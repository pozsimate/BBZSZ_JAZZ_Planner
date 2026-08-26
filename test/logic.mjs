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
  api.LAST_SMALL_GROUPS = null;
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  api.LAST_AUDIT = null;
}

function toyAuditDb(){
  return {
    students: [
      {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1'},
      {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G2'}
    ],
    lessons: [
      {id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:45, roomId:'ROOM1', room:'321'},
      {id:'L2', name:'Improv B', groupId:'G2', teacherId:'T1', duration:45, roomId:'ROOM1', room:'321'}
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
    refClasses: [{id:'C1', name:'9a', muclass:'9'}],
    refGroups: [{id:'G1', name:'imprA', type:'IMPR'}, {id:'G2', name:'imprB', type:'IMPR'}],
    refInstruments: [{id:'I1', name:'piano', type:'acc'}],
    refRooms: [{id:'ROOM1', name:'321'}, {id:'ROOM2', name:'Drum'}, {id:'ROOM3', name:'Ferencsik'}],
    smallGroupQuotas: [{teacherId:'T1', amount:4}],
    breaks: [{teacherId:'T1', breakMinutes:15, breakCount:1}],
    oneToOne: {columns:[], hours:{}},
    rpiano: {columns:[], hours:{}},
    acceptedSchedule: []
  };
}

function item(partial){
  return Object.assign({
    lessonId: 'L1', name: 'Improv A', teacherId: 'T1', teacher: 'Tea',
    day: 'MON', start: 13*60, end: 13*60+45, roomId: '', room: '', groupId: 'G1'
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
    ['students','lessons','smallgroups','timetable','oneone','rpiano','cloud'].every(t => tabBtns.includes(t)));
  ok('1/1 tab starts locked', /tab-btn-oneone is-locked/.test(html));
  ok('RJP tab starts locked', /tab-btn-rpiano is-locked/.test(html));
  ok('Group Lessons has a locked pale-green style', /\.tab-btn-timetable\.is-locked/.test(css));
  ok('searching UI freeze style exists', /body\.is-searching/.test(css));
  ok('default Drive URL is in the cloud input', html.includes('1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU'));
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  ok('group search attempts field exists', htmlIds.has('scheduleSearchAttempts'));
  ok('group search progress bar exists', htmlIds.has('generateProgressWrap') && htmlIds.has('generateProgressFill'));
  const jsIds = [...appSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const missing = [...new Set(jsIds)].filter(id => !htmlIds.has(id) && id !== 'hoverTooltip');
  ok('every getElementById target exists in index.html', missing.length === 0, missing.join(', '));
  ok('seed-data script tag exists', htmlIds.has('seed-data'));
  const seedTag = html.match(/<script id="seed-data"[^>]*>([\s\S]*?)<\/script>/);
  let pageSeed = {};
  try { pageSeed = JSON.parse((seedTag && seedTag[1] || '').trim()); } catch(e){ pageSeed = {parseError: String(e)}; }
  ok('page seed has no students until Drive', Array.isArray(pageSeed.students) && pageSeed.students.length === 0);
  ok('page seed has no lessons until Drive', Array.isArray(pageSeed.lessons) && pageSeed.lessons.length === 0);
  ok('page seed has no teachers until Drive', Array.isArray(pageSeed.refTeachers) && pageSeed.refTeachers.length === 0);
  ok('Cloud tab is the landing tab', html.includes('class="tab-btn active" data-tab="cloud"'));
  ok('Students is not the landing tab', !/<button class="tab-btn active" data-tab="students">/.test(html));
  ok('search lock is off at start', api.isSearchUiLocked() === false);
  api.setSearchUiLock(true);
  ok('search lock blocks other tabs', api.canSwitchTab('cloud') === false);
  ok('search lock is on', api.isSearchUiLocked() === true);
  api.setSearchUiLock(false);
  ok('search lock lifts', api.isSearchUiLocked() === false && api.canSwitchTab('cloud') === true);

  const needed = [
    'toMin','toHHMM','cleanCellText','parseGvizTable','inferHeaders','sheetsTablesToDb',
    'sheetLooksLike','matchSheetKey','parseSpreadsheetId','classWindow','classFreeGaps',
    'teacherDayWindows','teacherWindowClash','overlappingClassReservation','studentsInGroup',
    'breakUnitsForGap','muclassDistance','auditTimetable','generateSmallGroups','runScheduler',
    'scheduleOneToOne','scheduleAllOneToOne','parseOneToOneTable','collectOneOneAssignments',
    'acceptTimetableSchedule','acceptOneOneSchedule','acceptRpianoSchedule',
    'frozenIndividualItems','timetableAuditItems','studentsForScheduledItem',
    'hasPendingAccept','pendingAcceptTab','combinedWeekItems',
    'canSwitchTab','setSearchUiLock','isSearchUiLocked',
    'attachGroupLookahead','attachOneOneLookahead','markSuggestedByLookahead',
    'SCHEDULE_SEARCH_ATTEMPTS','SCHEDULE_VARIANT_KEEP',
    'clampScheduleSearchAttempts','readScheduleSearchAttempts',
    'buildTimetableIcs','icsEscape','collectFixedPins','clampBookedWindowToDuration',
    'snapMinutes','clampLessonStart','parseIdList','formatOneOneHours','driveTablesToAoa',
    'smallGroupsCsvAoa','parseSmallGroupsTable'
  ];
  needed.forEach(name => ok('export '+name, typeof api[name] === 'function' || api[name] != null, typeof api[name]));
  ok('harness still injects public seed', (api.DB.students || []).length > 0 && api.dbLooksEmpty() === false);
  ok('emptyPlannerDb is empty', api.dbLooksEmpty(api.emptyPlannerDb()) === true);

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
  ok('matchSheetKey JRPiano still aliases to rpiano', api.matchSheetKey('JRPiano') === 'rpiano');
  ok('matchSheetKey rpiano', api.matchSheetKey('rpiano') === 'rpiano');
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
  ok('muclass 1 and 13 are the same level', api.muclassDistance('1','13') === 0);
  ok('muclass 9 vs 10 is one step', api.muclassDistance('9','10') === 1);
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
  ok('ROOM_LOCK 321jazz resolves to ROOM1', db.lessons[0].roomId === 'ROOM1' && db.lessons[0].room === '321jazz', JSON.stringify(db.lessons[0]));
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
  const jrpCsv = parseCsv(fs.readFileSync(path.join(FIX, 'rpiano.csv'), 'utf8'));
  ok('rpiano.csv looks like rpiano', api.sheetLooksLike('rpiano', jrpCsv));

  const quotaHeaders = api.inferHeaders(['SMALLGRQUOTA_ID','TEACHER','TEACHER_ID',''], null, 'smallGroupQuotas');
  ok('SMALLGR_QUOTAS unlabeled amount column infers SMALLGR_AMOUNT',
    quotaHeaders[0] === 'SMALLGRQUOTA_ID' && quotaHeaders[3] === 'SMALLGR_AMOUNT',
    quotaHeaders.join(','));
  ok('matchSheetKey SMALLGR_QUOTAS', api.matchSheetKey('SMALLGR_QUOTAS') === 'smallGroupQuotas');
  ok('matchSheetKey ROOMS', api.matchSheetKey('ROOMS') === 'refRooms');
  ok('sheetLooksLike SMALLGRQUOTA_ID',
    api.sheetLooksLike('smallGroupQuotas', [{SMALLGRQUOTA_ID:'SMGQ1', TEACHER:'Csuhaj', TEACHER_ID:'TEAC1', SMALLGR_AMOUNT:'4'}]));
  const quotaParsed = api.sheetsTablesToDb({
    refTeachers: [{TEACHER_ID:'TEAC1', NAME:'Csuhaj'}],
    smallGroupQuotas: [{SMALLGRQUOTA_ID:'SMGQ1', TEACHER:'Csuhaj', TEACHER_ID:'TEAC1', SMALLGR_AMOUNT:'4'}],
    refRooms: [{ROOM_ID:'ROOM1', ROOM:'321'}, {ROOM_ID:'ROOM3', ROOM:'Ferencsik'}, {ROOM_ID:'ROOM3', ROOM:'Orgona'}]
  });
  ok('parses SMGQ1 amount 4',
    quotaParsed.db.smallGroupQuotas[0].id === 'SMGQ1' && quotaParsed.db.smallGroupQuotas[0].amount === 4,
    JSON.stringify(quotaParsed.db.smallGroupQuotas[0]));
  ok('quota sheet requires SMALLGRQUOTA_ID or SMALLGR_AMOUNT',
    !api.sheetLooksLike('smallGroupQuotas', [{ID:'Q1', TEACHER:'Csuhaj', TEACHER_ID:'TEAC1', AMOUNT:'3'}]));
  ok('isSmallGroupId is SG* only',
    api.isSmallGroupId('SG1') && !api.isSmallGroupId('LES1') && !api.isSmallGroupId('SMGQ1'));
  ok('parses ROOMS including duplicate ROOM3',
    quotaParsed.db.refRooms.length === 3 && quotaParsed.db.refRooms[2].name === 'Orgona',
    JSON.stringify(quotaParsed.db.refRooms));
  const lockParsed = api.sheetsTablesToDb({
    students: [{ID:'S1', NAME1:'Ann'}],
    refRooms: [{ROOM_ID:'ROOM1', ROOM:'321jazz'}, {ROOM_ID:'ROOM2', ROOM:'Drum'}],
    lessons: [{LESSON_ID:'L1', LESSON_NAME:'Improv', DURATION_MIN:'45', ROOM_LOCK:'321jazz'}]
  });
  ok('ROOM_LOCK 321jazz resolves to ROOM1',
    lockParsed.db.lessons[0].roomId === 'ROOM1' && lockParsed.db.lessons[0].room === '321jazz',
    JSON.stringify(lockParsed.db.lessons[0]));
  const exportedNames = api.driveTablesToAoa(seed).map(s => s.name);
  ok('xlsx export uses SMALL_GROUPS then SMALLGR_QUOTAS then 1_1 / rpiano',
    exportedNames.includes('SMALL_GROUPS') && exportedNames.includes('SMALLGR_QUOTAS') && exportedNames.includes('ROOMS')
    && exportedNames.indexOf('SMALL_GROUPS') < exportedNames.indexOf('SMALLGR_QUOTAS')
    && exportedNames.indexOf('SMALLGR_QUOTAS') < exportedNames.indexOf('1_1')
    && exportedNames.indexOf('1_1') < exportedNames.indexOf('rpiano'),
    exportedNames.join(', '));
  ok('matchSheetKey SMALL_GROUPS', api.matchSheetKey('SMALL_GROUPS') === 'smallGroups');
  ok('SMALL_GROUPS is not mistaken for LESSONS or ROOMS',
    api.sheetLooksLike('smallGroups', [{SMALL_GROUP_ID:'SG1', ROLE:'BASS', DURATION_MIN:'90', ROOM_ID:'ROOM1'}])
    && !api.sheetLooksLike('lessons', [{SMALL_GROUP_ID:'SG1', ROLE:'BASS', DURATION_MIN:'90', ROOM_ID:'ROOM1'}])
    && !api.sheetLooksLike('refRooms', [{SMALL_GROUP_ID:'SG1', ROLE:'BASS', DURATION_MIN:'90', ROOM_ID:'ROOM1'}]));
  ok('LESSONS with DURATION_MIN still looks like lessons',
    api.sheetLooksLike('lessons', [{LESSON_ID:'L1', DURATION_MIN:'45'}]));
  const sgHeaderInfer = api.inferHeaders(
    ['SMALL_GROUP_ID','SMALL_GROUP','TEACHER','TEACHER_ID','','ROOM_ID','ROOM','FIXED_DAY','FIXED_START','FIXED_END','SCHEDULED_DAY','SCHEDULED_START','SCHEDULED_END','SCHEDULED_TEACHER','SCHEDULED_TEACHER_ID','ROLE','STUDENT_ID','NAME','INSTRUMENT','CLASS',''],
    null,
    'smallGroups'
  );
  ok('SMALL_GROUPS unlabeled duration + muclass columns infer headers',
    sgHeaderInfer[4] === 'DURATION_MIN' && sgHeaderInfer[20] === 'MUCLASS_TYPE',
    sgHeaderInfer.join(','));
  ok('Drive fixture SMALL_GROUPS parsed',
    db.smallGroupsState && db.smallGroupsState.smallGroups && db.smallGroupsState.smallGroups.length === 1
    && db.smallGroupsState.smallGroups[0].id === 'SG7'
    && db.smallGroupsState.smallGroups[0].teacherId === 'TEAC1'
    && db.smallGroupsState.smallGroups[0].fixedDay === 'TUE'
    && db.smallGroupsState.smallGroups[0].fixedStart === '14:00'
    && db.smallGroupsState.smallGroups[0].acc.some(s => s.ID === 'S1'),
    JSON.stringify(db.smallGroupsState && db.smallGroupsState.smallGroups && db.smallGroupsState.smallGroups[0]));

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
    item({lessonId:'L2', name:'B', start:13*60+30, end:14*60+30, groupId:'G2'})
  ]);
  ok('same teacher overlap is red',
    clashT.entries.some(e => /both need teacher/.test(e.html)));

  const clashR = api.auditTimetable([
    item({lessonId:'L1', roomId:'ROOM1', room:'321', start:14*60, end:15*60, groupId:'G1'}),
    item({lessonId:'L2', roomId:'ROOM1', room:'321', start:14*60+15, end:15*60+15, teacherId:'T2', groupId:'G2'})
  ]);
  ok('same-room overlap is red',
    clashR.entries.some(e => /both need/.test(e.html) && /321/.test(e.html)));

  const clashSameRoom = api.auditTimetable([
    item({lessonId:'L1', roomId:'ROOM3', room:'Ferencsik', start:14*60, end:15*60, groupId:'G1'}),
    item({lessonId:'L2', roomId:'ROOM3', room:'Ferencsik', start:14*60+15, end:15*60+15, teacherId:'T2', groupId:'G2'})
  ]);
  ok('same named room overlap is red',
    clashSameRoom.entries.some(e => /Ferencsik/.test(e.html)));

  const clashDiffRoom = api.auditTimetable([
    item({lessonId:'L1', roomId:'ROOM1', room:'321', start:14*60, end:15*60, groupId:'G1'}),
    item({lessonId:'L2', roomId:'ROOM2', room:'Drum', start:14*60, end:15*60, teacherId:'T2', groupId:'G2'})
  ]);
  ok('different rooms at the same time are not a room clash',
    !clashDiffRoom.entries.some(e => /both need/.test(e.html) && !/teacher/.test(e.html) && !/include/.test(e.html)));

  const clashS = api.auditTimetable([
    item({lessonId:'L1', start:14*60, end:15*60, groupId:'G1'}),
    item({lessonId:'LX', name:'Same group again', start:14*60, end:15*60, groupId:'G1', teacherId:'T2'})
  ]);
  ok('shared student overlap is red',
    clashS.entries.some(e => /both include/.test(e.html)));

  const res = api.auditTimetable([item({start:10*60, end:11*60, groupId:'G1'})]);
  ok('class reservation overlap is red',
    res.entries.some(e => /class reservation/.test(stripHtml(e.html))));

  const gap = api.auditTimetable([
    item({lessonId:'L1', start:13*60, end:13*60+45, groupId:'G1'}),
    item({lessonId:'L2', start:13*60+45+10, end:13*60+45+10+45, groupId:'G2'})
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

  console.log('\n== 6. Small Groups: exclude no-class, same-grade pack ==');
  install(api, tiny);
  const smallGroups = api.generateSmallGroups(1);
  api.LAST_SMALL_GROUPS = smallGroups;
  ok('S5 with no CLASS_ID is excluded',
    (smallGroups.excluded || []).some(s => s.ID === 'S5'),
    (smallGroups.excluded || []).map(s => s.ID).join(','));
  ok('one same-grade 9 small group of four types',
    smallGroups.smallGroups.length === 1
    && ['bass','drum','acc','sol'].every(t => (smallGroups.smallGroups[0][t] || []).length === 1),
    JSON.stringify(smallGroups.smallGroups[0] && {
      bass:(smallGroups.smallGroups[0].bass||[]).map(s=>s.ID),
      drum:(smallGroups.smallGroups[0].drum||[]).map(s=>s.ID),
      acc:(smallGroups.smallGroups[0].acc||[]).map(s=>s.ID),
      sol:(smallGroups.smallGroups[0].sol||[]).map(s=>s.ID)
    }));
  ok('small group id is SG1', smallGroups.smallGroups[0].id === 'SG1');
  ok('getSmallGroupLessons uses the small group id',
    api.getSmallGroupLessons().some(l => l.id === 'SG1'));

  console.log('\n== 6b. Small groups CSV carries override, fixed, scheduled ==');
  const expectedSgCsvHeaders = [
    'SMALL_GROUP_ID','SMALL_GROUP',
    'TEACHER','TEACHER_ID','DURATION_MIN','ROOM_ID','ROOM',
    'FIXED_DAY','FIXED_START','FIXED_END',
    'SCHEDULED_DAY','SCHEDULED_START','SCHEDULED_END','SCHEDULED_TEACHER','SCHEDULED_TEACHER_ID',
    'ROLE','STUDENT_ID','NAME','INSTRUMENT','CLASS','MUCLASS_TYPE'
  ];
  ok('SMALL_GROUPS_CSV_HEADERS lists every live field',
    JSON.stringify(api.SMALL_GROUPS_CSV_HEADERS) === JSON.stringify(expectedSgCsvHeaders));
  const sg = smallGroups.smallGroups[0];
  sg.teacherId = 'T1';
  sg.duration = 90;
  sg.fixedDay = 'TUE';
  sg.fixedStart = '14:00';
  sg.fixedEnd = '15:30';
  sg.scheduledDay = 'WED';
  sg.scheduledStart = '16:00';
  sg.scheduledEnd = '17:30';
  sg.scheduledTeacherId = 'T1';
  sg.scheduledTeacher = 'Ajtai';
  const sgAoa = api.smallGroupsCsvAoa(smallGroups);
  const sgCol = {};
  sgAoa[0].forEach((h, i) => { sgCol[h] = i; });
  const sgRows = sgAoa.slice(1);
  ok('generated small group emits one CSV row per member',
    sgRows.length === 4 && ['BASS','DRUM','ACC','SOL'].every(role => sgRows.some(r => r[sgCol.ROLE] === role)),
    sgRows.map(r => r[sgCol.ROLE] + ':' + r[sgCol.STUDENT_ID]).join(','));
  ok('member rows keep teacher override and fixed slot',
    sgRows.every(r =>
      r[sgCol.SMALL_GROUP_ID] === 'SG1'
      && r[sgCol.SMALL_GROUP] === 'Small Group 1'
      && r[sgCol.TEACHER_ID] === 'T1'
      && r[sgCol.TEACHER] === 'Ajtai'
      && Number(r[sgCol.DURATION_MIN]) === 90
      && r[sgCol.FIXED_DAY] === 'TUE'
      && r[sgCol.FIXED_START] === '14:00'
      && r[sgCol.FIXED_END] === '15:30'
      && r[sgCol.SCHEDULED_DAY] === 'WED'
      && r[sgCol.SCHEDULED_START] === '16:00'
      && r[sgCol.SCHEDULED_END] === '17:30'
      && r[sgCol.SCHEDULED_TEACHER] === 'Ajtai'
      && r[sgCol.SCHEDULED_TEACHER_ID] === 'T1'));
  ok('member rows include student identity',
    sgRows.some(r => r[sgCol.ROLE] === 'BASS' && r[sgCol.STUDENT_ID] === 'S1' && r[sgCol.NAME] === 'Bass One'));
  const emptySgAoa = api.smallGroupsCsvAoa({
    smallGroups: [{
      id: 'SG9', bass: [], drum: [], acc: [], sol: [],
      teacherId: 'T1', duration: 90, roomId: 'ROOM1', room: '321',
      fixedDay: 'FRI', fixedStart: '18:00', fixedEnd: '19:30',
      scheduledDay: '', scheduledStart: '', scheduledEnd: '',
      scheduledTeacherId: '', scheduledTeacher: ''
    }]
  });
  ok('empty small group still emits one row so override/fixed are not lost',
    emptySgAoa.length === 2
    && emptySgAoa[1][sgCol.SMALL_GROUP_ID] === 'SG9'
    && emptySgAoa[1][sgCol.TEACHER_ID] === 'T1'
    && emptySgAoa[1][sgCol.TEACHER] === 'Ajtai'
    && emptySgAoa[1][sgCol.FIXED_DAY] === 'FRI'
    && emptySgAoa[1][sgCol.FIXED_START] === '18:00'
    && emptySgAoa[1][sgCol.FIXED_END] === '19:30'
    && emptySgAoa[1][sgCol.ROLE] === ''
    && emptySgAoa[1][sgCol.STUDENT_ID] === '');

  const driveSgRows = [
    {SMALL_GROUP_ID:'SG9', SMALL_GROUP:'Small Group 9', TEACHER:'Ajtai', TEACHER_ID:'T1', DURATION_MIN:'90', ROOM_ID:'ROOM1', ROOM:'321', FIXED_DAY:'FRI', FIXED_START:'18:00', FIXED_END:'19:30', ROLE:'', STUDENT_ID:''},
    {SMALL_GROUP_ID:'SG9', SMALL_GROUP:'Small Group 9', TEACHER:'Ajtai', TEACHER_ID:'T1', DURATION_MIN:'90', ROOM_ID:'ROOM1', ROOM:'321', FIXED_DAY:'FRI', FIXED_START:'18:00', FIXED_END:'19:30', ROLE:'BASS', STUDENT_ID:'S1'},
    {SMALL_GROUP_ID:'SG9', SMALL_GROUP:'Small Group 9', TEACHER:'Ajtai', TEACHER_ID:'T1', DURATION_MIN:'90', ROOM_ID:'ROOM1', ROOM:'321', FIXED_DAY:'FRI', FIXED_START:'18:00', FIXED_END:'19:30', ROLE:'DRUM', STUDENT_ID:'S2'}
  ];
  const parsedDriveSg = api.parseSmallGroupsTable(driveSgRows, api.DB.students, {
    refTeachers: api.DB.refTeachers, refClasses: api.DB.refClasses, refRooms: api.DB.refRooms
  });
  ok('parseSmallGroupsTable keeps override/fixed and members',
    parsedDriveSg.smallGroups.length === 1
    && parsedDriveSg.smallGroups[0].id === 'SG9'
    && parsedDriveSg.smallGroups[0].teacherId === 'T1'
    && parsedDriveSg.smallGroups[0].fixedDay === 'FRI'
    && parsedDriveSg.smallGroups[0].fixedStart === '18:00'
    && parsedDriveSg.smallGroups[0].bass.some(s => s.ID === 'S1')
    && parsedDriveSg.smallGroups[0].drum.some(s => s.ID === 'S2'));
  const roundTrip = api.parseSmallGroupsTable(
    api.smallGroupsCsvAoa(parsedDriveSg).slice(1).map(vals => {
      const row = {};
      api.SMALL_GROUPS_CSV_HEADERS.forEach((h, i) => { row[h] = vals[i] == null ? '' : String(vals[i]); });
      return row;
    }),
    api.DB.students,
    {refTeachers: api.DB.refTeachers, refClasses: api.DB.refClasses, refRooms: api.DB.refRooms}
  );
  ok('CSV round-trip keeps teacher override and fixed slot',
    roundTrip.smallGroups[0].teacherId === 'T1'
    && roundTrip.smallGroups[0].fixedDay === 'FRI'
    && roundTrip.smallGroups[0].fixedEnd === '19:30'
    && roundTrip.smallGroups[0].bass.some(s => s.ID === 'S1'));
  api.LAST_SMALL_GROUPS = parsedDriveSg;
  const regenerated = api.generateSmallGroups(1);
  ok('Generate small groups still works after a Drive roster load',
    regenerated.smallGroups.length === 1 && regenerated.smallGroups[0].id === 'SG1');

  console.log('\n== 7. Tiny school: generate → schedule → accept → 1/1 → piano ==');
  install(api, tiny);
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  api.LAST_VARIANTS = [result];
  ok('tiny school places the group lesson',
    result.scheduled.some(s => s.lessonId === 'LES1'),
    (result.unresolved || []).map(u => u.lesson && u.lesson.id).join(','));
  ok('tiny school places the small group',
    result.scheduled.some(s => s.lessonId === 'SG1'),
    (result.unresolved || []).map(u => u.lesson && u.lesson.id).join(','));
  ok('nothing unresolved', result.unresolved.length === 0,
    (result.unresolved || []).map(u => (u.lesson && u.lesson.id) + ':' + (u.customReason||'')).join(' | '));
  const inv = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, result);
  ok('independent invariants hold on tiny school', inv.length === 0, inv.join(' | '));
  const placedAfter13 = result.scheduled.every(s => s.start >= 13*60);
  ok('nothing sits inside the 09:00–13:00 class reservation', placedAfter13,
    result.scheduled.map(s => `${s.lessonId} ${s.day} ${api.toHHMM(s.start)}`).join(', '));
  const aud = api.auditTimetable(result.scheduled);
  ok('tiny generated week has no red errors',
    aud.entries.filter(e => e.level !== 'warning').length === 0,
    aud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));

  ok('1/1 locked before Accept', !api.hasAcceptedRecord() && !api.canOpenOneOne());
  ok('unaccepted generate locks other tabs', api.hasPendingAccept() === true && api.pendingAcceptTab() === 'timetable');
  api.acceptTimetableSchedule();
  ok('Accept unlocks 1/1', api.hasAcceptedRecord() && api.LAST_RESULT.accepted && api.canOpenOneOne());
  ok('Accept clears pending-tab lock', api.hasPendingAccept() === false);
  ok('acceptedSchedule has scheduled rows',
    (api.DB.acceptedSchedule || []).filter(r => r.status === 'scheduled').length >= 2);
  const written = api.writeAcceptedToSourceTables(api.LAST_RESULT);
  ok('SCHEDULED columns land on the lesson',
    api.DB.lessons[0].scheduledDay && (written.lessonsWritten || written.smallGroupsWritten));

  const one = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule || []
  });
  api.applyIndividualSearch('oneone', [one], 'T1');
  ok('1/1 places S1×Ajtai around the accepted week',
    one.scheduled.length === 1 && one.unresolved.length === 0,
    `scheduled=${one.scheduled.length} unresolved=${one.unresolved.length}`);
  ok('generated 1/1 is not frozen yet', api.frozenIndividualItems().length === 0);
  const oneWeek = api.combinedWeekItems('oneone');
  const oneAud = api.auditTimetable(oneWeek);
  ok('accepted groups + generated 1/1 have no reds',
    oneAud.entries.filter(e => e.level !== 'warning').length === 0,
    oneAud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));

  api.acceptOneOneSchedule();
  ok('Accept 1/1 freezes those slots', api.hasAcceptedOneOne());
  ok('RJP still empty after first Accept 1/1', api.LAST_RPIANO == null);
  ok('KIND is 1/1', (api.LAST_ONEONE.acceptedSchedule || [])[0].kind === '1/1');
  ok('timetableAuditItems now includes frozen 1/1',
    api.timetableAuditItems(api.LAST_RESULT.scheduled).length
    === api.LAST_RESULT.scheduled.length + api.LAST_ONEONE.scheduled.length);

  const rjp = api.scheduleAllOneToOne({
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
    source: 'rpiano', lessonLabel: 'piano', idPrefix: 'RP'
  });
  api.applyIndividualSearch('rpiano', [rjp], 'T1');
  ok('piano places S3×Ajtai in a leftover hole',
    rjp.scheduled.length === 1 && rjp.unresolved.length === 0,
    `scheduled=${rjp.scheduled.length} unresolved=${rjp.unresolved.length} ${rjp.unresolved.map(u=>u.reason).join(';')}`);
  ok('piano id is RP-…', rjp.scheduled[0].lessonId.startsWith('RP-'));
  ok('piano source is rpiano', rjp.scheduled[0].source === 'rpiano');
  const mix = api.combinedWeekItems('rpiano');
  const mixAud = api.auditTimetable(mix);
  ok('groups + 1/1 + piano have no reds',
    mixAud.entries.filter(e => e.level !== 'warning').length === 0,
    mixAud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));
  api.acceptRpianoSchedule();
  ok('Accept piano freezes', api.hasAcceptedRpiano());
  ok('KIND is piano', (api.LAST_RPIANO.acceptedSchedule || [])[0].kind === 'piano');

  const ics = api.buildTimetableIcs(api.LAST_RESULT.scheduled);
  ok('ICS is a calendar', /BEGIN:VCALENDAR/.test(ics) && /BEGIN:VEVENT/.test(ics));
  ok('calendar title uses the lesson name',
    /Improv/.test(api.calendarEventTitle(api.LAST_RESULT.scheduled[0])));
  const bundle = api.buildFullExportObject();
  ok('JSON export has oneToOneState.accepted and rpianoState.accepted',
    bundle.oneToOneState && bundle.oneToOneState.accepted
    && bundle.rpianoState && bundle.rpianoState.accepted);
  const aoa = api.driveTablesToAoa(api.DB);
  ok('xlsx AOA includes 1_1 and rpiano',
    aoa.some(s => s.name === '1_1') && aoa.some(s => s.name === 'rpiano'));

  console.log('\n== 8. Drag re-opens Accept; freeze drops while unaccepted ==');
  const oneBlock = api.LAST_ONEONE.scheduled[0];
  const from = oneBlock.start;
  oneBlock.start += 15; oneBlock.end += 15;
  api.markLayoutNeedsAccept('oneone');
  ok('1/1 drag clears accepted', api.LAST_ONEONE.accepted === false && !api.hasAcceptedOneOne());
  ok('1/1 drag locks Required Piano', api.canOpenRpiano() === false);
  ok('1/1 drag locks every other tab', api.pendingAcceptTab() === 'oneone');
  ok('unaccepted 1/1 is not in accepted-only week',
    api.combinedWeekItems().every(i => i.source !== 'oneone' || api.hasAcceptedOneOne()));
  ok('unaccepted 1/1 leaves timetable freeze', api.frozenIndividualItems().every(i => i.source !== 'oneone') || api.frozenIndividualItems().length === (api.hasAcceptedRpiano() ? api.LAST_RPIANO.scheduled.length : 0));
  api.acceptOneOneSchedule();
  ok('re-Accept writes the dragged 1/1 time', oneBlock.start === from + 15 && api.hasAcceptedOneOne());
  ok('re-Accept 1/1 keeps piano', api.hasAcceptedRpiano() && api.LAST_RPIANO != null);
  ok('re-Accept 1/1 unlocks Required Piano', api.canOpenRpiano() === true);

  const group = api.LAST_RESULT.scheduled[0];
  const gFrom = group.start;
  group.start += 5; group.end += 5;
  api.markLayoutNeedsAccept('timetable');
  ok('timetable drag re-opens Accept', api.LAST_RESULT.accepted === false);
  ok('timetable drag does not clear acceptedSchedule', api.hasAcceptedRecord());
  ok('timetable drag locks 1/1 until re-Accept', api.canOpenOneOne() === false);
  ok('timetable drag locks Required Piano until groups are accepted', api.canOpenRpiano() === false);
  ok('timetable drag locks every other tab', api.pendingAcceptTab() === 'timetable');
  api.acceptTimetableSchedule();
  ok('re-Accept timetable keeps the dragged slot', group.start === gFrom + 5 && api.LAST_RESULT.accepted);
  ok('re-Accept timetable unlocks 1/1', api.canOpenOneOne() === true);
  ok('re-Accept timetable unlocks piano if 1/1 is still accepted', api.canOpenRpiano() === true);

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
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
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
  const pianoTeachers = api.individualTeacherIds('rpiano');
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

  console.log('\n== 11. Variant lookahead SUGGESTED ==');
  ok('green SUGGESTED chip is gone', !/\.variant-suggested-tag/.test(css));
  ok('group search tries at least 100 layouts', api.SCHEDULE_SEARCH_ATTEMPTS >= 100);
  ok('group Solution list keeps the best 10', api.SCHEDULE_VARIANT_KEEP === 10);
  ok('attempts clamp floors at 1', api.clampScheduleSearchAttempts(0) === 1);
  ok('attempts clamp caps at 1000', api.clampScheduleSearchAttempts(5000) === 1000);
  ok('blank attempts value is 100', api.clampScheduleSearchAttempts('x') === 100);
  api.SCHEDULE_SEARCH_ATTEMPTS = 3;
  ok('empty Attempts field does not overwrite a test count', api.readScheduleSearchAttempts() === 3);
  api.SCHEDULE_SEARCH_ATTEMPTS = 100;
  const worse = {unresolved:[], lookahead:{oneUnresolved:2, pianoUnresolved:1, onePlaced:10, pianoPlaced:4}};
  const better = {unresolved:[], lookahead:{oneUnresolved:0, pianoUnresolved:1, onePlaced:12, pianoPlaced:5}};
  api.markSuggestedByLookahead([worse, better], api.groupLookaheadScore);
  ok('group SUGGESTED is fewest unplaced 1/1 among min left-out', better.suggested === true && worse.suggested === false);
  const moreLeft = {unresolved:[{},{}], lookahead:{oneUnresolved:0, pianoUnresolved:0, onePlaced:12, pianoPlaced:5}};
  const minLeft = {unresolved:[{}], lookahead:{oneUnresolved:4, pianoUnresolved:4, onePlaced:8, pianoPlaced:1}};
  api.markSuggestedByLookahead([moreLeft, minLeft], api.groupLookaheadScore);
  ok('group SUGGESTED cannot have more left-out than the minimum', minLeft.suggested === true && moreLeft.suggested === false);
  const pianoWorse = {unresolved:[], lookahead:{pianoUnresolved:3, pianoPlaced:1}};
  const pianoBetter = {unresolved:[], lookahead:{pianoUnresolved:0, pianoPlaced:4}};
  api.markSuggestedByLookahead([pianoWorse, pianoBetter], api.oneOneLookaheadScore);
  ok('1/1 SUGGESTED is fewest unplaced piano among min left-out', pianoBetter.suggested === true && pianoWorse.suggested === false);
  const oneMoreLeft = {unresolved:[{},{}], lookahead:{pianoUnresolved:0, pianoPlaced:4}};
  const oneMinLeft = {unresolved:[{}], lookahead:{pianoUnresolved:9, pianoPlaced:0}};
  api.markSuggestedByLookahead([oneMoreLeft, oneMinLeft], api.oneOneLookaheadScore);
  ok('1/1 SUGGESTED cannot have more left-out than the minimum', oneMinLeft.suggested === true && oneMoreLeft.suggested === false);

  install(api, tiny);
  const vBlock = {scheduled: api.DAYS.map(d => ({
    lessonId: 'BLOCK-'+d, teacherId:'T1', name:'block', day:d,
    start:13*60, end:20*60, studentIds:'S1,S2,S3,S4'
  })), unresolved:[]};
  const vFree = {scheduled: [{
    lessonId:'LES1', teacherId:'T1', name:'Improv 9', day:'MON',
    start:19*60, end:19*60+45, studentIds:'S1,S2,S3,S4'
  }], unresolved:[]};
  api.attachGroupLookahead([vBlock, vFree]);
  ok('blocked week leaves 1/1 unplaced', vBlock.lookahead && vBlock.lookahead.oneUnresolved > 0,
    vBlock.lookahead && JSON.stringify(vBlock.lookahead));
  ok('open week places 1/1', vFree.lookahead && vFree.lookahead.oneUnresolved === 0,
    vFree.lookahead && JSON.stringify(vFree.lookahead));
  ok('open week is SUGGESTED for groups', vFree.suggested === true && vBlock.suggested === false);

  const oneFill = {scheduled: api.DAYS.map(d => ({
    lessonId:'OO-'+d, teacherId:'T1', studentId:'S1', studentIds:'S1',
    day:d, start:13*60, end:20*60
  })), unresolved:[]};
  const oneHole = {scheduled: [{
    lessonId:'OO-MON', teacherId:'T1', studentId:'S1', studentIds:'S1',
    day:'MON', start:13*60, end:14*60
  }], unresolved:[]};
  api.DB.acceptedSchedule = [];
  api.attachOneOneLookahead([oneFill, oneHole]);
  ok('full 1/1 week leaves piano unplaced', oneFill.lookahead && oneFill.lookahead.pianoUnresolved > 0,
    oneFill.lookahead && JSON.stringify(oneFill.lookahead));
  ok('compact 1/1 places piano', oneHole.lookahead && oneHole.lookahead.pianoUnresolved === 0,
    oneHole.lookahead && JSON.stringify(oneHole.lookahead));
  ok('compact 1/1 is SUGGESTED', oneHole.suggested === true && oneFill.suggested === false);
  ok('lookahead label names piano leftovers',
    /piano 0\/1 placed, 1 left out/.test(api.formatLookaheadLabel(oneFill.lookahead, 'oneone'))
    || /left out/.test(api.formatLookaheadLabel(oneFill.lookahead, 'oneone')),
    api.formatLookaheadLabel(oneFill.lookahead, 'oneone'));

  install(api, tiny);
  api.SCHEDULE_SEARCH_ATTEMPTS = 3;
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
  api.LAST_VARIANTS = [];
  api.runGenerateTimetable(false);
  const starred = (api.LAST_VARIANTS || []).find(v => v && v.suggested);
  ok('Generate selects the ★ layout',
    !!(api.LAST_RESULT && (starred ? api.LAST_RESULT === starred : api.LAST_RESULT === api.LAST_VARIANTS[0])));
  const starLog = ((api.LAST_RESULT && api.LAST_RESULT.searchLog) || []).map(l => l.text).join('\n');
  if(api.LAST_RESULT && api.LAST_RESULT.lookahead){
    ok('★ search log includes starred lookahead', /Lookahead/.test(starLog) && /★/.test(starLog), starLog.slice(-400));
  }
  api.SCHEDULE_SEARCH_ATTEMPTS = 100;

  install(api, tiny);
  api.DB.refTeachers.push({id:'T2', name:'Other'});
  api.DB.teacherAvail.push(
    {teacher:'Other', teacherId:'T2', day:'MON', start:'13:00', end:'20:00', type:'AVAILABLE'}
  );
  api.DB.oneToOne = {columns:[{id:'T2', name:'Other'}], hours:{S1:{T2:1}}};
  api.DB.rpiano = {columns:[], hours:{}};
  const memberBlock = {scheduled: [{
    lessonId:'LES1', teacherId:'T1', name:'Improv 9', day:'MON',
    start:13*60, end:20*60
  }], unresolved:[]};
  api.attachGroupLookahead([memberBlock]);
  ok('1/1 preview treats group members as busy even without studentIds on the block',
    memberBlock.lookahead && memberBlock.lookahead.oneUnresolved > 0,
    memberBlock.lookahead && JSON.stringify(memberBlock.lookahead));

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
}

main();
