#!/usr/bin/env node
// Stress-tests the post-generate timetable drag editor: snap/clamp math, every
// constraint the bottom audit is supposed to re-check, "moves are never blocked",
// HTML conflict highlighting, JSON/ICS seeing the new times, and a fuzz of
// random drops on a real generated seed timetable.

import { loadApp } from './load-app.mjs';
import { checkSchedule } from './invariants.mjs';
import { makeRng } from './rng.mjs';

const DAYS = ['MON','TUE','WED','THU','FRI'];
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

function moveItem(item, day, start){
  const duration = Math.max(5, item.end - item.start);
  item.day = day;
  item.start = start;
  item.end = start + duration;
}

function auditKinds(audit){
  const kinds = new Set();
  (audit.issues || []).forEach(html => {
    const s = String(html);
    if(/outside the 08:00–20:00/.test(s)) kinds.add('schoolday');
    if(/is not available on|is only available/.test(s)) kinds.add('teacherWindow');
    if(/class reservation/.test(s)) kinds.add('reservation');
    if(/both need teacher/.test(s)) kinds.add('teacherOverlap');
    if(/both need /.test(s) && / at /.test(s) && !/both need teacher/.test(s) && !/both include/.test(s)) kinds.add('room');
    if(/both include/.test(s)) kinds.add('studentOverlap');
    if(/min gap on|break unit/.test(s)) kinds.add('break');
  });
  return kinds;
}

function invariantKinds(errors){
  const kinds = new Set();
  errors.forEach(s => {
    if(/outside school day/.test(s)) kinds.add('schoolday');
    if(/has no availability|only free/.test(s)) kinds.add('teacherWindow');
    if(/class reservation/.test(s)) kinds.add('reservation');
    if(/^teacher (?!.*illegal|.*break units)/.test(s) && /overlaps/.test(s)) kinds.add('teacherOverlap');
    if(/^room /.test(s) && /overlaps/.test(s)) kinds.add('room');
    if(/^student /.test(s) && /overlaps/.test(s)) kinds.add('studentOverlap');
    if(/illegal .*gap|break units/.test(s)) kinds.add('break');
  });
  return kinds;
}

function emptyRefs(){
  return {
    refTeachers: [{id:'T1', name:'Tea'}, {id:'T2', name:'Two'}],
    refClasses: [{id:'C1', name:'9a', muclass:'9'}],
    refGroups: [{id:'G1', name:'imprA', type:'IMPR'}, {id:'G2', name:'imprB', type:'IMPR'}],
    refInstruments: [{id:'I1', name:'piano', type:'acc'}],
    refRooms: [{id:'ROOM1', name:'321'}],
    smallGroupQuotas: [{teacherId:'T1', amount:4}, {teacherId:'T2', amount:4}],
  };
}

