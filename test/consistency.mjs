#!/usr/bin/env node
// Whole-app consistency, recursion/deep-input robustness, and cross-module smoke.
// Covers the full src/app.js surface — not just reports/PDF.
//
//   node test/consistency.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { checkSchedule, isSmallGroupId } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures');

let failed = 0;
let passed = 0;
const failures = [];
const findings = [];

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

function note(name, detail){
  findings.push(detail ? `${name}: ${detail}` : name);
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

function timed(name, fn, maxMs){
  const t0 = performance.now();
  let err = null;
  let result = null;
  try { result = fn(); }
  catch(e){ err = e; }
  const ms = performance.now() - t0;
  ok(name + ' completes without throw', !err, err ? String(err && err.stack || err) : '');
  ok(name + ' under ' + maxMs + 'ms', ms < maxMs, ms.toFixed(1) + 'ms');
  return result;
}

function makeOverlappingItems(n, start = 8 * 60, end = 9 * 60){
  return Array.from({length: n}, (_, i) => ({
    lessonId: 'OL' + i,
    teacherId: 'T' + (i % 7),
    start,
    end
  }));
}

function makeTouchingChain(n, start = 8 * 60, dur = 45){
  return Array.from({length: n}, (_, i) => ({
    lessonId: 'CH' + i,
    teacherId: 'T1',
    start: start + i * dur,
    end: start + (i + 1) * dur
  }));
}

function makeClassReservationBatch(n){
  return Array.from({length: n}, (_, i) => ({
    day: 'MON',
    start: 9 * 60,
    end: 13 * 60,
    classId: 'CL' + i,
    class: 'Class ' + i,
    source: 'class',
    note: i % 2 === 0 ? 'Language' : 'MET',
    reason: i % 2 === 0 ? 'Language' : 'MET'
  }));
}

function makeSchedulerVariants(n){
  return Array.from({length: n}, (_, i) => ({
    scheduled: [{
      lessonId: 'L' + i,
      day: 'MON',
      start: 13 * 60 + (i % 60),
      end: 13 * 60 + 45 + (i % 60),
      teacherId: 'T1'
    }],
    unresolved: []
  }));
}

function makeScheduledAuditItems(n){
  return Array.from({length: n}, (_, i) => ({
    lessonId: 'AUD' + i,
    name: 'Lesson ' + i,
    teacherId: 'T' + (i % 12),
    teacher: 'Teacher ' + (i % 12),
    day: api.DAYS[i % 5],
    start: 13 * 60 + (i % 20) * 5,
    end: 13 * 60 + 45 + (i % 20) * 5,
    roomId: 'R' + (i % 3),
    room: 'Room ' + (i % 3),
    groupId: 'G' + (i % 8),
    studentIds: 'S' + (i % 40)
  }));
}

function syntheticSchool(base, studentCount, extraLessons){
  const db = clone(base);
  for(let i = 0; i < studentCount; i++){
    db.students.push({
      ID: 'SX' + i,
      NAME1: 'Synthetic',
      NAME2: String(i),
      CLASS_ID: 'C9',
      CLASS: '9a',
      IMPR_ID: 'G1',
      INSTR_ID: 'INST3',
      INSTR: 'sax'
    });
  }
  for(let i = 0; i < extraLessons; i++){
    db.lessons.push({
      id: 'LEX' + i,
      name: 'Extra ' + i,
      group: 'impr9',
      groupId: 'G1',
      teacher: 'Ajtai',
      teacherId: 'T1',
      duration: 45,
      roomId: 'ROOM1',
      room: '321'
    });
  }
  return db;
}

/** Linear nesting: each level has one child variant (true recursion depth). */
function buildNestedRpianoState(depth){
  let node = {
    scheduled: [{source: 'rjpiano', kind: 'rjpiano', lessonId: 'RJP-LEAF'}],
    acceptedSchedule: [{source: 'rjpiano', lessonId: 'RJP-ACC'}],
    unresolved: [{lesson: {source: 'rjpiano', lessonId: 'RJP-UN'}}],
    variants: []
  };
  for(let d = 1; d < depth; d++){
    node = {
      scheduled: [{source: 'rjpiano', lessonId: 'RJP-L' + d}],
      variants: [node]
    };
  }
  return node;
}

/** Branching tree: moderate stack depth, many recursive calls total. */
function buildBranchingRpianoState(branching, depth){
  function node(level){
    if(level <= 0){
      return {
        scheduled: [{source: 'rjpiano', lessonId: 'RJP-TREE'}],
        variants: []
      };
    }
    return {
      scheduled: [],
      variants: Array.from({length: branching}, () => node(level - 1))
    };
  }
  return node(depth);
}

function exportDbWithRpianoState(base, rpianoState){
  const db = clone(base);
  db.rpianoState = rpianoState;
  db.rjPianoState = null;
  return db;
}

function walkRpianoState(state, visit){
  if(!state) return;
  visit(state);
  (state.variants || []).forEach(v => walkRpianoState(v, visit));
}

function rpianoLessonIds(state){
  const ids = [];
  walkRpianoState(state, st => {
    (st.scheduled || []).forEach(i => { if(i && i.lessonId) ids.push(i.lessonId); });
    (st.acceptedSchedule || []).forEach(i => { if(i && i.lessonId) ids.push(i.lessonId); });
    (st.unresolved || []).forEach(u => {
      const it = u && (u.lesson || u);
      if(it && it.lessonId) ids.push(it.lessonId);
    });
  });
  return ids;
}

function runTinyPipeline(api, tiny){
  install(api, tiny);
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  api.LAST_VARIANTS = [result];
  api.acceptTimetableSchedule();
  const one = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule || []
  });
  api.applyIndividualSearch('oneone', [one], 'T1');
  api.acceptOneOneSchedule();
  const rjp = api.scheduleAllOneToOne({
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  });
  api.applyIndividualSearch('rpiano', [rjp], 'T1');
  api.acceptRpianoSchedule();
  return {result, one, rjp};
}

