import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function dummyEl(){
  const el = {
    id: '',
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    style: {},
    classList: { add(){}, remove(){}, toggle(){ return false; }, contains(){ return false; } },
    dataset: {},
    options: [],
    files: [],
    parentNode: null,
    nextElementSibling: null,
    addEventListener(){},
    removeEventListener(){},
    appendChild(){ return el; },
    removeChild(){ return el; },
    click(){},
    focus(){},
    querySelector(){ return dummyEl(); },
    querySelectorAll(){ return []; },
    setAttribute(){},
    getAttribute(){ return null; },
    removeAttribute(){},
  };
  return el;
}

export function loadApp(opts = {}){
  const seedPath = path.join(ROOT, 'public/seed-data.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const els = {};
  const store = opts.store instanceof Map ? opts.store : new Map();

  const document = {
    getElementById(id){
      if(id === 'seed-data') return { textContent: JSON.stringify(seed) };
      if(!els[id]){
        els[id] = dummyEl();
        els[id].id = id;
      }
      return els[id];
    },
    querySelector(){ return dummyEl(); },
    querySelectorAll(){ return []; },
    createElement(){ return dummyEl(); },
    addEventListener(){},
    removeEventListener(){},
    body: dummyEl(),
  };

  const sandbox = {
    console,
    document,
    window: {
      innerWidth: 1280, innerHeight: 800, document,
      addEventListener(){},
      removeEventListener(){},
      __BJP_HARNESS: true,
    },
    localStorage: {
      getItem(key){ return store.has(key) ? store.get(key) : null; },
      setItem(key, value){ store.set(String(key), String(value)); },
      removeItem(key){ store.delete(key); },
    },
    alert(){},
    confirm(){ return true; },
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('fetch disabled in harness'); },
    URL: { createObjectURL(){ return ''; }, revokeObjectURL(){} },
    Blob: class {},
    FileReader: class { readAsText(){} },
    JSON, Math, Date, parseInt, parseFloat, isNaN, Infinity, NaN,
    Array, Object, Map, Set, String, Number, Boolean, Error, TypeError, RegExp, Promise,
    structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__BJP__ = {\n  get DB(){ return DB; },\n  set DB(v){ DB = v; },\n  get LAST_SMALL_GROUPS(){ return LAST_SMALL_GROUPS; },\n  set LAST_SMALL_GROUPS(v){ LAST_SMALL_GROUPS = v; },\n  get LAST_RESULT(){ return LAST_RESULT; },\n  set LAST_RESULT(v){ LAST_RESULT = v; },\n  get LAST_VARIANTS(){ return LAST_VARIANTS; },\n  set LAST_VARIANTS(v){ LAST_VARIANTS = v; },\n  get LAST_AUDIT(){ return LAST_AUDIT; },\n  set LAST_AUDIT(v){ LAST_AUDIT = v; },\n  get CAL_DRAG(){ return CAL_DRAG; },\n  set CAL_DRAG(v){ CAL_DRAG = v; },\n  runScheduler,\n  isSmallGroupId,\n  generateSmallGroups,\n  runGenerateSmallGroups,\n  renderSmallGroupCard,\n  setSmallGroupStudentMembership,\n  smallGroupContainsStudent,\n  smallGroupRoleForStudent,\n  SearchLog,\n  DAYS,\n  DAY_LABEL,\n  DEFAULT_START,\n  DEFAULT_END,\n  CAL_DAY_START,\n  CAL_DAY_END,\n  CAL_PX_PER_MIN,\n  CAL_SNAP_MIN,\n  inferHeaders,\n  sheetsTablesToDb,\n  rowGet,\n  sheetLooksLike,\n  dbToDriveTables,\n  driveTablesToAoa,\n  DRIVE_EXPORT_SPECS,\n  buildTimetableIcs,\n  calendarEventTitle,\n  auditTimetable,\n  snapMinutes,\n  clampLessonStart,\n  startFromPointerY,\n  hitCalendarDay,\n  scheduledItemById,\n  studentsForScheduledItem,\n  scheduledItemIsPinned,\n  teacherDayWindows,\n  teacherBreakSettings,\n  teacherWindowClash,\n  normalizeAvailScope,\n  SCOPE_OPTIONS,\n  availKindForItem,\n  studentReservationClash,\n  buildFullExportObject,\n  renderCalendar,\n  itemHasConflict,\n  toHHMM,\n  toMin,\n  getSmallGroupLessons,\n  endCalendarDrag,\n  abortCalendarInteraction,\n  requestGenerateTimetable,\n  requestGenerateSmallGroups,\n  showGenerateConfirm,\n  hideGenerateConfirm,\n  isGenerateConfirmOpen,\n  generateConfirmUi(){\n    const displayOf = id => {\n      const el = document.getElementById(id);\n      return el && el.style ? el.style.display : '';\n    };\n    return {\n      title: (document.getElementById('generateConfirmTitle') || {}).textContent || '',\n      body: (document.getElementById('generateConfirmBody') || {}).textContent || '',\n      keepDisplay: displayOf('generateKeepAcceptedBtn'),\n      clearDisplay: displayOf('generateClearAcceptedBtn'),\n      goDisplay: displayOf('generateConfirmGoBtn')\n    };\n  },\n  undoLastDrag,\n  resetVariantDrags,\n  ensureDragBaseline,\n  cloneLessonSlots,\n  computeScheduleFingerprint,\n  buildAcceptedScheduleRows,\n  writeAcceptedToSourceTables,\n  clearAcceptedScheduledRecord,\n  ensureSmallGroupIdentities,\n  mintSmallGroupId,\n  findSmallGroupById,\n  hasAcceptedRecord,\n  hasUnacceptedDrags,\n  runGenerateTimetable,\n  discardVariantDragEdits,\n  collectFixedPins,\n  clearAllFixedPins,\n  smallGroupShortLabel,\n  get LAST_ONEONE(){ return LAST_ONEONE; },\n  set LAST_ONEONE(v){ LAST_ONEONE = v; },\n  scheduleOneToOne,\n  scheduleAllOneToOne,\n  scheduleAllOneToOneSearch,\n  scheduleAllOneToOneSearchAsync,\n  generateIndividualScopedAsync,\n  attachOneOneLookaheadAsync,\n  oneOneResultLogLine,\n  get ONEONE_SEARCH_ATTEMPTS(){ return ONEONE_SEARCH_ATTEMPTS; },\n  set ONEONE_SEARCH_ATTEMPTS(v){ ONEONE_SEARCH_ATTEMPTS = clampOneOneSearchAttempts(v); },\n  get RPIANO_SEARCH_ATTEMPTS(){ return RPIANO_SEARCH_ATTEMPTS; },\n  set RPIANO_SEARCH_ATTEMPTS(v){ RPIANO_SEARCH_ATTEMPTS = clampOneOneSearchAttempts(v); },\n  clampOneOneSearchAttempts,\n  readOneOneSearchAttempts,\n  oneOneSearchMaxTries,\n  ONEONE_SEARCH_ATTEMPTS_MAX,\n  collectUiState,\n  applyUiState,\n  classFreeGaps,\n  studentsFreeIntervals,\n  classWindow,\n  updateOneOneTabLock,\n  renderOneOneTab,\n  parseOneOneHours,\n  oneOneHoursToMinutes,\n  parseOneToOneTable,\n  collectOneOneAssignments,\n  teacherMatrixRoom,\n  studentMatrixRoom,\n  mergeMatrixColumnRooms,\n  setMatrixTeacherRoom,\n  setMatrixStudentRoom,\n  oneToOneAoa,\n  rpianoAoa,\n  busyRowsFromScheduled,\n  hasAcceptedOneOne,\n  acceptOneOneSchedule,\n  hasAcceptedRpiano,\n  acceptRpianoSchedule,\n  individualAcceptedRows,\n  ACCEPTED_SCHEDULE_CSV_HEADERS,\n  individualTeacherIds,\n  timetableAuditItems,\n  frozenIndividualItems,\n  generatedIndividualItems,\n  combinedWeekItems,\n  acceptedGroupItems,\n  undoIndividualDrag,\n  acceptTimetableSchedule,\n  markLayoutNeedsAccept,\n  get LAST_RPIANO(){ return LAST_RPIANO; },\n  set LAST_RPIANO(v){ LAST_RPIANO = v; },\n  sheetLooksLike,\n  parseGvizTable,\n  parseSpreadsheetId,\n  SHEET_ALIASES,\n  DEFAULT_SHEETS_URL,\n  GROUP_NAME_FIELDS,\n  cleanCellText,\n  resultSignature,\n  mergeGenerateVariants,\n  resultScore,\n  compareScoreTuple,\n  leftoverOneOneHoleMinutes,\n  promoteTopKRandom,\n  restoreFromLoadedObject,\n  restoreAutosaveIfAny,\n  AUTOSAVE_KEY,\n  AUTOSAVE_META_KEY,\n  hasAcceptedRecord,\n  runSchedulerSearchAll,\n  get SCHEDULE_SEARCH_ATTEMPTS(){ return SCHEDULE_SEARCH_ATTEMPTS; },\n  set SCHEDULE_SEARCH_ATTEMPTS(v){ SCHEDULE_SEARCH_ATTEMPTS = v; },\n  clampScheduleSearchAttempts,\n  readScheduleSearchAttempts,\n  isDeepScheduleSearch,\n  beginScheduleSearch,\n  recordScheduleAttempt,\n  finishScheduleSearch,\n  requestCancelSearch,\n  resetSearchCancel,\n  isSearchCancelled,\n  DEEP_SEARCH_AFTER,\n  SCHEDULE_SEARCH_ATTEMPTS_MAX,\n  SCHEDULE_VARIANT_KEEP,\n  runGenerateTimetable,\n  applyIndividualSearch,\n  generateIndividualScoped,\n  assignmentsForGenerate,\n  cloneIndividualKeep,\n  mergeKeptIntoVariants,\n  selectIndividualVariant,\n  busyRowsFromScheduled,\n  individualAcceptedRows,\n  hasAcceptedOneOne,\n  hasAcceptedRpiano,\n  acceptTimetableSchedule,\n  acceptOneOneSchedule,\n  acceptRpianoSchedule,\n  markLayoutNeedsAccept,\n  combinedWeekItems,\n  timetableAuditItems,\n  frozenIndividualItems,\n  generatedIndividualItems,\n  acceptedGroupItems,\n  studentsForScheduledItem,\n  collectOneOneAssignments,\n  oneToOneAoa,\n  rpianoAoa,\n  driveTablesToAoa,\n  dbToDriveTables,\n  buildTimetableIcs,\n  buildFullExportObject,\n  writeAcceptedToSourceTables,\n  clearAcceptedScheduledRecord,\n  generateSmallGroups,\n  auditTimetable,\n  overlappingClassReservation,\n  studentsInGroup,\n  lessonStudents,\n  breakUnitsForGap,\n  muclassDistance,\n  matchSheetKey,\n  parseIdList,\n  icsEscape,\n  clampBookedWindowToDuration,\n  formatOneOneHours,\n  setOneOneHours,\n  setRpianoHours,\n  applyLessonSlots,\n  lessonSlotsMatch,\n  snapUpMin,\n  snapDownMin,\n  candidateStartsForInterval,\n  acceptedBusyMaps,\n  lessonDurationMinutes,\n  subtractBusyFromIntervals,\n  intervalGapScore,\n  scheduledIdleGapMinutes,\n  oneOneResultScore,\n  oneOneSplitPlans,\n  oneOneHalves,\n  oneOneCoverageCount,\n  oneOneAvgDayStartMinutes,\n  shuffleWithinGroups,\n  compareOneOneResults,\n  attachGroupLookahead,\n  attachOneOneLookahead,\n  markSuggestedByLookahead,\n  formatLookaheadLabel,\n  groupLookaheadScore,\n  oneOneLookaheadScore,\n  attachOneOneLayoutScore,\n  collectFixedPins,\n  clearAllFixedPins,\n  computeScheduleFingerprint,\n  resultSignature,\n  calendarEventTitle,\n  individualTeacherIds,\n  individualAcceptedRows,\n  hasUnacceptedDrags,\n  getSmallGroupLessons,\n  mintSmallGroupId,\n  ensureSmallGroupIdentities,\n  findSmallGroupById,\n  smallGroupShortLabel,\n  snapMinutes,\n  clampLessonStart,\n  parseSpreadsheetId,\n  inferHeaders,\n  rowGet,\n  sheetLooksLike,\n  classWindow,\n  classFreeGaps,\n  teacherDayWindows,\n  teacherBreakSettings,\n  teacherWindowClash,\n  normalizeAvailScope,\n  SCOPE_OPTIONS,\n  availKindForItem,\n  studentReservationClash,\n  toMin,\n  toHHMM,\n  DAYS,\n  DEFAULT_START,\n  DEFAULT_END,\n  CAL_SNAP_MIN,\n  get ONEONE_SEARCH_ATTEMPTS(){ return ONEONE_SEARCH_ATTEMPTS; },\n  set ONEONE_SEARCH_ATTEMPTS(v){ ONEONE_SEARCH_ATTEMPTS = clampOneOneSearchAttempts(v); },\n  hasPendingAccept,\n  pendingAcceptTab,\n  canSwitchTab,\n  setSearchUiLock,\n  isSearchUiLocked,\n  layoutNeedsAccept,\n  isTimetableAccepted,\n  canOpenOneOne,\n  canOpenRpiano,\n  canOpenReports,\n  emptyPlannerDb,\n  dbLooksEmpty,\n  ACCEPTED_SCHEDULE_CSV_HEADERS,\n  SMALL_GROUPS_CSV_HEADERS,\n  smallGroupsCsvAoa,\n  parseSmallGroupsTable,\n  reportWeekItems,\n  reportItemKind,\n  reportKindLabel,\n  reportItemMatches,\n  filterReportItems,\n  emptyReportFilters,\n  reportCsvAoa,\n  renderReportsTab,\n  classReservationItems,\n  reportClassReservationItems,\n  mergeClassReservationItems,\n  openSearchLive,\n  closeSearchLive,\n  searchLiveSay,\n  isSearchLiveOpen,\n  formatSearchLiveEta,\n  forbidUnlistedGroupGapsEnabled,\n  lookaheadEveryLayoutEnabled,\n  keepLookaheadBestVariants,
  teacherSwapProbeEnabled,
  collectSwappableGroupLessons,
  collectTeacherSwapCandidates,
  collectTeacherSwapSuggestions,
  collectTeacherSwapSuggestionsForLayouts,
  withLessonTeacherSwaps,
  matchLessonsByDuration,
  describeTeacherSwap,
  evaluateHypotheticalTeacherSwap,\n  teacherSwapSearchAttempts,\n  dayLessonNeighbors,\n  holePullsTowardEnd,\n  collectPhase1TeacherIds,\n  automaticPhase1TeacherOrder,\n  resolvePhase1TeacherOrder,\n  hasManualPhase1TeacherOrder,\n  normalizePhase1TeacherOrder,\n  setManualPhase1TeacherOrder,\n  clearManualPhase1TeacherOrder,\n  get REPORT_FILTERS(){ return REPORT_FILTERS; },\n  set REPORT_FILTERS(v){ REPORT_FILTERS = v; }\n};`, sandbox, { filename: 'src/app.js' });

  if(!sandbox.__BJP__ || typeof sandbox.__BJP__.runScheduler !== 'function'){
    throw new Error('Failed to load scheduler from src/app.js');
  }
  return { api: sandbox.__BJP__, seed, root: ROOT, store };
}