function installFixture(api, extra){
  const base = {
    ...emptyRefs(),
    students: [
      {ID:'S1', NAME1:'Anna', NAME2:'A', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G1'},
      {ID:'S2', NAME1:'Bela', NAME2:'B', CLASS_ID:'C1', CLASS:'9a', IMPR_ID:'G2'},
    ],
    lessons: [
      {id:'L1', name:'Piano', groupId:'G1', group:'imprA', teacherId:'T1', teacher:'Tea', duration:60, roomId:'ROOM1', room:'321'},
      {id:'L2', name:'Combo', groupId:'G2', group:'imprB', teacherId:'T1', teacher:'Tea', duration:60, roomId:'ROOM1', room:'321'},
      {id:'L3', name:'Sax', groupId:'G2', group:'imprB', teacherId:'T2', teacher:'Two', duration:60, roomId:'', room:''},
    ],
    teacherAvail: [
      {teacherId:'T1', day:'MON', start:'08:00', end:'14:00', type:'AVAILABLE'},
      {teacherId:'T2', day:'MON', start:'08:00', end:'14:00', type:'AVAILABLE'},
      {teacherId:'T2', day:'TUE', start:'08:00', end:'14:00', type:'AVAILABLE'},
    ],
    classAvail: [
      {classId:'C1', day:'TUE', start:'10:00', end:'12:00'},
    ],
    breaks: [{teacherId:'T1', breakMinutes:45, breakCount:1}],
  };
  Object.assign(base, extra || {});
  api.DB = base;
  api.LAST_SMALL_GROUPS = {smallGroups: [], excluded: [], appearances: {}, eligibleCount: 0};
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  return base;
}

function place(partial){
  return {
    lessonId: partial.lessonId,
    name: partial.name,
    group: partial.group || '',
    groupId: partial.groupId || '',
    teacher: partial.teacher || '',
    teacherId: partial.teacherId,
    day: partial.day,
    start: partial.start,
    end: partial.end,
    studentCount: partial.studentCount || 1,
    roomId: partial.roomId || '',
    room: partial.room || '',
    studentNames: partial.studentNames || [],
  };
}

function testSnapClamp(api){
  console.log('\n== snap / clamp / pointer math ==');
  ok('snap 8:00 stays', api.snapMinutes(8*60) === 8*60);
  ok('snap 8:02 down to 8:00', api.snapMinutes(8*60+2) === 8*60);
  ok('snap 8:03 up to 8:05', api.snapMinutes(8*60+3) === 8*60+5);
  ok('snap noon', api.snapMinutes(12*60) === 12*60);

  ok('clamp keeps 10:00 for 90min', api.clampLessonStart(10*60, 90) === 10*60);
  ok('clamp before 8:00 → 8:00', api.clampLessonStart(7*60, 90) === 8*60);
  ok('clamp 19:00/90min → 18:30', api.clampLessonStart(19*60, 90) === 18*60+30);
  ok('clamp 20:00/60min → 19:00', api.clampLessonStart(20*60, 60) === 19*60);

  const bodyTop = 200;
  const rect = {top: bodyTop, left: 0, right: 200, bottom: 2000};
  const yAt = (hhmm, grab=0) => {
    const mins = hhmm;
    return bodyTop + (mins - api.CAL_DAY_START) * api.CAL_PX_PER_MIN + grab * api.CAL_PX_PER_MIN;
  };
  ok('pointer at 8:00 → start 8:00',
    api.startFromPointerY(yAt(8*60), rect, 90, 0) === 8*60);
  ok('pointer at 10:00 → start 10:00',
    api.startFromPointerY(yAt(10*60), rect, 90, 0) === 10*60);
  ok('pointer at 19:40/90min clamps to 18:30',
    api.startFromPointerY(yAt(19*60+40), rect, 90, 0) === 18*60+30);
  ok('grab-offset 30min: pointer at 10:00 → start 9:30',
    api.startFromPointerY(yAt(10*60), rect, 90, 30) === 9*60+30);
  ok('grab-offset near 8:00 clamps rather than going before school',
    api.startFromPointerY(yAt(8*60), rect, 90, 45) === 8*60);

  const mon = {getBoundingClientRect(){ return {left:100, right:200, top:0, bottom:800}; }};
  const tue = {getBoundingClientRect(){ return {left:200, right:300, top:0, bottom:800}; }};
  const hitMon = api.hitCalendarDay(150, 40, [mon, tue]);
  const hitTue = api.hitCalendarDay(250, 40, [mon, tue]);
  const hitMiss = api.hitCalendarDay(50, 40, [mon, tue]);
  ok('hit Monday column', hitMon && hitMon.day === 'MON');
  ok('hit Tuesday column', hitTue && hitTue.day === 'TUE');
  ok('miss time-axis (left of Monday)', hitMiss == null);
}

function testFixtureAudit(api){
  console.log('\n== fixture: each constraint, move never blocked ==');
  installFixture(api);

  const legal = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
    place({lessonId:'L2', name:'Combo', groupId:'G2', teacherId:'T1', teacher:'Tea', day:'MON', start:9*60, end:10*60, roomId:'ROOM1', room:'321'}),
    place({lessonId:'L3', name:'Sax', groupId:'G2', teacherId:'T2', teacher:'Two', day:'MON', start:8*60, end:9*60}),
  ];
  api.LAST_RESULT = {scheduled: clone(legal), unresolved: []};
  let audit = api.auditTimetable(api.LAST_RESULT.scheduled);
  ok('legal layout has 0 audit issues', audit.issues.length === 0, `got ${audit.issues.length}: ${audit.issues.join(' | ')}`);

  // Teacher window: T1 has no Tuesday
  const a = clone(legal);
  moveItem(a[0], 'TUE', 8*60);
  audit = api.auditTimetable(a);
  ok('teacher-window move still applied', a[0].day === 'TUE' && a[0].start === 8*60 && a[0].end === 9*60);
  ok('teacher window is reported', auditKinds(audit).has('teacherWindow'), audit.issues.join(' | '));
  ok('conflict id includes moved lesson', audit.conflictIds.has('L1'));

  // Teacher overlap: stack L1 onto L2
  const b = clone(legal);
  moveItem(b[0], 'MON', 9*60);
  audit = api.auditTimetable(b);
  ok('teacher overlap reported', auditKinds(audit).has('teacherOverlap'), audit.issues.join(' | '));
  ok('room overlap also reported (same room)', auditKinds(audit).has('room'), audit.issues.join(' | '));
  ok('both lessons flagged', audit.conflictIds.has('L1') && audit.conflictIds.has('L2'));

  // Student overlap: L3 shares G2/S2 with L2 — move L3 onto L2
  const c = clone(legal);
  moveItem(c[2], 'MON', 9*60);
  audit = api.auditTimetable(c);
  ok('student overlap reported', auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));

  // Class reservation Tuesday 10–12 for class C1 (Anna in L1)
  const d = clone(legal);
  moveItem(d[0], 'TUE', 10*60); // also teacher-window fail
  audit = api.auditTimetable(d);
  ok('class reservation reported', auditKinds(audit).has('reservation'), audit.issues.join(' | '));

  // Illegal break: T1 08–09 then 10–11 = 60 min gap, unit is 45
  const e = clone(legal);
  moveItem(e[1], 'MON', 10*60);
  audit = api.auditTimetable(e);
  ok('illegal 60min gap reported', auditKinds(audit).has('break'), audit.issues.join(' | '));
  ok('illegal gap cites 45 min unit', /multiple of 45 min/.test(audit.issues.join(' ')), audit.issues.join(' | '));
  ok('gap is a warning, not a red conflict',
    audit.entries.some(x => x.level === 'warning' && /gap/.test(x.html)) && !audit.conflictIds.has('L1') && !audit.conflictIds.has('L2'),
    `levels=${(audit.entries||[]).map(x=>x.level).join(',')} ids=${[...audit.conflictIds].join(',')}`);

  // Legal break: 45 min gap, budget 1
  const f = clone(legal);
  moveItem(f[1], 'MON', 9*60+45);
  audit = api.auditTimetable(f);
  ok('legal 45min gap is silent', !auditKinds(audit).has('break') && audit.issues.length === 0, audit.issues.join(' | '));

  // Break overspend: two 45-min gaps (08–09, 09:45–10:45, 11:30–12:30) — add a third T1 lesson
  api.DB.lessons.push({id:'L4', name:'Extra', groupId:'G1', group:'imprA', teacherId:'T1', teacher:'Tea', duration:60, roomId:'', room:''});
  const g = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60}),
    place({lessonId:'L2', name:'Combo', groupId:'G2', teacherId:'T1', teacher:'Tea', day:'MON', start:9*60+45, end:10*60+45}),
    place({lessonId:'L4', name:'Extra', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:11*60+30, end:12*60+30}),
  ];
  audit = api.auditTimetable(g);
  ok('break budget overspend reported', auditKinds(audit).has('break'), audit.issues.join(' | '));
  ok('break budget is a warning', (audit.entries || []).every(x => x.level === 'warning'), (audit.entries||[]).map(x=>x.level).join(','));

  // Mixed: red teacher overlap first, then a yellow gap warning
  const mixed = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60}),
    place({lessonId:'L2', name:'Combo', groupId:'G2', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60}),
    place({lessonId:'L4', name:'Extra', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:10*60, end:11*60}),
  ];
  audit = api.auditTimetable(mixed);
  const mixedLevels = (audit.entries || []).map(x => x.level);
  ok('mixed list puts red errors before gap warnings',
    mixedLevels.indexOf('error') !== -1 && mixedLevels.indexOf('warning') !== -1 && mixedLevels.lastIndexOf('error') < mixedLevels.indexOf('warning'),
    mixedLevels.join(','));
  ok('overlap still paints red, gap does not add extra conflict ids beyond the overlap pair',
    audit.conflictIds.has('L1') && audit.conflictIds.has('L2') && !audit.conflictIds.has('L4'));

  // School-day overflow (UI clamps, but audit still catches a raw out-of-range item)
  const h = clone(legal);
  h[0].start = 19*60+30;
  h[0].end = 21*60;
  audit = api.auditTimetable(h);
  ok('past 20:00 is reported', auditKinds(audit).has('schoolday'), audit.issues.join(' | '));

  // Duration preserved across a chain of moves
  const i = clone(legal);
  const dur = i[0].end - i[0].start;
  moveItem(i[0], 'FRI', 16*60);
  moveItem(i[0], 'WED', 11*60+5);
  ok('duration unchanged after two drops', i[0].end - i[0].start === dur && i[0].day === 'WED' && i[0].start === 11*60+5);

  // AVOID day + outside the day's window
  api.DB.teacherAvail.push({teacherId:'T1', day:'WED', type:'AVOID'});
  const j = clone(legal);
  moveItem(j[0], 'WED', 10*60);
  audit = api.auditTimetable(j);
  ok('AVOID day reports teacher not available', /not available on Wednesday/.test(audit.issues.join(' ')), audit.issues.join(' | '));
  const k = clone(legal);
  moveItem(k[0], 'MON', 15*60);
  audit = api.auditTimetable(k);
  ok('past teacher window reports only-available range', /only available Monday 08:00–14:00/.test(audit.issues.join(' ')), audit.issues.join(' | '));
}

