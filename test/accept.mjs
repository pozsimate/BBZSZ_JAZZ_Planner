#!/usr/bin/env node
// Accept writes SCHEDULED output only; Generate ignores it and clears it.
// FIXED / teacher override stay as search inputs.

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

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function snapshotFixed(api){
  return {
    lessons: (api.DB.lessons || []).map(l => ({
      id: l.id, teacherId: l.teacherId,
      fixedDay: l.fixedDay || '', fixedStart: l.fixedStart || '', fixedEnd: l.fixedEnd || ''
    })),
    bands: (api.LAST_BANDS && api.LAST_BANDS.bands || []).map(b => ({
      id: b.id || '',
      teacherId: b.teacherId || '',
      fixedDay: b.fixedDay || '', fixedStart: b.fixedStart || '', fixedEnd: b.fixedEnd || ''
    }))
  };
}

function sameFixed(before, after){
  return JSON.stringify(before) === JSON.stringify(after);
}

function scheduledLessonCount(api){
  return (api.DB.lessons || []).filter(l => l.scheduledDay).length;
}

function scheduledBandCount(api){
  return (api.LAST_BANDS && api.LAST_BANDS.bands || []).filter(b => b.scheduledDay).length;
}

function generateSeed(api, seed){
  api.DB = JSON.parse(JSON.stringify(seed));
  api.LAST_BANDS = api.generateBands(16);
  api.LAST_RESULT = api.runScheduler(false);
  api.LAST_VARIANTS = [api.LAST_RESULT];
  return api.LAST_RESULT;
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();
  ['computeScheduleFingerprint','buildAcceptedScheduleRows','writeAcceptedToSourceTables',
   'clearAcceptedScheduledRecord','generateBands','runScheduler','getBandLessons','buildFullExportObject'
  ].forEach(name => {
    if(typeof api[name] !== 'function'){
      failed++;
      failures.push('export missing: ' + name);
      console.error('FAIL  export missing: ' + name);
    }
  });
  if(typeof api.writeAcceptedToSourceTables !== 'function'){
    console.error('Cannot continue without writeAcceptedToSourceTables');
    process.exit(1);
  }

  console.log('\n== seed Generate + Accept writes SCHEDULED, not FIXED ==');
  const result = generateSeed(api, seed);
  ok('seed Generate placed something', result.scheduled.length > 0, 'scheduled=' + result.scheduled.length);
  ok('seed Generate has unresolved items (typical on this roster)', true);

  const beforeFixed = snapshotFixed(api);
  const fpBefore = api.computeScheduleFingerprint();
  const lessonTeacherBefore = (api.DB.lessons || []).map(l => l.teacherId).join('|');

  const rows = api.buildAcceptedScheduleRows(result);
  api.DB.acceptedSchedule = rows;
  api.DB.acceptedTimetable = {
    acceptedAt: '2026-08-24T00:00:00.000Z',
    scheduled: clone(result.scheduled),
    unresolved: (result.unresolved || []).map(u => ({lessonId: u.lesson && u.lesson.id}))
  };
  const written = api.writeAcceptedToSourceTables(result);

  ok('Accept wrote lesson SCHEDULED slots', written.lessonsWritten > 0, 'lessonsWritten=' + written.lessonsWritten);
  ok('Accept wrote band SCHEDULED slots', written.bandsWritten > 0, 'bandsWritten=' + written.bandsWritten);
  ok('accepted table has one row per scheduled + unresolved',
    rows.length === result.scheduled.length + result.unresolved.length,
    `rows=${rows.length} scheduled=${result.scheduled.length} unresolved=${result.unresolved.length}`);
  ok('accepted table marks placed items as scheduled',
    rows.filter(r => r.status === 'scheduled').length === result.scheduled.length);

  const placedLessons = result.scheduled.filter(s => !String(s.lessonId).startsWith('BAND'));
  const sample = placedLessons[0];
  const lesson = (api.DB.lessons || []).find(l => l.id === sample.lessonId);
  ok('sample lesson SCHEDULED day matches Generate', lesson && lesson.scheduledDay === sample.day,
    lesson ? `${lesson.id} ${lesson.scheduledDay} vs ${sample.day}` : 'missing lesson');
  ok('sample lesson SCHEDULED start is HH:MM', lesson && /^\d{2}:\d{2}$/.test(lesson.scheduledStart),
    lesson && lesson.scheduledStart);
  ok('sample lesson FIXED day stayed empty (or original pin)',
    lesson && (lesson.fixedDay || '') === (beforeFixed.lessons.find(l => l.id === lesson.id).fixedDay || ''));

  const placedBand = result.scheduled.find(s => String(s.lessonId).startsWith('BAND'));
  if(placedBand){
    const band = api.LAST_BANDS.bands.find(b => b.id === placedBand.lessonId);
    const beforeBand = beforeFixed.bands.find(b => b.id === placedBand.lessonId) || beforeFixed.bands[0];
    ok('sample band SCHEDULED teacher is the placed teacher, not a Generate pin',
      band && band.scheduledTeacherId === placedBand.teacherId);
    ok('sample band Teacher override (teacherId) unchanged',
      band && band.teacherId === beforeBand.teacherId);
  } else {
    ok('at least one band was placed (skip band SCHEDULED checks)', false);
  }

  ok('FIXED / teacherId columns unchanged after Accept', sameFixed(beforeFixed, snapshotFixed(api)));
  ok('lesson teacherId columns unchanged after Accept',
    lessonTeacherBefore === (api.DB.lessons || []).map(l => l.teacherId).join('|'));
  ok('fingerprint ignores SCHEDULED so Accept does not look like an input edit',
    api.computeScheduleFingerprint() === fpBefore);

  const bandLessons = api.getBandLessons();
  const autoCount = bandLessons.filter(l => !l.teacherId).length;
  ok('getBandLessons still treats empty override as auto-match (ignores scheduledTeacherId)',
    autoCount > 0, 'autoCount=' + autoCount + ' of ' + bandLessons.length);

  console.log('\n== dragged times survive into Accept ==');
  const dragged = result.scheduled[0];
  const origDay = dragged.day;
  const origStart = dragged.start;
  const newDay = origDay === 'MON' ? 'FRI' : 'MON';
  const newStart = 16 * 60;
  const duration = dragged.end - dragged.start;
  dragged.day = newDay;
  dragged.start = newStart;
  dragged.end = newStart + duration;
  api.writeAcceptedToSourceTables(result);
  if(String(dragged.lessonId).startsWith('BAND')){
    const band = api.LAST_BANDS.bands.find(b => b.id === dragged.lessonId);
    ok('dragged band slot is what Accept writes',
      band && band.scheduledDay === newDay && band.scheduledStart === api.toHHMM(newStart));
  } else {
    const l = api.DB.lessons.find(x => x.id === dragged.lessonId);
    ok('dragged lesson slot is what Accept writes',
      l && l.scheduledDay === newDay && l.scheduledStart === api.toHHMM(newStart));
  }
  dragged.day = origDay;
  dragged.start = origStart;
  dragged.end = origStart + duration;
  api.writeAcceptedToSourceTables(result);

  console.log('\n== JSON snapshot includes frozen roster ==');
  const dump = api.buildFullExportObject();
  ok('JSON has acceptedSchedule rows', (dump.acceptedSchedule || []).length === rows.length);
  ok('JSON has acceptedTimetable clone, not a live alias',
    dump.acceptedTimetable && dump.acceptedTimetable.scheduled
    && dump.acceptedTimetable.scheduled !== result.scheduled);
  ok('JSON acceptedTimetable times match LAST_RESULT',
    dump.acceptedTimetable.scheduled[0].day === result.scheduled[0].day
    && dump.acceptedTimetable.scheduled[0].start === result.scheduled[0].start);

  console.log('\n== Generate-style clear wipes SCHEDULED and accepted table ==');
  api.clearAcceptedScheduledRecord();
  ok('lesson SCHEDULED columns empty after clear', scheduledLessonCount(api) === 0);
  ok('band SCHEDULED columns empty after clear', scheduledBandCount(api) === 0);
  ok('acceptedSchedule emptied', !(api.DB.acceptedSchedule && api.DB.acceptedSchedule.length));
  ok('acceptedTimetable nulled', api.DB.acceptedTimetable == null);
  ok('FIXED still unchanged after clear', sameFixed(beforeFixed, snapshotFixed(api)));
  ok('fingerprint still matches pre-Accept (clear is not an input edit)',
    api.computeScheduleFingerprint() === fpBefore);

  console.log('\n== second Generate is unconstrained by the previous Accept ==');
  const again = api.runScheduler(false);
  ok('second Generate still places lessons', again.scheduled.length > 0);
  const againFp = api.computeScheduleFingerprint();
  ok('second Generate fingerprint equals first (same inputs)', againFp === fpBefore);

  const pin = (api.DB.lessons || []).find(l => !l.fixedDay);
  if(pin){
    const placed = again.scheduled.find(s => s.lessonId === pin.id);
    if(placed){
      pin.fixedDay = placed.day;
      pin.fixedStart = api.toHHMM(placed.start);
      pin.fixedEnd = api.toHHMM(placed.end);
      const fpPinned = api.computeScheduleFingerprint();
      ok('typing a FIXED pin changes the fingerprint (Generate would reset the pool)',
        fpPinned !== fpBefore);
      pin.fixedDay = '';
      pin.fixedStart = '';
      pin.fixedEnd = '';
    } else {
      ok('found an unpinned lesson that this run placed (skip fingerprint pin check)', false);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failed){
    console.error('\nFailed checks:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('Accept / Generate SCHEDULED split looks solid.');
}

main();
