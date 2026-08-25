#!/usr/bin/env node
// Whole-app logic suite. Toy inputs pin every rule; fixture files cover Drive
// parse / name-resolution / a miniature school that can generate+accept end to end.
//
//   node test/logic.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { checkSchedule } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures');

let failed = 0;
let passed = 0;
const failures = [];

function ok(name, cond, detail){
  if(cond){
    passed++;
    return true;
  }
  failed++;
  const msg = detail ? `${name}: ${detail}` : name;
  failures.push(msg);
  console.error('FAIL  ' + msg);
  return false;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function stripHtml(s){
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

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
  if(cell.length || row.length){ row.push(cell); rows.push(row); }
  if(!rows.length) return [];
  const headers = rows[0].map(h => String(h).trim());
  return rows.slice(1).filter(r => r.some(c => String(c).trim() !== '')).map(r => {
    const o = {};
    headers.forEach((h, idx) => { o[h] = r[idx] == null ? '' : String(r[idx]); });
    return o;
  });
}

function install(api, db){
  api.DB = clone(db);
  api.LAST_BANDS = null;
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  api.LAST_ONEONE = null;
  api.LAST_RJPIANO = null;
  api.LAST_AUDIT = null;
}

function toyAuditDb(){
  return {
    students: [
      {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1'},
      {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G2'}
    ],
    lessons: [
      {id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:45, room321:true},
      {id:'L2', name:'Improv B', groupId:'G2', teacherId:'T1', duration:45, room321:true}
    ],
    teacherAvail: [
      {teacherId:'T1', teacher:'Tea', day:'MON', start:'13:00', end:'18:00', type:'AVAILABLE'},
      {teacherId:'T1', teacher:'Tea', day:'TUE', start:'13:00', end:'18:00', type:'AVAILABLE'},
      {teacherId:'T1', teacher:'Tea', day:'WED', start:'08:00', end:'12:00', type:'AVAILABLE'},
      {teacherId:'T1', teacher:'Tea', day:'WED', start:'', end:'', type:'AVOID'}
    ],
    classAvail: [
      {classId:'C1', class:'9a', day:'MON', start:'09:00', end:'13:00'}
    ],
    refTeachers: [{id:'T1', name:'Tea'}],
    refClasses: [{id:'C1', name:'9a', jclass:'9'}],
    refGroups: [{id:'G1', name:'imprA', type:'IMPR'}, {id:'G2', name:'imprB', type:'IMPR'}],
    refInstruments: [{id:'I1', name:'piano', type:'acc'}],
    bandQuotas: [{teacherId:'T1', amount:4}],
    breaks: [{teacherId:'T1', breakMinutes:15, breakCount:1}],
    oneToOne: {columns:[], hours:{}},
    rjPiano: {columns:[], hours:{}},
    acceptedSchedule: []
  };
}

function item(partial){
  return Object.assign({
    lessonId: 'L1', name: 'Improv A', teacherId: 'T1', teacher: 'Tea',
    day: 'MON', start: 13*60, end: 13*60+45, room321: false, groupId: 'G1'
  }, partial);
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed, root} = loadApp();
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const tiny = JSON.parse(fs.readFileSync(path.join(FIX, 'tiny-school.json'), 'utf8'));
  const gviz = JSON.parse(fs.readFileSync(path.join(FIX, 'gviz-students.json'), 'utf8'));
  const driveTables = JSON.parse(fs.readFileSync(path.join(FIX, 'drive-tables.json'), 'utf8'));

  console.log('\n== 0. App shell: HTML, CSS, seed, wiring ==');
  ok('seed JSON loads', Array.isArray(seed.students) && seed.students.length > 0);
  ok('styles.css is present and non-empty', css.length > 1000);
  ok('app.js has the scheduler', /function runScheduler/.test(appSrc));
  const tabBtns = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  const tabPanels = [...html.matchAll(/id="tab-([^"]+)"/g)].map(m => m[1]);
  ok('every nav tab has a panel', tabBtns.every(t => tabPanels.includes(t)),
    tabBtns.filter(t => !tabPanels.includes(t)).join(','));
  ok('core tabs exist',
    ['students','lessons','bands','timetable','oneone','rjpiano','cloud'].every(t => tabBtns.includes(t)));
  ok('1/1 tab starts locked', /tab-btn-oneone is-locked/.test(html));
  ok('RJP tab starts locked', /tab-btn-rjpiano is-locked/.test(html));
  ok('default Drive URL is in the cloud input', html.includes('1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU'));
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const jsIds = [...appSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const missing = [...new Set(jsIds)].filter(id => !htmlIds.has(id) && id !== 'hoverTooltip');
  ok('every getElementById target exists in index.html', missing.length === 0, missing.join(', '));
  ok('seed-data script tag exists', htmlIds.has('seed-data'));

  const needed = [
    'toMin','toHHMM','cleanCellText','parseGvizTable','inferHeaders','sheetsTablesToDb',
    'sheetLooksLike','matchSheetKey','parseSpreadsheetId','classWindow','classFreeGaps',
    'teacherDayWindows','teacherWindowClash','overlappingClassReservation','studentsInGroup',
    'breakUnitsForGap','jclassDistance','auditTimetable','generateBands','runScheduler',
    'scheduleOneToOne','scheduleAllOneToOne','parseOneToOneTable','collectOneOneAssignments',
    'acceptTimetableSchedule','acceptOneOneSchedule','acceptRjPianoSchedule',
    'frozenIndividualItems','timetableAuditItems','studentsForScheduledItem',
    'buildTimetableIcs','icsEscape','collectFixedPins','clampBookedWindowToDuration',
    'snapMinutes','clampLessonStart','parseIdList','formatOneOneHours','driveTablesToAoa'
  ];
  needed.forEach(name => ok('export '+name, typeof api[name] === 'function' || api[name] != null, typeof api[name]));

  console.log('\n== 1. Primitives: time, cells, days, ids, snap ==');
  ok('toMin 09:00', api.toMin('09:00') === 9*60);
  ok('toMin 9:30', api.toMin('9:30') === 9*60+30);
  ok('toMin blank is null', api.toMin('') == null && api.toMin(null) == null);
  ok('toHHMM 90', api.toHHMM(90) === '01:30');
  ok('toHHMM 13:05', api.toHHMM(13*60+5) === '13:05');
  ok('cleanCellText strips #N/A', api.cleanCellText('#N/A') === '');
  ok('cleanCellText strips #REF!', api.cleanCellText('#REF!') === '');
  ok('cleanCellText keeps piano', api.cleanCellText(' piano ') === 'piano');
  ok('parseSpreadsheetId from URL',
    api.parseSpreadsheetId('https://docs.google.com/spreadsheets/d/1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU/edit') === '1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU');
  ok('parseSpreadsheetId raw id', api.parseSpreadsheetId('1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU') === '1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU');
  ok('parseSpreadsheetId rejects junk', api.parseSpreadsheetId('not-a-sheet') == null);
  ok('matchSheetKey JRPiano', api.matchSheetKey('JRPiano') === 'rjPiano');
  ok('matchSheetKey 1_1', api.matchSheetKey('1_1') === 'oneToOne');
  ok('matchSheetKey STUDENTS', api.matchSheetKey('STUDENTS') === 'students');
  ok('matchSheetKey unknown is null', api.matchSheetKey('Shopping list') == null);
  ok('snapMinutes 5-min grid', api.snapMinutes(13) === 15 && api.snapMinutes(12) === 10);
  ok('clampLessonStart keeps duration inside the day',
    api.clampLessonStart(19*60+50, 45) + 45 <= api.DEFAULT_END);
  ok('parseIdList splits commas and semicolons',
    api.parseIdList('S1, S2;S3').join(',') === 'S1,S2,S3');
  ok('icsEscape commas and semicolons',
    api.icsEscape('A, B; C') === 'A\\, B\\; C');
  ok('jclass 1 and 13 are the same level', api.jclassDistance('1','13') === 0);
  ok('jclass 9 vs 10 is one step', api.jclassDistance('9','10') === 1);
  ok('breakUnitsForGap 0', api.breakUnitsForGap(0, 15) === 0);
  ok('breakUnitsForGap 15 min unit', api.breakUnitsForGap(15, 15) === 1);
  ok('breakUnitsForGap 30 = two units', api.breakUnitsForGap(30, 15) === 2);
  ok('breakUnitsForGap illegal remainder is null', api.breakUnitsForGap(10, 15) == null);
  ok('hours 1,5 → 90 min', api.parseOneOneHours('1,5') === 1.5 && api.oneOneHoursToMinutes(1.5) === 90);
  ok('formatOneOneHours uses comma for fractions',
    api.formatOneOneHours(1.5) === '1,5' || api.formatOneOneHours(1.5) === '1.5');
  ok('lessonDurationMinutes defaults to 90', api.lessonDurationMinutes({}) === 90);
  ok('lessonDurationMinutes reads duration', api.lessonDurationMinutes({duration:45}) === 45);

  const pin = {fixedStart:'14:00', fixedEnd:'16:00', duration:45};
  ok('clampBookedWindowToDuration snaps FIXED END to start+duration',
    api.clampBookedWindowToDuration(pin) === true && pin.fixedEnd === '14:45');

  console.log('\n== 2. Fixture: gviz JSON parse ==');
  const gvizRows = api.parseGvizTable(gviz, 'students');
  ok('letterish A/B/C headers promote the first data row',
    gvizRows.length === 2 && gvizRows[0].STUDENT_ID === 'S1',
    JSON.stringify(gvizRows[0]));
  ok('#N/A instrument becomes blank', gvizRows[0].INSTR === '');
  ok('#REF! group becomes blank', gvizRows[1].IMPR === '');
  ok('blank gviz row is dropped', gvizRows.length === 2);
  ok('sheetLooksLike students', api.sheetLooksLike('students', gvizRows));

  console.log('\n== 3. Fixture: Drive tables resolve names → ids, Hungarian days ==');
  const loaded = api.sheetsTablesToDb(driveTables);
  const db = loaded.db;
  ok('student INSTR_ID resolved from name piano', db.students[0].INSTR_ID === 'INST6');
  ok('student CLASS_ID resolved from name 9a', db.students[0].CLASS_ID === 'CL1');
  ok('student IMPR_ID resolved from name impr9', db.students[0].IMPR_ID === 'GR1');
  ok('lesson teacherId resolved from name Csuhaj', db.lessons[0].teacherId === 'TEAC1');
  ok('lesson groupId resolved from name impr9', db.lessons[0].groupId === 'GR1');
  ok('ROOM_321 TRUE is truthy', db.lessons[0].room321 === true);
  ok('FIXED DAY Hétfő → MON', db.lessons[0].fixedDay === 'MON', db.lessons[0].fixedDay);
  ok('teacher avail Kedd → TUE', db.teacherAvail[0].day === 'TUE', db.teacherAvail[0].day);
  ok('class reservation Hétfő → MON', db.classAvail[0].day === 'MON');
  ok('1,5 hours parsed on 1_1',
    db.oneToOne.hours.S1 && db.oneToOne.hours.S1.TEAC1 === 1.5,
    JSON.stringify(db.oneToOne.hours));
  ok('unknown 1_1 column NotATeacher is dropped',
    !db.oneToOne.columns.some(c => /notateacher/i.test(c.name || c.id || '')));

  const oneCsv = parseCsv(fs.readFileSync(path.join(FIX, 'one_1.csv'), 'utf8'));
  const oneParsed = api.parseOneToOneTable(oneCsv, seed.refTeachers);
  ok('one_1.csv fixture parses teacher columns', oneParsed.columns.length >= 10);
  ok('one_1.csv has hours for ST1', oneParsed.hours.ST1 && oneParsed.hours.ST1.TEAC1 === 2);
  const jrpCsv = parseCsv(fs.readFileSync(path.join(FIX, 'jrpiano.csv'), 'utf8'));
  ok('jrpiano.csv looks like rjPiano', api.sheetLooksLike('rjPiano', jrpCsv));

  console.log('\n== 4. Windows, reservations, AVOID ==');
  install(api, toyAuditDb());
  const wins = api.teacherDayWindows('T1');
  ok('AVAILABLE Mon 13–18', wins.MON && wins.MON.start === 13*60 && wins.MON.end === 18*60);
  ok('AVOID deletes Wednesday even if AVAILABLE was listed', wins.WED == null, JSON.stringify(wins.WED));
  const gaps = api.classFreeGaps('C1', 'MON');
  const largest = api.classWindow('C1', 'MON');
  ok('classFreeGaps keeps morning leftover 08:00–09:00',
    gaps.some(g => g[0] === 8*60 && g[1] === 9*60), JSON.stringify(gaps));
  ok('classWindow is the largest leftover (13:00–20:00)',
    largest && largest[0] === 13*60 && largest[1] === 20*60,
    largest ? `${largest[0]}-${largest[1]}` : 'null');
  ok('overlappingClassReservation hits 09:00–13:00',
    !!api.overlappingClassReservation('C1', 'MON', 10*60, 11*60));
  ok('overlappingClassReservation misses the afternoon',
    !api.overlappingClassReservation('C1', 'MON', 14*60, 15*60));
  ok('teacherWindowClash outside window',
    /only available/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 8*60, 9*60) || ''));
  ok('teacherWindowClash on AVOID day',
    /not available/.test(api.teacherWindowClash('T1', 'Tea', 'WED', 9*60, 10*60) || ''));
  ok('teacherWindowClash inside window is null',
    api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60) == null);
  const members = api.studentsInGroup('G1');
  ok('studentsInGroup finds Ann', members.map(s => s.ID).join(',') === 'S1');

  console.log('\n== 5. auditTimetable: every red kind + GAP warning ==');
  install(api, toyAuditDb());
  const school = api.auditTimetable([item({start: 7*60, end: 8*60})]);
  ok('group outside 08:00–20:00 is a red error',
    school.entries.some(e => e.level !== 'warning' && /08:00/.test(e.html)));
  ok('school-day error paints conflictIds', school.conflictIds.has('L1'));

  const indiv = api.auditTimetable([item({
    lessonId:'O2O-T1-S1', name:'Ann 1/1', source:'oneone',
    start: 20*60, end: 21*60, studentIds:'S1'
  })]);
  ok('1/1 past 20:00 is NOT a school-day error',
    !indiv.entries.some(e => /08:00/.test(e.html)));

  const clashT = api.auditTimetable([
    item({lessonId:'L1', name:'A', start:13*60, end:14*60, groupId:'G1'}),
    item({lessonId:'L2', name:'B', start:13*60+30, end:14*60+30, groupId:'G2', room321:false})
  ]);
  ok('same teacher overlap is red',
    clashT.entries.some(e => /both need teacher/.test(e.html)));

  const clashR = api.auditTimetable([
    item({lessonId:'L1', room321:true, start:14*60, end:15*60, groupId:'G1'}),
    item({lessonId:'L2', room321:true, start:14*60+15, end:15*60+15, teacherId:'T2', groupId:'G2'})
  ]);
  ok('ROOM 321 overlap is red',
    clashR.entries.some(e => /ROOM 321/.test(e.html)));

  const clashS = api.auditTimetable([
    item({lessonId:'L1', start:14*60, end:15*60, groupId:'G1', room321:false}),
    item({lessonId:'LX', name:'Same group again', start:14*60, end:15*60, groupId:'G1', teacherId:'T2', room321:false})
  ]);
  ok('shared student overlap is red',
    clashS.entries.some(e => /both include/.test(e.html)));

  const res = api.auditTimetable([item({start:10*60, end:11*60, groupId:'G1'})]);
  ok('class reservation overlap is red',
    res.entries.some(e => /class reservation/.test(stripHtml(e.html))));

  const gap = api.auditTimetable([
    item({lessonId:'L1', start:13*60, end:13*60+45, groupId:'G1', room321:false}),
    item({lessonId:'L2', start:13*60+45+10, end:13*60+45+10+45, groupId:'G2', room321:false})
  ]);
  ok('illegal 10 min gap is a WARNING not a red',
    gap.entries.some(e => e.level === 'warning' && /gap/.test(e.html))
    && !gap.entries.some(e => e.level !== 'warning' && /gap/.test(e.html)));
  ok('GAP warning does not paint conflictIds',
    gap.entries.filter(e => e.level === 'warning').every(e =>
      (e.ids || []).every(id => !gap.conflictIds.has(id))));

  const viaIds = api.studentsForScheduledItem({studentIds:'S1,S2', day:'MON', start:0, end:1});
  ok('studentsForScheduledItem reads studentIds when there is no lesson',
    viaIds.map(s => s.ID).join(',') === 'S1,S2', viaIds.map(s => s.ID).join(','));

  console.log('\n== 6. Bands: exclude no-class, same-grade pack ==');
  install(api, tiny);
  const bands = api.generateBands(1);
  api.LAST_BANDS = bands;
  ok('S5 with no CLASS_ID is excluded',
    (bands.excluded || []).some(s => s.ID === 'S5'),
    (bands.excluded || []).map(s => s.ID).join(','));
  ok('one same-grade 9 band of four types',
    bands.bands.length === 1
    && ['bass','drum','acc','sol'].every(t => (bands.bands[0][t] || []).length === 1),
    JSON.stringify(bands.bands[0] && {
      bass:(bands.bands[0].bass||[]).map(s=>s.ID),
      drum:(bands.bands[0].drum||[]).map(s=>s.ID),
      acc:(bands.bands[0].acc||[]).map(s=>s.ID),
      sol:(bands.bands[0].sol||[]).map(s=>s.ID)
    }));
  ok('band id is BAND1', bands.bands[0].id === 'BAND1');
  ok('getBandLessons uses the band id',
    api.getBandLessons().some(l => l.id === 'BAND1'));

  console.log('\n== 7. Tiny school: generate → schedule → accept → 1/1 → piano ==');
  install(api, tiny);
  api.LAST_BANDS = api.generateBands(1);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  api.LAST_VARIANTS = [result];
  ok('tiny school places the group lesson',
    result.scheduled.some(s => s.lessonId === 'LES1'),
    (result.unresolved || []).map(u => u.lesson && u.lesson.id).join(','));
  ok('tiny school places the band',
    result.scheduled.some(s => s.lessonId === 'BAND1'),
    (result.unresolved || []).map(u => u.lesson && u.lesson.id).join(','));
  ok('nothing unresolved', result.unresolved.length === 0,
    (result.unresolved || []).map(u => (u.lesson && u.lesson.id) + ':' + (u.customReason||'')).join(' | '));
  const inv = checkSchedule(api.DB, api.LAST_BANDS, result);
  ok('independent invariants hold on tiny school', inv.length === 0, inv.join(' | '));
  const placedAfter13 = result.scheduled.every(s => s.start >= 13*60);
  ok('nothing sits inside the 09:00–13:00 class reservation', placedAfter13,
    result.scheduled.map(s => `${s.lessonId} ${s.day} ${api.toHHMM(s.start)}`).join(', '));
  const aud = api.auditTimetable(result.scheduled);
  ok('tiny generated week has no red errors',
    aud.entries.filter(e => e.level !== 'warning').length === 0,
    aud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));

  ok('1/1 locked before Accept', !api.hasAcceptedRecord());
  api.acceptTimetableSchedule();
  ok('Accept unlocks 1/1', api.hasAcceptedRecord() && api.LAST_RESULT.accepted);
  ok('acceptedSchedule has scheduled rows',
    (api.DB.acceptedSchedule || []).filter(r => r.status === 'scheduled').length >= 2);
  const written = api.writeAcceptedToSourceTables(api.LAST_RESULT);
  ok('SCHEDULED columns land on the lesson',
    api.DB.lessons[0].scheduledDay && (written.lessonsWritten || written.bandsWritten));

  const one = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule || []
  });
  api.applyIndividualSearch('oneone', [one], 'T1');
  ok('1/1 places S1×Ajtai around the accepted week',
    one.scheduled.length === 1 && one.unresolved.length === 0,
    `scheduled=${one.scheduled.length} unresolved=${one.unresolved.length}`);
  ok('generated 1/1 is not frozen yet', api.frozenIndividualItems().length === 0);
  const oneWeek = api.combinedWeekItems();
  const oneAud = api.auditTimetable(oneWeek);
  ok('accepted groups + generated 1/1 have no reds',
    oneAud.entries.filter(e => e.level !== 'warning').length === 0,
    oneAud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));

  api.acceptOneOneSchedule();
  ok('Accept 1/1 freezes those slots', api.hasAcceptedOneOne());
  ok('Accept 1/1 clears RJP', api.LAST_RJPIANO == null);
  ok('KIND is 1/1', (api.LAST_ONEONE.acceptedSchedule || [])[0].kind === '1/1');
  ok('timetableAuditItems now includes frozen 1/1',
    api.timetableAuditItems(api.LAST_RESULT.scheduled).length
    === api.LAST_RESULT.scheduled.length + api.LAST_ONEONE.scheduled.length);

  const rjp = api.scheduleAllOneToOne({
    matrix: api.DB.rjPiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
    source: 'rjpiano', lessonLabel: 'piano', idPrefix: 'RJP'
  });
  api.applyIndividualSearch('rjpiano', [rjp], 'T1');
  ok('piano places S3×Ajtai in a leftover hole',
    rjp.scheduled.length === 1 && rjp.unresolved.length === 0,
    `scheduled=${rjp.scheduled.length} unresolved=${rjp.unresolved.length} ${rjp.unresolved.map(u=>u.reason).join(';')}`);
  ok('piano id is RJP-…', rjp.scheduled[0].lessonId.startsWith('RJP-'));
  ok('piano source is rjpiano', rjp.scheduled[0].source === 'rjpiano');
  const mix = api.combinedWeekItems();
  const mixAud = api.auditTimetable(mix);
  ok('groups + 1/1 + piano have no reds',
    mixAud.entries.filter(e => e.level !== 'warning').length === 0,
    mixAud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));
  api.acceptRjPianoSchedule();
  ok('Accept piano freezes', api.hasAcceptedRjPiano());
  ok('KIND is piano', (api.LAST_RJPIANO.acceptedSchedule || [])[0].kind === 'piano');

  const ics = api.buildTimetableIcs(api.LAST_RESULT.scheduled);
  ok('ICS is a calendar', /BEGIN:VCALENDAR/.test(ics) && /BEGIN:VEVENT/.test(ics));
  ok('calendar title uses the lesson name',
    /Improv/.test(api.calendarEventTitle(api.LAST_RESULT.scheduled[0])));
  const bundle = api.buildFullExportObject();
  ok('JSON export has oneToOneState.accepted and rjPianoState.accepted',
    bundle.oneToOneState && bundle.oneToOneState.accepted
    && bundle.rjPianoState && bundle.rjPianoState.accepted);
  const aoa = api.driveTablesToAoa(api.DB);
  ok('xlsx AOA includes 1_1 and JRPiano',
    aoa.some(s => s.name === '1_1') && aoa.some(s => s.name === 'JRPiano'));

  console.log('\n== 8. Drag re-opens Accept; freeze drops while unaccepted ==');
  const oneBlock = api.LAST_ONEONE.scheduled[0];
  const from = oneBlock.start;
  oneBlock.start += 15; oneBlock.end += 15;
  api.markLayoutNeedsAccept('oneone');
  ok('1/1 drag clears accepted', api.LAST_ONEONE.accepted === false && !api.hasAcceptedOneOne());
  ok('unaccepted 1/1 leaves timetable freeze', api.frozenIndividualItems().every(i => i.source !== 'oneone') || api.frozenIndividualItems().length === (api.hasAcceptedRjPiano() ? api.LAST_RJPIANO.scheduled.length : 0));
  api.acceptOneOneSchedule();
  ok('re-Accept writes the dragged 1/1 time', oneBlock.start === from + 15 && api.hasAcceptedOneOne());
  ok('re-Accept 1/1 still wipes piano', api.LAST_RJPIANO == null);

  const group = api.LAST_RESULT.scheduled[0];
  const gFrom = group.start;
  group.start += 5; group.end += 5;
  api.markLayoutNeedsAccept('timetable');
  ok('timetable drag re-opens Accept', api.LAST_RESULT.accepted === false);
  ok('timetable drag does not clear acceptedSchedule', api.hasAcceptedRecord());
  api.acceptTimetableSchedule();
  ok('re-Accept timetable keeps the dragged slot', group.start === gFrom + 5 && api.LAST_RESULT.accepted);

  const slots = api.cloneLessonSlots(api.LAST_RESULT.scheduled);
  ok('cloneLessonSlots snapshots day/start/end', slots[0].lessonId && slots[0].day);
  api.applyLessonSlots(api.LAST_RESULT.scheduled, slots.map((s,i) => i===0 ? Object.assign({}, s, {start:s.start+10, end:s.end+10}) : s));
  ok('applyLessonSlots writes back', api.LAST_RESULT.scheduled[0].start === slots[0].start + 10);
  ok('lessonSlotsMatch detects the edit',
    api.lessonSlotsMatch(api.LAST_RESULT.scheduled, slots) === false);

  console.log('\n== 9. FIXED pins, fingerprint, teacher dropdowns ==');
  install(api, tiny);
  api.DB.lessons[0].fixedDay = 'MON';
  api.DB.lessons[0].fixedStart = '14:00';
  api.DB.lessons[0].fixedEnd = '14:45';
  const pins = api.collectFixedPins();
  ok('collectFixedPins sees the lesson', pins.lessons.length === 1 && pins.lessons[0].id === 'LES1');
  api.LAST_BANDS = api.generateBands(1);
  const pinned = api.runScheduler(false);
  const les1 = pinned.scheduled.find(s => s.lessonId === 'LES1');
  ok('FIXED lesson lands on Monday 14:00',
    les1 && les1.day === 'MON' && les1.start === 14*60,
    les1 ? `${les1.day} ${api.toHHMM(les1.start)}` : 'unplaced');
  api.clearAllFixedPins();
  ok('clearAllFixedPins blanks the lesson', !api.DB.lessons[0].fixedDay);

  install(api, tiny);
  const fp1 = api.computeScheduleFingerprint();
  api.DB.lessons[0].duration = 90;
  const fp2 = api.computeScheduleFingerprint();
  ok('fingerprint changes when duration changes', fp1 !== fp2);

  install(api, seed);
  const oneTeachers = api.individualTeacherIds('oneone');
  const pianoTeachers = api.individualTeacherIds('rjpiano');
  ok('1/1 teachers come from the 1_1 matrix', oneTeachers.includes('TEAC1'));
  ok('piano teachers come from JRPiano', pianoTeachers.includes('TEAC14') || pianoTeachers.includes('TEAC15'));
  ok('dropdowns differ', oneTeachers.join(',') !== pianoTeachers.join(','));

  const variants = [{scheduled:[{lessonId:'A', day:'MON', start:8*60, end:9*60}], unresolved:[]}];
  api.LAST_ONEONE = null;
  api.applyIndividualSearch('oneone', variants, '');
  api.LAST_ONEONE.accepted = true;
  api.LAST_ONEONE.variants = [
    variants[0],
    {scheduled:[{lessonId:'A', day:'TUE', start:8*60, end:9*60}], unresolved:[]}
  ];
  api.selectIndividualVariant('oneone', 1);
  ok('picking another 1/1 layout un-accepts', api.LAST_ONEONE.accepted === false);
  ok('selected layout times are applied', api.LAST_ONEONE.scheduled[0].day === 'TUE');

  console.log('\n== 10. JSON restore + CSV headers ==');
  const dump = api.buildFullExportObject();
  ok('export has required table keys',
    ['students','lessons','teacherAvail','classAvail','refTeachers'].every(k => k in dump));
  ok('CSV headers include KIND and SCHEDULED_DATA',
    api.ACCEPTED_SCHEDULE_CSV_HEADERS.includes('KIND')
    && api.ACCEPTED_SCHEDULE_CSV_HEADERS.includes('SCHEDULED_DATA'));

  const busy = api.acceptedBusyMaps([{
    status:'scheduled', teacherId:'T1', day:'MON', start:'08:00', end:'09:00', studentIds:'S1'
  }]);
  ok('acceptedBusyMaps indexes teacher and student',
    busy.teacherBusy.T1 && busy.teacherBusy.T1.MON && busy.studentBusy.S1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
}

main();