function testCalendarHtml(api){
  console.log('\n== calendar HTML: conflict class + lesson ids ==');
  installFixture(api);
  const items = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
    place({lessonId:'L2', name:'Combo', groupId:'G2', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
  ];
  api.LAST_AUDIT = api.auditTimetable(items);
  const container = {innerHTML: ''};
  api.renderCalendar(container, items, true);
  const html = container.innerHTML;
  ok('renders both lesson ids', html.includes('data-lesson-id="L1"') && html.includes('data-lesson-id="L2"'));
  ok('conflict class on overlapping blocks', (html.match(/cal-block has-conflict/g) || []).length === 2, html.slice(0, 400));
  ok('five day columns', (html.match(/cal-day-body/g) || []).length === 5);
  ok('times shown', html.includes('08:00') && html.includes('09:00'));
}

function testSavePaths(api){
  console.log('\n== save / ICS / Accept see the moved times ==');
  installFixture(api);
  const scheduled = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
    place({lessonId:'L3', name:'Sax', groupId:'G2', teacherId:'T2', teacher:'Two', day:'MON', start:8*60, end:9*60}),
  ];
  api.LAST_RESULT = {scheduled, unresolved: []};
  api.LAST_VARIANTS = [api.LAST_RESULT];
  moveItem(scheduled[0], 'WED', 13*60+15);

  const exported = api.buildFullExportObject();
  const json = JSON.parse(JSON.stringify(exported));
  const saved = (json.lastResult.scheduled || []).find(s => s.lessonId === 'L1');
  ok('JSON lastResult has Wednesday 13:15', saved && saved.day === 'WED' && saved.start === 13*60+15 && saved.end === 14*60+15);
  const inVariant = (json.timetableVariants[0].scheduled || []).find(s => s.lessonId === 'L1');
  ok('JSON variant 0 is the same moved slot', inVariant && inVariant.day === 'WED' && inVariant.start === 13*60+15);

  const ics = api.buildTimetableIcs(scheduled, new Date('2026-08-24T12:00:00'));
  ok('ICS contains 131500 local start', /DTSTART;TZID=Europe\/Budapest:\d{8}T131500/.test(ics), ics.match(/DTSTART.*/g)?.slice(0,6).join('\n'));
  ok('ICS contains WED as WE', /BYDAY=WE/.test(ics));

  // variant isolation: moving A must not rewrite a cloned other variant
  const other = {scheduled: clone(scheduled).map(s => ({...s, day:'MON', start:8*60, end:9*60})), unresolved: []};
  other.scheduled[0].day = 'MON';
  other.scheduled[0].start = 8*60;
  other.scheduled[0].end = 9*60;
  api.LAST_VARIANTS = [api.LAST_RESULT, other];
  moveItem(api.LAST_RESULT.scheduled[0], 'FRI', 16*60);
  ok('other variant untouched', other.scheduled[0].day === 'MON' && other.scheduled[0].start === 8*60);
  ok('active variant moved to Friday', api.LAST_RESULT.scheduled[0].day === 'FRI' && api.LAST_RESULT.scheduled[0].start === 16*60);
}

