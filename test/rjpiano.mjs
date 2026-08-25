#!/usr/bin/env node
// Required Jazz Piano: Drive JRPiano matrix, Accept 1/1 gate, leftover-hole packing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function overlaps(a, b){
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

function toyStudents(){
  return ['S1','S2'].map((id, i) => ({
    ID: id,
    NAME1: 'Stu',
    NAME2: String(i + 1),
    NAME3: '',
    INSTR_ID: 'INST6',
    CLASS_ID: 'CLX',
  }));
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();

  ['rjPianoAoa','busyRowsFromScheduled','hasAcceptedOneOne','acceptOneOneSchedule','hasAcceptedRjPiano','acceptRjPianoSchedule','individualAcceptedRows','individualTeacherIds','scheduleAllOneToOne'
  ].forEach(name => {
    if(typeof api[name] !== 'function'){
      failed++;
      failures.push('export missing: ' + name);
      console.error('FAIL  export missing: ' + name);
    }
  });

  console.log('\n== Drive JRPiano fixture ==');
  const csvRows = parseCsv(fs.readFileSync(path.join(ROOT, 'test/fixtures/jrpiano.csv'), 'utf8'));
  ok('fixture has student rows', csvRows.length >= 70, 'n=' + csvRows.length);
  ok('sheetLooksLike rjPiano', api.sheetLooksLike('rjPiano', csvRows), Object.keys(csvRows[0]).join(','));
  ok('sheetLooksLike oneToOne also matches the matrix shape', api.sheetLooksLike('oneToOne', csvRows));
  ok('STUDENTS row is rejected',
    api.sheetLooksLike('rjPiano', [Object.assign({}, csvRows[0], {CLASS_ID:'CL1', IMPR:'x'})]) === false);

  const parsed = api.parseOneToOneTable(csvRows, seed.refTeachers);
  const jobs = api.collectOneOneAssignments(parsed);
  ok('six piano teacher columns', parsed.columns.length === 6, 'n=' + parsed.columns.length + ' ' + parsed.columns.map(c => c.name).join(','));
  ok('columns include Varallyay', parsed.columns.some(c => c.name === 'Varallyay'));
  ok('44 filled piano cells', jobs.length === 44, 'n=' + jobs.length);
  ok('Hungarian 0,5 → 30 min (Damo / Pozsar)',
    jobs.some(j => j.studentId === 'ST7' && j.hours === 0.5 && j.duration === 30),
    JSON.stringify(parsed.hours.ST7));
  ok('seed matrix matches fixture',
    api.collectOneOneAssignments(seed.rjPiano).length === 44,
    'n=' + api.collectOneOneAssignments(seed.rjPiano).length);

  console.log('\n== teacher dropdowns are type-specific ==');
  api.DB = clone(seed);
  api.LAST_ONEONE = null;
  api.LAST_RJPIANO = null;
  const oneIds = api.individualTeacherIds('oneone');
  const pianoIds = api.individualTeacherIds('rjpiano');
  const varallyay = (seed.refTeachers || []).find(t => t.name === 'Varallyay');
  const csuhaj = (seed.refTeachers || []).find(t => t.name === 'Csuhaj');
  ok('1/1 dropdown excludes piano-only Varallyay', varallyay && !oneIds.includes(varallyay.id), oneIds.join(','));
  ok('piano dropdown includes Varallyay', varallyay && pianoIds.includes(varallyay.id));
  ok('1/1 dropdown includes Csuhaj', csuhaj && oneIds.includes(csuhaj.id));
  ok('piano dropdown excludes 1/1-only Csuhaj', csuhaj && !pianoIds.includes(csuhaj.id));
  ok('no kind argument still returns the union',
    api.individualTeacherIds().includes(varallyay.id) && api.individualTeacherIds().includes(csuhaj.id));

  console.log('\n== export JRPiano round-trip ==');
  api.DB = clone(seed);
  const aoa = api.rjPianoAoa(api.DB);
  ok('export sheet is named JRPiano', aoa.name === 'JRPiano');
  const sheets = api.driveTablesToAoa(api.DB);
  ok('xlsx includes JRPiano after 1_1',
    sheets.some(s => s.name === 'JRPiano') && sheets.some(s => s.name === '1_1'));

  const viaSheets = api.sheetsTablesToDb({rjPiano: csvRows});
  ok('Drive load parses JRPiano',
    api.collectOneOneAssignments(viaSheets.db.rjPiano).length === 44,
    'n=' + api.collectOneOneAssignments((viaSheets.db || {}).rjPiano).length);

  api.DB = clone(seed);
  const kept = api.sheetsTablesToDb({});
  ok('missing JRPiano tab keeps the working matrix',
    api.collectOneOneAssignments(kept.db.rjPiano).length === 44,
    'n=' + api.collectOneOneAssignments((kept.db || {}).rjPiano).length);

  console.log('\n== Accept 1/1 gate ==');
  api.DB = clone(seed);
  api.LAST_ONEONE = null;
  api.LAST_RJPIANO = null;
  ok('locked before 1/1 accept', api.hasAcceptedOneOne() === false);
  api.LAST_ONEONE = {scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:8*60, end:9*60}], unresolved:[], accepted:false};
  ok('generated 1/1 is not enough', api.hasAcceptedOneOne() === false);
  api.acceptOneOneSchedule();
  ok('unlocked after Accept 1/1', api.hasAcceptedOneOne() === true);
  ok('accept flag is persisted in JSON',
    api.buildFullExportObject().oneToOneState && api.buildFullExportObject().oneToOneState.accepted === true);
  const oneRows = api.LAST_ONEONE.acceptedSchedule;
  ok('Accept 1/1 writes Accepted schedule rows', Array.isArray(oneRows) && oneRows.length === 1);
  ok('1/1 accepted row uses timetable columns',
    oneRows && oneRows[0] && oneRows[0].kind === '1/1' && oneRows[0].status === 'scheduled'
    && oneRows[0].day === 'MON' && oneRows[0].start === '08:00' && oneRows[0].end === '09:00'
    && oneRows[0].teacherId === 'T1' && 'SCHEDULED_DATA' && api.ACCEPTED_SCHEDULE_CSV_HEADERS.includes('SCHEDULED_DATA'));
  ok('CSV headers match timetable export',
    JSON.stringify(api.ACCEPTED_SCHEDULE_CSV_HEADERS) === JSON.stringify(['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_321','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA']));

  console.log('\n== Accept Required Jazz Piano freezes the slots ==');
  api.LAST_RJPIANO = {scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:11*60, end:12*60}], unresolved:[], accepted:false};
  ok('generated piano is not frozen yet', api.hasAcceptedRjPiano() === false);
  api.acceptRjPianoSchedule();
  ok('unlocked after Accept Required Jazz Piano', api.hasAcceptedRjPiano() === true);
  ok('piano accept flag is persisted in JSON',
    api.buildFullExportObject().rjPianoState && api.buildFullExportObject().rjPianoState.accepted === true);
  const pianoRows = api.LAST_RJPIANO.acceptedSchedule;
  ok('Accept piano writes Accepted schedule rows', Array.isArray(pianoRows) && pianoRows.length === 1);
  ok('piano accepted row uses timetable columns',
    pianoRows && pianoRows[0] && pianoRows[0].kind === 'piano' && pianoRows[0].status === 'scheduled'
    && pianoRows[0].day === 'MON' && pianoRows[0].start === '11:00' && pianoRows[0].end === '12:00');

  console.log('\n== piano packs around accepted groups + 1/1 ==');
  api.DB = clone(seed);
  api.DB.students = toyStudents();
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id:'T1', name:'Piano One'}]);
  api.DB.teacherAvail = DAYS_AVAIL();
  api.DB.classAvail = [];
  api.DB.acceptedSchedule = [{
    status: 'scheduled', teacherId: 'T1', day: 'MON', start: '08:00', end: '10:00',
    studentIds: 'S1', name: 'Group'
  }];
  api.LAST_ONEONE = {
    accepted: true,
    scheduled: [{
      lessonId: 'O2O-T1-S1', name: 'Stu 1 1/1', teacherId: 'T1', studentId: 'S1', studentIds: 'S1',
      day: 'MON', start: 10*60, end: 11*60, source: 'oneone'
    }],
    unresolved: []
  };
  api.DB.rjPiano = {columns: [{id:'T1', name:'Piano One'}], hours: {S1: {T1: 1}}};
  const piano = api.scheduleAllOneToOne({
    matrix: api.DB.rjPiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
    source: 'rjpiano',
    lessonLabel: 'piano',
    idPrefix: 'RJP'
  });
  ok('places the piano hour', piano.scheduled.length === 1 && piano.unresolved.length === 0,
    `scheduled=${piano.scheduled.length} unresolved=${piano.unresolved.length}`);
  const p = piano.scheduled[0];
  ok('does not overlap the group 08:00–10:00 or 1/1 10:00–11:00',
    p.day !== 'MON' || p.start >= 11*60,
    `${p.day} ${api.toHHMM(p.start)}–${api.toHHMM(p.end)}`);
  ok('source is rjpiano', p.source === 'rjpiano');
  ok('id prefix is RJP', p.lessonId === 'RJP-T1-S1');
  ok('label is piano', p.name.endsWith(' piano') && p.group === 'piano');

  const sameTeacherSameDay = piano.scheduled.concat(api.LAST_ONEONE.scheduled).concat([{
    day:'MON', start:8*60, end:10*60
  }]);
  let clash = false;
  for(let i=0;i<sameTeacherSameDay.length;i++){
    for(let j=i+1;j<sameTeacherSameDay.length;j++){
      if(overlaps(sameTeacherSameDay[i], sameTeacherSameDay[j])) clash = true;
    }
  }
  ok('no overlap among group + 1/1 + piano on the toy teacher', clash === false);

  console.log('\n== clear accepted timetable also drops 1/1 + piano ==');
  api.LAST_RJPIANO = {scheduled: piano.scheduled, unresolved: []};
  api.clearAcceptedScheduledRecord();
  ok('1/1 state cleared', api.LAST_ONEONE == null);
  ok('piano state cleared', api.LAST_RJPIANO == null);
  ok('piano tab locked again', api.hasAcceptedOneOne() === false);
  ok('piano accept cleared', api.hasAcceptedRjPiano() === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
}

function DAYS_AVAIL(){
  return ['MON','TUE','WED','THU','FRI'].map(day => ({
    teacher: 'Piano One', teacherId: 'T1', day, start: '08:00', end: '20:00', type: 'AVAILABLE', option: ''
  }));
}

main();
