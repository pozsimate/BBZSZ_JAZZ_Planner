#!/usr/bin/env node
// Full-tab chaos: random flags + rooms + pins, then small groups → timetable →
// Accept → 1/1 → Accept → Required Piano → Accept, then real calendar drags
// (always-stick) + re-Accept on every grid, plus JSON/ICS/render. Hard-fails on
// crashes, extra placements, duration breaks, blocked moves, Accept not freezing
// the dragged slot, group-drag clearing the accepted table, 1/1/piano locking a
// room. Overlaps after a blind drag are allowed (drag always sticks).
//
//   node test/chaos.mjs
//   node test/chaos.mjs --runs 80 --seed 42
//   node test/chaos.mjs --until-fail
//   node test/chaos.mjs --quick

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { makeRng } from './rng.mjs';
import { buildScenario, pickProfile } from './mutate.mjs';
import { checkSchedule, isSmallGroupId } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL_PATH = path.join(ROOT, 'test/last-chaos-failure.json');
const DAYS = ['MON','TUE','WED','THU','FRI'];
const HOUR_CHOICES = [0.5, 1, 1.5, 2, 3];

function parseArgs(argv){
  const args = {
    runs: 80,
    seed: (Date.now() ^ (process.pid << 16)) >>> 0,
    failFast: true,
    untilFail: false,
  };
  for(let i=2;i<argv.length;i++){
    const a = argv[i];
    if(a === '--quick') args.runs = 20;
    else if(a === '--until-fail') args.untilFail = true;
    else if(a === '--keep-going') args.failFast = false;
    else if(a === '--runs') args.runs = Math.max(1, parseInt(argv[++i], 10) || 80);
    else if(a === '--seed') args.seed = parseInt(argv[++i], 10) >>> 0;
    else if(a === '--help' || a === '-h'){
      console.log('Usage: node test/chaos.mjs [--runs N] [--seed N] [--quick] [--until-fail] [--keep-going]');
      process.exit(0);
    }
  }
  return args;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function stripHtml(s){
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function overlaps(a, b){
  return a && b && a.day === b.day && a.start < b.end && b.start < a.end;
}

function dummyDrag(){
  return {
    classList: { add(){}, remove(){} },
    releasePointerCapture(){},
    setPointerCapture(){},
  };
}

function mutateHours(db, key, rng, ops){
  const m = clone(db[key] || {columns: [], hours: {}});
  m.columns = m.columns || [];
  m.hours = m.hours || {};
  const students = db.students || [];
  const teachers = db.refTeachers || [];
  if(!m.columns.length && teachers.length){
    rng.sample(teachers, Math.min(5, teachers.length)).forEach(t => {
      m.columns.push({id: t.id, name: t.name});
    });
    ops.push(`${key}: seeded ${m.columns.length} teacher columns`);
  }
  const sids = students.map(s => s.ID);
  const tids = m.columns.map(c => c.id).filter(Boolean);
  if(!sids.length || !tids.length){
    db[key] = m;
    return;
  }
  rng.sample(sids, rng.int(4, Math.min(18, sids.length))).forEach(sid => {
    const tid = rng.pick(tids);
    m.hours[sid] = m.hours[sid] || {};
    if(rng.bool(0.18)) delete m.hours[sid][tid];
    else m.hours[sid][tid] = rng.pick(HOUR_CHOICES);
  });
  ops.push(`${key}: mutated hours`);
  db[key] = m;
}

function reds(audit){
  return (audit.entries || []).filter(e => e.level !== 'warning');
}

function checkCombined(api, items, label){
  const errors = [];
  const list = (items || []).filter(i => i && i.day && i.start != null && i.end != null);
  for(let i=0;i<list.length;i++){
    for(let j=i+1;j<list.length;j++){
      const a = list[i], b = list[j];
      if(!overlaps(a, b)) continue;
      const when = `${a.day} ${api.toHHMM(Math.max(a.start,b.start))}–${api.toHHMM(Math.min(a.end,b.end))}`;
      if(a.teacherId && a.teacherId === b.teacherId){
        errors.push(`${label}: teacher ${a.teacherId} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const ra = a.roomId || '';
      const rb = b.roomId || '';
      if(ra && ra === rb){
        errors.push(`${label}: room ${ra} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const sa = api.studentsForScheduledItem(a) || [];
      const sb = new Set((api.studentsForScheduledItem(b) || []).map(s => s.ID));
      const shared = sa.filter(s => sb.has(s.ID));
      if(shared.length){
        errors.push(`${label}: student ${shared.map(s => s.ID).join(',')} ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
    }
  }
  return errors;
}

function checkAssignments(api, matrix, scheduled, kind){
  const errors = [];
  const jobs = api.collectOneOneAssignments(matrix);
  const byKey = {};
  jobs.forEach(j => { byKey[j.studentId + '|' + j.teacherId] = j; });
  const got = {};
  (scheduled || []).forEach(s => {
    const sid = s.studentId || s.studentIds;
    const key = sid + '|' + s.teacherId;
    const job = byKey[key];
    if(!job){
      errors.push(`${kind}: placed ${s.lessonId} for ${key} which is not in the hours matrix`);
      return;
    }
    got[key] = (got[key] || 0) + (s.end - s.start);
  });
  Object.keys(got).forEach(key => {
    const job = byKey[key];
    if(job && got[key] !== job.duration){
      errors.push(`${kind}: ${key} booked ${got[key]} min, matrix wants ${job.duration}`);
    }
  });
  return errors;
}

function drop(api, item, kind, day, start){
  const inert = dummyDrag();
  const container = {querySelectorAll(){ return []; }, querySelector(){ return null; }};
  api.CAL_DRAG = {
    pointerId: 1, block: inert, container, dayBodies: [],
    lessonId: item.lessonId, kind, duration: item.end - item.start,
    originX: 0, originY: 0, active: true,
    hover: {day, start}, previewBody: null
  };
  api.endCalendarDrag(true);
}

function randomSlot(api, rng, duration){
  const day = rng.pick(DAYS);
  const raw = rng.int(api.CAL_DAY_START, api.CAL_DAY_END - 5);
  const start = api.clampLessonStart(api.snapMinutes(raw), duration);
  return {day, start};
}

function dragMany(api, rng, list, kind, n, errors, label){
  const items = (list || []).filter(i => i && i.lessonId && i.end > i.start);
  if(!items.length) return 0;
  let moved = 0;
  for(let i=0;i<n;i++){
    const item = rng.pick(items);
    const dur = item.end - item.start;
    const slot = randomSlot(api, rng, dur);
    const from = {day: item.day, start: item.start, end: item.end, lessonId: item.lessonId};
    drop(api, item, kind, slot.day, slot.start);
    if(item.end - item.start !== dur){
      errors.push(`${label}: duration broke on ${item.lessonId} (${dur} → ${item.end - item.start})`);
    }
    if(item.day !== slot.day || item.start !== slot.start){
      errors.push(`${label}: drag blocked ${from.lessonId} ${from.day} ${from.start} → ${slot.day} ${slot.start} landed ${item.day} ${item.start}`);
    } else {
      moved++;
    }
  }
  return moved;
}

function freezeMatches(api, scheduled, rows, label, errors){
  const byId = new Map((rows || []).map(r => [String(r.lessonId), r]));
  (scheduled || []).forEach(s => {
    const row = byId.get(String(s.lessonId));
    if(!row){
      errors.push(`${label}: Accept missed ${s.lessonId}`);
      return;
    }
    const start = typeof row.start === 'number' ? row.start : api.toMin(row.start);
    const day = row.day;
    if(day !== s.day || start !== s.start){
      errors.push(`${label}: Accept froze ${s.lessonId} at ${day} ${row.start}, grid is ${s.day} ${api.toHHMM(s.start)}`);
    }
  });
}

function dumpFailure(payload){
  fs.writeFileSync(FAIL_PATH, JSON.stringify(payload, null, 2));
}

function runScenario(api, seed, rng, profile){
  const errors = [];
  const ops = [];
  const intensity = profile === 'chaos' ? 'chaos' : 'normal';
  const scenario = buildScenario(api, seed, rng, profile);
  mutateHours(scenario.db, 'oneToOne', rng, scenario.ops);
  mutateHours(scenario.db, 'rpiano', rng, scenario.ops);
  ops.push.apply(ops, scenario.ops);

  api.DB = scenario.db;
  api.LAST_SMALL_GROUPS = scenario.smallGroups;
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  api.DB.acceptedSchedule = [];
  api.DB.acceptedTimetable = null;
  (api.DB.lessons || []).forEach(l => { l.scheduledDay = ''; l.scheduledStart = ''; l.scheduledEnd = ''; });
  if(api.SearchLog) api.SearchLog.quiet = true;

  const groups = api.runScheduler(false);
  api.LAST_RESULT = groups;
  api.LAST_VARIANTS = [groups];
  checkSchedule(api.DB, api.LAST_SMALL_GROUPS, groups).forEach(e => errors.push('groups: ' + e));
  reds(api.auditTimetable(groups.scheduled || [])).forEach(e => errors.push('group-audit: ' + stripHtml(e.html)));

  if(!(groups.scheduled || []).length){
    return {errors, ops, counts: {groups: 0}};
  }

  const cal = {innerHTML: ''};
  api.renderCalendar(cal, groups.scheduled, true);
  if(!cal.innerHTML) errors.push('timetable calendar render produced no HTML');

  api.acceptTimetableSchedule();
  if(!api.hasAcceptedRecord()) errors.push('Accept timetable did not write an accepted record');
  if(api.hasUnacceptedDrags()) errors.push('Accept timetable left unaccepted drags');
  freezeMatches(api, groups.scheduled, api.DB.acceptedSchedule, 'timetable', errors);

  const one = api.scheduleAllOneToOne({
    matrix: api.DB.oneToOne,
    acceptedRows: api.DB.acceptedSchedule || []
  });
  api.applyIndividualSearch('oneone', [one], '');
  checkAssignments(api, api.DB.oneToOne, one.scheduled, '1/1').forEach(e => errors.push(e));
  api.acceptOneOneSchedule();
  if(!api.hasAcceptedOneOne()) errors.push('Accept 1/1 did not freeze');
  freezeMatches(api, one.scheduled, api.LAST_ONEONE && api.LAST_ONEONE.acceptedSchedule, '1/1', errors);

  const weekAfterOne = api.timetableAuditItems(groups.scheduled || []);
  reds(api.auditTimetable(weekAfterOne)).forEach(e => errors.push('groups+frozen-1/1 audit: ' + stripHtml(e.html)));
  checkCombined(api, weekAfterOne, 'groups+frozen-1/1').forEach(e => errors.push(e));

  const piano = api.scheduleAllOneToOne({
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(one.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  });
  api.applyIndividualSearch('rpiano', [piano], '');
  checkAssignments(api, api.DB.rpiano, piano.scheduled, 'piano').forEach(e => errors.push(e));
  api.acceptRpianoSchedule();
  if(!api.hasAcceptedRpiano()) errors.push('Accept piano did not freeze');
  freezeMatches(api, piano.scheduled, api.LAST_RPIANO && api.LAST_RPIANO.acceptedSchedule, 'piano', errors);

  const week = (groups.scheduled || []).concat(one.scheduled || []).concat(piano.scheduled || []);
  checkCombined(api, week, 'combined-pre-drag').forEach(e => errors.push(e));
  reds(api.auditTimetable(week)).forEach(e => errors.push('combined-pre-drag audit: ' + stripHtml(e.html)));

  const ids = new Set();
  week.forEach(s => {
    if(!s.lessonId) return;
    if(ids.has(s.lessonId)) errors.push('duplicate lessonId ' + s.lessonId);
    ids.add(s.lessonId);
  });

  api.buildTimetableIcs(week);
  const exported = api.buildFullExportObject();
  if(!exported || !exported.students) errors.push('JSON export missing students');
  api.driveTablesToAoa(api.DB);

  const nGroupDrags = intensity === 'chaos' ? rng.int(6, 14) : rng.int(3, 8);
  const nOneDrags = Math.min((one.scheduled || []).length, intensity === 'chaos' ? rng.int(4, 10) : rng.int(2, 5));
  const nPianoDrags = Math.min((piano.scheduled || []).length, intensity === 'chaos' ? rng.int(3, 8) : rng.int(1, 4));

  const victim = groups.scheduled[0];
  const beforeAcceptTable = clone(api.DB.acceptedSchedule || []);
  drop(api, victim, 'timetable', victim.day === 'MON' ? 'FRI' : 'MON', api.clampLessonStart(16*60, victim.end - victim.start));
  if(api.LAST_RESULT.accepted !== false) errors.push('group drag did not re-open Accept');
  if(!api.hasAcceptedRecord()) errors.push('group drag cleared the accepted table');
  const afterDragTable = JSON.stringify(api.DB.acceptedSchedule || []);
  if(afterDragTable !== JSON.stringify(beforeAcceptTable)){
    errors.push('group drag mutated acceptedSchedule before re-Accept');
  }
  if(api.hasAcceptedOneOne() !== true) errors.push('group drag cleared Accept 1/1');
  if(api.hasAcceptedRpiano() !== true) errors.push('group drag cleared Accept piano');
  if(api.canOpenOneOne()) errors.push('group drag left 1/1 tab unlocked');
  if(api.canOpenRpiano()) errors.push('group drag left Required Piano tab unlocked');
  if(api.pendingAcceptTab() !== 'timetable') errors.push('group drag did not lock other tabs');

  dragMany(api, rng, groups.scheduled, 'timetable', nGroupDrags, errors, 'group-drag');
  api.acceptTimetableSchedule();
  freezeMatches(api, groups.scheduled, api.DB.acceptedSchedule, 'timetable-after-drag', errors);
  if(api.hasUnacceptedDrags()) errors.push('re-Accept timetable left unaccepted drags');
  if(!api.canOpenOneOne()) errors.push('re-Accept timetable left 1/1 tab locked');

  if((one.scheduled || []).length){
    const oneItem = one.scheduled[0];
    drop(api, oneItem, 'oneone', oneItem.day === 'MON' ? 'WED' : 'MON', api.clampLessonStart(14*60, oneItem.end - oneItem.start));
    if(api.hasAcceptedOneOne()) errors.push('1/1 drag did not re-open Accept 1/1');
    if(api.hasAcceptedRpiano() !== true) errors.push('1/1 drag cleared Accept piano');
    if(api.canOpenRpiano()) errors.push('1/1 drag left Required Piano tab unlocked');
    if(api.pendingAcceptTab() !== 'oneone') errors.push('1/1 drag did not lock other tabs');
    dragMany(api, rng, one.scheduled, 'oneone', nOneDrags, errors, '1/1-drag');
    api.acceptOneOneSchedule();
    if(!api.hasAcceptedRpiano()) errors.push('re-Accept 1/1 dropped Required Piano (piano should stay on file)');
    if(!api.canOpenRpiano()) errors.push('re-Accept 1/1 left Required Piano tab locked');
    freezeMatches(api, one.scheduled, api.LAST_ONEONE && api.LAST_ONEONE.acceptedSchedule, '1/1-after-drag', errors);
    const piano2 = api.scheduleAllOneToOne({
      matrix: api.DB.rpiano,
      acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(one.scheduled)),
      source: 'rpiano',
      lessonLabel: 'piano',
      idPrefix: 'RP'
    });
    api.applyIndividualSearch('rpiano', [piano2], '');
    checkAssignments(api, api.DB.rpiano, piano2.scheduled, 'piano-after-1/1-drag').forEach(e => errors.push(e));
    api.acceptRpianoSchedule();
    if((piano2.scheduled || []).length){
      const pItem = piano2.scheduled[0];
      drop(api, pItem, 'rpiano', pItem.day === 'FRI' ? 'TUE' : 'FRI', api.clampLessonStart(16*60, pItem.end - pItem.start));
      if(api.hasAcceptedRpiano()) errors.push('piano drag did not re-open Accept piano');
      if(!api.hasAcceptedOneOne()) errors.push('piano drag cleared Accept 1/1');
      dragMany(api, rng, piano2.scheduled, 'rpiano', Math.min(nPianoDrags, piano2.scheduled.length), errors, 'piano-drag');
      api.acceptRpianoSchedule();
      freezeMatches(api, piano2.scheduled, api.LAST_RPIANO && api.LAST_RPIANO.acceptedSchedule, 'piano-after-drag', errors);
    }
  }

  if(api.hasUnacceptedDrags()){
    const beforeGen = clone(api.LAST_RESULT && api.LAST_RESULT.scheduled);
    api.runGenerateTimetable(false);
    if(api.hasUnacceptedDrags()) errors.push('Generate after drag left the unaccepted-drag flag');
    void beforeGen;
  }

  try {
    api.undoLastDrag();
    api.resetVariantDrags();
    api.undoIndividualDrag('oneone');
    api.undoIndividualDrag('rpiano');
  } catch(err){
    errors.push('undo/reset threw: ' + (err && err.message));
  }

  const snap = api.buildFullExportObject();
  api.restoreFromLoadedObject(clone(snap));
  if((api.DB.students || []).length !== (scenario.db.students || []).length){
    errors.push('JSON restore lost students');
  }

  return {
    errors,
    ops,
    counts: {
      groups: (groups.scheduled || []).length,
      unresolved: (groups.unresolved || []).length,
      one: (one.scheduled || []).length,
      piano: (piano.scheduled || []).length,
      groupDrags: nGroupDrags,
    }
  };
}

function main(){
  const args = parseArgs(process.argv);
  console.log('Loading app…');
  const {api, seed} = loadApp();
  api.SCHEDULE_SEARCH_ATTEMPTS = 3;
  const rng = makeRng(args.seed);
  const limit = args.untilFail ? Infinity : args.runs;
  console.log(`Chaos: ${args.untilFail ? 'until first failure' : args.runs + ' scenarios'} · seed ${args.seed}`);
  console.log('Pipeline: mutate → small groups → timetable → Accept → 1/1 → Accept → piano → Accept → drag+re-Accept every grid\n');

  let passed = 0, failed = 0, crashes = 0;
  const tStart = Date.now();

  for(let i=0;i<limit;i++){
    const profile = pickProfile(rng, i);
    let packed;
    try {
      packed = runScenario(api, seed, rng, profile);
    } catch(err){
      crashes++; failed++;
      console.error(`\nSCENARIO ${i} ${profile} THREW: ${err.stack || err}`);
      dumpFailure({seed: args.seed, i, profile, error: String(err && err.stack || err)});
      if(args.failFast){
        console.error(`Dumped ${FAIL_PATH}`);
        process.exit(1);
      }
      continue;
    }
    if(packed.errors.length){
      failed++;
      console.error(`\nSCENARIO ${i} FAILED  profile=${profile}`);
      console.error((packed.ops || []).slice(0, 14).join('\n'));
      packed.errors.slice(0, 20).forEach(e => console.error('  - ' + e));
      if(packed.errors.length > 20) console.error(`  … ${packed.errors.length - 20} more`);
      dumpFailure({
        seed: args.seed, i, profile,
        ops: packed.ops, errors: packed.errors.slice(0, 40),
        counts: packed.counts
      });
      if(args.failFast){
        console.error(`\nDumped ${FAIL_PATH}`);
        process.exit(1);
      }
    } else {
      passed++;
    }
    if((i+1) % 10 === 0 || i === 0){
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      const counts = packed && packed.counts ? packed.counts : {};
      process.stdout.write(`  ${i+1}${args.untilFail ? '' : '/' + args.runs}  ok=${passed} fail=${failed} crash=${crashes}  groups=${counts.groups || 0} 1/1=${counts.one || 0} piano=${counts.piano || 0}  ${elapsed}s\n`);
    }
  }

  const secs = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('\n———');
  console.log(`scenarios ${passed} passed · ${failed} failed · ${crashes} crashed · wall ${secs}s · seed ${args.seed}`);
  if(failed) process.exit(1);
  console.log('Chaos pipeline is green — generate / accept / drag / freeze / JSON held.');
}

main();