function kindsFromInvariants(api, scheduled){
  const result = {scheduled, unresolved: []};
  const errors = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, result);
  return {errors, kinds: invariantKinds(errors)};
}

function testSeedGenerateAndFuzz(api, seed){
  console.log('\n== seed generate: audit vs independent checker + random drops ==');
  api.DB = clone(seed);
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  api.SearchLog.quiet = true;
  api.LAST_SMALL_GROUPS = api.generateSmallGroups(16);
  const result = api.runScheduler(false);
  api.LAST_RESULT = result;
  api.LAST_VARIANTS = [result];

  ok('scheduler placed something', (result.scheduled || []).length > 0, `scheduled=${(result.scheduled||[]).length}`);
  const origAudit = api.auditTimetable(result.scheduled);
  ok('generated timetable is audit-clean (no false positives)', origAudit.issues.length === 0, origAudit.issues.slice(0,8).join(' | '));
  const inv = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, result);
  ok('generated timetable also passes independent invariants', inv.length === 0, inv.slice(0,8).join(' | '));

  const snapshot = clone(result.scheduled);
  const rng = makeRng(20260824);
  let throws = 0;
  let durationBreaks = 0;
  let blocked = 0;
  let falseNeg = 0;
  let falseNegSamples = [];
  const kindHits = {};
  const nMoves = 250;

  for(let n=0;n<nMoves;n++){
    const scheduled = clone(snapshot);
    const item = rng.pick(scheduled);
    const origDur = item.end - item.start;
    const origDay = item.day, origStart = item.start, origEnd = item.end;
    const day = rng.pick(DAYS);
    const rawStart = rng.int(api.CAL_DAY_START, api.CAL_DAY_END - 5);
    const start = api.clampLessonStart(api.snapMinutes(rawStart), origDur);
    try {
      moveItem(item, day, start);
    } catch(err){
      throws++;
      continue;
    }
    if(item.day !== day || item.start !== start) blocked++;
    if(item.end - item.start !== origDur) durationBreaks++;

    const audit = api.auditTimetable(scheduled);
    const {errors, kinds: exp} = kindsFromInvariants(api, scheduled);
    const got = auditKinds(audit);
    // Independent checker also flags pins / quotas / duration / coverage — those
    // are not part of the live drag audit. Compare only shared kinds.
    const shared = ['schoolday','teacherWindow','reservation','teacherOverlap','room','studentOverlap','break'];
    shared.forEach(k => {
      if(exp.has(k)) kindHits[k] = (kindHits[k] || 0) + 1;
      if(exp.has(k) && !got.has(k)){
        falseNeg++;
        if(falseNegSamples.length < 6){
          falseNegSamples.push(`${k} after ${item.lessonId} ${origDay} ${origStart}→${day} ${start}: inv=${errors.filter(e=>true).slice(0,3).join(' || ')} audit=${audit.issues.slice(0,3).join(' || ')}`);
        }
      }
    });
    // Same slot must stay clean
    if(day === origDay && start === origStart){
      const back = api.auditTimetable(scheduled);
      if(back.issues.length !== origAudit.issues.length && origAudit.issues.length === 0 && back.issues.length){
        falseNegSamples.push('same-slot re-drop dirtied a clean timetable');
        falseNeg++;
      }
    }
    void origEnd;
  }

  ok('random drops never throw', throws === 0, `${throws} throws`);
  ok('random drops never blocked', blocked === 0, `${blocked} blocked`);
  ok('duration always preserved', durationBreaks === 0, `${durationBreaks} duration breaks`);
  ok('audit has no false negatives vs independent checker', falseNeg === 0, falseNegSamples.join('\n  '));
  console.log('  fuzz kind hits:', JSON.stringify(kindHits));

  // Restore a known-bad teacher overlap on the real roster if we have 2+ lessons
  // of the same teacher, and confirm audit + HTML flag them.
  const byTeacher = {};
  snapshot.forEach(s => {
    if(!s.teacherId) return;
    (byTeacher[s.teacherId] = byTeacher[s.teacherId] || []).push(s);
  });
  const pairTid = Object.keys(byTeacher).find(tid => byTeacher[tid].length >= 2);
  if(pairTid){
    const live = clone(snapshot);
    const [x, y] = byTeacher[pairTid];
    const xi = live.findIndex(s => s.lessonId === x.lessonId);
    moveItem(live[xi], y.day, y.start);
    const audit = api.auditTimetable(live);
    ok('real roster: stacking two of the same teacher reports overlap',
      auditKinds(audit).has('teacherOverlap'), audit.issues.slice(0,4).join(' | '));
    api.LAST_AUDIT = audit;
    const container = {innerHTML: ''};
    api.renderCalendar(container, live, true);
    ok('real roster: HTML marks the stacked pair',
      container.innerHTML.includes('has-conflict'));
  } else {
    ok('real roster has a teacher with 2+ lessons (skip overlap HTML)', false);
  }

  // Move one lesson back and forth — original snapshot must be restorable
  const roundtrip = clone(snapshot);
  const victim = roundtrip[0];
  const home = {day: victim.day, start: victim.start, end: victim.end};
  moveItem(victim, home.day === 'MON' ? 'FRI' : 'MON', 16*60);
  moveItem(victim, home.day, home.start);
  ok('move away and back restores exact slot', victim.day === home.day && victim.start === home.start && victim.end === home.end);
  ok('restored slot is audit-clean again', api.auditTimetable(roundtrip).issues.length === 0, api.auditTimetable(roundtrip).issues.slice(0,4).join(' | '));
}

