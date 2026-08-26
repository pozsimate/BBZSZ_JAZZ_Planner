#!/usr/bin/env node
// Scale the seed ~N× in every table (N independent campus copies with remapped ids),
// then run small groups → timetable → Accept → 1/1 → Accept → Required Piano.
//
//   node test/scale5x.mjs
//   node test/scale5x.mjs --copies 5 --tt-attempts 10 --one-attempts 5

import { loadApp } from './load-app.mjs';
import { checkSchedule } from './invariants.mjs';

const STUDENT_IDS = ['ID','INSTR_ID','CLASS_ID','IMPR_ID','VOC_ID','JTH_ID','SOLF_ID','JHIST_ID','RHIMPR_ID','AC_ID'];

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function rid(id, campus){
  if(id == null || id === '') return id;
  if(campus === 0) return String(id);
  return String(id) + '_C' + (campus + 1);
}

function remapRow(row, keys, campus){
  const out = clone(row);
  keys.forEach(k => {
    if(Object.prototype.hasOwnProperty.call(out, k)) out[k] = rid(out[k], campus);
  });
  return out;
}

function remapHours(hours, campus){
  const out = {};
  Object.entries(hours || {}).forEach(([sid, byT]) => {
    const inner = {};
    Object.entries(byT || {}).forEach(([tid, hrs]) => { inner[rid(tid, campus)] = hrs; });
    out[rid(sid, campus)] = inner;
  });
  return out;
}

function remapMatrix(matrix, campus){
  const m = matrix || {columns: [], hours: {}};
  return {
    columns: (m.columns || []).map(c => ({
      ...c,
      id: rid(c.id, campus),
      name: campus === 0 ? c.name : `${c.name} C${campus + 1}`
    })),
    hours: remapHours(m.hours, campus)
  };
}

function scaleDb(seed, copies){
  const tables = {
    students: [],
    lessons: [],
    teacherAvail: [],
    classAvail: [],
    refTeachers: [],
    refClasses: [],
    refGroups: [],
    refInstruments: [],
    refRooms: [],
    breaks: [],
    smallGroupQuotas: [],
  };
  for(let c = 0; c < copies; c++){
    (seed.students || []).forEach(s => {
      const row = remapRow(s, STUDENT_IDS, c);
      if(c > 0) row.NAME2 = `${s.NAME2 || ''} C${c + 1}`.trim();
      tables.students.push(row);
    });
    (seed.lessons || []).forEach(l => {
      const row = remapRow(l, ['id','groupId','teacherId','roomId'], c);
      if(c > 0){
        row.name = `${l.name} C${c + 1}`;
        row.group = l.group ? `${l.group}_C${c + 1}` : l.group;
        row.teacher = l.teacher ? `${l.teacher} C${c + 1}` : l.teacher;
        row.room = l.room ? `${l.room} C${c + 1}` : l.room;
      }
      tables.lessons.push(row);
    });
    (seed.teacherAvail || []).forEach(r => {
      const row = remapRow(r, ['teacherId'], c);
      if(c > 0 && r.teacher) row.teacher = `${r.teacher} C${c + 1}`;
      tables.teacherAvail.push(row);
    });
    (seed.classAvail || []).forEach(r => {
      const row = remapRow(r, ['classId'], c);
      if(c > 0 && r.class) row.class = `${r.class}_C${c + 1}`;
      tables.classAvail.push(row);
    });
    (seed.refTeachers || []).forEach(r => {
      const row = remapRow(r, ['id'], c);
      if(c > 0) row.name = `${r.name} C${c + 1}`;
      tables.refTeachers.push(row);
    });
    (seed.refClasses || []).forEach(r => {
      const row = remapRow(r, ['id'], c);
      if(c > 0) row.name = `${r.name}_C${c + 1}`;
      tables.refClasses.push(row);
    });
    (seed.refGroups || []).forEach(r => {
      const row = remapRow(r, ['id'], c);
      if(c > 0) row.name = `${r.name}_C${c + 1}`;
      tables.refGroups.push(row);
    });
    (seed.refInstruments || []).forEach(r => {
      const row = remapRow(r, ['id'], c);
      if(c > 0) row.name = `${r.name}_C${c + 1}`;
      tables.refInstruments.push(row);
    });
    (seed.refRooms || []).forEach(r => {
      const row = remapRow(r, ['id'], c);
      if(c > 0) row.name = `${r.name} C${c + 1}`;
      tables.refRooms.push(row);
    });
    (seed.breaks || []).forEach(r => {
      tables.breaks.push(remapRow(r, ['teacherId'], c));
    });
    (seed.smallGroupQuotas || []).forEach(r => {
      const row = remapRow(r, ['id','teacherId'], c);
      if(c > 0 && r.teacher) row.teacher = `${r.teacher} C${c + 1}`;
      tables.smallGroupQuotas.push(row);
    });
  }

  const oneToOne = {columns: [], hours: {}};
  const rpiano = {columns: [], hours: {}};
  for(let c = 0; c < copies; c++){
    const one = remapMatrix(seed.oneToOne, c);
    const rjp = remapMatrix(seed.rpiano, c);
    oneToOne.columns.push(...one.columns);
    rpiano.columns.push(...rjp.columns);
    Object.assign(oneToOne.hours, one.hours);
    Object.assign(rpiano.hours, rjp.hours);
  }

  return {
    ...tables,
    oneToOne,
    rpiano,
    acceptedSchedule: [],
    smallGroupsState: null,
  };
}

