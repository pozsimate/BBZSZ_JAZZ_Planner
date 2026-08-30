const DAYS = ['MON','TUE','WED','THU','FRI'];
const AVAIL_TYPES = ['AVAILABLE','PREFERRED','FALLBACK','CANDIDATE','AVOID'];
const SMALL_GROUP_TYPES = ['bass','drum','acc','sol'];
const BREAK_MINS = [15, 30, 45, 60, 90];
const DURATIONS = [45, 60, 75, 90];

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function hhmm(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}

function snap15(mins){
  return Math.round(mins / 15) * 15;
}

function randomSlot(rng, duration){
  const day = rng.pick(DAYS);
  const latest = 20*60 - duration;
  const start = snap15(rng.int(8*60, latest));
  return {day, start: hhmm(start), end: hhmm(start + duration)};
}

function pinItem(rng, obj){
  const dur = parseInt(obj.duration, 10) > 0 ? parseInt(obj.duration, 10) : 90;
  const slot = randomSlot(rng, dur);
  obj.fixedDay = slot.day;
  obj.fixedStart = slot.start;
  obj.fixedEnd = slot.end;
}

function clearPin(obj){
  obj.fixedDay = '';
  obj.fixedStart = '';
  obj.fixedEnd = '';
}

export const FAMILIES = [
  'fixedLessons',
  'fixedSmallGroups',
  'lockedTeachers',
  'breaks',
  'classReservations',
  'smallGroupQuotas',
  'teacherAvail',
  'lessonFlags',
  'smallGroupFlags',
];

function mutateFixedLessons(db, rng, ops, intensity){
  const n = intensity === 'chaos'
    ? rng.int(Math.ceil(db.lessons.length * 0.3), db.lessons.length)
    : rng.int(1, Math.min(12, db.lessons.length));
  rng.sample(db.lessons, n).forEach(l => {
    if(rng.bool(0.15)){ clearPin(l); ops.push(`unpin lesson ${l.id}`); return; }
    pinItem(rng, l);
    ops.push(`pin lesson ${l.id} ${l.fixedDay} ${l.fixedStart}–${l.fixedEnd}`);
  });
}

function mutateFixedSmallGroups(smallGroups, rng, ops, intensity){
  if(!smallGroups.length) return;
  const n = intensity === 'chaos'
    ? rng.int(Math.ceil(smallGroups.length * 0.4), smallGroups.length)
    : rng.int(1, Math.min(8, smallGroups.length));
  const chosen = new Set(rng.sample(smallGroups, n));
  smallGroups.forEach((b, i) => {
    if(!chosen.has(b)) return;
    if(rng.bool(0.2)){ clearPin(b); ops.push(`unpin SG${i+1}`); return; }
    pinItem(rng, b);
    ops.push(`pin SG${i+1} ${b.fixedDay} ${b.fixedStart}–${b.fixedEnd}`);
  });
}

function mutateLockedTeachers(db, smallGroups, rng, ops, intensity){
  if(!smallGroups.length) return;
  const quotaIds = (db.smallGroupQuotas || []).map(q => q.teacherId).filter(Boolean);
  const pool = quotaIds.length && rng.bool(0.7) ? quotaIds : db.refTeachers.map(t => t.id);
  const n = intensity === 'chaos'
    ? rng.int(Math.ceil(smallGroups.length * 0.5), smallGroups.length)
    : rng.int(1, Math.min(10, smallGroups.length));
  rng.sample(smallGroups, n).forEach(b => {
    if(rng.bool(0.2)){ b.teacherId = ''; ops.push('unlock a small group teacher'); return; }
    b.teacherId = rng.pick(pool);
    const name = (db.refTeachers.find(t => t.id === b.teacherId) || {}).name || b.teacherId;
    ops.push(`lock small group teacher ${name}`);
  });
}