function testDropHandler(api){
  console.log('\n== drop handler: apply / click / Escape ==');
  installFixture(api);
  const scheduled = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
  ];
  api.LAST_RESULT = {scheduled, unresolved: []};
  api.LAST_VARIANTS = [api.LAST_RESULT];
  const inert = {classList:{add(){}, remove(){}}, releasePointerCapture(){}};
  const container = {querySelectorAll(){ return []; }, querySelector(){ return null; }};
  function seedDrag(overrides){
    api.CAL_DRAG = {
      pointerId: 1,
      block: inert,
      container,
      dayBodies: [],
      lessonId: 'L1',
      duration: 60,
      originX: 0, originY: 0,
      active: true,
      hover: {day:'THU', start:11*60},
      previewBody: null,
      ...overrides,
    };
  }

  ok('endCalendarDrag is a no-op without a drag', api.endCalendarDrag(true) == null && scheduled[0].day === 'MON');

  seedDrag({active:true, hover:{day:'THU', start:11*60}});
  api.endCalendarDrag(true);
  ok('active drop applies Thursday 11:00', scheduled[0].day === 'THU' && scheduled[0].start === 11*60 && scheduled[0].end === 12*60);
  ok('CAL_DRAG cleared after drop', api.CAL_DRAG == null);

  seedDrag({active:false, hover:{day:'FRI', start:16*60}});
  api.endCalendarDrag(true);
  ok('click (inactive drag) does not move', scheduled[0].day === 'THU' && scheduled[0].start === 11*60);

  seedDrag({active:true, hover:{day:'FRI', start:16*60}});
  api.endCalendarDrag(false);
  ok('Escape cancel does not move', scheduled[0].day === 'THU' && scheduled[0].start === 11*60);

  seedDrag({active:true, hover:null});
  api.endCalendarDrag(true);
  ok('drop outside the grid does not move', scheduled[0].day === 'THU' && scheduled[0].start === 11*60);

  ok('undo stack recorded the Thursday drop', (api.LAST_RESULT.dragUndo || []).length === 1);
  ok('baseline is Monday 08:00', api.LAST_RESULT.dragBaseline && api.LAST_RESULT.dragBaseline[0].day === 'MON' && api.LAST_RESULT.dragBaseline[0].start === 8*60);

  seedDrag({active:true, hover:{day:'FRI', start:16*60}});
  api.endCalendarDrag(true);
  ok('second drop applied', scheduled[0].day === 'FRI' && scheduled[0].start === 16*60);
  ok('undo stack has two steps', api.LAST_RESULT.dragUndo.length === 2);

  api.undoLastDrag();
  ok('undo restores Thursday 11:00', scheduled[0].day === 'THU' && scheduled[0].start === 11*60);
  ok('one undo step remains', api.LAST_RESULT.dragUndo.length === 1);

  api.undoLastDrag();
  ok('second undo restores generated Monday 08:00', scheduled[0].day === 'MON' && scheduled[0].start === 8*60);
  ok('undo stack empty', api.LAST_RESULT.dragUndo.length === 0);

  seedDrag({active:true, hover:{day:'WED', start:13*60}});
  api.endCalendarDrag(true);
  seedDrag({active:true, hover:{day:'FRI', start:15*60}});
  api.endCalendarDrag(true);
  api.resetVariantDrags();
  ok('reset restores generated Monday 08:00 after two drags', scheduled[0].day === 'MON' && scheduled[0].start === 8*60 && scheduled[0].end === 9*60);
  ok('reset clears undo stack', api.LAST_RESULT.dragUndo.length === 0);

  const other = {scheduled: clone(scheduled), unresolved: []};
  api.ensureDragBaseline(other);
  moveItem(other.scheduled[0], 'TUE', 10*60);
  other.dragUndo = [{lessonId:'L1', from:{day:'MON', start:8*60, end:9*60}, to:{day:'TUE', start:10*60, end:11*60}}];
  api.LAST_VARIANTS = [api.LAST_RESULT, other];
  api.resetVariantDrags();
  ok('reset only touches the active variant', other.scheduled[0].day === 'TUE' && other.scheduled[0].start === 10*60);
}

