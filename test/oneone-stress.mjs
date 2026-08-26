#!/usr/bin/env node
// Brute-force 1/1 audit: Drive CSV, nasty units, full Generate→Accept→matrix
// generate, and an independent 5-minute oracle that does not use the scheduler's
// candidate picker.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = ['MON','TUE','WED','THU','FRI'];
const TYPE_RANK = {AVAILABLE:0, PREFERRED:0, FALLBACK:1, CANDIDATE:2};
const DEFAULT_START = 8*60, DEFAULT_END = 20*60;

let failed = 0;
let passed = 0;
const failures = [];

function ok(name, cond, detail){
  if(cond){
    passed++;
    return true;
  }
  failed++;
  failures.push(detail ? `${name}: ${detail}` : name);
  console.error('FAIL  ' + (detail ? `${name}: ${detail}` : name));
  return false;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function toMin(t){
  if(typeof t === 'number' && Number.isFinite(t)) return t;
  if(!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t).trim());
  if(!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}
function toHHMM(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function overlap(aS,aE,bS,bE){ return aS < bE && bS < aE; }

function parseCsv(text){
  const rows = [];
  let row = [], cell = '', i = 0, inQ = false;
  const s = String(text).replace(/^\uFEFF/, '');
  while(i < s.length){
    const ch = s[i];
    if(inQ){
      if(ch === '"'){
        if(s[i+1] === '"'){ cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if(ch === '"'){ inQ = true; i++; continue; }
    if(ch === ','){ row.push(cell); cell = ''; i++; continue; }
    if(ch === '\n' || ch === '\r'){
      if(ch === '\r' && s[i+1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; i++; continue;
    }
    cell += ch; i++;
  }
  if(cell.length || row.length) { row.push(cell); rows.push(row); }
  if(!rows.length) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).filter(r => r.some(c => String(c).trim() !== '')).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = r[idx] == null ? '' : String(r[idx]); });
    return o;
  });
}

function teacherWindows(db, teacherId){
  const rows = (db.teacherAvail || []).filter(r => r.teacherId === teacherId && r.type !== 'AVOID' && r.day && DAYS.includes(r.day));
  const byDay = {};
  rows.forEach(r => {
    const rank = TYPE_RANK[r.type] ?? 2;
    const start = toMin(r.start) ?? DEFAULT_START;
    const end = toMin(r.end) ?? DEFAULT_END;
    if(!byDay[r.day] || rank < byDay[r.day].rank){
      byDay[r.day] = {start, end, rank};
    } else if(rank === byDay[r.day].rank){
      byDay[r.day].start = Math.min(byDay[r.day].start, start);
      byDay[r.day].end = Math.max(byDay[r.day].end, end);
    }
  });
  (db.teacherAvail || []).forEach(r => {
    if(r.teacherId === teacherId && r.type === 'AVOID') delete byDay[r.day];
  });
  return byDay;
}

function classHits(db, classId, day, start, end){
  if(!classId) return false;
  return (db.classAvail || []).some(r => {
    if(r.classId !== classId || r.day !== day || (!r.start && !r.end)) return false;
    const rs = toMin(r.start) ?? DEFAULT_START;
    const re = toMin(r.end) ?? DEFAULT_END;
    return overlap(start, end, rs, re);
  });
}

function parseIdList(s){
  return String(s == null ? '' : s).split(/[,;]+/).map(x => String(x).trim()).filter(Boolean);
}

function intervalFromRow(r){
  const day = r.day;
  const start = toMin(r.start);
  const end = toMin(r.end);
  if(!day || !DAYS.includes(day) || start == null || end == null || !(start < end)) return null;
  return {day, start, end, teacherId: r.teacherId || '', studentIds: parseIdList(r.studentIds || r.studentId), name: r.name || ''};
}

function collectBusy(acceptedRows, oneoneRows){
  const teacher = {};
  const student = {};
  function add(tid, sidList, day, start, end){
    if(tid){
      teacher[tid] = teacher[tid] || {};
      teacher[tid][day] = teacher[tid][day] || [];
      teacher[tid][day].push({start, end});
    }
    sidList.forEach(sid => {
      student[sid] = student[sid] || {};
      student[sid][day] = student[sid][day] || [];
      student[sid][day].push({start, end});
    });
  }
  (acceptedRows || []).forEach(r => {
    if(r.status && r.status !== 'scheduled') return;
    const iv = intervalFromRow(r);
    if(!iv) return;
    add(iv.teacherId, iv.studentIds, iv.day, iv.start, iv.end);
  });
  (oneoneRows || []).forEach(r => {
    const sid = r.studentId || (r.studentIds || '');
    add(r.teacherId, parseIdList(sid), r.day, r.start, r.end);
  });
  return {teacher, student};
}

function hitsBusy(map, id, day, start, end){
  return ((map[id] || {})[day] || []).some(iv => overlap(start, end, iv.start, iv.end));
}

function allStarts(db, teacherId, student, duration, busy){
  const wins = teacherWindows(db, teacherId);
  const out = [];
  DAYS.forEach(day => {
    const w = wins[day];
    if(!w) return;
    for(let t = w.start; t + duration <= w.end; t += 5){
      const end = t + duration;
      if(hitsBusy(busy.teacher, teacherId, day, t, end)) continue;
      if(hitsBusy(busy.student, student.ID, day, t, end)) continue;
      if(classHits(db, student.CLASS_ID, day, t, end)) continue;
      out.push({day, start: t, end, rank: w.rank});
    }
  });
  return out;
}

function teacherName(db, id){
  const t = (db.refTeachers || []).find(x => x.id === id);
  return (t && t.name) || id || '';
}

function greedyOracle(db, assignments, acceptedRows){
  const byTeacher = {};
  assignments.forEach(a => {
    byTeacher[a.teacherId] = byTeacher[a.teacherId] || [];
    byTeacher[a.teacherId].push(a);
  });
  const teacherIds = Object.keys(byTeacher).sort((a,b) => {
    const da = DAYS.filter(d => teacherWindows(db, a)[d]).length;
    const dbn = DAYS.filter(d => teacherWindows(db, b)[d]).length;
    return da - dbn || byTeacher[b].length - byTeacher[a].length || String(teacherName(db,a)).localeCompare(String(teacherName(db,b)));
  });
  const placed = [];
  const missed = [];
  teacherIds.forEach(tid => {
    const list = byTeacher[tid].slice();
    const busy = collectBusy(acceptedRows, placed);
    list.sort((a,b) => {
      const sa = db.students.find(s => s.ID === a.studentId);
      const sb = db.students.find(s => s.ID === b.studentId);
      const na = sa ? allStarts(db, tid, sa, a.duration, busy).length : 0;
      const nb = sb ? allStarts(db, tid, sb, b.duration, busy).length : 0;
      return na - nb;
    });
    list.forEach(a => {
      const student = db.students.find(s => s.ID === a.studentId);
      if(!student){
        missed.push({...a, reason: 'student not in the roster'});
        return;
      }
      const nowBusy = collectBusy(acceptedRows, placed);
      const slots = allStarts(db, tid, student, a.duration, nowBusy);
      if(!slots.length){
        missed.push({...a, reason: 'oracle: no 5-min slot'});
        return;
      }
      const dayCount = {};
      DAYS.forEach(d => { dayCount[d] = placed.filter(p => p.teacherId === tid && p.day === d).length; });
      const daysAvail = DAYS.filter(d => teacherWindows(db, tid)[d]);
      const target = Math.ceil(list.length / Math.max(1, daysAvail.length));
      slots.sort((x,y) => {
        const overA = Math.max(0, (dayCount[x.day] + 1) - target);
        const overB = Math.max(0, (dayCount[y.day] + 1) - target);
        return overA - overB || dayCount[x.day] - dayCount[y.day]
          || DAYS.indexOf(x.day) - DAYS.indexOf(y.day) || x.start - y.start;
      });
      const pick = slots[0];
      placed.push({
        teacherId: tid, studentId: a.studentId, day: pick.day,
        start: pick.start, end: pick.end, duration: a.duration
      });
    });
  });
  return {placed, missed};
}

function pairKey(teacherId, studentId){ return teacherId + '::' + studentId; }

function checkScheduledValid(db, acceptedRows, scheduled){
  const errors = [];
  const busyAccepted = collectBusy(acceptedRows, []);
  scheduled.forEach((s, i) => {
    const student = (db.students || []).find(x => x.ID === s.studentId);
    if(!student) errors.push(`scheduled[${i}] unknown student ${s.studentId}`);
    if(!s.teacherId) errors.push(`scheduled[${i}] missing teacher`);
    if(!DAYS.includes(s.day)) errors.push(`scheduled[${i}] bad day ${s.day}`);
    if(!(s.end > s.start)) errors.push(`scheduled[${i}] end<=start`);
    if(s.duration != null && s.end - s.start !== s.duration){
      errors.push(`scheduled[${i}] duration ${s.duration} != ${s.end-s.start}`);
    }
    if(s.roomId) errors.push(`scheduled[${i}] 1/1 should not lock a room`);
    const w = teacherWindows(db, s.teacherId)[s.day];
    if(!w) errors.push(`scheduled[${i}] ${teacherName(db,s.teacherId)} not free on ${s.day}`);
    else if(s.start < w.start || s.end > w.end){
      errors.push(`scheduled[${i}] outside window ${toHHMM(w.start)}–${toHHMM(w.end)} got ${toHHMM(s.start)}–${toHHMM(s.end)}`);
    }
    if(student && classHits(db, student.CLASS_ID, s.day, s.start, s.end)){
      errors.push(`scheduled[${i}] ${s.studentId} overlaps class reservation ${s.day} ${toHHMM(s.start)}–${toHHMM(s.end)}`);
    }
    if(hitsBusy(busyAccepted.teacher, s.teacherId, s.day, s.start, s.end)){
      errors.push(`scheduled[${i}] overlaps accepted teacher block`);
    }
    if(student && hitsBusy(busyAccepted.student, student.ID, s.day, s.start, s.end)){
      errors.push(`scheduled[${i}] overlaps student’s accepted lesson`);
    }
    if(s.source && s.source !== 'oneone') errors.push(`scheduled[${i}] source=${s.source}`);
  });
  for(let i=0;i<scheduled.length;i++){
    for(let j=i+1;j<scheduled.length;j++){
      const a = scheduled[i], b = scheduled[j];
      if(a.day !== b.day) continue;
      if(!overlap(a.start, a.end, b.start, b.end)) continue;
      if(a.teacherId === b.teacherId){
        errors.push(`teacher overlap ${teacherName(db,a.teacherId)} ${a.day} ${toHHMM(a.start)}–${toHHMM(a.end)} vs ${toHHMM(b.start)}–${toHHMM(b.end)} (${a.studentId}/${b.studentId})`);
      }
      if(a.studentId && a.studentId === b.studentId){
        errors.push(`student overlap ${a.studentId} ${a.day} ${toHHMM(a.start)}–${toHHMM(a.end)} vs ${toHHMM(b.start)}–${toHHMM(b.end)}`);
      }
    }
  }
  return errors;
}

function toyStudents(){
  return ['S1','S2','S3','S4'].map((id, i) => ({
    ID: id, NAME1: 'Stu', NAME2: String(i + 1), NAME3: '', INSTR_ID: 'INST6', CLASS_ID: 'CLX',
  }));
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();
  const t0 = Date.now();

  console.log('\n== parse garbage / Hungarian / rounding ==');
  ok('null → 0', api.parseOneOneHours(null) === 0);
  ok('undefined → 0', api.parseOneOneHours(undefined) === 0);
  ok('0 → 0', api.parseOneOneHours(0) === 0 && api.parseOneOneHours('0') === 0);
  ok('negative → 0', api.parseOneOneHours(-2) === 0 && api.parseOneOneHours('-1') === 0);
  ok('foo → 0', api.parseOneOneHours('foo') === 0);
  ok('#N/A → 0', api.parseOneOneHours('#N/A') === 0);
  ok('2,0 → 2', api.parseOneOneHours('2,0') === 2);
  ok(' 1,5 → 1.5', api.parseOneOneHours(' 1,5 ') === 1.5);
  ok('0,5 → 30 min', api.oneOneHoursToMinutes('0,5') === 30);
  ok('3 → 180 min', api.oneOneHoursToMinutes(3) === 180);
  ok('1.25 snaps to 75', api.oneOneHoursToMinutes(1.25) === 75);
  ok('tiny 0.1 snaps up to 15 min floor', api.oneOneHoursToMinutes(0.1) === 15);

  console.log('\n== Drive fixture CSV ==');
  const csvPath = path.join(ROOT, 'test/fixtures/one_1.csv');
  const csvRows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  ok('fixture has 71 student rows', csvRows.length === 71, 'n=' + csvRows.length);
  ok('sheetLooksLike oneToOne on fixture headers',
    api.sheetLooksLike('oneToOne', csvRows),
    Object.keys(csvRows[0]).join(','));
  ok('1_1 is not mistaken for LESSONS / CLASS_CONST',
    !api.sheetLooksLike('lessons', csvRows) && !api.sheetLooksLike('classAvail', csvRows));
  ok('oneToOne matcher rejects a STUDENTS row (CLASS_ID / IMPR)',
    api.sheetLooksLike('oneToOne', [Object.assign({}, csvRows[0], {CLASS_ID:'CL1', IMPR:'x'})]) === false);

  const parsed = api.parseOneToOneTable(csvRows, seed.refTeachers);
  const jobs = api.collectOneOneAssignments(parsed);
  const filledCsv = [];
  csvRows.forEach(r => {
    Object.keys(r).forEach(h => {
      if(['STUDENT_ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID'].includes(h)) return;
      const n = api.parseOneOneHours(r[h]);
      if(n) filledCsv.push({sid: r.STUDENT_ID, teacher: h, hours: n});
    });
  });
  ok('parsed teacher columns = 20', parsed.columns.length === 20, 'n=' + parsed.columns.length);
  ok('filled CSV cells = 121', filledCsv.length === 121, 'n=' + filledCsv.length);
  ok('collect matches filled CSV cells', jobs.length === filledCsv.length, `jobs=${jobs.length} csv=${filledCsv.length}`);
  ok('Hungarian 1,5 survives CSV quotes (Szesztay Revesz + Olah)',
    parsed.hours.ST48 && parsed.hours.ST48.TEAC14 === 1.5 && parsed.hours.ST48.TEAC17 === 1.5,
    JSON.stringify(parsed.hours.ST48));
  ok('3-hour violin cell is 180 min',
    jobs.some(j => j.studentId === 'ST42' && j.hours === 3 && j.duration === 180));
  ok('empty guitar row ST32 has no hours', !parsed.hours.ST32 || !Object.keys(parsed.hours.ST32).length);

  const seedJobs = api.collectOneOneAssignments(seed.oneToOne);
  ok('seed matrix matches fixture cell count', seedJobs.length === jobs.length,
    `seed=${seedJobs.length} fixture=${jobs.length}`);
  const seedKeys = new Set(seedJobs.map(j => pairKey(j.teacherId, j.studentId) + ':' + j.hours));
  const csvKeys = new Set(jobs.map(j => pairKey(j.teacherId, j.studentId) + ':' + j.hours));
  const missingInSeed = [...csvKeys].filter(k => !seedKeys.has(k));
  const extraInSeed = [...seedKeys].filter(k => !csvKeys.has(k));
  ok('seed hours match fixture hours exactly', missingInSeed.length === 0 && extraInSeed.length === 0,
    `missing=${missingInSeed.slice(0,5).join('|')} extra=${extraInSeed.slice(0,5).join('|')}`);

  console.log('\n== export 1_1 round-trip ==');
  api.DB = clone(seed);
  const aoa = api.oneToOneAoa(api.DB);
  ok('export sheet is named 1_1', aoa.name === '1_1');
  ok('export has header + every student', aoa.aoa.length === 1 + seed.students.length,
    'rows=' + aoa.aoa.length);
  const expHeaders = aoa.aoa[0];
  const expRows = aoa.aoa.slice(1).map(line => {
    const o = {};
    expHeaders.forEach((h,i) => { o[h] = line[i]; });
    return o;
  });
  const reparsed = api.parseOneToOneTable(expRows, seed.refTeachers);
  const reJobs = api.collectOneOneAssignments(reparsed);
  ok('round-trip keeps assignment count', reJobs.length === seedJobs.length,
    `out=${reJobs.length} in=${seedJobs.length}`);
  const st48 = expRows.find(r => r.STUDENT_ID === 'ST48');
  ok('export writes Hungarian comma for 1.5',
    st48 && String(st48.Revesz) === '1,5' && String(st48.Olah) === '1,5',
    st48 ? `Revesz=${st48.Revesz} Olah=${st48.Olah}` : 'missing ST48');

  console.log('\n== sheetsTablesToDb keeps / replaces the matrix ==');
  api.DB = clone(seed);
  const viaSheets = api.sheetsTablesToDb({oneToOne: csvRows});
  ok('Drive load parses 1_1 into oneToOne',
    api.collectOneOneAssignments(viaSheets.db.oneToOne).length === jobs.length,
    'n=' + api.collectOneOneAssignments((viaSheets.db || {}).oneToOne).length);
  const kept = api.sheetsTablesToDb({});
  ok('missing 1_1 tab keeps the working matrix',
    api.collectOneOneAssignments(kept.db.oneToOne).length === seedJobs.length,
    'n=' + api.collectOneOneAssignments((kept.db || {}).oneToOne).length);

  console.log('\n== scheduler edge cases ==');
  api.DB = clone(seed);
  api.DB.students = toyStudents();
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id:'T1', name:'One'}]);
  api.DB.teacherAvail = [
    {teacherId:'T1', day:'MON', start:'08:00', end:'16:00', type:'AVAILABLE'},
    {teacherId:'T1', day:'TUE', start:'08:00', end:'16:00', type:'AVOID'},
  ];
  api.DB.classAvail = [];
  api.DB.acceptedSchedule = [];
  const avoid = api.scheduleOneToOne({
    teacherId:'T1', studentIds:['S1'], duration:60, perStudent:1, acceptedRows:[]
  });
  ok('AVOID day is not used', avoid.scheduled.length === 1 && avoid.scheduled[0].day === 'MON',
    avoid.scheduled[0] ? avoid.scheduled[0].day : 'unplaced');

  api.DB.oneToOne = {columns:[{id:'T1', name:'One'}], hours:{}};
  const empty = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows:[]});
  ok('empty matrix places nothing', empty.scheduled.length === 0 && empty.unresolved.length === 0);

  api.DB.oneToOne = {columns:[{id:'T1', name:'One'}], hours:{NOPE:{T1:1}, S1:{T1:0}}};
  const ghost = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows:[]});
  ok('unknown student is unresolved', ghost.unresolved.some(u => u.studentId === 'NOPE'));
  ok('zero hours are skipped', !ghost.scheduled.some(s => s.studentId === 'S1') && !ghost.unresolved.some(u => u.studentId === 'S1'),
    `sched=${ghost.scheduled.map(s=>s.studentId).join(',')} un=${ghost.unresolved.map(u=>u.studentId).join(',')}`);

  api.DB.teacherAvail = [
    {teacherId:'T1', day:'WED', start:'10:07', end:'12:00', type:'AVAILABLE'},
  ];
  api.DB.students = toyStudents();
  api.DB.classAvail = [];
  const odd = api.scheduleOneToOne({
    teacherId:'T1', studentIds:['S1'], duration:45, perStudent:1, acceptedRows:[]
  });
  ok('odd 10:07 window still places on a 5-min snap',
    odd.scheduled.length === 1 && odd.scheduled[0].start % 5 === 0,
    odd.scheduled[0] ? `${toHHMM(odd.scheduled[0].start)}–${toHHMM(odd.scheduled[0].end)}` : 'unplaced');

  api.DB.teacherAvail = [
    {teacherId:'T1', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'},
    {teacherId:'T2', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'},
  ];
  api.DB.refTeachers = (seed.refTeachers || []).concat([{id:'T1',name:'One'},{id:'T2',name:'Two'}]);
  api.DB.oneToOne = {
    columns:[{id:'T1',name:'One'},{id:'T2',name:'Two'}],
    hours:{S1:{T1:1, T2:1}, S2:{T1:1}}
  };
  api.DB.acceptedSchedule = [{
    status:'scheduled', teacherId:'T9', day:'MON', start:'08:00', end:'09:00',
    studentIds:'S1', name:'Other'
  }];
  const cross = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule});
  const s1s = cross.scheduled.filter(s => s.studentId === 'S1');
  ok('S1 still gets both teachers around the 08–09 accepted small group',
    s1s.length === 2, 'n=' + s1s.length);
  ok('neither S1 1/1 overlaps 08:00–09:00',
    s1s.every(s => !overlap(s.start, s.end, 8*60, 9*60)),
    s1s.map(s => `${s.teacherId} ${toHHMM(s.start)}–${toHHMM(s.end)}`).join('; '));
  ok('the two S1 lessons do not overlap each other',
    s1s.length === 2 && !overlap(s1s[0].start, s1s[0].end, s1s[1].start, s1s[1].end));

  console.log('\n== full seed Generate → Accept → 1/1 ==');
  api.DB = clone(seed);
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  const gen = api.runScheduler(false);
  api.LAST_RESULT = gen;
  ok('group Generate placed lessons', gen.scheduled.length > 0, 'n=' + gen.scheduled.length);
  const acceptedAll = api.buildAcceptedScheduleRows(gen);
  const accepted = acceptedAll.filter(r => r.status === 'scheduled');
  api.DB.acceptedSchedule = acceptedAll;
  api.DB.acceptedTimetable = {acceptedAt: '2026-08-25T00:00:00.000Z'};
  api.LAST_RESULT = {scheduled: gen.scheduled, accepted: true};
  ok('Accept produced scheduled rows', accepted.length === gen.scheduled.length,
    `accepted=${accepted.length} gen=${gen.scheduled.length}`);
  ok('tab unlocks after Accept', api.hasAcceptedRecord() === true && api.canOpenOneOne() === true);

  const t1 = Date.now();
  const result = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule
  });
  const oneMs = Date.now() - t1;
  const assignments = api.collectOneOneAssignments(api.DB.oneToOne);
  console.log(`  group ${gen.scheduled.length} placed / ${gen.unresolved.length} unresolved`);
  console.log(`  1/1 ${result.scheduled.length} placed / ${result.unresolved.length} unresolved of ${assignments.length} cells (${oneMs}ms)`);

  ok('every matrix cell is placed or listed unresolved',
    result.scheduled.length + result.unresolved.length === assignments.length,
    `sched=${result.scheduled.length} un=${result.unresolved.length} jobs=${assignments.length}`);

  const scheduledKeys = result.scheduled.map(s => pairKey(s.teacherId, s.studentId));
  ok('no duplicate student×teacher 1/1',
    new Set(scheduledKeys).size === scheduledKeys.length,
    'dupes=' + (scheduledKeys.length - new Set(scheduledKeys).size));

  const validErr = checkScheduledValid(api.DB, accepted, result.scheduled);
  ok('independent invariants: scheduled 1/1 are legal', validErr.length === 0,
    validErr.slice(0, 8).join(' | '));

  const hoursByPair = {};
  assignments.forEach(a => { hoursByPair[pairKey(a.teacherId, a.studentId)] = a; });
  const durationMismatches = result.scheduled.filter(s => {
    const a = hoursByPair[pairKey(s.teacherId, s.studentId)];
    return !a || s.duration !== a.duration || (s.end - s.start) !== a.duration;
  });
  ok('every placed 1/1 lasts hours×60', durationMismatches.length === 0,
    durationMismatches.slice(0, 5).map(s => `${s.studentId}/${s.teacherId} ${s.duration}`).join(','));

  const noAvailTeachers = new Set(
    (api.DB.oneToOne.columns || []).map(c => c.id).filter(id => DAYS.every(d => !teacherWindows(api.DB, id)[d]))
  );
  const noAvailJobs = assignments.filter(a => noAvailTeachers.has(a.teacherId));
  ok('cells whose teacher has zero availability are unresolved (Geroly/Olah)',
    noAvailJobs.length === result.unresolved.filter(u => noAvailTeachers.has(u.teacherId)).length
    && noAvailJobs.length > 0,
    `jobs=${noAvailJobs.length} unresolved=${result.unresolved.filter(u => noAvailTeachers.has(u.teacherId)).length} teachers=${[...noAvailTeachers].map(id => teacherName(api.DB,id)).join(',')}`);
  const leftoverPeople = result.unresolved.filter(u => !noAvailTeachers.has(u.teacherId));
  console.log('  leftover after packing (capacity/class, not missing holes):',
    leftoverPeople.map(u => `${u.studentId}×${teacherName(api.DB,u.teacherId)}`).join(', ') || 'none');

  const leftover = [];
  const busyFinal = collectBusy(accepted, result.scheduled);
  result.unresolved.forEach(u => {
    const student = api.DB.students.find(s => s.ID === u.studentId);
    const a = hoursByPair[pairKey(u.teacherId, u.studentId)];
    if(!student || !a) return;
    const slots = allStarts(api.DB, u.teacherId, student, a.duration, busyFinal);
    if(slots.length){
      leftover.push(`${u.studentId}×${teacherName(api.DB,u.teacherId)} still has ${slots.length} slots e.g. ${slots[0].day} ${toHHMM(slots[0].start)}`);
    }
  });
  ok('unresolved 1/1 have no leftover 5-min hole (oracle)', leftover.length === 0,
    leftover.slice(0, 8).join(' | '));

  const oracle = greedyOracle(api.DB, assignments, accepted);
  ok('5-min greedy oracle does not place more than the scheduler',
    oracle.placed.length <= result.scheduled.length,
    `oracle=${oracle.placed.length} scheduler=${result.scheduled.length} (scheduler missed ${oracle.placed.length - result.scheduled.length})`);
  if(oracle.placed.length > result.scheduled.length){
    const schedSet = new Set(result.scheduled.map(s => pairKey(s.teacherId, s.studentId)));
    const extra = oracle.placed.filter(p => !schedSet.has(pairKey(p.teacherId, p.studentId)));
    console.error('  oracle-only placements:', extra.slice(0, 10).map(p =>
      `${p.studentId}×${p.teacherId} ${p.day} ${toHHMM(p.start)}–${toHHMM(p.end)}`).join('; '));
  }

  const byTeacher = {};
  result.scheduled.forEach(s => {
    byTeacher[s.teacherId] = byTeacher[s.teacherId] || {n:0, days:{}};
    byTeacher[s.teacherId].n++;
    byTeacher[s.teacherId].days[s.day] = (byTeacher[s.teacherId].days[s.day] || 0) + 1;
  });
  const spreadBad = [];
  Object.keys(byTeacher).forEach(tid => {
    const avail = DAYS.filter(d => teacherWindows(api.DB, tid)[d]);
    if(avail.length < 2 || byTeacher[tid].n < 2) return;
    const counts = avail.map(d => byTeacher[tid].days[d] || 0);
    const max = Math.max(...counts), min = Math.min(...counts);
    if(max - min > 4 && min === 0 && max >= 6){
      spreadBad.push(`${teacherName(api.DB,tid)} ${JSON.stringify(byTeacher[tid].days)} avail=${avail.join(',')}`);
    }
  });
  ok('no teacher dumps 6+ lessons on one day while another available day is empty',
    spreadBad.length === 0, spreadBad.join(' | '));

  const ids = result.scheduled.map(s => s.lessonId);
  ok('1/1 lesson ids are unique', new Set(ids).size === ids.length);

  api.LAST_ONEONE = {viewTeacherId: result.scheduled[0] && result.scheduled[0].teacherId, scheduled: result.scheduled, unresolved: result.unresolved};
  const dumped = api.buildFullExportObject();
  ok('full JSON export keeps placed 1/1',
    dumped.oneToOneState && dumped.oneToOneState.scheduled.length === result.scheduled.length);

  const placedPct = assignments.length ? result.scheduled.length / assignments.length : 1;
  ok('places a majority of Drive 1_1 cells into the accepted week',
    placedPct >= 0.5,
    `${result.scheduled.length}/${assignments.length} = ${(placedPct*100).toFixed(0)}%`);

  const unReasons = {};
  result.unresolved.forEach(u => {
    const key = u.reason || 'unknown';
    unReasons[key] = (unReasons[key] || 0) + 1;
  });
  console.log('  unresolved reasons:', JSON.stringify(unReasons));
  console.log(`  teachers with 1/1: ${Object.keys(byTeacher).length} / ${(api.DB.oneToOne.columns||[]).length} columns`);

  console.log(`\n${passed} passed, ${failed} failed  (${Date.now()-t0}ms)`);
  if(failures.length){
    console.error(failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
}

main();