function mutateBreaks(db, rng, ops, intensity){
  db.breaks = db.breaks || [];
  if(intensity === 'chaos' || rng.bool(0.4)){
    const wipe = rng.int(0, db.breaks.length);
    if(wipe){
      db.breaks = rng.sample(db.breaks, db.breaks.length - wipe);
      ops.push(`drop ${wipe} break row(s)`);
    }
  }
  const listed = new Set(db.breaks.map(b => b.teacherId));
  const available = db.refTeachers.filter(t => !listed.has(t.id));
  const addN = intensity === 'chaos'
    ? rng.int(3, Math.min(12, available.length))
    : rng.int(1, Math.min(6, available.length));
  rng.sample(available, addN).forEach((t, i) => {
    const row = {
      id: 'BRID' + (db.breaks.length + 1 + i),
      teacherId: t.id,
      teacher: t.name,
      breakMinutes: rng.pick(BREAK_MINS),
      breakCount: rng.int(1, intensity === 'chaos' ? 8 : 4),
    };
    db.breaks.push(row);
    ops.push(`break ${t.name} ${row.breakMinutes}×${row.breakCount}`);
  });
  db.breaks.forEach(b => {
    if(rng.bool(0.25)){
      b.breakMinutes = rng.pick(BREAK_MINS);
      b.breakCount = rng.int(0, 6);
      ops.push(`tweak break ${b.teacher || b.teacherId} → ${b.breakMinutes}×${b.breakCount}`);
    }
  });
}

function mutateClassReservations(db, rng, ops, intensity){
  db.classAvail = db.classAvail || [];
  const dropN = intensity === 'chaos'
    ? rng.int(Math.ceil(db.classAvail.length * 0.2), Math.ceil(db.classAvail.length * 0.7))
    : rng.int(1, Math.min(25, db.classAvail.length));
  if(db.classAvail.length && dropN){
    const keep = db.classAvail.length - dropN;
    db.classAvail = rng.sample(db.classAvail, Math.max(0, keep));
    ops.push(`drop ${dropN} class reservation(s)`);
  }
  const addN = intensity === 'chaos' ? rng.int(8, 30) : rng.int(2, 14);
  for(let i=0;i<addN;i++){
    const cls = rng.pick(db.refClasses);
    const dur = rng.pick([60, 90, 120, 180, 240]);
    const slot = randomSlot(rng, dur);
    db.classAvail.push({
      class: cls.name,
      classId: cls.id,
      day: slot.day,
      start: slot.start,
      end: slot.end,
      note: 'endurance-fuzz',
    });
  }
  ops.push(`add ${addN} class reservation(s)`);
  db.classAvail.forEach(r => {
    if(rng.bool(0.12)){
      const dur = rng.pick([45, 60, 90, 150]);
      const slot = randomSlot(rng, dur);
      r.day = slot.day; r.start = slot.start; r.end = slot.end;
      ops.push(`shift reservation ${r.class} → ${r.day} ${r.start}–${r.end}`);
    }
  });
}

function mutateSmallGroupQuotas(db, rng, ops, intensity){
  db.smallGroupQuotas = db.smallGroupQuotas || [];
  if(db.smallGroupQuotas.length && (intensity === 'chaos' || rng.bool(0.45))){
    const dropN = rng.int(1, Math.min(4, db.smallGroupQuotas.length));
    db.smallGroupQuotas = rng.sample(db.smallGroupQuotas, db.smallGroupQuotas.length - dropN);
    ops.push(`drop ${dropN} quota row(s)`);
  }
  const listed = new Set(db.smallGroupQuotas.map(q => q.teacherId));
  const available = db.refTeachers.filter(t => !listed.has(t.id));
  const addN = intensity === 'chaos'
    ? rng.int(1, Math.min(8, available.length))
    : rng.int(0, Math.min(4, available.length));
  rng.sample(available, addN).forEach((t, i) => {
    const amount = rng.int(0, intensity === 'chaos' ? 6 : 4);
    db.smallGroupQuotas.push({
      id: 'SMGQ' + (db.smallGroupQuotas.length + 1 + i),
      teacherId: t.id,
      teacher: t.name,
      amount,
    });
    ops.push(`quota ${t.name}=${amount}`);
  });
  db.smallGroupQuotas.forEach(q => {
    if(rng.bool(0.55)){
      q.amount = rng.int(0, intensity === 'chaos' ? 7 : 5);
      ops.push(`quota ${q.teacher || q.teacherId}→${q.amount}`);
    }
  });
}