function testDragReopensAccept(api){
  console.log('\n== drag re-enables Accept and Accept freezes the dragged slots ==');
  installFixture(api);
  const scheduled = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60, roomId:'ROOM1', room:'321'}),
  ];
  api.LAST_RESULT = {scheduled, unresolved: []};
  api.acceptTimetableSchedule();
  ok('Accept this schedule flags the grid as accepted', api.LAST_RESULT.accepted === true);
  ok('accepted table is Monday 08:00',
    (api.DB.acceptedSchedule || []).some(r => r.lessonId === 'L1' && r.day === 'MON' && r.start === '08:00'));

  const inert = {classList:{add(){}, remove(){}}, releasePointerCapture(){}};
  const container = {querySelectorAll(){ return []; }, querySelector(){ return null; }};
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container, dayBodies: [],
    lessonId: 'L1', kind: 'timetable', duration: 60,
    originX: 0, originY: 0, active: true,
    hover: {day:'THU', start:11*60}, previewBody: null
  };
  api.endCalendarDrag(true);
  ok('timetable drag moves the lesson', scheduled[0].day === 'THU' && scheduled[0].start === 11*60);
  ok('timetable drag re-opens Accept', api.LAST_RESULT.accepted === false);
  ok('old freeze stays until re-accept',
    (api.DB.acceptedSchedule || []).some(r => r.lessonId === 'L1' && r.day === 'MON' && r.start === '08:00'));
  ok('timetable drag locks 1/1 tab', api.canOpenOneOne() === false);
  ok('timetable drag locks every other tab', api.pendingAcceptTab() === 'timetable');

  api.acceptTimetableSchedule();
  ok('re-accept freezes Thursday 11:00',
    api.LAST_RESULT.accepted === true
    && (api.DB.acceptedSchedule || []).some(r => r.lessonId === 'L1' && r.day === 'THU' && r.start === '11:00'));
  ok('re-accept unlocks 1/1 tab', api.canOpenOneOne() === true);

  const one = {
    lessonId:'O2O-T1-S1', name:'Anna 1/1', teacherId:'T1', teacher:'Tea',
    day:'MON', start:8*60, end:9*60, studentIds:'S1', studentId:'S1', source:'oneone'
  };
  api.LAST_ONEONE = {scheduled:[one], unresolved:[], accepted:false};
  api.acceptOneOneSchedule();
  ok('1/1 starts accepted', api.hasAcceptedOneOne() === true);
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container, dayBodies: [],
    lessonId: 'O2O-T1-S1', kind: 'oneone', duration: 60,
    originX: 0, originY: 0, active: true,
    hover: {day:'WED', start:14*60}, previewBody: null
  };
  api.endCalendarDrag(true);
  ok('1/1 drag moves the lesson', one.day === 'WED' && one.start === 14*60);
  ok('1/1 drag re-opens Accept 1/1', api.hasAcceptedOneOne() === false);

  api.acceptOneOneSchedule();
  ok('re-accept 1/1 freezes Wednesday 14:00',
    api.hasAcceptedOneOne() === true
    && api.LAST_ONEONE.acceptedSchedule[0].day === 'WED'
    && api.LAST_ONEONE.acceptedSchedule[0].start === '14:00');

  const pianoKeep = {
    lessonId:'RP-KEEP', name:'Anna piano', teacherId:'T1', teacher:'Tea',
    day:'MON', start:10*60, end:11*60, studentIds:'S1', studentId:'S1', source:'rpiano'
  };
  api.LAST_RPIANO = {scheduled:[pianoKeep], unresolved:[], accepted:true, acceptedSchedule:[{lessonId:'RP-KEEP'}]};
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container, dayBodies: [],
    lessonId: 'O2O-T1-S1', kind: 'oneone', duration: 60,
    originX: 0, originY: 0, active: true,
    hover: {day:'THU', start:15*60}, previewBody: null
  };
  api.endCalendarDrag(true);
  ok('1/1 drag keeps Required Piano accepted', api.hasAcceptedRpiano() === true);
  ok('1/1 drag locks Required Piano tab', api.canOpenRpiano() === false);
  ok('1/1 drag locks every other tab', api.pendingAcceptTab() === 'oneone');
  api.acceptOneOneSchedule();
  ok('re-Accept 1/1 still keeps Required Piano', api.hasAcceptedRpiano() === true);
  ok('re-Accept 1/1 unlocks Required Piano tab', api.canOpenRpiano() === true);

  const piano = {
    lessonId:'RP-T1-S1', name:'Anna piano', teacherId:'T1', teacher:'Tea',
    day:'MON', start:10*60, end:11*60, studentIds:'S1', studentId:'S1', source:'rpiano'
  };
  api.LAST_RPIANO = {scheduled:[piano], unresolved:[], accepted:false};
  api.acceptRpianoSchedule();
  ok('piano starts accepted', api.hasAcceptedRpiano() === true);
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container, dayBodies: [],
    lessonId: 'RP-T1-S1', kind: 'rpiano', duration: 60,
    originX: 0, originY: 0, active: true,
    hover: {day:'FRI', start:16*60}, previewBody: null
  };
  api.endCalendarDrag(true);
  ok('piano drag moves the lesson', piano.day === 'FRI' && piano.start === 16*60);
  ok('piano drag re-opens Accept Required Piano', api.hasAcceptedRpiano() === false);

  api.acceptRpianoSchedule();
  ok('re-accept piano freezes Friday 16:00',
    api.hasAcceptedRpiano() === true
    && api.LAST_RPIANO.acceptedSchedule[0].day === 'FRI'
    && api.LAST_RPIANO.acceptedSchedule[0].start === '16:00');
}

