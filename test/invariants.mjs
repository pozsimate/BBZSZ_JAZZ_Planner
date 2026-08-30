// Independent hard-rule checker. Reimplements the constraints from scratch so a
// bug in the scheduler cannot hide behind the scheduler's own helpers.

const DAYS = ['MON','TUE','WED','THU','FRI'];
const TYPE_RANK = {AVAILABLE:0, PREFERRED:0, FALLBACK:1, CANDIDATE:2};
const DEFAULT_START = 8*60, DEFAULT_END = 20*60;
const GROUP_FIELDS = ['IMPR_ID','VOC_ID','JTH_ID','SOLF_ID','JHIST_ID','RHIMPR_ID','AC_ID'];
const SMALL_GROUP_TYPES = ['bass','drum','acc','sol'];

export function isSmallGroupId(id){
  return /^SG\d+$/i.test(String(id || ''));
}

function toMin(t){
  if(!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t).trim());
  if(!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}
function toHHMM(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function overlap(aS,aE,bS,bE){ return aS < bE && bS < aE; }

function subtractBusy(intervals, busy){
  const cuts = (busy || []).slice().sort((x,y) => x.start - y.start);
  let cur = (intervals || []).map(iv => iv.slice());
  cuts.forEach(b => {
    const next = [];
    cur.forEach(([s,e]) => {
      if(b.end <= s || b.start >= e){ next.push([s,e]); return; }
      if(b.start > s) next.push([s, Math.min(b.start, e)]);
      if(b.end < e) next.push([Math.max(b.end, s), e]);
    });
    cur = next.filter(([s,e]) => e > s);
  });
  return cur;
}
function windowIntervals(win){
  if(!win) return [];
  if(Array.isArray(win.intervals) && win.intervals.length) return win.intervals;
  return [[win.start, win.end]];
}
function slotFitsWin(win, start, end){
  return windowIntervals(win).some(([s,e]) => start >= s && end <= e);
}
function availableMinutesBetween(intervals, from, to){
  if(!(to > from)) return 0;
  let n = 0;
  (intervals || []).forEach(([s,e]) => {
    const a = Math.max(from, s), b = Math.min(to, e);
    if(b > a) n += b - a;
  });
  return n;
}
function breakGapBetweenIntervals(intervals, prevEnd, curStart){
  const ivs = intervals || [];
  const prevIv = ivs.find(([s,e]) => prevEnd > s && prevEnd <= e);
  const curIv = ivs.find(([s,e]) => curStart >= s && curStart < e);
  if(prevIv && curIv && prevIv[0] === curIv[0] && prevIv[1] === curIv[1]){
    return availableMinutesBetween(ivs, prevEnd, curStart);
  }
  return 0;
}
function availScopeOf(row){
  const s = String((row && row.scope) || 'ALL').trim().toUpperCase();
  if(s === 'O2O' || s === '1/1' || s === 'ONEONE' || s === 'INDIVIDUAL' || s === 'PIANO') return 'O2O';
  if(s === 'GROUP' || s === 'GROUPS' || s === 'SG') return 'GROUP';
  return 'ALL';
}
function availMatchesKind(row, kind){
  if(!kind || kind === 'any') return true;
  const scope = availScopeOf(row);
  if(scope === 'ALL') return true;
  if(kind === 'group') return scope === 'GROUP';
  if(kind === 'oneone') return scope === 'O2O';
  return true;
}
function placementKind(p){
  if(!p) return 'any';
  if(p.source === 'oneone' || p.source === 'rpiano') return 'oneone';
  const id = String(p.lessonId || '');
  if(id.startsWith('O2O-') || id.startsWith('RP-')) return 'oneone';
  return 'group';
}
function teacherWindows(db, teacherId, kind){
  const rows = (db.teacherAvail || []).filter(r => r.teacherId === teacherId && r.type !== 'AVOID' && r.day && DAYS.includes(r.day) && availMatchesKind(r, kind));
  const byDay = {};
  rows.forEach(r => {
    const rank = TYPE_RANK[r.type] ?? 2;
    const start = toMin(r.start) ?? DEFAULT_START;
    const end = toMin(r.end) ?? DEFAULT_END;
    if(!byDay[r.day] || rank < byDay[r.day].rank){
      byDay[r.day] = {start, end, rank};
    } else if(rank === byDay[r.day].rank){
      byDay[r.day].start = Math.min(byDay[r.day].start, start);
      byDay[r.day].end = Math.max(byDay[r.day].end, end);
    }
  });
  Object.keys(byDay).forEach(day => {
    const w = byDay[day];
    const avoided = (db.teacherAvail || [])
      .filter(r => r.teacherId === teacherId && r.type === 'AVOID' && r.day === day && availMatchesKind(r, kind))
      .map(r => ({start: toMin(r.start) ?? DEFAULT_START, end: toMin(r.end) ?? DEFAULT_END}))
      .filter(iv => iv.end > iv.start);
    const ivs = subtractBusy([[w.start, w.end]], avoided);
    if(!ivs.length){
      delete byDay[day];
      return;
    }
    w.intervals = ivs;
    w.start = ivs[0][0];
    w.end = ivs[ivs.length - 1][1];
  });
  return byDay;
}

function breakSettings(db, teacherId){
  if(!(db && db.forbidUnlistedGroupGaps)){
    return { minutes: 0, count: 0, unconstrained: true };
  }
  const b = (db.breaks || []).find(r => r.teacherId === teacherId);
  if(!b) return { minutes: 0, count: 0, unconstrained: false };
  return {
    minutes: Math.max(0, parseInt(b.breakMinutes, 10) || 0),
    count: Math.max(0, parseInt(b.breakCount, 10) || 0),
    unconstrained: false
  };
}

function smallGroupByLessonId(smallGroups, lessonId){
  if(!smallGroups || !lessonId) return null;
  const found = smallGroups.find(b => b.id === lessonId);
  if(found) return found;
  if(smallGroups.some(b => b.id)) return null;
  const idx = parseInt(String(lessonId).replace(/^SG/i, ''), 10) - 1;
  return idx >= 0 ? smallGroups[idx] || null : null;
}
function membersOf(db, smallGroups, lessonId){
  if(isSmallGroupId(lessonId)){
    const sg = smallGroupByLessonId(smallGroups, lessonId);
    if(!sg) return [];
    return SMALL_GROUP_TYPES.flatMap(t => sg[t] || []);
  }
  const lesson = (db.lessons || []).find(l => l.id === lessonId);
  if(!lesson) return [];
  return (db.students || []).filter(s => GROUP_FIELDS.some(f => s[f] === lesson.groupId));
}

function sourceOf(db, smallGroups, lessonId){
  if(isSmallGroupId(lessonId)){
    const sg = smallGroupByLessonId(smallGroups, lessonId);
    return sg ? {kind:'smallgroup', id:lessonId, src:sg} : null;
  }
  const lesson = (db.lessons || []).find(l => l.id === lessonId);
  return lesson ? {kind:'lesson', id:lessonId, src:lesson} : null;
}

function expectedDuration(kind, src){
  const n = parseInt(src && src.duration, 10);
  if(n > 0) return n;
  return kind === 'smallgroup' ? 90 : 45;
}

function pinnedWindow(src){
  if(!src || !src.fixedDay || !DAYS.includes(src.fixedDay)) return null;
  const start = toMin(src.fixedStart);
  if(start == null) return null;
  const n = parseInt(src.duration, 10);
  const dur = n > 0 ? n : 90;
  return {day: src.fixedDay, start, end: start + dur};
}

function label(p){
  return `${p.name || p.lessonId} ${p.day} ${toHHMM(p.start)}–${toHHMM(p.end)}`;
}

export function checkSchedule(db, smallGroups, result){
  const errors = [];
  const scheduled = (result && result.scheduled) || [];
  const unresolved = (result && result.unresolved) || [];
  const smallGroupList = (smallGroups && smallGroups.smallGroups) || smallGroups || [];

  const scheduledIds = new Set();
  scheduled.forEach(p => {
    if(scheduledIds.has(p.lessonId)) errors.push(`duplicate scheduled id ${p.lessonId}`);
    scheduledIds.add(p.lessonId);
  });
  unresolved.forEach(u => {
    const id = u.lesson && u.lesson.id;
    if(id && scheduledIds.has(id)) errors.push(`${id} is both scheduled and unresolved`);
  });

  (db.lessons || []).forEach(l => {
    const placed = scheduled.some(p => p.lessonId === l.id);
    const failed = unresolved.some(u => u.lesson && u.lesson.id === l.id);
    if(!placed && !failed) errors.push(`lesson ${l.id} (${l.name}) missing from scheduled and unresolved`);
  });
  smallGroupList.forEach((b, i) => {
    const members = SMALL_GROUP_TYPES.flatMap(t => b[t] || []);
    if(members.length === 0) return;
    const id = b.id || ('SG' + (i+1));
    const placed = scheduled.some(p => p.lessonId === id);
    const failed = unresolved.some(u => u.lesson && u.lesson.id === id);
    if(!placed && !failed) errors.push(`${id} has members but is missing from scheduled and unresolved`);
  });

  scheduled.forEach(p => {
    if(!DAYS.includes(p.day)) errors.push(`${label(p)}: invalid day`);
    if(!(p.start < p.end)) errors.push(`${label(p)}: end is not after start`);
    if(p.start < DEFAULT_START || p.end > DEFAULT_END){
      errors.push(`${label(p)}: outside school day 08:00–20:00`);
    }
    const src = sourceOf(db, smallGroupList, p.lessonId);
    if(!src){
      errors.push(`${label(p)}: unknown lesson/small group id`);
      return;
    }
    const dur = expectedDuration(src.kind, src.src);
    if(p.end - p.start !== dur){
      errors.push(`${label(p)}: booked ${p.end-p.start} min, duration is ${dur}`);
    }
    const pin = pinnedWindow(src.src);
    if(pin && (p.day !== pin.day || p.start !== pin.start || p.end !== pin.end)){
      errors.push(`${label(p)}: pinned to ${pin.day} ${toHHMM(pin.start)}–${toHHMM(pin.end)} but landed elsewhere`);
    }
    if(!p.teacherId){
      errors.push(`${label(p)}: scheduled without a teacher`);
    } else {
      const win = teacherWindows(db, p.teacherId, placementKind(p))[p.day];
      if(!win) errors.push(`${label(p)}: teacher ${p.teacherId} has no availability on ${p.day}`);
      else if(!slotFitsWin(win, p.start, p.end)){
        const ranges = windowIntervals(win).map(([s,e]) => `${toHHMM(s)}–${toHHMM(e)}`).join(', ');
        errors.push(`${label(p)}: teacher ${p.teacherId} only free ${ranges}`);
      }
    }
    const members = membersOf(db, smallGroupList, p.lessonId);
    members.forEach(s => {
      if(!s.CLASS_ID) return;
      const hit = (db.classAvail || []).find(r => {
        if(r.classId !== s.CLASS_ID || r.day !== p.day) return false;
        const rs = toMin(r.start) ?? DEFAULT_START;
        const re = toMin(r.end) ?? DEFAULT_END;
        return overlap(p.start, p.end, rs, re);
      });
      if(hit){
        const pin = pinnedWindow(src.src);
        if(pin && p.day === pin.day && p.start === pin.start && p.end === pin.end){
          // Pinned slot overlapping a class reservation is placed with a UI warning,
          // not treated as a hard invariant failure.
        } else {
          errors.push(`${label(p)}: ${s.NAME1} ${s.NAME2} (${s.CLASS || s.CLASS_ID}) overlaps class reservation ${hit.start}–${hit.end}`);
        }
      }
    });
  });

  function clashPairs(items, keyFn, kind){
    const buckets = {};
    items.forEach(p => {
      const key = keyFn(p);
      if(!key) return;
      (key instanceof Set ? [...key] : [key]).forEach(k => {
        buckets[k] = buckets[k] || [];
        buckets[k].push(p);
      });
    });
    Object.entries(buckets).forEach(([k, list]) => {
      for(let i=0;i<list.length;i++){
        for(let j=i+1;j<list.length;j++){
          const a = list[i], b = list[j];
          if(a.day === b.day && overlap(a.start, a.end, b.start, b.end)){
            errors.push(`${kind} ${k}: ${label(a)} overlaps ${label(b)}`);
          }
        }
      }
    });
  }

  clashPairs(scheduled, p => p.teacherId, 'teacher');
  clashPairs(scheduled.filter(p => p.roomId), p => p.roomId, 'room');
  clashPairs(scheduled, p => new Set(membersOf(db, smallGroupList, p.lessonId).map(s => s.ID)), 'student');

  const byTeacher = {};
  scheduled.forEach(p => {
    if(!p.teacherId) return;
    byTeacher[p.teacherId] = byTeacher[p.teacherId] || {};
    byTeacher[p.teacherId][p.day] = byTeacher[p.teacherId][p.day] || [];
    byTeacher[p.teacherId][p.day].push(p);
  });
  function placementIsPinned(p){
    const src = sourceOf(db, smallGroupList, p.lessonId);
    if(!src) return false;
    const pin = pinnedWindow(src.src);
    return !!(pin && p.day === pin.day && p.start === pin.start && p.end === pin.end);
  }

  Object.entries(byTeacher).forEach(([tid, byDay]) => {
    const bs = breakSettings(db, tid);
    let units = 0;
    const wins = teacherWindows(db, tid);
    DAYS.forEach(day => {
      const list = (byDay[day] || []).slice().sort((a,b)=>a.start-b.start);
      for(let i=1;i<list.length;i++){
        const gap = breakGapBetweenIntervals(windowIntervals(wins[day]), list[i-1].end, list[i].start);
        if(gap < 0) return;
        if(gap === 0) continue;
        // Pin–pin holes are placed with a UI warning, not a hard invariant failure.
        if(placementIsPinned(list[i-1]) && placementIsPinned(list[i])) continue;
        // No Break Management row: any gap is legal (same as 1/1).
        if(bs.unconstrained) continue;
        if(!(bs.minutes > 0 && gap % bs.minutes === 0)){
          errors.push(`teacher ${tid} ${day}: illegal ${gap}-min gap between ${label(list[i-1])} and ${label(list[i])} (break ${bs.minutes}×${bs.count})`);
          continue;
        }
        units += gap / bs.minutes;
      }
    });
    if(!bs.unconstrained && units > bs.count){
      errors.push(`teacher ${tid}: used ${units} break units, budget is ${bs.minutes}×${bs.count}`);
    }
  });

  const quota = {};
  (db.smallGroupQuotas || []).forEach(q => { quota[q.teacherId] = Math.max(0, parseInt(q.amount, 10) || 0); });
  const used = {};
  scheduled.forEach(p => {
    if(!isSmallGroupId(p.lessonId) || !p.teacherId) return;
    used[p.teacherId] = (used[p.teacherId] || 0) + 1;
  });
  Object.entries(used).forEach(([tid, n]) => {
    const cap = quota[tid];
    if(cap == null) errors.push(`teacher ${tid} has ${n} small group(s) but is not on the quota list`);
    else if(n > cap) errors.push(`teacher ${tid} used ${n} small group quota, cap is ${cap}`);
  });

  return errors;
}

export function resultSignature(result){
  return ((result && result.scheduled) || [])
    .map(s => `${s.lessonId}|${s.day}|${s.start}|${s.teacherId}`)
    .sort()
    .join(';');
}