function counts(db){
  return {
    students: (db.students || []).length,
    lessons: (db.lessons || []).length,
    teacherAvail: (db.teacherAvail || []).length,
    classAvail: (db.classAvail || []).length,
    refTeachers: (db.refTeachers || []).length,
    refClasses: (db.refClasses || []).length,
    refGroups: (db.refGroups || []).length,
    refInstruments: (db.refInstruments || []).length,
    refRooms: (db.refRooms || []).length,
    breaks: (db.breaks || []).length,
    smallGroupQuotas: (db.smallGroupQuotas || []).length,
    oneToOneHours: Object.keys((db.oneToOne && db.oneToOne.hours) || {}).length,
    oneToOneCols: ((db.oneToOne && db.oneToOne.columns) || []).length,
    rpianoHours: Object.keys((db.rpiano && db.rpiano.hours) || {}).length,
    rpianoCols: ((db.rpiano && db.rpiano.columns) || []).length,
  };
}

function parseArgs(argv){
  const args = { copies: 5, ttAttempts: 10, oneAttempts: 5, sg: 0 };
  for(let i = 2; i < argv.length; i++){
    const a = argv[i];
    if(a === '--copies') args.copies = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if(a === '--tt-attempts') args.ttAttempts = Math.max(1, parseInt(argv[++i], 10) || 10);
    else if(a === '--one-attempts') args.oneAttempts = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if(a === '--sg') args.sg = Math.max(1, parseInt(argv[++i], 10) || 0);
    else if(a === '--help' || a === '-h'){
      console.log('Usage: node test/scale5x.mjs [--copies 5] [--tt-attempts 10] [--one-attempts 5] [--sg N]');
      process.exit(0);
    }
  }
  return args;
}

function ms(t0){ return Date.now() - t0; }

function runPipeline(api, label, opts){
  const out = { label, ok: true, errors: [] };
  if(api.SearchLog) api.SearchLog.quiet = true;

  const sgN = opts.sg;
  let t0 = Date.now();
  const smallGroups = api.generateSmallGroups(sgN);
  api.LAST_SMALL_GROUPS = smallGroups;
  out.smallGroupsMs = ms(t0);
  out.smallGroups = (smallGroups.smallGroups || []).length;
  out.sgEligible = smallGroups.eligibleCount;
  out.sgExcluded = (smallGroups.excluded || []).length;

  api.SCHEDULE_SEARCH_ATTEMPTS = opts.ttAttempts;
  t0 = Date.now();
  if(opts.ttAttempts <= 1){
    const result = api.runScheduler(false);
    api.LAST_RESULT = result;
    api.LAST_VARIANTS = [result];
  } else {
    api.runGenerateTimetable(true);
  }
  out.ttMs = ms(t0);
  out.ttPlaced = (api.LAST_RESULT && api.LAST_RESULT.scheduled || []).length;
  out.ttUnresolved = (api.LAST_RESULT && api.LAST_RESULT.unresolved || []).length;
  out.ttVariants = (api.LAST_VARIANTS || []).length;

  const inv = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, api.LAST_RESULT);
  out.invariantErrors = inv.length;
  if(inv.length){
    out.ok = false;
    out.errors.push(...inv.slice(0, 8));
  }

  const audit = api.auditTimetable((api.LAST_RESULT && api.LAST_RESULT.scheduled) || []);
  const red = ((audit && audit.entries) || []).filter(e => e.level !== 'warning' && e.kind !== 'gap');
  out.auditRed = red.length;
  if(red.length){
    out.ok = false;
    out.errors.push(...red.slice(0, 5).map(e => String(e.html || e.kind || e).replace(/<[^>]+>/g, '')));
  }

  t0 = Date.now();
  api.acceptTimetableSchedule();
  out.acceptMs = ms(t0);
  out.acceptedRows = (api.DB.acceptedSchedule || []).length;

  t0 = Date.now();
  const oneVariants = opts.oneAttempts <= 1
    ? [api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule || []})]
    : api.scheduleAllOneToOneSearch({
      matrix: api.DB.oneToOne,
      acceptedRows: api.DB.acceptedSchedule || [],
      attempts: opts.oneAttempts
    });
  api.applyIndividualSearch('oneone', oneVariants, '');
  out.oneMs = ms(t0);
  out.onePlaced = (api.LAST_ONEONE.scheduled || []).length;
  out.oneUnresolved = (api.LAST_ONEONE.unresolved || []).length;
  out.oneVariants = oneVariants.length;

  const oneWeek = api.combinedWeekItems('oneone');
  const oneRed = ((api.auditTimetable(oneWeek).entries) || []).filter(e => e.level !== 'warning' && e.kind !== 'gap');
  out.oneAuditRed = oneRed.length;
  if(oneRed.length){
    out.ok = false;
    out.errors.push('1/1 week red: ' + oneRed.slice(0, 3).map(e => String(e.html || e.kind).replace(/<[^>]+>/g, '')).join(' | '));
  }

  api.acceptOneOneSchedule();

  t0 = Date.now();
  const rjpOpts = {
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE && api.LAST_ONEONE.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP',
    attempts: opts.oneAttempts
  };
  const rjpVariants = opts.oneAttempts <= 1
    ? [api.scheduleAllOneToOne(rjpOpts)]
    : api.scheduleAllOneToOneSearch(rjpOpts);
  api.applyIndividualSearch('rpiano', rjpVariants, '');
  out.rjpMs = ms(t0);
  out.rjpPlaced = (api.LAST_RPIANO.scheduled || []).length;
  out.rjpUnresolved = (api.LAST_RPIANO.unresolved || []).length;
  out.rjpVariants = rjpVariants.length;

  const mixed = api.combinedWeekItems('rpiano');
  const mixedRed = ((api.auditTimetable(mixed).entries) || []).filter(e => e.level !== 'warning' && e.kind !== 'gap');
  out.rjpAuditRed = mixedRed.length;
  if(mixedRed.length){
    out.ok = false;
    out.errors.push('piano week red: ' + mixedRed.slice(0, 3).map(e => String(e.html || e.kind).replace(/<[^>]+>/g, '')).join(' | '));
  }

  api.acceptRpianoSchedule();
  out.totalMs = out.smallGroupsMs + out.ttMs + out.acceptMs + out.oneMs + out.rjpMs;
  return out;
}