function testFrozenTimetableAudit(api){
  console.log('\n== frozen 1/1 and piano bind Timetable checks ==');
  installFixture(api);
  const group = place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60});
  const oneone = {
    lessonId:'O2O-T2-S1', name:'Anna 1/1', teacherId:'T2', teacher:'Two',
    day:'MON', start:8*60, end:9*60, studentIds:'S1', studentId:'S1',
    studentCount:1, studentNames:['Anna A'], source:'oneone'
  };

  api.LAST_ONEONE = {scheduled:[oneone], unresolved:[], accepted:false};
  let items = api.timetableAuditItems([group]);
  ok('unaccepted 1/1 is not on Timetable audit', items.length === 1 && items[0].lessonId === 'L1');
  let audit = api.auditTimetable(items);
  ok('no student clash while 1/1 is still generated', !auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));

  api.LAST_ONEONE.accepted = true;
  ok('frozen helper returns accepted 1/1', api.frozenIndividualItems().some(i => i.lessonId === 'O2O-T2-S1'));
  items = api.timetableAuditItems([group]);
  ok('accepted 1/1 is on Timetable audit', items.some(i => i.lessonId === 'O2O-T2-S1'));
  const stu = api.studentsForScheduledItem(oneone);
  ok('1/1 studentIds resolve to Anna', stu.some(s => s.ID === 'S1'), JSON.stringify(stu.map(s => s && s.ID)));
  audit = api.auditTimetable(items);
  ok('group vs frozen 1/1 sharing Anna is student overlap', auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));

  const sameTeacher = {
    lessonId:'O2O-T1-S2', name:'Bela 1/1', teacherId:'T1', teacher:'Tea',
    day:'MON', start:8*60, end:9*60, studentIds:'S2', studentId:'S2',
    source:'oneone'
  };
  api.LAST_ONEONE.scheduled = [sameTeacher];
  audit = api.auditTimetable(api.timetableAuditItems([group]));
  ok('group vs frozen 1/1 same teacher is teacher overlap', auditKinds(audit).has('teacherOverlap'), audit.issues.join(' | '));

  const piano = {
    lessonId:'RP-T2-S1', name:'Anna piano', teacherId:'T2', teacher:'Two',
    day:'MON', start:8*60, end:9*60, studentIds:'S1', studentId:'S1',
    source:'rpiano'
  };
  api.LAST_ONEONE = {scheduled:[oneone], unresolved:[], accepted:true};
  api.LAST_RPIANO = {scheduled:[piano], unresolved:[], accepted:false};
  items = api.timetableAuditItems([group]);
  ok('unaccepted piano is not on Timetable audit', !items.some(i => i.source === 'rpiano'));
  api.LAST_RPIANO.accepted = true;
  items = api.timetableAuditItems([group]);
  ok('accepted piano is on Timetable audit', items.some(i => i.lessonId === 'RP-T2-S1'));
  audit = api.auditTimetable(items);
  ok('group vs frozen piano sharing Anna is student overlap', auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));

  audit = api.auditTimetable(api.timetableAuditItems([]));
  ok('frozen 1/1 vs frozen piano same student is student overlap', auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));

  api.LAST_ONEONE = {scheduled:[oneone], unresolved:[], accepted:true};
  api.LAST_RPIANO = {scheduled:[], unresolved:[], accepted:false};
  api.LAST_AUDIT = api.auditTimetable(api.timetableAuditItems([group]));
  const container = {innerHTML:''};
  api.renderCalendar(container, [group], true);
  ok('Timetable grid does not draw the 1/1 block', !container.innerHTML.includes('O2O-T2-S1'));
  ok('group lesson is still draggable', /data-lesson-id="L1"[^>]*data-draggable="1"/.test(container.innerHTML));
  ok('group still highlights from the frozen 1/1 clash', /cal-block has-conflict/.test(container.innerHTML));
}