function mutateTeacherAvail(db, rng, ops, intensity){
  db.teacherAvail = db.teacherAvail || [];
  if(db.teacherAvail.length && rng.bool(intensity === 'chaos' ? 0.7 : 0.4)){
    const dropN = rng.int(1, Math.min(intensity === 'chaos' ? 20 : 10, db.teacherAvail.length));
    db.teacherAvail = rng.sample(db.teacherAvail, db.teacherAvail.length - dropN);
    ops.push(`drop ${dropN} teacher-avail row(s)`);
  }
  const addN = intensity === 'chaos' ? rng.int(4, 18) : rng.int(1, 8);
  for(let i=0;i<addN;i++){
    const t = rng.pick(db.refTeachers);
    const type = rng.pick(AVAIL_TYPES);
    const start = type === 'AVOID' ? '' : hhmm(snap15(rng.int(8*60, 14*60)));
    const end = type === 'AVOID' ? '' : hhmm(snap15(rng.int(15*60, 20*60)));
    db.teacherAvail.push({
      teacher: t.name, teacherId: t.id,
      day: rng.pick(DAYS), start, end, type, scope: 'ALL', option: 'endurance-fuzz',
    });
  }
  ops.push(`add ${addN} teacher-avail row(s)`);
  db.teacherAvail.forEach(r => {
    if(rng.bool(0.2)){
      r.type = rng.pick(AVAIL_TYPES);
      ops.push(`avail ${r.teacher} ${r.day} → ${r.type}`);
    }
  });
}

function mutateLessonFlags(db, rng, ops, intensity){
  const n = intensity === 'chaos' ? rng.int(8, db.lessons.length) : rng.int(2, 10);
  rng.sample(db.lessons, n).forEach(l => {
    if(rng.bool(0.5)){
      const rooms = db.refRooms || [];
      l.roomId = rng.bool(0.5) ? rng.pick(rooms.map(r => r.id).concat([''])) : '';
      const hit = rooms.find(r => r.id === l.roomId);
      l.room = hit ? hit.name : '';
      ops.push(`lesson ${l.id} room=${l.roomId || 'none'}`);
    }
    if(rng.bool(0.45)){
      l.duration = rng.pick(DURATIONS);
      if(l.fixedStart) pinItem(rng, l);
      ops.push(`lesson ${l.id} duration=${l.duration}`);
    }
  });
}

function mutateSmallGroupFlags(smallGroups, rng, ops, intensity, db){
  if(!smallGroups.length) return;
  const rooms = (db && db.refRooms) || [];
  const n = intensity === 'chaos' ? smallGroups.length : rng.int(1, smallGroups.length);
  rng.sample(smallGroups, n).forEach(b => {
    if(rng.bool(0.5)){
      if(!rooms.length || rng.bool(0.3)){
        b.roomId = '';
        b.room = '';
      } else {
        const r = rng.pick(rooms);
        b.roomId = r.id;
        b.room = r.name;
      }
      ops.push(`small group room=${b.roomId || 'none'}`);
    }
    if(rng.bool(0.45)){
      b.duration = rng.pick(DURATIONS);
      if(b.fixedStart) pinItem(rng, b);
      ops.push(`small group duration=${b.duration}`);
    }
  });
}

function emptySmallGroupRecord(){
  return {bass:[], drum:[], acc:[], sol:[], teacherId:'', roomId:'', room:'', duration:90, fixedDay:'', fixedStart:'', fixedEnd:''};
}

function studentType(db, s){
  const inst = (db.refInstruments || []).find(i => i.id === s.INSTR_ID);
  return (inst && inst.type) || '';
}

