#!/usr/bin/env node
// The four "do now" fixes: stable small group ids, Generate keep-vs-clear accepted,
// FIXED pin inventory, and that the test harness does not hang on autosave.

import { loadApp } from './load-app.mjs';
import { isSmallGroupId } from './invariants.mjs';

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

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();
  api.SCHEDULE_SEARCH_ATTEMPTS = 3;

  console.log('\n== stable small group ids survive delete / add ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(3);
  const idsAfterGenerate = api.LAST_SMALL_GROUPS.smallGroups.map(b => b.id);
  ok('fresh generate numbers SG1… in order',
    idsAfterGenerate.join(',') === 'SG1,SG2,SG3', idsAfterGenerate.join(','));
  ok('nextSmallGroupSeq is 4 after 3 small groups', api.LAST_SMALL_GROUPS.nextSmallGroupSeq === 4);

  const midId = api.LAST_SMALL_GROUPS.smallGroups[1].id;
  api.LAST_SMALL_GROUPS.smallGroups.splice(1, 1);
  ok('deleting the middle small group does not renumber the others',
    api.LAST_SMALL_GROUPS.smallGroups.map(b => b.id).join(',') === 'SG1,SG3');

  const minted = api.mintSmallGroupId(api.LAST_SMALL_GROUPS);
  api.LAST_SMALL_GROUPS.smallGroups.push({
    id: minted, bass:[], drum:[], acc:[], sol:[],
    teacherId:'', duration:90,
    fixedDay:'', fixedStart:'', fixedEnd:'',
    scheduledDay:'', scheduledStart:'', scheduledEnd:'',
    scheduledTeacherId:'', scheduledTeacher:''
  });
  ok('add after delete mints SG4, never reuses SG2', minted === 'SG4');
  ok('SG2 is gone from the roster', !api.LAST_SMALL_GROUPS.smallGroups.some(b => b.id === midId));

  const lessonIds = api.getSmallGroupLessons().map(l => l.id);
  ok('getSmallGroupLessons uses remaining ids, not array index',
    lessonIds.includes('SG1') && lessonIds.includes('SG3') && !lessonIds.includes('SG2'),
    lessonIds.join(','));

  console.log('\n== Accept follows the small group id, not the slot ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(4);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  const placedSmallGroup = result.scheduled.find(s => isSmallGroupId(s.lessonId));
  ok('scheduler placed a small group', !!placedSmallGroup, 'no SG* in scheduled');
  if(placedSmallGroup){
    const victim = api.LAST_SMALL_GROUPS.smallGroups.find(b => b.id === placedSmallGroup.lessonId);
    const others = api.LAST_SMALL_GROUPS.smallGroups.filter(b => b.id !== placedSmallGroup.lessonId);
    api.LAST_SMALL_GROUPS.smallGroups = others.concat(victim ? [victim] : []);
    api.writeAcceptedToSourceTables(result);
    const written = api.LAST_SMALL_GROUPS.smallGroups.find(b => b.id === placedSmallGroup.lessonId);
    ok('SCHEDULED lands on the same small group id after reorder',
      written && written.scheduledDay === placedSmallGroup.day,
      written ? `${written.id} ${written.scheduledDay}` : 'missing small group');
    const byId = new Map(result.scheduled
      .filter(s => isSmallGroupId(s.lessonId))
      .map(s => [s.lessonId, s]));
    const mismatches = api.LAST_SMALL_GROUPS.smallGroups.filter(b => {
      const item = byId.get(b.id);
      if(item) return b.scheduledDay !== item.day;
      return !!b.scheduledDay;
    });
    ok('every small group SCHEDULED slot matches its own id, not its list index',
      mismatches.length === 0, mismatches.map(b => b.id).join(','));
  }

  console.log('\n== old JSON without ids still maps SG1 to index 0 ==');
  api.LAST_SMALL_GROUPS = {
    smallGroups: [
      {bass:[{ID:'S1', NAME1:'A', NAME2:'A'}], drum:[], acc:[], sol:[], teacherId:'', duration:90},
      {bass:[], drum:[{ID:'S2', NAME1:'B', NAME2:'B'}], acc:[], sol:[], teacherId:'', duration:90},
    ]
  };
  api.ensureSmallGroupIdentities(api.LAST_SMALL_GROUPS);
  ok('legacy small groups get SG1, SG2',
    api.LAST_SMALL_GROUPS.smallGroups.map(b => b.id).join(',') === 'SG1,SG2');
  ok('findSmallGroupById(SG2) is the drum small group',
    api.findSmallGroupById('SG2') && api.findSmallGroupById('SG2').drum[0].ID === 'S2');

  console.log('\n== Generate keep vs clear accepted ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  const first = api.runScheduler(false);
  api.LAST_RESULT = first;
  api.LAST_VARIANTS = [first];
  first.accepted = true;
  api.DB.acceptedSchedule = api.buildAcceptedScheduleRows(first);
  api.writeAcceptedToSourceTables(first);
  ok('hasAcceptedRecord is true after Accept', api.hasAcceptedRecord());
  ok('Accept button is in the accepted state', api.LAST_RESULT.accepted === true);
  const scheduledBefore = (api.DB.lessons || []).filter(l => l.scheduledDay).length;
  ok('SCHEDULED cells exist before keep-generate', scheduledBefore > 0);

  api.runGenerateTimetable(false);
  ok('keep-generate leaves SCHEDULED cells',
    (api.DB.lessons || []).filter(l => l.scheduledDay).length === scheduledBefore);
  ok('keep-generate leaves accepted table',
    (api.DB.acceptedSchedule || []).length > 0);
  ok('keep-generate re-opens Accept on the new grid',
    api.LAST_RESULT && api.LAST_RESULT.accepted === false);

  api.runGenerateTimetable(true);
  ok('clear-generate empties SCHEDULED cells',
    (api.DB.lessons || []).every(l => !l.scheduledDay));
  ok('clear-generate empties accepted table',
    !(api.DB.acceptedSchedule && api.DB.acceptedSchedule.length));
  ok('hasAcceptedRecord is false after clear-generate', !api.hasAcceptedRecord());

  console.log('\n== Generate small groups keep vs clear accepted ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  const smallGroupFirst = api.runScheduler(false);
  api.LAST_RESULT = smallGroupFirst;
  api.LAST_VARIANTS = [smallGroupFirst];
  api.DB.acceptedSchedule = api.buildAcceptedScheduleRows(smallGroupFirst);
  api.DB.acceptedTimetable = {acceptedAt: '2026-08-25T00:00:00.000Z'};
  api.writeAcceptedToSourceTables(smallGroupFirst);
  const acceptedN = (api.DB.acceptedSchedule || []).length;
  const lessonSchedN = (api.DB.lessons || []).filter(l => l.scheduledDay).length;
  ok('accepted is on file before small group generate', api.hasAcceptedRecord() && acceptedN > 0);

  api.runGenerateSmallGroups(false, 16);
  ok('keep-small group-generate leaves accepted table',
    (api.DB.acceptedSchedule || []).length === acceptedN);
  ok('keep-small group-generate leaves lesson SCHEDULED cells',
    (api.DB.lessons || []).filter(l => l.scheduledDay).length === lessonSchedN);
  ok('keep-small group-generate clears the timetable grid',
    api.LAST_RESULT == null && !(api.LAST_VARIANTS && api.LAST_VARIANTS.length));
  ok('keep-small group-generate still produced a new roster',
    !!(api.LAST_SMALL_GROUPS && api.LAST_SMALL_GROUPS.smallGroups && api.LAST_SMALL_GROUPS.smallGroups.length));

  api.runGenerateSmallGroups(true, 16);
  ok('clear-small group-generate empties accepted table',
    !(api.DB.acceptedSchedule && api.DB.acceptedSchedule.length));
  ok('clear-small group-generate empties lesson SCHEDULED cells',
    (api.DB.lessons || []).every(l => !l.scheduledDay));
  ok('hasAcceptedRecord is false after clear-small group-generate', !api.hasAcceptedRecord());

  console.log('\n== Generate small groups always asks first ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  const rosterBefore = api.LAST_SMALL_GROUPS.smallGroups.map(b => b.id).join(',');
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  ok('no accepted timetable before the confirm', !api.hasAcceptedRecord());
  api.requestGenerateSmallGroups();
  ok('confirm opens even without a generated timetable', api.isGenerateConfirmOpen());
  const sgUi = api.generateConfirmUi();
  ok('title asks to replace small groups', /small groups/i.test(sgUi.title), sgUi.title);
  ok('body warns that current bands are deleted', /band/i.test(sgUi.body), sgUi.body);
  ok('keep-accepted is hidden when nothing is accepted', sgUi.keepDisplay === 'none');
  ok('clear-accepted is hidden when nothing is accepted', sgUi.clearDisplay === 'none');
  ok('Generate button is shown instead', sgUi.goDisplay !== 'none');
  api.hideGenerateConfirm();
  ok('cancel closes without generating', !api.isGenerateConfirmOpen());
  ok('roster is unchanged after cancel',
    api.LAST_SMALL_GROUPS.smallGroups.map(b => b.id).join(',') === rosterBefore);

  api.LAST_RESULT = api.runScheduler(false);
  api.LAST_VARIANTS = [api.LAST_RESULT];
  api.acceptTimetableSchedule();
  ok('accepted record is on file for keep/clear', api.hasAcceptedRecord());
  api.requestGenerateSmallGroups();
  ok('confirm still opens with accepted on file', api.isGenerateConfirmOpen());
  const sgUiAccepted = api.generateConfirmUi();
  ok('keep-accepted is shown when accepted exists', sgUiAccepted.keepDisplay !== 'none');
  ok('clear-accepted is shown when accepted exists', sgUiAccepted.clearDisplay !== 'none');
  ok('plain Generate is hidden when accepted exists', sgUiAccepted.goDisplay === 'none');
  ok('accepted body still warns bands are deleted', /band/i.test(sgUiAccepted.body), sgUiAccepted.body);
  api.hideGenerateConfirm();

  console.log('\n== FIXED pins inventory ==');
  const pin = (api.DB.lessons || []).find(l => !l.fixedDay);
  pin.fixedDay = 'MON';
  pin.fixedStart = '10:00';
  pin.fixedEnd = '11:30';
  api.LAST_SMALL_GROUPS.smallGroups[0].fixedDay = 'TUE';
  api.LAST_SMALL_GROUPS.smallGroups[0].fixedStart = '14:00';
  api.LAST_SMALL_GROUPS.smallGroups[0].fixedEnd = '15:30';
  const pins = api.collectFixedPins();
  ok('collectFixedPins sees the lesson pin', pins.lessons.some(l => l.id === pin.id));
  ok('collectFixedPins sees the small group pin', pins.smallGroups.length >= 1);
  api.clearAllFixedPins();
  const after = api.collectFixedPins();
  ok('clearAllFixedPins empties lesson FIXED', after.lessons.length === 0);
  ok('clearAllFixedPins empties small group FIXED', after.smallGroups.length === 0);
  ok('lesson teacherId survived clearing FIXED',
    pin.teacherId && pin.fixedDay === '');

  console.log('\n== Generate after drag replaces the grid ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  api.runGenerateTimetable(false);
  const laid = api.LAST_RESULT;
  ok('first generate produced a layout', !!(laid && laid.scheduled.length));
  const victim = laid.scheduled[0];
  const home = {day: victim.day, start: victim.start, end: victim.end, lessonId: victim.lessonId};
  const dragDay = home.day === 'MON' ? 'FRI' : 'MON';
  const dragStart = 16 * 60;
  api.ensureDragBaseline(laid);
  victim.day = dragDay;
  victim.start = dragStart;
  victim.end = dragStart + (home.end - home.start);
  laid.dragUndo.push({
    lessonId: home.lessonId,
    from: {day: home.day, start: home.start, end: home.end},
    to: {day: dragDay, start: dragStart, end: victim.end}
  });
  ok('drag is flagged as unaccepted', api.hasUnacceptedDrags());
  api.runGenerateTimetable(false);
  ok('generate produced a layout', !!(api.LAST_RESULT && api.LAST_RESULT.scheduled.length));
  ok('drag undo is cleared after generate',
    !(api.LAST_RESULT.dragUndo && api.LAST_RESULT.dragUndo.length));
  const again = api.LAST_RESULT.scheduled.find(s => s.lessonId === home.lessonId);
  ok('the dragged slot did not stick as the generate result',
    !again || again.day !== dragDay || again.start !== dragStart,
    again ? `${again.day} ${again.start}` : 'lesson missing');
  const poolHasDrag = (api.LAST_VARIANTS || []).some(v =>
    (v.scheduled || []).some(s => s.lessonId === home.lessonId && s.day === dragDay && s.start === dragStart));
  ok('the solution pool dropped the dragged layout', !poolHasDrag);

  console.log('\n== Generate after Accept of a drag cannot get worse ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  api.runGenerateTimetable(false);
  const acceptedDrag = api.LAST_RESULT;
  const accVictim = acceptedDrag.scheduled[0];
  const accHome = {day: accVictim.day, start: accVictim.start, end: accVictim.end, lessonId: accVictim.lessonId};
  const accDay = accHome.day === 'MON' ? 'FRI' : 'MON';
  const accStart = 16 * 60;
  api.ensureDragBaseline(acceptedDrag);
  accVictim.day = accDay;
  accVictim.start = accStart;
  accVictim.end = accStart + (accHome.end - accHome.start);
  acceptedDrag.dragUndo.push({
    lessonId: accHome.lessonId,
    from: {day: accHome.day, start: accHome.start, end: accHome.end},
    to: {day: accDay, start: accStart, end: accVictim.end}
  });
  api.acceptTimetableSchedule();
  ok('Accept stored the dragged slot',
    (api.DB.acceptedSchedule || []).some(r =>
      r.lessonId === accHome.lessonId && r.day === accDay && api.toMin(r.start) === accStart));
  ok('Accept cleared unaccepted-drag flag', !api.hasUnacceptedDrags());
  const acceptedLeft = ((acceptedDrag.unresolved) || []).length;
  const acceptedSig = api.resultSignature(acceptedDrag);
  api.runGenerateTimetable(false);
  ok('keep-generate still has the accepted table',
    (api.DB.acceptedSchedule || []).some(r => r.lessonId === accHome.lessonId && r.day === accDay));
  ok('keep-generate still has a painted layout', !!(api.LAST_RESULT && api.LAST_RESULT.scheduled.length));
  ok('keep-generate does not paint more leftover items than the accepted week',
    ((api.LAST_RESULT.unresolved) || []).length <= acceptedLeft);
  ok('the accepted week stays in the pool unless a better leftover count replaced it',
    (api.LAST_VARIANTS || []).some(v => api.resultSignature(v) === acceptedSig)
    || ((api.LAST_VARIANTS[0].unresolved) || []).length < acceptedLeft);

  console.log('\n== Generate confirm stays reachable after teacher-view redraws ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  api.LAST_RESULT = api.runScheduler(false);
  api.acceptTimetableSchedule();
  ok('accepted record is on file', api.hasAcceptedRecord());
  api.CAL_DRAG = {
    active: true,
    pointerId: 1,
    block: null,
    container: null,
    hover: null,
    dayBodies: [],
    lessonId: 'L1'
  };
  api.requestGenerateTimetable();
  ok('in-flight calendar drag is aborted before the confirm', api.CAL_DRAG == null);
  ok('keep/clear popup opens instead of a silent generate', api.isGenerateConfirmOpen());
  api.hideGenerateConfirm();
  ok('cancel closes the popup', !api.isGenerateConfirmOpen());

  console.log('\n== autosave restores on a simulated reload ==');
  const store = new Map();
  const session = loadApp({store});
  session.api.DB.students = [{id:'ST-RELOAD', name:'Reload Teszt', CLASS_ID:'', INSTR_ID:''}];
  session.api.LAST_SMALL_GROUPS = {
    smallGroups: [{
      id:'SG-RELOAD', bass:[], drum:[], acc:[], sol:[],
      teacherId:'', duration:90,
      fixedDay:'', fixedStart:'', fixedEnd:'',
      scheduledDay:'', scheduledStart:'', scheduledEnd:'',
      scheduledTeacherId:'', scheduledTeacher:''
    }],
    excluded: [],
    nextSmallGroupSeq: 2
  };
  store.set(session.api.AUTOSAVE_KEY, JSON.stringify(session.api.buildFullExportObject()));
  store.set(session.api.AUTOSAVE_META_KEY, JSON.stringify({savedAt:'2026-08-27T07:00:00.000Z', dirty:true}));

  const reloaded = loadApp({store});
  ok('reload restores students from autosave',
    (reloaded.api.DB.students || []).some(s => s.id === 'ST-RELOAD'),
    (reloaded.api.DB.students || []).map(s => s.id).join(',') || 'none');
  ok('reload restores small groups from autosave',
    !!(reloaded.api.LAST_SMALL_GROUPS && reloaded.api.LAST_SMALL_GROUPS.smallGroups.some(b => b.id === 'SG-RELOAD')));
  ok('fresh load with empty storage keeps the harness seed', (() => {
    const fresh = loadApp();
    const ids = (fresh.api.DB.students || []).map(s => s.id);
    return ids.length > 0 && !ids.includes('ST-RELOAD');
  })());

  const broken = new Map();
  broken.set(session.api.AUTOSAVE_KEY, '{not-json');
  const recovered = loadApp({store: broken});
  ok('corrupt autosave falls back to seed instead of crashing',
    (recovered.api.DB.students || []).length > 0 &&
    !(recovered.api.DB.students || []).some(s => s.id === 'ST-RELOAD'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failed){
    console.error('\nFailed checks:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('Do-now fixes look solid.');
}

main();
