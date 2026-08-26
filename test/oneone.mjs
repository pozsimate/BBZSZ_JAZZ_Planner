#!/usr/bin/env node
// 1/1 scheduler: holes around accepted bookings, all class-reservation
// leftovers (not only the largest), pack teacher gaps first, even day
// spread as a tie-break, no group-break units.

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

function overlaps(a, b){
  return a.start < b.end && b.start < a.end;
}

function toyStudents(){
  return ['S1','S2','S3','S4'].map((id, i) => ({
    ID: id,
    NAME1: 'Stu',
    NAME2: String(i + 1),
    NAME3: '',
    INSTR_ID: 'INST6',
    CLASS_ID: 'CLX',
  }));
}

function installToy(api, seed, extra){
  api.DB = clone(seed);
  api.DB.students = toyStudents();
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id: 'T1', name: 'OneOne Teacher'}]);
  api.DB.teacherAvail = extra.teacherAvail;
  api.DB.classAvail = extra.classAvail || [];
  api.DB.acceptedSchedule = extra.accepted || [];
  api.DB.acceptedTimetable = extra.accepted && extra.accepted.length
    ? {acceptedAt: '2026-08-24T00:00:00.000Z'}
    : null;
  api.DB.breaks = extra.breaks || [{teacherId: 'T1', breakMinutes: 15, breakCount: 0}];
}