function testSmallGroupMemberLookup(api){
  console.log('\n== small group members participate in student-overlap audit ==');
  installFixture(api);
  api.LAST_SMALL_GROUPS = {
    smallGroups: [{
      bass: [{ID:'S1', NAME1:'Anna', NAME2:'A', CLASS_ID:'C1', CLASS:'9a'}],
      drum: [], acc: [], sol: [],
      teacherId:'T2', duration:60,
      fixedDay:'', fixedStart:'', fixedEnd:'',
    }],
    excluded: [], appearances: {}, eligibleCount: 1,
  };
  const scheduled = [
    place({lessonId:'L1', name:'Piano', groupId:'G1', teacherId:'T1', teacher:'Tea', day:'MON', start:8*60, end:9*60}),
    place({lessonId:'SG1', name:'Small Group 1 rehearsal', group:'SMALLGROUP', teacherId:'T2', teacher:'Two', day:'MON', start:8*60, end:9*60}),
  ];
  const students = api.studentsForScheduledItem(scheduled[1]);
  ok('small group lookup returns Anna', students.some(s => s.ID === 'S1'), JSON.stringify(students.map(s => s && s.ID)));
  const audit = api.auditTimetable(scheduled);
  ok('piano vs small group sharing Anna is a student overlap', auditKinds(audit).has('studentOverlap'), audit.issues.join(' | '));
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();
  const needed = ['auditTimetable','snapMinutes','clampLessonStart','startFromPointerY','hitCalendarDay','renderCalendar','buildFullExportObject','buildTimetableIcs','timetableAuditItems','frozenIndividualItems','studentsForScheduledItem'];
  needed.forEach(name => {
    if(typeof api[name] !== 'function'){
      failed++;
      failures.push(`export missing: ${name}`);
      console.error('FAIL  export missing: ' + name);
    }
  });
  if(typeof api.auditTimetable !== 'function'){
    console.error('Cannot continue without auditTimetable');
    process.exit(1);
  }

  testSnapClamp(api);
  testFixtureAudit(api);
  testCalendarHtml(api);
  testSavePaths(api);
  testDropHandler(api);
  testDragReopensAccept(api);
  testFrozenTimetableAudit(api);
  testSmallGroupMemberLookup(api);
  testSeedGenerateAndFuzz(api, seed);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failed){
    console.error('\nFailed checks:');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('Drag editor looks solid.');
}

main();
