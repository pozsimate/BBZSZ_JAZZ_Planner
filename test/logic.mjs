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
  ok('small groups try every 5-minute start', /t \+= 5\) opts\.push\(\{day, start:t/.test(appSrc));
  ok('small group reshuffle depth is the small group count', /const SWAP_DEPTH = smallGroupItems\.length/.test(appSrc));
  ok('shuffled small-group slot pick uses the 3 tightest gaps', /promoteTopKRandom\(directChoices, 3, randomize\)/.test(appSrc));
  ok('stuck Phase 2 can evict a blocking subject lesson', /Phase 2 leftover — evicting/.test(appSrc));
  ok('Phase 2 waits when subject lessons are still unresolved',
    /subjectLessonsPending/.test(appSrc) && /every subject lesson must be placed before auto-matching small groups/.test(appSrc));
  ok('shuffled attempts permute teacher pack order',
    /resolvePhase1TeacherOrder/.test(appSrc) && /shuffleArray\(base\)/.test(appSrc));
  ok('teacher availability has a SCOPE dropdown', /scopeSelect/.test(appSrc) && /SCOPE_OPTIONS/.test(appSrc));
  const tabBtns = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  const tabPanels = [...html.matchAll(/id="tab-([^"]+)"/g)].map(m => m[1]);
  ok('every nav tab has a panel', tabBtns.every(t => tabPanels.includes(t)),
    tabBtns.filter(t => !tabPanels.includes(t)).join(','));
  ok('core tabs exist',
    ['students','lessons','smallgroups','timetable','oneone','rpiano','cloud','reports'].every(t => tabBtns.includes(t)));
  ok('1/1 tab starts locked', /tab-btn-oneone is-locked/.test(html));
  ok('RJP tab starts locked', /tab-btn-rpiano is-locked/.test(html));
  ok('Group Lessons has a locked pale-green style', /\.tab-btn-timetable\.is-locked/.test(css));
  ok('searching UI freeze style exists', /body\.is-searching/.test(css));
  ok('searching UI shows live progress animation', /search-progress-flow/.test(css) && /search-phase-pulse/.test(css));
  ok('default Drive URL is in the cloud input', html.includes('1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU'));
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  ok('group search attempts field exists', htmlIds.has('scheduleSearchAttempts'));
  ok('1/1 search attempts field exists', htmlIds.has('oneoneSearchAttempts'));
  ok('1/1 assignment matrix is collapsible', htmlIds.has('oneoneMatrixFold') && htmlIds.has('oneoneMatrixWrap'));
  ok('piano assignment matrix is collapsible', htmlIds.has('rpianoMatrixFold') && htmlIds.has('rpianoMatrixWrap'));
  ok('piano search attempts field exists', htmlIds.has('rpianoSearchAttempts'));
  ok('Teacher order modal exists',
    htmlIds.has('phase1TeacherOrderBtn') && htmlIds.has('phase1TeacherOrderList')
    && htmlIds.has('phase1TeacherOrderOverlay'));
  ok('live search window has the progress bar', htmlIds.has('searchLiveFill') && htmlIds.has('searchLiveCount'));
  ok('live search window has phase stepper', htmlIds.has('searchLivePhases'));
  ok('live search window has status panel', htmlIds.has('searchLiveStatusNow') && htmlIds.has('searchLiveStatusBest'));
  ok('live search window has a remaining-time line', htmlIds.has('searchLiveEta'));
  ok('No gaps without Break Management checkbox exists', htmlIds.has('forbidUnlistedGroupGaps'));
  ok('1/1 preview All/10 switch exists', htmlIds.has('lookaheadEveryLayout'));
  ok('hypothetical teacher-swap switch exists', htmlIds.has('teacherSwapProbe'));
  ok('hypothetical teacher-swap suggestions panel exists', htmlIds.has('teacherSwapSuggestions'));
  ok('live search commentary window exists',
    htmlIds.has('searchLiveOverlay') && htmlIds.has('searchLiveHeadline') && htmlIds.has('searchLiveBody'));
  ok('live search has a Stop button', htmlIds.has('searchLiveCancelBtn'));
  ok('attempts field allows 50000', /id="scheduleSearchAttempts"[^>]*max="50000"/.test(html));
  ok('async search talks to the live window',
    /openSearchLive/.test(appSrc) && /searchLiveSay/.test(appSrc) && /searchLiveAttemptHeadline/.test(appSrc));
  ok('1/1 generate opens the live search window',
    /openSearchLive\(who \? `Generate 1\/1/.test(appSrc) && /generateIndividualScopedAsync/.test(appSrc));
  ok('Required Piano generate opens the live search window',
    /openSearchLive\(who \? `Generate Required Piano/.test(appSrc));
  api.openSearchLive('Search');
  ok('live search window opens', api.isSearchLiveOpen() === true);
  api.setupGroupSearchLivePhases({deep: true, attempts: 5000, swaps: true});
  ok('group phase stepper tracks five steps', api.searchLivePhaseIds().length === 5);
  api.setSearchLivePhase('forecast', '1/1 forecast 3 / 10');
  ok('active phase switches to forecast', api.searchLiveActivePhase() === 'forecast');
  api.updateSearchLiveStatus({now: 'Layout 3 / 10', best: '57 placed, 0 left out'});
  ok('status panel updates', api.searchLiveStatusText('now') === 'Layout 3 / 10');
  api.searchLiveSay('Packing Ajtai…', 'info');
  api.closeSearchLive();
  ok('live search window closes', api.isSearchLiveOpen() === false);
  ok('ETA formats a few seconds', api.formatSearchLiveEta(3000) === 'a few seconds left');
  ok('ETA formats seconds', api.formatSearchLiveEta(20000) === 'about 20s left');
  ok('ETA formats one minute', api.formatSearchLiveEta(60000) === 'about 1 min left');
  ok('ETA formats minutes', api.formatSearchLiveEta(180000) === 'about 3 min left');
  ok('1/1 live headline separates tries from distinct goal',
    api.searchLiveIndividualHeadline(2345, 4000, 512, 1000, true)
      === 'Try 2345 / 4000 · 512 / 1000 distinct — shuffled mix');
  ok('1/1 live count never shows try number over distinct goal',
    api.searchLiveIndividualCount(512, 1000, 2345, 4000)
      === 'Try 2345 / 4000 · 512 / 1000 distinct');
  ok('group live headline caps attempt display',
    api.searchLiveAttemptHeadline(2345, 1000, true) === 'Attempt 1000 / 1000 — shuffled teacher / day / lesson mix');
  const packLayout = {
    scheduled: [{lessonId:'L1'}],
    unresolved: [],
    lookahead: {oneUnresolved: 99, pianoUnresolved: 88, onePlaced: 1, pianoPlaced: 1, oneTotal: 10, pianoTotal: 10}
  };
  ok('pack live line ignores stale 1/1 preview during repack',
    api.searchLivePackLine(packLayout) === '1 placed, 0 left out'
    && api.searchLiveLayoutLine(packLayout).includes('1/1'));
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
  ok('Reports locked until a layout is accepted', api.canOpenReports() === false && api.canSwitchTab('reports') === false);
  ok('boot restores browser autosave',
    /\/\/ ---------- Init ----------[\s\S]{0,120}restoreAutosaveIfAny\(\)/.test(appSrc));

  const needed = [
    'toMin','toHHMM','cleanCellText','parseGvizTable','inferHeaders','sheetsTablesToDb',
    'sheetLooksLike','matchSheetKey','parseSpreadsheetId','classWindow','classFreeGaps',
    'teacherDayWindows','teacherWindowClash','normalizeAvailScope','overlappingClassReservation','studentsInGroup',
    'studentsFreeIntervals','breakUnitsForGap','teacherBreakSettings','muclassDistance','auditTimetable','generateSmallGroups','runScheduler',
    'scheduleOneToOne','scheduleAllOneToOne','parseOneToOneTable','collectOneOneAssignments',
    'acceptTimetableSchedule','acceptOneOneSchedule','acceptRpianoSchedule',
    'frozenIndividualItems','timetableAuditItems','studentsForScheduledItem','scheduledItemIsPinned',
    'hasPendingAccept','pendingAcceptTab','combinedWeekItems',
    'canSwitchTab','canOpenReports','setSearchUiLock','isSearchUiLocked',
    'attachGroupLookahead','attachOneOneLookahead','markSuggestedByLookahead',
    'SCHEDULE_SEARCH_ATTEMPTS','SCHEDULE_VARIANT_KEEP',
    'clampScheduleSearchAttempts','readScheduleSearchAttempts',
    'clampOneOneSearchAttempts','readOneOneSearchAttempts','oneOneSearchMaxTries',
    'ONEONE_SEARCH_ATTEMPTS','ONEONE_SEARCH_ATTEMPTS_MAX','RPIANO_SEARCH_ATTEMPTS',
    'collectUiState','applyUiState',
    'isDeepScheduleSearch','beginScheduleSearch','recordScheduleAttempt','finishScheduleSearch','compareScheduleBeam','trimVariantPool',
    'requestCancelSearch','resetSearchCancel','isSearchCancelled',
    'DEEP_SEARCH_AFTER','SCHEDULE_SEARCH_ATTEMPTS_MAX',
    'buildTimetableIcs','icsEscape','collectFixedPins','clampBookedWindowToDuration',
    'snapMinutes','clampLessonStart','parseIdList','formatOneOneHours','driveTablesToAoa',
    'smallGroupsCsvAoa','parseSmallGroupsTable','restoreAutosaveIfAny',
    'reportWeekItems','reportItemKind','reportItemMatches','filterReportItems','reportCsvAoa',
    'classReservationItems','reportClassReservationItems','classReservationReason',
    'colorForTeacher','calTextForHsl','renderCalendar','mergeFlushIndividualTiles','coalesceFlushIndividualLessons',
    'collectPhase1TeacherIds','automaticPhase1TeacherOrder','resolvePhase1TeacherOrder',
    'hasManualPhase1TeacherOrder','normalizePhase1TeacherOrder',
    'setManualPhase1TeacherOrder','clearManualPhase1TeacherOrder',
    'openSearchLive','closeSearchLive','searchLiveSay','isSearchLiveOpen','formatSearchLiveEta',
    'searchLivePackLine','searchLiveLayoutLine','groupForecastLiveLine','variantIndexInPool',
    'searchLiveIndividualHeadline','searchLiveIndividualCount',
    'setupGroupSearchLivePhases','setSearchLivePhase','updateSearchLiveStatus','renderSearchLivePhases',
    'searchLivePhaseIds','searchLiveActivePhase','searchLiveStatusText',
    'scheduleAllOneToOneSearchAsync','generateIndividualScopedAsync','oneOneResultLogLine',
    'oneOneAvgDayStartMinutes',
    'forbidUnlistedGroupGapsEnabled','lookaheadEveryLayoutEnabled','teacherSwapProbeEnabled',
    'keepLookaheadBestVariants',
    'layoutReadyForForecast','bestCompletePackLayout','forecastPreviewLayouts','groupMoveSlotLegal','applyScheduledMove','forecastMoveTeacherPlan','bestForecastLayout','optimizeLayoutSlotsForForecast',
    'collectTeacherSwapCandidates','collectTeacherSwapSuggestionsForLayouts','withLessonTeacherSwaps',
    'evaluateHypotheticalTeacherSwap','teacherSwapSearchAttempts',
    'dayLessonNeighbors','holePullsTowardEnd'
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

  const gvizLessons = JSON.parse(fs.readFileSync(path.join(FIX, 'gviz-lessons.json'), 'utf8'));
  const lessonRows = api.parseGvizTable(gvizLessons, 'lessons');
  ok('LESSONS empty gviz labels promote FIXED_DAY / FIXED_START / FIXED_END',
    lessonRows.length === 2
      && lessonRows[0].DURATION_MIN === '45'
      && lessonRows[0].FIXED_DAY === 'MON'
      && lessonRows[0].FIXED_START === '13:00'
      && lessonRows[0].FIXED_END === '13:45',
    JSON.stringify(lessonRows[0]));
  ok('LESSONS timeofday uses 24h from the array, not AM/PM formatted text',
    lessonRows[0].FIXED_START === '13:00' && lessonRows[0].FIXED_END === '13:45');
  ok('LESSONS Hungarian FIXED_DAY Hétfő stays on the row for sheetsTablesToDb',
    lessonRows[1].FIXED_DAY === 'Hétfő' && lessonRows[1].FIXED_START === '13:45',
    JSON.stringify(lessonRows[1]));
  const unlabeledLessonHeaders = api.inferHeaders(
    ['LESSON_ID','LESSON NAME','GROUP','GROUP_ID','TEACHER','TEACHER_ID','DURATION_MIN','ROOM_LOCK','FIXED_DAY','',''],
    ['string','string','string','string','string','string','number','string','string','timeofday','timeofday'],
    'lessons'
  );
  ok('LESSONS unlabeled time columns after FIXED_DAY infer FIXED_START / FIXED_END, not START / END',
    unlabeledLessonHeaders[8] === 'FIXED_DAY'
      && unlabeledLessonHeaders[9] === 'FIXED_START'
      && unlabeledLessonHeaders[10] === 'FIXED_END',
    unlabeledLessonHeaders.join(','));
  const unlabeledLessonGviz = {
    status: 'ok',
    table: {
      cols: [
        {id:'A', label:'LESSON_ID', type:'string'},
        {id:'B', label:'DURATION_MIN', type:'number'},
        {id:'C', label:'FIXED_DAY', type:'string'},
        {id:'D', label:'', type:'timeofday'},
        {id:'E', label:'', type:'timeofday'}
      ],
      rows: [{c: [
        {v:'Lpin'},
        {v:45, f:'45'},
        {v:'TUE'},
        {v:[14,0,0,0], f:'2:00:00 PM'},
        {v:[15,30,0,0], f:'3:30:00 PM'}
      ]}]
    }
  };
  const unlabeledLessonRows = api.parseGvizTable(unlabeledLessonGviz, 'lessons');
  ok('LESSONS unlabeled timeofday after FIXED_DAY parses as pin times',
    unlabeledLessonRows.length === 1
      && unlabeledLessonRows[0].FIXED_DAY === 'TUE'
      && unlabeledLessonRows[0].FIXED_START === '14:00'
      && unlabeledLessonRows[0].FIXED_END === '15:30'
      && unlabeledLessonRows[0].START == null
      && unlabeledLessonRows[0].END == null,
    JSON.stringify(unlabeledLessonRows[0]));

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
  ok('FIXED START / END import from Drive LESSONS',
    db.lessons[0].fixedStart === '14:00' && db.lessons[0].fixedEnd === '15:00',
    JSON.stringify({start: db.lessons[0].fixedStart, end: db.lessons[0].fixedEnd}));
  const gvizLessonDb = api.sheetsTablesToDb({
    refTeachers: [{TEACHER_ID:'TEAC15', NAME:'Pozsar'}, {TEACHER_ID:'TEAC18', NAME:'HorvathG'}],
    refGroups: [{GROUP_ID:'GR13', TYPE:'JAZZTHEO', NAME:'jazztheory9'}, {GROUP_ID:'GR22', TYPE:'SOLF', NAME:'solf9'}],
    refRooms: [{ROOM_ID:'ROOM1', ROOM:'321jazz'}],
    students: [{ID:'S1', NAME1:'Ann'}],
    lessons: lessonRows
  }).db;
  ok('gviz LESSONS pins resolve Hungarian day and 24h times',
    gvizLessonDb.lessons[0].fixedDay === 'MON' && gvizLessonDb.lessons[0].fixedStart === '13:00'
      && gvizLessonDb.lessons[1].fixedDay === 'MON' && gvizLessonDb.lessons[1].fixedStart === '13:45',
    JSON.stringify(gvizLessonDb.lessons.map(l => ({id:l.id, day:l.fixedDay, start:l.fixedStart, end:l.fixedEnd}))));
  ok('teacher avail Kedd → TUE', db.teacherAvail[0].day === 'TUE', db.teacherAvail[0].day);
  ok('class reservation Hétfő → MON', db.classAvail[0].day === 'MON');
  const classConstWide = api.sheetsTablesToDb({
    refClasses: [{CLASS_ID:'CL1', CLASS:'9a'}],
    classAvail: [{
      CLASS:'9a', CLASS_ID:'CL1', DAY:'MON',
      L_STAR:'0', L_END:'0', START:'07:15', END:'07:55',
      AVAIL:'RESERVED', NOTE:'regular education'
    }]
  }).db;
  ok('CLASS_CONST START/END stay the busy interval next to L_STAR/L_END',
    classConstWide.classAvail[0].start === '07:15' && classConstWide.classAvail[0].end === '07:55',
    JSON.stringify(classConstWide.classAvail[0]));
  ok('CLASS_CONST reads L_STAR / L_END / AVAIL',
    classConstWide.classAvail[0].lStar === '0' && classConstWide.classAvail[0].lEnd === '0'
      && classConstWide.classAvail[0].avail === 'RESERVED'
      && classConstWide.classAvail[0].note === 'regular education',
    JSON.stringify(classConstWide.classAvail[0]));
  const unlabeledClassHeaders = api.inferHeaders(
    ['CLASS','CLASS_ID','DAY','','','START','END','AVAIL','NOTE'],
    null,
    'classAvail'
  );
  ok('CLASS_CONST unlabeled columns after DAY infer L_STAR / L_END when START is labeled later',
    unlabeledClassHeaders[3] === 'L_STAR' && unlabeledClassHeaders[4] === 'L_END'
      && unlabeledClassHeaders[5] === 'START' && unlabeledClassHeaders[6] === 'END',
    unlabeledClassHeaders.join(','));
  const oldClassHeaders = api.inferHeaders(
    ['CLASS','CLASS_ID','DAY','','','AVAIL','NOTE'],
    null,
    'classAvail'
  );
  ok('old CLASS_CONST unlabeled after DAY still infers START / END',
    oldClassHeaders[3] === 'START' && oldClassHeaders[4] === 'END',
    oldClassHeaders.join(','));
  const classExport = (api.DRIVE_EXPORT_SPECS || []).find(s => s.key === 'classAvail');
  ok('CLASS_CONST export keeps L_STAR / L_END / START / END',
    classExport && classExport.headers.join(',') === 'CLASS,CLASS_ID,DAY,L_STAR,L_END,START,END,AVAIL,NOTE',
    classExport && classExport.headers.join(','));
  ok('CLASS_CONST export writes period labels and clock times',
    JSON.stringify(classExport.rows({classAvail: classConstWide.classAvail})[0])
      === JSON.stringify(['9a','CL1','MON','0','0','07:15','07:55','RESERVED','regular education']));
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
  ok('studentsFreeIntervals keeps every leftover, not only the largest',
    JSON.stringify(api.studentsFreeIntervals([{CLASS_ID:'C1'}], 'MON')) === JSON.stringify(gaps));
  ok('overlappingClassReservation hits 09:00–13:00',
    !!api.overlappingClassReservation('C1', 'MON', 10*60, 11*60));
  ok('overlappingClassReservation misses the afternoon',
    !api.overlappingClassReservation('C1', 'MON', 14*60, 15*60));

  const holeDb = toyAuditDb();
  holeDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'12:00', type:'AVAILABLE'}];
  holeDb.lessons = [{id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:45, roomId:'', room:''}];
  holeDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  install(api, holeDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const holeSched = api.runScheduler(false);
  const holePlaced = (holeSched.scheduled || []).find(s => s.lessonId === 'L1');
  ok('group packing uses the morning leftover 08:00–09:00 when that is the teacher-feasible hole',
    holePlaced && holePlaced.day === 'MON' && holePlaced.start === 8*60 && holePlaced.end === 8*60+45,
    holePlaced ? `${holePlaced.day} ${api.toHHMM(holePlaced.start)}–${api.toHHMM(holePlaced.end)}`
      : ((holeSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));

  const twoHoleDb = toyAuditDb();
  twoHoleDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  twoHoleDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  twoHoleDb.lessons = [
    {id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:45, roomId:'', room:''},
    {id:'L2', name:'Improv B', groupId:'G2', teacherId:'T1', duration:45, roomId:'', room:''}
  ];
  install(api, twoHoleDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const twoHoleSched = api.runScheduler(false);
  const twoHolePlaced = (twoHoleSched.scheduled || []).filter(s => s.day === 'MON').sort((a,b) => a.start - b.start);
  ok('two leftovers on one teacher-day pack flush in the larger hole, not as two islands',
    twoHolePlaced.length === 2
      && twoHolePlaced[1].start === twoHolePlaced[0].end
      && twoHolePlaced[0].start >= 13*60,
    twoHolePlaced.map(s => `${s.lessonId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join(', ')
      || ((twoHoleSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));
  ok('two leftover islands are not an independent-checker gap',
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, twoHoleSched).filter(e => /illegal .*gap/.test(e)).length === 0,
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, twoHoleSched).join(' | '));
  const afterSgDb = toyAuditDb();
  afterSgDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  afterSgDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  afterSgDb.lessons = [
    {id:'Lsg', name:'Small Group 15 rehearsal', groupId:'G2', teacherId:'T1', duration:90, roomId:'', room:'',
      fixedDay:'MON', fixedStart:'13:00', fixedEnd:'14:30'},
    {id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:90, roomId:'', room:''}
  ];
  install(api, afterSgDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const afterSgSched = api.runScheduler(false);
  const afterSgLive = (afterSgSched.scheduled || []).find(s => s.lessonId === 'L1');
  ok('group lesson after a small-group rehearsal sits flush, not at 18:30 with a hole',
    afterSgLive && afterSgLive.day === 'MON' && afterSgLive.start === 14*60+30 && afterSgLive.end === 16*60,
    afterSgLive ? `${afterSgLive.day} ${api.toHHMM(afterSgLive.start)}–${api.toHHMM(afterSgLive.end)}`
      : ((afterSgSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));

  const freeGapDb = toyAuditDb();
  freeGapDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  freeGapDb.breaks = [];
  freeGapDb.refClasses = [
    {id:'C1', name:'9a', muclass:'9'},
    {id:'C2', name:'9b', muclass:'9'}
  ];
  freeGapDb.students = [
    {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1'},
    {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C2', CLASS:'9b', IMPR_ID:'G2'}
  ];
  freeGapDb.classAvail = [
    {classId:'C1', class:'9a', day:'MON', start:'09:00', end:'20:00'},
    {classId:'C2', class:'9b', day:'MON', start:'08:00', end:'16:00'}
  ];
  freeGapDb.lessons = [
    {id:'L1', name:'Improv A', groupId:'G1', teacherId:'T1', duration:45, roomId:'', room:''},
    {id:'L2', name:'Improv B', groupId:'G2', teacherId:'T1', duration:45, roomId:'', room:''}
  ];
  install(api, freeGapDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  ok('unlisted teacher is unconstrained', api.teacherBreakSettings('T1').unconstrained === true);
  const freeGapSched = api.runScheduler(false);
  ok('unlisted teacher can sit both leftovers the same day (like 1/1)',
    (freeGapSched.scheduled || []).length === 2,
    (freeGapSched.scheduled || []).map(s => `${s.lessonId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join(', ')
      || ((freeGapSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));
  ok('unlisted-teacher gap is not an independent-checker error',
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, freeGapSched).filter(e => /illegal .*gap/.test(e)).length === 0,
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, freeGapSched).join(' | '));
  ok('unlisted-teacher gap is not a GAP warning',
    !(api.auditTimetable(freeGapSched.scheduled).issues || []).some(s => /gap/.test(s)),
    (api.auditTimetable(freeGapSched.scheduled).issues || []).join(' | '));
  ok('Generate records idle minutes like 1/1',
    Number.isFinite(freeGapSched.idleGapMinutes) && freeGapSched.idleGapMinutes > 0,
    String(freeGapSched.idleGapMinutes));

  const listedZeroDb = JSON.parse(JSON.stringify(freeGapDb));
  listedZeroDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  install(api, listedZeroDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  ok('optimize mode ignores Break Management rows', api.teacherBreakSettings('T1').unconstrained === true);
  const listedZeroOpt = api.runScheduler(false);
  ok('optimize mode can split leftovers even with a 0×0 row',
    (listedZeroOpt.scheduled || []).length === 2,
    (listedZeroOpt.scheduled || []).map(s => `${s.lessonId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join(', ')
      + ' unresolved=' + ((listedZeroOpt.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'none'));
  api.DB.forbidUnlistedGroupGaps = true;
  ok('old-rule mode honors the 0×0 row', api.teacherBreakSettings('T1').unconstrained === false);
  const listedZeroSched = api.runScheduler(false);
  ok('old-rule 0×0 still forbids splitting leftovers',
    (listedZeroSched.scheduled || []).length === 1,
    (listedZeroSched.scheduled || []).map(s => `${s.lessonId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join(', ')
      + ' unresolved=' + ((listedZeroSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'none'));
  api.DB.forbidUnlistedGroupGaps = false;

  install(api, freeGapDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  api.DB.forbidUnlistedGroupGaps = true;
  ok('Breaks mode treats unlisted teacher as idle/unconstrained', api.teacherBreakSettings('T1').unconstrained === true
    && api.forbidUnlistedGroupGapsEnabled() === true);
  const forbidGapSched = api.runScheduler(false);
  ok('Breaks mode still splits leftovers for unlisted teachers',
    (forbidGapSched.scheduled || []).length === 2,
    (forbidGapSched.scheduled || []).map(s => `${s.lessonId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join(', ')
      + ' unresolved=' + ((forbidGapSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'none'));
  const fpGapOff = (() => { api.DB.forbidUnlistedGroupGaps = false; return api.computeScheduleFingerprint(); })();
  api.DB.forbidUnlistedGroupGaps = true;
  ok('fingerprint changes when the gap toggle changes', fpGapOff !== api.computeScheduleFingerprint());
  api.DB.forbidUnlistedGroupGaps = false;
  ok('1/1 preview defaults to the 10 kept layouts', api.lookaheadEveryLayoutEnabled() === false);
  const fpLookOff = api.computeScheduleFingerprint();
  api.DB.lookaheadEveryLayout = true;
  ok('1/1 preview All turns the all-layout probe on', api.lookaheadEveryLayoutEnabled() === true);
  ok('fingerprint changes when the 1/1 preview toggle changes', fpLookOff !== api.computeScheduleFingerprint());
  api.DB.lookaheadEveryLayout = false;
  const worsePack = {unresolved:[{lesson:{id:'L1'}}], scheduled:[]};
  const betterPack = {unresolved:[], scheduled:[{lessonId:'L1'}]};
  ok('bestCompletePackLayout picks fewer left out', api.bestCompletePackLayout([worsePack, betterPack]) === betterPack);
  ok('forecastPreviewLayouts scores every complete layout in the pool',
    api.forecastPreviewLayouts([worsePack, betterPack]).length === 1
    && api.forecastPreviewLayouts([worsePack, betterPack, {unresolved:[], scheduled:[]}]).length === 2);
  ok('teacher-swap probe defaults off', api.teacherSwapProbeEnabled() === false);
  api.DB.teacherSwapProbe = true;
  ok('teacher-swap probe can turn on', api.teacherSwapProbeEnabled() === true);
  api.DB.teacherSwapProbe = false;

  console.log('\n== Hypothetical same-duration teacher swaps ==');
  const swapDb = {
    students: [
      {ID:'ST1', NAME1:'Thy', NAME2:'One', CLASS_ID:'CLA', JTH_ID:'GTH'},
      {ID:'ST2', NAME1:'Thy', NAME2:'Two', CLASS_ID:'CLA', JTH_ID:'GTH'},
      {ID:'SS1', NAME1:'Sol', NAME2:'One', CLASS_ID:'CLB', SOLF_ID:'GSO'},
      {ID:'SS2', NAME1:'Sol', NAME2:'Two', CLASS_ID:'CLB', SOLF_ID:'GSO'},
      {ID:'P1', NAME1:'Priv', NAME2:'One', CLASS_ID:'CLC'},
      {ID:'P2', NAME1:'Priv', NAME2:'Two', CLASS_ID:'CLC'},
      {ID:'P3', NAME1:'Priv', NAME2:'Three', CLASS_ID:'CLC'},
      {ID:'P4', NAME1:'Priv', NAME2:'Four', CLASS_ID:'CLC'},
      {ID:'P5', NAME1:'Priv', NAME2:'Five', CLASS_ID:'CLC'}
    ],
    lessons: [
      {id:'LTH', name:'Jazz Theory', groupId:'GTH', teacher:'Ajtai', teacherId:'T1', duration:60, roomId:'', room:''},
      {id:'LSO', name:'Jazz Solfege', groupId:'GSO', teacher:'Pal', teacherId:'T2', duration:60, roomId:'', room:''}
    ],
    teacherAvail: [
      {teacherId:'T1', teacher:'Ajtai', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'},
      {teacherId:'T2', teacher:'Pal', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}
    ],
    classAvail: [
      {classId:'CLA', day:'MON', start:'13:00', end:'20:00'},
      {classId:'CLB', day:'MON', start:'08:00', end:'13:00'},
      {classId:'CLC', day:'MON', start:'13:00', end:'20:00'}
    ],
    refTeachers: [{id:'T1', name:'Ajtai'}, {id:'T2', name:'Pal'}],
    refClasses: [{id:'CLA', name:'9a'}, {id:'CLB', name:'9b'}, {id:'CLC', name:'9c'}],
    refGroups: [{id:'GTH', name:'jth9', type:'JTH'}, {id:'GSO', name:'solf9', type:'SOLF'}],
    refInstruments: [],
    refRooms: [],
    smallGroupQuotas: [],
    breaks: [],
    oneToOne: {columns:[{id:'T1', name:'Ajtai'}], hours:{P1:{T1:1}, P2:{T1:1}, P3:{T1:1}, P4:{T1:1}, P5:{T1:1}}},
    rpiano: {columns:[], hours:{}},
    acceptedSchedule: [],
    teacherSwapProbe: false
  };
  install(api, swapDb);
  api.LAST_SMALL_GROUPS = null;
  const swapCands = api.collectTeacherSwapCandidates();
  ok('finds the 60-min Theory ↔ Solfege pair',
    swapCands.some(c => (c.pairs || []).some(([a,b]) =>
      (a.id === 'LTH' && b.id === 'LSO') || (a.id === 'LSO' && b.id === 'LTH'))),
    swapCands.map(c => c.label).join(' | '));
  const beforeIds = api.DB.lessons.map(l => l.teacherId).join(',');
  const swappedInside = api.withLessonTeacherSwaps([[api.DB.lessons[0], api.DB.lessons[1]]], () =>
    api.DB.lessons.map(l => l.teacherId).join(','));
  ok('swap temporarily exchanges teachers', swappedInside === 'T2,T1', swappedInside);
  ok('swap restores Lesson groups teachers',
    api.DB.lessons.map(l => l.teacherId).join(',') === beforeIds);
  const packedA = api.runScheduler(false);
  api.attachGroupLookahead([packedA]);
  api.DB.teacherSwapProbe = false;
  ok('off probe does not attach swaps',
    (api.collectTeacherSwapSuggestionsForLayouts([packedA]) || []).length === 0
    && (packedA.teacherSwaps || []).length === 0);
  api.DB.teacherSwapProbe = true;
  const packedB = Object.assign({}, packedA, {unresolved: packedA.unresolved.slice(), lookahead: packedA.lookahead});
  api.collectTeacherSwapSuggestionsForLayouts([packedA, packedB]);
  ok('on probe logs swaps on every layout',
    Array.isArray(packedA.teacherSwaps) && Array.isArray(packedB.teacherSwaps));
  ok('Theory ↔ Solfege swap improves leftover 1/1 on this school',
    (packedA.teacherSwaps || []).some(s => /Jazz Theory/.test(s.label) && /Jazz Solfege/.test(s.label)),
    (packedA.teacherSwaps || []).map(s => s.label).join(' | ') || 'none');
  ok('swap probe re-searches with shuffled packs, not only the current layout',
    api.teacherSwapSearchAttempts(1) > 1
    && (packedA.teacherSwaps || []).some(s => (s.swapSearchAttempts || 0) > 1),
    JSON.stringify((packedA.teacherSwaps || [])[0]));
  const afterSwapIds = api.DB.lessons.map(l => l.teacherId).join(',');
  ok('swap search restores Lesson groups teachers', afterSwapIds === beforeIds);
  api.DB.teacherSwapProbe = false;

  const pinHoleDb = toyAuditDb();
  pinHoleDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  pinHoleDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  pinHoleDb.students = [
    {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1', SOLF_ID:'G3'}
  ];
  pinHoleDb.refGroups = [
    {id:'G1', name:'imprA', type:'IMPR'},
    {id:'G2', name:'imprB', type:'IMPR'},
    {id:'G3', name:'solf', type:'SOLF'}
  ];
  pinHoleDb.lessons = [
    {id:'Lpin', name:'Pinned solf', groupId:'G3', teacherId:'T1', duration:90, roomId:'', room:'',
      fixedDay:'MON', fixedStart:'14:15', fixedEnd:'15:45'},
    {id:'L1', name:'Morning leftover', groupId:'G1', teacherId:'T1', duration:45, roomId:'', room:''}
  ];
  pinHoleDb.forbidUnlistedGroupGaps = true;
  install(api, pinHoleDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const pinHoleSched = api.runScheduler(false);
  const pinHoleLive = (pinHoleSched.scheduled || []).find(s => s.lessonId === 'L1');
  const pinHolePin = (pinHoleSched.scheduled || []).find(s => s.lessonId === 'Lpin');
  ok('afternoon pin is placed',
    pinHolePin && pinHolePin.day === 'MON' && pinHolePin.start === 14*60+15,
    pinHolePin ? `${pinHolePin.day} ${api.toHHMM(pinHolePin.start)}–${api.toHHMM(pinHolePin.end)}` : 'unplaced');
  ok('unpinned leftover does not sit 08:00–08:45 next to an afternoon pin (0 break)',
    !pinHoleLive || !(pinHoleLive.day === 'MON' && pinHoleLive.start === 8*60),
    pinHoleLive ? `${pinHoleLive.day} ${api.toHHMM(pinHoleLive.start)}–${api.toHHMM(pinHoleLive.end)}` : 'unplaced');
  ok('pin + leftover packing has no independent-checker gap',
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, pinHoleSched).filter(e => /illegal .*gap/.test(e)).length === 0,
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, pinHoleSched).join(' | '));

  const pinFlushDb = toyAuditDb();
  pinFlushDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  pinFlushDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  pinFlushDb.classAvail = [{classId:'C1', class:'9a', day:'MON', start:'14:30', end:'16:00'}];
  pinFlushDb.students = [
    {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1', SOLF_ID:'G3'}
  ];
  pinFlushDb.refGroups = [
    {id:'G1', name:'imprA', type:'IMPR'},
    {id:'G2', name:'imprB', type:'IMPR'},
    {id:'G3', name:'solf', type:'SOLF'}
  ];
  pinFlushDb.forbidUnlistedGroupGaps = true;
  pinFlushDb.lessons = [
    {id:'Lpin', name:'Pinned', groupId:'G3', teacherId:'T1', duration:240, roomId:'', room:'',
      fixedDay:'MON', fixedStart:'09:00', fixedEnd:'13:00'},
    {id:'L1', name:'After pin', groupId:'G1', teacherId:'T1', duration:90, roomId:'', room:''}
  ];
  install(api, pinFlushDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const pinFlushSched = api.runScheduler(false);
  const pinFlushLive = (pinFlushSched.scheduled || []).find(s => s.lessonId === 'L1');
  ok('unpinned 90-min sits 13:00–14:30 flush to the pin, not the larger 16:00 leftover',
    pinFlushLive && pinFlushLive.day === 'MON' && pinFlushLive.start === 13*60 && pinFlushLive.end === 14*60+30,
    pinFlushLive ? `${pinFlushLive.day} ${api.toHHMM(pinFlushLive.start)}–${api.toHHMM(pinFlushLive.end)}`
      : ((pinFlushSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));
  ok('pin-flush packing has no independent-checker gap',
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, pinFlushSched).filter(e => /illegal .*gap/.test(e)).length === 0,
    checkSchedule(api.DB, api.LAST_SMALL_GROUPS, pinFlushSched).join(' | '));

  const emptyBusy = {};
  const pinAfter = {T1:{MON:[{start:18*60+30, end:19*60+30}]}};
  const pinBefore = {T1:{MON:[{start:8*60, end:9*60}]}};
  const pinBoth = {T1:{MON:[{start:8*60, end:9*60},{start:18*60+30, end:19*60+30}]}};
  ok('hole pulls to the end when the only neighbor is later',
    api.holePullsTowardEnd('MON', 15*60, 17*60, 'T1', pinAfter, emptyBusy, []) === true);
  ok('hole stays at the start when the only neighbor is earlier',
    api.holePullsTowardEnd('MON', 15*60, 17*60, 'T1', pinBefore, emptyBusy, []) === false);
  ok('hole does not care which edge when both neighbors exist',
    api.holePullsTowardEnd('MON', 15*60, 17*60, 'T1', pinBoth, emptyBusy, []) === false);
  ok('empty day does not pull to the leftover end',
    api.holePullsTowardEnd('MON', 15*60, 17*60, 'T1', {}, emptyBusy, []) === false);
  ok('a later student lesson also pulls to the hole end',
    api.holePullsTowardEnd('MON', 15*60, 17*60, 'T1', {}, {S1:{MON:[{start:18*60, end:19*60}]}}, [{ID:'S1'}]) === true);
  ok('class-reservation-shaped empty busy is not a neighbor',
    api.dayLessonNeighbors('MON', 15*60, 17*60, 'T1', {}, {}, []).after === false);

  const pullEndDb = toyAuditDb();
  pullEndDb.teacherAvail = [{teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}];
  pullEndDb.breaks = [];
  pullEndDb.classAvail = [
    {classId:'C1', class:'9a', day:'MON', start:'08:00', end:'15:00'},
    {classId:'C1', class:'9a', day:'MON', start:'17:00', end:'20:00'}
  ];
  pullEndDb.lessons = [
    {id:'Lpin', name:'Evening pin', groupId:'G2', teacherId:'T1', duration:60, roomId:'', room:'',
      fixedDay:'MON', fixedStart:'18:30', fixedEnd:'19:30'},
    {id:'L1', name:'Afternoon leftover', groupId:'G1', teacherId:'T1', duration:90, roomId:'', room:''}
  ];
  install(api, pullEndDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const pullEndSched = api.runScheduler(false);
  const pullEndLive = (pullEndSched.scheduled || []).find(s => s.lessonId === 'L1');
  ok('unsnappable leftover sits at the hole end toward a later lesson',
    pullEndLive && pullEndLive.day === 'MON' && pullEndLive.start === 15*60+30 && pullEndLive.end === 17*60,
    pullEndLive ? `${pullEndLive.day} ${api.toHHMM(pullEndLive.start)}–${api.toHHMM(pullEndLive.end)}`
      : ((pullEndSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));

  const pullStartDb = JSON.parse(JSON.stringify(pullEndDb));
  pullStartDb.lessons = [
    {id:'Lpin', name:'Morning pin', groupId:'G2', teacherId:'T1', duration:60, roomId:'', room:'',
      fixedDay:'MON', fixedStart:'08:00', fixedEnd:'09:00'},
    {id:'L1', name:'Afternoon leftover', groupId:'G1', teacherId:'T1', duration:90, roomId:'', room:''}
  ];
  install(api, pullStartDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const pullStartSched = api.runScheduler(false);
  const pullStartLive = (pullStartSched.scheduled || []).find(s => s.lessonId === 'L1');
  ok('unsnappable leftover sits at the hole start toward an earlier lesson',
    pullStartLive && pullStartLive.day === 'MON' && pullStartLive.start === 15*60 && pullStartLive.end === 16*60+30,
    pullStartLive ? `${pullStartLive.day} ${api.toHHMM(pullStartLive.start)}–${api.toHHMM(pullStartLive.end)}`
      : ((pullStartSched.unresolved||[]).map(u => u.lesson && u.lesson.id).join(',') || 'unplaced'));

  install(api, toyAuditDb());
  ok('teacherWindowClash outside window',
    /only available/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 8*60, 9*60) || ''));
  ok('teacherWindowClash on AVOID day',
    /not available/.test(api.teacherWindowClash('T1', 'Tea', 'WED', 9*60, 10*60) || ''));
  ok('teacherWindowClash inside window is null',
    api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60) == null);

  api.DB.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'},
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'12:00', end:'14:00', type:'AVOID'}
  ];
  const timed = api.teacherDayWindows('T1');
  ok('timed AVOID keeps Monday', !!timed.MON);
  ok('timed AVOID splits Monday around 12–14',
    timed.MON && timed.MON.intervals
    && timed.MON.intervals.length === 2
    && timed.MON.intervals[0][0] === 8*60 && timed.MON.intervals[0][1] === 12*60
    && timed.MON.intervals[1][0] === 14*60 && timed.MON.intervals[1][1] === 20*60,
    JSON.stringify(timed.MON && timed.MON.intervals));
  ok('timed AVOID morning slot is allowed',
    api.teacherWindowClash('T1', 'Tea', 'MON', 10*60, 11*60) == null);
  ok('timed AVOID afternoon slot is allowed',
    api.teacherWindowClash('T1', 'Tea', 'MON', 15*60, 16*60) == null);
  ok('timed AVOID blocks only 12–14',
    /12:00/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 12*60, 13*60) || ''),
    api.teacherWindowClash('T1', 'Tea', 'MON', 12*60, 13*60));

  ok('missing SCOPE normalizes to ALL', api.normalizeAvailScope('') === 'ALL' && api.normalizeAvailScope('group') === 'GROUP');
  api.DB.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'13:00', end:'16:00', type:'AVAILABLE', scope:'GROUP'}
  ];
  ok('GROUP scope is a group window', !!api.teacherDayWindows('T1', 'group').MON);
  ok('GROUP scope is not a 1/1 window', !api.teacherDayWindows('T1', 'oneone').MON);
  ok('GROUP window rejects 1/1',
    /1\/1/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60, 'oneone') || ''),
    api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60, 'oneone'));
  ok('GROUP window accepts a group lesson',
    api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60, 'group') == null);
  api.DB.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'13:00', end:'16:00', type:'AVAILABLE', scope:'O2O'}
  ];
  ok('O2O scope is a 1/1 window', !!api.teacherDayWindows('T1', 'oneone').MON);
  ok('O2O scope is not a group window', !api.teacherDayWindows('T1', 'group').MON);
  ok('O2O window rejects a group lesson',
    /group/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 13*60, 14*60, 'group') || ''));
  api.DB.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE', scope:'ALL'},
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'12:00', end:'14:00', type:'AVOID', scope:'O2O'}
  ];
  ok('AVOID O2O does not split the group window',
    api.teacherDayWindows('T1', 'group').MON
    && api.teacherDayWindows('T1', 'group').MON.intervals.length === 1
    && api.teacherWindowClash('T1', 'Tea', 'MON', 12*60, 13*60, 'group') == null);
  ok('AVOID O2O still blocks 1/1 at 12–14',
    /12:00/.test(api.teacherWindowClash('T1', 'Tea', 'MON', 12*60, 13*60, 'oneone') || ''));

  const availHeaders = api.inferHeaders(
    ['TEACHER','TEACHER_ID','DAY','START','END','TYPE','','NOTE'],
    null,
    'teacherAvail'
  );
  ok('TEACHER_CONST unlabeled column after TYPE infers SCOPE',
    availHeaders[5] === 'TYPE' && availHeaders[6] === 'SCOPE',
    availHeaders.join(','));

  const o2oOnly = toyAuditDb();
  o2oOnly.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'13:00', end:'20:00', type:'AVAILABLE', scope:'O2O'}
  ];
  o2oOnly.breaks = [];
  install(api, o2oOnly);
  api.LAST_SMALL_GROUPS = {smallGroups:[], excluded:[], appearances:{}, eligibleCount:0};
  const o2oSched = api.runScheduler(false);
  ok('O2O-only window leaves group lessons unresolved',
    (o2oSched.unresolved || []).some(u => u.lesson && u.lesson.id === 'L1')
      && !(o2oSched.scheduled || []).some(s => s.lessonId === 'L1'),
    (o2oSched.scheduled || []).map(s => s.lessonId).join(',')
      + ' leftover=' + (o2oSched.unresolved || []).map(u => u.lesson && u.lesson.id).join(','));

  const splitDb = toyAuditDb();
  splitDb.teacherAvail = [
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'},
    {teacherId:'T1', teacher:'Tea', day:'MON', start:'12:00', end:'14:00', type:'AVOID'}
  ];
  splitDb.classAvail = [];
  splitDb.breaks = [{teacherId:'T1', breakMinutes:0, breakCount:0}];
  splitDb.lessons = [
    {id:'L1', name:'A', groupId:'G1', teacherId:'T1', duration:180, roomId:'', room:''},
    {id:'L2', name:'B', groupId:'G2', teacherId:'T1', duration:180, roomId:'', room:''}
  ];
  install(api, splitDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[], excluded:[], appearances:{}, eligibleCount:0};
  const aroundAvoid = api.runScheduler(false);
  ok('timed AVOID still places both lessons', aroundAvoid.scheduled.length === 2,
    aroundAvoid.unresolved.map(u => u.lesson && u.lesson.id).join(',') || 'ok');
  ok('timed AVOID placements miss 12–14',
    aroundAvoid.scheduled.every(s => s.end <= 12*60 || s.start >= 14*60),
    aroundAvoid.scheduled.map(s => `${s.day} ${s.start}-${s.end}`).join(', '));
  const sides = aroundAvoid.scheduled.map(s => s.end <= 12*60 ? 'am' : 'pm').sort().join(',');
  ok('timed AVOID packs one lesson each side of the hole', sides === 'am,pm', sides);
  const avoidAudit = api.auditTimetable(aroundAvoid.scheduled);
  ok('lessons on both sides of AVOID are not a red error',
    (avoidAudit.entries || []).filter(e => e.level !== 'warning').length === 0,
    (avoidAudit.issues || []).join(' | '));
  ok('AVOID hole is not a break warning',
    !(avoidAudit.issues || []).some(s => /gap/.test(s)),
    (avoidAudit.issues || []).join(' | '));

  install(api, toyAuditDb());
  const members = api.studentsInGroup('G1');
  ok('studentsInGroup finds Ann', members.map(s => s.ID).join(',') === 'S1');

  console.log('\n== 5. auditTimetable: every red kind + GAP warning ==');
  install(api, toyAuditDb());
  api.DB.forbidUnlistedGroupGaps = true;
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
    res.entries.some(e => e.level !== 'warning' && /class reservation/.test(stripHtml(e.html))));
  ok('unpinned class reservation paints conflictIds', res.conflictIds.has('L1'));

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
  ok('fresh small group starts with a default room lock',
    !!(smallGroups.smallGroups[0].roomId), smallGroups.smallGroups[0].roomId || 'none');
  smallGroups.smallGroups[0].roomId = '';
  smallGroups.smallGroups[0].room = '';
  ok('cleared room lock stays off when Generate reads the band',
    api.getSmallGroupLessons().every(l => !l.roomId));
  api.ensureSmallGroupIdentities(smallGroups);
  ok('ensure identities does not put a cleared room lock back',
    !smallGroups.smallGroups[0].roomId);
  const unlockedWeek = api.runScheduler(false);
  const unlockedSg = unlockedWeek.scheduled.find(s => s.lessonId === 'SG1');
  ok('Generate does not lock a room after the band room was cleared',
    !unlockedSg || !unlockedSg.roomId,
    unlockedSg ? (unlockedSg.roomId + ' ' + (unlockedSg.room || '')) : 'SG1 not placed');

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
  const unlockedDriveSg = api.parseSmallGroupsTable([
    {SMALL_GROUP_ID:'SG8', SMALL_GROUP:'Small Group 8', DURATION_MIN:'90', ROLE:'BASS', STUDENT_ID:'S1'},
    {SMALL_GROUP_ID:'SG8', SMALL_GROUP:'Small Group 8', DURATION_MIN:'90', ROLE:'DRUM', STUDENT_ID:'S2'}
  ], api.DB.students, {
    refTeachers: api.DB.refTeachers, refClasses: api.DB.refClasses, refRooms: api.DB.refRooms
  });
  ok('Sheets row without ROOM_LOCK stays unlocked',
    unlockedDriveSg.smallGroups.length === 1 && !unlockedDriveSg.smallGroups[0].roomId,
    unlockedDriveSg.smallGroups[0] && (unlockedDriveSg.smallGroups[0].roomId || 'none'));
  const liveShaped = api.parseSmallGroupsTable([
    {SMALL_GROUP_ID:'SG16', SMALL_GROUP:'Small Group 16', DURATION_MIN:'90', ROOM_ID:'ROOM1', ROOM:'321jazz', ROLE:'BASS', STUDENT_ID:'S1'},
    {SMALL_GROUP_ID:'SG17', SMALL_GROUP:'Small Group 17', TEACHER:'Kovats', TEACHER_ID:'T1', DURATION_MIN:'90', ROOM_ID:'', ROOM:'', FIXED_DAY:'TUE', ROLE:'ACC', STUDENT_ID:'S1'},
    {SMALL_GROUP_ID:'SG17', SMALL_GROUP:'Small Group 17', TEACHER:'Kovats', TEACHER_ID:'T1', DURATION_MIN:'90', ROOM_ID:'', ROOM:'', FIXED_DAY:'TUE', ROLE:'SOL', STUDENT_ID:'S2'}
  ], api.DB.students, {
    refTeachers: api.DB.refTeachers, refClasses: api.DB.refClasses, refRooms: api.DB.refRooms
  });
  const live16 = liveShaped.smallGroups.find(b => b.id === 'SG16');
  const live17 = liveShaped.smallGroups.find(b => b.id === 'SG17');
  ok('Sheets SG16 keeps an explicit ROOM_LOCK', !!(live16 && live16.roomId === 'ROOM1'));
  ok('Sheets SG17 with blank ROOM_ID/ROOM stays unlocked', !!(live17 && !live17.roomId), live17 && live17.roomId);
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

  console.log('\n== 6c. Edit students checklist, no ✕ on member badges ==');
  install(api, tiny);
  const editState = api.generateSmallGroups(1);
  const band = editState.smallGroups[0];
  const cardHtml = api.renderSmallGroupCard(band, 0, editState.appearances);
  ok('card has Edit students instead of an add dropdown',
    /Edit students/.test(cardHtml) && !/small-group-add-select/.test(cardHtml));
  ok('member badges have no red ✕',
    !/<div class="small-group-member[\s\S]*?✕/.test(cardHtml));
  ok('card header still has delete ✕', /small-group-delete-btn/.test(cardHtml));
  const outsider = api.DB.students.find(s => s.ID === 'S5');
  ok('S5 starts outside the small group', !api.smallGroupContainsStudent(band, 'S5'));
  ok('S5 piano maps to acc', api.smallGroupRoleForStudent(outsider) === 'acc');
  ok('checking S5 adds them as acc',
    api.setSmallGroupStudentMembership(band, outsider, true)
    && (band.acc || []).some(s => s.ID === 'S5'));
  ok('unchecking S5 removes them',
    api.setSmallGroupStudentMembership(band, outsider, false)
    && !api.smallGroupContainsStudent(band, 'S5'));
  const bass = band.bass[0];
  ok('unchecking a current member removes the badge',
    api.setSmallGroupStudentMembership(band, bass, false)
    && !api.smallGroupContainsStudent(band, bass.ID)
    && (band.bass || []).length === 0);
  ok('checking them back restores the bass role',
    api.setSmallGroupStudentMembership(band, bass, true)
    && (band.bass || []).some(s => s.ID === bass.ID));

  const ghost = {ID:'GONE', NAME1:'Ghost', NAME2:'Kid', INSTR_ID:'I1', CLASS_ID:'C1'};
  band.bass.push(ghost);
  api.DB.students = api.DB.students.filter(s => s.ID !== 'GONE');
  const orphans = api.orphanSmallGroupMembers(band);
  ok('orphan small-group member is listed when missing from Students',
    orphans.length === 1 && orphans[0].ID === 'GONE');
  ok('orphan can be unchecked out of the band',
    api.setSmallGroupStudentMembership(band, ghost, false)
    && !api.smallGroupContainsStudent(band, 'GONE'));
  band.sol.push(ghost);
  api.LAST_SMALL_GROUPS = editState;
  ok('Students ✕ purge removes orphan from every small group',
    api.removeStudentFromAllSmallGroups('GONE')
    && !api.smallGroupContainsStudent(band, 'GONE'));

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
  ok('Reports stays locked while generate needs Accept', api.canSwitchTab('reports') === false);
  ok('Cloud stays locked while generate needs Accept', api.canSwitchTab('cloud') === false);
  api.acceptTimetableSchedule();
  ok('Accept unlocks 1/1', api.hasAcceptedRecord() && api.LAST_RESULT.accepted && api.canOpenOneOne());
  ok('Accept unlocks Reports', api.canOpenReports() === true && api.canSwitchTab('reports') === true);
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
  ok('unaccepted 1/1 locks Reports', api.canSwitchTab('reports') === false);
  const oneWeek = api.combinedWeekItems('oneone');
  const oneAud = api.auditTimetable(oneWeek);
  ok('accepted groups + generated 1/1 have no reds',
    oneAud.entries.filter(e => e.level !== 'warning').length === 0,
    oneAud.entries.filter(e => e.level !== 'warning').map(e => stripHtml(e.html)).join(' | '));

  api.acceptOneOneSchedule();
  ok('Accept 1/1 freezes those slots', api.hasAcceptedOneOne());
  ok('Accept 1/1 unlocks Reports', api.canSwitchTab('reports') === true);
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
  const named = (api.LAST_RESULT.scheduled || []).find(s => /Improv|Theory|Small Group/i.test(s.name || ''));
  ok('calendar title uses the lesson name',
    named && /Improv|Theory|Small Group/i.test(api.calendarEventTitle(named)),
    named ? api.calendarEventTitle(named) : 'no named lesson');
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
  ok('timetable drag locks Reports', api.canSwitchTab('reports') === false);
  api.acceptTimetableSchedule();
  ok('re-Accept timetable keeps the dragged slot', group.start === gFrom + 5 && api.LAST_RESULT.accepted);
  ok('re-Accept timetable unlocks 1/1', api.canOpenOneOne() === true);
  ok('re-Accept timetable unlocks piano if 1/1 is still accepted', api.canOpenRpiano() === true);
  ok('re-Accept timetable unlocks Reports', api.canSwitchTab('reports') === true);

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
  api.DB.teacherAvail.forEach(r => { r.start = '08:00'; });
  api.DB.lessons[0].fixedDay = 'MON';
  api.DB.lessons[0].fixedStart = '10:00';
  api.DB.lessons[0].fixedEnd = '10:45';
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
  const overlapPin = api.runScheduler(false);
  const overlapLes = overlapPin.scheduled.find(s => s.lessonId === 'LES1');
  ok('pinned lesson overlapping class reservation is still placed',
    overlapLes && overlapLes.day === 'MON' && overlapLes.start === 10*60,
    overlapLes ? `${overlapLes.day} ${api.toHHMM(overlapLes.start)}` : ((overlapPin.unresolved||[]).map(u => (u.lesson && u.lesson.id)+':'+(u.customReason||'')).join(' | ') || 'unplaced'));
  ok('pinned class-reservation overlap is not unresolved',
    !(overlapPin.unresolved || []).some(u => u.lesson && u.lesson.id === 'LES1'));
  ok('scheduledItemIsPinned matches the FIXED window', api.scheduledItemIsPinned(overlapLes) === true);
  const pinAud = api.auditTimetable(overlapPin.scheduled);
  ok('pin vs class reservation is a WARNING not a red',
    pinAud.entries.some(e => e.level === 'warning' && /class reservation/.test(stripHtml(e.html)) && (e.ids||[]).includes('LES1'))
      && !pinAud.entries.some(e => e.level !== 'warning' && /class reservation/.test(stripHtml(e.html)) && (e.ids||[]).includes('LES1')),
    pinAud.entries.filter(e => /class reservation/.test(stripHtml(e.html))).map(e => e.level+':'+stripHtml(e.html)).join(' | '));
  ok('pin vs class reservation does not paint the block red', !pinAud.conflictIds.has('LES1'));
  const invPin = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, overlapPin);
  ok('independent checker allows pinned class-reservation overlap',
    !invPin.some(e => /LES1/.test(e) && /class reservation/.test(e)),
    invPin.join(' | '));

  install(api, tiny);
  api.DB.forbidUnlistedGroupGaps = true;
  api.DB.breaks = [{id:'B1', teacherId:'T1', teacher:'Ajtai', breakMinutes:0, breakCount:0}];
  api.DB.lessons.push({
    id:'LES2', name:'Theory 9', group:'impr9', groupId:'G1', teacher:'Ajtai', teacherId:'T1',
    duration:45, roomId:'', room:'', fixedDay:'FRI', fixedStart:'14:55', fixedEnd:'15:40'
  });
  api.DB.lessons[0].fixedDay = 'FRI';
  api.DB.lessons[0].fixedStart = '14:00';
  api.DB.lessons[0].fixedEnd = '14:45';
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
  const gapPin = api.runScheduler(false);
  const gapLes1 = gapPin.scheduled.find(s => s.lessonId === 'LES1');
  const gapLes2 = gapPin.scheduled.find(s => s.lessonId === 'LES2');
  ok('pinned pair with illegal 10 min gap is still placed',
    gapLes1 && gapLes1.day === 'FRI' && gapLes1.start === 14*60
      && gapLes2 && gapLes2.day === 'FRI' && gapLes2.start === 14*60+55,
    [gapLes1, gapLes2].map(s => s ? `${s.lessonId} ${s.day} ${api.toHHMM(s.start)}` : 'unplaced').join(' | ')
      || (gapPin.unresolved||[]).map(u => (u.lesson && u.lesson.id)+':'+(u.customReason||'')).join(' | '));
  ok('pinned gap pair is not unresolved',
    !(gapPin.unresolved || []).some(u => u.lesson && (u.lesson.id === 'LES1' || u.lesson.id === 'LES2')));
  const gapPinAud = api.auditTimetable(gapPin.scheduled);
  ok('pin vs illegal teacher gap is a WARNING not a red',
    gapPinAud.entries.some(e => e.level === 'warning' && /gap/.test(stripHtml(e.html)))
      && !gapPinAud.entries.some(e => e.level !== 'warning' && /gap/.test(stripHtml(e.html))),
    gapPinAud.entries.filter(e => /gap/.test(stripHtml(e.html))).map(e => e.level+':'+stripHtml(e.html)).join(' | '));
  ok('pin vs illegal teacher gap does not paint the blocks red',
    !gapPinAud.conflictIds.has('LES1') && !gapPinAud.conflictIds.has('LES2'));
  const invGap = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, gapPin);
  ok('independent checker allows pinned illegal teacher gap',
    !invGap.some(e => /illegal .*gap/.test(e)),
    invGap.join(' | '));

  install(api, tiny);
  const fp1 = api.computeScheduleFingerprint();
  api.DB.lessons[0].duration = 90;
  const fp2 = api.computeScheduleFingerprint();
  ok('fingerprint changes when duration changes', fp1 !== fp2);

  console.log('\n== Phase 1 teacher order ==');
  const orderDb = toyAuditDb();
  orderDb.refTeachers = [
    {id:'T1', name:'Pusztai'},
    {id:'T2', name:'Ajtai'},
    {id:'T3', name:'Pozsar'}
  ];
  orderDb.lessons = [
    {id:'L1', name:'A', groupId:'G1', teacherId:'T1', duration:45, roomId:'', room:''},
    {id:'L2', name:'B', groupId:'G2', teacherId:'T2', duration:90, roomId:'', room:''},
    {id:'L3', name:'C', groupId:'G1', teacherId:'T3', duration:45, roomId:'', room:''}
  ];
  orderDb.teacherAvail = [
    {teacherId:'T1', teacher:'Pusztai', day:'MON', start:'13:00', end:'18:00', type:'AVAILABLE'},
    {teacherId:'T2', teacher:'Ajtai', day:'MON', start:'13:00', end:'18:00', type:'AVAILABLE'},
    {teacherId:'T2', teacher:'Ajtai', day:'TUE', start:'13:00', end:'18:00', type:'AVAILABLE'},
    {teacherId:'T2', teacher:'Ajtai', day:'WED', start:'13:00', end:'18:00', type:'AVAILABLE'},
    {teacherId:'T3', teacher:'Pozsar', day:'MON', start:'13:00', end:'18:00', type:'AVAILABLE'},
    {teacherId:'T3', teacher:'Pozsar', day:'TUE', start:'13:00', end:'18:00', type:'AVAILABLE'}
  ];
  orderDb.phase1TeacherOrder = null;
  install(api, orderDb);
  api.LAST_SMALL_GROUPS = {smallGroups:[]};
  const autoIds = api.collectPhase1TeacherIds();
  ok('Phase 1 teachers are unfixed subject teachers',
    autoIds.length === 3 && autoIds.includes('T1') && autoIds.includes('T2') && autoIds.includes('T3'));
  ok('automatic order is fewest days first (T1 → T3 → T2)',
    api.automaticPhase1TeacherOrder(autoIds).join(',') === 'T1,T3,T2',
    api.automaticPhase1TeacherOrder(autoIds).join(','));
  ok('no manual order yet', api.hasManualPhase1TeacherOrder() === false);
  ok('deterministic resolve matches automatic',
    api.resolvePhase1TeacherOrder(autoIds, false).join(',') === 'T1,T3,T2');
  api.setManualPhase1TeacherOrder(['T2','T1','T3']);
  ok('manual order is stored', api.hasManualPhase1TeacherOrder() === true
    && api.DB.phase1TeacherOrder.join(',') === 'T2,T1,T3');
  ok('deterministic attempt keeps the dragged order',
    api.resolvePhase1TeacherOrder(autoIds, false).join(',') === 'T2,T1,T3');
  const shuffledManual = api.resolvePhase1TeacherOrder(autoIds, true);
  ok('shuffled attempt still permutes the manual list',
    shuffledManual.slice().sort().join(',') === 'T1,T2,T3',
    shuffledManual.join(','));
  ok('unknown ids are dropped and new teachers append',
    api.resolvePhase1TeacherOrder(['T3','T4','T2'], false).join(',') === 'T2,T3,T4',
    api.resolvePhase1TeacherOrder(['T3','T4','T2'], false).join(','));
  const orderSched = api.runScheduler(false);
  const orderLog = (orderSched.searchLog || []).map(l => l.text).join('\n');
  ok('search log names the manual teacher order',
    /Manual teacher order: Ajtai → Pusztai → Pozsar/.test(orderLog),
    orderLog.slice(0, 400));
  const shuffledSched = api.runScheduler(true);
  const shuffledLog = (shuffledSched.searchLog || []).map(l => l.text).join('\n');
  ok('shuffled attempt still logs a shuffled teacher order',
    /Shuffled teacher order this attempt:/.test(shuffledLog)
    && !/Manual teacher order:/.test(shuffledLog),
    shuffledLog.slice(0, 400));
  const fpOrder1 = api.computeScheduleFingerprint();
  api.DB.phase1TeacherOrder = ['T1','T2','T3'];
  const fpOrder2 = api.computeScheduleFingerprint();
  ok('fingerprint changes when teacher order changes', fpOrder1 !== fpOrder2);
  const exported = api.buildFullExportObject();
  ok('export keeps the manual teacher order',
    Array.isArray(exported.phase1TeacherOrder) && exported.phase1TeacherOrder.join(',') === 'T1,T2,T3');
  api.clearManualPhase1TeacherOrder();
  ok('reset clears the manual order', api.hasManualPhase1TeacherOrder() === false);
  install(api, seed);

  install(api, seed);
  const oneTeachers = api.individualTeacherIds('oneone');
  const pianoTeachers = api.individualTeacherIds('rpiano');
  ok('1/1 teachers come from the 1_1 matrix', oneTeachers.includes('TEAC1'));
  ok('piano teachers come from JRPiano', pianoTeachers.includes('TEAC14') || pianoTeachers.includes('TEAC15'));
  ok('dropdowns differ', oneTeachers.join(',') !== pianoTeachers.join(','));

  const variants = [{scheduled:[{lessonId:'A', teacherId:'T1', studentId:'S1', day:'MON', start:8*60, end:9*60}], unresolved:[]}];
  api.LAST_ONEONE = null;
  api.applyIndividualSearch('oneone', variants, '');
  api.LAST_ONEONE.accepted = true;
  api.LAST_ONEONE.variants = [
    variants[0],
    {scheduled:[{lessonId:'A', teacherId:'T1', studentId:'S1', day:'TUE', start:8*60, end:9*60}], unresolved:[]}
  ];
  api.selectIndividualVariant('oneone', 1);
  ok('picking another 1/1 layout un-accepts', api.LAST_ONEONE.accepted === false);
  ok('selected layout times are applied', api.LAST_ONEONE.scheduled[0].day === 'TUE');
  api.LAST_RPIANO = {scheduled: [{teacherId:'T1', studentId:'S1', day:'MON', start:11*60, end:12*60}], unresolved:[], accepted:true};
  api.selectIndividualVariant('oneone', 0);
  ok('1/1 variant on another day keeps non-clashing piano',
    api.LAST_RPIANO != null && api.hasAcceptedRpiano() === true);
  api.LAST_RPIANO = {scheduled: [{teacherId:'T1', studentId:'S1', day:'TUE', start:8*60, end:9*60}], unresolved:[], accepted:true};
  api.selectIndividualVariant('oneone', 1);
  ok('1/1 variant that clashes keeps piano',
    api.LAST_RPIANO != null && api.hasAcceptedRpiano() === true);
  ok('1/1 variant clash is listed',
    api.collectOneOneRpianoClashes(api.LAST_ONEONE.scheduled, api.LAST_RPIANO.scheduled).length >= 1);

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
  ok('attempts clamp allows 5000', api.clampScheduleSearchAttempts(5000) === 5000);
  ok('attempts clamp caps at 50000', api.clampScheduleSearchAttempts(80000) === 50000);
  ok('1000 attempts is not deep search', api.isDeepScheduleSearch(1000) === false);
  ok('1001 attempts is deep search', api.isDeepScheduleSearch(1001) === true);
  ok('deep search starts after 1000', api.DEEP_SEARCH_AFTER === 1000);
  ok('search max is 50000', api.SCHEDULE_SEARCH_ATTEMPTS_MAX === 50000);
  ok('blank attempts value is 100', api.clampScheduleSearchAttempts('x') === 100);
  ok('1/1 attempts default is 15', api.ONEONE_SEARCH_ATTEMPTS === 15);
  ok('piano attempts default is 15', api.RPIANO_SEARCH_ATTEMPTS === 15);
  ok('1/1 attempts clamp floors at 1', api.clampOneOneSearchAttempts(0) === 1);
  ok('1/1 attempts clamp caps at 5000', api.clampOneOneSearchAttempts(8000) === 5000);
  ok('1/1 max tries is 4× attempts', api.oneOneSearchMaxTries(15) === 60 && api.oneOneSearchMaxTries(20) === 80);
  api.applyUiState({oneOneSearchAttempts: '1000', rpianoSearchAttempts: '12'});
  ok('piano generate does not inherit 1/1 attempts', api.readOneOneSearchAttempts('rpiano') === 12);
  ok('1/1 generate still uses its own attempts', api.readOneOneSearchAttempts('oneone') === 1000);
  ok('reading piano does not rewrite 1/1 attempts', api.readOneOneSearchAttempts('oneone') === 1000);
  ok('reading 1/1 does not rewrite piano attempts', api.readOneOneSearchAttempts('rpiano') === 12);
  const uiAttempts = api.collectUiState();
  ok('autosave stores piano attempts separately',
    uiAttempts.rpianoSearchAttempts === '12' && uiAttempts.oneOneSearchAttempts === '1000');
  api.applyUiState({oneOneSearchAttempts: '1000'});
  ok('old save without piano attempts does not force piano to 1000', api.readOneOneSearchAttempts('rpiano') === 12);
  api.applyUiState({oneOneSearchAttempts: '15', rpianoSearchAttempts: '15'});
  function fakeLayout(id, unresolvedN, idle){
    return {
      scheduled: [{lessonId:id, day:'MON', start:8*60, teacherId:'T1'}],
      unresolved: Array.from({length: unresolvedN}, (_, i) => ({lesson:{id:'U'+id+i, name:'x'}})),
      idleGapMinutes: idle || 0,
      oneOneHoleMinutes: 0
    };
  }
  const deepState = api.beginScheduleSearch(2000);
  ok('2000 attempts starts a deep search', deepState.deep === true && deepState.keep === 10);
  for(let i = 1; i <= 12; i++){
    api.recordScheduleAttempt(deepState, fakeLayout('L'+i, 12 - i, i), i);
  }
  ok('deep beam keeps at most 10 full layouts', deepState.beam.length === 10);
  ok('deep beam best has the fewest unresolved', deepState.beam[0].unresolved.length === 0);
  ok('deep search remembers every distinct signature', deepState.distinct === 12 && deepState.seen.size === 12);
  ok('finishScheduleSearch returns the beam sorted', api.finishScheduleSearch(deepState).length === 10);
  const skipKind = api.recordScheduleAttempt(deepState, fakeLayout('WORSE', 40, 0), 13);
  ok('worse-than-beam layout is signature-only', skipKind === 'skip' && deepState.beam.length === 10);
  function completeForecast(id, oneUnres, pianoUnres){
    return {
      scheduled: [{lessonId:id, day:'MON', start:8*60, teacherId:'T1'}],
      unresolved: [],
      idleGapMinutes: 0,
      oneOneHoleMinutes: 0,
      lookahead: {
        oneUnresolved: oneUnres,
        pianoUnresolved: pianoUnres,
        onePlaced: 10,
        pianoPlaced: 5,
        oneTotal: 10,
        pianoTotal: 5
      }
    };
  }
  const forecastState = api.beginScheduleSearch(2000);
  for(let i = 0; i < 10; i++){
    api.recordScheduleAttempt(forecastState, completeForecast('BASE'+i, i, i), i + 1);
  }
  ok('full beam keeps ten complete layouts', forecastState.beam.length === 10);
  const worseForecastKind = api.recordScheduleAttempt(
    forecastState, completeForecast('WORSEFC', 20, 20), 11);
  ok('complete layout with worse forecast than beam worst is skipped',
    worseForecastKind === 'skip' && !forecastState.beam.some(v => v.scheduled[0].lessonId === 'WORSEFC'));
  const betterForecastKind = api.recordScheduleAttempt(
    forecastState, completeForecast('BETTERFC', 0, 0), 12);
  ok('complete layout with better forecast replaces beam worst',
    betterForecastKind === 'kept'
    && forecastState.beam.some(v => v.scheduled[0].lessonId === 'BETTERFC')
    && !forecastState.beam.some(v => v.scheduled[0].lessonId === 'BASE9'));
  ok('compareScheduleBeam prefers better forecast at same left out',
    api.compareScheduleBeam(completeForecast('A', 0, 0), completeForecast('B', 2, 2)) < 0);
  const trimPool = Array.from({length: 12}, (_, i) => completeForecast('T'+i, i % 3, i % 3));
  const trimmed = api.trimVariantPool(trimPool, 10);
  ok('trimVariantPool keeps the ten best forecasts when left out ties',
    trimmed.length === 10
    && trimmed.filter(v => v.lookahead.oneUnresolved === 0).length === 4
    && trimmed.filter(v => v.lookahead.oneUnresolved === 1).length === 4
    && trimmed.filter(v => v.lookahead.oneUnresolved === 2).length === 2);
  api.resetSearchCancel();
  ok('search cancel starts clear', api.isSearchCancelled() === false);
  api.requestCancelSearch();
  ok('requestCancelSearch sets the flag', api.isSearchCancelled() === true);
  api.resetSearchCancel();
  ok('resetSearchCancel clears the flag', api.isSearchCancelled() === false);
  install(api, tiny);
  const quietRes = api.runScheduler(false, {quiet:true});
  ok('quiet scheduler keeps no walkthrough', (quietRes.searchLog || []).length === 0);
  const loudRes = api.runScheduler(false);
  ok('normal scheduler writes a walkthrough', (loudRes.searchLog || []).length > 0);
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
  const fewerLeft = {unresolved:[{lesson:{id:'LES1'}}], lookahead:{oneUnresolved:8, pianoUnresolved:8, onePlaced:1, pianoPlaced:0}};
  const moreLeftBetterLook = {unresolved:[{lesson:{id:'SG1'}},{lesson:{id:'SG2'}}], lookahead:{oneUnresolved:0, pianoUnresolved:0, onePlaced:20, pianoPlaced:10}};
  api.markSuggestedByLookahead([moreLeftBetterLook, fewerLeft], api.groupLookaheadScore);
  ok('group SUGGESTED is fewest leftover items of any kind, not small groups first',
    fewerLeft.suggested === true && moreLeftBetterLook.suggested === false);
  const sameLeftWorseLook = {unresolved:[{lesson:{id:'LES1'}}], idleGapMinutes:10, lookahead:{oneUnresolved:8, pianoUnresolved:8, onePlaced:1, pianoPlaced:0}};
  const sameLeftBetterLook = {unresolved:[{lesson:{id:'SG1'}}], idleGapMinutes:400, lookahead:{oneUnresolved:0, pianoUnresolved:0, onePlaced:20, pianoPlaced:10}};
  api.markSuggestedByLookahead([sameLeftWorseLook, sameLeftBetterLook], api.groupLookaheadScore);
  ok('among the same leftover count, group SUGGESTED is the best 1/1 then piano preview',
    sameLeftBetterLook.suggested === true && sameLeftWorseLook.suggested === false);
  const keptAccepted = {
    accepted: true,
    unresolved: [],
    idleGapMinutes: 40,
    scheduled: [{lessonId:'L1', day:'MON', start:'08:00', teacherId:'T1'}]
  };
  const worseFresh = {
    unresolved: [{lesson:{id:'SG1'}}],
    idleGapMinutes: 0,
    scheduled: [{lessonId:'L2', day:'TUE', start:'09:00', teacherId:'T2'}]
  };
  api.LAST_VARIANTS = [keptAccepted];
  api.mergeGenerateVariants([worseFresh]);
  ok('merge keeps an accepted layout so Generate cannot drop a better week',
    api.LAST_VARIANTS.some(v => v.scheduled && v.scheduled[0] && v.scheduled[0].lessonId === 'L1')
    && api.LAST_VARIANTS[0].accepted === false);
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
    ok('★ search log includes 1/1 forecast', /1\/1 forecast/.test(starLog) && /★/.test(starLog), starLog.slice(-400));
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

  console.log('\n== 13. Search core: 1/1 holes, top-3 gaps, Phase 2 ruin ==');
  ok('promoteTopKRandom leaves a deterministic list alone',
    api.promoteTopKRandom(['a','b','c'], 3, false).join(',') === 'a,b,c');
  const wideHoles = {unresolved:[], scheduled:[], idleGapMinutes:50, oneOneHoleMinutes:400};
  const tightHoles = {unresolved:[], scheduled:[], idleGapMinutes:10, oneOneHoleMinutes:40};
  ok('search ranking ignores 1/1 hole proxy and idle — only leftover count',
    api.compareScoreTuple(api.resultScore(wideHoles), api.resultScore(tightHoles)) === 0);
  const noHoleA = {unresolved:[], scheduled:[], idleGapMinutes:10};
  const noHoleB = {unresolved:[], scheduled:[], idleGapMinutes:40};
  ok('search ranking ignores idle when leftover count matches',
    api.compareScoreTuple(api.resultScore(noHoleA), api.resultScore(noHoleB)) === 0);
  const oneLeftLowIdle = {unresolved:[{lesson:{id:'L1'}}], idleGapMinutes:0, lookahead:{oneUnresolved:5, pianoUnresolved:0, onePlaced:1, pianoPlaced:0}};
  const oneLeftHighIdle = {unresolved:[{lesson:{id:'L2'}}], idleGapMinutes:500, lookahead:{oneUnresolved:0, pianoUnresolved:0, onePlaced:20, pianoPlaced:10}};
  api.LAST_VARIANTS = [oneLeftLowIdle, oneLeftHighIdle];
  api.keepLookaheadBestVariants();
  ok('after 1/1 preview, Solution list follows lookahead not idle',
    api.LAST_VARIANTS[0] === oneLeftHighIdle && oneLeftHighIdle.suggested === true,
    (api.LAST_VARIANTS || []).map(v => v && v.idleGapMinutes).join(','));
  const leftOutSkip = {unresolved:[{lesson:{id:'L1'}}], scheduled:[{lessonId:'L2', day:'MON', start:480, end:525}]};
  const leftOutOk = {unresolved:[], scheduled:[{lessonId:'L2', day:'MON', start:480, end:525}]};
  api.attachGroupLookahead([leftOutSkip, leftOutOk]);
  ok('forecast skipped when anything is left out',
    !leftOutSkip.lookahead && leftOutOk.lookahead,
    JSON.stringify({skip:leftOutSkip.lookahead, ok:leftOutOk.lookahead && leftOutOk.lookahead.oneTotal}));
  const moveDb = {
    students: [
      {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1', INSTR_ID:'I1'},
      {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', CLASS:'9a', INSTR_ID:'I2'}
    ],
    lessons: [
      {id:'L1', name:'Combo A', groupId:'G1', group:'comboA', teacherId:'T1', teacher:'Tea', duration:60, roomId:'', room:''},
      {id:'L2', name:'Combo B', groupId:'G2', group:'comboB', teacherId:'T1', teacher:'Tea', duration:60, roomId:'', room:''}
    ],
    teacherAvail: [
      {teacherId:'T1', teacher:'Tea', day:'MON', start:'08:00', end:'20:00', type:'AVAILABLE'}
    ],
    classAvail: [
      {classId:'C1', class:'9a', day:'MON', start:'08:00', end:'12:00'}
    ],
    refTeachers: [{id:'T1', name:'Tea'}],
    refClasses: [{id:'C1', name:'9a', muclass:'9'}],
    refGroups: [{id:'G1', name:'comboA', type:'COMBO'}, {id:'G2', name:'comboB', type:'COMBO'}],
    breaks: [],
    forbidUnlistedGroupGaps: false,
    oneToOne: [[], ['S1','Tea',1], ['S2','Tea',1]],
    rpiano: [['Student','Teacher','Hours']]
  };
  install(api, moveDb);
  const moveSched = [
    {lessonId:'L1', name:'Combo A', teacherId:'T1', teacher:'Tea', day:'MON', start:720, end:780, groupId:'G1'},
    {lessonId:'L2', name:'Combo B', teacherId:'T1', teacher:'Tea', day:'MON', start:780, end:840, groupId:'G2'}
  ];
  ok('forecast move rejects overlap target', api.groupMoveSlotLegal(moveSched[0], 'MON', 780, moveSched) === false);
  ok('forecast move accepts empty slot', api.groupMoveSlotLegal(moveSched[0], 'MON', 840, moveSched) === true);
  const moved = api.applyScheduledMove(moveSched, 'L1', 'MON', 840, 900);
  ok('applyScheduledMove updates the slot', moved[0].start === 840 && moved[0].end === 900);
  ok('moved layout passes audit', (api.auditTimetable(moved).entries || []).every(e => e.level === 'warning'));
  const plan = api.forecastMoveTeacherPlan([
    {lessonId:'L1', teacherId:'T2', day:'MON', start:720, end:780},
    {lessonId:'L2', teacherId:'T1', day:'MON', start:780, end:840},
    {lessonId:'L3', teacherId:'T1', day:'TUE', start:600, end:660}
  ]);
  ok('forecast moves are grouped by teacher', plan.length === 2 && plan[0].teacherId === 'T1' && plan[0].lessonIds.length === 2);
  const moveWorse = {unresolved:[], lookahead:{oneUnresolved:2, pianoUnresolved:1, onePlaced:10, pianoPlaced:4}};
  const moveBetter = {unresolved:[], lookahead:{oneUnresolved:0, pianoUnresolved:1, onePlaced:12, pianoPlaced:5}};
  ok('bestForecastLayout picks better lookahead', api.bestForecastLayout([moveWorse, moveBetter]) === moveBetter);
  ok('forecastMoveTargetLayout picks best forecast for slot moves',
    api.forecastMoveTargetLayout([moveWorse, moveBetter]) === moveBetter);
  install(api, tiny);
  const fastSched = api.runScheduler(false);
  ok('a search attempt does not walk leftover 1/1 holes',
    fastSched.oneOneHoleMinutes == null);
  const ruinDb = {
    students: [
      {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1', INSTR_ID:'I1'},
      {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', CLASS:'9a', INSTR_ID:'I2'},
      {ID:'S3', NAME1:'Cat', NAME2:'C', CLASS_ID:'C1', CLASS:'9a', INSTR_ID:'I3'},
      {ID:'S4', NAME1:'Dan', NAME2:'D', CLASS_ID:'C1', CLASS:'9a', INSTR_ID:'I4'}
    ],
    lessons: [
      {id:'L1', name:'Improv A', groupId:'G1', group:'imprA', teacherId:'T1', teacher:'Tea', duration:60, roomId:'', room:''}
    ],
    teacherAvail: [
      {teacherId:'T1', teacher:'Tea', day:'MON', start:'14:00', end:'16:00', type:'AVAILABLE'}
    ],
    classAvail: [
      {classId:'C1', class:'9a', day:'MON', start:'08:00', end:'14:00'}
    ],
    refTeachers: [{id:'T1', name:'Tea'}],
    refClasses: [{id:'C1', name:'9a', muclass:'9'}],
    refGroups: [{id:'G1', name:'imprA', type:'IMPR'}],
    refInstruments: [
      {id:'I1', name:'bassg', type:'bass'},
      {id:'I2', name:'drum', type:'drum'},
      {id:'I3', name:'piano', type:'acc'},
      {id:'I4', name:'sax', type:'sol'}
    ],
    refRooms: [{id:'ROOM1', name:'321'}],
    smallGroupQuotas: [{teacherId:'T1', amount:1}],
    breaks: [],
    oneToOne: {columns:[], hours:{}},
    rpiano: {columns:[], hours:{}},
    acceptedSchedule: []
  };
  install(api, ruinDb);
  api.LAST_SMALL_GROUPS = {
    smallGroups: [{
      id:'SG1',
      bass:[{ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', INSTR_ID:'I1'}],
      drum:[{ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', INSTR_ID:'I2'}],
      acc:[{ID:'S3', NAME1:'Cat', NAME2:'C', CLASS_ID:'C1', INSTR_ID:'I3'}],
      sol:[{ID:'S4', NAME1:'Dan', NAME2:'D', CLASS_ID:'C1', INSTR_ID:'I4'}],
      teacherId:'', roomId:'', room:'', duration:90,
      fixedDay:'', fixedStart:'', fixedEnd:''
    }],
    excluded: [],
    nextSmallGroupSeq: 2
  };
  const ruined = api.runScheduler(false);
  ok('Phase 2 ruin places the small group that Phase 1 would have blocked',
    ruined.scheduled.some(s => s.lessonId === 'SG1'),
    (ruined.unresolved || []).map(u => u.lesson && u.lesson.id).join(',')
      || ruined.scheduled.map(s => s.lessonId).join(','));

  const blockDb = Object.assign({}, ruinDb, {
    lessons: [{id:'L1', name:'Improv A', groupId:'G1', group:'imprA', teacherId:'T1', teacher:'Tea', duration:180, roomId:'', room:''}]
  });
  install(api, blockDb);
  api.LAST_SMALL_GROUPS = {
    smallGroups: [{
      id:'SG1',
      bass:[{ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'C1', INSTR_ID:'I1'}],
      drum:[{ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'C1', INSTR_ID:'I2'}],
      acc:[{ID:'S3', NAME1:'Cat', NAME2:'C', CLASS_ID:'C1', INSTR_ID:'I3'}],
      sol:[{ID:'S4', NAME1:'Dan', NAME2:'D', CLASS_ID:'C1', INSTR_ID:'I4'}],
      teacherId:'', roomId:'', room:'', duration:90,
      fixedDay:'', fixedStart:'', fixedEnd:''
    }],
    excluded: [],
    nextSmallGroupSeq: 2
  };
  const blocked = api.runScheduler(false);
  ok('Phase 2 skips auto small groups while a subject lesson is unresolved',
    !blocked.scheduled.some(s => s.lessonId === 'SG1')
    && blocked.unresolved.some(u => u.lesson && u.lesson.id === 'SG1'
      && String(u.customReason || '').indexOf('subject lesson') >= 0),
    blocked.scheduled.map(s => s.lessonId).join(',') + ' / '
      + blocked.unresolved.map(u => u.lesson && u.lesson.id).join(','));

  console.log('\n== 12. Timetable reports filters ==');
  install(api, {
    students: [
      {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'CL1'},
      {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'CL2'}
    ],
    lessons: [],
    teacherAvail: [],
    classAvail: [
      {class:'9a', classId:'CL1', day:'MON', start:'09:00', end:'13:00'},
      {class:'10a', classId:'CL2', day:'TUE', start:'09:00', end:'13:00'}
    ],
    refTeachers: [{id:'T1', name:'Ajtai'}, {id:'T2', name:'Pozsar'}],
    refClasses: [{id:'CL1', name:'9a', muclass:'9'}, {id:'CL2', name:'10a', muclass:'10'}],
    refGroups: [],
    refInstruments: [],
    refRooms: [{id:'ROOM1', name:'321'}, {id:'ROOM2', name:'Drum'}]
  });
  api.LAST_RESULT = { accepted: true, scheduled: [
    {lessonId:'LES1', name:'Improv', teacherId:'T1', teacher:'Ajtai', day:'MON', start:9*60, end:10*60, studentIds:'S1', studentNames:['Ann A'], roomId:'ROOM1', room:'321'},
    {lessonId:'LES2', name:'Theory', teacherId:'T2', teacher:'Pozsar', day:'TUE', start:10*60, end:11*60+30, studentIds:'S1,S2', studentNames:['Ann A','Bob B'], roomId:'ROOM2', room:'Drum'}
  ]};
  api.LAST_ONEONE = { accepted: true, scheduled: [
    {lessonId:'O2O-T1-S1', name:'Ann A 1/1', teacherId:'T1', teacher:'Ajtai', day:'WED', start:9*60, end:10*60, studentId:'S1', studentIds:'S1', studentNames:['Ann A'], source:'oneone', roomId:''}
  ]};
  api.LAST_RPIANO = { accepted: true, scheduled: [
    {lessonId:'RP-T2-S2', name:'Bob B piano', teacherId:'T2', teacher:'Pozsar', day:'FRI', start:12*60, end:12*60+30, studentId:'S2', studentIds:'S2', studentNames:['Bob B'], source:'rpiano', roomId:'ROOM1', room:'321'}
  ]};
  const week = api.reportWeekItems();
  ok('report week has groups + 1/1 + piano', week.length === 4, String(week.length));
  ok('kind of group / 1/1 / piano',
    api.reportItemKind(week[0]) === 'group'
      && api.reportItemKind(week.find(i => i.source === 'oneone')) === 'oneone'
      && api.reportItemKind(week.find(i => i.source === 'rpiano')) === 'rpiano');
  const byTeacher = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {teacherId:'T1'}));
  ok('filter by teacher T1',
    byTeacher.length === 2 && byTeacher.every(i => i.teacherId === 'T1'),
    byTeacher.map(i => i.lessonId).join(','));
  const byStudent = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {studentId:'S2'}));
  ok('filter by student S2 hides rpiano by default',
    byStudent.map(i => i.lessonId).sort().join(',') === 'LES2',
    byStudent.map(i => i.lessonId).join(','));
  const byStudentAll = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {studentId:'S2', showRpiano:true}));
  ok('filter by student S2 with rpiano keeps piano',
    byStudentAll.map(i => i.lessonId).sort().join(',') === 'LES2,RP-T2-S2',
    byStudentAll.map(i => i.lessonId).join(','));
  const byClass = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {classId:'CL1'}));
  ok('filter by class 9a includes every item with a 9a student',
    byClass.map(i => i.lessonId).sort().join(',') === 'LES1,LES2,O2O-T1-S1',
    byClass.map(i => i.lessonId).join(','));
  const byMu = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {muclass:'10'}));
  ok('filter by MUCLASS_TYPE 10',
    byMu.map(i => i.lessonId).sort().join(',') === 'LES2,RP-T2-S2',
    byMu.map(i => i.lessonId).join(','));
  const byRoom = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {roomId:'ROOM1'}));
  ok('filter by room 321',
    byRoom.map(i => i.lessonId).sort().join(',') === 'LES1,RP-T2-S2',
    byRoom.map(i => i.lessonId).join(','));
  const combined = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {teacherId:'T1', roomId:'ROOM1'}));
  ok('AND teacher + room keeps only LES1',
    combined.length === 1 && combined[0].lessonId === 'LES1',
    combined.map(i => i.lessonId).join(','));
  const onlyPiano = api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {kind:'rpiano'}));
  ok('kind filter Required Piano', onlyPiano.length === 1 && onlyPiano[0].lessonId === 'RP-T2-S2');
  ok('CLASS_CONST rows become class reservation items',
    api.classReservationItems().length === 2
      && api.classReservationItems().every(i => i.source === 'class' && api.reportItemKind(i) === 'class'));
  ok('class reservation title is the class, not the word reserved',
    api.classReservationItems().every(i => i.name && !/reserved/i.test(i.name)));
  ok('NOTE is the calendar reason (Language / MET), AVAIL RESERVED is ignored',
    api.classReservationReason({note:'Language', avail:'RESERVED'}) === 'Language'
    && api.classReservationReason({note:'MET'}) === 'MET'
    && api.classReservationReason({avail:'RESERVED'}) === '');
  api.DB.classAvail = [
    {class:'9a', classId:'CL1', day:'MON', start:'09:00', end:'13:00', avail:'RESERVED', note:'Language'},
    {class:'10a', classId:'CL2', day:'TUE', start:'09:00', end:'13:00', note:'MET'}
  ];
  const namedRes = api.classReservationItems();
  ok('calendar items carry Language and MET',
    namedRes.some(i => i.classId === 'CL1' && i.reason === 'Language' && i.name === '9a')
    && namedRes.some(i => i.classId === 'CL2' && i.reason === 'MET' && i.name === '10a'));
  const calBox = {innerHTML: ''};
  api.renderCalendar(calBox, namedRes, true, 'none');
  ok('class reservation block is grey class, not the word reserved',
    /is-class/.test(calBox.innerHTML) && /Language/.test(calBox.innerHTML) && !/ · reserved/.test(calBox.innerHTML),
    calBox.innerHTML.slice(0, 500));
  const calPrint = {innerHTML: ''};
  api.renderCalendar(calPrint, namedRes, true, 'none', { compact: true, pxPerMin: 0.9 });
  ok('compact PDF class reservation shows NOTE and class name',
    /Language/.test(calPrint.innerHTML) && /9a/.test(calPrint.innerHTML)
    && /MET/.test(calPrint.innerHTML) && /10a/.test(calPrint.innerHTML),
    calPrint.innerHTML.slice(0, 700));
  const oneoneCal = {innerHTML: ''};
  api.renderCalendar(oneoneCal, [{
    lessonId:'O2O-T1-S1', name:'Ann A 1/1', teacherId:'T1', teacher:'Ajtai',
    day:'WED', start:9*60, end:10*60, studentCount:1, studentNames:['Ann A'], source:'oneone'
  }], false, 'oneone');
  ok('1/1 calendar block shows the teacher name',
    /Ajtai/.test(oneoneCal.innerHTML) && /Ann A 1\/1/.test(oneoneCal.innerHTML),
    oneoneCal.innerHTML.slice(0, 400));
  const flushA = {
    lessonId:'O2O-T1-S1', name:'Vince 1/1 · 45′', teacherId:'T1', teacher:'Ajtai',
    studentId:'S1', studentIds:'S1', day:'MON', start:9*60, end:9*60+45,
    studentCount:1, studentNames:['Vince'], source:'oneone'
  };
  const flushB = {
    lessonId:'O2O-T1-S1-2', name:'Vince 1/1 · 45′', teacherId:'T1', teacher:'Ajtai',
    studentId:'S1', studentIds:'S1', day:'MON', start:9*60+45, end:10*60+30,
    studentCount:1, studentNames:['Vince'], source:'oneone'
  };
  const flushMerged = api.mergeFlushIndividualTiles([flushA, flushB]);
  ok('flush split 1/1 pieces merge into one tile',
    flushMerged.length === 1
      && flushMerged[0].start === 9*60
      && flushMerged[0].end === 10*60+30
      && flushMerged[0].name === 'Vince 1/1'
      && (flushMerged[0].mergedIds || []).join(',') === 'O2O-T1-S1,O2O-T1-S1-2',
    JSON.stringify(flushMerged.map(i => ({id:i.lessonId, name:i.name, start:i.start, end:i.end, merged:i.mergedIds}))));
  const fusedLive = [Object.assign({}, flushA), Object.assign({}, flushB)];
  api.coalesceFlushIndividualLessons(fusedLive);
  ok('flush slices fuse into one scheduled lesson',
    fusedLive.length === 1
      && fusedLive[0].lessonId === 'O2O-T1-S1'
      && fusedLive[0].duration === 90
      && fusedLive[0].name === 'Vince 1/1'
      && fusedLive[0].start === 9*60
      && fusedLive[0].end === 10*60+30
      && !fusedLive[0].mergedIds,
    JSON.stringify(fusedLive));
  const gappedLive = [
    Object.assign({}, flushA),
    Object.assign({}, flushB, {start:11*60, end:11*60+45})
  ];
  api.coalesceFlushIndividualLessons(gappedLive);
  ok('gapped slices stay two scheduled lessons',
    gappedLive.length === 2 && gappedLive.every(s => s.end - s.start === 45));
  const gapMerged = api.mergeFlushIndividualTiles([
    Object.assign({}, flushA),
    Object.assign({}, flushB, {start:11*60, end:11*60+45})
  ]);
  ok('same-day split with a gap stays two tiles',
    gapMerged.length === 2 && !gapMerged.some(i => i.mergedIds),
    gapMerged.map(i => i.lessonId).join(','));
  const otherStu = api.mergeFlushIndividualTiles([
    Object.assign({}, flushA),
    Object.assign({}, flushB, {lessonId:'O2O-T1-S2-2', studentId:'S2', studentIds:'S2', name:'Bela 1/1 · 45′'})
  ]);
  ok('different students stay two tiles even if flush',
    otherStu.length === 2 && !otherStu.some(i => i.mergedIds),
    otherStu.map(i => i.lessonId).join(','));
  const groupKeep = {lessonId:'L1', name:'Combo', teacherId:'T1', day:'MON', start:9*60, end:10*60};
  const withGroup = api.mergeFlushIndividualTiles([groupKeep, flushA, flushB]);
  ok('group lessons stay unmerged next to a flush 1/1 tile',
    withGroup.length === 2
      && withGroup.some(i => i.lessonId === 'L1' && !i.mergedIds)
      && withGroup.some(i => (i.mergedIds || []).join(',') === 'O2O-T1-S1,O2O-T1-S1-2'));
  const flushCal = {innerHTML: ''};
  api.renderCalendar(flushCal, [flushA, flushB], false, 'oneone');
  ok('calendar paints one merged 1/1 tile',
    (flushCal.innerHTML.match(/data-lesson-id="O2O-T1-S1"/g) || []).length === 1
      && !/data-lesson-id="O2O-T1-S1-2"/.test(flushCal.innerHTML)
      && /data-merged-ids="O2O-T1-S1,O2O-T1-S1-2"/.test(flushCal.innerHTML)
      && /Vince 1\/1/.test(flushCal.innerHTML)
      && !/Vince 1\/1 · 45/.test(flushCal.innerHTML)
      && /09:00–10:30/.test(flushCal.innerHTML),
    flushCal.innerHTML.slice(0, 700));
  const pianoFlush = api.mergeFlushIndividualTiles([
    Object.assign({}, flushA, {source:'rpiano', lessonId:'RP-T1-S1', name:'Vince piano · 45′', group:'piano'}),
    Object.assign({}, flushB, {source:'rpiano', lessonId:'RP-T1-S1-2', name:'Vince piano · 45′', group:'piano'})
  ]);
  ok('flush Required Piano pieces also merge in the view',
    pianoFlush.length === 1 && pianoFlush[0].name === 'Vince piano'
      && (pianoFlush[0].mergedIds || []).join(',') === 'RP-T1-S1,RP-T1-S1-2');
  const aLive = Object.assign({}, flushA);
  const bLive = Object.assign({}, flushB);
  api.LAST_ONEONE = {scheduled:[aLive, bLive], unresolved:[], dragUndo:[]};
  const inert = {classList:{add(){}, remove(){}}, releasePointerCapture(){}, dataset:{mergedIds:'O2O-T1-S1,O2O-T1-S1-2'}};
  const emptyCal = {querySelectorAll(){ return []; }, querySelector(){ return null; }};
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container: emptyCal, dayBodies: [],
    lessonId: 'O2O-T1-S1',
    pieces: [{lessonId:'O2O-T1-S1', duration:45}, {lessonId:'O2O-T1-S1-2', duration:45}],
    kind: 'oneone', duration: 90, originX: 0, originY: 0,
    active: true, hover: {day:'TUE', start:10*60}, previewBody: null
  };
  api.endCalendarDrag(true);
  const fusedDrag = api.LAST_ONEONE.scheduled;
  ok('dragging flush pieces fuses them into one lesson',
    fusedDrag.length === 1
      && fusedDrag[0].lessonId === 'O2O-T1-S1'
      && fusedDrag[0].day === 'TUE'
      && fusedDrag[0].start === 10*60
      && fusedDrag[0].end === 11*60+30
      && fusedDrag[0].duration === 90
      && fusedDrag[0].name === 'Vince 1/1',
    JSON.stringify(fusedDrag.map(i => ({id:i.lessonId, name:i.name, day:i.day, start:i.start, end:i.end, duration:i.duration}))));
  api.undoIndividualDrag('oneone');
  const undone = api.LAST_ONEONE.scheduled;
  ok('undo restores both split pieces',
    undone.length === 2
      && undone.some(s => s.lessonId === 'O2O-T1-S1' && s.day === 'MON' && s.start === 9*60 && s.end === 9*60+45)
      && undone.some(s => s.lessonId === 'O2O-T1-S1-2' && s.day === 'MON' && s.start === 9*60+45 && s.end === 10*60+30),
    JSON.stringify(undone.map(i => ({id:i.lessonId, day:i.day, start:i.start, end:i.end}))));
  const gapA = Object.assign({}, flushA);
  const gapB = Object.assign({}, flushB, {day:'TUE', start:10*60, end:10*60+45});
  api.LAST_ONEONE = {scheduled:[gapA, gapB], unresolved:[], dragUndo:[]};
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container: emptyCal, dayBodies: [],
    lessonId: 'O2O-T1-S1-2',
    pieces: [{lessonId:'O2O-T1-S1-2', duration:45}],
    kind: 'oneone', duration: 45, originX: 0, originY: 0,
    active: true, hover: {day:'MON', start:9*60+45}, previewBody: null
  };
  api.endCalendarDrag(true);
  const droppedFlush = api.LAST_ONEONE.scheduled;
  ok('dropping a slice flush against its pair fuses them into one lesson',
    droppedFlush.length === 1
      && droppedFlush[0].lessonId === 'O2O-T1-S1'
      && droppedFlush[0].day === 'MON'
      && droppedFlush[0].start === 9*60
      && droppedFlush[0].end === 10*60+30
      && droppedFlush[0].name === 'Vince 1/1',
    JSON.stringify(droppedFlush.map(i => ({id:i.lessonId, day:i.day, start:i.start, end:i.end, name:i.name}))));
  api.DB.refTeachers = [{id:'T1', name:'Ajtai'}, {id:'T2', name:'Pozsar'}, {id:'T3', name:'Csuhaj'}];
  const hueOf = c => parseFloat((c.bg.match(/hsl\(([-\d.]+)/) || [])[1]);
  const h1 = hueOf(api.colorForTeacher('T1'));
  const h2 = hueOf(api.colorForTeacher('T2'));
  const h3 = hueOf(api.colorForTeacher('T3'));
  const hueGap = (a,b) => Math.min(Math.abs(a-b), 360-Math.abs(a-b));
  ok('neighbor teachers get well-separated hues',
    hueGap(h1,h2) >= 20 && hueGap(h2,h3) >= 20 && hueGap(h1,h3) >= 20,
    [h1,h2,h3].join(','));
  ok('teacher swatches stay light pastels like the original',
    parseInt((api.colorForTeacher('T1').bg.match(/% (\d+)%\)/) || [])[1], 10) >= 88);
  ok('teacher colors carry readable ink on light tiles',
    api.colorForTeacher('T1').text === '#1a1d28' && api.colorForTeacher('T1').textDim === '#434963');
  const groupCal = {innerHTML: ''};
  api.renderCalendar(groupCal, [{
    lessonId:'L1', name:'Combo', teacherId:'T1', teacher:'Ajtai',
    day:'MON', start:9*60, end:10*60, studentCount:4, studentNames:['A','B','C','D']
  }], true);
  ok('all-teachers calendar marks colored tiles for readable ink',
    /has-teacher-bg/.test(groupCal.innerHTML) && /--cal-ink:#1a1d28/.test(groupCal.innerHTML),
    groupCal.innerHTML.slice(0, 400));
  api.DB.refTeachers = [{id:'T1', name:'Ajtai'}, {id:'T2', name:'Pozsar'}];
  api.DB.classAvail = [
    {class:'9a', classId:'CL1', day:'MON', start:'09:00', end:'13:00'},
    {class:'10a', classId:'CL2', day:'TUE', start:'09:00', end:'13:00'}
  ];
  const resAll = api.reportClassReservationItems(api.emptyReportFilters(), []);
  ok('unfiltered reports include every class reservation', resAll.length === 2, String(resAll.length));
  const resCl1 = api.reportClassReservationItems(Object.assign(api.emptyReportFilters(), {classId:'CL1'}), []);
  ok('class filter keeps that class reservation',
    resCl1.length === 1 && resCl1[0].classId === 'CL1',
    resCl1.map(i => i.classId).join(','));
  const resS2 = api.reportClassReservationItems(Object.assign(api.emptyReportFilters(), {studentId:'S2'}), []);
  ok('student filter keeps their class reservation',
    resS2.length === 1 && resS2[0].classId === 'CL2',
    resS2.map(i => i.classId).join(','));
  const resMu9 = api.reportClassReservationItems(Object.assign(api.emptyReportFilters(), {muclass:'9'}), []);
  ok('MUCLASS_TYPE 9 keeps 9a reservation',
    resMu9.length === 1 && resMu9[0].classId === 'CL1');
  const resTeacher = api.reportClassReservationItems(
    Object.assign(api.emptyReportFilters(), {teacherId:'T1'}),
    byTeacher
  );
  ok('teacher filter overlays reservations for classes in those lessons',
    resTeacher.length === 1 && resTeacher[0].classId === 'CL1',
    resTeacher.map(i => i.classId).join(','));
  const resHidden = api.reportClassReservationItems(
    Object.assign(api.emptyReportFilters(), {showClassReservations:false}),
    []
  );
  ok('unticking Class reservations hides the red overlay', resHidden.length === 0);
  ok('emptyReportFilters defaults to showing class reservations',
    api.emptyReportFilters().showClassReservations === true);
  const resTeacherHidden = api.reportClassReservationItems(
    Object.assign(api.emptyReportFilters(), {teacherId:'T1', showClassReservations:false}),
    byTeacher
  );
  ok('the checkbox hides reservations even in a teacher view', resTeacherHidden.length === 0);
  const csvRes = api.reportCsvAoa(resCl1);
  ok('class reservation CSV kind is Class reservation',
    csvRes[1] && csvRes[1][3] === 'Class reservation',
    JSON.stringify(csvRes[1]));
  const csv = api.reportCsvAoa(byTeacher);
  ok('report CSV has a header and the filtered rows',
    csv[0][0] === 'DAY' && csv.length === 3 && csv[1][3] === 'Group lessons',
    JSON.stringify(csv[0]));
  const batchS1 = api.planReportBatchPages('student', ['S1'], { skipEmpty: true });
  const batchEmpty = api.planReportBatchPages('student', ['NOBODY'], { skipEmpty: true });
  ok('batch weekly plan builds a page per student with calendar items',
    batchS1.length === 1 && batchS1[0].bundle.listItems.length >= 3 && batchEmpty.length === 0);
  const batchTeachers = api.reportBatchTargets('teacher');
  ok('batch teacher list comes from reference teachers',
    batchTeachers.some(t => t.id === 'T1'));
  ok('batch teacher filters hide class reservations',
    api.reportBatchFilters('teacher', 'T1').showClassReservations === false);
  ok('batch student filters show class reservations',
    api.reportBatchFilters('student', 'S1').showClassReservations === true);
  ok('batch student filters hide rpiano by default',
    api.reportBatchFilters('student', 'S2').showRpiano === false);
  ok('student filter without rpiano drops piano lessons',
    !api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {studentId:'S2', showRpiano:false}))
      .some(i => api.reportItemKind(i) === 'rpiano'));
  ok('student filter with rpiano keeps piano lessons',
    api.filterReportItems(week, Object.assign(api.emptyReportFilters(), {studentId:'S2', showRpiano:true}))
      .some(i => api.reportItemKind(i) === 'rpiano'));
  const sneakyPiano = Object.assign({}, week.find(i => i.source === 'rpiano') || {
    lessonId:'RP-T2-S2', name:'Bob B piano', teacherId:'T2', day:'FRI', start:12*60, end:12*60+30,
    studentId:'S2', studentIds:'S2', studentNames:['Bob B']
  });
  delete sneakyPiano.source;
  ok('RP- lesson id counts as Required Piano even without source',
    api.reportItemKind(sneakyPiano) === 'rpiano');
  const hiddenBundle = api.reportBatchPageItems({
    scope: 'student',
    filters: api.reportBatchFilters('student', 'S2', { showRpiano: false }),
    bundle: api.reportBundleForFilters(api.reportBatchFilters('student', 'S2', { showRpiano: false }))
  });
  ok('student PDF view strips Required Piano when checkbox is off',
    hiddenBundle.gridItems.every(i => api.reportItemKind(i) !== 'rpiano')
    && hiddenBundle.listItems.every(i => api.reportItemKind(i) !== 'rpiano'));
  const teacherView = api.reportBatchPageItems({
    scope: 'teacher',
    filters: api.reportBatchFilters('teacher', 'T1'),
    bundle: api.reportBundleForFilters(api.reportBatchFilters('teacher', 'T1'))
  });
  const studentView = api.reportBatchPageItems({
    scope: 'student',
    filters: api.reportBatchFilters('student', 'S2'),
    bundle: api.reportBundleForFilters(api.reportBatchFilters('student', 'S2'))
  });
  ok('teacher PDF view has no class reservation rows',
    teacherView.listItems.every(i => api.reportItemKind(i) !== 'class'));
  api.LAST_RESULT = {
    accepted: true,
    scheduled: api.LAST_RESULT.scheduled,
    unresolved: [{
      lesson: {id:'LESX', name:'Combo X', teacherId:'T1', groupId:'G1'},
      students: [{ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'CL1'}],
      customReason: 'no free slot'
    }]
  };
  api.LAST_ONEONE = {
    accepted: true,
    scheduled: api.LAST_ONEONE.scheduled,
    unresolved: [{studentId:'S2', name:'Bob B', teacherId:'T2', reason:'no shared free slot'}]
  };
  const t1Unplaced = api.reportTeacherUnplacedForPdf('T1');
  const t2Unplaced = api.reportTeacherUnplacedForPdf('T2');
  ok('teacher PDF lists unplaced group students for that teacher',
    t1Unplaced.some(e => e.label === 'Ann A' && e.kind === 'Group lesson'));
  ok('teacher PDF lists unplaced 1/1 students for that teacher',
    t2Unplaced.some(e => e.label === 'Bob B' && e.kind === '1/1'));
  const teacherPage = api.planReportBatchPages('teacher', ['T1'], { skipEmpty: false })[0];
  ok('teacher batch page carries unplaced entries',
    teacherPage.unplaced && teacherPage.unplaced.length >= 1);
  ok('student PDF view can include class reservations',
    studentView.listItems.some(i => api.reportItemKind(i) === 'class'));
  ok('student PDF view hides rpiano by default',
    studentView.listItems.every(i => api.reportItemKind(i) !== 'rpiano'));
  api.DB.refRooms = [{id:'ROOM1', name:'321'}, {id:'ROOM2', name:'Drum'}];
  const rooms = api.resolveRoomsByHints([
    { label: '321-es terem', hints: ['321'] },
    { label: 'Dobterem', hints: ['dobterem', 'dob', 'drum'] }
  ]);
  ok('room hints resolve 321-es terem and Dobterem (Drum)',
    rooms.length === 2
    && rooms[0].label === '321-es terem'
    && rooms[1].label === 'Dobterem'
    && rooms[1].id === 'ROOM2',
    rooms.map(r => `${r.id}:${r.label}`).join(';'));
  const pack = api.planStandardWeeklyPdfPages({ skipEmpty: true });
  ok('standard weekly PDF pack orders rooms then students then teachers',
    pack.length >= 5
    && pack[0].scope === 'room' && pack[0].title === '321-es terem'
    && pack[1].scope === 'room' && pack[1].title === 'Dobterem'
    && pack.some(p => p.scope === 'student')
    && pack[pack.length - 1].scope === 'teacher');
  let renderedOk = true;
  try { api.renderReportsTab(); } catch(e){ renderedOk = false; }
  ok('renderReportsTab does not throw', renderedOk);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
}

main();
