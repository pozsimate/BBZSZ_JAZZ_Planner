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

async function main(){
  console.log('Loading app into harness…');
  const {api, seed} = loadApp();

  ['scheduleOneToOne','scheduleAllOneToOne','scheduleAllOneToOneSearch','scheduleAllOneToOneSearchAsync','classFreeGaps','parseOneOneHours','oneOneHoursToMinutes','parseOneToOneTable','collectOneOneAssignments','hasAcceptedRecord','isTimetableAccepted','canOpenOneOne','buildFullExportObject','scheduledIdleGapMinutes','oneOneResultScore','compareOneOneResults','oneOneAvgDayStartMinutes','generateIndividualScoped','generateIndividualScopedAsync','assignmentsForGenerate','oneOneSplitPlans','oneOneHalves','oneOneCoverageCount','teacherMatrixRoom','studentMatrixRoom','mergeMatrixColumnRooms','setMatrixTeacherRoom','setMatrixStudentRoom'
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

  const rooms = [{id:'ROOM1', name:'321'}, {id:'ROOM2', name:'Drum'}];
  const withLock = api.parseOneToOneTable([
    {STUDENT_ID:'ROOM_LOCK', CSUHAJ:'321', PAL:''},
    {STUDENT_ID:'S1', NAME1:'Ann', INSTR:'piano', CSUHAJ:'2', PAL:'1,5'},
    {STUDENT_ID:'S2', NAME1:'Bob', INSTR:'sax', CSUHAJ:'', PAL:'1'},
  ], [{id:'TEAC1', name:'Csuhaj'}, {id:'TEAC3', name:'Pal'}], rooms);
  ok('ROOM_LOCK row is not treated as a student', !withLock.hours.ROOM_LOCK);
  ok('ROOM_LOCK row still keeps the hour cells', api.collectOneOneAssignments(withLock).length === 3);
  ok('Csuhaj column locks to 321',
    (withLock.columns.find(c => c.id === 'TEAC1') || {}).roomId === 'ROOM1',
    JSON.stringify(withLock.columns));
  ok('blank Pal cell stays unlocked',
    !(withLock.columns.find(c => c.id === 'TEAC3') || {}).roomId);
  ok('ROOM_LOCK row is flagged for Drive merge', withLock.hasRoomRow === true);

  const withCol = api.parseOneToOneTable([
    {STUDENT_ID:'S1', NAME1:'Ann', INSTR:'piano', CSUHAJ:'2', CSUHAJ_ROOM:'321', PAL:'1,5', PAL_ROOM:''},
    {STUDENT_ID:'S2', NAME1:'Bob', INSTR:'sax', CSUHAJ:'', CSUHAJ_ROOM:'321', PAL:'1', PAL_ROOM:''},
  ], [{id:'TEAC1', name:'Csuhaj'}, {id:'TEAC3', name:'Pal'}], rooms);
  ok('Csuhaj_ROOM is not a teacher hours column',
    withCol.columns.map(c => c.id).join(',') === 'TEAC1,TEAC3'
    && !withCol.hours.S1.CSUHAJ_ROOM);
  ok('321 in Csuhaj_ROOM is a lock, not 321 hours',
    api.collectOneOneAssignments(withCol).length === 3
    && (withCol.columns.find(c => c.id === 'TEAC1') || {}).roomId === 'ROOM1',
    JSON.stringify({hours: withCol.hours.S1, cols: withCol.columns}));
  ok('blank Pal_ROOM stays unlocked',
    !(withCol.columns.find(c => c.id === 'TEAC3') || {}).roomId);
  ok('teacher _ROOM columns are flagged for Drive merge',
    (withCol.roomColumnIds || []).includes('TEAC1') && (withCol.roomColumnIds || []).includes('TEAC3'));

  const withStuRoom = api.parseOneToOneTable([
    {STUDENT_ID:'S1', NAME1:'Ann', INSTR:'piano', ROOM:'321', CSUHAJ:'2', PAL:'1,5'},
    {STUDENT_ID:'S2', NAME1:'Bob', INSTR:'sax', ROOM:'', CSUHAJ:'', PAL:'1'},
  ], [{id:'TEAC1', name:'Csuhaj'}, {id:'TEAC3', name:'Pal'}], rooms);
  ok('ROOM after the student is not a teacher hours column',
    withStuRoom.columns.map(c => c.id).join(',') === 'TEAC1,TEAC3'
    && api.collectOneOneAssignments(withStuRoom).length === 3,
    JSON.stringify({cols: withStuRoom.columns, hours: withStuRoom.hours}));
  ok('321 in the student ROOM column is a lock, not 321 hours',
    (withStuRoom.studentRooms || {}).S1 && withStuRoom.studentRooms.S1.roomId === 'ROOM1',
    JSON.stringify(withStuRoom.studentRooms));
  ok('blank student ROOM stays unlocked',
    !((withStuRoom.studentRooms || {}).S2 || {}).roomId);
  ok('student ROOM column is flagged for Drive merge', withStuRoom.hasStudentRooms === true);

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

  console.log('\n== SCOPE GROUP windows are not 1/1 holes ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE', scope: 'GROUP'},
    ],
    classAvail: [],
    accepted: [],
  });
  const groupOnly = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 60, perStudent: 1, acceptedRows: []
  });
  ok('GROUP-only availability leaves 1/1 unplaced',
    groupOnly.scheduled.length === 0 && groupOnly.unresolved.length === 1,
    `scheduled=${groupOnly.scheduled.length} unresolved=${groupOnly.unresolved.length}`);

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
  ok('1/1 sits flush against the accepted block when the teacher already has a lesson',
    hit && (hit.end === 10*60 || hit.start === 12*60),
    hit ? `${api.toHHMM(hit.start)}–${api.toHHMM(hit.end)}` : 'missing');
  const chainTwo = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1','S2'], duration: 45, perStudent: 1,
    acceptedRows: api.DB.acceptedSchedule
  });
  const chainTimes = chainTwo.scheduled.slice().sort((a,b) => a.start - b.start);
  ok('two 1/1s chain flush to the existing lesson',
    chainTimes.length === 2
    && chainTimes[0].end === chainTimes[1].start
    && (chainTimes[1].end === 10*60 || chainTimes[0].start === 12*60),
    chainTimes.map(s => `${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; '));
  const earlyIsland = {
    scheduled: [{teacherId:'T1', day:'MON', start:8*60, end:8*60+45, studentId:'S1'}],
    unresolved: [],
    idleGapMinutes: 75
  };
  const flushToGroup = {
    scheduled: [{teacherId:'T1', day:'MON', start:9*60+15, end:10*60, studentId:'S1'}],
    unresolved: [],
    idleGapMinutes: 0
  };
  ok('search ranks flush-to-existing above an early island with a hole',
    api.compareOneOneResults(flushToGroup, earlyIsland) < 0);

  console.log('\n== empty teacher-day starts as early as possible ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  const emptyDay = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1','S2'], duration: 45, perStudent: 1, acceptedRows: []
  });
  const emptyTimes = emptyDay.scheduled.slice().sort((a,b) => a.start - b.start);
  ok('no existing lesson → first 1/1 at 08:00, second chained',
    emptyTimes.length === 2
    && emptyTimes[0].start === 8*60 && emptyTimes[0].end === 8*60+45
    && emptyTimes[1].start === 8*60+45 && emptyTimes[1].end === 9*60+30,
    emptyTimes.map(s => `${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; '));

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

  console.log('\n== smaller leftover class hole is still usable ==');
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
    && api.oneOneCoverageCount(searched[0]) >= api.oneOneCoverageCount(greedy));
  ok('one attempt is the deterministic baseline',
    searched.some(v => v.attemptKind === 'deterministic' && v.attemptNo === 1));
  ok('search ranks fewest teacher idle minutes after completeness',
    searched.every((v,i) => i === 0 || api.compareOneOneResults(searched[i-1], v) <= 0));

  console.log('\n== live 1/1 search window ==');
  api.resetSearchCancel();
  api.openSearchLive('Generate all 1/1');
  const liveTicks = [];
  const liveAsync = await api.scheduleAllOneToOneSearchAsync(
    {matrix: api.DB.oneToOne, acceptedRows: [], attempts: 2, maxTries: 3},
    (done, total, label) => liveTicks.push({done, total, label})
  );
  ok('async search returns layouts', Array.isArray(liveAsync) && liveAsync.length >= 1);
  ok('async search writes progress ticks', liveTicks.length >= 1);
  ok('async search logs a baseline line', api.oneOneResultLogLine(liveAsync[0]).includes('placed'));
  ok('live window is open during search', api.isSearchLiveOpen() === true);
  api.closeSearchLive();
  ok('live window closes after search', api.isSearchLiveOpen() === false);

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

  console.log('\n== split catalog: 60 → 2×30, 90 → 2×45 or 60+30, 120 → 2×60, 30 stays ==');
  ok('90 splits to 45+45 then 60+30',
    api.oneOneSplitPlans(90).map(p => p.join('+')).join('|') === '45+45|60+30|30+60',
    JSON.stringify(api.oneOneSplitPlans(90)));
  ok('120 splits to 60+60',
    api.oneOneSplitPlans(120).length === 1 && api.oneOneSplitPlans(120)[0].join('+') === '60+60',
    JSON.stringify(api.oneOneSplitPlans(120)));
  ok('60 splits to 30+30',
    api.oneOneSplitPlans(60).length === 1 && api.oneOneSplitPlans(60)[0].join('+') === '30+30',
    JSON.stringify(api.oneOneSplitPlans(60)));
  ok('30 does not split', api.oneOneSplitPlans(30).length === 0);
  ok('180 does not split', api.oneOneSplitPlans(180).length === 0);
  ok('45 does not split', api.oneOneSplitPlans(45).length === 0);
  ok('halves 60 → 30+30', api.oneOneHalves(60).join('+') === '30+30');
  ok('halves 90 → 45+45', api.oneOneHalves(90).join('+') === '45+45');
  ok('halves 120 → 60+60', api.oneOneHalves(120).join('+') === '60+60');
  ok('halves 180 is none', api.oneOneHalves(180) == null);
  ok('halves 30 is none', api.oneOneHalves(30) == null);

  console.log('\n== 2-hour cell splits into two 60s when no 120 hole exists ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '09:00', end: '15:00'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 2}}
  };
  const sameDaySplit = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('two leftover holes on the same day are not used as a split',
    sameDaySplit.scheduled.length === 0 && sameDaySplit.unresolved.length === 1,
    sameDaySplit.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${sameDaySplit.unresolved.length}`);

  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '09:00', end: '16:00'},
      {classId: 'CLX', day: 'TUE', start: '09:00', end: '16:00'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 2}}
  };
  const split2 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('places the 2-hour cell as two 60-min leftover sessions on different days',
    split2.unresolved.length === 0 && api.oneOneCoverageCount(split2) === 1 && split2.scheduled.length === 2
    && split2.scheduled.every(s => (s.end - s.start) === 60)
    && split2.scheduled[0].day !== split2.scheduled[1].day,
    split2.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${split2.unresolved.length}`);
  ok('split 60s do not overlap',
    split2.scheduled.length === 2
    && (split2.scheduled[0].day !== split2.scheduled[1].day
      || !overlaps(split2.scheduled[0], split2.scheduled[1])));

  console.log('\n== 1.5-hour cell splits into two 45s when no 90 hole exists ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '08:45', end: '16:00'},
      {classId: 'CLX', day: 'TUE', start: '08:45', end: '16:00'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 1.5}}
  };
  const split15 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('places 1.5 hours as two 45-min leftover sessions on different days',
    split15.unresolved.length === 0 && api.oneOneCoverageCount(split15) === 1 && split15.scheduled.length === 2
    && split15.scheduled.every(s => (s.end - s.start) === 45)
    && split15.scheduled[0].day !== split15.scheduled[1].day,
    split15.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${split15.unresolved.length}`);

  console.log('\n== 1-hour leftover splits to 2×30; 3-hour does not split ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '08:45', end: '15:15'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 1}, S2: {T1: 3}}
  };
  const noSplit = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('1-hour cell is left out when no 60-min hole and 30s cannot sit flush',
    noSplit.unresolved.some(u => u.studentId === 'S1')
    && !noSplit.scheduled.some(s => s.studentId === 'S1'),
    noSplit.scheduled.map(s => `${s.studentId} ${s.end-s.start}`).join('; ')
    + ' / ' + noSplit.unresolved.map(u => u.studentId).join(','));
  ok('3-hour cell is left out when no 180-min hole exists',
    noSplit.unresolved.some(u => u.studentId === 'S2')
    && !noSplit.scheduled.some(s => s.studentId === 'S2'));

  console.log('\n== contiguous 90 and 120 are preferred over a split ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'WED', start: '14:30', end: '20:30', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}],
    hours: {S1: {T1: 1.5}, S2: {T1: 2}}
  };
  const keepBlock = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const keep90 = keepBlock.scheduled.find(s => s.studentId === 'S1');
  const keep120 = keepBlock.scheduled.find(s => s.studentId === 'S2');
  ok('keeps a single 90 and a single 120 when a hole is big enough',
    keepBlock.scheduled.length === 2 && keepBlock.unresolved.length === 0
    && keep90 && keep90.duration === 90 && keep120 && keep120.duration === 120,
    keepBlock.scheduled.map(s => `${s.studentId} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; '));
  ok('coverage counts a split and a block as one assignment',
    api.oneOneCoverageCount(split2) === 1 && api.oneOneCoverageCount(keepBlock) === 2);
  ok('fewer sessions score better than a needless split of the same coverage',
    api.compareOneOneResults({scheduled: keepBlock.scheduled.filter(s => s.studentId==='S2'), unresolved: []}, split2) < 0);

  console.log('\n== round 2 splits only leftovers; placed blocks stay ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '08:45', end: '16:00'},
      {classId: 'CLX', day: 'TUE', start: '08:45', end: '16:00'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 1}}};
  const half60 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('unplaced 60 is split to 30+30 on different days',
    half60.unresolved.length === 0 && half60.scheduled.length === 2
    && half60.scheduled.every(s => (s.end - s.start) === 30)
    && half60.scheduled[0].day !== half60.scheduled[1].day,
    half60.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${half60.unresolved.length}`);

  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '09:30', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '09:30', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 3}}};
  const half180 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('3h stays unresolved — 180 has no split plan',
    half180.unresolved.length === 1 && half180.scheduled.length === 0,
    half180.scheduled.map(s => `${s.day} ${s.end-s.start}`).join('; ')
    + ` unresolved=${half180.unresolved.length}`);

  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '10:00', end: '16:00'},
      {classId: 'CLX', day: 'TUE', start: '10:00', end: '16:00'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 1.5}, S2: {T1: 1.5}, S3: {T1: 1}}};
  const halfPool = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const halfByStu = {};
  halfPool.scheduled.forEach(s => { (halfByStu[s.studentId] = halfByStu[s.studentId] || []).push(s); });
  const sameDayGap = [];
  Object.keys(halfByStu).forEach(id => {
    const list = halfByStu[id];
    for(let i = 0; i < list.length; i++){
      for(let j = i + 1; j < list.length; j++){
        if(list[i].day !== list[j].day) continue;
        if(list[i].end !== list[j].start && list[j].end !== list[i].start){
          sameDayGap.push(id + ' ' + list[i].day);
        }
      }
    }
  });
  ok('round 2 keeps placed 90s and only splits the leftover 60',
    halfPool.unresolved.length === 0 && api.oneOneCoverageCount(halfPool) === 3
    && (halfByStu.S1 || []).length === 1 && (halfByStu.S1 || [])[0].duration === 90
    && (halfByStu.S2 || []).length === 1 && (halfByStu.S2 || [])[0].duration === 90
    && (halfByStu.S3 || []).length === 2 && (halfByStu.S3 || []).every(s => s.duration === 30),
    halfPool.scheduled.map(s => `${s.studentId} ${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${halfPool.unresolved.length}`);
  ok('split pieces share a day only when flush',
    sameDayGap.length === 0, sameDayGap.join(', '));

  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '09:00', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '08:30', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 1.5}}};
  const split60_30 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const durs6030 = split60_30.scheduled.map(s => s.end - s.start).sort((a,b) => b - a);
  ok('90 that cannot be 45+45 lands as 60+30',
    split60_30.unresolved.length === 0 && durs6030.join('+') === '60+30',
    split60_30.scheduled.map(s => `${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${split60_30.unresolved.length}`);

  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [
      {classId: 'CLX', day: 'MON', start: '08:15', end: '15:45'},
    ],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 0.5}}};
  const noHalf30 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('30-min lesson is never split into 15s',
    noHalf30.scheduled.length === 0 && noHalf30.unresolved.length === 1,
    noHalf30.scheduled.map(s => `${s.end-s.start}`).join(';'));

  console.log('\n== round 3 splits every cell when leftover-only still fails ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '09:30', type: 'AVAILABLE'},
      {teacherId: 'T1', day: 'TUE', start: '08:00', end: '09:30', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.oneToOne = {columns: [{id:'T1', name:'One'}], hours: {S1: {T1: 1}, S2: {T1: 2}}};
  const round3 = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const r3by = {};
  round3.scheduled.forEach(s => { (r3by[s.studentId] = r3by[s.studentId] || []).push(s.end - s.start); });
  ok('when leftover 120 cannot sit beside a placed 60, everyone is split from one pool',
    round3.unresolved.length === 0 && api.oneOneCoverageCount(round3) === 2
    && (r3by.S1 || []).slice().sort((a,b)=>a-b).join('+') === '30+30'
    && (r3by.S2 || []).slice().sort((a,b)=>a-b).join('+') === '60+60',
    round3.scheduled.map(s => `${s.studentId} ${s.day} ${api.toHHMM(s.start)}–${api.toHHMM(s.end)}`).join('; ')
    + ` unresolved=${round3.unresolved.length}`);

  console.log('\n== generate one teacher keeps the other ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T2', day: 'TUE', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id:'T2', name:'Two'}]);
  api.DB.oneToOne = {
    columns: [{id:'T1', name:'One'}, {id:'T2', name:'Two'}],
    hours: {S1: {T1: 1}, S2: {T2: 1}}
  };
  api.LAST_ONEONE = null;
  ok('scope T1 returns only T1 assignments',
    api.assignmentsForGenerate(api.DB.oneToOne, 'T1').length === 1
    && api.assignmentsForGenerate(api.DB.oneToOne, 'T1')[0].teacherId === 'T1');
  const onlyT1 = api.generateIndividualScoped('oneone', 'T1');
  api.applyIndividualSearch('oneone', onlyT1.variants, 'T1', 'T1');
  ok('first generate places only T1',
    (api.LAST_ONEONE.scheduled || []).length >= 1
    && (api.LAST_ONEONE.scheduled || []).every(s => s.teacherId === 'T1'),
    (api.LAST_ONEONE.scheduled || []).map(s => s.teacherId).join(','));
  const t1Kept = clone(api.LAST_ONEONE.scheduled[0]);
  const addT2 = api.generateIndividualScoped('oneone', 'T2');
  api.applyIndividualSearch('oneone', addT2.variants, 'T2', 'T2');
  ok('T2 generate keeps T1 slot',
    (api.LAST_ONEONE.scheduled || []).some(s =>
      s.teacherId === 'T1' && s.day === t1Kept.day && s.start === t1Kept.start && s.studentId === t1Kept.studentId),
    (api.LAST_ONEONE.scheduled || []).map(s => `${s.teacherId} ${s.day} ${s.start}`).join('; '));
  ok('T2 generate also places T2',
    (api.LAST_ONEONE.scheduled || []).some(s => s.teacherId === 'T2'));
  const t2Kept = clone((api.LAST_ONEONE.scheduled || []).find(s => s.teacherId === 'T2'));
  const redoT1 = api.generateIndividualScoped('oneone', 'T1');
  api.applyIndividualSearch('oneone', redoT1.variants, 'T1', 'T1');
  ok('regenerating T1 keeps T2',
    t2Kept && (api.LAST_ONEONE.scheduled || []).some(s =>
      s.teacherId === 'T2' && s.day === t2Kept.day && s.start === t2Kept.start && s.studentId === t2Kept.studentId));
  const allAgain = api.generateIndividualScoped('oneone', '');
  api.applyIndividualSearch('oneone', allAgain.variants, '', '');
  ok('All teachers still places both',
    (api.LAST_ONEONE.scheduled || []).some(s => s.teacherId === 'T1')
    && (api.LAST_ONEONE.scheduled || []).some(s => s.teacherId === 'T2'));

  console.log('\n== per-teacher room lock on 1/1 ==');
  installToy(api, seed, {
    teacherAvail: [
      {teacherId: 'T1', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
      {teacherId: 'T2', day: 'MON', start: '08:00', end: '16:00', type: 'AVAILABLE'},
    ],
    classAvail: [],
    accepted: [],
  });
  api.DB.refRooms = [{id: 'ROOM1', name: '321'}, {id: 'ROOM2', name: 'Drum'}];
  api.DB.refTeachers = (api.DB.refTeachers || []).concat([{id: 'T2', name: 'Two'}]);
  const unlocked = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 60, perStudent: 1, acceptedRows: []
  });
  ok('unlocked 1/1 still has no room',
    unlocked.scheduled.length === 1 && !unlocked.scheduled[0].roomId,
    unlocked.scheduled[0] && unlocked.scheduled[0].roomId);

  const locked = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 60, perStudent: 1,
    acceptedRows: [], roomId: 'ROOM1', room: '321'
  });
  ok('locked 1/1 copies the room onto the session',
    locked.scheduled.length === 1 && locked.scheduled[0].roomId === 'ROOM1' && locked.scheduled[0].room === '321',
    locked.scheduled[0] ? `${locked.scheduled[0].roomId} ${locked.scheduled[0].room}` : 'unplaced');

  const againstRoom = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 60, perStudent: 1,
    roomId: 'ROOM1', room: '321',
    acceptedRows: [{
      status: 'scheduled', teacherId: 'T9', day: 'MON', start: 8*60, end: 9*60,
      studentIds: 'SX', name: 'Group', roomId: 'ROOM1', room: '321'
    }]
  });
  ok('1/1 with room lock skips the occupied studio',
    againstRoom.scheduled.length === 1
    && againstRoom.scheduled[0].roomId === 'ROOM1'
    && !(againstRoom.scheduled[0].start < 9*60 && againstRoom.scheduled[0].end > 8*60),
    againstRoom.scheduled[0]
      ? `${api.toHHMM(againstRoom.scheduled[0].start)}–${api.toHHMM(againstRoom.scheduled[0].end)}`
      : (againstRoom.unresolved[0] && againstRoom.unresolved[0].reason));

  const stuffed = [];
  for(let t = 8*60; t < 16*60; t += 60){
    stuffed.push({
      status: 'scheduled', teacherId: 'T9', day: 'MON', start: t, end: t + 60,
      studentIds: 'SX', name: 'Block', roomId: 'ROOM1', room: '321'
    });
  }
  const noHole = api.scheduleOneToOne({
    teacherId: 'T1', studentIds: ['S1'], duration: 60, perStudent: 1,
    roomId: 'ROOM1', room: '321', acceptedRows: stuffed
  });
  ok('full room-lock day leaves the student unplaced',
    noHole.scheduled.length === 0 && noHole.unresolved.length === 1,
    `scheduled=${noHole.scheduled.length} unresolved=${noHole.unresolved.length}`);

  api.DB.oneToOne = {
    columns: [
      {id: 'T1', name: 'One', roomId: 'ROOM1', room: '321'},
      {id: 'T2', name: 'Two', roomId: 'ROOM1', room: '321'}
    ],
    hours: {S1: {T1: 1}, S2: {T2: 1}}
  };
  const shared = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  ok('two teachers sharing a studio both place',
    shared.scheduled.length === 2 && shared.scheduled.every(s => s.roomId === 'ROOM1'),
    shared.scheduled.map(s => `${s.teacherId} ${s.roomId} ${s.day} ${s.start}`).join('; '));
  ok('shared studio sessions do not overlap',
    shared.scheduled.length === 2
    && !(shared.scheduled[0].day === shared.scheduled[1].day
      && overlaps(shared.scheduled[0], shared.scheduled[1])),
    shared.scheduled.map(s => `${s.teacherId} ${s.day} ${s.start}-${s.end}`).join('; '));

  const parsedLock = api.parseOneToOneTable([
    {STUDENT_ID: 'S1', NAME1: 'Stu', INSTR: 'piano', 'OneOne Teacher': '1'}
  ], [{id: 'T1', name: 'OneOne Teacher'}]);
  const merged = api.mergeMatrixColumnRooms(parsedLock, {
    columns: [{id: 'T1', name: 'OneOne Teacher', roomId: 'ROOM1', room: '321'}]
  });
  ok('Drive 1_1 reload keeps the teacher room lock',
    merged.columns.some(c => c.id === 'T1' && c.roomId === 'ROOM1'),
    JSON.stringify(merged.columns));
  const driveBlank = api.parseOneToOneTable([
    {STUDENT_ID: 'ROOM_LOCK', 'OneOne Teacher': ''},
    {STUDENT_ID: 'S1', NAME1: 'Stu', INSTR: 'piano', 'OneOne Teacher': '1'}
  ], [{id: 'T1', name: 'OneOne Teacher'}], [{id: 'ROOM1', name: '321'}]);
  const cleared = api.mergeMatrixColumnRooms(driveBlank, {
    columns: [{id: 'T1', name: 'OneOne Teacher', roomId: 'ROOM1', room: '321'}]
  });
  ok('Drive ROOM_LOCK blank clears a previous app lock',
    driveBlank.hasRoomRow && !(cleared.columns.find(c => c.id === 'T1') || {}).roomId);
  const driveColBlank = api.parseOneToOneTable([
    {STUDENT_ID: 'S1', NAME1: 'Stu', INSTR: 'piano', 'OneOne Teacher': '1', 'OneOne Teacher_ROOM': ''}
  ], [{id: 'T1', name: 'OneOne Teacher'}], [{id: 'ROOM1', name: '321'}]);
  const clearedCol = api.mergeMatrixColumnRooms(driveColBlank, {
    columns: [{id: 'T1', name: 'OneOne Teacher', roomId: 'ROOM1', room: '321'}]
  });
  ok('Drive Tanár_ROOM blank clears a previous app lock',
    (driveColBlank.roomColumnIds || []).includes('T1')
    && !(clearedCol.columns.find(c => c.id === 'T1') || {}).roomId);

  const parsedStuLock = api.parseOneToOneTable([
    {STUDENT_ID: 'S1', NAME1: 'Stu', INSTR: 'piano', ROOM: '321', 'OneOne Teacher': '1'}
  ], [{id: 'T1', name: 'OneOne Teacher'}], [{id: 'ROOM1', name: '321'}]);
  ok('Drive student ROOM parses onto that student',
    parsedStuLock.hasStudentRooms && ((parsedStuLock.studentRooms || {}).S1 || {}).roomId === 'ROOM1');
  const driveStuBlank = api.parseOneToOneTable([
    {STUDENT_ID: 'S1', NAME1: 'Stu', INSTR: 'piano', ROOM: '', 'OneOne Teacher': '1'}
  ], [{id: 'T1', name: 'OneOne Teacher'}], [{id: 'ROOM1', name: '321'}]);
  const clearedStu = api.mergeMatrixColumnRooms(driveStuBlank, {
    columns: [{id: 'T1', name: 'OneOne Teacher'}],
    studentRooms: {S1: {roomId: 'ROOM1', room: '321'}}
  });
  ok('Drive student ROOM blank clears a previous student lock',
    driveStuBlank.hasStudentRooms && !((clearedStu.studentRooms || {}).S1 || {}).roomId);

  console.log('\n== per-student room lock on 1/1 ==');
  api.DB.oneToOne = {
    columns: [{id: 'T1', name: 'One'}, {id: 'T2', name: 'Two'}],
    hours: {S1: {T1: 1, T2: 1}, S2: {T1: 1}},
    studentRooms: {S1: {roomId: 'ROOM1', room: '321'}}
  };
  const byStu = api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: []});
  const s1Sessions = byStu.scheduled.filter(s => s.studentId === 'S1');
  const s2Sessions = byStu.scheduled.filter(s => s.studentId === 'S2');
  ok('student room lock copies onto every teacher of that student',
    s1Sessions.length === 2 && s1Sessions.every(s => s.roomId === 'ROOM1' && s.room === '321'),
    s1Sessions.map(s => `${s.teacherId} ${s.roomId}`).join('; '));
  ok('student without a room stays unlocked',
    s2Sessions.length === 1 && !s2Sessions[0].roomId,
    s2Sessions[0] && s2Sessions[0].roomId);
  ok('one student locked to a studio does not overlap themselves',
    s1Sessions.length === 2
    && !(s1Sessions[0].day === s1Sessions[1].day && overlaps(s1Sessions[0], s1Sessions[1])),
    s1Sessions.map(s => `${s.teacherId} ${s.day} ${s.start}-${s.end}`).join('; '));

  const againstStu = api.scheduleAllOneToOne({
    matrix: {
      columns: [{id: 'T1', name: 'One'}],
      hours: {S1: {T1: 1}},
      studentRooms: {S1: {roomId: 'ROOM1', room: '321'}}
    },
    acceptedRows: [{
      status: 'scheduled', teacherId: 'T9', day: 'MON', start: 8*60, end: 9*60,
      studentIds: 'SX', name: 'Group', roomId: 'ROOM1', room: '321'
    }]
  });
  ok('student room lock skips the occupied studio',
    againstStu.scheduled.length === 1
    && againstStu.scheduled[0].roomId === 'ROOM1'
    && !(againstStu.scheduled[0].start < 9*60 && againstStu.scheduled[0].end > 8*60),
    againstStu.scheduled[0]
      ? `${api.toHHMM(againstStu.scheduled[0].start)}–${api.toHHMM(againstStu.scheduled[0].end)}`
      : (againstStu.unresolved[0] && againstStu.unresolved[0].reason));

  const stuWins = api.scheduleAllOneToOne({
    matrix: {
      columns: [{id: 'T1', name: 'One', roomId: 'ROOM2', room: 'Drum'}],
      hours: {S1: {T1: 1}},
      studentRooms: {S1: {roomId: 'ROOM1', room: '321'}}
    },
    acceptedRows: []
  });
  ok('student ROOM wins over a leftover teacher column lock',
    stuWins.scheduled.length === 1 && stuWins.scheduled[0].roomId === 'ROOM1',
    stuWins.scheduled[0] && stuWins.scheduled[0].roomId);

  api.DB.students = [{ID:'S1', NAME1:'Ann', NAME2:'', NAME3:'', PUBLIC_NAME:'', INSTR:'piano', INSTR_ID:'INST6'}];
  api.DB.oneToOne = {
    columns: [{id: 'T1', name: 'One'}],
    hours: {S1: {T1: 1}},
    studentRooms: {S1: {roomId: 'ROOM1', room: '321'}}
  };
  const expStu = api.oneToOneAoa(api.DB);
  ok('export puts ROOM after INSTR_ID',
    expStu.aoa[0][6] === 'INSTR_ID' && expStu.aoa[0][7] === 'ROOM',
    (expStu.aoa[0] || []).slice(0, 10).join(','));
  ok('export writes the student room, not a teacher _ROOM column',
    expStu.aoa[1][7] === '321'
    && !(expStu.aoa[0] || []).some(h => String(h).endsWith('_ROOM')),
    (expStu.aoa[0] || []).join(','));

  console.log(`\n${passed} passed, ${failed} failed`);
  if(failures.length){
    console.error(failures.map(f => '  - ' + f).join('\n'));
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
