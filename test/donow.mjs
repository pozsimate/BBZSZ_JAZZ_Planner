#!/usr/bin/env node
// The four "do now" fixes: stable band ids, Generate keep-vs-clear accepted,
// FIXED pin inventory, and that the test harness does not hang on autosave.

import { loadApp } from './load-app.mjs';

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

  console.log('\n== stable band ids survive delete / add ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(3);
  const idsAfterGenerate = api.LAST_BANDS.bands.map(b => b.id);
  ok('fresh generate numbers BAND1… in order',
    idsAfterGenerate.join(',') === 'BAND1,BAND2,BAND3', idsAfterGenerate.join(','));
  ok('nextBandSeq is 4 after 3 bands', api.LAST_BANDS.nextBandSeq === 4);

  const midId = api.LAST_BANDS.bands[1].id;
  api.LAST_BANDS.bands.splice(1, 1);
  ok('deleting the middle band does not renumber the others',
    api.LAST_BANDS.bands.map(b => b.id).join(',') === 'BAND1,BAND3');

  const minted = api.mintBandId(api.LAST_BANDS);
  api.LAST_BANDS.bands.push({
    id: minted, bass:[], drum:[], acc:[], sol:[],
    teacherId:'', room321:true, duration:90,
    fixedDay:'', fixedStart:'', fixedEnd:'',
    scheduledDay:'', scheduledStart:'', scheduledEnd:'',
    scheduledTeacherId:'', scheduledTeacher:''
  });
  ok('add after delete mints BAND4, never reuses BAND2', minted === 'BAND4');
  ok('BAND2 is gone from the roster', !api.LAST_BANDS.bands.some(b => b.id === midId));

  const lessonIds = api.getBandLessons().map(l => l.id);
  ok('getBandLessons uses remaining ids, not array index',
    lessonIds.includes('BAND1') && lessonIds.includes('BAND3') && !lessonIds.includes('BAND2'),
    lessonIds.join(','));

  console.log('\n== Accept follows the band id, not the slot ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(4);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  const placedBand = result.scheduled.find(s => String(s.lessonId).startsWith('BAND'));
  ok('scheduler placed a band', !!placedBand, 'no BAND* in scheduled');
  if(placedBand){
    const victim = api.LAST_BANDS.bands.find(b => b.id === placedBand.lessonId);
    const others = api.LAST_BANDS.bands.filter(b => b.id !== placedBand.lessonId);
    api.LAST_BANDS.bands = others.concat(victim ? [victim] : []);
    api.writeAcceptedToSourceTables(result);
    const written = api.LAST_BANDS.bands.find(b => b.id === placedBand.lessonId);
    ok('SCHEDULED lands on the same band id after reorder',
      written && written.scheduledDay === placedBand.day,
      written ? `${written.id} ${written.scheduledDay}` : 'missing band');
    const byId = new Map(result.scheduled
      .filter(s => String(s.lessonId).startsWith('BAND'))
      .map(s => [s.lessonId, s]));
    const mismatches = api.LAST_BANDS.bands.filter(b => {
      const item = byId.get(b.id);
      if(item) return b.scheduledDay !== item.day;
      return !!b.scheduledDay;
    });
    ok('every band SCHEDULED slot matches its own id, not its list index',
      mismatches.length === 0, mismatches.map(b => b.id).join(','));
  }

  console.log('\n== old JSON without ids still maps BAND1 to index 0 ==');
  api.LAST_BANDS = {
    bands: [
      {bass:[{ID:'S1', NAME1:'A', NAME2:'A'}], drum:[], acc:[], sol:[], teacherId:'', duration:90, room321:true},
      {bass:[], drum:[{ID:'S2', NAME1:'B', NAME2:'B'}], acc:[], sol:[], teacherId:'', duration:90, room321:true},
    ]
  };
  api.ensureBandIdentities(api.LAST_BANDS);
  ok('legacy bands get BAND1, BAND2',
    api.LAST_BANDS.bands.map(b => b.id).join(',') === 'BAND1,BAND2');
  ok('findBandById(BAND2) is the drum band',
    api.findBandById('BAND2') && api.findBandById('BAND2').drum[0].ID === 'S2');

  console.log('\n== Generate keep vs clear accepted ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(16);
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

  console.log('\n== Generate bands keep vs clear accepted ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(16);
  const bandFirst = api.runScheduler(false);
  api.LAST_RESULT = bandFirst;
  api.LAST_VARIANTS = [bandFirst];
  api.DB.acceptedSchedule = api.buildAcceptedScheduleRows(bandFirst);
  api.DB.acceptedTimetable = {acceptedAt: '2026-08-25T00:00:00.000Z'};
  api.writeAcceptedToSourceTables(bandFirst);
  const acceptedN = (api.DB.acceptedSchedule || []).length;
  const lessonSchedN = (api.DB.lessons || []).filter(l => l.scheduledDay).length;
  ok('accepted is on file before band generate', api.hasAcceptedRecord() && acceptedN > 0);

  api.runGenerateBands(false, 16);
  ok('keep-band-generate leaves accepted table',
    (api.DB.acceptedSchedule || []).length === acceptedN);
  ok('keep-band-generate leaves lesson SCHEDULED cells',
    (api.DB.lessons || []).filter(l => l.scheduledDay).length === lessonSchedN);
  ok('keep-band-generate clears the timetable grid',
    api.LAST_RESULT == null && !(api.LAST_VARIANTS && api.LAST_VARIANTS.length));
  ok('keep-band-generate still produced a new roster',
    !!(api.LAST_BANDS && api.LAST_BANDS.bands && api.LAST_BANDS.bands.length));

  api.runGenerateBands(true, 16);
  ok('clear-band-generate empties accepted table',
    !(api.DB.acceptedSchedule && api.DB.acceptedSchedule.length));
  ok('clear-band-generate empties lesson SCHEDULED cells',
    (api.DB.lessons || []).every(l => !l.scheduledDay));
  ok('hasAcceptedRecord is false after clear-band-generate', !api.hasAcceptedRecord());

  console.log('\n== FIXED pins inventory ==');
  const pin = (api.DB.lessons || []).find(l => !l.fixedDay);
  pin.fixedDay = 'MON';
  pin.fixedStart = '10:00';
  pin.fixedEnd = '11:30';
  api.LAST_BANDS.bands[0].fixedDay = 'TUE';
  api.LAST_BANDS.bands[0].fixedStart = '14:00';
  api.LAST_BANDS.bands[0].fixedEnd = '15:30';
  const pins = api.collectFixedPins();
  ok('collectFixedPins sees the lesson pin', pins.lessons.some(l => l.id === pin.id));
  ok('collectFixedPins sees the band pin', pins.bands.length >= 1);
  api.clearAllFixedPins();
  const after = api.collectFixedPins();
  ok('clearAllFixedPins empties lesson FIXED', after.lessons.length === 0);
  ok('clearAllFixedPins empties band FIXED', after.bands.length === 0);
  ok('lesson teacherId survived clearing FIXED',
    pin.teacherId && pin.fixedDay === '');

  console.log('\n== Generate after drag replaces the grid ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(16);
  const laid = api.runScheduler(false);
  api.LAST_RESULT = laid;
  api.LAST_VARIANTS = [laid];
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

  console.log('\n== Generate confirm stays reachable after teacher-view redraws ==');
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(16);
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failed){
    console.error('\nFailed checks:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('Do-now fixes look solid.');
}

main();