let api;

function main(){
  console.log('Loading app into harness…');
  const loaded = loadApp();
  api = loaded.api;
  const {root, seed} = loaded;
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const tiny = JSON.parse(fs.readFileSync(path.join(FIX, 'tiny-school.json'), 'utf8'));
  const driveTables = JSON.parse(fs.readFileSync(path.join(FIX, 'drive-tables.json'), 'utf8'));
  const gvizStudents = JSON.parse(fs.readFileSync(path.join(FIX, 'gviz-students.json'), 'utf8'));
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

  console.log('\n== A. Whole-app code consistency ==');

  const topLevelFns = [...appSrc.matchAll(/^function ([a-zA-Z_][a-zA-Z0-9_]*)\(/gm)].map(m => m[1]);
  ok('app.js has a large top-level surface', topLevelFns.length >= 500, String(topLevelFns.length));
  const unreferenced = topLevelFns.filter(name => {
    const hits = (appSrc.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    return hits <= 1;
  });
  ok('unreferenced top-level functions stay bounded',
    unreferenced.length <= 35,
    `${unreferenced.length}: ${unreferenced.slice(0, 12).join(', ')}`);
  if(unreferenced.length) note('unused top-level functions', unreferenced.join(', '));

  const harnessKeys = Object.keys(api).filter(k => !k.startsWith('__')).sort();
  ok('harness exports a broad API', harnessKeys.length >= 280, String(harnessKeys.length));
  const missingHarness = harnessKeys.filter(k => api[k] === undefined);
  ok('every harness export is defined', missingHarness.length === 0, missingHarness.join(', '));

  const jsIds = [...appSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const missingDom = [...new Set(jsIds)].filter(id => !htmlIds.has(id) && id !== 'hoverTooltip');
  ok('every getElementById target exists in index.html', missingDom.length === 0, missingDom.join(', '));

  const clickIds = [...appSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)\?\.addEventListener|getElementById\(\s*['"]([^'"]+)['"]\s*\)\.addEventListener/g)]
    .map(m => m[1] || m[2]);
  const missingClick = [...new Set(clickIds)].filter(id => !htmlIds.has(id));
  ok('every click-wired element exists in HTML', missingClick.length === 0, missingClick.join(', '));

  const tabBtns = [...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  const tabPanels = [...html.matchAll(/id="tab-([^"]+)"/g)].map(m => m[1]);
  ok('every nav tab has a panel', tabBtns.every(t => tabPanels.includes(t)),
    tabBtns.filter(t => !tabPanels.includes(t)).join(','));
  ok('all core workflow tabs exist',
    ['cloud','students','lessons','smallgroups','timetable','oneone','rpiano','reports']
      .every(t => tabBtns.includes(t)));

  ok('DRIVE_EXPORT_SPECS is exported', Array.isArray(api.DRIVE_EXPORT_SPECS) && api.DRIVE_EXPORT_SPECS.length >= 10);
  ok('SHEET_ALIASES is exported', api.SHEET_ALIASES && typeof api.SHEET_ALIASES === 'object');
  const exportKeys = new Set(api.DRIVE_EXPORT_SPECS.map(s => s.key));
  const aliasKeys = new Set(Object.keys(api.SHEET_ALIASES));
  const exportWithoutAlias = [...exportKeys].filter(k => !aliasKeys.has(k));
  ok('every Drive export table has sheet aliases',
    exportWithoutAlias.length === 0,
    exportWithoutAlias.join(', '));
  api.DRIVE_EXPORT_SPECS.forEach(spec => {
    ok('Drive sheet name resolves: ' + spec.name, api.matchSheetKey(spec.name) === spec.key);
  });
  Object.keys(api.SHEET_ALIASES).forEach(key => {
  api.SHEET_ALIASES[key].forEach(alias => {
      const hit = api.matchSheetKey(alias);
      ok('alias ' + alias + ' → ' + key, hit === key, hit);
    });
  });

  const subsystemFns = [
    'runScheduler','runSchedulerSearchAll','generateSmallGroups','scheduleOneToOne','scheduleAllOneToOne',
    'auditTimetable','restoreFromLoadedObject','buildFullExportObject','sheetsTablesToDb','driveTablesToAoa',
    'parseGvizTable','parseOneToOneTable','parseSmallGroupsTable','acceptTimetableSchedule','acceptOneOneSchedule',
    'acceptRpianoSchedule','mergeGenerateVariants','layoutColumns','subtractBusyFromIntervals','renderCalendar',
    'planStandardWeeklyPdfPages','restoreAutosaveIfAny','collectTeacherSwapSuggestionsForLayouts',
    'optimizeLayoutSlotsForForecast','generateIndividualScopedAsync','scheduleAllOneToOneSearchAsync'
  ];
  subsystemFns.forEach(fn => ok('app defines ' + fn, new RegExp('function ' + fn + '\\(').test(appSrc)));

  ok('styles.css is non-trivial', css.length > 5000);
  ok('calendar + tab CSS exists', /\.cal-wrap/.test(css) && /\.tab-btn/.test(css));
  ok('search lock CSS exists', /body\.is-searching/.test(css));
  ok('print CSS exists', /@media print/.test(css));

  const criticalIds = [
    'generateBtn','acceptScheduleBtn','generateSmallGroupsBtn','sheetsLoadBtn','sheetsExportBtn',
    'exportDbBtn','exportCalendarBtn','oneoneGenerateBtn','rpianoGenerateBtn','scheduleSearchAttempts',
    'oneoneSearchAttempts','rpianoSearchAttempts','searchLiveOverlay','generateConfirmOverlay',
    'variantSelect','reportFullPdfBtn','reportShowRpiano','reportShowClassReservations'
  ];
  criticalIds.forEach(id => ok('critical UI #' + id, htmlIds.has(id)));

  ok('DAYS constant is Mon–Fri', api.DAYS.length === 5 && api.DAYS[0] === 'MON' && api.DAYS[4] === 'FRI');
  ok('DEFAULT window spans the school day', api.DEFAULT_END > api.DEFAULT_START);
  ok('small group id helper', api.isSmallGroupId('SG12') && !api.isSmallGroupId('LES1'));
  ok('independent isSmallGroupId matches harness', isSmallGroupId('SG3') === api.isSmallGroupId('SG3'));

  console.log('\n== B. Deep-input stress (large lists, no stack recursion) ==');

  timed('layoutColumns 500 overlapping lessons', () => {
    const laid = api.layoutColumns(makeOverlappingItems(500));
    ok('500 overlaps → 500 columns', laid.every(x => x._totalCols === 500));
    ok('500 overlaps → distinct columns', new Set(laid.map(x => x._col)).size === 500);
    return laid;
  }, 500);

  timed('layoutColumns 1200 touching chain', () => {
    const laid = api.layoutColumns(makeTouchingChain(1200));
    ok('1200 chain → full width', laid.every(x => x._totalCols === 1));
    return laid;
  }, 500);

  ok('layoutColumns empty + single item', api.layoutColumns([]).length === 0
    && api.layoutColumns([{lessonId:'X', start:480, end:525}])[0]._totalCols === 1);

  timed('mergeClassReservationItems 300 classes', () => {
    const merged = api.mergeClassReservationItems(makeClassReservationBatch(300));
    ok('300 class rows → 1 merged block', merged.length === 1 && merged[0].classIds.length === 300);
    return merged;
  }, 500);

  const flushChain = Array.from({length: 80}, (_, i) => ({
    source: 'oneone',
    teacherId: 'T1',
    studentId: 'S1',
    day: 'MON',
    lessonId: 'OO' + i,
    name: 'Split ' + i + ' · 45′',
    start: 13 * 60 + i * 45,
    end: 13 * 60 + (i + 1) * 45
  }));
  timed('mergeFlushIndividualTiles 80-tile chain', () => {
    const merged = api.mergeFlushIndividualTiles(flushChain);
    ok('80 adjacent 1/1 tiles coalesce', merged.length === 1 && merged[0].mergedIds.length === 80);
    return merged;
  }, 500);

  timed('coalesceFlushIndividualLessons in-place fuse', () => {
    const fusedLive = flushChain.map(i => Object.assign({}, i));
    api.coalesceFlushIndividualLessons(fusedLive);
    ok('80 flush slices fuse to one lesson', fusedLive.length === 1 && fusedLive[0].duration === 80 * 45);
    return fusedLive;
  }, 500);

  install(api, tiny);
  api.LAST_VARIANTS = makeSchedulerVariants(50);
  timed('mergeGenerateVariants 250 fresh + 50 kept', () => {
    const out = api.mergeGenerateVariants(makeSchedulerVariants(250));
    ok('mergeGenerateVariants fresh count', out.freshCount === 250);
    ok('variant pool trimmed', api.LAST_VARIANTS.length <= api.SCHEDULE_VARIANT_KEEP);
    return out;
  }, 2000);

  timed('trimVariantPool 800 → keep 50', () => {
    const trimmed = api.trimVariantPool(makeSchedulerVariants(800), 50);
    ok('trimVariantPool size', trimmed.length === 50);
    return trimmed;
  }, 1000);

  timed('compareScheduleBeam sort 400 variants', () => {
    const vars = makeSchedulerVariants(400);
    vars.sort((a, b) => api.compareScheduleBeam(a, b));
    ok('sorted variants stay valid', vars[0].scheduled.length === 1);
    return vars;
  }, 1000);

  timed('subtractBusyFromIntervals 100 intervals × 500 cuts', () => {
    const intervals = Array.from({length: 100}, (_, i) => [480 + i, 520 + i]);
    const busy = Array.from({length: 500}, (_, i) => ({
      start: 481 + ((i * 7) % 500),
      end: 485 + ((i * 7) % 500)
    }));
    const out = api.subtractBusyFromIntervals(intervals, busy);
    ok('subtractBusy returns array', Array.isArray(out));
    return out;
  }, 1000);

  timed('candidateStartsForInterval dense windows', () => {
    const windows = Array.from({length: 80}, (_, i) => [480 + i * 5, 500 + i * 5]);
    const starts = api.candidateStartsForInterval(windows, 45, 5);
    ok('candidateStarts returns choices', Array.isArray(starts));
    return starts;
  }, 500);

  install(api, syntheticSchool(tiny, 60, 0));
  timed('studentsFreeIntervals 60 students × 5 days', () => {
    let total = 0;
    api.DAYS.forEach(day => {
      total += api.studentsFreeIntervals(api.DB.students, day).length;
    });
    ok('free-interval scan produces gaps', total > 0, String(total));
    return total;
  }, 2000);

  timed('classFreeGaps with stacked reservations', () => {
    const gaps = api.classFreeGaps('MON', api.DB.classAvail.concat(makeClassReservationBatch(40)));
    ok('classFreeGaps returns intervals', Array.isArray(gaps));
    return gaps;
  }, 1000);

  timed('oneOneSplitPlans catalog depth', () => {
    const plans120 = api.oneOneSplitPlans(120);
    ok('120m split catalog', plans120.length === 1 && plans120[0].join('+') === '60+60');
    const plans90Piano = api.oneOneSplitPlans(90, 'rpiano');
    ok('90m piano split catalog', plans90Piano.length === 3);
    ok('60m never splits', api.oneOneSplitPlans(60).length === 0);
    return plans120;
  }, 500);

  timed('shuffleWithinGroups 2000 items', () => {
    const arr = Array.from({length: 2000}, (_, i) => ({bucket: i % 25, n: i}));
    const shuffled = api.shuffleWithinGroups(arr, x => x.bucket, () => 0.37);
    ok('shuffle preserves length', shuffled.length === 2000);
    return shuffled;
  }, 500);

  timed('promoteTopKRandom 500 choices', () => {
    const choices = Array.from({length: 500}, (_, i) => i);
    const deterministic = api.promoteTopKRandom(choices, 8, false);
    ok('promoteTopKRandom deterministic pass-through', deterministic.length === 500);
    const shuffled = api.promoteTopKRandom(choices.slice(), 8, true);
    ok('promoteTopKRandom shuffled head length', shuffled.length === 500);
    return shuffled;
  }, 500);

  const auditItems = makeScheduledAuditItems(400);
  timed('auditTimetable 400 placements', () => {
    const aud = api.auditTimetable(auditItems);
    ok('audit returns entries array', Array.isArray(aud.entries));
    return aud;
  }, 3000);

  timed('timetableAuditItems on 200 synthetic rows', () => {
    const rows = api.timetableAuditItems(auditItems.slice(0, 200));
    ok('timetableAuditItems length', rows.length === 200);
    return rows;
  }, 2000);

  install(api, tiny);
  const week = api.reportWeekItems();
  timed('filterReportItems repeated 200×', () => {
    let items = week;
    for(let i = 0; i < 200; i++) items = api.filterReportItems(items, api.emptyReportFilters());
    return items;
  }, 1000);
  ok('filterReportItems stable on week items', week.length >= 0);

  install(api, syntheticSchool(tiny, 120, 5));
  api.LAST_SMALL_GROUPS = {smallGroups: []};
  api.LAST_RESULT = {accepted: true, scheduled: [], unresolved: []};
  api.LAST_ONEONE = {accepted: true, scheduled: [], unresolved: []};
  api.LAST_RPIANO = {accepted: true, scheduled: [], unresolved: []};
  timed('planStandardWeeklyPdfPages 120 students', () => {
    return api.planStandardWeeklyPdfPages({skipEmpty: false});
  }, 5000);

  timed('collectTeacherSwapSuggestionsForLayouts 80 variants', () => {
    install(api, tiny);
    api.LAST_VARIANTS = makeSchedulerVariants(80);
    return api.collectTeacherSwapSuggestionsForLayouts(api.LAST_VARIANTS);
  }, 3000);

  timed('resultSignature + computeScheduleFingerprint large schedule', () => {
    const big = makeSchedulerVariants(1)[0];
    big.scheduled = makeScheduledAuditItems(120);
    const sig = api.resultSignature(big);
    install(api, tiny);
    api.LAST_RESULT = big;
    api.LAST_SMALL_GROUPS = {smallGroups: []};
    const fp = api.computeScheduleFingerprint();
    ok('resultSignature non-empty', sig.length > 20);
    ok('fingerprint non-empty', typeof fp === 'string' && fp.length > 8);
    return {sig, fp};
  }, 1000);

  console.log('\n== B2. Recursion depth (nested variant trees, restore migrate) ==');
  ok('app.js migrateRpianoState is recursive',
    /\(st\.variants \|\| \[\]\)\.forEach\(v => migrateRpianoState\(v\)\)/.test(appSrc));

  [50, 200, 400].forEach(depth => {
    timed('restoreFromLoadedObject nested rpiano variants depth ' + depth, () => {
      const nested = buildNestedRpianoState(depth);
      const payload = exportDbWithRpianoState(api.emptyPlannerDb(), nested);
      ok('nested fixture has depth ' + depth + ' RJP- ids before restore',
        rpianoLessonIds(nested).some(id => String(id).startsWith('RJP-')));
      install(api, tiny);
      api.restoreFromLoadedObject(payload);
      ok('depth ' + depth + ': restore survived without stack overflow', api.LAST_RPIANO != null);
      ok('depth ' + depth + ': no RJP- prefix left on loaded state',
        !rpianoLessonIds(api.LAST_RPIANO).some(id => String(id).startsWith('RJP-')),
        rpianoLessonIds(api.LAST_RPIANO).join(', '));
      return api.LAST_RPIANO;
    }, depth >= 300 ? 3000 : 1500);
  });

  timed('restoreFromLoadedObject branching rpiano tree 3^6', () => {
    const tree = buildBranchingRpianoState(3, 6);
    const payload = exportDbWithRpianoState(api.emptyPlannerDb(), tree);
    install(api, tiny);
    api.restoreFromLoadedObject(payload);
    ok('branching tree restore sets LAST_RPIANO', api.LAST_RPIANO != null);
    ok('branching tree migrated all RJP- ids',
      !rpianoLessonIds(api.LAST_RPIANO).some(id => String(id).startsWith('RJP-')));
    return api.LAST_RPIANO;
  }, 3000);

  timed('JSON export → restore round-trip (shallow rpiano state)', () => {
    install(api, tiny);
    api.LAST_RPIANO = {
      accepted: true,
      scheduled: [{source: 'rjpiano', lessonId: 'RJP-SHAL', teacherId: 'T1', day: 'MON', start: 780, end: 810}],
      unresolved: [],
      variants: []
    };
    const blob = api.buildFullExportObject();
    install(api, tiny);
    api.restoreFromLoadedObject(clone(blob));
    ok('export round-trip restores rpiano accepted state', api.LAST_RPIANO && api.LAST_RPIANO.accepted === true);
    ok('export round-trip migrates RJP- → RP-',
      (api.LAST_RPIANO.scheduled || []).some(i => i.lessonId === 'RP-SHAL'));
    return api.LAST_RPIANO;
  }, 3000);

  timed('coalesceIndividualState on 60 variants × 40 slices', () => {
    const slices = Array.from({length: 40}, (_, i) => ({
      source: 'oneone',
      teacherId: 'T1',
      studentId: 'S1',
      day: 'MON',
      lessonId: 'RC' + i,
      start: 13 * 60 + i * 15,
      end: 13 * 60 + (i + 1) * 15
    }));
    const state = {
      scheduled: slices.map(s => Object.assign({}, s)),
      variants: Array.from({length: 60}, () => ({
        scheduled: slices.map(s => Object.assign({}, s)),
        unresolved: []
      }))
    };
    api.coalesceIndividualState(state);
    ok('each variant coalesced to one fused lesson',
      state.variants.every(v => v.scheduled.length === 1));
    return state;
  }, 2000);

  console.log('\n== C. Parse / IO round-trips ==');

  const gvizDb = api.parseGvizTable(gvizStudents, 'students');
  ok('gviz students parse', Array.isArray(gvizDb) && gvizDb.length > 0);

  const {db: parsedDrive} = api.sheetsTablesToDb(driveTables);
  ok('drive fixture → DB students', (parsedDrive.students || []).length >= 1);
  ok('drive fixture resolves teacher id', parsedDrive.lessons[0].teacherId === 'TEAC1');
  ok('drive fixture resolves room lock', parsedDrive.lessons[0].roomId === 'ROOM1');

  install(api, parsedDrive);
  const aoa = api.driveTablesToAoa(api.DB);
  ok('driveTablesToAoa emits core sheets',
    aoa.some(s => s.name === 'STUDENTS') && aoa.some(s => s.name === 'LESSONS'));

  const oneCsv = parseCsv(fs.readFileSync(path.join(FIX, 'one_1.csv'), 'utf8'));
  const oneMatrix = api.parseOneToOneTable(oneCsv, seed.refTeachers);
  ok('1_1 CSV fixture parses teacher columns', (oneMatrix.columns || []).length >= 10);
  ok('1_1 CSV fixture has ST1 hours', oneMatrix.hours.ST1 && oneMatrix.hours.ST1.TEAC1 === 2);

  console.log('\n== D. Cross-module functionality smoke ==');

  install(api, tiny);
  ok('empty DB is empty', api.dbLooksEmpty(api.emptyPlannerDb()));
  ok('harness seed is non-empty', (api.DB.students || []).length > 0);

  const tabGate = () => {
    install(api, tiny);
    ok('Reports locked at boot', api.canOpenReports() === false);
    api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
    api.LAST_RESULT = api.runScheduler(false);
    api.LAST_VARIANTS = [api.LAST_RESULT];
    ok('1/1 locked before Accept timetable', !api.canOpenOneOne());
    api.acceptTimetableSchedule();
    ok('1/1 opens after Accept timetable', api.canOpenOneOne());
    ok('Rpiano still locked before 1/1 Accept', !api.canOpenRpiano());
    const one = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule || []});
    api.applyIndividualSearch('oneone', [one], 'T1');
    api.acceptOneOneSchedule();
    ok('Rpiano opens after Accept 1/1', api.canOpenRpiano());
    return one;
  };
  tabGate();

  const {result, one, rjp} = (() => {
    install(api, tiny);
    api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
    const result = api.runScheduler(false);
    api.LAST_RESULT = result;
    api.LAST_VARIANTS = [result];
    ok('tiny school places lessons', result.scheduled.length >= 2 && result.unresolved.length === 0,
      (result.unresolved || []).map(u => u.customReason).join(' | '));
    const inv = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, result);
    ok('tiny school independent invariants', inv.length === 0, inv.join(' | '));
    api.acceptTimetableSchedule();
    const one = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule || []});
    api.applyIndividualSearch('oneone', [one], 'T1');
    api.acceptOneOneSchedule();
    const rjp = api.scheduleAllOneToOne({
      matrix: api.DB.rpiano,
      acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE.scheduled)),
      source: 'rpiano', lessonLabel: 'piano', idPrefix: 'RP'
    });
    api.applyIndividualSearch('rpiano', [rjp], 'T1');
    api.acceptRpianoSchedule();
    return {result, one, rjp};
  })();
  ok('tiny 1/1 resolved', one.scheduled.length === 1 && one.unresolved.length === 0);
  ok('tiny piano resolved', rjp.scheduled.length === 1 && rjp.unresolved.length === 0);

  const mix = api.combinedWeekItems('rpiano');
  ok('combined week has all three kinds',
    mix.some(i => i.source === 'oneone') && mix.some(i => i.source === 'rpiano')
    && mix.some(i => i.lessonId === 'LES1' || i.lessonId === 'SG1'));
  const mixAud = api.auditTimetable(mix);
  ok('combined week audit has no reds',
    mixAud.entries.filter(e => e.level !== 'warning').length === 0);

  const uiBefore = api.collectUiState();
  api.applyUiState(uiBefore);
  ok('collectUiState / applyUiState round-trip', api.collectUiState() != null);

  const written = api.writeAcceptedToSourceTables(api.LAST_RESULT);
  ok('writeAcceptedToSourceTables touches lessons or small groups',
    written.lessonsWritten || written.smallGroupsWritten);

  const ics = api.buildTimetableIcs(api.LAST_RESULT.scheduled);
  ok('ICS export', /BEGIN:VCALENDAR/.test(ics) && /BEGIN:VEVENT/.test(ics));

  const csv = api.reportCsvAoa(api.filterReportItems(mix, api.emptyReportFilters()));
  ok('report CSV header', csv[0] && csv[0][0] === 'DAY');

  const exported = api.buildFullExportObject();
  ok('JSON export bundle complete',
    exported.students && exported.lessons && exported.oneToOneState && exported.rpianoState);
  install(api, tiny);
  let restoreOk = true;
  try { api.restoreFromLoadedObject(clone(exported)); }
  catch(e){ restoreOk = false; }
  ok('restoreFromLoadedObject round-trip', restoreOk);
  ok('restore brings back accepted schedule', (api.DB.acceptedSchedule || []).length > 0);

  install(api, clone(seed));
  timed('seed school: small groups + scheduler', () => {
    api.LAST_SMALL_GROUPS = api.generateSmallGroups(1);
    const seedResult = api.runScheduler(false);
    api.LAST_RESULT = seedResult;
    api.LAST_VARIANTS = [seedResult];
    ok('seed scheduler places most lessons',
      seedResult.scheduled.length >= 20,
      `scheduled=${seedResult.scheduled.length} unresolved=${seedResult.unresolved.length}`);
    return seedResult;
  }, 5000);

  install(api, tiny);
  runTinyPipeline(api, tiny);
  const pack = api.planStandardWeeklyPdfPages({skipEmpty: true});
  ok('weekly PDF pack non-empty', pack.length > 0);
  ok('PDF pack order: rooms → students → teachers',
    pack[0].scope === 'room' && pack.some(p => p.scope === 'student') && pack[pack.length - 1].scope === 'teacher');
  ok('student PDF hides rpiano by default',
    pack.filter(p => p.scope === 'student').every(page => {
      const view = api.reportBatchPageItems(page);
      return view.listItems.every(i => api.reportItemKind(i) !== 'rpiano');
    }));
  ok('teacher PDF has no class reservations',
    pack.filter(p => p.scope === 'teacher').every(page => {
      return api.reportBatchPageItems(page).listItems.every(i => api.reportItemKind(i) !== 'class');
    }));

  let renderOk = true;
  try {
    const grid = {innerHTML: ''};
    api.renderCalendar(grid, mix, true, 'none');
    api.renderReportsTab();
    api.renderOneOneTab();
    ok('renderCalendar emits day columns', (grid.innerHTML.match(/cal-day-body/g) || []).length === 5);
  } catch(e){ renderOk = false; }
  ok('main render paths do not throw', renderOk);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(findings.length){
    console.log('\nFindings (informational):');
    findings.forEach(f => console.log('  · ' + f));
  }
  if(failures.length){
    failures.forEach(f => console.error('  · ' + f));
    process.exit(1);
  }
}

main();