function randomSmallGroups(db, rng, n){
  const eligible = db.students.filter(s => {
    const cls = (db.refClasses || []).find(c => c.id === s.CLASS_ID);
    return cls && cls.muclass;
  });
  const byType = {bass:[], drum:[], acc:[], sol:[]};
  eligible.forEach(s => {
    const t = studentType(db, s);
    if(byType[t]) byType[t].push(s);
  });
  const smallGroups = Array.from({length:n}, emptySmallGroupRecord);
  smallGroups.forEach(b => {
    SMALL_GROUP_TYPES.forEach(t => {
      const pool = byType[t];
      if(!pool || !pool.length) return;
      const take = rng.bool(0.12) ? rng.int(1, Math.min(2, pool.length)) : 1;
      rng.sample(pool, take).forEach(s => b[t].push(s));
    });
    const rooms = db.refRooms || [];
    if(rooms.length && rng.bool(0.75)){
      const r = rng.pick(rooms);
      b.roomId = r.id;
      b.room = r.name;
    } else {
      b.roomId = '';
      b.room = '';
    }
    b.duration = rng.pick(DURATIONS);
  });
  return {smallGroups, excluded:[], appearances:{}, eligibleCount: eligible.length, generated:'random'};
}

export function buildScenario(api, seed, rng, profile){
  const db = clone(seed);
  const ops = [`profile=${profile}`];
  const intensity = profile === 'chaos' ? 'chaos' : 'normal';

  let families;
  if(profile === 'baseline'){
    families = [];
  } else if(profile === 'single'){
    families = [rng.pick(FAMILIES.filter(f => f !== 'fixedSmallGroups' && f !== 'lockedTeachers' && f !== 'smallGroupFlags'))];
  } else if(profile === 'combo'){
    families = rng.sample(FAMILIES, rng.int(3, 6));
  } else {
    families = FAMILIES.slice();
  }
  ops.push(`families=${families.join(',') || 'none'}`);

  const preSmallGroupFamilies = new Set(['fixedLessons','breaks','classReservations','smallGroupQuotas','teacherAvail','lessonFlags']);
  families.filter(f => preSmallGroupFamilies.has(f)).forEach(f => {
    if(f === 'fixedLessons') mutateFixedLessons(db, rng, ops, intensity);
    else if(f === 'breaks') mutateBreaks(db, rng, ops, intensity);
    else if(f === 'classReservations') mutateClassReservations(db, rng, ops, intensity);
    else if(f === 'smallGroupQuotas') mutateSmallGroupQuotas(db, rng, ops, intensity);
    else if(f === 'teacherAvail') mutateTeacherAvail(db, rng, ops, intensity);
    else if(f === 'lessonFlags') mutateLessonFlags(db, rng, ops, intensity);
  });

  api.DB = db;
  const smallGroupCount = profile === 'chaos' ? rng.int(10, 22) : rng.int(12, 18);
  const useRandomRoster = profile !== 'baseline' && rng.bool(profile === 'chaos' ? 0.45 : 0.25);
  const smallGroupsState = useRandomRoster
    ? randomSmallGroups(db, rng, smallGroupCount)
    : Object.assign(api.generateSmallGroups(smallGroupCount), {generated:'algorithm', smallGroupCount});
  ops.push(`${smallGroupsState.generated} small groups × ${smallGroupsState.smallGroups.length}`);

  families.forEach(f => {
    if(f === 'fixedSmallGroups') mutateFixedSmallGroups(smallGroupsState.smallGroups, rng, ops, intensity);
    else if(f === 'lockedTeachers') mutateLockedTeachers(db, smallGroupsState.smallGroups, rng, ops, intensity);
    else if(f === 'smallGroupFlags') mutateSmallGroupFlags(smallGroupsState.smallGroups, rng, ops, intensity, db);
  });

  api.LAST_SMALL_GROUPS = smallGroupsState;
  return {db, smallGroups: smallGroupsState, ops, families, profile};
}

export function pickProfile(rng, index){
  if(index === 0) return 'baseline';
  const roll = rng.next();
  if(roll < 0.18) return 'single';
  if(roll < 0.55) return 'combo';
  if(roll < 0.88) return 'chaos';
  return 'baseline';
}