function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();

  ['scheduleOneToOne','scheduleAllOneToOne','scheduleAllOneToOneSearch','classFreeGaps','parseOneOneHours','oneOneHoursToMinutes','parseOneToOneTable','collectOneOneAssignments','hasAcceptedRecord','isTimetableAccepted','canOpenOneOne','buildFullExportObject','scheduledIdleGapMinutes','oneOneResultScore','compareOneOneResults'
  ].forEach(name => {
    if(typeof api[name] !== 'function'){
      failed++;
      failures.push('export missing: ' + name);
      console.error('FAIL  export missing: ' + name);
    }
  });
  if(typeof api.scheduleOneToOne !== 'function'){
    console.error('Cannot continue without scheduleOneToOne');
    process.exit(1);
  }

  console.log('\n== hours units: 1 = 60, 1.5 = 90, 2 = 120 ==');
  ok('parses Hungarian 1,5', api.parseOneOneHours('1,5') === 1.5);
  ok('parses 1.5', api.parseOneOneHours('1.5') === 1.5);
  ok('1 hour → 60 min', api.oneOneHoursToMinutes(1) === 60);
  ok('1.5 hours → 90 min', api.oneOneHoursToMinutes(1.5) === 90);
  ok('2 hours → 120 min', api.oneOneHoursToMinutes(2) === 120);
  ok('3 hours → 180 min', api.oneOneHoursToMinutes(3) === 180);
  ok('blank is 0', api.parseOneOneHours('') === 0 && api.parseOneOneHours('  ') === 0);

  console.log('\n== Drive 1_1 matrix parses teacher columns ==');
  const parsed = api.parseOneToOneTable([
    {STUDENT_ID:'S1', NAME1:'Ann', INSTR:'piano', CSUHAJ:'2', PAL:'1,5'},
    {STUDENT_ID:'S2', NAME1:'Bob', INSTR:'sax', CSUHAJ:'', PAL:'1'},
  ], [{id:'TEAC1', name:'Csuhaj'}, {id:'TEAC3', name:'Pal'}]);
  ok('keeps teacher column order',
    parsed.columns.map(c => c.id).join(',') === 'TEAC1,TEAC3',
    parsed.columns.map(c => c.id).join(','));
  ok('S1 Csuhaj = 2 hours', parsed.hours.S1 && parsed.hours.S1.TEAC1 === 2);
  ok('S1 Pal = 1.5 hours', parsed.hours.S1 && parsed.hours.S1.TEAC3 === 1.5);
  ok('empty cell is omitted', parsed.hours.S2 && parsed.hours.S2.TEAC1 == null);
  const jobs = api.collectOneOneAssignments(parsed);
  ok('collects three assignments', jobs.length === 3, 'n=' + jobs.length);
  ok('1.5 cell becomes 90-minute job',
    jobs.some(j => j.studentId==='S1' && j.teacherId==='TEAC3' && j.duration===90));

  console.log('\n== classFreeGaps keeps every leftover hole, not only the largest ==');
  api.DB = clone(seed);
  api.DB.classAvail = [
    {classId: 'CLX', day: 'MON', start: '09:00', end: '12:00'},
    {classId: 'CLX', day: 'MON', start: '14:00', end: '16:00'},
  ];
  const gaps = api.classFreeGaps('CLX', 'MON');
  const win = api.classWindow('CLX', 'MON');
  ok('classFreeGaps returns more than one hole', gaps.length >= 2, JSON.stringify(gaps));
  ok('classWindow still returns only the largest hole',
    win && win[0] === 16*60 && win[1] === 20*60,
    win ? `${win[0]}-${win[1]}` : 'null');
  ok('morning leftover 08:00–09:00 is kept for 1/1',
    gaps.some(g => g[0] === 8*60 && g[1] === 9*60),
    JSON.stringify(gaps));

  console.log('\n== no teacher days → every student unresolved ==');
  installToy(api, seed, {teacherAvail: [], accepted: []});
  const none = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1','S2'], duration: 45, perStudent: 1, acceptedRows: []
  });
  ok('no availability places nobody', none.scheduled.length === 0, 'scheduled=' + none.scheduled.length);
  ok('no availability lists every student', none.unresolved.length === 2, 'unresolved=' + none.unresolved.length);

  console.log('\n== 1/1 does not overlap an accepted teacher slot ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [{
      status: 'scheduled', teacherId: 'T1', day: 'MON',
      start: 10*60, end: 12*60, name: 'Group', studentIds: 'S9'
    }],
  });
  const against = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 45, perStudent: 1,
    acceptedRows: api.DB.acceptedSchedule
  });
  ok('placed the one student', against.scheduled.length === 1, 'scheduled=' + against.scheduled.length);
  const hit = against.scheduled[0];
  ok('1/1 does not overlap 10:00–12:00 accepted block',
    hit && !overlaps(hit, {start: 10*60, end: 12*60}),
    hit ? `${api.toHHMM(hit.start)}–${api.toHHMM(hit.end)}` : 'missing');
  ok('1/1 sits flush against the accepted block (min idle gap)',
    hit && (hit.end === 10*60 || hit.start === 12*60),
    hit ? `${api.toHHMM(hit.start)}–${api.toHHMM(hit.end)}` : 'missing');

  console.log('\n== class reservation blocks the student ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '09:00', end: '13:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '09:00', end: '13:00'},
    ],
    accepted: [],
  });
  const blocked = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 45, perStudent: 1, acceptedRows: []
  });
  ok('fully reserved class window leaves the student unplaced',
    blocked.scheduled.length === 0 && blocked.unresolved.length === 1,
    `scheduled=${blocked.scheduled.length} unresolved=${blocked.unresolved.length}`);

  console.log('\n== smaller leftover class hole is still usable (unlike group classWindow) ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '09:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '09:00', end: '16:00'},
    ],
    accepted: [],
  });
  const smallHole = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 45, perStudent: 1, acceptedRows: []
  });
  ok('places into the 08:00–09:00 leftover, not only the afternoon gap',
    smallHole.scheduled.length === 1 && smallHole.scheduled[0].start === 8*60,
    smallHole.scheduled[0]
      ? `${api.toHHMM(smallHole.scheduled[0].start)}–${api.toHHMM(smallHole.scheduled[0].end)}`
      : 'unplaced');

  console.log('\n== 4 students / 2 teacher days → even 2+2 ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  const even = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1','S2','S3','S4'], duration: 45, perStudent: 1, acceptedRows: []
  });
  const byDay = {};
  even.scheduled.forEach(s => { byDay[s.day] = (byDay[s.day] || 0) + 1; });
  ok('places all four', even.scheduled.length === 4 && even.unresolved.length === 0,
    `scheduled=${even.scheduled.length} unresolved=${even.unresolved.length}`);
  ok('spreads 2+2 across the two available days when gaps tie',
    byDay.MON === 2 && byDay.TUE === 2,
    JSON.stringify(byDay));
  ok('packed 2+2 has no teacher idle gap',
    api.scheduledIdleGapMinutes(even.scheduled) === 0,
    String(api.scheduledIdleGapMinutes(even.scheduled)));
  ok('does not require group-timetable break units (breaks are 15×0)',
    even.scheduled.length === 4, 'would have failed if 0-break packing were enforced');

  console.log('\n== minutes can differ per student ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  const mixed = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1','S2'], duration: 45, perStudent: 1,
    durations: {S1: 90, S2: 45}, acceptedRows: []
  });
  const s1 = mixed.scheduled.find(s => s.studentId === 'S1');
  const s2 = mixed.scheduled.find(s => s.studentId === 'S2');
  ok('places both mixed-length students', mixed.scheduled.length === 2, 'scheduled=' + mixed.scheduled.length);
  ok('S1 is 90 minutes', s1 && s1.duration === 90 && (s1.end - s1.start) === 90,
    s1 ? `${s1.duration} / ${s1.end - s1.start}` : 'missing');
  ok('S2 is 45 minutes', s2 && s2.duration === 45 && (s2.end - s2.start) === 45,
    s2 ? `${s2.duration} / ${s2.end - s2.start}` : 'missing');
  ok('mixed lengths do not overlap', s1 && s2 && !overlaps(s1, s2),
    s1 && s2 ? `${s1.start}-${s1.end} vs ${s2.start}-${s2.end}` : 'missing');

  console.log('\n== generate all teachers at once from the matrix ==');
  api.DB = clone(seed);
  api.DB.students = toyStudents();
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([
    {id:'T1', name:'One'}, {id:'T2', name:'Two'}
  ]);
  api.DB.teacherAvail = [
    {teacherId:'T1', day:'MON', start:'08:00', end:'16:00', type:'AVAILABLE'},
    {teacherId:'T2', day:'MON', start:'08:00', end:'16:00', type:'AVAILABLE'},
  ];
  api.DB.classAvail = [];
  api.DB.acceptedSchedule = [];
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}, {id:'T2', name:'Two'}],
    hours: {S1: {T1: 1, T2: 1.5}, S2: {T1: 2}}
  };
  const all = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const a1 = all.scheduled.find(s => s.studentId==='S1' && s.teacherId==='T1');
  const a2 = all.scheduled.find(s => s.studentId==='S1' && s.teacherId==='T2');
  const a3 = all.scheduled.find(s => s.studentId==='S2' && s.teacherId==='T1');
  ok('places every matrix cell', all.scheduled.length === 3 && all.unresolved.length === 0,
    `scheduled=${all.scheduled.length} unresolved=${all.unresolved.length}`);
  ok('T1×S1 is 60 min', a1 && a1.duration === 60, a1 ? String(a1.duration) : 'missing');
  ok('T2×S1 is 90 min', a2 && a2.duration === 90, a2 ? String(a2.duration) : 'missing');
  ok('T1×S2 is 120 min', a3 && a3.duration === 120, a3 ? String(a3.duration) : 'missing');
  ok('same student does not overlap two teachers',
    a1 && a2 && !overlaps(a1, a2),
    a1 && a2 ? `${a1.start}-${a1.end} vs ${a2.start}-${a2.end}` : 'missing');
  ok('same teacher does not overlap two students',
    a1 && a3 && !overlaps(a1, a3),
    a1 && a3 ? `${a1.start}-${a1.end} vs ${a3.start}-${a3.end}` : 'missing');

  console.log('\n== student already booked in accepted schedule is busy ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '10:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [{
      status: 'scheduled', teacherId: 'T9', day: 'MON',
      start: 8*60, end: 10*60, name: 'Small Group', studentIds: 'S1'
    }],
  });
  const busyStu = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 45, perStudent: 1,
    acceptedRows: api.DB.acceptedSchedule
  });
  ok('student’s accepted booking blocks the only teacher window',
    busyStu.scheduled.length === 0 && busyStu.unresolved.length === 1,
    `scheduled=${busyStu.scheduled.length}`);

  console.log('\n== teacher window past 20:00 is still a 1/1 hole ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'WED', start: '14:30', end: '20:30', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 3}, S2: {T1: 3}}
  };
  const evening = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('places both 180-min lessons into 14:30–20:30',
    evening.scheduled.length === 2 && evening.unresolved.length === 0,
    `scheduled=${evening.scheduled.length} unresolved=${evening.unresolved.length}`);
  const eTimes = evening.scheduled.map(s => `${s.studentId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).sort();
  ok('packs 14:30–17:30 then 17:30–20:30 (past the 20:00 classFreeGaps clip)',
    evening.scheduled.some(s => s.start === 14*60+30 && s.end === 17*60+30)
    && evening.scheduled.some(s => s.start === 17*60+30 && s.end === 20*60+30),
    eTimes.join('; '));
  ok('lesson ids include teacher and student',
    evening.scheduled.every(s => s.lessonId === 'O2O-T1-' + s.studentId),
    evening.scheduled.map(s => s.lessonId).join(','));

  console.log('\n== 15-layout search keeps distinct versions ==');
  installToy(api, seed, {
    teacherAvail: ['MON','TUE','WED','THU','FRI'].map(d => (
      {teacherId: 'T1', day: d, start: '08:00', end: '16:00', type: 'AVAILABLE'}
    )),
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 1}, S2: {T1: 1}, S3: {T1: 1}, S4: {T1: 1}}
  };
  const greedy = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const searched = api.scheduleAllOneToOneSearch({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('search returns an array of layouts', Array.isArray(searched) && searched.length >= 1);
  ok('aims for 15 distinct layouts on an open week',
    searched.length >= api.ONEONE_SEARCH_ATTEMPTS,
    `got ${searched.length}`);
  ok('every layout places all four students',
    searched.every(v => v.scheduled.length === 4 && v.unresolved.length === 0),
    searched.map(v => `${v.scheduled.length}/${v.unresolved.length}`).join(','));
  ok('layouts are distinct',
    new Set(searched.map(v => v.scheduled.map(s => `${s.studentId}|${s.day}|${s.start}`).sort().join(';'))).size === searched.length);
  ok('best is at least as complete as a single greedy pass',
    searched[0].unresolved.length <= greedy.unresolved.length
    && searched[0].scheduled.length >= greedy.scheduled.length);
  ok('one attempt is the deterministic baseline',
    searched.some(v => v.attemptKind === 'deterministic' && v.attemptNo === 1));
  ok('search ranks fewest teacher idle minutes after completeness',
    searched.every((v,i) => i === 0 || api.compareOneOneResults(searched[i-1], v) <= 0));
  const gappy = {
    scheduled: [
      {teacherId:'T1', day:'MON', start:8*60, end:9*60},
      {teacherId:'T1', day:'MON', start:11*60, end:12*60}
    ],
    unresolved: []
  };
  const packed = {
    scheduled: [
      {teacherId:'T1', day:'MON', start:8*60, end:9*60},
      {teacherId:'T1', day:'MON', start:9*60, end:10*60}
    ],
    unresolved: []
  };
  ok('packed layout scores better than a 2-hour hole',
    api.compareOneOneResults(packed, gappy) < 0
    && api.scheduledIdleGapMinutes(packed.scheduled) === 0
    && api.scheduledIdleGapMinutes(gappy.scheduled) === 120);

  console.log('\n== class leftover packs onto the other day instead of opening a teacher hole ==');
  api.DB = clone(seed);
  api.DB.students = [
    {ID:'S1', NAME1:'Ann', NAME2:'A', CLASS_ID:'CLX'},
    {ID:'S2', NAME1:'Bob', NAME2:'B', CLASS_ID:'CLX'},
    {ID:'S3', NAME1:'Cara', NAME2:'C', CLASS_ID:''},
    {ID:'S4', NAME1:'Dan', NAME2:'D', CLASS_ID:''},
    {ID:'S5', NAME1:'Eve', NAME2:'E', CLASS_ID:''},
    {ID:'S6', NAME1:'Fay', NAME2:'F', CLASS_ID:''}
  ];
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id:'T1', name:'One'}]);
  api.DB.teacherAvail = [
    {teacherId:'T1', day:'THU', start:'08:00', end:'20:00', type:'AVAILABLE'},
    {teacherId:'T1', day:'FRI', start:'08:00', end:'15:00', type:'AVAILABLE'}
  ];
  api.DB.classAvail = [
    {classId:'CLX', day:'THU', start:'09:00', end:'13:00'},
    {classId:'CLX', day:'FRI', start:'09:00', end:'13:00'}
  ];
  api.DB.acceptedSchedule = [];
  api.DB.breaks = [{teacherId:'T1', breakMinutes:15, breakCount:0}];
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1:{T1:1}, S2:{T1:1}, S3:{T1:1}, S4:{T1:1}, S5:{T1:1}, S6:{T1:1}}
  };
  const packedDays = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('places all six around the 09:00–13:00 class block',
    packedDays.scheduled.length === 6 && packedDays.unresolved.length === 0,
    `scheduled=${packedDays.scheduled.length} unresolved=${packedDays.unresolved.length}`);
  ok('does not leave an idle gap between the teacher’s 1/1 blocks',
    api.scheduledIdleGapMinutes(packedDays.scheduled) === 0,
    packedDays.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)} ${s.studentId}`).join('; '));
  const searchedPack = api.scheduleAllOneToOneSearch({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('best search layout also has zero teacher idle',
    searchedPack[0] && searchedPack[0].idleGapMinutes === 0
    && searchedPack[0].unresolved.length === 0,
    searchedPack[0]
      ? `idle=${searchedPack[0].idleGapMinutes} unresolved=${searchedPack[0].unresolved.length}`
      : 'no layouts');

  console.log('\n== JSON export keeps the 1/1 state ==');
  api.LAST_ONEONE = {viewTeacherId: 'T1', scheduled: even.scheduled, unresolved: []};
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 1}}};
  const dumped = api.buildFullExportObject();
  ok('oneToOneState is in the full export',
    dumped.oneToOneState && dumped.oneToOneState.viewTeacherId === 'T1',
    dumped.oneToOneState ? JSON.stringify(dumped.oneToOneState) : 'missing');
  ok('oneToOne matrix is in the full export',
    dumped.oneToOne && dumped.oneToOne.hours && dumped.oneToOne.hours.S1 && dumped.oneToOne.hours.S1.T1 === 1);

  console.log('\n== hasAcceptedRecord vs current-grid tab lock ==');
  api.DB = clone(seed);
  api.DB.acceptedSchedule = [];
  api.DB.acceptedTimetable = null;
  api.LAST_SMALL_GROUPS = null;
  api.LAST_RESULT = null;
  (api.DB.lessons || []).forEach(l => { l.scheduledDay = ''; });
  ok('locked before Accept', api.hasAcceptedRecord() === false);
  ok('1/1 tab locked without a current accepted grid', api.canOpenOneOne() === false);
  api.DB.acceptedTimetable = {acceptedAt: '2026-08-24T00:00:00.000Z'};
  ok('unlocked after acceptedTimetable is set', api.hasAcceptedRecord() === true);
  ok('old freeze alone does not open 1/1', api.canOpenOneOne() === false);
  api.LAST_RESULT = {scheduled:[{lessonId:'L1'}], accepted:true};
  ok('current accepted grid opens 1/1', api.canOpenOneOne() === true);
  api.LAST_RESULT.accepted = false;
  ok('unaccepted grid locks 1/1 even if freeze exists', api.hasAcceptedRecord() && api.canOpenOneOne() === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    console.error(failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
}

main();
