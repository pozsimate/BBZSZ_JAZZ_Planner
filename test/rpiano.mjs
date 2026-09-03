#!/usr/bin/env node
// Required Piano: Drive JRPiano matrix, Accept 1/1 gate, leftover-hole packing.

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
  const {api, seed, root} = loadApp();
  const appSrc = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');

  ok('rpiano generate progress uses attemptsN (not undefined attempts)',
    /setSearchLiveProgress\(0, attemptsN, searchLiveIndividualCount\(0, attemptsN/.test(appSrc));

  ['rpianoAoa','busyRowsFromScheduled','hasAcceptedOneOne','acceptOneOneSchedule','hasAcceptedRpiano','acceptRpianoSchedule','individualAcceptedRows','individualTeacherIds','scheduleAllOneToOne','canOpenRpiano','isTimetableAccepted'
  ].forEach(name => {
    if(typeof api[name] !== 'function'){
      failed++;
      failures.push('export missing: ' + name);
      console.error('FAIL  export missing: ' + name);
    }
  });

  console.log('\n== Drive JRPiano fixture ==');
  const csvRows = parseCsv(fs.readFileSync(path.join(ROOT, 'test/fixtures/rpiano.csv'), 'utf8'));
  ok('fixture has student rows', csvRows.length >= 70, 'n=' + csvRows.length);
  ok('sheetLooksLike rpiano', api.sheetLooksLike('rpiano', csvRows), Object.keys(csvRows[0]).join(','));
  ok('sheetLooksLike oneToOne also matches the matrix shape', api.sheetLooksLike('oneToOne', csvRows));
  ok('STUDENTS row is rejected',
    api.sheetLooksLike('rpiano', [Object.assign({}, csvRows[0], {CLASS_ID:'CL1', IMPR:'x'})]) === false);

  const parsed = api.parseOneToOneTable(csvRows, seed.refTeachers);
  const jobs = api.collectOneOneAssignments(parsed);
  ok('six piano teacher columns', parsed.columns.length === 6, 'n=' + parsed.columns.length + ' ' + parsed.columns.map(c => c.name).join(','));
  ok('columns include Varallyay', parsed.columns.some(c => c.name === 'Varallyay'));
  ok('44 filled piano cells', jobs.length === 44, 'n=' + jobs.length);
  ok('Hungarian 0,5 → 30 min (Damo / Pozsar)',
    jobs.some(j => j.studentId === 'ST7' && j.hours === 0.5 && j.duration === 30),
    JSON.stringify(parsed.hours.ST7));
  ok('seed matrix matches fixture',
    api.collectOneOneAssignments(seed.rpiano).length === 44,
    'n=' + api.collectOneOneAssignments(seed.rpiano).length);

  console.log('\n== teacher dropdowns are type-specific ==');
  api.DB = clone(seed);
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  const oneIds = api.individualTeacherIds('oneone');
  const pianoIds = api.individualTeacherIds('rpiano');
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
  const aoa = api.rpianoAoa(api.DB);
  ok('export sheet is named rpiano', aoa.name === 'rpiano');
  const sheets = api.driveTablesToAoa(api.DB);
  ok('xlsx includes rpiano after 1_1',
    sheets.some(s => s.name === 'rpiano') && sheets.some(s => s.name === '1_1'));

  const viaSheets = api.sheetsTablesToDb({rpiano: csvRows});
  ok('Drive load parses JRPiano',
    api.collectOneOneAssignments(viaSheets.db.rpiano).length === 44,
    'n=' + api.collectOneOneAssignments((viaSheets.db || {}).rpiano).length);

  api.DB = clone(seed);
  const kept = api.sheetsTablesToDb({});
  ok('missing JRPiano tab keeps the working matrix',
    api.collectOneOneAssignments(kept.db.rpiano).length === 44,
    'n=' + api.collectOneOneAssignments((kept.db || {}).rpiano).length);

  console.log('\n== Accept 1/1 gate ==');
  api.DB = clone(seed);
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
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
    JSON.stringify(api.ACCEPTED_SCHEDULE_CSV_HEADERS) === JSON.stringify(['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_ID','ROOM','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA']));

  console.log('\n== Accept Required Piano freezes the slots ==');
  api.LAST_RPIANO = {scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:11*60, end:12*60}], unresolved:[], accepted:false};
  ok('generated piano is not frozen yet', api.hasAcceptedRpiano() === false);
  api.acceptRpianoSchedule();
  ok('unlocked after Accept Required Piano', api.hasAcceptedRpiano() === true);
  ok('piano accept flag is persisted in JSON',
    api.buildFullExportObject().rpianoState && api.buildFullExportObject().rpianoState.accepted === true);
  const pianoRows = api.LAST_RPIANO.acceptedSchedule;
  ok('Accept piano writes Accepted schedule rows', Array.isArray(pianoRows) && pianoRows.length === 1);
  ok('piano accepted row uses timetable columns',
    pianoRows && pianoRows[0] && pianoRows[0].kind === 'piano' && pianoRows[0].status === 'scheduled'
    && pianoRows[0].day === 'MON' && pianoRows[0].start === '11:00' && pianoRows[0].end === '12:00');

  api.LAST_ONEONE.accepted = false;
  ok('1/1 drag / un-accept keeps piano on file', api.hasAcceptedRpiano() === true);
  ok('1/1 un-accept locks piano tab', api.canOpenRpiano() === false);
  api.acceptOneOneSchedule();
  ok('re-Accept 1/1 keeps piano',
    api.hasAcceptedRpiano() === true && api.LAST_RPIANO != null);
  api.applyIndividualSearch('oneone', [{scheduled: api.LAST_ONEONE.scheduled, unresolved: []}], '');
  api.acceptOneOneSchedule();
  ok('Generate 1/1 with same slots keeps Required Piano',
    api.LAST_RPIANO != null && api.hasAcceptedRpiano() === true);
  api.LAST_RPIANO = {scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:11*60, end:12*60}], unresolved:[], accepted:true};
  api.LAST_ONEONE = null;
  api.applyIndividualSearch('oneone', [{scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:11*60, end:12*60}], unresolved: []}], '', 'T1');
  ok('Generate 1/1 that clashes keeps Required Piano',
    api.LAST_RPIANO != null && api.hasAcceptedRpiano() === true);
  ok('Generate 1/1 that clashes is reported',
    api.collectOneOneRpianoClashes(api.LAST_ONEONE.scheduled, api.LAST_RPIANO.scheduled).length >= 1);

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
  api.DB.rpiano = {columns: [{id:'T1', name:'Piano One'}], hours: {S1: {T1: 1}}};
  const piano = api.scheduleAllOneToOne({
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  });
  ok('places the piano hour', piano.scheduled.length === 1 && piano.unresolved.length === 0,
    `scheduled=${piano.scheduled.length} unresolved=${piano.unresolved.length}`);
  const p = piano.scheduled[0];
  ok('does not overlap the group 08:00–10:00 or 1/1 10:00–11:00',
    p.day !== 'MON' || p.start >= 11*60,
    `${p.day} ${api.toHHMM(p.start)}–${api.toHHMM(p.end)}`);
  ok('source is rpiano', p.source === 'rpiano');
  ok('id prefix is RP', p.lessonId === 'RP-T1-S1');
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
  api.LAST_RPIANO = {scheduled: piano.scheduled, unresolved: []};
  api.clearAcceptedScheduledRecord();
  ok('1/1 state cleared', api.LAST_ONEONE == null);
  ok('piano state cleared', api.LAST_RPIANO == null);
  ok('piano tab locked again', api.hasAcceptedOneOne() === false);
  ok('piano accept cleared', api.hasAcceptedRpiano() === false);

  console.log('\n== generate one piano teacher keeps the other ==');
  api.DB = clone(seed);
  api.DB.students = ['S1','S2'].map((id, i) => ({
    ID: id, NAME1: 'Stu', NAME2: String(i+1), NAME3: '', INSTR_ID: 'INST6', CLASS_ID: ''
  }));
  api.DB.refTeachers = [
    {id:'T1', name:'Piano One'},
    {id:'T2', name:'Piano Two'}
  ];
  api.DB.teacherAvail = ['MON','TUE','WED','THU','FRI'].flatMap(day => [
    {teacherId:'T1', day, start:'08:00', end:'20:00', type:'AVAILABLE'},
    {teacherId:'T2', day, start:'08:00', end:'20:00', type:'AVAILABLE'}
  ]);
  api.DB.classAvail = [];
  api.DB.acceptedSchedule = [];
  api.LAST_ONEONE = {scheduled: [], unresolved: [], accepted: true};
  api.DB.rpiano = {
    columns: [{id:'T1', name:'Piano One'}, {id:'T2', name:'Piano Two'}],
    hours: {S1: {T1: 0.5}, S2: {T2: 0.5}}
  };
  api.LAST_RPIANO = null;
  const p1 = api.generateIndividualScoped('rpiano', 'T1');
  api.applyIndividualSearch('rpiano', p1.variants, 'T1', 'T1');
  ok('first piano generate places only T1',
    (api.LAST_RPIANO.scheduled || []).length >= 1
    && (api.LAST_RPIANO.scheduled || []).every(s => s.teacherId === 'T1'));
  const pianoT1 = clone(api.LAST_RPIANO.scheduled[0]);
  const p2 = api.generateIndividualScoped('rpiano', 'T2');
  api.applyIndividualSearch('rpiano', p2.variants, 'T2', 'T2');
  ok('second piano teacher keeps the first',
    (api.LAST_RPIANO.scheduled || []).some(s =>
      s.teacherId === 'T1' && s.day === pianoT1.day && s.start === pianoT1.start));
  ok('second piano teacher is placed',
    (api.LAST_RPIANO.scheduled || []).some(s => s.teacherId === 'T2'));

  console.log('\n== generate two piano teachers at once ==');
  api.LAST_RPIANO = null;
  const both = api.generateIndividualScoped('rpiano', ['T1', 'T2']);
  api.applyIndividualSearch('rpiano', both.variants, ['T1', 'T2'], ['T1', 'T2']);
  ok('multi-teacher piano generate places T1',
    (api.LAST_RPIANO.scheduled || []).some(s => s.teacherId === 'T1'));
  ok('multi-teacher piano generate places T2',
    (api.LAST_RPIANO.scheduled || []).some(s => s.teacherId === 'T2'));
  ok('multi-teacher view ids saved',
    Array.isArray(api.LAST_RPIANO.viewTeacherIds)
    && api.LAST_RPIANO.viewTeacherIds.includes('T1')
    && api.LAST_RPIANO.viewTeacherIds.includes('T2'));

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
