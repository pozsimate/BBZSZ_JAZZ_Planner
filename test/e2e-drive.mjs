#!/usr/bin/env node
// End-to-end super test: Google Drive workbook → small groups → timetable → Accept
// → 1/1 → Accept → Required Piano → Accept, plus referential integrity,
// static HTML/JS wiring, dead-code scan, round-trip export, and independent
// clash checks that do not trust auditTimetable.
//
//   node test/e2e-drive.mjs
//   node test/e2e-drive.mjs --seed-only
//   node test/e2e-drive.mjs --quick          (1 scheduler pass, 1 1/1 pass)
//   node test/e2e-drive.mjs --url 'https://docs.google.com/spreadsheets/d/…'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { checkSchedule } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ID = '1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU';
const REQUIRED_TABS = ['students','lessons','teacherAvail','classAvail','refTeachers','refClasses','refGroups','refInstruments'];
const HOURS_TABS = ['oneToOne','rpiano'];
const IDENTITY_HOURS_COLS = new Set(['STUDENT_ID','ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID','NAME']);
const DYNAMIC_HTML_IDS = new Set(['hoverTooltip']);
const GROUP_FIELDS = [
  {name:'IMPR', id:'IMPR_ID', type:'IMPR'},
  {name:'VOC', id:'VOC_ID', type:'VOC'},
  {name:'JTH', id:'JTH_ID', type:'JAZZTHEO'},
  {name:'SOLF', id:'SOLF_ID', type:'SOLF'},
  {name:'JHIST', id:'JHIST_ID', type:'JAZZHIS'},
  {name:'RHIMPR', id:'RHIMPR_ID', type:'RHYTHM'},
  {name:'AC', id:'AC_ID', type:'AC'},
];

function parseArgs(argv){
  const args = { seedOnly: false, quick: false, url: '', requireDrive: true };
  for(let i=2;i<argv.length;i++){
    const a = argv[i];
    if(a === '--seed-only'){ args.seedOnly = true; args.requireDrive = false; }
    else if(a === '--quick') args.quick = true;
    else if(a === '--url') args.url = argv[++i] || '';
    else if(a === '--help' || a === '-h'){
      console.log('Usage: node test/e2e-drive.mjs [--seed-only] [--quick] [--url SHEETS_URL]');
      process.exit(0);
    }
  }
  return args;
}

function clone(x){ return JSON.parse(JSON.stringify(x)); }

function stripHtml(s){
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
}

function overlaps(a, b){
  return a && b && a.day === b.day && a.start < b.end && b.start < a.end;
}

function parseGvizText(text){
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if(start < 0 || end <= start) throw new Error('gviz response was not JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

async function fetchGvizJson(spreadsheetId, sheetName, sheetKey){
  const headers = (sheetKey === 'oneToOne' || sheetKey === 'rpiano') ? '1' : '0';
  const q = new URLSearchParams({
    tqx: 'out:json',
    sheet: sheetName,
    headers,
    tq: 'select *'
  });
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?${q}`;
  const ctrl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(25000)
    : undefined;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bartok-jazz-planner-e2e/1.0' },
    signal: ctrl
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} for tab ${sheetName}`);
  return parseGvizText(await res.text());
}

async function loadDriveTables(api, spreadsheetId){
  const found = [];
  const missing = [];
  const tables = {};
  const usedNames = {};
  const keys = Object.entries(api.SHEET_ALIASES);
  const settled = await Promise.all(keys.map(async ([key, aliases]) => {
    let lastErr = '';
    for(const name of aliases){
      try {
        const resp = await fetchGvizJson(spreadsheetId, name, key);
        const rows = api.parseGvizTable(resp, key);
        if(!api.sheetLooksLike(key, rows)){
          lastErr = `tab “${name}” did not look like ${key}`;
          continue;
        }
        return {key, name, rows, error: null};
      } catch(err){
        lastErr = err && err.message ? err.message : String(err);
      }
    }
    return {key, name: null, rows: null, error: lastErr};
  }));
  settled.forEach(hit => {
    if(hit.rows){
      tables[hit.key] = hit.rows;
      found.push(hit.name);
      usedNames[hit.key] = hit.name;
    } else {
      missing.push(hit.key);
    }
  });
  return {tables, found, missing, usedNames};
}

function independentClashes(api, items){
  const errors = [];
  const list = (items || []).filter(i => i && i.day && i.start != null && i.end != null);
  for(let i=0;i<list.length;i++){
    for(let j=i+1;j<list.length;j++){
      const a = list[i], b = list[j];
      if(!overlaps(a, b)) continue;
      const when = `${a.day} ${api.toHHMM(Math.max(a.start,b.start))}–${api.toHHMM(Math.min(a.end,b.end))}`;
      if(a.teacherId && a.teacherId === b.teacherId){
        errors.push(`teacher ${a.teacherId}: ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const ra = a.roomId || '';
      const rb = b.roomId || '';
      if(ra && ra === rb){
        errors.push(`room ${ra}: ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
      const sa = api.studentsForScheduledItem(a) || [];
      const sb = new Set((api.studentsForScheduledItem(b) || []).map(s => s.ID));
      const shared = sa.filter(s => sb.has(s.ID));
      if(shared.length){
        errors.push(`student ${shared.map(s => s.ID).join(',')}: ${a.name || a.lessonId} overlaps ${b.name || b.lessonId} at ${when}`);
      }
    }
  }
  return errors;
}

function auditErrors(audit){
  return ((audit && audit.entries) || []).filter(e => e.level !== 'warning');
}

function hoursLeak(api, rows, refTeachers){
  const tByNorm = {};
  (refTeachers || []).forEach(t => {
    if(t && t.name) tByNorm[String(t.name).toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'')] = t;
    if(t && t.id) tByNorm[String(t.id).toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'')] = t;
  });
  const unmatchedCols = new Set();
  let matched = 0, unmatched = 0, cells = 0;
  (rows || []).forEach(r => {
    Object.keys(r).forEach(h => {
      const nh = String(h).toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'');
      if(!nh || IDENTITY_HOURS_COLS.has(nh)) return;
      const n = api.parseOneOneHours(r[h]);
      if(!n) return;
      cells++;
      if(tByNorm[nh] && tByNorm[nh].id) matched++;
      else {
        unmatched++;
        unmatchedCols.add(h);
      }
    });
  });
  return {matched, unmatched, cells, unmatchedCols: [...unmatchedCols]};
}