function printCounts(title, a, b){
  console.log(`\n${title}`);
  const keys = Object.keys(a);
  keys.forEach(k => {
    const ratio = a[k] ? (b[k] / a[k]).toFixed(2) : (b[k] ? '∞' : '1.00');
    console.log(`  ${k.padEnd(18)} ${String(a[k]).padStart(5)} → ${String(b[k]).padStart(5)}   ×${ratio}`);
  });
}

function printRun(r){
  console.log(`\n== ${r.label} ==`);
  console.log(`  small groups: ${r.smallGroups} (eligible ${r.sgEligible}, excluded ${r.sgExcluded}) in ${r.smallGroupsMs}ms`);
  console.log(`  timetable:    ${r.ttPlaced} placed / ${r.ttUnresolved} unresolved · ${r.ttVariants} layout(s) in ${r.ttMs}ms`);
  console.log(`  invariants:   ${r.invariantErrors}  audit red: ${r.auditRed}`);
  console.log(`  accept:       ${r.acceptedRows} rows in ${r.acceptMs}ms`);
  console.log(`  1/1:          ${r.onePlaced} placed / ${r.oneUnresolved} left · ${r.oneVariants} layout(s) in ${r.oneMs}ms  audit red ${r.oneAuditRed}`);
  console.log(`  piano:        ${r.rjpPlaced} placed / ${r.rjpUnresolved} left · ${r.rjpVariants} layout(s) in ${r.rjpMs}ms  audit red ${r.rjpAuditRed}`);
  console.log(`  wall:         ${r.totalMs}ms  ${r.ok ? 'PASS' : 'FAIL'}`);
  if(r.errors.length){
    r.errors.forEach(e => console.error('    - ' + e));
  }
}

function main(){
  const args = parseArgs(process.argv);
  const { api, seed } = loadApp();
  const copies = args.copies;
  const scaled = scaleDb(seed, copies);
  const c0 = counts(seed);
  const c1 = counts(scaled);
  printCounts(`Table sizes  1× → ${copies}× campus copies`, c0, c1);

  const sg1 = 16;
  const sgN = args.sg || sg1 * copies;

  console.log(`\nPipeline: small groups ${sg1} vs ${sgN} · timetable attempts ${args.ttAttempts} · 1/1+piano attempts ${args.oneAttempts}`);

  api.DB = clone(seed);
  api.LAST_SMALL_GROUPS = null;
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  const baseline = runPipeline(api, '1× seed', { sg: sg1, ttAttempts: args.ttAttempts, oneAttempts: args.oneAttempts });
  printRun(baseline);

  api.DB = scaled;
  api.LAST_SMALL_GROUPS = null;
  api.LAST_RESULT = null;
  api.LAST_VARIANTS = [];
  api.LAST_ONEONE = null;
  api.LAST_RPIANO = null;
  const big = runPipeline(api, `${copies}× scaled`, { sg: sgN, ttAttempts: args.ttAttempts, oneAttempts: args.oneAttempts });
  printRun(big);

  const slowdown = baseline.totalMs ? (big.totalMs / baseline.totalMs).toFixed(2) : '?';
  console.log(`\nSlowdown vs 1×: ${slowdown}×  (tt ${baseline.ttMs}ms → ${big.ttMs}ms, 1/1 ${baseline.oneMs}ms → ${big.oneMs}ms)`);

  if(!baseline.ok || !big.ok) process.exit(1);
  console.log('\nBoth pipelines passed invariants + no red audit on generated weeks.');
}

main();
