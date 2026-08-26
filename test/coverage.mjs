#!/usr/bin/env node
// Random coverage fuzzer: mutates teacher availability, 1/1 hours, piano hours,
// reservations and quotas, then runs small groups → timetable → Accept → 1/1 → Accept
// → Required Piano. Hard-fails on overlaps / bad IDs / extra placements.
// Prints teacher and student coverage (requested vs placed minutes).
//
//   node test/coverage.mjs
//   node test/coverage.mjs --quick
//   node test/coverage.mjs --runs 80 --seed 42

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { makeRng } from './rng.mjs';
import { buildScenario, pickProfile } from './mutate.mjs';
import { checkSchedule, isSmallGroupId } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL_PATH = path.join(ROOT, 'test/last-coverage-failure.json');
const DAYS = ['MON','TUE','WED','THU','FRI'];
const HOUR_CHOICES = [0.5, 1, 1.5, 2, 3];

function parseArgs(argv){
  const args = { runs: 60, seed: (Date.now() ^ (process.pid << 16)) >>> 0, failFast: true };
  for(let i=2;i<argv.length;i++){
    const a = argv[i];
    if(a === '--quick') args.runs = 20;
    else if(a === '--runs') args.runs = Math.max(1, parseInt(argv[++i], 10) || 60);
    else if(a === '--seed') args.seed = parseInt(argv[++i], 10) >>> 0;
    else if(a === '--keep-going') args.failFast = false;
    else if(a === '--help' || a === '-h'){
      console.log('Usage: node test/coverage.mjs [--runs N] [--seed N] [--quick] [--keep-going]');
      process.exit(0);
    }
  }
  return args;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function stripHtml(s){
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function overlaps(a, b){
  return a && b && a.day === b.day && a.start < b.end && b.start < a.end;
}

function teacherName(db, id){
  const t = (db.refTeachers || []).find(x => x.id === id);
  return (t && t.name) || id;
}

function studentName(db, id){
  const s = (db.students || []).find(x => x.ID === id);
  return s ? `${s.NAME1} ${s.NAME2}` : id;
}

function mutateMatrix(db, key, rng, ops, intensity){
  const m = clone(db[key] || {columns: [], hours: {}});
  m.columns = m.columns || [];
  m.hours = m.hours || {};
  const students = db.students || [];
  const teachers = db.refTeachers || [];
  if(!m.columns.length && teachers.length){
    rng.sample(teachers, Math.min(4, teachers.length)).forEach(t => {
      m.columns.push({id: t.id, name: t.name});
    });
    ops.push(`${key}: seeded ${m.columns.length} teacher columns`);
  }
  const sids = students.map(s => s.ID);
  const tids = m.columns.map(c => c.id).filter(Boolean);
  if(!sids.length || !tids.length){
    db[key] = m;
    return;
  }
  const dropN = intensity === 'chaos'
    ? rng.int(4, 24)
    : rng.int(1, 10);
  for(let i=0;i<dropN;i++){
    const sid = rng.pick(sids);
    const row = m.hours[sid];
    if(!row) continue;
    const keys = Object.keys(row);
    if(!keys.length) continue;
    const tid = rng.pick(keys);
    delete row[tid];
    ops.push(`${key}: drop ${sid}×${tid}`);
  }
  const addN = intensity === 'chaos' ? rng.int(6, 20) : rng.int(2, 10);
  for(let i=0;i<addN;i++){
    const sid = rng.pick(sids);
    const tid = rng.pick(tids);
    m.hours[sid] = m.hours[sid] || {};
    m.hours[sid][tid] = rng.pick(HOUR_CHOICES);
  }
  ops.push(`${key}: bump ${addN} hour cell(s)`);
  if(rng.bool(0.35)){
    const extra = rng.pick(teachers);
    if(extra && extra.id && !tids.includes(extra.id)){
      m.columns.push({id: extra.id, name: extra.name});
      const sid = rng.pick(sids);
      m.hours[sid] = m.hours[sid] || {};
      m.hours[sid][extra.id] = rng.pick(HOUR_CHOICES);
      ops.push(`${key}: add column ${extra.name} with hours on ${sid}`);
    }
  }
  if(rng.bool(0.2) && m.columns.length > 1){
    const gone = m.columns.splice(rng.int(0, m.columns.length - 1), 1)[0];
    Object.keys(m.hours).forEach(sid => {
      if(m.hours[sid]) delete m.hours[sid][gone.id];
    });
    ops.push(`${key}: remove column ${gone.name || gone.id}`);
  }
  db[key] = m;
}

function availMinutes(api, teacherId){
  const w = api.teacherDayWindows(teacherId) || {};
  return DAYS.reduce((n, d) => n + (w[d] ? Math.max(0, w[d].end - w[d].start) : 0), 0);
}

function checkCombined(api, items, label){
  const errors = [];
  const list = (items || []).filter(i => i && i.day && i.start != null && i.end != null);
  for(let i=0;i<list.length;i++){
    for(let j=i+1;j<list.length;j++){
      const a = list[i], b = list[j];
      if(!overlaps(a, b)) continue;
      const when = `${a.day} ${api.toHHMM(Math.max(a.start,b.start))}–${api.toHHMM(Math.min(a.end,b.end))}`;
      if(a.teacherId && a.teacherId === b.teacherId){
        errors.push(`${label}: teacher ${a.teacherId} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const ra = a.roomId || '';
      const rb = b.roomId || '';
      if(ra && ra === rb){
        errors.push(`${label}: room ${ra} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const sa = api.studentsForScheduledItem(a) || [];
      const sb = new Set((api.studentsForScheduledItem(b) || []).map(s => s.ID));
      const shared = sa.filter(s => sb.has(s.ID));
      if(shared.length){
        errors.push(`${label}: student ${shared.map(s => s.ID).join(',')} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
    }
  }
  return errors;
}

function checkAssignments(api, matrix, scheduled, kind){
  const errors = [];
  const jobs = api.collectOneOneAssignments(matrix);
  const byKey = {};
  jobs.forEach(j => { byKey[j.studentId + '|' + j.teacherId] = j; });
  const seen = new Set();
  (scheduled || []).forEach(s => {
    const sid = s.studentId || s.studentIds;
    const key = sid + '|' + s.teacherId;
    seen.add(key);
    const job = byKey[key];
    if(!job){
      errors.push(`${kind}: placed ${s.lessonId} for ${key} which is not in the hours matrix`);
      return;
    }
    const dur = s.end - s.start;
    if(dur !== job.duration){
      errors.push(`${kind}: ${key} booked ${dur} min, matrix wants ${job.duration}`);
    }
    const st = (api.DB.students || []).find(x => x.ID === sid);
    if(!st) errors.push(`${kind}: placed unknown student ${sid}`);
    const t = (api.DB.refTeachers || []).find(x => x.id === s.teacherId);
    if(!t) errors.push(`${kind}: placed unknown teacher ${s.teacherId}`);
  });
  return {errors, jobs, seen};
}

function coverageSnapshot(api, groups, one, piano){
  const db = api.DB;
  const oneJobs = api.collectOneOneAssignments(db.oneToOne);
  const pianoJobs = api.collectOneOneAssignments(db.rpiano);
  const onePlaced = (one && one.scheduled) || [];
  const pianoPlaced = (piano && piano.scheduled) || [];
  const allItems = (groups || []).concat(onePlaced).concat(pianoPlaced);

  const teacher = {};
  (db.refTeachers || []).forEach(t => {
    teacher[t.id] = {
      id: t.id, name: t.name,
      availMin: availMinutes(api, t.id),
      taughtMin: 0, groupMin: 0, oneReq: 0, oneGot: 0, pianoReq: 0, pianoGot: 0
    };
  });
  oneJobs.forEach(j => { if(teacher[j.teacherId]) teacher[j.teacherId].oneReq += j.duration; });
  pianoJobs.forEach(j => { if(teacher[j.teacherId]) teacher[j.teacherId].pianoReq += j.duration; });
  allItems.forEach(it => {
    if(!it.teacherId || !teacher[it.teacherId]) return;
    const dur = (it.end || 0) - (it.start || 0);
    teacher[it.teacherId].taughtMin += dur;
    if(it.source === 'oneone' || (it.lessonId && String(it.lessonId).startsWith('O2O'))) teacher[it.teacherId].oneGot += dur;
    else if(it.source === 'rpiano' || (it.lessonId && (String(it.lessonId).startsWith('RP-') || String(it.lessonId).startsWith('RJP-')))) teacher[it.teacherId].pianoGot += dur;
    else teacher[it.teacherId].groupMin += dur;
  });

  const student = {};
  (db.students || []).forEach(s => {
    student[s.ID] = {
      id: s.ID, name: `${s.NAME1} ${s.NAME2}`,
      classId: s.CLASS_ID || '',
      scheduledMin: 0, oneReq: 0, oneGot: 0, pianoReq: 0, pianoGot: 0, groupHits: 0, smallGroupHits: 0
    };
  });
  oneJobs.forEach(j => { if(student[j.studentId]) student[j.studentId].oneReq += j.duration; });
  pianoJobs.forEach(j => { if(student[j.studentId]) student[j.studentId].pianoReq += j.duration; });
  allItems.forEach(it => {
    const members = api.studentsForScheduledItem(it) || [];
    const dur = (it.end || 0) - (it.start || 0);
    const isSmallGroup = it.lessonId && isSmallGroupId(it.lessonId);
    const isOne = it.source === 'oneone' || (it.lessonId && String(it.lessonId).startsWith('O2O'));
    const isPiano = it.source === 'rpiano' || (it.lessonId && (String(it.lessonId).startsWith('RP-') || String(it.lessonId).startsWith('RJP-')));
    members.forEach(s => {
      const row = student[s.ID];
      if(!row) return;
      row.scheduledMin += dur;
      if(isOne) row.oneGot += dur;
      else if(isPiano) row.pianoGot += dur;
      else if(isSmallGroup) row.smallGroupHits++;
      else row.groupHits++;
    });
  });

  return {teacher: Object.values(teacher), student: Object.values(student), oneJobs, pianoJobs};
}

function pct(got, req){
  if(!req) return '—';
  return `${Math.round(100 * got / req)}%`;
}

function printTeacherTable(rows, limit){
  const list = rows.slice().sort((a,b) => b.taughtMin - a.taughtMin);
  const show = limit ? list.slice(0, limit) : list;
  console.log('  teacher            avail  taught  groups   1/1 req→got   piano req→got');
  show.forEach(t => {
    const name = (t.name || t.id).padEnd(16);
    console.log(
      `  ${name}  ${String(t.availMin).padStart(4)}  ${String(t.taughtMin).padStart(6)}  ${String(t.groupMin).padStart(6)}  ${String(t.oneReq).padStart(4)}→${String(t.oneGot).padStart(4)} ${pct(t.oneGot,t.oneReq).padStart(4)}  ${String(t.pianoReq).padStart(4)}→${String(t.pianoGot).padStart(4)} ${pct(t.pianoGot,t.pianoReq).padStart(4)}`
    );
  });
}

function printStudentGaps(rows, limit){
  const missing = rows.filter(s => (s.oneReq && s.oneGot < s.oneReq) || (s.pianoReq && s.pianoGot < s.pianoReq));
  const none = rows.filter(s => s.scheduledMin === 0);
  console.log(`  students with 0 scheduled minutes this week: ${none.length}`);
  if(none.length){
    console.log('    ' + none.slice(0, limit || 12).map(s => `${s.name} (${s.id}${s.classId ? '' : ', no class'})`).join('; '));
  }
  console.log(`  students with unplaced 1/1 or piano minutes: ${missing.length}`);
  missing.slice(0, limit || 12).forEach(s => {
    const bits = [];
    if(s.oneReq) bits.push(`1/1 ${s.oneGot}/${s.oneReq} min`);
    if(s.pianoReq) bits.push(`piano ${s.pianoGot}/${s.pianoReq} min`);
    console.log(`    ${s.name} (${s.id}): ${bits.join(', ')}`);
  });
}

function dumpFailure(payload){
  fs.writeFileSync(FAIL_PATH, JSON.stringify(payload, null, 2));
}

function runPipeline(api){
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  api.DB.acceptedSchedule = [];
  api.DB.acceptedTimetable = null;
  (api.DB.lessons || []).forEach(l => { l.scheduledDay = ''; l.scheduledStart = ''; l.scheduledEnd = ''; });
  const groups = api.runScheduler(false);
  api.LAST_RESULT = groups;
  api.LAST_VARIANTS = [groups];
  const groupErrors = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, groups);
  const groupAudit = api.auditTimetable(groups.scheduled || []);
  const groupReds = (groupAudit.entries || []).filter(e => e.level !== 'warning');
  api.acceptTimetableSchedule();
  const one = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule || []
  });
  api.applyIndividualSearch('oneone', [one], '');
  api.acceptOneOneSchedule();
  const piano = api.scheduleAllOneToOne({
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(one.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  });
  api.applyIndividualSearch('rpiano', [piano], '');
  api.acceptRpianoSchedule();
  return {groups, one, piano, groupErrors, groupReds};
}

function collectErrors(api, packed){
  const errors = [];
  (packed.groupErrors || []).forEach(e => errors.push('groups: ' + e));
  (packed.groupReds || []).forEach(e => errors.push('group-audit: ' + stripHtml(e.html)));
  const oneChk = checkAssignments(api, api.DB.oneToOne, packed.one.scheduled, '1/1');
  const pianoChk = checkAssignments(api, api.DB.rpiano, packed.piano.scheduled, 'piano');
  errors.push.apply(errors, oneChk.errors);
  errors.push.apply(errors, pianoChk.errors);
  const week = (packed.groups.scheduled || []).concat(packed.one.scheduled || []).concat(packed.piano.scheduled || []);
  errors.push.apply(errors, checkCombined(api, week, 'combined'));
  const aud = api.auditTimetable(week);
  (aud.entries || []).filter(e => e.level !== 'warning').forEach(e => {
    errors.push('combined-audit: ' + stripHtml(e.html));
  });
  const ids = new Set();
  week.forEach(s => {
    if(!s.lessonId) return;
    if(ids.has(s.lessonId)) errors.push('duplicate lessonId ' + s.lessonId);
    ids.add(s.lessonId);
  });
  return errors;
}

function main(){
  const args = parseArgs(process.argv);
  console.log('Loading app…');
  const {api, seed} = loadApp();
  const rng = makeRng(args.seed);
  console.log(`Coverage fuzzer: ${args.runs} random scenarios · seed ${args.seed}\n`);

  let passed = 0, failed = 0, crashes = 0;
  const acc = {
    oneReq: 0, oneGot: 0, pianoReq: 0, pianoGot: 0,
    groupPlaced: 0, groupTotal: 0,
    taught: 0, avail: 0
  };
  const tStart = Date.now();
  let lastSnap = null;

  for(let i=0;i<args.runs;i++){
    const profile = pickProfile(rng, i);
    let scenario;
    try {
      scenario = buildScenario(api, seed, rng, profile);
      const intensity = profile === 'chaos' ? 'chaos' : 'normal';
      mutateMatrix(scenario.db, 'oneToOne', rng, scenario.ops, intensity);
      mutateMatrix(scenario.db, 'rpiano', rng, scenario.ops, intensity);
      api.DB = scenario.db;
      api.LAST_SMALL_GROUPS = scenario.smallGroups;
    } catch(err){
      crashes++; failed++;
      console.error(`\nSCENARIO ${i} crashed while building (${profile}): ${err.stack || err}`);
      if(args.failFast) process.exit(1);
      continue;
    }

    let packed;
    try {
      packed = runPipeline(api);
    } catch(err){
      crashes++; failed++;
      console.error(`\nSCENARIO ${i} ${profile} THREW: ${err.stack || err}`);
      dumpFailure({seed: args.seed, i, profile, ops: scenario.ops, error: String(err && err.stack || err)});
      if(args.failFast){
        console.error(`Dumped ${FAIL_PATH}`);
        process.exit(1);
      }
      continue;
    }

    const errors = collectErrors(api, packed);
    const snap = coverageSnapshot(api, packed.groups.scheduled, packed.one, packed.piano);
    lastSnap = snap;
    acc.oneReq += snap.oneJobs.reduce((n,j) => n + j.duration, 0);
    acc.oneGot += snap.teacher.reduce((n,t) => n + t.oneGot, 0);
    acc.pianoReq += snap.pianoJobs.reduce((n,j) => n + j.duration, 0);
    acc.pianoGot += snap.teacher.reduce((n,t) => n + t.pianoGot, 0);
    acc.groupPlaced += (packed.groups.scheduled || []).length;
    acc.groupTotal += (packed.groups.scheduled || []).length + (packed.groups.unresolved || []).length;
    acc.taught += snap.teacher.reduce((n,t) => n + t.taughtMin, 0);
    acc.avail += snap.teacher.reduce((n,t) => n + t.availMin, 0);

    if(errors.length){
      failed++;
      console.error(`\nSCENARIO ${i} FAILED  profile=${profile}`);
      console.error(scenario.ops.slice(0, 12).join('\n'));
      errors.slice(0, 16).forEach(e => console.error('  - ' + e));
      if(errors.length > 16) console.error(`  … ${errors.length - 16} more`);
      dumpFailure({
        seed: args.seed, i, profile, ops: scenario.ops, errors: errors.slice(0, 40),
        counts: {
          groups: (packed.groups.scheduled||[]).length,
          unresolved: (packed.groups.unresolved||[]).length,
          one: (packed.one.scheduled||[]).length,
          oneLeft: (packed.one.unresolved||[]).length,
          piano: (packed.piano.scheduled||[]).length,
          pianoLeft: (packed.piano.unresolved||[]).length
        }
      });
      if(args.failFast){
        console.error(`\nDumped ${FAIL_PATH}`);
        process.exit(1);
      }
    } else {
      passed++;
    }

    if(i === 0 || (i+1) % 10 === 0 || i === args.runs - 1){
      const onePct = pct(acc.oneGot, acc.oneReq);
      const pianoPct = pct(acc.pianoGot, acc.pianoReq);
      const gPct = pct(acc.groupPlaced, acc.groupTotal);
      process.stdout.write(
        `  ${i+1}/${args.runs}  ok=${passed} fail=${failed}  groups ${gPct}  1/1 ${onePct}  piano ${pianoPct}\n`
      );
    }
  }

  const secs = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('\n——— teacher coverage (last scenario) ———');
  if(lastSnap) printTeacherTable(lastSnap.teacher);
  console.log('\n——— student coverage (last scenario) ———');
  if(lastSnap) printStudentGaps(lastSnap.student, 15);

  console.log('\n——— totals across all random runs ———');
  console.log(`scenarios ${passed}/${args.runs} passed · ${failed} failed · ${crashes} crashed · ${secs}s · seed ${args.seed}`);
  console.log(`group/small group placements ${pct(acc.groupPlaced, acc.groupTotal)}  (${acc.groupPlaced}/${acc.groupTotal})`);
  console.log(`1/1 minutes placed    ${pct(acc.oneGot, acc.oneReq)}  (${acc.oneGot}/${acc.oneReq})`);
  console.log(`piano minutes placed  ${pct(acc.pianoGot, acc.pianoReq)}  (${acc.pianoGot}/${acc.pianoReq})`);
  console.log(`teacher load vs avail ${pct(acc.taught, acc.avail)}  (${acc.taught} taught / ${acc.avail} window minutes)`);
  if(failed) process.exit(1);
  console.log('Random coverage run is green — no overlap / ID / extra-placement bugs.');
}

main();