function aoaToObjects(aoa){
  if(!aoa || aoa.length < 2) return [];
  const headers = aoa[0].map(h => String(h == null ? '' : h));
  return aoa.slice(1).filter(arr => (arr || []).some(c => String(c == null ? '' : c).trim() !== '')).map(arr => {
    const row = {};
    headers.forEach((h, i) => { if(h) row[h] = arr[i] == null ? '' : arr[i]; });
    return row;
  });
}

function scanHtmlIds(appSrc, html){
  const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const jsIds = [...appSrc.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const missing = [...new Set(jsIds)].filter(id => !htmlIds.has(id) && !DYNAMIC_HTML_IDS.has(id));
  return {htmlIds, jsIds, missing};
}

function scanDeadFunctions(appSrc){
  const names = [...appSrc.matchAll(/^function ([A-Za-z_][A-Za-z0-9_]*)\(/gm)].map(m => m[1]);
  const unused = [];
  names.forEach(name => {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const hits = appSrc.match(re) || [];
    if(hits.length <= 1) unused.push(name);
  });
  return {defined: names.length, unused};
}

function formatUnresolvedOne(u, api){
  const id = u.studentId || (u.student && u.student.ID) || '?';
  const name = u.name || (u.student && (u.student.NAME1 + ' ' + u.student.NAME2)) || id;
  const tid = u.teacherId || '';
  const tname = tid && api.DB.refTeachers ? ((api.DB.refTeachers.find(t => t.id === tid) || {}).name || tid) : '';
  const why = u.reason || u.customReason || 'no hole';
  return `${name} (${id}${tname ? ' × '+tname : ''}: ${why})`;
}

function moveItem(item, deltaMin, day){
  const dur = item.end - item.start;
  item.day = day || item.day;
  item.start += deltaMin;
  item.end = item.start + dur;
}

async function main(){
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  let failed = 0;
  let passed = 0;
  const failures = [];
  const findings = [];

  function ok(name, cond, detail){
    if(cond){
      passed++;
      console.log('  PASS  ' + name);
      return true;
    }
    failed++;
    const msg = detail ? `${name}: ${detail}` : name;
    failures.push(msg);
    console.error('  FAIL  ' + msg);
    return false;
  }
  function find(name, detail){
    findings.push(detail ? `${name}: ${detail}` : name);
    console.log('  FIND  ' + (detail ? `${name}: ${detail}` : name));
  }

  console.log('Loading app into harness…');
  const {api, seed, root} = loadApp();
  const appSrc = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const needed = [
    'parseGvizTable','parseSpreadsheetId','SHEET_ALIASES','DEFAULT_SHEETS_URL',
    'sheetsTablesToDb','sheetLooksLike','restoreFromLoadedObject','generateSmallGroups',
    'runGenerateTimetable','runSchedulerSearchAll','runScheduler','acceptTimetableSchedule',
    'scheduleAllOneToOneSearch','applyIndividualSearch','acceptOneOneSchedule',
    'acceptRpianoSchedule','auditTimetable','combinedWeekItems','timetableAuditItems',
    'studentsForScheduledItem','collectOneOneAssignments','driveTablesToAoa',
    'hasAcceptedRecord','hasAcceptedOneOne','hasAcceptedRpiano','markLayoutNeedsAccept',
    'isTimetableAccepted','canOpenOneOne','canOpenRpiano','canOpenReports','hasPendingAccept','pendingAcceptTab',
    'parseOneOneHours','oneOneHoursToMinutes','GROUP_NAME_FIELDS','busyRowsFromScheduled'
  ];
  needed.forEach(name => {
    const v = api[name];
    ok('export '+name, v != null, v == null ? 'missing' : typeof v);
  });
  if(typeof api.parseGvizTable !== 'function'){
    console.error('Cannot continue without parseGvizTable');
    process.exit(1);
  }

  console.log('\n== 0. Static wiring: HTML ids, dead functions, aliases ==');
  const ids = scanHtmlIds(appSrc, html);
  ok('every getElementById id exists in index.html (or is created at runtime)',
    ids.missing.length === 0,
    ids.missing.join(', '));
  const dead = scanDeadFunctions(appSrc);
  if(dead.unused.length){
    find('unused top-level functions (never referenced after definition)',
      `${dead.unused.length}/${dead.defined}: ${dead.unused.join(', ')}`);
  } else {
    ok('no unused top-level functions', true);
  }
  const exportKeys = new Set((api.DRIVE_EXPORT_SPECS || []).map(s => s.key));
  ok('DRIVE_EXPORT_SPECS covers the core Drive tabs',
    REQUIRED_TABS.every(k => exportKeys.has(k)),
    [...REQUIRED_TABS].filter(k => !exportKeys.has(k)).join(', '));
  ok('1_1 / rpiano are not in DRIVE_EXPORT_SPECS (spliced via driveTablesToAoa)',
    !exportKeys.has('oneToOne') && !exportKeys.has('rpiano'));
  const aliasKeys = Object.keys(api.SHEET_ALIASES || {});
  ok('SHEET_ALIASES includes 1_1 and rpiano',
    aliasKeys.includes('oneToOne') && aliasKeys.includes('rpiano'));
  ok('SHEET_ALIASES maps SMALLGR_QUOTAS and ROOMS',
    (api.SHEET_ALIASES.smallGroupQuotas || []).includes('SMALLGR_QUOTAS')
    && (api.SHEET_ALIASES.refRooms || []).includes('ROOMS'));
  ok('SHEET_ALIASES maps SMALL_GROUPS',
    (api.SHEET_ALIASES.smallGroups || []).includes('SMALL_GROUPS'));
  ok('SMALL_GROUPS is not in DRIVE_EXPORT_SPECS (spliced via driveTablesToAoa)',
    !exportKeys.has('smallGroups'));
  const defaultId = api.parseSpreadsheetId(api.DEFAULT_SHEETS_URL);
  ok('DEFAULT_SHEETS_URL parses to a spreadsheet id', !!defaultId, api.DEFAULT_SHEETS_URL);

  let source = 'seed';
  let tables = null;
  let usedNames = {};
  let driveKeep = [];

  if(!args.seedOnly){
    const url = args.url || api.DEFAULT_SHEETS_URL;
    const id = api.parseSpreadsheetId(url) || DEFAULT_ID;
    console.log(`\n== 1. Fetch Google Drive workbook ${id} ==`);
    try {
      const loaded = await loadDriveTables(api, id);
      tables = loaded.tables;
      usedNames = loaded.usedNames;
      console.log('  tabs: ' + (loaded.found.join(', ') || '(none)'));
      if(loaded.missing.filter(k => k !== 'acceptedSchedule').length){
        find('Drive tabs not found (will fall back to seed for those keys)',
          loaded.missing.filter(k => k !== 'acceptedSchedule').join(', '));
      }
      const missingReq = REQUIRED_TABS.filter(k => !tables[k] || !tables[k].length);
      const missingHours = HOURS_TABS.filter(k => !tables[k] || !tables[k].length);
      ok('required Drive tabs present', missingReq.length === 0, missingReq.join(', '));
      ok('1_1 and JRPiano tabs present', missingHours.length === 0, missingHours.join(', '));
      if(missingReq.length && args.requireDrive){
        console.error('\nDrive workbook is missing required tabs. Re-share as Anyone with the link → Viewer, or pass --seed-only.');
        process.exit(1);
      }
      if(!missingReq.length) source = 'drive';
    } catch(err){
      const msg = err && err.message ? err.message : String(err);
      if(args.requireDrive){
        console.error('\nCould not reach Google Sheets: ' + msg);
        console.error('Pass --seed-only to run the same pipeline on public/seed-data.json.');
        process.exit(1);
      }
      find('Drive fetch failed, using seed', msg);
    }
  } else {
    console.log('\n== 1. --seed-only: skip Google Drive ==');
  }

  if(source === 'drive'){
    const {db, keep} = api.sheetsTablesToDb(tables);
    driveKeep = keep || [];
    if(driveKeep.length) find('sheetsTablesToDb kept seed tables for missing Drive tabs', driveKeep.join(', '));
    ok('STUDENTS parsed', (db.students || []).length > 0, String((db.students || []).length));
    const drivePins = (tables.lessons || []).filter(r => String(r.FIXED_DAY || '').trim());
    const missedPins = drivePins.filter(r => {
      const les = (db.lessons || []).find(l => l.id === (r.LESSON_ID || r.ID));
      return !les || !les.fixedDay;
    });
    ok('Drive LESSONS FIXED_DAY / FIXED_START / FIXED_END import onto lessons',
      missedPins.length === 0,
      missedPins.map(r => r.LESSON_ID || r.ID).join(',') || `pins=${drivePins.length}`);
    if(drivePins.length){
      find('Drive lesson pins',
        drivePins.map(r => {
          const les = (db.lessons || []).find(l => l.id === (r.LESSON_ID || r.ID)) || {};
          return `${les.id || r.LESSON_ID} ${les.fixedDay || ''} ${les.fixedStart || ''}–${les.fixedEnd || ''}`;
        }).join(', '));
    }
    api.restoreFromLoadedObject(db);
    const loadedSg = (api.LAST_SMALL_GROUPS && api.LAST_SMALL_GROUPS.smallGroups) || [];
    if(tables.smallGroups && tables.smallGroups.length){
      ok('Drive SMALL_GROUPS restored into the Small Groups tab',
        loadedSg.length > 0,
        `groups=${loadedSg.length} rows=${tables.smallGroups.length}`);
      ok('Drive small groups keep member student ids',
        loadedSg.some(sg => ['bass','drum','acc','sol'].some(t => (sg[t] || []).some(s => s && s.ID))),
        loadedSg.map(sg => sg.id).join(','));
    } else {
      find('Drive workbook has no SMALL_GROUPS tab');
    }
    const hadAccepted = (api.DB.acceptedSchedule || []).length
      || (api.DB.lessons || []).some(l => l.scheduledDay);
    if(hadAccepted){
      find('Drive already had ACCEPTED / SCHEDULED columns — clearing so Generate starts unconstrained',
        `${(api.DB.acceptedSchedule || []).length} accepted rows`);
    }
    api.clearAcceptedScheduledRecord();
    api.LAST_RESULT = null;
    api.LAST_VARIANTS = [];
    api.LAST_ONEONE = null;
    api.LAST_RPIANO = null;
  } else {
    api.DB = clone(seed);
    api.clearAcceptedScheduledRecord();
    api.LAST_SMALL_GROUPS = null;
    api.LAST_RESULT = null;
    api.LAST_VARIANTS = [];
    api.LAST_ONEONE = null;
    api.LAST_RPIANO = null;
  }

  const db = api.DB;
  console.log(`\n== 2. Referential integrity (${source}: ${db.students.length} students, ${db.lessons.length} lessons, ${db.refTeachers.length} teachers) ==`);

  function dups(list, field, label){
    const seen = new Map();
    const twice = [];
    (list || []).forEach(row => {
      const id = String(row[field] || '').trim();
      if(!id) return;
      if(seen.has(id)) twice.push(id);
      seen.set(id, true);
    });
    ok(`no duplicate ${label}`, twice.length === 0, [...new Set(twice)].join(', '));
    return new Set((list || []).map(r => String(r[field] || '').trim()).filter(Boolean));
  }
  const teacherIds = dups(db.refTeachers, 'id', 'teacher ids');
  const classIds = dups(db.refClasses, 'id', 'class ids');
  const groupIds = dups(db.refGroups, 'id', 'group ids');
  const instrIds = dups(db.refInstruments, 'id', 'instrument ids');
  const studentIds = dups(db.students, 'ID', 'student ids');
  dups(db.lessons, 'id', 'lesson ids');

  const blankTeachers = (db.refTeachers || []).filter(t => !t.id || !t.name);
  ok('every teacher has id + name', blankTeachers.length === 0, blankTeachers.map(t => t.id || t.name).join(', '));

  const badClass = [];
  const badInstr = [];
  const badGroup = [];
  const typeMismatch = [];
  const groupsById = {};
  (db.refGroups || []).forEach(g => { groupsById[g.id] = g; });
  (db.students || []).forEach(s => {
    if(s.CLASS_ID && !classIds.has(s.CLASS_ID)) badClass.push(`${s.ID} CLASS_ID=${s.CLASS_ID}`);
    if(s.INSTR_ID && !instrIds.has(s.INSTR_ID)) badInstr.push(`${s.ID} INSTR_ID=${s.INSTR_ID}`);
    GROUP_FIELDS.forEach(f => {
      const gid = s[f.id];
      if(!gid) return;
      if(!groupIds.has(gid)) badGroup.push(`${s.ID} ${f.id}=${gid}`);
      else if(groupsById[gid] && groupsById[gid].type && f.type && groupsById[gid].type !== f.type){
        typeMismatch.push(`${s.ID} ${f.id}=${gid} type ${groupsById[gid].type} (expected ${f.type})`);
      }
    });
  });
  ok('student CLASS_IDs resolve', badClass.length === 0, badClass.slice(0, 12).join('; '));
  ok('student INSTR_IDs resolve', badInstr.length === 0, badInstr.slice(0, 12).join('; '));
  ok('student group IDs resolve', badGroup.length === 0, badGroup.slice(0, 12).join('; '));
  if(typeMismatch.length) find('group TYPE vs student column mismatch', typeMismatch.slice(0, 12).join('; '));
  else ok('group TYPEs match the student columns', true);

  const noClass = (db.students || []).filter(s => !s.CLASS_ID);
  if(noClass.length) find('students with no CLASS_ID (excluded from small groups)', `${noClass.length}: ${noClass.map(s => s.ID).join(', ')}`);

  const badLessonT = (db.lessons || []).filter(l => l.teacherId && !teacherIds.has(l.teacherId));
  const badLessonG = (db.lessons || []).filter(l => l.groupId && !groupIds.has(l.groupId));
  const emptyLessonT = (db.lessons || []).filter(l => !l.teacherId);
  ok('lesson TEACHER_IDs resolve', badLessonT.length === 0, badLessonT.map(l => `${l.id}=${l.teacherId}`).join(', '));
  ok('lesson GROUP_IDs resolve', badLessonG.length === 0, badLessonG.slice(0, 12).map(l => `${l.id}=${l.groupId}`).join(', '));
  if(emptyLessonT.length) find('lessons with no teacher', emptyLessonT.map(l => l.id).join(', '));

  const badAvail = (db.teacherAvail || []).filter(r => r.teacherId && !teacherIds.has(r.teacherId));
  const badCav = (db.classAvail || []).filter(r => r.classId && !classIds.has(r.classId));
  const badBrk = (db.breaks || []).filter(r => r.teacherId && !teacherIds.has(r.teacherId));
  const badQuota = (db.smallGroupQuotas || []).filter(r => r.teacherId && !teacherIds.has(r.teacherId));
  ok('teacher-avail TEACHER_IDs resolve', badAvail.length === 0, badAvail.slice(0, 8).map(r => r.teacherId).join(', '));
  ok('class-reservation CLASS_IDs resolve', badCav.length === 0, badCav.slice(0, 8).map(r => r.classId).join(', '));
  ok('break-management TEACHER_IDs resolve', badBrk.length === 0, badBrk.map(r => r.teacherId).join(', '));
  ok('small group-quota TEACHER_IDs resolve', badQuota.length === 0, badQuota.map(r => r.teacherId).join(', '));
  if(source === 'drive'){
    ok('Drive small-group quotas tab is SMALLGR_QUOTAS',
      usedNames.smallGroupQuotas === 'SMALLGR_QUOTAS', usedNames.smallGroupQuotas || '(missing)');
    ok('Drive quota rows parsed', (db.smallGroupQuotas || []).length > 0,
      String((db.smallGroupQuotas || []).length));
    ok('Drive quota ids are SMGQ*',
      (db.smallGroupQuotas || []).every(q => /^SMGQ\d+$/i.test(q.id || '')),
      (db.smallGroupQuotas || []).map(q => q.id).join(', '));
    ok('Drive rooms tab loaded',
      usedNames.refRooms === 'ROOMS' && (db.refRooms || []).length > 0,
      `${usedNames.refRooms || '(missing)'} n=${(db.refRooms || []).length}`);
    const dupRoomIds = Object.entries((db.refRooms || []).reduce((acc, r) => {
      if(r.id) acc[r.id] = (acc[r.id] || 0) + 1;
      return acc;
    }, {})).filter(([,n]) => n > 1).map(([id,n]) => `${id}×${n}`);
    if(dupRoomIds.length) find('ROOMS has duplicate ROOM_IDs', dupRoomIds.join(', '));
  }

  const teachersWithoutAvail = [...teacherIds].filter(id =>
    !(db.teacherAvail || []).some(r => r.teacherId === id && r.type !== 'AVOID'));
  if(teachersWithoutAvail.length){
    find('teachers with no availability windows', teachersWithoutAvail.map(id => {
      const t = (db.refTeachers || []).find(x => x.id === id);
      return (t && t.name) || id;
    }).join(', '));
  }

  const oneAsg = api.collectOneOneAssignments(db.oneToOne);
  const rjpAsg = api.collectOneOneAssignments(db.rpiano);
  ok('1/1 matrix has hours', oneAsg.length > 0, String(oneAsg.length));
  ok('Required Piano matrix has hours', rjpAsg.length > 0, String(rjpAsg.length));
  const badOneS = oneAsg.filter(a => !studentIds.has(a.studentId));
  const badOneT = oneAsg.filter(a => !teacherIds.has(a.teacherId));
  const badRjpS = rjpAsg.filter(a => !studentIds.has(a.studentId));
  const badRjpT = rjpAsg.filter(a => !teacherIds.has(a.teacherId));
  ok('1/1 student IDs exist', badOneS.length === 0, badOneS.map(a => a.studentId).join(', '));
  ok('1/1 teacher IDs exist', badOneT.length === 0, badOneT.map(a => a.teacherId).join(', '));
  ok('RJP student IDs exist', badRjpS.length === 0, badRjpS.map(a => a.studentId).join(', '));
  ok('RJP teacher IDs exist', badRjpT.length === 0, badRjpT.map(a => a.teacherId).join(', '));

  if(source === 'drive' && tables.oneToOne){
    const leak1 = hoursLeak(api, tables.oneToOne, db.refTeachers);
    ok('1_1 numeric cells map to a teacher column', leak1.unmatched === 0,
      leak1.unmatchedCols.join(', ') + ` (${leak1.unmatched} cells)`);
    ok('1_1 parsed hours count matches matched cells', leak1.matched === oneAsg.length,
      `raw ${leak1.matched} vs parsed ${oneAsg.length}`);
  }
  if(source === 'drive' && tables.rpiano){
    const leakP = hoursLeak(api, tables.rpiano, db.refTeachers);
    ok('JRPiano numeric cells map to a teacher column', leakP.unmatched === 0,
      leakP.unmatchedCols.join(', ') + ` (${leakP.unmatched} cells)`);
    ok('JRPiano parsed hours count matches matched cells', leakP.matched === rjpAsg.length,
      `raw ${leakP.matched} vs parsed ${rjpAsg.length}`);
  }
  if(usedNames.oneToOne) ok('1/1 tab name used', true, usedNames.oneToOne);
  if(usedNames.rpiano){
    ok('Required Piano tab is rpiano',
      /^rpiano$/i.test(usedNames.rpiano) || /jrpiano/i.test(usedNames.rpiano),
      usedNames.rpiano);
  }

  console.log('\n== 3. Round-trip export (Drive-shaped workbook) ==');
  const aoa = api.driveTablesToAoa(db);
  const sheetNames = aoa.map(s => s.name);
  ok('export includes STUDENTS', sheetNames.includes('STUDENTS'));
  ok('export includes SMALL_GROUPS', sheetNames.includes('SMALL_GROUPS'));
  ok('export includes SMALLGR_QUOTAS', sheetNames.includes('SMALLGR_QUOTAS'));
  ok('export includes ROOMS', sheetNames.includes('ROOMS'));
  ok('export includes 1_1', sheetNames.includes('1_1'));
  ok('export includes rpiano', sheetNames.includes('rpiano'));
  const oneSheet = aoa.find(s => s.name === '1_1');
  const rjpSheet = aoa.find(s => s.name === 'rpiano');
  const oneBack = api.parseOneToOneTable(aoaToObjects(oneSheet.aoa), db.refTeachers);
  const rjpBack = api.parseOneToOneTable(aoaToObjects(rjpSheet.aoa), db.refTeachers);
  ok('1_1 round-trip keeps assignment count',
    api.collectOneOneAssignments(oneBack).length === oneAsg.length,
    `${api.collectOneOneAssignments(oneBack).length} vs ${oneAsg.length}`);
  ok('JRPiano round-trip keeps assignment count',
    api.collectOneOneAssignments(rjpBack).length === rjpAsg.length,
    `${api.collectOneOneAssignments(rjpBack).length} vs ${rjpAsg.length}`);
  const exported = api.dbToDriveTables(db);
  const {db: reimported} = api.sheetsTablesToDb(Object.assign({}, exported, {
    oneToOne: tables && tables.oneToOne ? tables.oneToOne : undefined,
    rpiano: tables && tables.rpiano ? tables.rpiano : undefined
  }));
  ok('reimport student count', reimported.students.length === db.students.length,
    `${reimported.students.length} vs ${db.students.length}`);
  ok('reimport lesson count', reimported.lessons.length === db.lessons.length,
    `${reimported.lessons.length} vs ${db.lessons.length}`);

  console.log('\n== 4. Generate small groups → timetable (100 layouts, keep 10, unless --quick) ==');
  const smallGroups = api.generateSmallGroups(16);
  api.LAST_SMALL_GROUPS = smallGroups;
  ok('generated 16 small groups (or as many as roster allows)',
    smallGroups && Array.isArray(smallGroups.smallGroups) && smallGroups.smallGroups.length > 0,
    smallGroups && smallGroups.smallGroups ? String(smallGroups.smallGroups.length) : 'none');
  const emptySmallGroupRecords = (smallGroups.smallGroups || []).filter(b =>
    !['bass','drum','acc','sol'].some(t => (b[t] || []).length));
  if(emptySmallGroupRecords.length) find('empty small group shells', String(emptySmallGroupRecords.length));
  console.log(`  small groups=${smallGroups.smallGroups.length} excluded=${(smallGroups.excluded||[]).length} eligible=${smallGroups.eligibleCount}`);

  const tSched0 = Date.now();
  if(args.quick){
    const result = api.runScheduler(false);
    api.LAST_RESULT = result;
    api.LAST_VARIANTS = [result];
  } else {
    api.runGenerateTimetable(true);
  }
  console.log(`  timetable search ${(Date.now()-tSched0)/1000}s — ${(api.LAST_VARIANTS||[]).length} layout(s), ${(api.LAST_RESULT && api.LAST_RESULT.scheduled || []).length} placed, ${(api.LAST_RESULT && api.LAST_RESULT.unresolved || []).length} unresolved`);
  ok('timetable produced a result', !!(api.LAST_RESULT && api.LAST_RESULT.scheduled));
  if(!args.quick){
    const nVar = (api.LAST_VARIANTS || []).length;
    ok('timetable search keeps at most 10 layouts', nVar <= (api.SCHEDULE_VARIANT_KEEP || 10), String(nVar));
    if(nVar < 2) find('timetable search found only one distinct layout', String(nVar));
  }
  const inv = checkSchedule(api.DB, api.LAST_SMALL_GROUPS, api.LAST_RESULT);
  ok('independent invariant checker: groups + small groups', inv.length === 0, inv.slice(0, 8).join(' | '));
  const ttAudit = api.auditTimetable(api.LAST_RESULT.scheduled || []);
  const ttErr = auditErrors(ttAudit);
  ok('auditTimetable has no red errors on generated groups', ttErr.length === 0,
    ttErr.slice(0, 8).map(e => stripHtml(e.html)).join(' | '));
  const ttWarn = ((ttAudit && ttAudit.entries) || []).filter(e => e.level === 'warning');
  if(ttWarn.length) find('timetable GAP/break warnings (yellow, not red)', `${ttWarn.length}`);
  const ttClash = independentClashes(api, api.LAST_RESULT.scheduled || []);
  ok('independent clash check on generated groups', ttClash.length === 0, ttClash.slice(0, 8).join(' | '));

  const unresolved = api.LAST_RESULT.unresolved || [];
  if(unresolved.length){
    find('unresolved group/small group lessons after Generate',
      unresolved.map(u => (u.lesson && u.lesson.id) || '?').join(', '));
  }
  ok('1/1 still locked before Accept timetable', !api.hasAcceptedRecord() && !api.canOpenOneOne());
  ok('unaccepted generate locks other tabs', api.hasPendingAccept() === true && api.pendingAcceptTab() === 'timetable');
  ok('unaccepted generate locks Reports', api.canSwitchTab('reports') === false);

  console.log('\n== 5. Accept timetable → Generate 1/1 → Accept 1/1 ==');
  api.acceptTimetableSchedule();
  ok('hasAcceptedRecord after Accept', api.hasAcceptedRecord());
  ok('LAST_RESULT.accepted', !!(api.LAST_RESULT && api.LAST_RESULT.accepted));
  ok('1/1 tab open after Accept', api.canOpenOneOne());
  ok('Reports open after Accept timetable', api.canOpenReports() && api.canSwitchTab('reports'));
  ok('acceptedSchedule rows written', (api.DB.acceptedSchedule || []).length > 0,
    String((api.DB.acceptedSchedule || []).length));
  const written = api.writeAcceptedToSourceTables(api.LAST_RESULT);
  ok('SCHEDULED columns written back onto lessons/small groups',
    (written && (written.lessonsWritten || written.smallGroupsWritten)) > 0,
    JSON.stringify(written));

  const t11 = Date.now();
  const oneVariants = args.quick
    ? [api.scheduleAllOneToOne({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule || []})]
    : api.scheduleAllOneToOneSearch({matrix: api.DB.oneToOne, acceptedRows: api.DB.acceptedSchedule || []});
  api.applyIndividualSearch('oneone', oneVariants, '');
  console.log(`  1/1 search ${(Date.now()-t11)/1000}s — ${oneVariants.length} layout(s), ${(api.LAST_ONEONE.scheduled||[]).length} placed, ${(api.LAST_ONEONE.unresolved||[]).length} left out`);
  ok('1/1 placed at least one lesson', (api.LAST_ONEONE.scheduled || []).length > 0);
  ok('unaccepted 1/1 is NOT in frozenIndividualItems / timetable audit',
    api.frozenIndividualItems().length === 0);
  if(!args.quick && oneVariants.length < 15){
    find('1/1 search found fewer than 15 distinct layouts', String(oneVariants.length));
  }
  const oneUnresolved = api.LAST_ONEONE.unresolved || [];
  if(oneUnresolved.length){
    find('unplaced 1/1 assignments',
      oneUnresolved.map(u => formatUnresolvedOne(u, api)).slice(0, 20).join('; '));
  }
  const oneWeek = api.combinedWeekItems('oneone');
  const oneAudit = api.auditTimetable(oneWeek);
  const oneErr = auditErrors(oneAudit);
  ok('combined week (accepted groups + generated 1/1) has no red errors',
    oneErr.length === 0, oneErr.slice(0, 8).map(e => stripHtml(e.html)).join(' | '));
  const oneClash = independentClashes(api, oneWeek);
  ok('independent clash check: accepted groups + 1/1', oneClash.length === 0, oneClash.slice(0, 8).join(' | '));
  ok('RJP still locked before Accept 1/1', !api.hasAcceptedOneOne() && !api.canOpenRpiano());
  ok('unaccepted 1/1 locks every other tab', api.pendingAcceptTab() === 'oneone');

  api.acceptOneOneSchedule();
  ok('hasAcceptedOneOne after Accept 1/1', api.hasAcceptedOneOne());
  ok('RJP still empty after first Accept 1/1', api.LAST_RPIANO == null);
  ok('KIND on accepted 1/1 rows is 1/1',
    ((api.LAST_ONEONE.acceptedSchedule || []).every(r => r.kind === '1/1')),
    (api.LAST_ONEONE.acceptedSchedule || []).slice(0,3).map(r => r.kind).join(','));
  ok('frozen 1/1 now binds timetable audit',
    api.frozenIndividualItems().length === (api.LAST_ONEONE.scheduled || []).length);
  const ttBound = api.timetableAuditItems(api.LAST_RESULT.scheduled || []);
  ok('timetableAuditItems = groups + frozen 1/1 (not drawn, but checked)',
    ttBound.length === (api.LAST_RESULT.scheduled || []).length + (api.LAST_ONEONE.scheduled || []).length);

  console.log('\n== 6. Generate Required Piano → Accept ==');
  ok('RJP generate is allowed after Accept 1/1', api.hasAcceptedOneOne() && api.canOpenRpiano());
  const tRjp = Date.now();
  const rjpOpts = {
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE && api.LAST_ONEONE.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  };
  const rjpVariants = args.quick
    ? [api.scheduleAllOneToOne(rjpOpts)]
    : api.scheduleAllOneToOneSearch(rjpOpts);
  api.applyIndividualSearch('rpiano', rjpVariants, '');
  console.log(`  RJP search ${(Date.now()-tRjp)/1000}s — ${rjpVariants.length} layout(s), ${(api.LAST_RPIANO.scheduled||[]).length} placed, ${(api.LAST_RPIANO.unresolved||[]).length} left out`);
  ok('RJP placed at least one lesson', (api.LAST_RPIANO.scheduled || []).length > 0);
  if(!args.quick && rjpVariants.length < 15){
    find('RJP search found fewer than 15 distinct layouts', String(rjpVariants.length));
  }
  const rjpUnresolved = api.LAST_RPIANO.unresolved || [];
  if(rjpUnresolved.length){
    find('unplaced Required Piano assignments',
      rjpUnresolved.map(u => formatUnresolvedOne(u, api)).slice(0, 20).join('; '));
  }
  const mixedWeek = api.combinedWeekItems('rpiano');
  const mixedAudit = api.auditTimetable(mixedWeek);
  const mixedErr = auditErrors(mixedAudit);
  ok('combined week (groups + 1/1 + piano) has no red errors',
    mixedErr.length === 0, mixedErr.slice(0, 8).map(e => stripHtml(e.html)).join(' | '));
  const mixedClash = independentClashes(api, mixedWeek);
  ok('independent clash check: groups + 1/1 + piano', mixedClash.length === 0, mixedClash.slice(0, 8).join(' | '));
  const mixedWarn = ((mixedAudit && mixedAudit.entries) || []).filter(e => e.level === 'warning');
  if(mixedWarn.length) find('combined-week GAP/break warnings', String(mixedWarn.length));

  const pianoIds = new Set((api.LAST_RPIANO.scheduled || []).map(s => s.lessonId));
  const oneIds = new Set((api.LAST_ONEONE.scheduled || []).map(s => s.lessonId));
  const overlapIds = [...pianoIds].filter(id => oneIds.has(id));
  ok('1/1 and RJP lessonIds do not collide', overlapIds.length === 0, overlapIds.join(', '));
  ok('RJP items use source rpiano / piano label',
    (api.LAST_RPIANO.scheduled || []).every(s => s.source === 'rpiano' || /piano/i.test(s.name || '')),
    (api.LAST_RPIANO.scheduled || []).slice(0,3).map(s => s.source+'/'+s.name).join(', '));

  api.acceptRpianoSchedule();
  ok('hasAcceptedRpiano after Accept', api.hasAcceptedRpiano());
  ok('KIND on accepted piano rows is piano',
    ((api.LAST_RPIANO.acceptedSchedule || []).every(r => r.kind === 'piano')));
  ok('frozen items include 1/1 + piano',
    api.frozenIndividualItems().length === (api.LAST_ONEONE.scheduled || []).length + (api.LAST_RPIANO.scheduled || []).length);

  const afterAll = api.auditTimetable(api.timetableAuditItems(api.LAST_RESULT.scheduled || []));
  const afterErr = auditErrors(afterAll);
  ok('timetable audit with frozen 1/1+piano has no red errors',
    afterErr.length === 0, afterErr.slice(0, 8).map(e => stripHtml(e.html)).join(' | '));
  const afterWarn = ((afterAll && afterAll.entries) || []).filter(e => e.level === 'warning');
  ok('GAP warnings do not paint conflictIds',
    afterWarn.length === 0 || (afterAll.conflictIds && ![...afterAll.conflictIds].length) ||
    afterWarn.every(e => (e.ids || []).every(id => !afterAll.conflictIds.has(id))));

  const ics = api.buildTimetableIcs(api.LAST_RESULT.scheduled || []);
  ok('ICS export is a calendar', typeof ics === 'string' && /BEGIN:VCALENDAR/.test(ics));
  const bundle = api.buildFullExportObject();
  ok('JSON export includes oneToOneState.accepted',
    !!(bundle && bundle.oneToOneState && bundle.oneToOneState.accepted));
  ok('JSON export includes rpianoState.accepted',
    !!(bundle && bundle.rpianoState && bundle.rpianoState.accepted));

  console.log('\n== 7. Drag un-accepts; re-Accept writes the dragged times ==');
  const oneItem = (api.LAST_ONEONE.scheduled || [])[0];
  ok('have a 1/1 block to drag', !!oneItem);
  if(oneItem){
    const from = {day: oneItem.day, start: oneItem.start, end: oneItem.end};
    moveItem(oneItem, 15, oneItem.day);
    api.markLayoutNeedsAccept('oneone');
    ok('1/1 Accept re-opens after drag', api.LAST_ONEONE.accepted === false);
    ok('1/1 drag keeps Required Piano data',
      api.hasAcceptedRpiano() === true);
    ok('1/1 drag locks Required Piano until 1/1 is accepted again',
      api.canOpenRpiano() === false);
    ok('1/1 drag locks every other tab', api.pendingAcceptTab() === 'oneone');
    ok('frozen 1/1 drops out of timetable audit while unaccepted',
      api.frozenIndividualItems().length === (api.LAST_RPIANO && api.LAST_RPIANO.accepted ? (api.LAST_RPIANO.scheduled||[]).length : 0));
    api.acceptOneOneSchedule();
    ok('re-Accept 1/1 freezes the dragged time',
      oneItem.start === from.start + 15 && api.hasAcceptedOneOne());
    ok('re-Accept 1/1 keeps Required Piano on file', api.LAST_RPIANO != null && api.hasAcceptedRpiano());
    ok('re-Accept 1/1 unlocks Required Piano', api.canOpenRpiano() === true);
  }

  // Keep the frozen piano while dragging 1/1; regenerate only if packing around the new 1/1.
  const rjpOpts2 = {
    matrix: api.DB.rpiano,
    acceptedRows: (api.DB.acceptedSchedule || []).concat(api.busyRowsFromScheduled(api.LAST_ONEONE && api.LAST_ONEONE.scheduled)),
    source: 'rpiano',
    lessonLabel: 'piano',
    idPrefix: 'RP'
  };
  const rjpAgain = args.quick
    ? [api.scheduleAllOneToOne(rjpOpts2)]
    : api.scheduleAllOneToOneSearch(rjpOpts2);
  api.applyIndividualSearch('rpiano', rjpAgain, '');
  api.acceptRpianoSchedule();
  const rjpItem = (api.LAST_RPIANO.scheduled || [])[0];
  ok('have a piano block to drag', !!rjpItem);
  if(rjpItem){
    const from = {day: rjpItem.day, start: rjpItem.start, end: rjpItem.end};
    moveItem(rjpItem, 15, rjpItem.day);
    api.markLayoutNeedsAccept('rpiano');
    ok('RJP Accept re-opens after drag', api.LAST_RPIANO.accepted === false);
    ok('hasAcceptedRpiano is false after piano drag', !api.hasAcceptedRpiano());
    api.acceptRpianoSchedule();
    ok('re-Accept piano freezes the dragged time',
      rjpItem.start === from.start + 15 && api.hasAcceptedRpiano());
    ok('piano drag does not clear 1/1 Accept', api.hasAcceptedOneOne());
  }

  const ttItem = (api.LAST_RESULT.scheduled || [])[0];
  ok('have a group block to drag', !!ttItem);
  if(ttItem){
    const from = {day: ttItem.day, start: ttItem.start, end: ttItem.end};
    moveItem(ttItem, 5, ttItem.day);
    api.markLayoutNeedsAccept('timetable');
    ok('timetable Accept re-opens after drag', api.LAST_RESULT.accepted === false);
    ok('timetable drag does not clear acceptedSchedule',
      api.hasAcceptedRecord() && api.hasAcceptedOneOne());
    ok('timetable drag locks 1/1 until re-Accept', api.canOpenOneOne() === false);
    ok('timetable drag locks Required Piano until groups are accepted', api.canOpenRpiano() === false);
    ok('timetable drag locks every other tab', api.pendingAcceptTab() === 'timetable');
    api.acceptTimetableSchedule();
    ok('re-Accept timetable writes the dragged slot',
      ttItem.start === from.start + 5 && api.LAST_RESULT.accepted);
    ok('re-Accept timetable unlocks 1/1', api.canOpenOneOne() === true);
  }

  const finalWeek = api.combinedWeekItems();
  const finalClash = independentClashes(api, finalWeek);
  const finalAudit = auditErrors(api.auditTimetable(finalWeek));
  // Drag always sticks — leftover overlaps must surface in the audit, not vanish.
  if(finalClash.length || finalAudit.length){
    find('after blind +15min drags, leftover overlaps are reported (drag always sticks)',
      (finalClash.length ? finalClash.slice(0, 4).join(' | ') : finalAudit.slice(0, 4).map(e => stripHtml(e.html)).join(' | ')));
  } else {
    ok('blind +15min drags happened to stay clash-free', true);
  }

  const ms = Date.now() - t0;
  console.log('\n' + '─'.repeat(64));
  console.log(`Source: ${source}${usedNames.rpiano ? '  piano-tab='+usedNames.rpiano : ''}  ${args.quick ? 'quick' : 'full search'}`);
  console.log(`PASS ${passed}   FAIL ${failed}   FINDING ${findings.length}   ${(ms/1000).toFixed(1)}s`);
  if(findings.length){
    console.log('\nFindings (data / coverage / dead code — do not fail the pipeline):');
    findings.forEach(f => console.log('  • ' + f));
  }
  if(failed){
    console.error('\nFailures:');
    failures.forEach(f => console.error('  • ' + f));
    process.exit(1);
  }
  console.log('\nEnd-to-end pipeline is green.');
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
