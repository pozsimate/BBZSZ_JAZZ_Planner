// ---------- Load seed data ----------
function showBootError(err){
  const msg = (err && err.stack) || String(err || 'unknown error');
  try { console.error(err); } catch(e){}
  if(window.__BJP_BOOT_ERROR__) return;
  window.__BJP_BOOT_ERROR__ = true;
  const el = document.createElement('pre');
  el.style.cssText = 'margin:16px;padding:16px;white-space:pre-wrap;background:#3a1020;color:#ffd0d8;border-radius:8px;max-height:240px;overflow:auto';
  el.textContent = 'Planner failed to start:\n' + msg;
  document.body.insertBefore(el, document.body.firstChild);
}
window.addEventListener('error', ev => {
  showBootError(ev.error || ev.message);
});

function emptyPlannerDb(){
  return {
    students:[], lessons:[], teacherAvail:[], classAvail:[],
    refTeachers:[], refClasses:[], refGroups:[], refInstruments:[], refRooms:[],
    breaks:[], smallGroupQuotas:[],
    oneToOne:{columns:[], hours:{}}, rpiano:{columns:[], hours:{}},
    acceptedSchedule:[],
    phase1TeacherOrder:null,
    forbidUnlistedGroupGaps:false,
    lookaheadEveryLayout:false,
    teacherSwapProbe:false
  };
}
function dbLooksEmpty(db){
  const d = db || DB || {};
  return !(d.students||[]).length && !(d.lessons||[]).length && !(d.refTeachers||[]).length
    && !(d.teacherAvail||[]).length && !(d.classAvail||[]).length;
}

let SEED;
let DB;
try {
  const raw = ((document.getElementById('seed-data') || {}).textContent || '').trim();
  SEED = raw ? JSON.parse(raw) : emptyPlannerDb();
  DB = JSON.parse(JSON.stringify(SEED));
} catch(e){
  showBootError(e);
  SEED = emptyPlannerDb();
  DB = JSON.parse(JSON.stringify(SEED));
}
DB.smallGroupQuotas = DB.smallGroupQuotas || [];
DB.refRooms = DB.refRooms || [];

let LAST_RESULT = null;
let LAST_AUDIT = null;
let LAST_VARIANTS = [];
let LAST_FINGERPRINT = null;
let LAST_SMALL_GROUPS = null;
let LAST_ONEONE = null;
let LAST_RPIANO = null;

const DAYS = ["MON","TUE","WED","THU","FRI"];
const DAY_LABEL = {MON:"Monday",TUE:"Tuesday",WED:"Wednesday",THU:"Thursday",FRI:"Friday"};
const DEFAULT_START = 8*60, DEFAULT_END = 20*60;
const TYPE_OPTIONS = ["AVAILABLE","PREFERRED","FALLBACK","CANDIDATE","AVOID"];
const SCOPE_OPTIONS = ["ALL","O2O","GROUP"];
function normalizeAvailScope(raw){
  const s = String(raw == null ? '' : raw).trim().toUpperCase();
  if(s === 'O2O' || s === '1/1' || s === 'ONEONE' || s === 'INDIVIDUAL' || s === 'PIANO') return 'O2O';
  if(s === 'GROUP' || s === 'GROUPS' || s === 'SG') return 'GROUP';
  return 'ALL';
}
function availScopeMatches(row, kind){
  if(!kind || kind === 'any') return true;
  const scope = normalizeAvailScope(row && row.scope);
  if(scope === 'ALL') return true;
  if(kind === 'group') return scope === 'GROUP';
  if(kind === 'oneone') return scope === 'O2O';
  return true;
}
function availKindForItem(item){
  if(!item) return 'any';
  if(item.source === 'oneone' || item.source === 'rpiano') return 'oneone';
  return 'group';
}

// ---------- Time helpers ----------
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

function lessonDurationMinutes(obj){
  const n = parseInt(obj && obj.duration, 10);
  return n > 0 ? n : 90;
}

// A pinned window must be exactly the lesson/small group duration. Snap FIXED END to start+duration
// whether the typed range was shorter or longer. Returns true if the stored end changed.
function clampBookedWindowToDuration(obj){
  if(!obj) return false;
  const start = toMin(obj.fixedStart);
  const end = toMin(obj.fixedEnd);
  if(start == null || end == null) return false;
  const exact = start + lessonDurationMinutes(obj);
  if(end === exact) return false;
  obj.fixedEnd = toHHMM(exact);
  return true;
}

// ---------- Lookup helpers (built fresh from the reference tables every time) ----------
function lookupMap(list){ const m={}; list.forEach(r=>{ m[r.id]=r.name; }); return m; }
function teacherName(id){ return lookupMap(DB.refTeachers)[id] || ''; }
function className(id){ return lookupMap(DB.refClasses)[id] || ''; }
function classMuclass(id){
  const c = DB.refClasses.find(r => r.id === id);
  if(!c) return '';
  return (c.muclass != null && String(c.muclass).trim() !== '') ? String(c.muclass).trim() : String(c.jclass || '').trim();
}
function groupName(id){ return lookupMap(DB.refGroups)[id] || ''; }
function instrName(id){ return lookupMap(DB.refInstruments)[id] || ''; }
function instrType(id){ const i = DB.refInstruments.find(r => r.id === id); return (i && i.type) || ''; }
function roomName(id, rooms){
  if(!id) return '';
  const list = rooms || (DB && DB.refRooms) || [];
  const hit = list.find(r => String(r.id) === String(id));
  return (hit && hit.name) || '';
}
function defaultRoomId(rooms){
  const list = rooms || (DB && DB.refRooms) || [];
  return list.length ? list[0].id : '';
}
function itemRoomId(item){
  return item ? String(item.roomId || '').trim() : '';
}
function itemRoomLabel(item){
  const id = itemRoomId(item);
  if(!id) return '';
  return (item && item.room) || roomName(id) || id;
}
function roomClashLabel(item){
  return itemRoomLabel(item) || 'the same room';
}
function roomsOverlap(a, b){
  const ra = itemRoomId(a), rb = itemRoomId(b);
  return !!(ra && rb && ra === rb);
}
function roomFieldsOf(obj){
  const roomId = itemRoomId(obj);
  return { roomId, room: (obj && obj.room) || roomName(roomId) };
}
function occupyRoom(roomBusy, roomId, day, start, end){
  if(!roomId) return;
  roomBusy[roomId] = roomBusy[roomId] || {};
  roomBusy[roomId][day] = roomBusy[roomId][day] || [];
  roomBusy[roomId][day].push({start, end});
}
function vacateRoom(roomBusy, roomId, day, start, end){
  if(!roomId || !roomBusy[roomId] || !roomBusy[roomId][day]) return;
  const list = roomBusy[roomId][day];
  const i = list.findIndex(iv => iv.start === start && iv.end === end);
  if(i >= 0) list.splice(i, 1);
}
function roomSlotTaken(roomBusy, roomId, day, start, end){
  if(!roomId) return false;
  const list = (roomBusy[roomId] && roomBusy[roomId][day]) || [];
  return list.some(iv => intervalsOverlap(start, end, iv.start, iv.end));
}
function migrateRoomLock(obj, opts){
  if(!obj) return obj;
  if(String(obj.roomId || '').trim()){
    obj.room = obj.room || roomName(obj.roomId);
    return obj;
  }
  if(Object.prototype.hasOwnProperty.call(obj, 'roomId')){
    obj.roomId = '';
    obj.room = '';
    return obj;
  }
  if(opts && opts.defaultOn){
    obj.roomId = defaultRoomId();
    obj.room = roomName(obj.roomId);
  } else {
    obj.roomId = '';
    obj.room = '';
  }
  return obj;
}
function normalizeDbRooms(db){
  if(!db) return db;
  db.refRooms = db.refRooms || [];
  (db.lessons || []).forEach(l => migrateRoomLock(l, {defaultOn:false}));
  const sgs = (db.smallGroupsState && db.smallGroupsState.smallGroups) || [];
  sgs.forEach(sg => migrateRoomLock(sg, {defaultOn:false}));
  (db.acceptedSchedule || []).forEach(r => migrateRoomLock(r, {defaultOn:false}));
  ((db.oneToOne && db.oneToOne.columns) || []).forEach(c => migrateRoomLock(c, {defaultOn:false}));
  ((db.rpiano && db.rpiano.columns) || []).forEach(c => migrateRoomLock(c, {defaultOn:false}));
  migrateStudentRooms(db.oneToOne);
  migrateStudentRooms(db.rpiano);
  (db.refClasses || []).forEach(c => {
    if((c.muclass == null || c.muclass === '') && c.jclass) c.muclass = c.jclass;
  });
  (db.teacherAvail || []).forEach(r => { r.scope = normalizeAvailScope(r.scope); });
  return db;
}
normalizeDbRooms(DB);

const TYPE_RANK = {AVAILABLE:0, PREFERRED:0, FALLBACK:1, CANDIDATE:2};

// ---------- Generic editable table renderer ----------
// colDefs: [{key,label,type:'text'|'select'|'readonly', options:()=>[{id,name}], syncField (for select: field to auto-fill with the option's name), width}]
function renderTable(tableEl, rows, colDefs, onChange){
  let html = '<thead><tr>';
  colDefs.forEach(c => html += `<th${c.width ? ` style="min-width:${c.width}"` : ''}>${c.label}</th>`);
  html += '<th></th></tr></thead><tbody>';
  rows.forEach((row,i) => {
    html += '<tr data-idx="'+i+'">';
    colDefs.forEach(c => {
      const val = row[c.key] ?? '';
      const widthStyle = c.width ? `min-width:${c.width};` : '';
      if(c.type === 'select'){
        const opts = c.options();
        let optHtml = '<option value="">—</option>';
        opts.forEach(o => {
          optHtml += `<option value="${escapeAttr(o.id)}" ${o.id===val?'selected':''}>${escapeAttr(o.name)}</option>`;
        });
        html += `<td style="${widthStyle}"><select data-field="${c.key}" data-idx="${i}" data-sync="${c.syncField||''}">${optHtml}</select></td>`;
      } else if(c.type === 'daySelect'){
        let optHtml = '<option value="">—</option>';
        DAYS.forEach(d => { optHtml += `<option value="${d}" ${d===val?'selected':''}>${d}</option>`; });
        const cls = row.dayInferred ? 'day-inferred' : '';
        html += `<td class="${cls}" style="${widthStyle}"><select data-field="${c.key}" data-idx="${i}">${optHtml}</select></td>`;
      } else if(c.type === 'typeSelect'){
        let optHtml='';
        TYPE_OPTIONS.forEach(t => { optHtml += `<option value="${t}" ${t===val?'selected':''}>${t}</option>`; });
        html += `<td style="${widthStyle}"><select data-field="${c.key}" data-idx="${i}">${optHtml}</select></td>`;
      } else if(c.type === 'scopeSelect'){
        const scopeVal = normalizeAvailScope(val);
        let optHtml='';
        SCOPE_OPTIONS.forEach(t => { optHtml += `<option value="${t}" ${t===scopeVal?'selected':''}>${t}</option>`; });
        html += `<td style="${widthStyle}"><select data-field="${c.key}" data-idx="${i}">${optHtml}</select></td>`;
      } else if(c.type === 'readonly'){
        const shown = typeof c.value === 'function' ? c.value(row) : val;
        if(c.plain){
          html += `<td style="${widthStyle}white-space:nowrap">${escapeAttr(shown)}</td>`;
        } else {
          html += `<td style="${widthStyle}"><input data-field="${c.key}" data-idx="${i}" value="${escapeAttr(shown)}" disabled></td>`;
        }
      } else if(c.type === 'checkbox'){
        html += `<td style="text-align:center;${widthStyle}"><input type="checkbox" data-field="${c.key}" data-idx="${i}" ${val ? 'checked' : ''}></td>`;
      } else {
        html += `<td style="${widthStyle}"><input data-field="${c.key}" data-idx="${i}" value="${escapeAttr(val)}"></td>`;
      }
    });
    html += `<td><button class="btn danger small" data-del="${i}">✕</button></td>`;
    html += '</tr>';
  });
  html += '</tbody>';
  tableEl.innerHTML = html;

  tableEl.querySelectorAll('input:not([disabled]):not([type=checkbox])').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx,10);
      rows[idx][e.target.dataset.field] = e.target.value;
      markWorkDirty();
    });
    // Fire the dependent-tab refresh on blur (not on every keystroke, to avoid
    // re-rendering other tabs while still mid-edit) — this is what makes an edit here
    // (e.g. renaming a group) actually show up in dropdowns on Students/Lessons/etc.
    inp.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx,10);
      if(clampBookedWindowToDuration(rows[idx])){
        const endInp = tableEl.querySelector(`tr[data-idx="${idx}"] input[data-field="fixedEnd"]`);
        if(endInp) endInp.value = rows[idx].fixedEnd;
      }
      if(onChange) onChange();
      markWorkDirty();
      updateFixedPinsBanner();
    });
  });
  tableEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx,10);
      rows[idx][e.target.dataset.field] = e.target.checked;
      if(onChange) onChange();
      markWorkDirty();
    });
  });
  tableEl.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx,10);
      const field = e.target.dataset.field;
      rows[idx][field] = e.target.value;
      const syncField = e.target.dataset.sync;
      if(syncField){
        const opts = colDefs.find(c=>c.key===field).options();
        const found = opts.find(o=>o.id===e.target.value);
        rows[idx][syncField] = found ? found.name : '';
      }
      if(onChange) onChange();
      markWorkDirty();
      updateFixedPinsBanner();
      render(); // re-render this table so the synced readonly field updates
    });
  });

  function render(){ renderTable(tableEl, rows, colDefs, onChange); }
  tableEl.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.del,10);
      rows.splice(idx,1);
      markWorkDirty();
      updateFixedPinsBanner();
      renderTable(tableEl, rows, colDefs, onChange);
    });
  });
}
function escapeAttr(s){
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

// ---------- Column definitions ----------
const groupOpts = () => DB.refGroups;
const groupOptsByType = (type) => () => DB.refGroups.filter(g => g.type === type);
const teacherOpts = () => DB.refTeachers;
const classOpts = () => DB.refClasses;
const instrOpts = () => DB.refInstruments;
const roomOpts = () => DB.refRooms || [];

const STUDENT_COLDEFS = [
  {key:'ID', label:'ID', type:'text', width:'70px'},
  {key:'NAME1', label:'NAME1', type:'text', width:'130px'},
  {key:'NAME2', label:'NAME2', type:'text', width:'130px'},
  {key:'NAME3', label:'NAME3', type:'text', width:'130px'},
  {key:'PUBLIC_NAME', label:'PUBLIC_NAME', type:'text', width:'120px'},
  {key:'INSTR_ID', label:'INSTR', type:'select', options:instrOpts, syncField:'INSTR', width:'100px'},
  {key:'CLASS_ID', label:'CLASS', type:'select', options:classOpts, syncField:'CLASS', width:'80px'},
  {key:'IMPR_ID', label:'IMPR', type:'select', options:groupOptsByType('IMPR'), syncField:'IMPR', width:'130px'},
  {key:'VOC_ID', label:'VOC', type:'select', options:groupOptsByType('VOC'), syncField:'VOC', width:'175px'},
  {key:'JTH_ID', label:'JTH', type:'select', options:groupOptsByType('JAZZTHEO'), syncField:'JTH', width:'155px'},
  {key:'SOLF_ID', label:'SOLF', type:'select', options:groupOptsByType('SOLF'), syncField:'SOLF', width:'115px'},
  {key:'JHIST_ID', label:'JHIST', type:'select', options:groupOptsByType('JAZZHIS'), syncField:'JHIST', width:'135px'},
  {key:'RHIMPR_ID', label:'RHIMPR', type:'select', options:groupOptsByType('RHYTHM'), syncField:'RHIMPR', width:'155px'},
  {key:'AC_ID', label:'AC', type:'select', options:groupOptsByType('AC'), syncField:'AC', width:'145px'},
];

const LESSON_COLDEFS = [
  {key:'id', label:'LESSON_ID', type:'text'},
  {key:'name', label:'NAME', type:'text', width:'160px'},
  {key:'groupId', label:'GROUP', type:'select', options:groupOpts, syncField:'group'},
  {key:'teacherId', label:'TEACHER', type:'select', options:teacherOpts, syncField:'teacher'},
  {key:'duration', label:'DURATION_MIN', type:'text'},
  {key:'roomId', label:'ROOM', type:'select', options:roomOpts, syncField:'room', width:'120px'},
  {key:'fixedDay', label:'FIXED DAY', type:'daySelect'},
  {key:'fixedStart', label:'FIXED START', type:'text', width:'90px'},
  {key:'fixedEnd', label:'FIXED END', type:'text', width:'90px'},
  {key:'scheduledDay', label:'SCHEDULED DAY', type:'readonly', width:'90px'},
  {key:'scheduledStart', label:'SCHEDULED START', type:'readonly', width:'90px'},
  {key:'scheduledEnd', label:'SCHEDULED END', type:'readonly', width:'90px'},
  {key:'scheduledData', label:'SCHEDULED DATA', type:'readonly', plain:true, width:'220px', value: (row) => formatLessonScheduledData(row)},
];

const AVAIL_COLDEFS = [
  {key:'teacherId', label:'TEACHER', type:'select', options:teacherOpts, syncField:'teacher'},
  {key:'day', label:'DAY', type:'daySelect'},
  {key:'start', label:'START', type:'text'},
  {key:'end', label:'END', type:'text'},
  {key:'type', label:'TYPE', type:'typeSelect'},
  {key:'scope', label:'SCOPE', type:'scopeSelect', width:'90px'},
  {key:'option', label:'OPTION', type:'text'},
];

const CAVAIL_COLDEFS = [
  {key:'classId', label:'CLASS', type:'select', options:classOpts, syncField:'class'},
  {key:'day', label:'DAY', type:'daySelect'},
  {key:'lStar', label:'L_STAR', type:'text', width:'70px'},
  {key:'lEnd', label:'L_END', type:'text', width:'70px'},
  {key:'start', label:'START', type:'text'},
  {key:'end', label:'END', type:'text'},
  {key:'avail', label:'AVAIL', type:'text', width:'90px'},
  {key:'note', label:'NOTE', type:'text'},
];


const TEACHER_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text', width:'70px'},
  {key:'name', label:'NAME', type:'text', width:'160px'},
];

const GROUP_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text'},
  {key:'name', label:'NAME', type:'text'},
  {key:'type', label:'TYPE', type:'text', width:'100px'},
];

const CLASS_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text'},
  {key:'name', label:'NAME', type:'text'},
  {key:'muclass', label:'MUCLASS_TYPE', type:'text', width:'110px'},
];

const INSTR_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text'},
  {key:'name', label:'NAME', type:'text'},
  {key:'type', label:'TYPE', type:'text', width:'90px'},
];

const ROOM_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text', width:'80px'},
  {key:'name', label:'ROOM', type:'text'},
];

// ---------- Render calls ----------
function renderStudents(){
  renderTable(document.getElementById('studentsTable'), DB.students, STUDENT_COLDEFS);
  document.getElementById('studentCountTag').textContent = DB.students.length + ' students';
}
function renderLessons(){
  renderTable(document.getElementById('lessonsTable'), DB.lessons, LESSON_COLDEFS);
  updateFixedPinsBanner();
}
function renderAvail(){
  renderTable(document.getElementById('availTable'), DB.teacherAvail, AVAIL_COLDEFS);
}
function renderCAvail(){
  renderTable(document.getElementById('cavailTable'), DB.classAvail, CAVAIL_COLDEFS);
}
function renderRefTables(){
  DB.refRooms = DB.refRooms || [];
  renderTable(document.getElementById('refTeachersTable'), DB.refTeachers, TEACHER_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refClassesTable'), DB.refClasses, CLASS_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refGroupsTable'), DB.refGroups, GROUP_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refInstrumentsTable'), DB.refInstruments, INSTR_REF_COLDEFS, refreshDependents);
  const roomsTable = document.getElementById('refRoomsTable');
  if(roomsTable) renderTable(roomsTable, DB.refRooms, ROOM_REF_COLDEFS, refreshDependents);
  document.getElementById('refTeacherCount').textContent = DB.refTeachers.length + ' teachers';
  document.getElementById('refClassCount').textContent = DB.refClasses.length + ' classes';
  document.getElementById('refGroupCount').textContent = DB.refGroups.length + ' groups';
  document.getElementById('refInstrCount').textContent = DB.refInstruments.length + ' instruments';
  const roomsCount = document.getElementById('refRoomCount');
  if(roomsCount) roomsCount.textContent = DB.refRooms.length + ' rooms';
}
function refreshDependents(){
  renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderBreaksTable();
}

// Break Management — its own tab, editing DB.refTeachers[i].breakMinutes/breakCount
// directly (same underlying array as the Teachers reference table). Uses a dedicated
// renderer without a delete button, since "delete" here would delete the teacher
// entirely, which isn't what this settings-style table is for.
function renderBreaksTable(){
  const el = document.getElementById('breaksTable');
  let html = '<thead><tr><th>BREAK_ID</th><th>NAME</th><th style="min-width:100px">BREAK MIN</th><th style="min-width:110px">BREAK COUNT</th><th></th></tr></thead><tbody>';
  (DB.breaks || []).forEach((b, i) => {
    html += `<tr data-idx="${i}">
      <td>${escapeAttr(b.id)}</td>
      <td>${escapeAttr(b.teacher || teacherName(b.teacherId))}</td>
      <td style="min-width:100px"><input data-field="breakMinutes" data-idx="${i}" value="${escapeAttr(b.breakMinutes ?? 0)}"></td>
      <td style="min-width:110px"><input data-field="breakCount" data-idx="${i}" value="${escapeAttr(b.breakCount ?? 0)}"></td>
      <td><button class="btn danger small" data-remove="${i}" title="Remove this teacher from the Break Management list entirely">✕</button></td>
    </tr>`;
  });
  html += '</tbody>';
  el.innerHTML = html;
  el.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      DB.breaks[idx][e.target.dataset.field] = e.target.value;
      markWorkDirty();
    });
  });
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.remove, 10);
      DB.breaks.splice(idx, 1);
      renderBreaksTable();
      markWorkDirty();
    });
  });

  // "+ Add teacher" row — only teachers not already in the list are offered, since a
  // teacher not present here should never get any gap at all.
  const addSel = document.getElementById('breaksAddSelect');
  if(addSel){
    const listedIds = new Set((DB.breaks || []).map(b => b.teacherId));
    const available = DB.refTeachers.filter(t => !listedIds.has(t.id));
    addSel.innerHTML = '<option value="">Add a teacher…</option>' +
      available.map(t => `<option value="${escapeAttr(t.id)}">${escapeAttr(t.name)}</option>`).join('');
  }
}
document.getElementById('breaksAddBtn').addEventListener('click', () => {
  const sel = document.getElementById('breaksAddSelect');
  const teacherId = sel.value;
  if(!teacherId) return;
  const t = DB.refTeachers.find(x => x.id === teacherId);
  if(!t) return;
  DB.breaks = DB.breaks || [];
  const nextN = DB.breaks.length
    ? Math.max(...DB.breaks.map(b => parseInt((b.id||'BRID0').replace('BRID',''),10) || 0)) + 1
    : 1;
  DB.breaks.push({id:'BRID'+nextN, teacherId: t.id, teacher: t.name, breakMinutes: 0, breakCount: 0});
  renderBreaksTable();
});

// ---------- Add-row buttons ----------
document.getElementById('addStudentBtn').addEventListener('click', () => {
  const n = DB.students.length + 1;
  const row = {}; STUDENT_COLDEFS.forEach(c => row[c.key] = '');
  row.ID = 'ST' + n;
  DB.students.push(row);
  renderStudents();
});
const STUDENT_EXPORT_COLS = ["ID","NAME1","NAME2","NAME3","PUBLIC_NAME","INSTR","INSTR_ID","CLASS","CLASS_ID",
  "IMPR","IMPR_ID","VOC","VOC_ID","JTH","JTH_ID","SOLF","SOLF_ID","JHIST","JHIST_ID","RHIMPR","RHIMPR_ID","AC","AC_ID"];

// Proper CSV field escaping: wrap in quotes (and double any internal quotes) whenever
// the value contains a comma, a quote, or a line break — otherwise commas inside a
// lesson/student name would silently split into the wrong column.
function csvField(value){
  const s = value === null || value === undefined ? '' : String(value);
  if(/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsvRow(values){
  return values.map(csvField).join(',');
}

document.getElementById('exportStudentsBtn').addEventListener('click', () => {
  const csv = [toCsvRow(STUDENT_EXPORT_COLS)].concat(
    DB.students.map(r => toCsvRow(STUDENT_EXPORT_COLS.map(c => r[c] || '')))
  ).join('\r\n');
  downloadFile('students.csv', csv);
});
document.getElementById('addLessonBtn').addEventListener('click', () => {
  const n = DB.lessons.length + 1;
  DB.lessons.push({id:'LES'+n,name:'',group:'',groupId:'',teacher:'',teacherId:'',duration:90,roomId:'',room:'',fixedDay:'',fixedStart:'',fixedEnd:'',scheduledDay:'',scheduledStart:'',scheduledEnd:''});
  renderLessons();
});
document.getElementById('addAvailBtn').addEventListener('click', () => {
  DB.teacherAvail.push({teacher:'',teacherId:'',day:'MON',start:'',end:'',type:'AVAILABLE',scope:'ALL',option:''});
  renderAvail();
});
document.getElementById('addCAvailBtn').addEventListener('click', () => {
  DB.classAvail.push({class:'',classId:'',day:'MON',lStar:'',lEnd:'',start:'',end:'',avail:'RESERVED',note:''});
  renderCAvail();
});
document.getElementById('addRefTeacher').addEventListener('click', () => {
  DB.refTeachers.push({id:'TEAC'+(DB.refTeachers.length+1), name:''}); renderRefTables(); renderBreaksTable();
});
document.getElementById('addRefClass').addEventListener('click', () => {
  DB.refClasses.push({id:'CL'+(DB.refClasses.length+1), name:'', muclass:''}); renderRefTables();
});
document.getElementById('addRefGroup').addEventListener('click', () => {
  DB.refGroups.push({id:'GR'+(DB.refGroups.length+1), name:'', type:''}); renderRefTables();
});
document.getElementById('addRefInstr').addEventListener('click', () => {
  DB.refInstruments.push({id:'INST'+(DB.refInstruments.length+1), name:'', type:''}); renderRefTables();
});
document.getElementById('addRefRoom').addEventListener('click', () => {
  DB.refRooms = DB.refRooms || [];
  DB.refRooms.push({id: nextId('ROOM', DB.refRooms, 'id'), name:''});
  renderRefTables();
});

// ---------- Tabs ----------
function currentTab(){
  const btn = document.querySelector('.tab-btn.active');
  return (btn && btn.dataset.tab) || 'students';
}
let SEARCH_UI_LOCK = false;
function isSearchUiLocked(){
  return !!SEARCH_UI_LOCK;
}
function layoutNeedsAccept(kind){
  if(kind === 'timetable'){
    return !!(LAST_RESULT && (LAST_RESULT.scheduled || []).length && !LAST_RESULT.accepted);
  }
  if(kind === 'oneone'){
    return !!(LAST_ONEONE && (LAST_ONEONE.scheduled || []).length && !LAST_ONEONE.accepted);
  }
  if(kind === 'rpiano'){
    return !!(LAST_RPIANO && (LAST_RPIANO.scheduled || []).length && !LAST_RPIANO.accepted);
  }
  return false;
}
function pendingAcceptTab(){
  if(layoutNeedsAccept('timetable')) return 'timetable';
  if(layoutNeedsAccept('oneone')) return 'oneone';
  if(layoutNeedsAccept('rpiano')) return 'rpiano';
  return null;
}
function hasPendingAccept(){
  return !!pendingAcceptTab();
}
function canSwitchTab(to){
  if(!to) return false;
  if(SEARCH_UI_LOCK && to !== currentTab()) return false;
  if(to === currentTab()) return true;
  const dirty = pendingAcceptTab();
  if(dirty && to !== dirty) return false;
  if(to === 'oneone' && !canOpenOneOne()) return false;
  if(to === 'rpiano' && !canOpenRpiano()) return false;
  if(to === 'reports' && !canOpenReports()) return false;
  return true;
}
function tabLockReason(to){
  if(SEARCH_UI_LOCK && to !== currentTab()){
    return 'Search is running — wait until it finishes.';
  }
  const dirty = pendingAcceptTab();
  if(dirty && to !== dirty && to !== currentTab()){
    return 'Accept this layout first. After Generate or a drag you cannot open another tab until it is frozen.';
  }
  if(to === 'oneone' && !canOpenOneOne()){
    return 'Accept this schedule first. 1/1 only opens while the current group grid is accepted.';
  }
  if(to === 'rpiano' && !canOpenRpiano()){
    return canOpenOneOne()
      ? 'Accept 1/1 first. Required Piano only opens while 1/1 is accepted.'
      : 'Accept this schedule first. Required Piano only opens while the current group grid and 1/1 are accepted.';
  }
  if(to === 'reports' && !canOpenReports()){
    return 'Accept a layout first. Reports only opens while group lessons, 1/1, or Required Piano is accepted.';
  }
  return '';
}
function showTab(tab){
  const btn = document.querySelector('.tab-btn[data-tab="'+tab+'"]');
  if(!btn) return false;
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p=>p.style.display='none');
  const panel = document.getElementById('tab-'+tab);
  if(panel) panel.style.display='block';
  if(tab === 'timetable' && LAST_RESULT) renderGrid();
  if(tab === 'oneone') renderOneOneTab();
  if(tab === 'rpiano') renderRpianoTab();
  if(tab === 'reports') renderReportsTab();
  updateAllTabLocks();
  return true;
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const to = btn.dataset.tab;
    if(!canSwitchTab(to)){
      alert(tabLockReason(to) || 'Accept this layout first.');
      return;
    }
    showTab(to);
  });
});

// ---------- Scheduler ----------
function studentsInGroup(groupId){
  const fields = ["IMPR_ID","VOC_ID","JTH_ID","SOLF_ID","JHIST_ID","RHIMPR_ID","AC_ID"];
  return DB.students.filter(s => fields.some(f => s[f] === groupId));
}

// Resolves the participants of a lesson-like entry: explicit member IDs (used by small group
// rehearsals) take priority; otherwise falls back to the usual subject-group lookup.
function lessonStudents(l){
  if(l.memberIds && l.memberIds.length){
    return l.memberIds.map(id => DB.students.find(s => s.ID === id)).filter(Boolean);
  }
  return studentsInGroup(l.groupId);
}

// Turns the current small group roster (from the Small Groups tab) into lesson-shaped entries. Small Groups
// are teacher-less by default now — the scheduler places them by member availability
// first and matches a teacher afterward based on SMALL GROUP QUOTA (see runScheduler). If the
// user manually picked a teacher on the Small Groups tab for a specific small group, that's honoured
// as a fixed override and the small group is scheduled the normal teacher-first way instead.
// Recomputed fresh every time the timetable is generated, so edits on the Small Groups tab are
// always picked up. Small Groups with no members are skipped.
function isSmallGroupId(id){
  return /^SG\d+$/i.test(String(id || ''));
}
function smallGroupIdSeq(id){
  const m = /^SG(\d+)$/i.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : 0;
}
function smallGroupShortLabel(sg){
  const n = smallGroupIdSeq(sg && sg.id);
  return n ? ('Small Group ' + n) : 'Small Group';
}
function smallGroupDisplayName(sg){
  return smallGroupShortLabel(sg) + ' rehearsal';
}
function emptySmallGroupRecord(id){
  return {
    id: id || '',
    bass:[], drum:[], acc:[], sol:[],
    teacherId:'', roomId:'', room:'', duration:90,
    fixedDay:'', fixedStart:'', fixedEnd:'',
    scheduledDay:'', scheduledStart:'', scheduledEnd:'',
    scheduledTeacherId:'', scheduledTeacher:''
  };
}
function normalizeSmallGroupsState(state){
  if(!state) return state;
  if(!state.smallGroups && state.smallgroups) state.smallGroups = state.smallgroups;
  return ensureSmallGroupIdentities(state);
}
function ensureSmallGroupIdentities(state){
  if(!state) return state;
  if(!state.smallGroups && state.smallgroups) state.smallGroups = state.smallgroups;
  state.smallGroups = state.smallGroups || [];
  let maxN = 0;
  state.smallGroups.forEach((b, i) => {
    if(!b.id) b.id = 'SG' + (i + 1);
    migrateRoomLock(b, {defaultOn:false});
    maxN = Math.max(maxN, smallGroupIdSeq(b.id));
  });
  const stored = parseInt(state.nextSmallGroupSeq, 10) || 0;
  state.nextSmallGroupSeq = Math.max(maxN + 1, stored, 1);
  return state;
}
function mintSmallGroupId(state){
  ensureSmallGroupIdentities(state);
  const id = 'SG' + state.nextSmallGroupSeq;
  state.nextSmallGroupSeq += 1;
  return id;
}
function findSmallGroupById(lessonId){
  if(!LAST_SMALL_GROUPS || !LAST_SMALL_GROUPS.smallGroups) return null;
  return LAST_SMALL_GROUPS.smallGroups.find(b => b.id === lessonId) || null;
}
function getSmallGroupLessons(){
  if(!LAST_SMALL_GROUPS || !LAST_SMALL_GROUPS.smallGroups) return [];
  ensureSmallGroupIdentities(LAST_SMALL_GROUPS);
  const out = [];
  LAST_SMALL_GROUPS.smallGroups.forEach(sg => {
    const memberIds = SMALL_GROUP_TYPES.flatMap(t => sg[t].map(s => s.ID));
    if(memberIds.length === 0) return;
    out.push({
      id: sg.id,
      name: smallGroupDisplayName(sg),
      group: 'SMALLGROUP', groupId: '',
      teacherId: sg.teacherId || '', teacher: sg.teacherId ? teacherName(sg.teacherId) : '',
      duration: parseInt(sg.duration,10) || 90,
      roomId: itemRoomId(sg),
      room: itemRoomLabel(sg),
      fixedDay: sg.fixedDay || '', fixedStart: sg.fixedStart || '', fixedEnd: sg.fixedEnd || '',
      memberIds,
    });
  });
  return out;
}

function teacherAvoidBusy(teacherId, day, kind){
  return (DB.teacherAvail || [])
    .filter(r => r.teacherId === teacherId && r.type === 'AVOID' && r.day === day && availScopeMatches(r, kind))
    .map(r => ({
      start: toMin(r.start) ?? DEFAULT_START,
      end: toMin(r.end) ?? DEFAULT_END
    }))
    .filter(iv => iv.end > iv.start);
}
function teacherWindowIntervals(win){
  if(!win) return [];
  if(Array.isArray(win.intervals) && win.intervals.length) return win.intervals;
  if(win.start != null && win.end != null && win.end > win.start) return [[win.start, win.end]];
  return [];
}
function slotFitsTeacherWindow(win, start, end){
  return teacherWindowIntervals(win).some(([s,e]) => start >= s && end <= e);
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
function teacherDayWindows(teacherId, kind){
  const rows = (DB.teacherAvail || []).filter(r => r.teacherId === teacherId && r.type !== 'AVOID' && r.day && DAYS.includes(r.day) && availScopeMatches(r, kind));
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
    const ivs = subtractBusyFromIntervals([[w.start, w.end]], teacherAvoidBusy(teacherId, day, kind));
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

// CLASS RESERVATIONS sheet: each row is a time the class is BUSY (regular schoolwork),
// not a time it's free. Group packing uses the largest leftover that still intersects
// the teacher's window that day — so a morning hole is not dropped just because the
// class's biggest leftover is afternoon. Small groups and 1/1 walk every leftover.
// classWindow() still returns the single biggest hole for display/tests.
function classWindow(classId, day){
  if(!classId) return null;
  const reserved = DB.classAvail
    .filter(r => r.classId === classId && r.day === day && (r.start || r.end))
    .map(r => [toMin(r.start) ?? DEFAULT_START, toMin(r.end) ?? DEFAULT_END])
    .sort((a,b) => a[0]-b[0]);

  const merged = [];
  reserved.forEach(iv => {
    const last = merged[merged.length-1];
    if(last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  });

  let cursor = DEFAULT_START;
  const gaps = [];
  merged.forEach(iv => {
    if(iv[0] > cursor) gaps.push([cursor, iv[0]]);
    cursor = Math.max(cursor, iv[1]);
  });
  if(cursor < DEFAULT_END) gaps.push([cursor, DEFAULT_END]);

  if(gaps.length === 0) return null; // reserved the entire day: no free window
  gaps.sort((a,b) => (b[1]-b[0]) - (a[1]-a[0])); // largest free gap wins
  return gaps[0];
}

function classFreeGaps(classId, day){
  if(!classId) return [[DEFAULT_START, DEFAULT_END]];
  const reserved = DB.classAvail
    .filter(r => r.classId === classId && r.day === day && (r.start || r.end))
    .map(r => [toMin(r.start) ?? DEFAULT_START, toMin(r.end) ?? DEFAULT_END])
    .sort((a,b) => a[0]-b[0]);
  const merged = [];
  reserved.forEach(iv => {
    const last = merged[merged.length-1];
    if(last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  });
  let cursor = DEFAULT_START;
  const gaps = [];
  merged.forEach(iv => {
    if(iv[0] > cursor) gaps.push([cursor, iv[0]]);
    cursor = Math.max(cursor, iv[1]);
  });
  if(cursor < DEFAULT_END) gaps.push([cursor, DEFAULT_END]);
  return gaps.filter(g => g[1] > g[0]);
}

function studentsFreeIntervals(students, day){
  let ivs = [[DEFAULT_START, DEFAULT_END]];
  for(const s of students || []){
    const gaps = classFreeGaps(s && s.CLASS_ID, day);
    if(!gaps.length) return [];
    ivs = intersectIntervals(ivs, gaps);
    if(!ivs.length) return [];
  }
  return ivs;
}

function leftoversInSegment(students, day, seg, duration){
  return studentsFreeIntervals(students, day)
    .map(([s,e]) => [Math.max(s, seg.start), Math.min(e, seg.end)])
    .filter(([s,e]) => e - s >= duration);
}

// Prefer a leftover that can sit flush (or on a legal break) against a pin that
// splits the teacher-day. The largest leftover is often later (16:00–20:00) and
// would open an illegal gap after a 13:00 pin — that used to leave the 13:00–14:30
// hole unused and the lesson unresolved.
function pickItemWindowInSegment(item, day, seg, breakSettings, alreadyUsed){
  const ivs = leftoversInSegment(item.students, day, seg, item.duration);
  if(!ivs.length) return null;
  const can = gap => breakGapOk(gap, breakSettings, alreadyUsed || 0).ok;
  if(seg.precededByObstacle){
    const attach = ivs.filter(([s]) => can(s - seg.start))
      .sort((a,b) => a[0]-b[0] || (b[1]-b[0])-(a[1]-a[0]));
    if(attach.length) return {winStart:attach[0][0], winEnd:attach[0][1]};
  }
  if(seg.followedByObstacle){
    const attach = ivs.filter(([,e]) => can(seg.end - e))
      .sort((a,b) => b[1]-a[1] || (b[1]-b[0])-(a[1]-a[0]));
    if(attach.length) return {winStart:attach[0][0], winEnd:attach[0][1]};
  }
  ivs.sort((a,b) => (b[1]-b[0]) - (a[1]-a[0]) || a[0]-b[0]);
  return {winStart:ivs[0][0], winEnd:ivs[0][1]};
}

function intersectIntervals(a, b){
  const out = [];
  (a || []).forEach(([as,ae]) => {
    (b || []).forEach(([bs,be]) => {
      const s = Math.max(as, bs), e = Math.min(ae, be);
      if(e > s) out.push([s, e]);
    });
  });
  return out;
}
function subtractBusyFromIntervals(intervals, busy){
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

// Gap-optimize mode (checkbox off) ignores Break Management entirely: any teacher
// may gap, like 1/1, and Generate ranks by least total idle time.
// "No gaps without Break Management" (checkbox on) restores the old hard budget:
// listed row = BREAK MIN units up to BREAK COUNT; no row = no gap.
function forbidUnlistedGroupGapsEnabled(){
  return !!DB.forbidUnlistedGroupGaps;
}
function lookaheadEveryLayoutEnabled(){
  return !!DB.lookaheadEveryLayout;
}
function teacherSwapProbeEnabled(){
  return !!DB.teacherSwapProbe;
}
function teacherBreakSettings(teacherId){
  if(!forbidUnlistedGroupGapsEnabled()){
    return { minutes: 0, count: 0, unconstrained: true };
  }
  const b = (DB.breaks || []).find(r => r.teacherId === teacherId);
  if(!b) return { minutes: 0, count: 0, unconstrained: false };
  return {
    minutes: Math.max(0, parseInt(b.breakMinutes, 10) || 0),
    count: Math.max(0, parseInt(b.breakCount, 10) || 0),
    unconstrained: false
  };
}

function intervalsOverlap(aS,aE,bS,bE){ return aS < bE && bS < aE; }

// Does [start,end] overlap any Class Reservations row for this class/day?
// Used for a specific pinned slot. Do not reuse classWindow() here: that only
// returns the single largest free gap, so a valid morning slot would look busy
// just because the afternoon gap is bigger.
function overlappingClassReservation(classId, day, start, end){
  if(!classId) return null;
  return DB.classAvail.find(r => {
    if(r.classId !== classId || r.day !== day || (!r.start && !r.end)) return false;
    const rs = toMin(r.start) ?? DEFAULT_START;
    const re = toMin(r.end) ?? DEFAULT_END;
    return intervalsOverlap(start, end, rs, re);
  }) || null;
}

function teacherWindowClash(teacherId, teacherLabel, day, start, end, kind){
  if(!teacherId) return null;
  const w = teacherDayWindows(teacherId, kind)[day];
  const label = teacherLabel || teacherName(teacherId) || teacherId;
  const forWhat = kind === 'group' ? ' for group lessons' : kind === 'oneone' ? ' for 1/1 / piano' : '';
  if(!w) return `teacher ${label} is not available on ${DAY_LABEL[day]}${forWhat}`;
  if(slotFitsTeacherWindow(w, start, end)) return null;
  const hit = teacherAvoidBusy(teacherId, day, kind).find(iv => intervalsOverlap(start, end, iv.start, iv.end));
  if(hit){
    return `teacher ${label} is not available on ${DAY_LABEL[day]} ${toHHMM(hit.start)}–${toHHMM(hit.end)}${forWhat}`;
  }
  const ranges = teacherWindowIntervals(w).map(([s,e]) => `${toHHMM(s)}–${toHHMM(e)}`).join(', ');
  return `teacher ${label} is only available ${DAY_LABEL[day]} ${ranges}${forWhat}`;
}

function studentReservationClash(students, day, start, end){
  const hits = [];
  for(const s of students){
    const hit = overlappingClassReservation(s.CLASS_ID, day, start, end);
    if(!hit) continue;
    const cls = className(s.CLASS_ID) || s.CLASS || s.CLASS_ID;
    const rs = toMin(hit.start) ?? DEFAULT_START;
    const re = toMin(hit.end) ?? DEFAULT_END;
    hits.push({name: `${s.NAME1} ${s.NAME2} (${cls})`, range: `${toHHMM(rs)}–${toHHMM(re)}`});
  }
  if(!hits.length) return null;
  if(hits.length === 1) return `${hits[0].name} has a class reservation ${hits[0].range}`;
  return `${hits.length} students have a class reservation then: ${hits.map(h => `${h.name} ${h.range}`).join(', ')}`;
}

function studentFixedBookingClash(students, studentBusy, day, start, end, memberWord){
  const hits = [];
  for(const s of students){
    const list = (studentBusy[s.ID] && studentBusy[s.ID][day]) || [];
    const iv = list.find(x => intervalsOverlap(start, end, x.start, x.end));
    if(!iv) continue;
    hits.push(`${s.NAME1} ${s.NAME2} ${toHHMM(iv.start)}–${toHHMM(iv.end)}`);
  }
  if(!hits.length) return null;
  const who = memberWord || 'students';
  if(hits.length === 1) return `${hits[0]} already has a fixed booking then`;
  return `${hits.length} ${who} already have a fixed booking then: ${hits.join(', ')}`;
}

// ---------- Small helpers for per-teacher block packing ----------
function permutations(arr){
  if(arr.length <= 1) return [arr];
  const result = [];
  for(let i=0;i<arr.length;i++){
    const rest = arr.slice(0,i).concat(arr.slice(i+1));
    for(const p of permutations(rest)) result.push([arr[i], ...p]);
  }
  return result;
}

// BREAK MIN is the unit, BREAK COUNT is how many units a listed teacher may spend in
// their whole timetable (Mon–Fri combined). A gap may be 0, or any positive multiple of
// BREAK MIN (45×2 → one 90-minute hole, or two 45-minute holes on the same or
// different days). Any other length is illegal. An explicit 0/0 row still means no
// gaps. Not listed = unconstrained (any gap, like 1/1).
function breakUnitsForGap(gap, minutes){
  if(gap === 0) return 0;
  if(gap > 0 && minutes > 0 && gap % minutes === 0) return gap / minutes;
  return null;
}
function breakUnitsInIntervals(intervals, minutes, availableIvs){
  if(!intervals || intervals.length <= 1) return 0;
  const busy = intervals.slice().sort((a,b)=>a.start-b.start);
  let units = 0;
  for(let i=1;i<busy.length;i++){
    const raw = busy[i].start - busy[i-1].end;
    if(raw < 0) return Infinity;
    const gap = availableIvs
      ? breakGapBetweenIntervals(availableIvs, busy[i-1].end, busy[i].start)
      : raw;
    if(gap === 0) continue;
    const extra = breakUnitsForGap(gap, minutes);
    if(extra === null) return Infinity;
    units += extra;
  }
  return units;
}
function breakUnitsAcrossDays(byDay, minutes, teacherId, kind){
  if(teacherId && teacherBreakSettings(teacherId).unconstrained) return 0;
  const wins = teacherId ? teacherDayWindows(teacherId, kind) : {};
  let units = 0;
  DAYS.forEach(day => {
    const av = teacherId ? teacherWindowIntervals(wins[day]) : null;
    units += breakUnitsInIntervals((byDay && byDay[day]) || [], minutes, av);
  });
  return units;
}
function breakUnitsUsedOutsideSegment(teacherBusy, teacherId, day, seg, minutes, kind){
  const wins = teacherDayWindows(teacherId, kind);
  let units = 0;
  DAYS.forEach(d => {
    const av = teacherWindowIntervals(wins[d]);
    const ivs = ((teacherBusy[teacherId] && teacherBusy[teacherId][d]) || []).slice();
    if(d !== day){
      units += breakUnitsInIntervals(ivs, minutes, av);
    } else {
      units += breakUnitsInIntervals(ivs.filter(iv => iv.end <= seg.start), minutes, av);
      units += breakUnitsInIntervals(ivs.filter(iv => iv.start >= seg.end), minutes, av);
    }
  });
  return units;
}
function breakGapOk(gap, breakSettings, breaksUsed){
  if(gap < 0) return {ok:false, extra:0};
  if(breakSettings && breakSettings.unconstrained) return {ok:true, extra:0};
  const extra = breakUnitsForGap(gap, breakSettings.minutes);
  if(extra === null) return {ok:false, extra:0};
  if(breaksUsed + extra > breakSettings.count) return {ok:false, extra:0};
  return {ok:true, extra};
}

function itemClashesAt(item, day, start, studentBusy, roomBusy){
  for(const s of item.students){
    const busyList = (studentBusy[s.ID] && studentBusy[s.ID][day]) || [];
    if(busyList.some(iv => intervalsOverlap(start, start+item.duration, iv.start, iv.end))) return true;
  }
  if(roomSlotTaken(roomBusy, itemRoomId(item.lesson), day, start, start+item.duration)) return true;
  return false;
}

// First item of a chain: attach flush to a preceding fixed booking when one exists
// (hard no-gap rule).
function pickFirstItemStart(item, day, studentBusy, roomBusy, breakSettings, existingTeacherBusy, breaksUsed){
  breaksUsed = breaksUsed || 0;
  const before = (existingTeacherBusy || []).filter(iv => iv.end <= item.winEnd).sort((a,b)=>b.end-a.end)[0];
  const gapBase = before ? before.end : null;

  const tryStarts = [];
  if(gapBase !== null){
    tryStarts.push(gapBase);
    if(breakSettings.minutes > 0){
      const remaining = breakSettings.count - breaksUsed;
      for(let n=1;n<=remaining;n++) tryStarts.push(gapBase + n * breakSettings.minutes);
    }
  }
  tryStarts.push(item.winStart);

  const seen = new Set();
  for(const t of tryStarts){
    if(seen.has(t)) continue;
    seen.add(t);
    if(t < item.winStart || t + item.duration > item.winEnd) continue;
    if((existingTeacherBusy || []).some(iv => intervalsOverlap(t, t+item.duration, iv.start, iv.end))) continue;
    if(itemClashesAt(item, day, t, studentBusy, roomBusy)) continue;
    if(gapBase !== null){
      const gap = t - gapBase;
      if(gap < 0) continue;
      const allowed = breakGapOk(gap, breakSettings, breaksUsed);
      if(!allowed.ok) continue;
      return {start:t, gapBase, usedBreak:allowed.extra};
    }
    return {start:t, gapBase:null, usedBreak:0};
  }
  return null;
}

function simulateOrder(order, day, studentBusy, roomBusy, breakSettings, existingTeacherBusy, initialBreaksUsed){
  existingTeacherBusy = existingTeacherBusy || [];
  let currentEnd = null;
  let breaksUsed = initialBreaksUsed || 0;
  const placements = [];
  for(const item of order){
    let candidateStart;
    let gapBase;
    if(currentEnd === null){
      const first = pickFirstItemStart(item, day, studentBusy, roomBusy, breakSettings, existingTeacherBusy, breaksUsed);
      if(!first) break;
      candidateStart = first.start;
      gapBase = first.gapBase;
      breaksUsed += first.usedBreak;
    } else {
      candidateStart = currentEnd;
      gapBase = currentEnd;
    }

    // Never let an item land on top of a booking this teacher already has that day —
    // push forward past it. If that push itself creates a gap (didn't land exactly on
    // the obstacle's end), that gap still has to pass the same break-rule check below.
    let guard = 0;
    while(guard++ < 50){
      const overlap = existingTeacherBusy.find(iv => intervalsOverlap(candidateStart, candidateStart+item.duration, iv.start, iv.end));
      if(!overlap) break;
      candidateStart = overlap.end;
      if(gapBase === null) gapBase = overlap.end;
    }
    if(gapBase !== null && candidateStart < item.winStart){
      candidateStart = item.winStart;
    }

    if(currentEnd !== null && gapBase !== null){
      const gap = candidateStart - gapBase;
      if(gap > 0){
        const allowed = breakGapOk(gap, breakSettings, breaksUsed);
        if(!allowed.ok) break;
        breaksUsed += allowed.extra;
      }
    }
    if(candidateStart + item.duration > item.winEnd) break;
    if(itemClashesAt(item, day, candidateStart, studentBusy, roomBusy)) break;
    placements.push({...item, start:candidateStart, end:candidateStart+item.duration});
    currentEnd = candidateStart + item.duration;
  }
  return placements;
}

function placementsIdleMinutes(placements){
  let n = 0;
  const list = (placements || []).slice().sort((a,b) => a.start - b.start);
  for(let i=1;i<list.length;i++){
    const g = list[i].start - list[i-1].end;
    if(g > 0) n += g;
  }
  return n;
}

// Tries every ordering (small sets) — or a few sensible heuristics for large sets —
// to pack as many of this teacher's remaining lessons as possible into this day
// (flush when a Break Management row requires it; otherwise like 1/1, any gap is
// legal and the tightest pack wins) — but never more than maxCount.
function bestPermutationPlacements(items, day, studentBusy, roomBusy, breakSettings, maxCount, existingTeacherBusy, initialBreaksUsed){
  const cap = maxCount == null ? items.length : Math.min(maxCount, items.length);
  let orders;
  if(items.length <= 7){
    orders = permutations(items);
  } else {
    orders = [
      [...items].sort((a,b)=> a.winStart-b.winStart || a.winEnd-b.winEnd),
      [...items].sort((a,b)=> a.winEnd-b.winEnd || a.winStart-b.winStart),
      [...items].sort((a,b)=> b.duration-a.duration),
    ];
  }
  let best = [];
  for(const order of orders){
    const placements = simulateOrder(order, day, studentBusy, roomBusy, breakSettings, existingTeacherBusy, initialBreaksUsed).slice(0, cap);
    const idle = placementsIdleMinutes(placements);
    const bestIdle = placementsIdleMinutes(best);
    if(placements.length > best.length || (placements.length === best.length && idle < bestIdle)){
      best = placements;
    }
    if(best.length === cap && placementsIdleMinutes(best) === 0) break;
  }
  return best;
}

// Schedules every lesson belonging to one teacher. Days are grouped by availability rank
// (PREFERRED/AVAILABLE days together, then FALLBACK days, then CANDIDATE days) — within
// each rank tier the remaining lessons are split as evenly as possible across that tier's
// days (so if a teacher offers three preferred days, their lessons spread across all
// three instead of all piling onto the first one just because it technically had room).
// Only spills into a lower tier once the current tier's days are exhausted or can't fit
// any more. Within each day, lessons are still packed gap-free (or using the teacher's
// break budget) as before.
function shuffleArray(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function lessonHasFixedSlot(l){
  return !!(l && l.fixedDay && l.fixedStart);
}
function collectPhase1TeacherIds(){
  const ids = new Set();
  (DB.lessons || []).forEach(l => {
    if(l && l.teacherId && !lessonHasFixedSlot(l)) ids.add(l.teacherId);
  });
  getSmallGroupLessons().forEach(l => {
    if(l && l.teacherId && !lessonHasFixedSlot(l)) ids.add(l.teacherId);
  });
  return [...ids];
}
function phase1MinutesForTeacher(teacherId){
  let n = 0;
  (DB.lessons || []).forEach(l => {
    if(l && l.teacherId === teacherId && !lessonHasFixedSlot(l)) n += parseInt(l.duration, 10) || 45;
  });
  getSmallGroupLessons().forEach(l => {
    if(l && l.teacherId === teacherId && !lessonHasFixedSlot(l)) n += parseInt(l.duration, 10) || 90;
  });
  return n;
}
function automaticPhase1TeacherOrder(teacherIds, byTeacher){
  return (teacherIds || []).slice().sort((a, b) => {
    const da = Object.keys(teacherDayWindows(a, 'group')).length;
    const db = Object.keys(teacherDayWindows(b, 'group')).length;
    if(da !== db) return da - db;
    const minutes = id => {
      if(byTeacher && byTeacher[id]) return byTeacher[id].reduce((s, i) => s + (i.duration || 0), 0);
      return phase1MinutesForTeacher(id);
    };
    return minutes(b) - minutes(a) || String(teacherName(a)).localeCompare(String(teacherName(b)));
  });
}
function normalizePhase1TeacherOrder(raw){
  if(!Array.isArray(raw)) return null;
  const ids = raw.map(id => String(id || '').trim()).filter(Boolean);
  return ids.length ? ids : null;
}
function hasManualPhase1TeacherOrder(){
  return !!(normalizePhase1TeacherOrder(DB.phase1TeacherOrder));
}
function resolvePhase1TeacherOrder(teacherIds, randomize, byTeacher){
  const ids = (teacherIds || []).slice();
  const saved = hasManualPhase1TeacherOrder()
    ? (DB.phase1TeacherOrder || []).filter(id => ids.includes(id))
    : [];
  const base = saved.length
    ? saved.concat(automaticPhase1TeacherOrder(ids.filter(id => !saved.includes(id)), byTeacher))
    : automaticPhase1TeacherOrder(ids, byTeacher);
  return randomize ? shuffleArray(base) : base;
}
function promoteTopKRandom(sorted, k, randomize){
  if(!randomize || !sorted || sorted.length < 2) return sorted || [];
  const n = Math.min(k, sorted.length);
  return shuffleArray(sorted.slice(0, n)).concat(sorted.slice(n));
}

function tryShiftChainTo(placements, targetEnd, day, studentBusy, roomBusy){
  if(!placements.length) return null;
  const shift = targetEnd - placements[placements.length-1].end;
  if(shift === 0) return placements;
  if(shift < 0) return null;
  const shifted = placements.map(p => ({...p, start:p.start+shift, end:p.end+shift}));
  const stillValid = shifted.every(p =>
    p.start >= p.winStart && p.end <= p.winEnd &&
    !itemClashesAt(p, day, p.start, studentBusy, roomBusy)
  );
  return stillValid ? shifted : null;
}

// When a leftover cannot sit flush against another jazz lesson that day, sit at the
// hole end if the only neighbor is later, or at the hole start if the only neighbor
// is earlier. Class reservations are not neighbors — they already cut the leftover.
// Both sides (or none): either edge is fine, so we keep the packed start.
function dayLessonNeighbors(day, holeStart, holeEnd, teacherId, teacherBusy, studentBusy, students){
  let before = false, after = false;
  const see = iv => {
    if(!iv || !Number.isFinite(iv.start) || !Number.isFinite(iv.end)) return;
    if(iv.end <= holeStart) before = true;
    else if(iv.start >= holeEnd) after = true;
  };
  ((teacherBusy && teacherBusy[teacherId] && teacherBusy[teacherId][day]) || []).forEach(see);
  (students || []).forEach(s => {
    if(!s || !s.ID) return;
    ((studentBusy && studentBusy[s.ID] && studentBusy[s.ID][day]) || []).forEach(see);
  });
  return {before, after};
}
function holePullsTowardEnd(day, holeStart, holeEnd, teacherId, teacherBusy, studentBusy, students){
  const n = dayLessonNeighbors(day, holeStart, holeEnd, teacherId, teacherBusy, studentBusy, students);
  return !!(n.after && !n.before);
}
function tryShiftChainMax(placements, day, studentBusy, roomBusy){
  if(!placements.length) return null;
  let shift = Infinity;
  placements.forEach(p => { shift = Math.min(shift, p.winEnd - p.end); });
  if(!(shift > 0)) return null;
  return tryShiftChainTo(placements, placements[placements.length-1].end + shift, day, studentBusy, roomBusy);
}

function segmentBoundaryOk(placements, seg, breakSettings, alreadyUsed){
  if(!placements.length) return false;
  let used = alreadyUsed || 0;
  for(let i=1;i<placements.length;i++){
    const gap = placements[i].start - placements[i-1].end;
    const allowed = breakGapOk(gap, breakSettings, used);
    if(!allowed.ok) return false;
    used += allowed.extra;
  }
  if(seg.precededByObstacle){
    const allowed = breakGapOk(placements[0].start - seg.start, breakSettings, used);
    if(!allowed.ok) return false;
    used += allowed.extra;
  }
  if(seg.followedByObstacle){
    const allowed = breakGapOk(seg.end - placements[placements.length-1].end, breakSettings, used);
    if(!allowed.ok) return false;
  }
  return true;
}

function scheduleTeacherAcrossDays(teacherId, items, teacherBusy, studentBusy, roomBusy, randomize){
  const dayWin = teacherDayWindows(teacherId, 'group');
  const dayEntries = Object.entries(dayWin).sort((a,b)=> (a[1].rank-b[1].rank) || (DAYS.indexOf(a[0])-DAYS.indexOf(b[0])));
  const breakSettings = teacherBreakSettings(teacherId);
  let remaining = randomize ? shuffleArray(items) : items.slice();
  const placedAll = [];

  // group consecutive same-rank days into tiers
  const tiers = [];
  dayEntries.forEach(entry => {
    const last = tiers[tiers.length-1];
    if(last && last[0][1].rank === entry[1].rank) last.push(entry);
    else tiers.push([entry]);
  });
  // Which specific day within a tier gets processed first only matters when a tier has
  // more than one day of the same rank — shuffling that order (in randomized attempts)
  // is one of the ways a different-but-still-valid regular-lesson layout gets explored,
  // which can incidentally free up a teacher's day that a stuck small group needed.
  const orderedTiers = randomize ? tiers.map(shuffleArray) : tiers;

  for(const tier of orderedTiers){
    let daysLeftInTier = tier.length;
    for(const [day, win] of tier){
      if(remaining.length === 0) break;
      const target = Math.ceil(remaining.length / daysLeftInTier);
      daysLeftInTier--;

      // Split the day into free segments around anything this teacher already has that
      // day (e.g. a FIXED lesson/small group from Phase 0) — packing then fills each segment
      // independently, gap-free within it, instead of building one forward chain that
      // simply gives up the moment it would need to "jump over" an obstacle. This is what
      // lets lessons land snugly both before AND after a fixed booking in the middle of
      // the day. A hole on either side of that booking is a real gap and must pass the
      // same Break Management rule as a gap between two packed lessons.
      const existingBusy = ((teacherBusy[teacherId] && teacherBusy[teacherId][day]) || []).slice().sort((a,b)=>a.start-b.start);
      const segments = [];
      teacherWindowIntervals(win).forEach(([segStart, segEnd]) => {
        let cursor = segStart;
        const busyIn = existingBusy.filter(iv => iv.start < segEnd && iv.end > segStart);
        busyIn.forEach(iv => {
          const cutStart = Math.max(iv.start, segStart);
          const cutEnd = Math.min(iv.end, segEnd);
          if(cutStart > cursor) segments.push({
            start:cursor, end:cutStart,
            precededByObstacle: busyIn.some(e => e.end === cursor),
          followedByObstacle: true
        });
          cursor = Math.max(cursor, cutEnd);
        });
        if(cursor < segEnd) segments.push({
          start:cursor, end:segEnd,
          precededByObstacle: busyIn.some(e => e.end === cursor),
        followedByObstacle: false
        });
      });

      let dayTarget = target;
      for(const seg of segments){
        if(remaining.length === 0 || dayTarget <= 0) break;

        // Largest leftover that actually intersects this teacher segment — not the
        // earliest leftover, and not classWindow() clipped from outside the segment
        // (that dropped a morning hole when the class's biggest leftover was afternoon
        // and the teacher was only free in the morning).
        const alreadyUsed = breakUnitsUsedOutsideSegment(teacherBusy, teacherId, day, seg, breakSettings.minutes, 'group');
        const withWindow = remaining.map(it => {
          const win = pickItemWindowInSegment(it, day, seg, breakSettings, alreadyUsed);
          if(!win) return {...it, feasible:false, winStart:seg.start, winEnd:seg.end};
          return {...it, feasible:true, winStart:win.winStart, winEnd:win.winEnd};
        }).filter(it => it.feasible && it.winStart + it.duration <= it.winEnd);

        if(withWindow.length === 0) continue;

        const existingForSim = seg.precededByObstacle ? [{start: seg.start - 1, end: seg.start}] : [];

        let best = [];
        for(let cap = Math.min(dayTarget, withWindow.length); cap >= 1; cap--){
          const packed = bestPermutationPlacements(withWindow, day, studentBusy, roomBusy, breakSettings, cap, existingForSim, alreadyUsed);
          if(packed.length === 0) break;

          const options = [];
          if(seg.followedByObstacle){
            const shifted = tryShiftChainTo(packed, seg.end, day, studentBusy, roomBusy);
            if(shifted) options.push(shifted);
          }
          const holeStart = Math.min(...packed.map(p => p.winStart));
          const holeEnd = Math.max(...packed.map(p => p.winEnd));
          const packedStudents = packed.flatMap(p => p.students || []);
          if(holePullsTowardEnd(day, holeStart, holeEnd, teacherId, teacherBusy, studentBusy, packedStudents)){
            const pulled = tryShiftChainMax(packed, day, studentBusy, roomBusy);
            if(pulled) options.push(pulled);
          }
          options.push(packed);
          const valid = options.find(p => segmentBoundaryOk(p, seg, breakSettings, alreadyUsed));
          if(valid){ best = valid; break; }
        }

        if(best.length > 0){
          best.forEach(p => {
            placedAll.push({...p, day});
            p.students.forEach(s => {
              studentBusy[s.ID] = studentBusy[s.ID] || {};
              studentBusy[s.ID][day] = studentBusy[s.ID][day] || [];
              studentBusy[s.ID][day].push({start:p.start, end:p.end});
            });
            occupyRoom(roomBusy, itemRoomId(p.lesson), day, p.start, p.end);
          });
          teacherBusy[teacherId] = teacherBusy[teacherId] || {};
          teacherBusy[teacherId][day] = (teacherBusy[teacherId][day] || []).concat(best.map(p => ({start:p.start, end:p.end})));
          const placedIds = new Set(best.map(p => p.lesson.id));
          remaining = remaining.filter(it => !placedIds.has(it.lesson.id));
          dayTarget -= best.length;
        }
      }
    }
  }
  return {placed: placedAll, unresolved: remaining};
}

const SearchLog = {
  lines: [],
  quiet: false,
  reset(){ this.lines = []; this.quiet = false; },
  push(type, text){ this.lines.push({type, text}); },
  section(text){ if(!this.quiet) this.push('section', text); },
  info(text){ if(!this.quiet) this.push('info', text); },
  ok(text){ if(!this.quiet) this.push('ok', text); },
  warn(text){ if(!this.quiet) this.push('warn', text); },
  always(type, text){ this.push(type, text); }
};
let LAST_SEARCH_LOG = [];
let LAST_SEARCH_OVERVIEW = [];
let LAST_TEACHER_SWAP_SUGGESTIONS = [];

function variantLogHeader(result){
  const n = result && result.attemptNo;
  const kind = result && result.attemptKind === 'deterministic' ? 'deterministic'
    : result && result.attemptKind === 'random' ? 'random' : '';
  const idx = LAST_VARIANTS && result ? LAST_VARIANTS.indexOf(result) : -1;
  const mark = result && result.suggested ? '★ ' : '';
  const who = idx >= 0 ? mark + variantDisplayName(idx) : (mark ? '★ this layout' : 'this layout');
  const label = n
    ? `Search log — ${who} · attempt ${n}${kind ? ' ('+kind+')' : ''}`
    : `Search log — ${who}`;
  return [
    {type:'section', text: label},
    {type:'info', text: resultLogLine(result)}
  ];
}

function logLinesForResult(result){
  if(result && Array.isArray(result.searchLog) && result.searchLog.length){
    return variantLogHeader(result).concat(result.searchLog);
  }
  if(LAST_SEARCH_OVERVIEW.length) return LAST_SEARCH_OVERVIEW.slice();
  return LAST_SEARCH_LOG.slice();
}

function showLogForSelected(){
  LAST_SEARCH_LOG = logLinesForResult(LAST_RESULT);
  SearchLog.lines = LAST_SEARCH_LOG.slice();
  const logBtn = document.getElementById('searchLogBtn');
  if(logBtn) logBtn.disabled = LAST_SEARCH_LOG.length === 0;
  const overlay = document.getElementById('searchLogOverlay');
  if(overlayIsOpen(overlay)) renderSearchLogBody();
}

function resultLogLine(result){
  const smallGroups = result.unresolved.filter(u => u.lesson.id && isSmallGroupId(u.lesson.id)).length;
  const extra = smallGroups ? `, ${smallGroups} small group${smallGroups===1?'':'s'} stuck` : '';
  const idle = Number.isFinite(result.idleGapMinutes) ? `, ${result.idleGapMinutes} min idle` : '';
  return `${result.scheduled.length} scheduled, ${result.unresolved.length} unresolved${extra}${idle}`;
}

function logQuotaLedger(scheduled, heading){
  SearchLog.section(heading || 'Small group quota ledger');
  const used = {};
  (scheduled || []).forEach(s => {
    if(s.lessonId && isSmallGroupId(s.lessonId) && s.teacherId){
      (used[s.teacherId] = used[s.teacherId] || []).push(`${s.name} (${DAY_LABEL[s.day]} ${toHHMM(s.start)})`);
    }
  });
  const listed = new Set();
  (DB.smallGroupQuotas || []).forEach(quota => {
    listed.add(quota.teacherId);
    const cap = parseInt(quota.amount, 10) || 0;
    const list = used[quota.teacherId] || [];
    const left = cap - list.length;
    const names = list.length ? list.join(', ') : 'none';
    const line = `${quota.teacher || teacherName(quota.teacherId)}: ${list.length} used / ${cap} quota (${left < 0 ? 'OVER' : left + ' left'}) — ${names}`;
    if(list.length > cap) SearchLog.warn(line);
    else SearchLog.ok(line);
  });
  Object.keys(used).forEach(tid => {
    if(!listed.has(tid)){
      SearchLog.warn(`${teacherName(tid) || tid}: ${used[tid].length} small group(s) but not on the quota list — ${used[tid].join(', ')}`);
    }
  });
  const totalUsed = Object.values(used).reduce((n, a) => n + a.length, 0);
  const totalCap = (DB.smallGroupQuotas || []).reduce((n, quota) => n + (parseInt(quota.amount, 10) || 0), 0);
  SearchLog.info(`Total: ${totalUsed} small groups assigned against ${totalCap} quota slots`);
}

function runScheduler(randomize, opts){
  // Isolate this attempt's walkthrough so each kept variant can show its own log.
  const parentLines = SearchLog.lines;
  const parentQuiet = SearchLog.quiet;
  SearchLog.lines = [];
  SearchLog.quiet = !!(opts && opts.quiet);

  const teacherBusy = {};
  const studentBusy = {};
  const roomBusy = {}; // roomId -> day -> [{start,end}] — any two lessons sharing a room may not overlap

  // SMALL GROUP QUOTA pool — shared by manual "Teacher override" assignments (phase 1) and
  // automatic matching (phase 3), so a manually-picked teacher counts against their
  // quota exactly like an auto-matched one does. Only teachers with an actual entry in
  // DB.smallGroupQuotas are ever eligible — a teacher not listed there simply never appears in
  // quotaRemaining, so `quotaRemaining[t.id] || 0` correctly resolves to 0 for them and
  // they're never auto-matched to a sg.
  const quotaRemaining = {};
  (DB.smallGroupQuotas || []).forEach(quota => { quotaRemaining[quota.teacherId] = Math.max(0, parseInt(quota.amount,10) || 0); });

  const allSmallGroupLessons = getSmallGroupLessons();
  const manualSmallGroupLessons = allSmallGroupLessons.filter(l => l.teacherId);   // user picked a teacher on the Small Groups tab: schedule the normal way
  const autoSmallGroupLessons = allSmallGroupLessons.filter(l => !l.teacherId);    // teacher-less: place by member availability, match a teacher after

  const scheduled = [];
  const unresolved = [];

  if(!SearchLog.quiet){
    SearchLog.section(randomize ? 'This attempt (shuffled)' : 'This attempt (deterministic)');
    SearchLog.info(`${DB.lessons.length} subject lessons · ${manualSmallGroupLessons.length} small groups with a teacher override · ${autoSmallGroupLessons.length} small groups to auto-match`);
    const qParts = (DB.smallGroupQuotas || []).map(quota => `${quota.teacher || teacherName(quota.teacherId)} ${quotaRemaining[quota.teacherId]}/${quota.amount}`);
    SearchLog.info(qParts.length ? `Small group quotas at start: ${qParts.join(', ')}` : 'Small group quotas: none listed — auto-match cannot assign any teacher');
    const br = (DB.breaks || []).filter(b => (parseInt(b.breakMinutes,10)||0) > 0);
    SearchLog.info(forbidUnlistedGroupGapsEnabled()
      ? (br.length
        ? `Week break budget: ${br.map(b => `${b.teacher || teacherName(b.teacherId)} ${b.breakMinutes} min × ${b.breakCount}`).join(', ')} — unlisted teachers cannot gap`
        : 'Week break budget: none listed — no gaps (No gaps without Break Management)')
      : 'Break Management ignored this search — any gap is allowed; Generate prefers the least total idle time');
    SearchLog.info('Hard checks: teacher availability, room overlap, no student/teacher double-book. Pinned slots that overlap a class reservation or open an illegal teacher gap are placed with a warning.');
  }

  // ---------- PHASE 0: fixed-time lessons/small groups — no searching, no negotiating. Placed
  // first (before anything else), so every other flexible item naturally routes around
  // them. A lesson/small group only needs FIXED DAY set to be "fixed"; FIXED START/END give the
  // exact window (falls back to the lesson's own duration ending 90 min after start, or
  // the whole day, if end is left blank). A fixed slot still has to pass the same hard
  // constraints as a searched one for teacher availability, no double-booking a
  // student/teacher, and a locked room. A pin that overlaps a student's class
  // reservation, or that opens an illegal hole next to another of that teacher's
  // bookings, is still placed; audit lists a warning. If any hard check fails it's
  // left unresolved — no alternative time is ever substituted for it.
  function pushFixedPlacement(l, teacherId, teacherLabel, day, start, end, students){
    scheduled.push({
      lessonId: l.id, name: l.name, group: l.group || '', groupId: l.groupId || '',
      teacher: teacherLabel, teacherId: teacherId,
      day, start, end,
      studentCount: students.length, ...roomFieldsOf(l),
      studentNames: students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
    });
    students.forEach(s => {
      studentBusy[s.ID] = studentBusy[s.ID] || {};
      studentBusy[s.ID][day] = studentBusy[s.ID][day] || [];
      studentBusy[s.ID][day].push({start, end});
    });
    occupyRoom(roomBusy, itemRoomId(l), day, start, end);
    if(teacherId){
      teacherBusy[teacherId] = teacherBusy[teacherId] || {};
      teacherBusy[teacherId][day] = (teacherBusy[teacherId][day] || []).concat([{start, end}]);
    }
  }
  function parseFixedWindow(l){
    const day = l.fixedDay;
    if(!day || !DAYS.includes(day)) return null;
    const start = toMin(l.fixedStart);
    if(start == null) return null;
    const dur = lessonDurationMinutes(l);
    const typedEnd = toMin(l.fixedEnd);
    const end = start + dur;
    const adjusted = typedEnd != null && typedEnd !== end;
    return {day, start, end, adjusted, duration: dur};
  }
  function pinnedBreaksClash(teacherId, teacherLabel, day, start, end){
    if(!teacherId) return null;
    const bs = teacherBreakSettings(teacherId);
    const byDay = {};
    DAYS.forEach(d => { byDay[d] = ((teacherBusy[teacherId] && teacherBusy[teacherId][d]) || []).slice(); });
    byDay[day] = (byDay[day] || []).concat([{start, end}]);
    if(breakUnitsAcrossDays(byDay, bs.minutes, teacherId, 'group') <= bs.count) return null;
    const label = teacherLabel || teacherName(teacherId) || teacherId;
    const sameDay = scheduled.filter(s => s.teacherId === teacherId && s.day === day);
    const prev = sameDay.filter(s => s.end <= start).sort((a,b) => b.end - a.end)[0];
    const next = sameDay.filter(s => s.start >= end).sort((a,b) => a.start - b.start)[0];
    const beside = [prev && `${prev.name} ending ${toHHMM(prev.end)}`, next && `${next.name} starting ${toHHMM(next.start)}`].filter(Boolean).join(' and ');
    const nextTo = beside ? ` next to ${beside}` : '';
    if(bs.minutes === 0 || bs.count === 0){
      return `teacher ${label} has no break budget, so this pinned slot leaves an illegal gap${nextTo}`;
    }
    return `teacher ${label}'s break budget is ${bs.minutes} min × ${bs.count} and this pinned slot would overspend it${nextTo}`;
  }

  const fixedRegularLessons = DB.lessons.filter(l => l.fixedDay);
  const fixedManualSmallGroups = manualSmallGroupLessons.filter(l => l.fixedDay);
  const fixedAutoSmallGroups = autoSmallGroupLessons.filter(l => l.fixedDay);
  if(!SearchLog.quiet){
    const nFixed = fixedRegularLessons.length + fixedManualSmallGroups.length + fixedAutoSmallGroups.length;
    SearchLog.section('Phase 0 — pinned slots (no search)');
    SearchLog.info(nFixed ? `${nFixed} item(s) have FIXED DAY — placed first, everyone else routes around them` : 'No pinned slots');
  }

  fixedRegularLessons.concat(fixedManualSmallGroups).forEach(l => {
    const win = parseFixedWindow(l);
    const students = lessonStudents(l);
    if(!win){
      SearchLog.warn(`${l.name}: fixed slot rejected — invalid FIXED DAY / START / END`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:'invalid fixed time — check FIXED DAY / FIXED START / FIXED END.'});
      return;
    }
    const {day, start, end} = win;
    const reservationClash = studentReservationClash(students, day, start, end);
    let clash = teacherWindowClash(l.teacherId, l.teacher, day, start, end, 'group');
    if(!clash && l.id && isSmallGroupId(l.id)){
      if((quotaRemaining[l.teacherId] || 0) <= 0){
        clash = `teacher ${l.teacher || teacherName(l.teacherId) || l.teacherId} has no remaining SMALL GROUP QUOTA — add them in ⚙ Small Group Quotas (Small Groups tab) or raise their amount`;
      }
    }
    if(!clash){
      const tBusy = (teacherBusy[l.teacherId] && teacherBusy[l.teacherId][day]) || [];
      if(tBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) clash = `the teacher already has a fixed booking at ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}`;
    }
    if(!clash){
      clash = studentFixedBookingClash(students, studentBusy, day, start, end, 'students');
    }
    if(!clash && itemRoomId(l)){
      if(roomSlotTaken(roomBusy, itemRoomId(l), day, start, end)) clash = `${roomClashLabel(l)} is already taken by another fixed booking then`;
    }
    const breakClash = clash ? null : pinnedBreaksClash(l.teacherId, l.teacher, day, start, end);
    if(clash){
      SearchLog.warn(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} — ${clash}`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:`fixed to ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}, but ${clash} — no alternative time is tried for a fixed slot.`});
    } else {
      if(win.adjusted) SearchLog.info(`${l.name}: FIXED window snapped to ${win.duration} min — booked ${toHHMM(start)}–${toHHMM(end)}`);
      SearchLog.ok(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}${l.teacherId ? ' · '+ (l.teacher||teacherName(l.teacherId)) : ''}${l.id && isSmallGroupId(l.id) ? ' · uses 1 small group quota' : ''}`);
      if(reservationClash){
        SearchLog.warn(`${l.name}: pinned slot overlaps a class reservation — ${reservationClash} (placed anyway)`);
      }
      if(breakClash){
        SearchLog.warn(`${l.name}: pinned slot ${breakClash} (placed anyway)`);
      }
      pushFixedPlacement(l, l.teacherId, l.teacher, day, start, end, students);
      if(l.id && isSmallGroupId(l.id) && l.teacherId){
        quotaRemaining[l.teacherId]--;
        SearchLog.info(`Quota ${l.teacher || teacherName(l.teacherId)}: consume 1 (pinned) → ${quotaRemaining[l.teacherId]} left`);
      }
    }
  });

  fixedAutoSmallGroups.forEach(l => {
    const win = parseFixedWindow(l);
    const students = lessonStudents(l);
    if(!win){
      SearchLog.warn(`${l.name}: fixed slot rejected — invalid FIXED DAY / START / END`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:'invalid fixed time — check FIXED DAY / FIXED START / FIXED END.'});
      return;
    }
    const {day, start, end} = win;
    const reservationClash = studentReservationClash(students, day, start, end);
    let clash = studentFixedBookingClash(students, studentBusy, day, start, end, 'members');
    if(!clash && itemRoomId(l)){
      if(roomSlotTaken(roomBusy, itemRoomId(l), day, start, end)) clash = `${roomClashLabel(l)} is already taken by another fixed booking then`;
    }
    if(clash){
      SearchLog.warn(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} — ${clash}`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:`fixed to ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}, but ${clash} — no alternative time is tried for a fixed slot.`});
      return;
    }
    function gapForFixedCandidate(teacherId){
      const busy = (teacherBusy[teacherId] && teacherBusy[teacherId][day]) || [];
      let minGap = Infinity;
      busy.forEach(iv => {
        if(iv.end <= start) minGap = Math.min(minGap, start - iv.end);
        else if(iv.start >= end) minGap = Math.min(minGap, iv.start - end);
        else minGap = 0;
      });
      return minGap;
    }
    const eligible = DB.refTeachers
      .filter(t => (quotaRemaining[t.id] || 0) > 0)
      .filter(t => {
        const w = teacherDayWindows(t.id, 'group')[day];
        if(!w || !slotFitsTeacherWindow(w, start, end)) return false;
        const tBusy = (teacherBusy[t.id] && teacherBusy[t.id][day]) || [];
        return !tBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end));
      });
    const flush = eligible.filter(t => !pinnedBreaksClash(t.id, t.name, day, start, end));
    const pool = (flush.length ? flush : eligible).slice();
    const candidate = pool.sort((a,b) => gapForFixedCandidate(a.id) - gapForFixedCandidate(b.id) || (quotaRemaining[b.id]||0) - (quotaRemaining[a.id]||0))[0];
    if(candidate){
      if(win.adjusted) SearchLog.info(`${l.name}: FIXED window snapped to ${win.duration} min — booked ${toHHMM(start)}–${toHHMM(end)}`);
      quotaRemaining[candidate.id]--;
      SearchLog.ok(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} · auto-matched ${candidate.name} (quota left ${quotaRemaining[candidate.id]})`);
      if(reservationClash){
        SearchLog.warn(`${l.name}: pinned slot overlaps a class reservation — ${reservationClash} (placed anyway)`);
      }
      const breakClash = pinnedBreaksClash(candidate.id, candidate.name, day, start, end);
      if(breakClash){
        SearchLog.warn(`${l.name}: pinned slot ${breakClash} (placed anyway)`);
      }
      SearchLog.info(`Quota ${candidate.name}: consume 1 (pinned auto-match) → ${quotaRemaining[candidate.id]} left`);
      pushFixedPlacement(l, candidate.id, candidate.name, day, start, end, students);
    } else {
      SearchLog.warn(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} — members free, but no quota teacher is free then`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:`a fixed slot of ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} was requested and its members are free then, but no teacher with remaining SMALL GROUP QUOTA is available at exactly that time — raise a teacher's quota in ⚙ Small Group Quotas (Small Groups tab), set a "Teacher override" on this small group instead, or adjust the fixed time.`});
    }
  });

  const fixedIds = new Set(fixedRegularLessons.concat(fixedManualSmallGroups, fixedAutoSmallGroups).map(l => l.id));

  // ---------- PHASE 1: regular subject lessons + any manually-assigned small groups, teacher-first ----------
  const byTeacher = {};
  DB.lessons.concat(manualSmallGroupLessons).filter(l => !fixedIds.has(l.id)).forEach(l => {
    const students = lessonStudents(l);
    if(l.id && isSmallGroupId(l.id)){
      if((quotaRemaining[l.teacherId] || 0) <= 0){
        SearchLog.warn(`${l.name}: ${l.teacher || teacherName(l.teacherId)} has no remaining small group quota — not scheduled`);
        unresolved.push({lesson:l, students, dayWin: teacherDayWindows(l.teacherId, 'group'), customReason:`teacher ${l.teacher || teacherName(l.teacherId) || l.teacherId} has no remaining SMALL GROUP QUOTA — add them in ⚙ Small Group Quotas (Small Groups tab) or raise their amount.`});
        return;
      }
      SearchLog.info(`Quota ${l.teacher || teacherName(l.teacherId)}: ${quotaRemaining[l.teacherId]} → ${quotaRemaining[l.teacherId]-1} (reserve for ${l.name})`);
      quotaRemaining[l.teacherId]--; // reserve; refunded below if this small group cannot be placed
    }
    const duration = parseInt(l.duration,10) || 45;
    byTeacher[l.teacherId] = byTeacher[l.teacherId] || [];
    byTeacher[l.teacherId].push({lesson:l, students, duration});
  });

  const teacherIds = Object.keys(byTeacher);
  const packOrder = resolvePhase1TeacherOrder(teacherIds, randomize, byTeacher);

  if(!SearchLog.quiet){
    SearchLog.section('Phase 1 — teacher-first (subjects + override small groups)');
    const names = packOrder.map(id => teacherName(id) || id).join(' → ');
    const tail = forbidUnlistedGroupGapsEnabled()
      ? 'Days used by rank (PREFERRED/AVAILABLE → FALLBACK → CANDIDATE); listed Break Management teachers stay on BREAK MIN × COUNT, unlisted teachers cannot gap.'
      : 'Days used by rank (PREFERRED/AVAILABLE → FALLBACK → CANDIDATE); Break Management is off — any teacher may gap like 1/1.';
    if(randomize){
      SearchLog.info(`Shuffled teacher order this attempt: ${names}. ${tail}`);
    } else if(hasManualPhase1TeacherOrder()){
      SearchLog.info(`Manual teacher order: ${names}. ${tail}`);
    } else {
      SearchLog.info(`Teachers in order of fewest available days, then most minutes: ${names}. ${tail}`);
    }
  }
  packOrder.forEach(teacherId => {
    const {placed, unresolved: leftover} = scheduleTeacherAcrossDays(teacherId, byTeacher[teacherId], teacherBusy, studentBusy, roomBusy, randomize);
    if(!SearchLog.quiet){
      const days = [...new Set(placed.map(p => p.day))].sort((a,b)=>DAYS.indexOf(a)-DAYS.indexOf(b));
      const total = byTeacher[teacherId].length;
      const tname = teacherName(teacherId) || teacherId;
      if(leftover.length){
        SearchLog.warn(`${tname}: placed ${placed.length}/${total} on ${days.join(', ') || '—'} — left out: ${leftover.map(it => it.lesson.name).join(', ')}`);
      } else {
        SearchLog.ok(`${tname}: placed ${placed.length}/${total} on ${days.join(', ') || '—'}`);
      }
    }
    placed.forEach(p => {
      scheduled.push({
        lessonId: p.lesson.id, name: p.lesson.name, group: p.lesson.group, groupId: p.lesson.groupId,
        teacher: p.lesson.teacher, teacherId: p.lesson.teacherId,
        day: p.day, start: p.start, end: p.end,
        studentCount: p.students.length, ...roomFieldsOf(p.lesson),
        studentNames: p.students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
      });
    });
    leftover.forEach(it => {
      if(it.lesson.id && isSmallGroupId(it.lesson.id) && it.lesson.teacherId){
        quotaRemaining[it.lesson.teacherId] = (quotaRemaining[it.lesson.teacherId] || 0) + 1;
        SearchLog.info(`Quota ${it.lesson.teacher || teacherName(it.lesson.teacherId)}: refund +1 — ${it.lesson.name} did not get a slot`);
      }
      unresolved.push({lesson: it.lesson, students: it.students, dayWin: teacherDayWindows(teacherId, 'group')});
    });
  });

  // ---------- PHASE 2+3 (merged + local search): place teacher-less small groups where BOTH
  // their members and a quota-holding teacher are simultaneously free, treating "which
  // small group gets which slot" as a small constraint problem rather than pure first-come,
  // first-served — a naive greedy pass can leave a couple of small groups stranded even when
  // the total SMALL GROUP QUOTA exactly equals the small group count, because an early, flexible small group
  // can grab a slot that only a later, more constrained small group actually needed. This does
  // two things about that: (1) processes the most constrained small groups first, and (2) if a
  // small group still can't be placed, tries bumping one already-placed small group to a different
  // valid slot to free up room for it (a single-step local search / augmenting swap).
  const quotaTeachers = DB.refTeachers.filter(t => (quotaRemaining[t.id] || 0) > 0);

  function smallGroupSlotOptions(students, duration){
    const opts = [];
    for(const day of DAYS){
      const ivs = studentsFreeIntervals(students, day);
      for(const [start, end] of ivs){
        if(start + duration > end) continue;
        for(let t = start; t + duration <= end; t += 5) opts.push({day, start:t, end:t+duration});
      }
    }
    return opts;
  }
  function conflictsWithBase(day, start, end, students, roomId){
    for(const s of students){
      const list = (studentBusy[s.ID] && studentBusy[s.ID][day]) || [];
      if(list.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return true;
    }
    if(roomSlotTaken(roomBusy, roomId, day, start, end)) return true;
    return false;
  }
  // Checks a candidate (day,start,end) against every OTHER already-made auto-small group
  // assignment (excluding index `excludeIdx`) for student/room/teacher clashes.
  // Pass teacherId to also check for a same-teacher double-booking.
  function conflictsWithAssignments(day, start, end, students, roomId, teacherId, assignments, excludeIdx){
    for(let i=0;i<assignments.length;i++){
      if(i === excludeIdx || !assignments[i]) continue;
      const a = assignments[i];
      if(a.day !== day || !intervalsOverlap(start, end, a.start, a.end)) continue;
      if(teacherId && a.teacherId === teacherId) return true;
      if(roomId && a.roomId && roomId === a.roomId) return true;
      if(students.length){
        const otherIds = new Set(a.students.map(s => s.ID));
        if(students.some(s => otherIds.has(s.ID))) return true;
      }
    }
    return false;
  }
  function teacherQuotaUsed(teacherId, assignments, excludeIdx){
    let n = 0;
    assignments.forEach((a,i) => { if(i !== excludeIdx && a && a.teacherId === teacherId) n++; });
    return n;
  }
  function teacherWindowOk(teacherId, day, start, end){
    const win = teacherDayWindows(teacherId, 'group')[day];
    return !!win && slotFitsTeacherWindow(win, start, end);
  }
  // Checks against the teacher's existing commitments from Phase 1 (regular subject
  // lessons and any manually-assigned small groups) — this was missing before and could let an
  // auto-matched small group double-book a teacher who already had a regular lesson right then.
  function teacherBusyConflict(teacherId, day, start, end){
    const list = (teacherBusy[teacherId] && teacherBusy[teacherId][day]) || [];
    return list.some(iv => intervalsOverlap(start, end, iv.start, iv.end));
  }

  function structuralOptionCount(students, duration){
    let count = 0;
    smallGroupSlotOptions(students, duration).forEach(opt => {
      quotaTeachers.forEach(t => { if(teacherWindowOk(t.id, opt.day, opt.start, opt.end)) count++; });
    });
    return count;
  }

  const smallGroupItems = autoSmallGroupLessons
    .filter(l => !fixedIds.has(l.id)) // already handled in Phase 0
    .map(l => ({l, students: lessonStudents(l), duration: parseInt(l.duration,10) || 90}))
    .sort((a,b) => structuralOptionCount(a.students, a.duration) - structuralOptionCount(b.students, b.duration) || (b.students.length - a.students.length));

  const assignments = new Array(smallGroupItems.length).fill(null);

  // Recursive augmenting-path search: tries to place small group `idx` in some free slot with
  // some teacher who still has quota; if every teacher who could otherwise take that slot
  // is already full, it tries "bumping" one of that teacher's current small groups to a different
  // teacher/slot instead (recursively, up to `depth` hops) to free up the room — a proper
  // multi-step reshuffle, not just a single swap. `visited` stops a small group from being bumped
  // more than once within the same top-level attempt, to avoid endless back-and-forth.
  // How close a candidate slot sits to this teacher's nearest existing commitment that
  // day — regular lessons, other small groups, anything already in teacherBusy/assignments.
  // 0 = perfectly adjacent (no gap at all), Infinity = teacher has nothing booked that
  // day (so there's no gap to minimize against). Used to prefer teachers whose day
  // already has something nearby, packing the new small group right up against it.
  function teacherGapAt(teacherId, day, start, end, excludeIdx){
    let minGap = Infinity;
    const busy = (teacherBusy[teacherId] && teacherBusy[teacherId][day]) || [];
    busy.forEach(iv => {
      if(iv.end <= start) minGap = Math.min(minGap, start - iv.end);
      else if(iv.start >= end) minGap = Math.min(minGap, iv.start - end);
      else minGap = 0;
    });
    assignments.forEach((a,i) => {
      if(i === excludeIdx || !a || a.teacherId !== teacherId || a.day !== day) return;
      if(a.end <= start) minGap = Math.min(minGap, start - a.end);
      else if(a.start >= end) minGap = Math.min(minGap, a.start - end);
      else minGap = 0;
    });
    return minGap;
  }
  function compareSmallGroupChoice(a, b){
    const af = Number.isFinite(a.gap), bf = Number.isFinite(b.gap);
    if(af !== bf) return af ? -1 : 1;
    if(af && a.gap !== b.gap) return a.gap - b.gap;
    const day = DAYS.indexOf(a.opt.day) - DAYS.indexOf(b.opt.day);
    if(day) return day;
    // Empty teacher-day: sit at the leftover's end, not its start.
    return af ? a.opt.start - b.opt.start : b.opt.start - a.opt.start;
  }

  function teacherWeekByDay(teacherId, excludeIdx){
    const byDay = {};
    DAYS.forEach(d => { byDay[d] = ((teacherBusy[teacherId] && teacherBusy[teacherId][d]) || []).slice(); });
    assignments.forEach((a,i) => {
      if(i === excludeIdx || !a || a.teacherId !== teacherId) return;
      byDay[a.day] = byDay[a.day] || [];
      byDay[a.day].push({start:a.start, end:a.end});
    });
    return byDay;
  }

  // Insert the candidate and check this teacher's whole week: every remaining gap must
  // be 0 or a multiple of BREAK MIN, and the units across Mon–Fri must fit COUNT.
  function teacherGapsOk(teacherId, day, start, end, excludeIdx){
    const bs = teacherBreakSettings(teacherId);
    const byDay = teacherWeekByDay(teacherId, excludeIdx);
    byDay[day] = (byDay[day] || []).concat([{start, end}]);
    return breakUnitsAcrossDays(byDay, bs.minutes, teacherId, 'group') <= bs.count;
  }

  function teacherWeekGapsValid(teacherId){
    const bs = teacherBreakSettings(teacherId);
    return breakUnitsAcrossDays(teacherWeekByDay(teacherId, -1), bs.minutes, teacherId, 'group') <= bs.count;
  }

  function tryPlaceRecursive(idx, depth, visited){
    if(visited.has(idx)) return false;
    visited.add(idx);
    const {l, students, duration} = smallGroupItems[idx];
    if(students.length === 0){ visited.delete(idx); return false; }

    // Gather every feasible (slot, teacher) combination up front — not just the first
    // slot that happens to work — so the one with the smallest gap to that teacher's
    // existing schedule can be picked, rather than whichever comes first in time order.
    const feasibleOpts = smallGroupSlotOptions(students, duration).filter(opt =>
      !conflictsWithBase(opt.day, opt.start, opt.end, students, itemRoomId(l)) &&
      !conflictsWithAssignments(opt.day, opt.start, opt.end, students, itemRoomId(l), null, assignments, idx)
    );

    const directChoices = [];
    feasibleOpts.forEach(opt => {
      quotaTeachers.forEach(t => {
        if(!teacherWindowOk(t.id, opt.day, opt.start, opt.end)) return;
        if(teacherBusyConflict(t.id, opt.day, opt.start, opt.end)) return;
        if(teacherQuotaUsed(t.id, assignments, idx) >= (quotaRemaining[t.id] || 0)) return;
        if(conflictsWithAssignments(opt.day, opt.start, opt.end, [], false, t.id, assignments, idx)) return;
        if(!teacherGapsOk(t.id, opt.day, opt.start, opt.end, idx)) return; // HARD rule: no gap unless BREAK MIN/COUNT covers it, checked on BOTH sides
        const gap = teacherGapAt(t.id, opt.day, opt.start, opt.end, idx); // soft preference value for sorting only
        directChoices.push({opt, teacherId: t.id, gap});
      });
    });
    if(directChoices.length){
      directChoices.sort((a,b) =>
        compareSmallGroupChoice(a, b) ||
        ((quotaRemaining[b.teacherId]||0) - teacherQuotaUsed(b.teacherId, assignments, idx)) - ((quotaRemaining[a.teacherId]||0) - teacherQuotaUsed(a.teacherId, assignments, idx))
      );
      const ranked = promoteTopKRandom(directChoices, 3, randomize);
      const best = ranked[0];
      assignments[idx] = {day:best.opt.day, start:best.opt.start, end:best.opt.end, teacherId:best.teacherId, students, ...roomFieldsOf(l)};
      return true; // stays in `visited` — it's now committed, not up for further bumping in this search
    }

    if(depth > 0){
      // every eligible teacher for every feasible slot is at capacity — try bumping one
      // of a teacher's other small groups elsewhere to open up a spot, then retry. Still prefers
      // the smallest-gap (slot, teacher) combination first.
      const bumpChoices = [];
      feasibleOpts.forEach(opt => {
        quotaTeachers.forEach(t => {
          if(!teacherWindowOk(t.id, opt.day, opt.start, opt.end)) return;
          if(teacherBusyConflict(t.id, opt.day, opt.start, opt.end)) return; // t has a REGULAR lesson right then — bumping other small groups won't free that up
          if(conflictsWithAssignments(opt.day, opt.start, opt.end, [], false, t.id, assignments, idx)) return; // t is genuinely busy then, bumping won't help
          if(!teacherGapsOk(t.id, opt.day, opt.start, opt.end, idx)) return; // HARD rule here too, both sides
          const gap = teacherGapAt(t.id, opt.day, opt.start, opt.end, idx);
          bumpChoices.push({opt, teacherId: t.id, gap});
        });
      });
      bumpChoices.sort((a,b) => compareSmallGroupChoice(a, b));
      const rankedBumps = promoteTopKRandom(bumpChoices, 3, randomize);

      for(const choice of rankedBumps){
        const {opt, teacherId: t} = choice;
        const usingT = assignments.map((a,i) => (a && a.teacherId === t) ? i : -1).filter(i => i >= 0 && i !== idx);
        for(const cIdx of usingT){
          // Snapshot the WHOLE assignments array, not just cIdx — relocating cIdx can
          // itself trigger nested bumps of other small groups, and if this attempt ultimately
          // doesn't work out we need to undo all of that, not just cIdx's own slot.
          const snapshot = assignments.slice();
          assignments[cIdx] = null;
          if(tryPlaceRecursive(cIdx, depth-1, visited)){
            // Relocating cIdx can change teacher t's day layout, so the gap computed
            // when bumpChoices was built may now be stale — re-check it (both sides)
            // against the post-relocation state before committing, not the snapshot
            // from before.
            if(teacherGapsOk(t, opt.day, opt.start, opt.end, idx) &&
               teacherQuotaUsed(t, assignments, idx) < (quotaRemaining[t] || 0) &&
               !conflictsWithAssignments(opt.day, opt.start, opt.end, students, itemRoomId(l), t, assignments, idx)){
              assignments[idx] = {day:opt.day, start:opt.start, end:opt.end, teacherId:t, students, ...roomFieldsOf(l)};
              return true;
            }
          }
          for(let k=0;k<assignments.length;k++) assignments[k] = snapshot[k]; // full rollback, including nested side effects
        }
      }
    }

    visited.delete(idx); // backtrack: this branch failed, let a different branch reconsider this small group later
    return false;
  }

  const SWAP_DEPTH = smallGroupItems.length;
  if(!SearchLog.quiet){
    SearchLog.section('Phase 2 — auto-match small groups');
    SearchLog.info(smallGroupItems.length
      ? `${smallGroupItems.length} teacher-less small group(s), most constrained first (fewest member+teacher slot options). Slots every 5 min. Deterministic attempt picks the tightest legal gap; shuffled attempts pick among the 3 tightest. Can reshuffle up to ${SWAP_DEPTH} hops (one per small group). If bands stay stuck, 1–2 blocking subject lessons may be evicted and Phase 2 retried.`
      : 'No teacher-less small groups');
  }
  smallGroupItems.forEach((_, idx) => { if(!assignments[idx]) tryPlaceRecursive(idx, SWAP_DEPTH, new Set()); });

  // Final safety pass: a LATER small group's bump chain can relocate a small group that an EARLIER,
  // already-placed small group was relying on for zero-gap adjacency — nothing re-validates
  // that earlier small group automatically when its neighbor moves away. Rather than ever ship a
  // schedule with a stray gap that breaks the hard "no gap unless Break Management allows
  // it" rule, re-check every commitment after all placement is done; anything that no
  // longer complies gets unassigned and re-attempted (which may find it a new, valid home,
  // or correctly leave it unresolved) — repeated until the whole set is self-consistent.
  function assignedSmallGroupCount(){
    return assignments.filter(Boolean).length;
  }
  function repairAutoSmallGroupAssignments(){
    for(let round = 0; round < smallGroupItems.length + 5; round++){
      const teacherIdsRepair = new Set();
      assignments.forEach(a => { if(a) teacherIdsRepair.add(a.teacherId); });
    let anyInvalid = false;
      teacherIdsRepair.forEach(teacherId => {
      if(!teacherWeekGapsValid(teacherId)){
        anyInvalid = true;
          SearchLog.warn(`Break-budget repair: ${teacherName(teacherId) || teacherId} went over the week limit after a reshuffle — unassigned their auto small groups and retried`);
        assignments.forEach((a,i) => { if(a && a.teacherId === teacherId) assignments[i] = null; });
      }
    });
    for(let i=0;i<assignments.length;i++){
      const a = assignments[i];
      if(!a) continue;
      for(let j=i+1;j<assignments.length;j++){
        const b = assignments[j];
        if(!b || a.day !== b.day || !intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
        const sameTeacher = a.teacherId === b.teacherId;
          const roomClash = roomsOverlap(a, b);
        const aIds = new Set(a.students.map(s => s.ID));
        const studentClash = b.students.some(s => aIds.has(s.ID));
        if(!sameTeacher && !roomClash && !studentClash) continue;
        anyInvalid = true;
          SearchLog.warn(`Reshuffle repair: ${smallGroupItems[i].l.name} and ${smallGroupItems[j].l.name} overlap after a bump — unassigned the later one and retried`);
        assignments[j] = null;
      }
    }
    if(!anyInvalid) break;
      smallGroupItems.forEach((_, idx) => { if(!assignments[idx]) tryPlaceRecursive(idx, SWAP_DEPTH, new Set()); });
    }
  }
  function dropBusySlot(map, id, day, start, end){
    const list = map[id] && map[id][day];
    if(!list) return;
    const i = list.findIndex(iv => iv.start === start && iv.end === end);
    if(i >= 0) list.splice(i, 1);
  }
  function overwriteBusy(dst, src){
    Object.keys(dst).forEach(k => { delete dst[k]; });
    Object.assign(dst, JSON.parse(JSON.stringify(src)));
  }
  repairAutoSmallGroupAssignments();

  const stuckAfterPhase2 = smallGroupItems
    .map((item, idx) => ({item, idx}))
    .filter(x => !assignments[x.idx] && x.item.students.length);
  if(stuckAfterPhase2.length){
    const stuckIds = new Set();
    const stuckRooms = new Set();
    stuckAfterPhase2.forEach(({item}) => {
      item.students.forEach(s => stuckIds.add(s.ID));
      const rid = itemRoomId(item.l);
      if(rid) stuckRooms.add(rid);
    });
    const candidates = scheduled.map(s => {
      if(!s || !s.lessonId || isSmallGroupId(s.lessonId) || fixedIds.has(s.lessonId)) return null;
      const lesson = (DB.lessons || []).find(l => l.id === s.lessonId);
      if(!lesson) return null;
      const kids = lessonStudents(lesson);
      let score = kids.filter(k => stuckIds.has(k.ID)).length;
      if(itemRoomId(s) && stuckRooms.has(itemRoomId(s))) score += 2;
      if(!score) return null;
      return {s, lesson, kids, score};
    }).filter(Boolean).sort((a,b) => b.score - a.score || String(a.s.lessonId).localeCompare(String(b.s.lessonId)));
    let pick = candidates.slice(0, Math.min(2, candidates.length));
    if(randomize && candidates.length > 2){
      pick = shuffleArray(candidates.slice(0, Math.min(4, candidates.length))).slice(0, 2);
    }
    if(pick.length){
      const snap = {
        scheduled: scheduled.slice(),
        assignments: assignments.slice(),
        teacherBusy: JSON.parse(JSON.stringify(teacherBusy)),
        studentBusy: JSON.parse(JSON.stringify(studentBusy)),
        roomBusy: JSON.parse(JSON.stringify(roomBusy)),
        placedBefore: assignedSmallGroupCount()
      };
      SearchLog.warn(`Phase 2 leftover — evicting ${pick.map(c => c.s.name).join(', ')} so stuck small groups can retry`);
      pick.forEach(c => {
        const i = scheduled.indexOf(c.s);
        if(i >= 0) scheduled.splice(i, 1);
        dropBusySlot(teacherBusy, c.s.teacherId, c.s.day, c.s.start, c.s.end);
        c.kids.forEach(st => dropBusySlot(studentBusy, st.ID, c.s.day, c.s.start, c.s.end));
        if(itemRoomId(c.s)) dropBusySlot(roomBusy, itemRoomId(c.s), c.s.day, c.s.start, c.s.end);
      });
      stuckAfterPhase2.forEach(({idx}) => { if(!assignments[idx]) tryPlaceRecursive(idx, SWAP_DEPTH, new Set()); });
      repairAutoSmallGroupAssignments();
      if(assignedSmallGroupCount() <= snap.placedBefore){
        scheduled.length = 0;
        snap.scheduled.forEach(row => scheduled.push(row));
        for(let i=0;i<assignments.length;i++) assignments[i] = snap.assignments[i];
        overwriteBusy(teacherBusy, snap.teacherBusy);
        overwriteBusy(studentBusy, snap.studentBusy);
        overwriteBusy(roomBusy, snap.roomBusy);
        SearchLog.info('Evict-and-retry did not place more small groups — kept the original Phase 1 pack');
      } else {
        assignments.forEach(a => {
          if(!a) return;
          occupyRoom(roomBusy, itemRoomId(a), a.day, a.start, a.end);
          (a.students || []).forEach(st => {
            studentBusy[st.ID] = studentBusy[st.ID] || {};
            studentBusy[st.ID][a.day] = studentBusy[st.ID][a.day] || [];
            studentBusy[st.ID][a.day].push({start:a.start, end:a.end});
          });
          if(a.teacherId){
            teacherBusy[a.teacherId] = teacherBusy[a.teacherId] || {};
            teacherBusy[a.teacherId][a.day] = teacherBusy[a.teacherId][a.day] || [];
            teacherBusy[a.teacherId][a.day].push({start:a.start, end:a.end});
          }
        });
        pick.forEach(c => {
          const item = {
            lesson: c.lesson,
            students: c.kids,
            duration: parseInt(c.lesson.duration, 10) || 45
          };
          const {placed, unresolved: leftover} = scheduleTeacherAcrossDays(c.s.teacherId, [item], teacherBusy, studentBusy, roomBusy, randomize);
          placed.forEach(p => {
            scheduled.push({
              lessonId: p.lesson.id, name: p.lesson.name, group: p.lesson.group, groupId: p.lesson.groupId,
              teacher: p.lesson.teacher, teacherId: p.lesson.teacherId,
              day: p.day, start: p.start, end: p.end,
              studentCount: p.students.length, ...roomFieldsOf(p.lesson),
              studentNames: p.students.map(st => `${st.NAME1} ${st.NAME2}${st.NAME3 ? ' '+st.NAME3 : ''}`).sort()
            });
          });
          leftover.forEach(it => {
            unresolved.push({lesson: it.lesson, students: it.students, dayWin: teacherDayWindows(c.s.teacherId, 'group')});
          });
        });
        SearchLog.ok(`Evict-and-retry placed ${assignedSmallGroupCount() - snap.placedBefore} more small group(s)`);
      }
    }
  }

  smallGroupItems.forEach((item, idx) => {
    const a = assignments[idx];
    if(a){
      const teacher = DB.refTeachers.find(t => t.id === a.teacherId);
      const usedHere = teacherQuotaUsed(a.teacherId, assignments, -1);
      const left = (quotaRemaining[a.teacherId] || 0) - usedHere;
      SearchLog.ok(`${item.l.name}: ${teacher ? teacher.name : a.teacherId} · ${DAY_LABEL[a.day]} ${toHHMM(a.start)}–${toHHMM(a.end)}${itemRoomId(a) ? ' · '+itemRoomLabel(a) : ''} · quota ${usedHere} this phase, ${left} left`);
      SearchLog.info(`Quota ${teacher ? teacher.name : a.teacherId}: consume 1 (auto-match ${item.l.name}) → ${left} left of remaining pool`);
      scheduled.push({
        lessonId: item.l.id, name: item.l.name, group: 'SMALLGROUP', groupId: '',
        teacher: teacher ? teacher.name : a.teacherId, teacherId: a.teacherId,
        day: a.day, start: a.start, end: a.end,
        studentCount: item.students.length, ...roomFieldsOf(item.l),
        studentNames: item.students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
      });
    } else if(item.students.length === 0){
      SearchLog.warn(`${item.l.name}: no members`);
      unresolved.push({lesson:item.l, students:item.students, dayWin:{}, customReason:'this small group has no members.'});
    } else {
      const anyOpt = smallGroupSlotOptions(item.students, item.duration).find(opt => !conflictsWithBase(opt.day, opt.start, opt.end, item.students, itemRoomId(item.l)));
      const customReason = anyOpt
        ? `a free time for its ${item.students.length} members exists (e.g. ${DAY_LABEL[anyOpt.day]} ${toHHMM(anyOpt.start)}–${toHHMM(anyOpt.end)}), but no combination of a quota-holding teacher and a reshuffle of the other small groups could cover it — raise a teacher's quota in ⚙ Small Group Quotas (Small Groups tab), or pick a teacher manually via "Teacher override" on this small group.`
        : `no time slot found where all ${item.students.length} members are simultaneously free.`;
      SearchLog.warn(`${item.l.name}: ${anyOpt ? `members free e.g. ${DAY_LABEL[anyOpt.day]} ${toHHMM(anyOpt.start)}–${toHHMM(anyOpt.end)}, but no quota teacher + legal gap` : `no slot where all ${item.students.length} members are free`}`);
      unresolved.push({lesson:item.l, students:item.students, dayWin:{}, customReason});
    }
  });

  scheduled.sort((a,b)=> DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.start-b.start);
  if(!SearchLog.quiet) logQuotaLedger(scheduled, 'Small group quota ledger (this attempt)');
  const attemptLog = SearchLog.lines.slice();
  SearchLog.lines = parentLines;
  SearchLog.quiet = parentQuiet;
  const idleGapMinutes = scheduledIdleGapMinutes(scheduled);
  return {scheduled, unresolved, searchLog: attemptLog, idleGapMinutes};
}

// ---------- Rendering results ----------
// Fingerprints everything that actually affects the schedule so repeated Generate
// clicks can keep accumulating solutions until the source tables change.
function computeScheduleFingerprint(){
  const smallGroupsSummary = (LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups) ? LAST_SMALL_GROUPS.smallGroups.map(b => ({
    id: b.id||'',
    bass: b.bass.map(s=>s.ID), drum: b.drum.map(s=>s.ID), acc: b.acc.map(s=>s.ID), sol: b.sol.map(s=>s.ID),
    teacherId: b.teacherId||'', roomId: itemRoomId(b), duration: b.duration||90,
    fixedDay: b.fixedDay||'', fixedStart: b.fixedStart||'', fixedEnd: b.fixedEnd||''
  })) : null;
  const lessonsSummary = (DB.lessons || []).map(l => ({
    id: l.id, name: l.name, group: l.group, groupId: l.groupId,
    teacher: l.teacher, teacherId: l.teacherId, duration: l.duration,
    roomId: itemRoomId(l),
    fixedDay: l.fixedDay||'', fixedStart: l.fixedStart||'', fixedEnd: l.fixedEnd||''
  }));
  return JSON.stringify({
    students: DB.students, lessons: lessonsSummary, teacherAvail: DB.teacherAvail, classAvail: DB.classAvail,
    refTeachers: DB.refTeachers, refClasses: DB.refClasses, refGroups: DB.refGroups, refInstruments: DB.refInstruments, refRooms: DB.refRooms,
    smallGroupQuotas: DB.smallGroupQuotas, breaks: DB.breaks,
    smallGroups: smallGroupsSummary,
    phase1TeacherOrder: normalizePhase1TeacherOrder(DB.phase1TeacherOrder),
    forbidUnlistedGroupGaps: forbidUnlistedGroupGapsEnabled(),
    lookaheadEveryLayout: lookaheadEveryLayoutEnabled()
  });
}

// Runs the whole pipeline many times: once with the normal deterministic layout, then
// shuffled day/lesson order, since Phase 1 commits to one regular-lesson layout before
// teacher-less small groups get a say. Distinct layouts are ranked and only the best
// handful are kept in the Solution dropdown.
let SCHEDULE_SEARCH_ATTEMPTS = 100;
const SCHEDULE_SEARCH_ATTEMPTS_MAX = 50000;
const DEEP_SEARCH_AFTER = 1000;
const DEEP_SEARCH_YIELD_EVERY = 25;
const DEEP_SEARCH_LIVE_EVERY = 100;
const SCHEDULE_VARIANT_KEEP = 10;
const TEACHER_SWAP_EVAL_MAX = 48;
const TEACHER_SWAP_KEEP = 5;
const TEACHER_SWAP_SEARCH_ATTEMPTS = 8;
const TEACHER_SWAP_PACK_BUDGET = 96;
let SEARCH_CANCELLED = false;
function clampScheduleSearchAttempts(n){
  const v = parseInt(n, 10);
  if(!Number.isFinite(v)) return 100;
  return Math.max(1, Math.min(SCHEDULE_SEARCH_ATTEMPTS_MAX, v));
}
function isDeepScheduleSearch(attempts){
  return clampScheduleSearchAttempts(attempts) > DEEP_SEARCH_AFTER;
}
function resetSearchCancel(){
  SEARCH_CANCELLED = false;
}
function requestCancelSearch(){
  SEARCH_CANCELLED = true;
}
function isSearchCancelled(){
  return !!SEARCH_CANCELLED;
}
function beginScheduleSearch(attempts){
  attempts = clampScheduleSearchAttempts(attempts);
  return {
    attempts,
    deep: isDeepScheduleSearch(attempts),
    keep: SCHEDULE_VARIANT_KEEP,
    seen: new Set(),
    beam: [],
    all: [],
    foundOnAttempt: new Map(),
    discarded: 0,
    distinct: 0,
    first: null,
    lastN: 0,
    cancelled: false
  };
}
function recordScheduleAttempt(state, attempt, n){
  state.lastN = n;
  const sig = resultSignature(attempt);
  if(state.seen.has(sig)){
    state.discarded++;
    return 'dup';
  }
  state.seen.add(sig);
  state.distinct++;
  if(!state.deep){
    state.all.push(attempt);
    state.foundOnAttempt.set(sig, n);
    return 'kept';
  }
  if(state.deep && n > 1){
    attempt.searchLog = [{type:'info', text:`Attempt ${n} (random): ${resultLogLine(attempt)}`}];
  }
  if(state.beam.length < state.keep){
    state.beam.push(attempt);
    state.beam.sort((a, b) => compareGroupResults(a, b));
    state.foundOnAttempt.set(sig, n);
    return 'kept';
  }
  const worst = state.beam[state.beam.length - 1];
  if(compareGroupResults(attempt, worst) < 0){
    const evicted = state.beam.pop();
    if(evicted) state.foundOnAttempt.delete(resultSignature(evicted));
    state.beam.push(attempt);
    state.beam.sort((a, b) => compareGroupResults(a, b));
    state.foundOnAttempt.set(sig, n);
    return 'kept';
  }
  return 'skip';
}
function finishScheduleSearch(state){
  return (state.deep ? state.beam : state.all).slice().sort((a, b) => compareGroupResults(a, b));
}
function finalizeScheduleSearch(state){
  const variants = finishScheduleSearch(state);
  const first = state.first;
  const best = variants[0];
  const bestN = best ? state.foundOnAttempt.get(resultSignature(best)) : 0;
  SearchLog.always('info', `${state.discarded} shuffled ${state.discarded === 1 ? 'try was' : 'tries were'} the same as an earlier layout — discarded`);
  if(state.deep){
    SearchLog.always('info', `Deep search kept ${variants.length} of ${state.distinct} distinct layout(s); signatures only for the rest`);
  }
  if(state.cancelled){
    SearchLog.always('warn', `Stopped after attempt ${state.lastN} of ${state.attempts}`);
  }
  SearchLog.section('Pick');
  SearchLog.info(`Ranking: fewest unresolved small groups, then fewest unresolved items, then least idle gap (like 1/1). ${state.distinct} distinct layout(s) this click; the Solution list keeps the best ${SCHEDULE_VARIANT_KEEP}.`);
  if(best){
    SearchLog.ok(`Best this click is attempt ${bestN}: ${resultLogLine(best)}. Search log opens on the ★ layout.`);
  }
  if(first){
    variants.forEach(v => {
      const extra = collectHowRedsCleared(first, v, v.attemptNo);
      v.searchLog = (v.searchLog || []).concat(extra);
    });
    if(best) logHowRedsCleared(first, best, bestN);
  }
  return variants;
}
function readScheduleSearchAttempts(){
  const el = document.getElementById('scheduleSearchAttempts');
  if(el && String(el.value || '').trim() !== ''){
    SCHEDULE_SEARCH_ATTEMPTS = clampScheduleSearchAttempts(el.value);
    el.value = String(SCHEDULE_SEARCH_ATTEMPTS);
  }
  return clampScheduleSearchAttempts(SCHEDULE_SEARCH_ATTEMPTS);
}
function leftoverOneOneHoleMinutes(scheduled){
  const jobs = collectOneOneAssignments(DB && DB.oneToOne);
  if(!jobs.length) return 0;
  const seen = new Set();
  let total = 0;
  jobs.forEach(j => {
    if(!j || seen.has(j.studentId)) return;
    seen.add(j.studentId);
    const st = (DB.students || []).find(s => s.ID === j.studentId);
    if(!st) return;
    DAYS.forEach(day => {
      const busy = (scheduled || []).filter(item => {
        if(!item || item.day !== day) return false;
        return studentsForScheduledItem(item).some(x => x && x.ID === st.ID);
      }).map(item => ({
        start: typeof item.start === 'number' ? item.start : toMin(item.start),
        end: typeof item.end === 'number' ? item.end : toMin(item.end)
      })).filter(iv => iv.start != null && iv.end != null);
      subtractBusyFromIntervals(classFreeGaps(st.CLASS_ID, day), busy).forEach(([s, e]) => {
        if(e > s) total += (e - s);
      });
    });
  });
  return total;
}
function resultScore(result){
  const idle = result && Number.isFinite(result.idleGapMinutes)
    ? result.idleGapMinutes
    : scheduledIdleGapMinutes(result && result.scheduled);
  const holes = result && Number.isFinite(result.oneOneHoleMinutes) ? result.oneOneHoleMinutes : 0;
  return [((result && result.unresolved) || []).length, -holes, idle];
}
function compareGroupResults(a, b){
  const sa = resultScore(a), sb = resultScore(b);
  for(let i=0;i<sa.length;i++){
    if(sa[i] !== sb[i]) return sa[i] - sb[i];
  }
  return 0;
}
function resultSignature(result){
  return result.scheduled.map(s => `${s.lessonId}|${s.day}|${s.start}|${s.teacherId}`).sort().join(';');
}

function shortUnresolvedReason(u){
  if(u.customReason){
    let r = u.customReason
      .replace(/ — no alternative time is tried for a fixed slot\./, '')
      .replace(/ — raise a teacher's quota[\s\S]*$/, '')
      .replace(/ — add them in[\s\S]*$/, '')
      .replace(/ — pick a teacher manually[\s\S]*$/, '');
    return r;
  }
  if(!u.dayWin || Object.keys(u.dayWin).length === 0) return 'teacher has no availability rows';
  return 'no shared free slot for the teacher and every student';
}

function collectHowRedsCleared(first, current, currentAttemptNo){
  const lines = [];
  const push = (type, text) => lines.push({type, text});
  const sameAsFirst = !first || !current || resultSignature(first) === resultSignature(current);
  const reds = (first && first.unresolved) || [];
  const currentReds = (current && current.unresolved) || [];

  push('section', 'How the red items were handled');

  if(sameAsFirst){
    if(!reds.length){
      push('ok', 'This attempt had nothing unresolved — no red items to recover.');
      return lines;
    }
    push('info', `This attempt left ${reds.length} in red: ${reds.map(u => u.lesson.name).join(', ')}`);
    push('info', 'Later shuffled attempts try a different day/lesson order so a leftover small group or lesson can take a hole this layout did not leave.');
    reds.forEach(u => push('warn', `${u.lesson.name}: still red — ${shortUnresolvedReason(u)}`));
    return lines;
  }

  if(!reds.length){
    push('ok', 'Attempt 1 already had nothing unresolved. This layout is another valid arrangement.');
  } else {
    push('info', `Attempt 1 left ${reds.length} in red: ${reds.map(u => u.lesson.name).join(', ')}`);
    push('info', 'This attempt reshuffled which of a teacher\'s equally-ranked days get packed first, and the order of their lessons, to free a hole a stuck small group or leftover lesson needed.');
    if(currentAttemptNo){
      push('info', `This layout is attempt ${currentAttemptNo} (${resultLogLine(current)}).`);
    }
    let cleared = 0;
    reds.forEach(u => {
      const id = u.lesson.id;
      const placed = current.scheduled.find(s => s.lessonId === id);
      const still = current.unresolved.find(x => x.lesson.id === id);
      const why = shortUnresolvedReason(u);
      if(placed){
        cleared++;
        push('ok', `${u.lesson.name}: was red (${why}) → ${placed.teacher || teacherName(placed.teacherId)} · ${DAY_LABEL[placed.day]} ${toHHMM(placed.start)}–${toHHMM(placed.end)}`);
        const tid = placed.teacherId;
        const moved = current.scheduled.filter(s => {
          if(s.teacherId !== tid || s.lessonId === id) return false;
          const old = first.scheduled.find(x => x.lessonId === s.lessonId);
          return old && (old.day !== s.day || old.start !== s.start);
        });
        if(moved.length){
          push('info', `${placed.teacher || teacherName(tid)}'s other items shifted, which opened that slot: ${moved.map(s => {
            const old = first.scheduled.find(x => x.lessonId === s.lessonId);
            return `${s.name} ${DAY_LABEL[old.day]} ${toHHMM(old.start)} → ${DAY_LABEL[s.day]} ${toHHMM(s.start)}`;
          }).join('; ')}`);
        } else {
          const blocker = first.scheduled.find(s =>
            s.teacherId === tid && s.day === placed.day && intervalsOverlap(s.start, s.end, placed.start, placed.end)
          );
          if(blocker){
            push('info', `In attempt 1 that exact slot was ${blocker.name}; it is no longer there.`);
          } else if(id && isSmallGroupId(id)){
            push('info', `That time was free for ${placed.teacher || teacherName(tid)} in attempt 1 — the block was members, another small group, a locked room, or quota matching. The reshuffled week made the combination legal.`);
          } else {
            push('info', `The reshuffled pack for ${placed.teacher || teacherName(tid)} simply reached this leftover before the day filled up.`);
          }
        }
      } else if(still){
        push('warn', `${u.lesson.name}: still red — ${shortUnresolvedReason(still)}`);
      }
    });
    const stillN = reds.length - cleared;
    if(cleared && !stillN) push('ok', `All ${cleared} attempt-1 red(s) landed in this layout.`);
    else if(cleared) push('info', `${cleared} of ${reds.length} attempt-1 red(s) cleared; ${stillN} still red.`);
    else push('warn', `None of the ${reds.length} attempt-1 red(s) cleared in this layout.`);
  }

  const firstRedIds = new Set(reds.map(u => u.lesson.id));
  currentReds.forEach(u => {
    if(firstRedIds.has(u.lesson.id)) return;
    const was = first.scheduled.find(s => s.lessonId === u.lesson.id);
    if(was){
      push('warn', `${u.lesson.name}: newly red (was ${DAY_LABEL[was.day]} ${toHHMM(was.start)} in attempt 1) — ${shortUnresolvedReason(u)}`);
    } else {
      push('warn', `${u.lesson.name}: red on this layout — ${shortUnresolvedReason(u)}`);
    }
  });
  return lines;
}

function logHowRedsCleared(first, current, currentAttemptNo){
  collectHowRedsCleared(first, current, currentAttemptNo).forEach(line => SearchLog.push(line.type, line.text));
}
function runSchedulerSearchAll(){
  return collectSchedulerSearch(readScheduleSearchAttempts());
}
function collectSchedulerSearch(attempts, onTick){
  const state = beginScheduleSearch(attempts);
  attempts = state.attempts;
  SearchLog.quiet = false;
  const first = runScheduler(false);
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  state.first = first;
  SearchLog.always('ok', `Attempt 1 (deterministic): ${resultLogLine(first)}`);
  recordScheduleAttempt(state, first, 1);
  if(onTick) onTick(1, attempts, `Layout 1 / ${attempts}`);
  SearchLog.always('section', 'Further attempts');
  SearchLog.always('info', state.deep
    ? `${Math.max(0, attempts - 1)} more tries — deep search keeps only the best ${state.keep} layouts and skips per-attempt logs`
    : `${Math.max(0, attempts - 1)} more tries with shuffled teacher order / day order / lesson order — looking for a layout that unblocks a stuck small group`);
  for(let i = 0; i < attempts - 1; i++){
    const n = i + 2;
    const attempt = runScheduler(true, state.deep ? {quiet: true} : null);
    attempt.attemptNo = n;
    attempt.attemptKind = 'random';
    const kind = recordScheduleAttempt(state, attempt, n);
    if(kind === 'kept' && !state.deep){
      SearchLog.always('ok', `Attempt ${n} (random): ${resultLogLine(attempt)} — kept`);
    }
    if(onTick) onTick(n, attempts, `Layout ${n} / ${attempts}`);
  }
  return finalizeScheduleSearch(state);
}
function yieldUi(){
  return new Promise(resolve => setTimeout(resolve, 0));
}
async function collectSchedulerSearchAsync(attempts, onTick){
  const state = beginScheduleSearch(attempts);
  attempts = state.attempts;
  SearchLog.quiet = false;
  setSearchLiveHeadline(searchLiveAttemptHeadline(1, attempts, false));
  searchLiveSay(state.deep
    ? `Deep search: ${attempts} tries, keep the best ${state.keep}. Quiet logs, beam only, yield every ${DEEP_SEARCH_YIELD_EVERY}.`
    : 'Packing pinned slots, then subjects teacher-first, then auto-match small groups…', 'info');
  if(onTick) onTick(0, attempts, `Starting 1 / ${attempts}`);
  await yieldUi();
  if(SEARCH_CANCELLED){
    state.cancelled = true;
    return finalizeScheduleSearch(state);
  }
  const first = runScheduler(false);
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  state.first = first;
  SearchLog.always('ok', `Attempt 1 (deterministic): ${resultLogLine(first)}`);
  recordScheduleAttempt(state, first, 1);
  let bestSoFar = first;
  searchLiveSay(`Attempt 1: ${resultLogLine(first)} — baseline kept.`, 'ok');
  if(onTick) onTick(1, attempts, `Layout 1 / ${attempts}`);
  await yieldUi();
  SearchLog.always('section', 'Further attempts');
  SearchLog.always('info', state.deep
    ? `${Math.max(0, attempts - 1)} more tries — deep search keeps only the best ${state.keep} layouts and skips per-attempt logs`
    : `${Math.max(0, attempts - 1)} more tries with shuffled teacher order / day order / lesson order — looking for a layout that unblocks a stuck small group`);
  if(attempts > 1 && !state.deep){
    searchLiveSay(`${attempts - 1} shuffled ${attempts - 1 === 1 ? 'try' : 'tries'} next — looking for a week that unblocks a stuck small group.`, 'info');
  }
  for(let i = 0; i < attempts - 1; i++){
    if(SEARCH_CANCELLED){
      state.cancelled = true;
      break;
    }
    const n = i + 2;
    if(!state.deep){
      setSearchLiveHeadline(searchLiveAttemptHeadline(n, attempts, true));
      searchLiveSay(`Mixing a new teacher / day / lesson order for attempt ${n}…`, 'info');
      await yieldUi();
    }
    const attempt = runScheduler(true, state.deep ? {quiet: true} : null);
    attempt.attemptNo = n;
    attempt.attemptKind = 'random';
    const kind = recordScheduleAttempt(state, attempt, n);
    if(kind === 'kept' && compareGroupResults(attempt, bestSoFar) < 0){
      bestSoFar = attempt;
      searchLiveSay(`Attempt ${n}: ${resultLogLine(attempt)} — new best.`, 'ok');
    } else if(!state.deep){
      if(kind === 'dup') searchLiveSay(`Attempt ${n}: same week as an earlier try — discarded.`, 'info');
      else if(kind === 'kept'){
        SearchLog.always('ok', `Attempt ${n} (random): ${resultLogLine(attempt)} — kept`);
        searchLiveSay(`Attempt ${n}: ${resultLogLine(attempt)} — distinct, kept.`, 'ok');
      }
    } else if(n % DEEP_SEARCH_LIVE_EVERY === 0){
      setSearchLiveHeadline(`Attempt ${n} / ${attempts} — deep search`);
      searchLiveSay(`Checked ${n}. Best so far: ${resultLogLine(bestSoFar)}. ${state.distinct} distinct, ${state.beam.length} kept.`, 'info');
    }
    if(onTick) onTick(n, attempts, `Layout ${n} / ${attempts}`);
    if(!state.deep || n % DEEP_SEARCH_YIELD_EVERY === 0) await yieldUi();
  }
  setSearchLiveHeadline('Ranking layouts');
  const variants = finalizeScheduleSearch(state);
  const best = variants[0];
  searchLiveSay(state.cancelled
    ? `Stopped at attempt ${state.lastN}. Kept ${variants.length} layout(s); best: ${best ? resultLogLine(best) : '—'}.`
    : `${state.discarded} duplicate ${state.discarded === 1 ? 'try' : 'tries'} thrown away. ${state.distinct} distinct; best this click is ${best ? resultLogLine(best) : '—'}.`,
    state.cancelled ? 'warn' : 'ok');
  return variants;
}

function discardVariantDragEdits(){
  const list = LAST_VARIANTS && LAST_VARIANTS.length ? LAST_VARIANTS : (LAST_RESULT ? [LAST_RESULT] : []);
  list.forEach(v => {
    if(!v) return;
    if(v.dragBaseline) applyLessonSlots(v.scheduled, v.dragBaseline);
    v.dragUndo = [];
    v.dragBaseline = null;
  });
}
function hasAcceptedRecord(){
  return !!(DB.acceptedTimetable
    || (DB.acceptedSchedule && DB.acceptedSchedule.length)
    || (DB.lessons || []).some(l => l.scheduledDay)
    || (LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups && LAST_SMALL_GROUPS.smallGroups.some(b => b.scheduledDay)));
}
function hasUnacceptedDrags(){
  const v = LAST_RESULT;
  if(!v) return false;
  if(v.dragUndo && v.dragUndo.length) return true;
  if(v.dragBaseline && !lessonSlotsMatch(v.scheduled, v.dragBaseline)) return true;
  return false;
}
let PENDING_GENERATE = 'timetable';
const GENERATE_CONFIRM_TITLE = {
  timetable: 'Accepted schedule is on file',
  smallgroups: 'Replace current small groups?'
};
const GENERATE_CONFIRM_BODY = {
  timetable: 'Generate can search again and leave the frozen roster in place, or clear it (and the SCHEDULED columns) so the next search starts unconstrained. Generate still only reads FIXED times and small group Teacher override.',
  smallgroups: 'Generate small groups deletes the current bands and builds a new roster. Any generated timetable grid is also cleared.',
  smallgroupsAccepted: 'New small groups replace the current roster (existing bands are deleted) and clear the generated timetable grid. You can leave the frozen accepted roster in place, or clear it (and the SCHEDULED columns) so the next search starts unconstrained. Generate still only reads FIXED times and small group Teacher override.'
};
const GENERATE_CONFIRM_EXTRA = {
  timetable: 'The current grid also has dragged times that were not accepted — a new search replaces the grid.',
  smallgroups: 'The current generated timetable is cleared either way — new small groups change who is in each rehearsal.'
};
function overlayIsOpen(el){
  return !!(el && (el.classList.contains('is-open') || el.style.display === 'flex'));
}
function setModalOverlay(id, open){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('is-open', !!open);
  el.style.display = open ? 'flex' : 'none';
  el.setAttribute('aria-hidden', open ? 'false' : 'true');
  if(open && document.body) document.body.appendChild(el);
}
function hideGenerateConfirm(){
  setModalOverlay('generateConfirmOverlay', false);
}
function isSearchLiveOpen(){
  return overlayIsOpen(document.getElementById('searchLiveOverlay'));
}
function setSearchLiveHeadline(text){
  const el = document.getElementById('searchLiveHeadline');
  if(el) el.textContent = text || '';
}
let SEARCH_LIVE_STARTED_AT = 0;
function formatSearchLiveEta(ms){
  if(!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.max(0, Math.round(ms / 1000));
  if(sec < 8) return 'a few seconds left';
  if(sec < 55) return `about ${sec}s left`;
  const min = Math.max(1, Math.round(sec / 60));
  return min === 1 ? 'about 1 min left' : `about ${min} min left`;
}
function setSearchLiveEta(text){
  const el = document.getElementById('searchLiveEta');
  if(el) el.textContent = text || '';
}
function setSearchLiveProgress(done, total, label){
  const fill = document.getElementById('searchLiveFill');
  const count = document.getElementById('searchLiveCount');
  const pct = total ? Math.max(0, Math.min(100, Math.round(100 * done / total))) : 0;
  if(fill) fill.style.width = pct + '%';
  if(count) count.textContent = label || (total ? `${done} / ${total}` : '');
  if(!total){
    setSearchLiveEta('');
    return;
  }
  if(done >= total){
    setSearchLiveEta('finishing…');
    return;
  }
  if(!(done > 0) || !SEARCH_LIVE_STARTED_AT){
    setSearchLiveEta('estimating…');
    return;
  }
  const elapsed = Date.now() - SEARCH_LIVE_STARTED_AT;
  if(elapsed < 250){
    setSearchLiveEta('estimating…');
    return;
  }
  setSearchLiveEta(formatSearchLiveEta(elapsed * (total - done) / done));
}
function searchLiveSay(text, type){
  const body = document.getElementById('searchLiveBody');
  if(!body || !text) return;
  const line = document.createElement('div');
  line.className = 'search-live-line' + (type === 'ok' || type === 'warn' || type === 'info' ? ' search-live-'+type : '');
  line.textContent = text;
  body.appendChild(line);
  while(body.childElementCount > 48 && body.firstChild) body.removeChild(body.firstChild);
  if(body.scrollTop != null) body.scrollTop = body.scrollHeight;
}
function openSearchLive(title){
  const t = document.getElementById('searchLiveTitle');
  if(t) t.textContent = title || 'Search';
  const body = document.getElementById('searchLiveBody');
  if(body) body.innerHTML = '';
  SEARCH_LIVE_STARTED_AT = Date.now();
  setSearchLiveHeadline('Starting…');
  setSearchLiveEta('estimating…');
  setSearchLiveProgress(0, 1, '');
  const cancel = document.getElementById('searchLiveCancelBtn');
  if(cancel){
    cancel.disabled = false;
    cancel.textContent = 'Stop search';
  }
  setModalOverlay('searchLiveOverlay', true);
}
function closeSearchLive(){
  const cancel = document.getElementById('searchLiveCancelBtn');
  if(cancel) cancel.disabled = true;
  setModalOverlay('searchLiveOverlay', false);
}
function searchLiveAttemptHeadline(n, total, shuffled){
  if(!shuffled){
    return hasManualPhase1TeacherOrder()
      ? `Attempt ${n} / ${total} — packing in your teacher order`
      : `Attempt ${n} / ${total} — fewest available days first`;
  }
  return `Attempt ${n} / ${total} — shuffled teacher / day / lesson mix`;
}
function isGenerateConfirmOpen(){
  return overlayIsOpen(document.getElementById('generateConfirmOverlay'));
}
function showGenerateConfirm(kind){
  abortCalendarInteraction();
  setModalOverlay('searchLogOverlay', false);
  setModalOverlay('smallGroupQuotasOverlay', false);
  setModalOverlay('phase1TeacherOrderOverlay', false);
  hideSmallGroupStudentsEditor();
  PENDING_GENERATE = kind === 'smallgroups' ? 'smallgroups' : 'timetable';
  const title = document.getElementById('generateConfirmTitle');
  const extra = document.getElementById('generateConfirmExtra');
  const body = document.getElementById('generateConfirmBody');
  const keepBtn = document.getElementById('generateKeepAcceptedBtn');
  const clearBtn = document.getElementById('generateClearAcceptedBtn');
  const goBtn = document.getElementById('generateConfirmGoBtn');
  const accepted = hasAcceptedRecord();
  const smallgroupsPlain = PENDING_GENERATE === 'smallgroups' && !accepted;
  if(title) title.textContent = GENERATE_CONFIRM_TITLE[PENDING_GENERATE];
  if(body){
    body.textContent = PENDING_GENERATE === 'smallgroups' && accepted
      ? GENERATE_CONFIRM_BODY.smallgroupsAccepted
      : GENERATE_CONFIRM_BODY[PENDING_GENERATE];
  }
  if(extra){
    extra.textContent = GENERATE_CONFIRM_EXTRA[PENDING_GENERATE];
    extra.style.display = (PENDING_GENERATE === 'smallgroups' && LAST_RESULT) || hasUnacceptedDrags() ? 'block' : 'none';
  }
  if(keepBtn) keepBtn.style.display = smallgroupsPlain ? 'none' : '';
  if(clearBtn) clearBtn.style.display = smallgroupsPlain ? 'none' : '';
  if(goBtn) goBtn.style.display = smallgroupsPlain ? '' : 'none';
  setModalOverlay('generateConfirmOverlay', true);
}
function queuePendingGenerate(clearAccepted){
  if(PENDING_GENERATE === 'smallgroups') queueGenerateSmallGroups(clearAccepted);
  else queueGenerateTimetable(clearAccepted);
}
function setSearchUiLock(on){
  SEARCH_UI_LOCK = !!on;
  if(document.body && document.body.classList){
    document.body.classList.toggle('is-searching', SEARCH_UI_LOCK);
  }
  const frame = document.querySelector('.page-frame');
  if(frame){
    if(SEARCH_UI_LOCK) frame.setAttribute('inert', '');
    else frame.removeAttribute('inert');
  }
  if(SEARCH_UI_LOCK){
    abortCalendarInteraction();
    setModalOverlay('searchLogOverlay', false);
    setModalOverlay('smallGroupQuotasOverlay', false);
    setModalOverlay('phase1TeacherOrderOverlay', false);
    hideSmallGroupStudentsEditor();
    hideGenerateConfirm();
  }
  updateAllTabLocks();
}
function setGenerateBusy(busy){
  setSearchUiLock(busy);
  const btn = document.getElementById('generateBtn');
  if(btn){
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Generating…' : '▶ Generate group lessons';
  }
  const orderBtn = document.getElementById('phase1TeacherOrderBtn');
  if(orderBtn) orderBtn.disabled = !!busy;
  const attempts = document.getElementById('scheduleSearchAttempts');
  if(attempts) attempts.disabled = !!busy;
  const gapToggle = document.getElementById('forbidUnlistedGroupGaps');
  if(gapToggle) gapToggle.disabled = !!busy;
  const lookaheadToggle = document.getElementById('lookaheadEveryLayout');
  if(lookaheadToggle) lookaheadToggle.disabled = !!busy;
  const swapToggle = document.getElementById('teacherSwapProbe');
  if(swapToggle) swapToggle.disabled = !!busy;
}
function setGenerateProgress(done, total, label){
  setSearchLiveProgress(done, total, label);
}
function setSmallGroupsBusy(busy){
  setSearchUiLock(busy);
  const btn = document.getElementById('generateSmallGroupsBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : '▶ Generate small groups';
}
function clearGeneratedTimetableGrid(){
  LAST_RESULT = null;
  LAST_VARIANTS = [];
  LAST_FINGERPRINT = null;
  LAST_SEARCH_LOG = [];
  LAST_SEARCH_OVERVIEW = [];
  LAST_AUDIT = null;
  SearchLog.lines = [];
  const resultsPanel = document.getElementById('resultsPanel');
  const unresolvedPanel = document.getElementById('unresolvedPanel');
  const statsRow = document.getElementById('statsRow');
  const variantRow = document.getElementById('variantRow');
  if(resultsPanel) resultsPanel.style.display = 'none';
  if(unresolvedPanel) unresolvedPanel.style.display = 'none';
  if(statsRow) statsRow.style.display = 'none';
  if(variantRow) variantRow.style.display = 'none';
  const searchLogBtn = document.getElementById('searchLogBtn');
  if(searchLogBtn) searchLogBtn.disabled = true;
  LAST_TEACHER_SWAP_SUGGESTIONS = [];
  renderTeacherSwapSuggestions();
  updateTimetableAcceptBtn();
}
function queueGenerateTimetable(clearAccepted){
  hideGenerateConfirm();
  const attempts = readScheduleSearchAttempts();
  resetSearchCancel();
  setGenerateBusy(true);
  openSearchLive('Generate group lessons');
  searchLiveSay(isDeepScheduleSearch(attempts)
    ? `Deep search: ${attempts} tries, keep the best ${SCHEDULE_VARIANT_KEEP}. Quiet logs, beam only — Stop search keeps the best so far.`
    : `${attempts} layout attempt(s); keep the best ${SCHEDULE_VARIANT_KEEP}.`, 'info');
  if(hasManualPhase1TeacherOrder()){
    searchLiveSay('First attempt follows your teacher order; shuffled attempts still permute that list.', 'info');
  }
  searchLiveSay(forbidUnlistedGroupGapsEnabled()
    ? 'No gaps without Break Management — listed teachers use MIN × COUNT, everyone else flush only.'
    : 'Optimizing idle — Break Management is ignored; any teacher may gap.', 'info');
  searchLiveSay(lookaheadEveryLayoutEnabled()
    ? '1/1 + piano preview: every distinct layout.'
    : `1/1 + piano preview: only the best ${SCHEDULE_VARIANT_KEEP} layouts.`, 'info');
  searchLiveSay(teacherSwapProbeEnabled()
    ? 'Hypothetical teacher swaps: on — each same-duration pair re-runs the group search (shuffled packs + 1/1 preview) and keeps the better leftover week. The grid stays as packed.'
    : 'Hypothetical teacher swaps: off.', 'info');
  setGenerateProgress(0, attempts, 'Starting…');
  (async () => {
    try {
      await runGenerateTimetableAsync(clearAccepted);
    } finally {
      closeSearchLive();
      setGenerateBusy(false);
      setGenerateProgress(0, 0);
    }
  })();
}
function prepareGenerateTimetable(clearAccepted){
  hideGenerateConfirm();
  const hadDrags = hasUnacceptedDrags();
  discardVariantDragEdits();
  const hadScheduled = hasAcceptedRecord();
  if(clearAccepted && hadScheduled) clearAcceptedScheduledRecord();
  SearchLog.reset();
  const fp = computeScheduleFingerprint();
  SearchLog.section('Generate group lessons');
  SearchLog.info(`${readScheduleSearchAttempts()} layout attempt(s); keep the best ${SCHEDULE_VARIANT_KEEP}`);
  if(clearAccepted && hadScheduled) SearchLog.info('SCHEDULED columns from the last Accept were cleared — this search starts unconstrained');
  else if(hadScheduled) SearchLog.info('Accepted schedule kept — this search does not read SCHEDULED columns');
  if(fp !== LAST_FINGERPRINT){
    SearchLog.info('Inputs changed (or first run) — previous solution pool cleared, search starts clean');
    searchLiveSay('Inputs changed — previous solution pool cleared.', 'info');
    LAST_VARIANTS = [];
    LAST_FINGERPRINT = fp;
  } else if(hadDrags){
    SearchLog.info('Dragged grid was thrown away — this search starts from the lessons table, not from where blocks were moved');
    searchLiveSay('Dragged grid thrown away — packing from the lessons table.', 'info');
    LAST_VARIANTS = [];
  } else {
    SearchLog.info(`Same inputs as last click — new layouts are merged in, then the best ${SCHEDULE_VARIANT_KEEP} are kept`);
    searchLiveSay('Same inputs — new layouts merge into the existing pool.', 'info');
  }
}
function mergeGenerateVariants(freshVariants, opts){
  freshVariants = freshVariants || [];
  freshVariants.sort((a,b) => compareGroupResults(a, b));
  const freshBest = freshVariants[0] || null;
  const merged = new Map();
  freshVariants.forEach(v => merged.set(resultSignature(v), v));
  LAST_VARIANTS.forEach(v => {
    if(!v) return;
    const sig = resultSignature(v);
    if(!merged.has(sig)) merged.set(sig, v);
  });
  LAST_VARIANTS = [...merged.values()].sort((a,b) => compareGroupResults(a, b));
  if(!(opts && opts.all) && LAST_VARIANTS.length > SCHEDULE_VARIANT_KEEP){
    LAST_VARIANTS = LAST_VARIANTS.slice(0, SCHEDULE_VARIANT_KEEP);
  }
  LAST_VARIANTS.forEach(v => {
    if(!v) return;
    v.accepted = false;
    v.dragUndo = [];
    v.dragBaseline = null;
  });
  return {freshBest, freshCount: freshVariants.length};
}
function keepLookaheadBestVariants(){
  LAST_VARIANTS = (LAST_VARIANTS || []).slice()
    .sort((a,b) => compareScoreTuple(groupLookaheadScore(a), groupLookaheadScore(b)))
    .slice(0, SCHEDULE_VARIANT_KEEP);
  markSuggestedByLookahead(LAST_VARIANTS, groupLookaheadScore);
}
function paintGenerateTimetable(freshCount){
  logGroupLookahead(LAST_VARIANTS);
  logTeacherSwapSuggestions();
  const starI = suggestedVariantIndex(LAST_VARIANTS);
  LAST_RESULT = LAST_VARIANTS[starI] || LAST_VARIANTS[0] || null;
  if(LAST_VARIANTS.length > freshCount){
    SearchLog.info(`Pool now has ${LAST_VARIANTS.length} distinct layouts (including ones from earlier clicks)`);
  }
  LAST_SEARCH_OVERVIEW = SearchLog.lines.slice();
  showLogForSelected();
  populateVariantSelector();
  renderResults(LAST_RESULT);
  markWorkDirty();
}
function completeGenerateTimetable(freshVariants, onLookahead){
  const previewAll = lookaheadEveryLayoutEnabled();
  const {freshCount} = mergeGenerateVariants(freshVariants, previewAll ? {all:true} : null);
  attachGroupLookahead(LAST_VARIANTS, onLookahead);
  if(previewAll) keepLookaheadBestVariants();
  collectTeacherSwapSuggestionsForLayouts(LAST_VARIANTS);
  paintGenerateTimetable(freshCount);
}
function runGenerateTimetable(clearAccepted){
  prepareGenerateTimetable(clearAccepted);
  completeGenerateTimetable(runSchedulerSearchAll());
}
async function runGenerateTimetableAsync(clearAccepted){
  prepareGenerateTimetable(clearAccepted);
  const attempts = readScheduleSearchAttempts();
  const previewAll = lookaheadEveryLayoutEnabled();
  const previewBudget = previewAll ? Math.max(SCHEDULE_VARIANT_KEEP, attempts) : SCHEDULE_VARIANT_KEEP;
  const fresh = await collectSchedulerSearchAsync(attempts, (done, total, label) => {
    setGenerateProgress(done, total + previewBudget, label);
  });
  if(!(fresh || []).length){
    searchLiveSay(SEARCH_CANCELLED ? 'Stopped before a layout was kept.' : 'No layout produced.', 'warn');
    return;
  }
  const {freshCount} = mergeGenerateVariants(fresh, previewAll ? {all:true} : null);
  const previewN = LAST_VARIANTS.length || Math.min(SCHEDULE_VARIANT_KEEP, (fresh || []).length);
  setSearchLiveHeadline('Previewing 1/1 and Required Piano');
  searchLiveSay(previewAll
    ? `Checking leftover 1/1 and piano on every distinct layout (${previewN}) — this picks ★.`
    : `Checking leftover 1/1 and piano on the ${previewN} kept layout(s) — this picks ★.`, 'info');
  await yieldUi();
  await attachGroupLookaheadAsync(LAST_VARIANTS, (i, n) => {
    setSearchLiveHeadline(`1/1 preview ${i} / ${n}`);
    searchLiveSay(`Trying leftover 1/1 holes on layout ${i} of ${n}…`, 'info');
    setGenerateProgress(attempts + i, attempts + n, `1/1 preview ${i} / ${n}`);
  });
  if(previewAll) keepLookaheadBestVariants();
  if(teacherSwapProbeEnabled() && !SEARCH_CANCELLED){
    const layouts = LAST_VARIANTS || [];
    const swapCands = collectTeacherSwapCandidates();
    if(swapCands.length){
      setSearchLiveHeadline('Hypothetical teacher swaps');
      searchLiveSay(`${swapCands.length} same-duration swap(s); each re-runs the group search then a 1/1 preview. The timetable will not change.`, 'info');
      await collectTeacherSwapSuggestionsForLayoutsAsync(layouts, (done, total, label) => {
        setSearchLiveHeadline(label || `Teacher swap check ${done} / ${total}`);
        setGenerateProgress(attempts + previewN + done, attempts + previewN + total, label || `Teacher swap ${done} / ${total}`);
      });
    } else {
      clearTeacherSwapsOnLayouts(layouts);
    }
  } else {
    clearTeacherSwapsOnLayouts(LAST_VARIANTS);
  }
  paintGenerateTimetable(freshCount);
  setSearchLiveHeadline('Done');
  searchLiveSay('Search finished. The grid shows the ★ layout.', 'ok');
  setGenerateProgress(attempts + previewN, attempts + previewN, 'Done');
}
function requestGenerateTimetable(){
  if(SEARCH_UI_LOCK) return;
  abortCalendarInteraction();
  if(hasAcceptedRecord()){
    showGenerateConfirm('timetable');
    return;
  }
  if(hasUnacceptedDrags()){
    if(!confirm('This layout has dragged lessons that were not Accepted. Generate will replace the grid. Continue?')) return;
  }
  queueGenerateTimetable(false);
}
document.getElementById('generateBtn').addEventListener('click', requestGenerateTimetable);
document.getElementById('scheduleSearchAttempts').addEventListener('change', () => {
  readScheduleSearchAttempts();
  markWorkDirty();
});
function syncForbidUnlistedGroupGapsCheckbox(){
  const el = document.getElementById('forbidUnlistedGroupGaps');
  if(el) el.checked = forbidUnlistedGroupGapsEnabled();
}
function syncLookaheadEveryLayoutCheckbox(){
  const el = document.getElementById('lookaheadEveryLayout');
  if(el) el.checked = lookaheadEveryLayoutEnabled();
}
function syncTeacherSwapProbeCheckbox(){
  const el = document.getElementById('teacherSwapProbe');
  if(el) el.checked = teacherSwapProbeEnabled();
}
const forbidUnlistedGroupGapsEl = document.getElementById('forbidUnlistedGroupGaps');
if(forbidUnlistedGroupGapsEl){
  forbidUnlistedGroupGapsEl.addEventListener('change', () => {
    DB.forbidUnlistedGroupGaps = !!forbidUnlistedGroupGapsEl.checked;
    markWorkDirty();
  });
}
const lookaheadEveryLayoutEl = document.getElementById('lookaheadEveryLayout');
if(lookaheadEveryLayoutEl){
  lookaheadEveryLayoutEl.addEventListener('change', () => {
    DB.lookaheadEveryLayout = !!lookaheadEveryLayoutEl.checked;
    markWorkDirty();
  });
}
const teacherSwapProbeEl = document.getElementById('teacherSwapProbe');
if(teacherSwapProbeEl){
  teacherSwapProbeEl.addEventListener('change', () => {
    DB.teacherSwapProbe = !!teacherSwapProbeEl.checked;
    markWorkDirty();
  });
}
document.getElementById('generateCancelBtn').addEventListener('click', hideGenerateConfirm);
document.getElementById('generateKeepAcceptedBtn').addEventListener('click', () => queuePendingGenerate(false));
document.getElementById('generateClearAcceptedBtn').addEventListener('click', () => queuePendingGenerate(true));
const generateConfirmGoBtn = document.getElementById('generateConfirmGoBtn');
if(generateConfirmGoBtn) generateConfirmGoBtn.addEventListener('click', () => queuePendingGenerate(false));
document.getElementById('generateConfirmOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'generateConfirmOverlay') hideGenerateConfirm();
});
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  if(CAL_DRAG) return;
  if(isGenerateConfirmOpen()){
    e.preventDefault();
    hideGenerateConfirm();
    return;
  }
  if(isSmallGroupStudentsEditorOpen()){
    e.preventDefault();
    hideSmallGroupStudentsEditor();
  }
});

function populateVariantSelector(){
  const row = document.getElementById('variantRow');
  const sel = document.getElementById('variantSelect');
  const summary = document.getElementById('variantLookaheadSummary');
  if(!row || !sel) return;
  const selected = Math.max(0, LAST_VARIANTS.indexOf(LAST_RESULT));
  const many = LAST_VARIANTS.length > 1;
  row.style.display = many ? 'flex' : 'none';
  if(many){
    sel.innerHTML = LAST_VARIANTS.map((v, i) =>
      `<option value="${i}">${variantOptionText(v, i, 'group')}</option>`
    ).join('');
    sel.value = String(selected);
  }
  renderLookaheadSummary(summary, LAST_VARIANTS, 'group', selected);
  renderTeacherSwapSuggestions();
}
function renderSearchLogBody(){
  const el = document.getElementById('searchLogBody');
  if(!el) return;
  const title = document.getElementById('searchLogTitle');
  const hint = document.getElementById('searchLogHint');
  const idx = LAST_RESULT && LAST_VARIANTS ? LAST_VARIANTS.indexOf(LAST_RESULT) : -1;
  const mark = LAST_RESULT && LAST_RESULT.suggested ? '★ ' : '';
  const who = idx >= 0 ? mark + variantDisplayName(idx) : '';
  if(title){
    if(who && LAST_RESULT && LAST_RESULT.attemptNo){
      title.textContent = `Search log — ${who} · attempt ${LAST_RESULT.attemptNo}`;
    } else if(who){
      title.textContent = `Search log — ${who}`;
    } else {
      title.textContent = 'Search log';
    }
  }
  if(hint){
    if(LAST_RESULT && LAST_RESULT.suggested){
    hint.textContent = LAST_VARIANTS.length > 1
        ? 'Walkthrough of the ★ layout after Generate — packing, attempt-1 reds, quota ledger, and 1/1 / piano preview. Switch the Solution list to see another log.'
        : 'How the ★ layout was built, including unresolved (red) items, the quota ledger, and the 1/1 / piano preview.';
    } else if(LAST_VARIANTS.length > 1 && who){
      hint.textContent = `Walkthrough of ${who} — packing, attempt-1 reds, quota ledger, and 1/1 / piano preview. ★ is selected after Generate; pick it in the Solution list to return.`;
    } else {
      hint.textContent = 'How this layout was built, including unresolved (red) items, the quota ledger, and the 1/1 / piano preview.';
    }
  }
  if(!LAST_SEARCH_LOG.length){
    el.innerHTML = '<p class="dataio-hint" style="margin:0">Generate a timetable first — the walkthrough of that search will appear here.</p>';
    return;
  }
  el.innerHTML = LAST_SEARCH_LOG.map(line => {
    if(line.type === 'section') return `<div class="log-section">${escapeAttr(line.text)}</div>`;
    const cls = line.type === 'ok' ? 'log-ok' : line.type === 'warn' ? 'log-warn' : 'log-info';
    return `<div class="log-line ${cls}">${escapeAttr(line.text)}</div>`;
  }).join('');
}
document.getElementById('searchLogBtn').addEventListener('click', () => {
  if(SEARCH_UI_LOCK) return;
  renderSearchLogBody();
  setModalOverlay('searchLogOverlay', true);
});
document.getElementById('searchLogCloseBtn').addEventListener('click', () => {
  setModalOverlay('searchLogOverlay', false);
});
document.getElementById('searchLogOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'searchLogOverlay') setModalOverlay('searchLogOverlay', false);
});
const searchLiveCancelBtn = document.getElementById('searchLiveCancelBtn');
if(searchLiveCancelBtn){
  searchLiveCancelBtn.addEventListener('click', () => {
    requestCancelSearch();
    searchLiveCancelBtn.disabled = true;
    searchLiveCancelBtn.textContent = 'Stopping…';
    searchLiveSay('Stop requested — finishing the current attempt, then keeping the best so far.', 'warn');
  });
}

function updatePhase1TeacherOrderBtn(){
  const btn = document.getElementById('phase1TeacherOrderBtn');
  if(!btn) return;
  const manual = hasManualPhase1TeacherOrder();
  const n = (normalizePhase1TeacherOrder(DB.phase1TeacherOrder) || []).length;
  btn.textContent = manual ? `Teacher order · ${n}` : 'Teacher order';
  btn.classList.toggle('is-manual-order', manual);
  btn.title = manual
    ? 'The first Generate attempt packs in this order. Shuffled attempts still permute the list.'
    : 'Set a Phase 1 teacher order for the first attempt, or leave automatic (fewest available days).';
}
function setManualPhase1TeacherOrder(ids){
  const current = collectPhase1TeacherIds();
  const present = new Set(current);
  const cleaned = (ids || []).filter(id => present.has(id));
  const extra = automaticPhase1TeacherOrder(current.filter(id => !cleaned.includes(id)));
  DB.phase1TeacherOrder = cleaned.concat(extra);
  if(!DB.phase1TeacherOrder.length) DB.phase1TeacherOrder = null;
  markWorkDirty();
  updatePhase1TeacherOrderBtn();
}
function clearManualPhase1TeacherOrder(){
  DB.phase1TeacherOrder = null;
  markWorkDirty();
  updatePhase1TeacherOrderBtn();
}
function renderPhase1TeacherOrderModal(){
  const list = document.getElementById('phase1TeacherOrderList');
  const hint = document.getElementById('phase1TeacherOrderHint');
  if(!list) return;
  const ids = resolvePhase1TeacherOrder(collectPhase1TeacherIds(), false);
  if(!ids.length){
    list.innerHTML = '<li class="teacher-order-empty">No Phase 1 teachers yet — add subject lessons or a small-group teacher override.</li>';
    if(hint) hint.textContent = '';
    return;
  }
  list.innerHTML = ids.map((id, i) => `
    <li class="teacher-order-item" draggable="true" data-id="${escapeAttr(id)}">
      <span class="teacher-order-handle" aria-hidden="true">⋮⋮</span>
      <span class="teacher-order-n">${i + 1}</span>
      <span class="teacher-order-name">${escapeAttr(teacherName(id) || id)}</span>
    </li>
  `).join('');
  if(hint){
    hint.textContent = hasManualPhase1TeacherOrder()
      ? 'The first Generate attempt uses this order. Shuffled attempts still permute the list. New teachers appear at the end.'
      : 'Automatic: fewest available days, then most minutes. Drag a name to set the first-attempt order; shuffled attempts still permute.';
  }
  let dragId = null;
  list.querySelectorAll('.teacher-order-item').forEach(li => {
    li.addEventListener('dragstart', e => {
      dragId = li.dataset.id;
      li.classList.add('is-dragging');
      if(e.dataTransfer){
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId);
      }
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('is-dragging');
      list.querySelectorAll('.is-over').forEach(el => el.classList.remove('is-over'));
      dragId = null;
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      if(e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      li.classList.add('is-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('is-over'));
    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('is-over');
      const from = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || dragId;
      const to = li.dataset.id;
      if(!from || !to || from === to) return;
      const order = [...list.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      const fi = order.indexOf(from);
      const ti = order.indexOf(to);
      if(fi < 0 || ti < 0) return;
      order.splice(fi, 1);
      order.splice(ti, 0, from);
      setManualPhase1TeacherOrder(order);
      renderPhase1TeacherOrderModal();
    });
  });
}
function openPhase1TeacherOrderModal(){
  if(SEARCH_UI_LOCK) return;
  hideGenerateConfirm();
  setModalOverlay('searchLogOverlay', false);
  setModalOverlay('smallGroupQuotasOverlay', false);
  hideSmallGroupStudentsEditor();
  renderPhase1TeacherOrderModal();
  setModalOverlay('phase1TeacherOrderOverlay', true);
}
const phase1TeacherOrderBtn = document.getElementById('phase1TeacherOrderBtn');
if(phase1TeacherOrderBtn){
  phase1TeacherOrderBtn.addEventListener('click', openPhase1TeacherOrderModal);
}
const phase1TeacherOrderCloseBtn = document.getElementById('phase1TeacherOrderCloseBtn');
if(phase1TeacherOrderCloseBtn){
  phase1TeacherOrderCloseBtn.addEventListener('click', () => setModalOverlay('phase1TeacherOrderOverlay', false));
}
const phase1TeacherOrderResetBtn = document.getElementById('phase1TeacherOrderResetBtn');
if(phase1TeacherOrderResetBtn){
  phase1TeacherOrderResetBtn.addEventListener('click', () => {
    clearManualPhase1TeacherOrder();
    renderPhase1TeacherOrderModal();
  });
}
const phase1TeacherOrderOverlay = document.getElementById('phase1TeacherOrderOverlay');
if(phase1TeacherOrderOverlay){
  phase1TeacherOrderOverlay.addEventListener('click', e => {
    if(e.target.id === 'phase1TeacherOrderOverlay') setModalOverlay('phase1TeacherOrderOverlay', false);
  });
}
updatePhase1TeacherOrderBtn();

document.getElementById('variantSelect').addEventListener('change', (e) => {
  if(SEARCH_UI_LOCK) return;
  const idx = parseInt(e.target.value, 10) || 0;
  LAST_RESULT = LAST_VARIANTS[idx];
  showLogForSelected();
  populateVariantSelector();
  renderResults(LAST_RESULT);
});

function renderResults(result){
  const {scheduled, unresolved} = result;
  ensureDragBaseline(result);
  document.getElementById('resultsPanel').style.display = 'block';
  document.getElementById('unresolvedPanel').style.display = unresolved.length ? 'block' : 'none';

  const statsRow = document.getElementById('statsRow');
  statsRow.style.display = 'flex';
  statsRow.innerHTML = `
    <div class="stat"><div class="num">${scheduled.length}</div><div class="lbl">Scheduled</div></div>
    <div class="stat"><div class="num">${unresolved.length}</div><div class="lbl">Unresolved</div></div>
    <div class="stat"><div class="num">${DB.lessons.length + getSmallGroupLessons().length}</div><div class="lbl">Lesson groups</div></div>
    <div class="stat"><div class="num">${DB.students.length}</div><div class="lbl">Students</div></div>
  `;

  const teacherFilter = document.getElementById('teacherFilter');
  const previouslySelectedTeacher = teacherFilter.value; // preserve across regenerate / variant switch
  const teacherIds = [...new Set(scheduled.map(s=>s.teacherId))].sort((a,b)=>{
    const na = teacherName(a)||a, nb = teacherName(b)||b; return na.localeCompare(nb);
  });
  teacherFilter.innerHTML = teacherIds.map(t => `<option value="${t}">${teacherName(t)||t}</option>`).join('');
  if(previouslySelectedTeacher && teacherIds.includes(previouslySelectedTeacher)){
    teacherFilter.value = previouslySelectedTeacher;
  }

  renderGrid();

  const ul = document.getElementById('unresolvedList');
  ul.innerHTML = unresolved.map(u => {
    const reason = u.customReason ? u.customReason
      : Object.keys(u.dayWin).length === 0
      ? `teacher <b>${u.lesson.teacher||u.lesson.teacherId}</b> has no availability rows at all — add some in the "Teacher availability" tab.`
      : `no shared free slot found within availability + class-time windows for its ${u.students.length} students.`;
    return `<li><b>${u.lesson.name}</b> (${u.lesson.id}${u.lesson.teacherId ? ', teacher '+(u.lesson.teacher||u.lesson.teacherId) : ''}, ${u.students.length} students, ${u.lesson.duration} min) — ${reason}</li>`;
  }).join('') || '<li>None — every lesson group was placed.</li>';

  const quotasOverlay = document.getElementById('smallGroupQuotasOverlay');
  if(overlayIsOpen(quotasOverlay)) renderSmallGroupQuotasModal();
}

document.getElementById('viewMode').addEventListener('change', renderGrid);
document.getElementById('teacherFilter').addEventListener('change', renderGrid);
document.querySelector('#viewMode').addEventListener('change', (e)=>{
  document.getElementById('teacherFilter').style.display = e.target.value==='teacher' ? 'inline-block':'none';
});

function renderGrid(){
  if(!LAST_RESULT) return;
  const viewModeEl = document.getElementById('viewMode');
  const grid = document.getElementById('ttGrid');
  const legend = document.getElementById('ttLegend');
  if(!viewModeEl || !grid || !legend) return;
  abortCalendarInteraction();
  LAST_AUDIT = auditTimetable(timetableAuditItems(LAST_RESULT.scheduled));
  const mode = viewModeEl.value;
  let items = LAST_RESULT.scheduled;

  if(mode === 'teacher'){
    const tid = document.getElementById('teacherFilter').value;
    items = items.filter(i => i.teacherId === tid);
    legend.style.display = 'none';
    renderCalendar(grid, items, false);
  } else if(mode === 'all'){
    legend.style.display = 'flex';
    renderTeacherLegend(legend, LAST_RESULT.scheduled);
    renderCalendar(grid, items, true);
  } else {
    legend.style.display = 'none';
    renderChronoList(grid, items);
  }
  const dragHint = document.getElementById('ttDragHint');
  if(dragHint) dragHint.style.display = mode === 'group' ? 'none' : 'block';
  attachHoverTooltips(grid);
  attachCalendarDrag(grid);
  renderAuditPanel();
  updateDragEditButtons();
  updateTimetableAcceptBtn();
}

// A single floating tooltip element, positioned with the mouse via JS (position:fixed),
// so it's never clipped by the calendar's scrolling/rounded-corner containers the way a
// CSS pseudo-element tied to the block's own box would be.
function getTooltipEl(){
  let el = document.getElementById('hoverTooltip');
  if(!el){
    el = document.createElement('div');
    el.id = 'hoverTooltip';
    el.className = 'hover-tooltip';
    document.body.appendChild(el);
  }
  return el;
}
function attachHoverTooltips(container){
  const tip = getTooltipEl();
  function place(e){
    const pad = 16;
    let x = e.clientX + pad, y = e.clientY + pad;
    const rect = tip.getBoundingClientRect();
    if(x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - pad;
    if(y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - pad;
    tip.style.left = Math.max(8,x) + 'px';
    tip.style.top = Math.max(8,y) + 'px';
  }
  container.querySelectorAll('[data-tooltip]').forEach(el => {
    el.addEventListener('mouseenter', e => {
      if(CAL_DRAG) return;
      tip.textContent = el.dataset.tooltip;
      tip.style.display = 'block';
      place(e);
    });
    el.addEventListener('mousemove', place);
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// ---------- Teacher colour coding (for the "all teachers" view) ----------
function colorForTeacher(teacherId){
  // Golden-angle hue stepping by stable teacher order — spreads colours evenly around
  // the wheel regardless of how similar the IDs look (a hash of "TEAC1".."TEAC25" tends
  // to cluster in one hue range, which is why everyone looked blue before).
  const ids = DB.refTeachers.map(t => t.id).slice().sort();
  let idx = ids.indexOf(teacherId);
  if(idx === -1) idx = 0;
  const hue = (idx * 137.508) % 360;
  return {
    bg: `hsl(${hue} 68% 90%)`,
    border: `hsl(${hue} 58% 46%)`
  };
}
function renderTeacherLegend(el, items){
  const ids = [...new Set(items.map(i=>i.teacherId))].sort((a,b)=>{
    const na=teacherName(a)||a, nb=teacherName(b)||b; return na.localeCompare(nb);
  });
  el.innerHTML = ids.map(id => {
    const c = colorForTeacher(id);
    return `<span class="legend-chip"><span class="swatch" style="background:${c.bg};border-color:${c.border}"></span>${teacherName(id)||id}</span>`;
  }).join('');
}

// Assigns a column + total-column-count to every item on a given day so that
// genuinely overlapping lessons (different teachers, same slot, "all teachers" view)
// sit side by side, while back-to-back lessons (touching but not overlapping) each
// keep the full width and simply stack.
function layoutColumns(dayItems){
  const items = dayItems.slice().sort((a,b)=> a.start-b.start || a.end-b.end);
  let cluster = [], clusterEnd = -Infinity;
  const clusters = [];
  items.forEach(item => {
    if(item.start >= clusterEnd){
      if(cluster.length) clusters.push(cluster);
      cluster = [item];
      clusterEnd = item.end;
    } else {
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.end);
    }
  });
  if(cluster.length) clusters.push(cluster);

  clusters.forEach(cl => {
    const colEnds = [];
    cl.forEach(item => {
      let placedCol = -1;
      for(let c=0;c<colEnds.length;c++){
        if(colEnds[c] <= item.start){ placedCol = c; colEnds[c] = item.end; break; }
      }
      if(placedCol === -1){ placedCol = colEnds.length; colEnds.push(item.end); }
      item._col = placedCol;
    });
    const totalCols = colEnds.length;
    cl.forEach(item => { item._totalCols = totalCols; });
  });
  return items;
}

const CAL_DAY_START = 8*60, CAL_DAY_END = 20*60, CAL_PX_PER_MIN = 1.15;

function renderCalendar(container, items, colorByTeacher, dragSource){
  const totalHeight = (CAL_DAY_END - CAL_DAY_START) * CAL_PX_PER_MIN;

  let ticksHtml = '<div class="cal-headerpad"></div>';
  for(let h = 8; h <= 20; h++){
    const top = (h*60 - CAL_DAY_START) * CAL_PX_PER_MIN;
    ticksHtml += `<div class="tick" style="top:${top}px">${String(h).padStart(2,'0')}:00</div>`;
  }

  let daysHtml = '';
  DAYS.forEach(day => {
    const dayReservations = layoutColumns(items.filter(i => i.day === day && i.source === 'class'));
    const dayItems = layoutColumns(items.filter(i => i.day === day && i.source !== 'class'));
    let blocksHtml = '';
    function paintBlock(i, z){
      const top = (i.start - CAL_DAY_START) * CAL_PX_PER_MIN;
      const height = Math.max((i.end - i.start) * CAL_PX_PER_MIN - 2, 14);
      const widthPct = 100 / i._totalCols;
      const leftPct = i._col * widthPct;
      const isClass = i.source === 'class';
      const style = (!isClass && colorByTeacher && !i.source) ? (() => {
        const c = colorForTeacher(i.teacherId);
        return `background:${c.bg};border-left-color:${c.border};`;
      })() : '';
      const teacherLine = (!isClass && colorByTeacher && !i.source) ? `<span class="meta">${i.teacher||i.teacherId}</span>` : '';
      const roomTag = !isClass && itemRoomId(i) ? ' 🔒' + itemRoomLabel(i) : '';
      const studentTitle = escapeAttr(isClass
        ? ((i.classNames && i.classNames.length) ? `${i.name}\n${i.classNames.join('\n')}` : (i.name || 'Class reservation'))
        : ((i.studentNames && i.studentNames.length) ? `${i.name} — ${i.studentNames.length} students:\n${i.studentNames.join('\n')}` : i.name));
      const sourceCls = isClass ? ' is-class'
        : (i.source === 'accepted' ? ' is-accepted-bg'
        : (i.source === 'oneone' ? ' is-oneone'
        : (i.source === 'rpiano' ? ' is-rpiano' : '')));
      const canDrag = isClass ? false : (dragSource ? i.source === dragSource : !i.source);
      const conflictCls = !isClass && itemHasConflict(i) ? ' has-conflict' : '';
      const countLabel = isClass
        ? 'reserved'
        : (i.studentCount === 1 ? '1 student' : `${i.studentCount} students`);
      return `<div class="cal-block${conflictCls}${sourceCls}${canDrag ? ' is-draggable' : ''}" data-lesson-id="${escapeAttr(i.lessonId)}" data-source="${escapeAttr(i.source || '')}" data-draggable="${canDrag ? '1' : ''}" data-tooltip="${studentTitle}" style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);z-index:${z};${style}">
        <b>${i.name}${roomTag}</b>${teacherLine}<span class="meta">${toHHMM(i.start)}–${toHHMM(i.end)} · ${countLabel}</span>
      </div>`;
    }
    dayReservations.forEach(i => { blocksHtml += paintBlock(i, 0); });
    dayItems.forEach(i => { blocksHtml += paintBlock(i, 1); });
    daysHtml += `<div class="cal-day">
      <div class="cal-day-header">${DAY_LABEL[day]}</div>
      <div class="cal-day-body" style="height:${totalHeight}px">${blocksHtml}</div>
    </div>`;
  });

  container.innerHTML = `<div class="cal-wrap">
    <div class="cal-timeaxis" style="height:${totalHeight+34}px">${ticksHtml}</div>
    <div class="cal-days">${daysHtml}</div>
  </div>`;
}

function renderChronoList(containerEl, items){
  let html = '<table class="tt"><thead><tr><th>Day</th><th>Time</th><th>Lesson</th><th>Teacher</th><th>Students</th></tr></thead><tbody>';
  items.forEach(i => {
    const studentTitle = escapeAttr((i.studentNames && i.studentNames.length) ? `${i.name} — ${i.studentNames.length} students:\n${i.studentNames.join('\n')}` : i.name);
    html += `<tr>
      <td class="tt-time">${DAY_LABEL[i.day]}</td>
      <td class="tt-time">${toHHMM(i.start)}–${toHHMM(i.end)}</td>
      <td><div class="lesson-block${itemHasConflict(i) ? ' has-conflict' : ''}" data-tooltip="${studentTitle}"><b>${i.name}${itemRoomId(i) ? ' 🔒'+itemRoomLabel(i) : ''}</b><span class="meta">${i.group} · ${i.lessonId}</span></div></td>
      <td>${i.teacher||i.teacherId}</td>
      <td>${i.studentCount}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  containerEl.innerHTML = html;
}

function lookupLessonForScheduled(item){
  if(!item || !item.lessonId) return null;
  if(isSmallGroupId(item.lessonId)){
    return getSmallGroupLessons().find(l => l.id === item.lessonId) || null;
  }
  return DB.lessons.find(l => l.id === item.lessonId) || null;
}
function scheduledItemIsPinned(item){
  const l = lookupLessonForScheduled(item);
  if(!l || !l.fixedDay || !DAYS.includes(l.fixedDay)) return false;
  const start = toMin(l.fixedStart);
  if(start == null || item.day !== l.fixedDay || item.start !== start) return false;
  const end = start + lessonDurationMinutes(l);
  return item.end === end;
}
function studentsForScheduledItem(item){
  const l = lookupLessonForScheduled(item);
  if(l) return lessonStudents(l);
  if(item.groupId) return studentsInGroup(item.groupId);
  const raw = item.studentIds || item.studentId || '';
  const ids = String(raw).split(/[,;]+/).map(x => String(x).trim()).filter(Boolean);
  if(!ids.length) return [];
  return ids.map(id => (DB.students || []).find(s => s.ID === id)).filter(Boolean);
}
function frozenIndividualItems(){
  const out = [];
  if(typeof hasAcceptedOneOne === 'function' && hasAcceptedOneOne()){
    out.push.apply(out, (LAST_ONEONE && LAST_ONEONE.scheduled) || []);
  }
  if(typeof hasAcceptedRpiano === 'function' && hasAcceptedRpiano()){
    out.push.apply(out, (LAST_RPIANO && LAST_RPIANO.scheduled) || []);
  }
  return out.filter(i => i && i.day && i.start != null && i.end != null);
}
function generatedIndividualItems(){
  return ((LAST_ONEONE && LAST_ONEONE.scheduled) || [])
    .concat((LAST_RPIANO && LAST_RPIANO.scheduled) || [])
    .filter(i => i && i.day && i.start != null && i.end != null);
}
function acceptedGroupItems(){
  return (DB.acceptedSchedule || []).filter(r => r.status === 'scheduled' && r.day && toMin(r.start) != null && toMin(r.end) != null).map(r => ({
    lessonId: r.lessonId || ('ACC-' + r.name),
    name: r.name || '',
    teacherId: r.teacherId,
    teacher: r.teacher,
    day: r.day,
    start: typeof r.start === 'number' ? r.start : toMin(r.start),
    end: typeof r.end === 'number' ? r.end : toMin(r.end),
    studentCount: r.studentCount,
    studentNames: r.students ? String(r.students).split(/[,;]+/).map(x => x.trim()).filter(Boolean) : [],
    studentIds: r.studentIds || '',
    ...roomFieldsOf(r),
    source: 'accepted'
  }));
}
function combinedWeekItems(kind){
  const groups = acceptedGroupItems();
  const one = ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).filter(i => i && i.day && i.start != null && i.end != null);
  const piano = ((LAST_RPIANO && LAST_RPIANO.scheduled) || []).filter(i => i && i.day && i.start != null && i.end != null);
  if(kind === 'oneone') return groups.concat(one).concat(hasAcceptedRpiano() ? piano : []);
  if(kind === 'rpiano') return groups.concat(hasAcceptedOneOne() ? one : []).concat(piano);
  return groups.concat(hasAcceptedOneOne() ? one : []).concat(hasAcceptedRpiano() ? piano : []);
}
function emptyReportFilters(){
  return { classId:'', studentId:'', muclass:'', roomId:'', teacherId:'', kind:'', showClassReservations: true };
}
let REPORT_FILTERS = emptyReportFilters();
function reportItemKind(item){
  if(!item) return 'group';
  if(item.source === 'class') return 'class';
  if(item.source === 'oneone') return 'oneone';
  if(item.source === 'rpiano' || item.source === 'piano') return 'rpiano';
  return 'group';
}
function reportKindLabel(kind){
  if(kind === 'oneone') return '1/1';
  if(kind === 'rpiano') return 'Required Piano';
  if(kind === 'class') return 'Class reservation';
  return 'Group lessons';
}
function classReservationItems(){
  return (DB.classAvail || []).map((r, idx) => {
    if(!r || !r.day || !DAYS.includes(r.day)) return null;
    const start = toMin(r.start);
    const end = toMin(r.end);
    const s = start != null ? start : DEFAULT_START;
    const e = end != null ? end : DEFAULT_END;
    if(e <= s) return null;
    if(!r.start && !r.end) return null;
    const classId = r.classId || '';
    const label = r.class || className(classId) || classId || 'Class';
    return {
      lessonId: 'CLASS-' + (classId || idx) + '-' + r.day + '-' + s,
      name: label + ' reserved',
      day: r.day,
      start: s,
      end: e,
      source: 'class',
      classId,
      class: label,
      classIds: classId ? [classId] : [],
      classNames: [label],
      teacherId: '',
      teacher: '',
      roomId: '',
      room: '',
      studentCount: 0,
      studentNames: [label],
      note: r.note || ''
    };
  }).filter(Boolean);
}
function mergeClassReservationItems(items){
  const groups = new Map();
  (items || []).forEach(i => {
    const key = [i.day, i.start, i.end].join('|');
    if(!groups.has(key)){
      groups.set(key, {
        lessonId: 'CLASS-' + i.day + '-' + i.start + '-' + i.end,
        name: '',
        day: i.day,
        start: i.start,
        end: i.end,
        source: 'class',
        classId: i.classId || '',
        classIds: [],
        classNames: [],
        teacherId: '',
        teacher: '',
        roomId: '',
        room: '',
        studentCount: 0,
        studentNames: [],
        note: i.note || ''
      });
    }
    const g = groups.get(key);
    const id = i.classId || '';
    const label = i.class || (id ? className(id) : '') || id;
    if(id && !g.classIds.includes(id)){
      g.classIds.push(id);
      g.classNames.push(label);
    } else if(!id && label && !g.classNames.includes(label)){
      g.classNames.push(label);
    }
  });
  return [...groups.values()].map(g => {
    const names = g.classNames;
    g.name = names.length <= 3
      ? names.join(', ') + ' reserved'
      : names.slice(0, 2).join(', ') + ' +' + (names.length - 2) + ' reserved';
    g.class = names.join(', ');
    g.classId = g.classIds.length === 1 ? g.classIds[0] : '';
    g.studentNames = names.slice();
    return g;
  });
}
function reportClassReservationItems(filters, lessonItems){
  const f = filters || emptyReportFilters();
  if(f.showClassReservations === false) return [];
  const rows = classReservationItems();
  let classIds = null;
  if(f.classId){
    classIds = new Set([f.classId]);
  } else if(f.studentId){
    const st = (DB.students || []).find(s => s && s.ID === f.studentId);
    classIds = new Set(st && st.CLASS_ID ? [st.CLASS_ID] : []);
  } else if(f.muclass){
    classIds = new Set((DB.refClasses || []).filter(c => classMuclass(c.id) === f.muclass).map(c => c.id));
  } else if(f.teacherId || f.roomId || (f.kind && f.kind !== 'class')){
    classIds = new Set();
    (lessonItems || []).forEach(i => {
      reportItemClasses(i).forEach(c => { if(c && c.id) classIds.add(c.id); });
    });
  }
  if(!classIds) return rows;
  return rows.filter(r => r.classId && classIds.has(r.classId));
}
function reportWeekItems(){
  const seen = new Set();
  const out = [];
  function add(list){
    (list || []).forEach(i => {
      if(!i || !i.day || i.start == null || i.end == null) return;
      const key = [i.lessonId || i.name, i.day, i.start, i.end, reportItemKind(i)].join('|');
      if(seen.has(key)) return;
      seen.add(key);
      out.push(i);
    });
  }
  if(LAST_RESULT && (LAST_RESULT.scheduled || []).length) add(LAST_RESULT.scheduled);
  else add(acceptedGroupItems());
  add((LAST_ONEONE && LAST_ONEONE.scheduled) || []);
  add((LAST_RPIANO && LAST_RPIANO.scheduled) || []);
  out.sort((a,b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start || String(a.name||'').localeCompare(String(b.name||'')));
  return out;
}
function reportItemStudentIds(item){
  const fromRoster = studentsForScheduledItem(item).map(s => s && s.ID).filter(Boolean);
  if(fromRoster.length) return fromRoster;
  const raw = [item && item.studentId, item && item.studentIds].filter(Boolean).join(',');
  return String(raw).split(/[,;]+/).map(x => String(x).trim()).filter(Boolean);
}
function reportItemMatches(item, filters){
  const f = filters || emptyReportFilters();
  if(reportItemKind(item) === 'class'){
    if(f.kind && f.kind !== 'class') return false;
    if(f.teacherId || f.roomId) return false;
    if(f.classId && item.classId !== f.classId && !(item.classIds || []).includes(f.classId)) return false;
    if(f.studentId){
      const st = (DB.students || []).find(s => s && s.ID === f.studentId);
      if(!st || !st.CLASS_ID || (item.classId !== st.CLASS_ID && !(item.classIds || []).includes(st.CLASS_ID))) return false;
    }
    if(f.muclass){
      const ids = (item.classIds && item.classIds.length) ? item.classIds : (item.classId ? [item.classId] : []);
      if(!ids.some(id => classMuclass(id) === f.muclass)) return false;
    }
    return true;
  }
  if(f.kind && reportItemKind(item) !== f.kind) return false;
  if(f.teacherId && String(item.teacherId || '') !== String(f.teacherId)) return false;
  if(f.roomId && itemRoomId(item) !== String(f.roomId)) return false;
  const students = studentsForScheduledItem(item);
  const ids = reportItemStudentIds(item);
  if(f.studentId){
    const sid = String(f.studentId);
    if(!ids.includes(sid) && !students.some(s => s && s.ID === sid)) return false;
  }
  if(f.classId){
    if(!students.some(s => s && s.CLASS_ID === f.classId)) return false;
  }
  if(f.muclass){
    if(!students.some(s => s && classMuclass(s.CLASS_ID) === f.muclass)) return false;
  }
  return true;
}
function filterReportItems(items, filters){
  return (items || []).filter(i => reportItemMatches(i, filters));
}
function reportItemClasses(item){
  if(item && item.source === 'class'){
    const ids = (item.classIds && item.classIds.length) ? item.classIds : (item.classId ? [item.classId] : []);
    return ids.map(id => ({
      id,
      name: item.class && ids.length === 1 ? item.class : (className(id) || id),
      muclass: classMuclass(id)
    }));
  }
  const seen = new Set();
  const out = [];
  studentsForScheduledItem(item).forEach(s => {
    if(!s || !s.CLASS_ID || seen.has(s.CLASS_ID)) return;
    seen.add(s.CLASS_ID);
    out.push({ id: s.CLASS_ID, name: className(s.CLASS_ID) || s.CLASS_ID, muclass: classMuclass(s.CLASS_ID) });
  });
  return out;
}
function reportCsvAoa(items){
  const headers = ['DAY','START','END','KIND','LESSON','TEACHER','TEACHER_ID','ROOM','ROOM_ID','STUDENTS','STUDENT_IDS','CLASS','MUCLASS_TYPE'];
  const rows = (items || []).map(i => {
    const students = studentsForScheduledItem(i);
    const names = (i.studentNames && i.studentNames.length)
      ? i.studentNames.slice()
      : students.map(studentDisplayName);
    const classes = reportItemClasses(i);
    const kind = reportItemKind(i);
    return [
      i.day || '',
      i.start != null ? toHHMM(i.start) : '',
      i.end != null ? toHHMM(i.end) : '',
      reportKindLabel(kind),
      i.name || '',
      kind === 'class' ? '' : (i.teacher || teacherName(i.teacherId) || ''),
      kind === 'class' ? '' : (i.teacherId || ''),
      kind === 'class' ? '' : itemRoomLabel(i),
      kind === 'class' ? '' : itemRoomId(i),
      names.join(', '),
      reportItemStudentIds(i).join(', '),
      classes.map(c => c.name).join(', '),
      [...new Set(classes.map(c => c.muclass).filter(Boolean))].join(', ')
    ];
  });
  return [headers].concat(rows);
}
function fillReportSelect(el, options, blankLabel, current){
  if(!el) return;
  const opts = [`<option value="">${blankLabel}</option>`].concat((options || []).map(o => {
    const value = escapeAttr(o.value);
    const label = escapeAttr(o.label);
    return `<option value="${value}">${label}</option>`;
  }));
  el.innerHTML = opts.join('');
  if(current && [...(el.options || [])].some(o => o.value === current)){
    el.value = current;
  } else if(current){
    el.value = current;
  } else {
    el.value = '';
  }
}
function readReportFiltersFromUi(){
  const val = (id) => {
    const el = document.getElementById(id);
    return el && el.value != null ? String(el.value) : '';
  };
  REPORT_FILTERS = {
    classId: val('reportClassFilter'),
    studentId: val('reportStudentFilter'),
    muclass: val('reportMuclassFilter'),
    roomId: val('reportRoomFilter'),
    teacherId: val('reportTeacherFilter'),
    kind: val('reportKindFilter'),
    showClassReservations: (() => {
      const el = document.getElementById('reportShowClassReservations');
      if(!el) return REPORT_FILTERS.showClassReservations !== false;
      return !!el.checked;
    })()
  };
}
function fillReportFilterOptions(){
  const classes = (DB.refClasses || []).slice().sort((a,b) => String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const students = (DB.students || []).slice().sort((a,b) => studentDisplayName(a).localeCompare(studentDisplayName(b)));
  const muclasses = [...new Set((DB.refClasses || []).map(c => classMuclass(c.id)).filter(Boolean))].sort((a,b) => String(a).localeCompare(String(b)));
  const rooms = (DB.refRooms || []).slice().sort((a,b) => String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const teachers = (DB.refTeachers || []).slice().sort((a,b) => String(a.name||a.id).localeCompare(String(b.name||b.id)));
  fillReportSelect(document.getElementById('reportClassFilter'),
    classes.map(c => ({ value: c.id, label: (c.name || c.id) + (classMuclass(c.id) ? ' · ' + classMuclass(c.id) : '') })),
    'All classes', REPORT_FILTERS.classId);
  fillReportSelect(document.getElementById('reportStudentFilter'),
    students.map(s => ({ value: s.ID, label: studentDisplayName(s) })),
    'All students', REPORT_FILTERS.studentId);
  fillReportSelect(document.getElementById('reportMuclassFilter'),
    muclasses.map(m => ({ value: m, label: m })),
    'All MUCLASS_TYPE', REPORT_FILTERS.muclass);
  fillReportSelect(document.getElementById('reportRoomFilter'),
    rooms.map(r => ({ value: r.id, label: r.name || r.id })),
    'All rooms', REPORT_FILTERS.roomId);
  fillReportSelect(document.getElementById('reportTeacherFilter'),
    teachers.map(t => ({ value: t.id, label: t.name || t.id })),
    'All teachers', REPORT_FILTERS.teacherId);
  const kindEl = document.getElementById('reportKindFilter');
  if(kindEl && REPORT_FILTERS.kind) kindEl.value = REPORT_FILTERS.kind;
  const showClassEl = document.getElementById('reportShowClassReservations');
  if(showClassEl) showClassEl.checked = REPORT_FILTERS.showClassReservations !== false;
}
function renderReportList(container, items){
  if(!container) return;
  if(!items.length){
    container.innerHTML = '';
    return;
  }
  let html = '<table class="data tt"><thead><tr><th>Day</th><th>Time</th><th>Kind</th><th>Lesson</th><th>Teacher</th><th>Room</th><th>Class</th><th>Students</th></tr></thead><tbody>';
  items.forEach(i => {
    const isClass = reportItemKind(i) === 'class';
    const students = isClass ? [] : studentsForScheduledItem(i);
    const names = isClass
      ? (i.classNames || []).slice()
      : ((i.studentNames && i.studentNames.length) ? i.studentNames.slice() : students.map(studentDisplayName));
    const classes = reportItemClasses(i).map(c => c.name).join(', ');
    const studentTitle = escapeAttr(names.length ? `${i.name}\n${names.join('\n')}` : (i.name || ''));
    const blockCls = isClass ? ' lesson-block is-class' : 'lesson-block';
    html += `<tr>
      <td class="tt-time">${DAY_LABEL[i.day] || i.day}</td>
      <td class="tt-time">${toHHMM(i.start)}–${toHHMM(i.end)}</td>
      <td>${reportKindLabel(reportItemKind(i))}</td>
      <td><div class="${blockCls}" data-tooltip="${studentTitle}"><b>${i.name || ''}${!isClass && itemRoomId(i) ? ' 🔒'+itemRoomLabel(i) : ''}</b></div></td>
      <td>${isClass ? '—' : (i.teacher || teacherName(i.teacherId) || '')}</td>
      <td>${isClass ? '—' : (itemRoomLabel(i) || '—')}</td>
      <td>${classes || '—'}</td>
      <td>${isClass ? '—' : names.length}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}
function classReservationLegendChip(){
  return `<span class="legend-chip"><span class="swatch" style="background:rgba(224,87,107,.30);border-color:#c43b50"></span>Class reservation</span>`;
}
function renderReportsTab(){
  fillReportFilterOptions();
  const all = reportWeekItems();
  const items = REPORT_FILTERS.kind === 'class' ? [] : filterReportItems(all, REPORT_FILTERS);
  const reservations = reportClassReservationItems(REPORT_FILTERS, items);
  const overlay = mergeClassReservationItems(reservations);
  const count = document.getElementById('reportCount');
  const empty = document.getElementById('reportEmpty');
  const grid = document.getElementById('reportGrid');
  const list = document.getElementById('reportList');
  const legend = document.getElementById('reportLegend');
  const total = all.length;
  const bits = [];
  if(total) bits.push(`${items.length} of ${total} items`);
  if(reservations.length) bits.push(`${reservations.length} class reservation${reservations.length === 1 ? '' : 's'}`);
  if(count) count.textContent = bits.join(' · ') || 'No calendar items yet';
  if(empty){
    if(items.length || reservations.length) empty.textContent = '';
    else if(total) empty.textContent = 'Nothing matches these filters.';
    else empty.textContent = 'Generate group lessons (and 1/1 / Required Piano) to fill the week calendar. Tick Class reservations to overlay CLASS_CONST busy times in red.';
  }
  if(legend){
    const groups = items.filter(i => reportItemKind(i) === 'group');
    const chips = [];
    if(reservations.length) chips.push(classReservationLegendChip());
    if(groups.length){
      legend.style.display = 'flex';
      renderTeacherLegend(legend, groups);
      if(chips.length) legend.innerHTML = chips.join('') + (legend.innerHTML || '');
    } else if(chips.length){
      legend.style.display = 'flex';
      legend.innerHTML = chips.join('');
    } else {
      legend.style.display = 'none';
      legend.innerHTML = '';
    }
  }
  if(grid) renderCalendar(grid, items.concat(overlay), true, 'none');
  renderReportList(list, items.concat(reservations));
  if(grid) attachHoverTooltips(grid);
  if(list) attachHoverTooltips(list);
}
function downloadReportCsv(){
  const all = reportWeekItems();
  const items = REPORT_FILTERS.kind === 'class' ? [] : filterReportItems(all, REPORT_FILTERS);
  const reservations = reportClassReservationItems(REPORT_FILTERS, items);
  const rows = items.concat(reservations);
  if(!rows.length){ alert('Nothing to export for these filters.'); return; }
  const aoa = reportCsvAoa(rows);
  downloadFile('bartokkonzi_timetable_report.csv', aoa.map(toCsvRow).join('\r\n'));
}
function printReports(){
  if(typeof document === 'undefined' || !document.body) return;
  document.body.classList.add('is-print-report');
  const done = () => document.body.classList.remove('is-print-report');
  if(typeof window !== 'undefined' && window.addEventListener){
    window.addEventListener('afterprint', done, { once: true });
  }
  if(typeof window !== 'undefined' && typeof window.print === 'function') window.print();
  else done();
}
function timetableAuditItems(scheduled){
  return (scheduled || []).concat(frozenIndividualItems());
}
function itemHasConflict(item){
  return !!(LAST_AUDIT && item && item.lessonId && LAST_AUDIT.conflictIds.has(item.lessonId));
}
function overlapRangeLabel(a, b){
  return `${DAY_LABEL[a.day]} ${toHHMM(Math.max(a.start, b.start))}–${toHHMM(Math.min(a.end, b.end))}`;
}
function itemSlotLabel(item){
  return `${DAY_LABEL[item.day]} ${toHHMM(item.start)}–${toHHMM(item.end)}`;
}

// Re-checks every hard scheduler rule against the current placements. Moves are never
// rejected — this only reports what's broken so the editor can show it under the grid.
// Gap / break-budget problems are warnings (yellow, listed after red errors) and do
// not paint the calendar blocks red.
function auditTimetable(scheduled){
  const entries = [];
  const conflictIds = new Set();
  function addEntry(level, html, lessonIds){
    const ids = lessonIds.filter(Boolean);
    if(level !== 'warning') ids.forEach(id => conflictIds.add(id));
    entries.push({html, ids, level: level || 'error'});
  }
  function addIssue(html, ...lessonIds){ addEntry('error', html, lessonIds); }
  function addWarning(html, ...lessonIds){ addEntry('warning', html, lessonIds); }
  const list = Array.isArray(scheduled) ? scheduled : [];
  const studentsOf = new Map();
  list.forEach(item => { studentsOf.set(item, studentsForScheduledItem(item)); });

  list.forEach(item => {
    const isIndividual = item.source === 'oneone' || item.source === 'rpiano';
    if(!isIndividual && (item.start < DEFAULT_START || item.end > DEFAULT_END)){
      addIssue(`<b>${item.name}</b> sits outside the 08:00–20:00 school day (${itemSlotLabel(item)})`, item.lessonId);
    }
    const tw = teacherWindowClash(item.teacherId, item.teacher, item.day, item.start, item.end, availKindForItem(item));
    if(tw) addIssue(`<b>${item.name}</b> ${itemSlotLabel(item)} — ${tw}`, item.lessonId);
    const sr = studentReservationClash(studentsOf.get(item) || [], item.day, item.start, item.end);
    if(sr){
      if(scheduledItemIsPinned(item)){
        addWarning(`<b>${item.name}</b> ${itemSlotLabel(item)} — ${sr} (pinned; placed anyway)`, item.lessonId);
      } else {
        addIssue(`<b>${item.name}</b> ${itemSlotLabel(item)} — ${sr}`, item.lessonId);
      }
    }
  });

  for(let i=0;i<list.length;i++){
    for(let j=i+1;j<list.length;j++){
      const a = list[i], b = list[j];
      if(a.day !== b.day || !intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
      const when = overlapRangeLabel(a, b);
      if(a.teacherId && a.teacherId === b.teacherId){
        const label = a.teacher || b.teacher || teacherName(a.teacherId) || a.teacherId;
        addIssue(`<b>${a.name}</b> and <b>${b.name}</b> both need teacher ${label} at ${when}`, a.lessonId, b.lessonId);
      }
      if(roomsOverlap(a, b)){
        addIssue(`<b>${a.name}</b> and <b>${b.name}</b> both need ${roomClashLabel(a)} at ${when}`, a.lessonId, b.lessonId);
      }
      const sa = studentsOf.get(a) || [];
      const sbIds = new Set((studentsOf.get(b) || []).map(s => s.ID));
      const shared = sa.filter(s => sbIds.has(s.ID));
      if(shared.length){
        const names = shared.map(studentDisplayName).join(', ');
        const who = shared.length === 1 ? names : `${shared.length} students (${names})`;
        addIssue(`<b>${a.name}</b> and <b>${b.name}</b> both include ${who} at ${when}`, a.lessonId, b.lessonId);
      }
    }
  }

  const byTeacher = {};
  list.forEach(item => {
    if(!item.teacherId) return;
    (byTeacher[item.teacherId] = byTeacher[item.teacherId] || []).push(item);
  });
  Object.entries(byTeacher).forEach(([tid, items]) => {
    const bs = teacherBreakSettings(tid);
    const label = teacherName(tid) || tid;
    let units = 0;
    DAYS.forEach(day => {
      const dayItems = items.filter(it => it.day === day).slice().sort((a,b)=> a.start-b.start || a.end-b.end);
      for(let i=1;i<dayItems.length;i++){
        const prev = dayItems[i-1], cur = dayItems[i];
        const win = teacherDayWindows(tid)[day];
        const gap = breakGapBetweenIntervals(teacherWindowIntervals(win), prev.end, cur.start);
        if(gap < 0) continue;
        const extra = breakUnitsForGap(gap, bs.minutes);
        if(bs.unconstrained) continue;
        if(gap > 0 && extra === null){
          const allowed = (bs.minutes === 0 || bs.count === 0)
            ? 'no gap (this teacher has no break budget)'
            : `0 or a multiple of ${bs.minutes} min`;
          addWarning(`Teacher ${label}: ${gap} min gap on ${DAY_LABEL[day]} between <b>${prev.name}</b> (${toHHMM(prev.end)}) and <b>${cur.name}</b> (${toHHMM(cur.start)}) — allowed gaps are ${allowed}`, prev.lessonId, cur.lessonId);
        } else if(extra){
          units += extra;
        }
      }
    });
    if(!bs.unconstrained && units > bs.count){
      const budget = (bs.minutes === 0 || bs.count === 0)
        ? '0 (no gaps allowed)'
        : `${bs.minutes} min × ${bs.count}`;
      const involved = items.map(it => it.lessonId);
      addWarning(`Teacher ${label} used ${units} break unit(s) this week; budget is ${budget}`, ...involved);
    }
  });

  entries.sort((a,b) => (a.level === 'warning' ? 1 : 0) - (b.level === 'warning' ? 1 : 0));
  return {issues: entries.map(e => e.html), entries, conflictIds};
}

function renderAuditPanel(opts){
  const prefix = (opts && opts.prefix) || 'tt';
  const wrap = document.getElementById(prefix + 'AuditWrap');
  const list = document.getElementById(prefix + 'AuditList');
  const ok = document.getElementById(prefix + 'AuditOk');
  const title = document.getElementById(prefix + 'AuditTitle');
  const warnBox = document.getElementById(prefix + 'AuditWarnings');
  const warnList = document.getElementById(prefix + 'AuditWarnList');
  const warnLabel = warnBox && warnBox.querySelector
    ? warnBox.querySelector('.tt-audit-warnings-label')
    : null;
  if(!wrap) return;
  if(prefix === 'tt' && !LAST_RESULT){
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  const allow = opts && opts.lessonIds ? new Set(opts.lessonIds) : null;
  let entries = (LAST_AUDIT && LAST_AUDIT.entries) || [];
  if(allow) entries = entries.filter(e => e.ids.some(id => allow.has(id)));
  entries = entries.slice().sort((a,b) => (a.level === 'warning' ? 1 : 0) - (b.level === 'warning' ? 1 : 0));
  const errors = entries.filter(e => e.level !== 'warning');
  const warnings = entries.filter(e => e.level === 'warning');
  if(title){
    title.textContent = errors.length
      ? `Constraint check — ${errors.length} issue${errors.length===1?'':'s'}`
      : 'Constraint check';
  }
  if(!entries.length){
    if(ok){
      ok.style.display = 'block';
      ok.textContent = prefix === 'tt'
        ? 'No constraint issues. Drag any lesson to another day or time — the move always sticks, and this list will show whatever breaks, including clashes with frozen 1/1 and Required Piano. Gap problems sit under WARNINGS — hover to read them.'
        : 'No constraint issues. Drag a lesson — the move always sticks. This list re-checks teacher windows, class reservations, double-bookings, rooms, and break gaps against the accepted week plus 1/1 and Required Piano. Gap problems sit under WARNINGS — hover to read them.';
    }
    if(list){
      list.innerHTML = '';
      list.style.display = 'none';
    }
    if(warnBox) warnBox.hidden = true;
    return;
  }
  if(ok) ok.style.display = 'none';
  if(list){
    if(errors.length){
      list.style.display = 'block';
      list.innerHTML = errors.map(e => `<li class="is-error">${e.html}</li>`).join('');
    } else {
      list.innerHTML = '';
      list.style.display = 'none';
    }
  }
  if(warnBox && warnList){
    if(warnings.length){
      warnBox.hidden = false;
      if(warnLabel) warnLabel.textContent = `WARNINGS · ${warnings.length}`;
      warnList.innerHTML = warnings.map(e =>
        `<li class="is-warning"><span class="tt-audit-level">WARNING</span> ${e.html}</li>`
      ).join('');
    } else {
      warnBox.hidden = true;
      warnList.innerHTML = '';
    }
  }
}

function cloneLessonSlots(scheduled){
  return (scheduled || []).map(i => ({lessonId: i.lessonId, day: i.day, start: i.start, end: i.end}));
}
function applyLessonSlots(scheduled, slots){
  if(!scheduled || !slots) return;
  const byId = {};
  slots.forEach(s => { byId[s.lessonId] = s; });
  scheduled.forEach(item => {
    const s = byId[item.lessonId];
    if(!s) return;
    item.day = s.day;
    item.start = s.start;
    item.end = s.end;
  });
}
function lessonSlotsMatch(scheduled, slots){
  if(!scheduled || !slots || scheduled.length !== slots.length) return false;
  const byId = {};
  slots.forEach(s => { byId[s.lessonId] = s; });
  return scheduled.every(item => {
    const s = byId[item.lessonId];
    return s && s.day === item.day && s.start === item.start && s.end === item.end;
  });
}
function ensureDragBaseline(result){
  if(!result) return;
  if(!result.dragBaseline) result.dragBaseline = cloneLessonSlots(result.scheduled);
  if(!Array.isArray(result.dragUndo)) result.dragUndo = [];
}
function updateTimetableAcceptBtn(){
  const btn = document.getElementById('acceptScheduleBtn');
  if(!btn) return;
  const ready = !!(LAST_RESULT && (LAST_RESULT.scheduled || []).length);
  const accepted = !!(ready && LAST_RESULT.accepted);
  btn.disabled = !ready || accepted;
  btn.textContent = accepted ? '✓ Schedule accepted' : '✓ Accept this schedule';
  updateAllTabLocks();
}
function markLayoutNeedsAccept(kind){
  if(kind === 'oneone' && LAST_ONEONE){
    LAST_ONEONE.accepted = false;
    updateAllTabLocks();
    return;
  }
  if(kind === 'rpiano' && LAST_RPIANO){
    LAST_RPIANO.accepted = false;
    updateAllTabLocks();
    return;
  }
  if(LAST_RESULT) LAST_RESULT.accepted = false;
  updateTimetableAcceptBtn();
}
function updateDragEditButtons(){
  const undoBtn = document.getElementById('ttUndoBtn');
  const resetBtn = document.getElementById('ttResetBtn');
  if(!undoBtn && !resetBtn) return;
  const result = LAST_RESULT;
  const canUndo = !!(result && result.dragUndo && result.dragUndo.length);
  const canReset = !!(result && result.dragBaseline && !lessonSlotsMatch(result.scheduled, result.dragBaseline));
  if(undoBtn) undoBtn.disabled = !canUndo;
  if(resetBtn) resetBtn.disabled = !canReset;
}
function undoLastDrag(){
  if(SEARCH_UI_LOCK) return;
  if(!LAST_RESULT || !LAST_RESULT.dragUndo || !LAST_RESULT.dragUndo.length) return;
  const step = LAST_RESULT.dragUndo.pop();
  const item = scheduledItemById(step.lessonId);
  if(item && step.from){
    item.day = step.from.day;
    item.start = step.from.start;
    item.end = step.from.end;
  }
  renderGrid();
  markWorkDirty();
}
function undoIndividualDrag(kind){
  if(SEARCH_UI_LOCK) return;
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  if(!state || !state.dragUndo || !state.dragUndo.length) return;
  const step = state.dragUndo.pop();
  const item = (state.scheduled || []).find(it => String(it.lessonId) === String(step.lessonId));
  if(item && step.from){
    item.day = step.from.day;
    item.start = step.from.start;
    item.end = step.from.end;
  }
  if(kind === 'rpiano') renderRpianoTab();
  else renderOneOneTab();
  markWorkDirty();
}
function updateIndividualUndo(kind){
  const btn = document.getElementById(kind === 'rpiano' ? 'rpianoUndoBtn' : 'oneoneUndoBtn');
  if(!btn) return;
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  btn.disabled = !(state && state.dragUndo && state.dragUndo.length);
}
function resetVariantDrags(){
  if(SEARCH_UI_LOCK) return;
  if(!LAST_RESULT || !LAST_RESULT.dragBaseline) return;
  applyLessonSlots(LAST_RESULT.scheduled, LAST_RESULT.dragBaseline);
  LAST_RESULT.dragUndo = [];
  markLayoutNeedsAccept('timetable');
  renderGrid();
  markWorkDirty();
}

const CAL_SNAP_MIN = 5;
let CAL_DRAG = null;

function snapMinutes(mins){
  return Math.round(mins / CAL_SNAP_MIN) * CAL_SNAP_MIN;
}
function clampLessonStart(start, duration){
  const maxStart = CAL_DAY_END - duration;
  return Math.max(CAL_DAY_START, Math.min(start, maxStart));
}
function scheduledItemById(lessonId){
  const lists = [
    LAST_RESULT && LAST_RESULT.scheduled,
    LAST_ONEONE && LAST_ONEONE.scheduled,
    LAST_RPIANO && LAST_RPIANO.scheduled
  ];
  for(let i=0;i<lists.length;i++){
    const list = lists[i];
    if(!list) continue;
    const hit = list.find(it => String(it.lessonId) === String(lessonId));
    if(hit) return hit;
  }
  return null;
}
function hitCalendarDay(clientX, clientY, dayBodies){
  for(let i=0;i<dayBodies.length;i++){
    const rect = dayBodies[i].getBoundingClientRect();
    if(clientX >= rect.left && clientX < rect.right){
      return {dayIndex:i, day: DAYS[i], body: dayBodies[i], rect};
    }
  }
  return null;
}
function startFromPointerY(clientY, bodyRect, duration, grabOffsetMin){
  const y = clientY - bodyRect.top;
  const raw = CAL_DAY_START + y / CAL_PX_PER_MIN - (grabOffsetMin || 0);
  return clampLessonStart(snapMinutes(raw), duration);
}
function clearDropPreview(container){
  if(!container) return;
  container.querySelectorAll('.cal-drop-preview').forEach(el => el.remove());
}
function showDropPreview(dayBody, start, duration){
  let el = dayBody.querySelector('.cal-drop-preview');
  if(!el){
    el = document.createElement('div');
    el.className = 'cal-drop-preview';
    dayBody.appendChild(el);
  }
  const top = (start - CAL_DAY_START) * CAL_PX_PER_MIN;
  const height = Math.max(duration * CAL_PX_PER_MIN - 2, 14);
  el.style.top = top + 'px';
  el.style.height = height + 'px';
}
function abortCalendarInteraction(){
  if(CAL_DRAG) endCalendarDrag(false);
  else {
    document.body.classList.remove('cal-drag-active');
    window.removeEventListener('pointermove', onCalendarPointerMove);
    window.removeEventListener('pointerup', onCalendarPointerUp);
    window.removeEventListener('pointercancel', onCalendarPointerUp);
    window.removeEventListener('keydown', onCalendarDragKey);
  }
  const tip = document.getElementById('hoverTooltip');
  if(tip) tip.style.display = 'none';
}
function endCalendarDrag(apply){
  if(!CAL_DRAG) return;
  const drag = CAL_DRAG;
  CAL_DRAG = null;
  document.body.classList.remove('cal-drag-active');
  window.removeEventListener('pointermove', onCalendarPointerMove);
  window.removeEventListener('pointerup', onCalendarPointerUp);
  window.removeEventListener('pointercancel', onCalendarPointerUp);
  window.removeEventListener('keydown', onCalendarDragKey);
  if(drag.block && drag.block.releasePointerCapture){
    try{ drag.block.releasePointerCapture(drag.pointerId); }catch(e){}
  }
  if(drag.block) drag.block.classList.remove('is-dragging');
  clearDropPreview(drag.container);
  if(!apply || !drag.active || !drag.hover) return;
  const item = scheduledItemById(drag.lessonId);
  if(!item) return;
  const duration = Math.max(CAL_SNAP_MIN, item.end - item.start);
  const start = drag.hover.start;
  const end = start + duration;
  if(item.day === drag.hover.day && item.start === start && item.end === end) return;
  const kind = drag.kind || 'timetable';
  if(kind === 'oneone' || kind === 'rpiano'){
    const state = kind === 'oneone' ? LAST_ONEONE : LAST_RPIANO;
    if(!state) return;
    ensureDragBaseline(state);
    state.dragUndo.push({
      lessonId: item.lessonId,
      from: {day: item.day, start: item.start, end: item.end},
      to: {day: drag.hover.day, start, end}
    });
    item.day = drag.hover.day;
    item.start = start;
    item.end = end;
    markLayoutNeedsAccept(kind);
    markWorkDirty();
    if(kind === 'oneone') renderOneOneTab();
    else renderRpianoTab();
    return;
  }
  if(!LAST_RESULT) return;
  ensureDragBaseline(LAST_RESULT);
  LAST_RESULT.dragUndo.push({
    lessonId: item.lessonId,
    from: {day: item.day, start: item.start, end: item.end},
    to: {day: drag.hover.day, start, end}
  });
  item.day = drag.hover.day;
  item.start = start;
  item.end = end;
  markLayoutNeedsAccept('timetable');
  markWorkDirty();
  renderGrid();
}
function onCalendarPointerMove(e){
  if(!CAL_DRAG) return;
  const drag = CAL_DRAG;
  const dx = e.clientX - drag.originX, dy = e.clientY - drag.originY;
  if(!drag.active && (dx*dx + dy*dy) < 36) return;
  if(!drag.active){
    drag.active = true;
    document.body.classList.add('cal-drag-active');
    drag.block.classList.add('is-dragging');
    const tip = document.getElementById('hoverTooltip');
    if(tip) tip.style.display = 'none';
    try{ drag.block.setPointerCapture(drag.pointerId); }catch(err){}
  }
  e.preventDefault();
  const scrollWrap = drag.container.closest('.grid-wrap');
  if(scrollWrap){
    const r = scrollWrap.getBoundingClientRect();
    const margin = 36;
    if(e.clientY > r.bottom - margin) scrollWrap.scrollTop += 18;
    else if(e.clientY < r.top + margin) scrollWrap.scrollTop -= 18;
    if(e.clientX > r.right - margin) scrollWrap.scrollLeft += 18;
    else if(e.clientX < r.left + margin) scrollWrap.scrollLeft -= 18;
  }
  const hit = hitCalendarDay(e.clientX, e.clientY, drag.dayBodies);
  if(!hit){
    drag.hover = null;
    clearDropPreview(drag.container);
    return;
  }
  const start = startFromPointerY(e.clientY, hit.rect, drag.duration, drag.grabOffsetMin);
  drag.hover = {day: hit.day, start, body: hit.body};
  if(drag.previewBody && drag.previewBody !== hit.body) clearDropPreview(drag.container);
  drag.previewBody = hit.body;
  showDropPreview(hit.body, start, drag.duration);
}
function onCalendarPointerUp(e){
  if(!CAL_DRAG) return;
  if(e && CAL_DRAG.active) e.preventDefault();
  endCalendarDrag(true);
}
function onCalendarDragKey(e){
  if(e.key === 'Escape') endCalendarDrag(false);
}
function onCalendarBlockPointerDown(e){
  if(SEARCH_UI_LOCK) return;
  if(e.button != null && e.button !== 0) return;
  const block = e.currentTarget;
  if(block.dataset.draggable !== '1') return;
  const lessonId = block.dataset.lessonId;
  const item = scheduledItemById(lessonId);
  if(!item) return;
  const container = block.closest('#ttGrid') || block.closest('#oneoneGrid') || block.closest('#rpianoGrid') || block.closest('.cal-wrap');
  if(!container) return;
  const wrap = container.querySelector ? (container.querySelector('.cal-wrap') || container) : container;
  const dayBodies = [...wrap.querySelectorAll('.cal-day-body')];
  if(!dayBodies.length) return;
  const blockRect = block.getBoundingClientRect();
  const source = block.dataset.source || '';
  CAL_DRAG = {
    pointerId: e.pointerId,
    block,
    container: wrap,
    dayBodies,
    lessonId,
    kind: source === 'oneone' || source === 'rpiano' ? source : 'timetable',
    duration: Math.max(CAL_SNAP_MIN, item.end - item.start),
    grabOffsetMin: (e.clientY - blockRect.top) / CAL_PX_PER_MIN,
    originX: e.clientX,
    originY: e.clientY,
    active: false,
    hover: null,
    previewBody: null
  };
  window.addEventListener('pointermove', onCalendarPointerMove, {passive:false});
  window.addEventListener('pointerup', onCalendarPointerUp);
  window.addEventListener('pointercancel', onCalendarPointerUp);
  window.addEventListener('keydown', onCalendarDragKey);
}
function attachCalendarDrag(container){
  if(!container) return;
  container.querySelectorAll('.cal-block[data-lesson-id]').forEach(block => {
    block.addEventListener('pointerdown', onCalendarBlockPointerDown);
    block.addEventListener('dragstart', e => e.preventDefault());
  });
}

document.getElementById('ttUndoBtn')?.addEventListener('click', undoLastDrag);
document.getElementById('ttResetBtn')?.addEventListener('click', resetVariantDrags);
document.addEventListener('keydown', (e) => {
  if(!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
  const tab = document.querySelector('.tab-btn.active');
  const tabId = tab && tab.dataset.tab;
  if(tabId === 'oneone'){
    if(!LAST_ONEONE || !LAST_ONEONE.dragUndo || !LAST_ONEONE.dragUndo.length) return;
    e.preventDefault();
    undoIndividualDrag('oneone');
    return;
  }
  if(tabId === 'rpiano'){
    if(!LAST_RPIANO || !LAST_RPIANO.dragUndo || !LAST_RPIANO.dragUndo.length) return;
    e.preventDefault();
    undoIndividualDrag('rpiano');
    return;
  }
  if(!LAST_RESULT || !LAST_RESULT.dragUndo || !LAST_RESULT.dragUndo.length) return;
  e.preventDefault();
  undoLastDrag();
});

// Official iCalendar (.ics) — Google Calendar: Settings → Import & export → Import.
const ICS_DOW = {MON:'MO', TUE:'TU', WED:'WE', THU:'TH', FRI:'FR'};
const ICS_JS_DOW = {MON:1, TUE:2, WED:3, THU:4, FRI:5};
function icsPad(n){ return String(n).padStart(2,'0'); }
function icsStampUtc(d){
  return d.getUTCFullYear()+icsPad(d.getUTCMonth()+1)+icsPad(d.getUTCDate())
    +'T'+icsPad(d.getUTCHours())+icsPad(d.getUTCMinutes())+icsPad(d.getUTCSeconds())+'Z';
}
function icsLocal(date, minutes){
  return date.getFullYear()+icsPad(date.getMonth()+1)+icsPad(date.getDate())
    +'T'+icsPad(Math.floor(minutes/60))+icsPad(minutes%60)+'00';
}
function icsNextDate(dayKey, from){
  const target = ICS_JS_DOW[dayKey];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const diff = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d;
}
function icsEscape(s){
  return String(s == null ? '' : s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
}
function icsFold(line){
  if(line.length <= 73) return line;
  let out = line.slice(0,73), rest = line.slice(73);
  while(rest.length){
    out += '\r\n '+rest.slice(0,72);
    rest = rest.slice(72);
  }
  return out;
}
function scheduledStudentNames(i){
  if(i.studentNames && i.studentNames.length) return i.studentNames.slice();
  if(i.groupId) return studentsInGroup(i.groupId).map(studentDisplayName).sort();
  if(i.lessonId && isSmallGroupId(i.lessonId)){
    const sg = findSmallGroupById(i.lessonId);
    if(sg) return SMALL_GROUP_TYPES.flatMap(t => sg[t] || []).map(studentDisplayName).sort();
  }
  return [];
}
function calendarEventTitle(i){
  return [i.name, i.teacher || teacherName(i.teacherId) || '', i.group || ''].filter(Boolean).join(' — ');
}
function buildTimetableIcs(scheduled, fromDate){
  const now = fromDate || new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BartokKonzi//Timetable 2026//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Bartók 2026',
    'X-WR-TIMEZONE:Europe/Budapest',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Budapest',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const stamp = icsStampUtc(now);
  (scheduled || []).forEach(i => {
    if(!i.day || !ICS_DOW[i.day] || i.start == null || i.end == null) return;
    const when = icsNextDate(i.day, now);
    const title = calendarEventTitle(i);
    const students = scheduledStudentNames(i);
    const uid = (i.lessonId || 'LES')+'-'+i.day+'@bartokkonzi';
    lines.push('BEGIN:VEVENT');
    lines.push('UID:'+uid);
    lines.push('DTSTAMP:'+stamp);
    lines.push('DTSTART;TZID=Europe/Budapest:'+icsLocal(when, i.start));
    lines.push('DTEND;TZID=Europe/Budapest:'+icsLocal(when, i.end));
    lines.push('RRULE:FREQ=WEEKLY;BYDAY='+ICS_DOW[i.day]+';UNTIL=20270615T200000Z');
    lines.push(icsFold('SUMMARY:'+icsEscape(title)));
    if(students.length) lines.push(icsFold('DESCRIPTION:'+icsEscape(students.join('\n'))));
    if(itemRoomId(i)) lines.push('LOCATION:'+icsEscape(itemRoomLabel(i)));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n')+'\r\n';
}
function acceptedItemsForExport(){
  const frozen = DB.acceptedTimetable && Array.isArray(DB.acceptedTimetable.scheduled)
    ? DB.acceptedTimetable.scheduled : [];
  if(frozen.length) return frozen;
  return (DB.acceptedSchedule || []).filter(r => r.status === 'scheduled').map(r => ({
    lessonId: r.lessonId,
    name: r.name,
    teacher: r.teacher,
    teacherId: r.teacherId,
    group: r.group,
    groupId: r.groupId,
    day: r.day,
    start: typeof r.start === 'number' ? r.start : toMin(r.start),
    end: typeof r.end === 'number' ? r.end : toMin(r.end),
    studentNames: r.students ? String(r.students).split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [],
    ...roomFieldsOf(r)
  }));
}
document.getElementById('exportCalendarBtn').addEventListener('click', () => {
  const scheduled = acceptedItemsForExport().filter(i => i && i.day && i.start != null && i.end != null);
  if(!scheduled.length){
    alert('Accept a schedule first.');
    return;
  }
  const ics = buildTimetableIcs(scheduled, new Date());
  downloadFile('bartokkonzi_timetable.ics', ics, 'text/calendar;charset=utf-8');
  alert('Saved bartokkonzi_timetable.ics — in Google Calendar open Settings → Import & export → Import. Weekly events run through 15 June 2027. Import into a new calendar if you want to delete the whole set later.');
});

function renderAcceptedStatus(){
  const el = document.getElementById('acceptedStatus');
  if(!el) return;
  if(DB.acceptedTimetable && DB.acceptedTimetable.acceptedAt){
    const d = new Date(DB.acceptedTimetable.acceptedAt);
    const n = (DB.acceptedSchedule || []).filter(r => r.status === 'scheduled').length;
    const u = (DB.acceptedSchedule || []).filter(r => r.status === 'unresolved').length;
    el.textContent = `✓ Accepted ${d.toLocaleString()} — ${n} rows in Accepted schedule${u ? `, ${u} unresolved` : ''}. SCHEDULED columns on Lesson groups / Small Groups were filled; FIXED times and teacher overrides were left alone.`;
  } else {
    el.textContent = '';
  }
  updateOneOneTabLock();
  updateRpianoTabLock();
}

function formatScheduledWho(students){
  return Array.isArray(students) ? students.filter(Boolean).join(', ') : String(students || '').trim();
}
function formatLessonScheduledData(lesson){
  if(!lesson || !lesson.scheduledDay) return '';
  return formatScheduledWho(studentsInGroup(lesson.groupId).map(studentDisplayName).sort());
}
function formatAcceptedScheduledData(r){
  return r ? formatScheduledWho(r.students) : '';
}

function buildAcceptedScheduleRows(result){
  const rows = [];
  const dayRank = (d) => { const i = DAYS.indexOf(d); return i < 0 ? 99 : i; };
  (result.scheduled || []).forEach(item => {
    const students = studentsForScheduledItem(item);
    const names = (item.studentNames && item.studentNames.length)
      ? item.studentNames.slice()
      : students.map(studentDisplayName).sort();
    const kind = isSmallGroupId(item.lessonId || '') ? 'smallgroup' : 'lesson';
    const duration = (item.end != null && item.start != null) ? (item.end - item.start) : lessonDurationMinutes(item);
    rows.push({
      lessonId: item.lessonId || '',
      name: item.name || '',
      kind,
      group: item.group || '',
      groupId: item.groupId || '',
      teacher: item.teacher || teacherName(item.teacherId) || '',
      teacherId: item.teacherId || '',
      day: item.day || '',
      start: item.start != null ? toHHMM(item.start) : '',
      end: item.end != null ? toHHMM(item.end) : '',
      duration,
      ...roomFieldsOf(item),
      studentCount: names.length,
      students: names.join(', '),
      studentIds: students.map(s => s.ID).filter(Boolean).join(', '),
      status: 'scheduled',
      note: '',
    });
  });
  rows.sort((a,b) => dayRank(a.day)-dayRank(b.day) || String(a.start).localeCompare(String(b.start)) || String(a.name).localeCompare(String(b.name)));
  (result.unresolved || []).forEach(u => {
    const l = u.lesson || {};
    const students = u.students || [];
    const names = students.map(studentDisplayName).sort();
    const kind = isSmallGroupId(l.id || '') ? 'smallgroup' : 'lesson';
    rows.push({
      lessonId: l.id || '',
      name: l.name || '',
      kind,
      group: l.group || '',
      groupId: l.groupId || '',
      teacher: l.teacher || teacherName(l.teacherId) || '',
      teacherId: l.teacherId || '',
      day: '', start: '', end: '',
      duration: lessonDurationMinutes(l),
      ...roomFieldsOf(l),
      studentCount: names.length,
      students: names.join(', '),
      studentIds: students.map(s => s.ID).filter(Boolean).join(', '),
      status: 'unresolved',
      note: String(u.customReason || 'no free slot found within availability + class-time windows.').replace(/<[^>]+>/g, ''),
    });
  });
  return rows;
}

function clearScheduledFields(obj){
  if(!obj) return;
  obj.scheduledDay = '';
  obj.scheduledStart = '';
  obj.scheduledEnd = '';
  obj.scheduledTeacherId = '';
  obj.scheduledTeacher = '';
}
function clearAcceptedScheduledRecord(){
  (DB.lessons || []).forEach(clearScheduledFields);
  if(LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups) LAST_SMALL_GROUPS.smallGroups.forEach(clearScheduledFields);
  DB.acceptedSchedule = [];
  DB.acceptedTimetable = null;
  LAST_ONEONE = null;
  LAST_RPIANO = null;
  renderLessons();
  if(LAST_SMALL_GROUPS) renderSmallGroupsResults(LAST_SMALL_GROUPS);
  renderAcceptedSchedule();
  renderAcceptedStatus();
  renderOneOneTab();
  renderRpianoTab();
}
function writeAcceptedToSourceTables(result){
  // SCHEDULED_* is a record of the last Accept — the generator never reads it.
  // FIXED / teacher override stay as the user's search constraints.
  (DB.lessons || []).forEach(clearScheduledFields);
  if(LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups) LAST_SMALL_GROUPS.smallGroups.forEach(clearScheduledFields);
  let lessonsWritten = 0;
  let smallGroupsWritten = 0;
  (result.scheduled || []).forEach(item => {
    const startH = item.start != null ? toHHMM(item.start) : '';
    const endH = item.end != null ? toHHMM(item.end) : '';
    if(item.lessonId && isSmallGroupId(item.lessonId)){
      const sg = findSmallGroupById(item.lessonId);
      if(!sg) return;
      sg.scheduledTeacherId = item.teacherId || '';
      sg.scheduledTeacher = item.teacher || teacherName(item.teacherId) || '';
      sg.scheduledDay = item.day || '';
      sg.scheduledStart = startH;
      sg.scheduledEnd = endH;
      smallGroupsWritten++;
      return;
    }
    const lesson = (DB.lessons || []).find(l => l.id === item.lessonId);
    if(!lesson) return;
    lesson.scheduledDay = item.day || '';
    lesson.scheduledStart = startH;
    lesson.scheduledEnd = endH;
    lessonsWritten++;
  });
  return {lessonsWritten, smallGroupsWritten};
}

const ACCEPTED_SCHEDULE_CSV_HEADERS = ['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_ID','ROOM','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA'];
function acceptedScheduleTime(v){
  if(v == null || v === '') return '';
  if(typeof v === 'number' && Number.isFinite(v)) return toHHMM(v);
  return toHHMM(toMin(v)) || String(v);
}
function individualAcceptedRows(state, kind){
  const dayRank = (d) => { const i = DAYS.indexOf(d); return i < 0 ? 99 : i; };
  const rows = [];
  ((state && state.scheduled) || []).forEach(item => {
    const names = (item.studentNames && item.studentNames.length)
      ? item.studentNames.slice()
      : (item.students ? String(item.students).split(/[,;]+/).map(s => s.trim()).filter(Boolean) : [item.name].filter(Boolean));
    const startMin = typeof item.start === 'number' ? item.start : toMin(item.start);
    const endMin = typeof item.end === 'number' ? item.end : toMin(item.end);
    const duration = item.duration || ((startMin != null && endMin != null) ? (endMin - startMin) : '');
    rows.push({
      lessonId: item.lessonId || '',
      name: item.name || '',
      kind,
      group: item.group || kind,
      groupId: item.groupId || '',
      teacher: item.teacher || teacherName(item.teacherId) || '',
      teacherId: item.teacherId || '',
      day: item.day || '',
      start: acceptedScheduleTime(item.start),
      end: acceptedScheduleTime(item.end),
      duration,
      ...roomFieldsOf(item),
      studentCount: names.length,
      students: names.join(', '),
      studentIds: item.studentIds || item.studentId || '',
      status: 'scheduled',
      note: '',
    });
  });
  rows.sort((a,b) => dayRank(a.day)-dayRank(b.day) || String(a.start).localeCompare(String(b.start)) || String(a.name).localeCompare(String(b.name)));
  ((state && state.unresolved) || []).forEach(u => {
    const student = (DB.students || []).find(s => s.ID === u.studentId);
    const name = u.name || (student ? studentDisplayName(student) : u.studentId) || '';
    rows.push({
      lessonId: '',
      name,
      kind,
      group: kind,
      groupId: '',
      teacher: teacherName(u.teacherId) || u.teacherId || '',
      teacherId: u.teacherId || '',
      day: '', start: '', end: '',
      duration: u.duration || '',
      roomId: '', room: '',
      studentCount: name ? 1 : 0,
      students: name,
      studentIds: u.studentId || '',
      status: 'unresolved',
      note: String(u.reason || 'no free slot found within availability + class-time windows.').replace(/<[^>]+>/g, ''),
    });
  });
  return rows;
}
function acceptedScheduleTableHtml(rows){
  let html = '<thead><tr>'
    + '<th>DAY</th><th>START</th><th>END</th><th>NAME</th><th>TEACHER</th>'
    + '<th>ROOM</th><th>KIND</th><th>STATUS</th><th>SCHEDULED DATA</th>'
    + '</tr></thead><tbody>';
  rows.forEach(r => {
    const cls = r.status === 'unresolved' ? ' class="is-unresolved"' : '';
    html += `<tr${cls}>`
      + `<td>${escapeAttr(r.day)}</td>`
      + `<td>${escapeAttr(r.start)}</td>`
      + `<td>${escapeAttr(r.end)}</td>`
      + `<td>${escapeAttr(r.name)}${r.lessonId ? `<div class="meta" style="font-family:var(--mono);font-size:10px;color:var(--ink-dim)">${escapeAttr(r.lessonId)}</div>` : ''}</td>`
      + `<td>${escapeAttr(r.teacher)}</td>`
      + `<td>${itemRoomId(r) ? '🔒'+escapeAttr(itemRoomLabel(r)) : ''}</td>`
      + `<td>${escapeAttr(r.kind)}</td>`
      + `<td>${escapeAttr(r.status)}${r.note ? `<div class="cell-wrap" style="max-width:220px;color:var(--ink-dim)">${escapeAttr(r.note)}</div>` : ''}</td>`
      + `<td style="white-space:nowrap">${escapeAttr(formatAcceptedScheduledData(r))}</td>`
      + '</tr>';
  });
  html += '</tbody>';
  return html;
}
function fillAcceptedSchedulePanel(ids, rows){
  const panel = document.getElementById(ids.panel);
  const table = document.getElementById(ids.table);
  const tag = document.getElementById(ids.tag);
  const list = rows || [];
  if(panel) panel.style.display = list.length ? 'block' : 'none';
  if(tag){
    const n = list.filter(r => r.status === 'scheduled').length;
    const u = list.filter(r => r.status === 'unresolved').length;
    tag.textContent = n ? `${n} booked${u ? ` · ${u} unresolved` : ''}` : '';
  }
  if(!table) return;
  table.innerHTML = list.length ? acceptedScheduleTableHtml(list) : '';
}
function downloadAcceptedScheduleCsv(rows, filename){
  const list = rows || [];
  if(!list.length){ alert('Accept a schedule first.'); return; }
  const csv = [toCsvRow(ACCEPTED_SCHEDULE_CSV_HEADERS)].concat(list.map(r => toCsvRow([
    r.lessonId, r.name, r.kind, r.teacher, r.teacherId,
    r.day, r.start, r.end, r.duration, itemRoomId(r), itemRoomLabel(r),
    r.studentCount, r.students, r.studentIds, r.status, r.note, formatAcceptedScheduledData(r)
  ])));
  downloadFile(filename, csv.join('\r\n'));
}

function renderAcceptedSchedule(){
  fillAcceptedSchedulePanel({
    panel: 'acceptedSchedulePanel',
    table: 'acceptedScheduleTable',
    tag: 'acceptedScheduleTag'
  }, DB.acceptedSchedule || []);
}

function acceptTimetableSchedule(){
  if(SEARCH_UI_LOCK) return;
  if(!LAST_RESULT){ alert('Generate the timetable first.'); return; }
  DB.acceptedSchedule = buildAcceptedScheduleRows(LAST_RESULT);
  DB.acceptedTimetable = {
    acceptedAt: new Date().toISOString(),
    scheduled: JSON.parse(JSON.stringify(LAST_RESULT.scheduled || [])),
    unresolved: (LAST_RESULT.unresolved || []).map(u => ({
      lessonId: u.lesson && u.lesson.id, name: u.lesson && u.lesson.name,
      reason: u.customReason || 'no free slot found within availability + class-time windows.'
    }))
  };
  LAST_RESULT.accepted = true;
  LAST_RESULT.dragUndo = [];
  LAST_RESULT.dragBaseline = cloneLessonSlots(LAST_RESULT.scheduled);
  const {lessonsWritten, smallGroupsWritten} = writeAcceptedToSourceTables(LAST_RESULT);
  renderLessons();
  if(LAST_SMALL_GROUPS) renderSmallGroupsResults(LAST_SMALL_GROUPS);
  renderAcceptedSchedule();
  renderAcceptedStatus();
  updateTimetableAcceptBtn();
  updateDragEditButtons();
  markWorkDirty();
  const bits = [`${(DB.acceptedSchedule || []).filter(r => r.status==='scheduled').length} rows in Accepted schedule`];
  if(lessonsWritten) bits.push(`${lessonsWritten} lesson SCHEDULED slot(s)`);
  if(smallGroupsWritten) bits.push(`${smallGroupsWritten} small group SCHEDULED slot(s)`);
  alert('Schedule accepted — ' + bits.join(', ') + '. Generate still uses FIXED / teacher override only.');
}

document.getElementById('acceptScheduleBtn').addEventListener('click', acceptTimetableSchedule);

document.getElementById('exportAcceptedBtn').addEventListener('click', () => {
  downloadAcceptedScheduleCsv(DB.acceptedSchedule || [], 'bartokkonzi_accepted_schedule.csv');
});

function downloadFile(filename, content, mime){
  const blob = content instanceof Blob ? content : new Blob([content], {type: mime || 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Save / load the whole working database as JSON ----------
// ---------- Save / load the whole working database ----------
// Shared by the local JSON file export/import AND the cloud (Supabase) sync — both use
// the exact same "bundle everything" / "restore everything" logic, so behaviour never
// drifts between the two.
const REQUIRED_DB_KEYS = ['students','lessons','teacherAvail','classAvail','refTeachers','refClasses','refGroups','refInstruments'];

function collectUiState(){
  const activeBtn = document.querySelector('.tab-btn.active');
  return {
    smallGroupCount: document.getElementById('smallGroupCountInput') ? document.getElementById('smallGroupCountInput').value : '',
    scheduleSearchAttempts: document.getElementById('scheduleSearchAttempts') ? document.getElementById('scheduleSearchAttempts').value : '',
    oneOneSearchAttempts: document.getElementById('oneoneSearchAttempts') ? document.getElementById('oneoneSearchAttempts').value : '',
    rpianoSearchAttempts: document.getElementById('rpianoSearchAttempts') ? document.getElementById('rpianoSearchAttempts').value : '',
    viewMode: document.getElementById('viewMode') ? document.getElementById('viewMode').value : 'week',
    teacherFilter: document.getElementById('teacherFilter') ? document.getElementById('teacherFilter').value : '',
    reportFilters: Object.assign({}, REPORT_FILTERS),
    activeTab: activeBtn && activeBtn.dataset.tab ? activeBtn.dataset.tab : 'students'
  };
}

function applyUiState(ui){
  if(!ui) return;
  const smallGroupIn = document.getElementById('smallGroupCountInput');
  const savedCount = ui.smallGroupCount;
  if(smallGroupIn && savedCount != null && savedCount !== '') smallGroupIn.value = savedCount;
  const attemptsIn = document.getElementById('scheduleSearchAttempts');
  if(attemptsIn && ui.scheduleSearchAttempts != null && ui.scheduleSearchAttempts !== ''){
    attemptsIn.value = String(clampScheduleSearchAttempts(ui.scheduleSearchAttempts));
    SCHEDULE_SEARCH_ATTEMPTS = clampScheduleSearchAttempts(attemptsIn.value);
  }
  if(ui.oneOneSearchAttempts != null && ui.oneOneSearchAttempts !== ''){
    ONEONE_SEARCH_ATTEMPTS = clampOneOneSearchAttempts(ui.oneOneSearchAttempts);
    const oneEl = document.getElementById('oneoneSearchAttempts');
    if(oneEl) oneEl.value = String(ONEONE_SEARCH_ATTEMPTS);
  }
  if(ui.rpianoSearchAttempts != null && ui.rpianoSearchAttempts !== ''){
    RPIANO_SEARCH_ATTEMPTS = clampOneOneSearchAttempts(ui.rpianoSearchAttempts);
    const pianoEl = document.getElementById('rpianoSearchAttempts');
    if(pianoEl) pianoEl.value = String(RPIANO_SEARCH_ATTEMPTS);
  }
  if(ui.activeTab){
    try {
      let tab = ui.activeTab;
      const dirty = pendingAcceptTab();
      if(dirty) tab = dirty;
      else {
        if(tab === 'rpiano' && !canOpenRpiano()) tab = canOpenOneOne() ? 'oneone' : 'timetable';
        if(tab === 'oneone' && !canOpenOneOne()) tab = 'timetable';
        if(tab === 'reports' && !canOpenReports()) tab = 'timetable';
      }
      showTab(tab);
    } catch(e){
      console.error(e);
    }
  }
  const vm = document.getElementById('viewMode');
  if(vm && ui.viewMode){
    vm.value = ui.viewMode;
    const tfWrap = document.getElementById('teacherFilter');
    if(tfWrap) tfWrap.style.display = ui.viewMode === 'teacher' ? 'inline-block' : 'none';
  }
  const tf = document.getElementById('teacherFilter');
  if(tf && ui.teacherFilter && [...tf.options].some(o => o.value === ui.teacherFilter)){
    tf.value = ui.teacherFilter;
  }
  if(ui.reportFilters && typeof ui.reportFilters === 'object'){
    REPORT_FILTERS = Object.assign(emptyReportFilters(), ui.reportFilters);
  }
  if(LAST_RESULT && (ui.viewMode || ui.teacherFilter)) renderGrid();
}

function buildFullExportObject(){
  // Bundle every in-memory working field so a JSON (or cloud) save is a full snapshot:
  // tables, quotas, breaks, accepted timetable, small group roster, every timetable variant,
  // the selected layout, the search log, the generate fingerprint, and the UI view.
  DB.smallGroupsState = LAST_SMALL_GROUPS;
  DB.timetableVariants = LAST_VARIANTS;
  DB.timetableSelectedIndex = LAST_VARIANTS.indexOf(LAST_RESULT);
  DB.lastResult = LAST_RESULT;
  DB.searchLog = LAST_SEARCH_LOG;
  DB.searchOverview = LAST_SEARCH_OVERVIEW;
  DB.scheduleFingerprint = LAST_FINGERPRINT;
  DB.uiState = collectUiState();
  DB.oneToOneState = LAST_ONEONE;
  DB.rpianoState = LAST_RPIANO;
  return DB;
}

function restoreFromLoadedObject(loaded){
  const missing = REQUIRED_DB_KEYS.filter(k => !(k in loaded));
  if(missing.length){
    throw new Error('This data is missing: ' + missing.join(', ') + ' — it doesn\'t look like a BartokKonzi database export.');
  }
  DB = loaded;
  if(!DB.rpiano && DB.rjPiano) DB.rpiano = DB.rjPiano;
  if(!DB.rpianoState && DB.rjPianoState) DB.rpianoState = DB.rjPianoState;
  function migrateRpianoItem(it){
    if(!it) return;
    if(it.source === 'rjpiano') it.source = 'rpiano';
    if(it.kind === 'rjpiano') it.kind = 'rpiano';
    if(typeof it.lessonId === 'string' && it.lessonId.indexOf('RJP-') === 0){
      it.lessonId = 'RP-' + it.lessonId.slice(4);
    }
  }
  function migrateRpianoState(st){
    if(!st) return;
    (st.scheduled || []).forEach(migrateRpianoItem);
    (st.acceptedSchedule || []).forEach(migrateRpianoItem);
    (st.unresolved || []).forEach(u => migrateRpianoItem(u && (u.lesson || u)));
    (st.variants || []).forEach(v => migrateRpianoState(v));
  }
  migrateRpianoState(DB.rpianoState);
  (DB.acceptedSchedule || []).forEach(migrateRpianoItem);
  (DB.timetableVariants || []).forEach(v => (v.scheduled || []).forEach(migrateRpianoItem));
  if(DB.lastResult && DB.lastResult.scheduled) DB.lastResult.scheduled.forEach(migrateRpianoItem);
  DB.smallGroupQuotas = DB.smallGroupQuotas || [];
  DB.phase1TeacherOrder = normalizePhase1TeacherOrder(DB.phase1TeacherOrder);
  DB.forbidUnlistedGroupGaps = !!DB.forbidUnlistedGroupGaps;
  DB.lookaheadEveryLayout = !!DB.lookaheadEveryLayout;
  DB.teacherSwapProbe = !!DB.teacherSwapProbe;
  DB.breaks = DB.breaks || []; // older exports may not have this yet
  DB.refRooms = DB.refRooms || [];
  normalizeDbRooms(DB);
  DB.acceptedSchedule = DB.acceptedSchedule || [];
  DB.oneToOne = DB.oneToOne || {columns: [], hours: {}};
  DB.rpiano = DB.rpiano || {columns: [], hours: {}};
  LAST_ONEONE = DB.oneToOneState || LAST_ONEONE || null;
  LAST_RPIANO = DB.rpianoState || LAST_RPIANO || null;
  renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderRefTables(); renderBreaksTable();

  // Restore the small group roster exactly as it was when saved.
  LAST_SMALL_GROUPS = normalizeSmallGroupsState(DB.smallGroupsState || null);
  if(LAST_SMALL_GROUPS){
    renderSmallGroupsResults(LAST_SMALL_GROUPS);
  }
  else {
    const smallGroupsPanel = document.getElementById('smallGroupsResultsPanel');
    const exclPanel = document.getElementById('smallGroupsExcludedPanel');
    const stats = document.getElementById('smallGroupsStatsRow');
    if(smallGroupsPanel) smallGroupsPanel.style.display = 'none';
    if(exclPanel) exclPanel.style.display = 'none';
    if(stats) stats.style.display = 'none';
  }

  LAST_FINGERPRINT = DB.scheduleFingerprint || null;
  LAST_SEARCH_OVERVIEW = Array.isArray(DB.searchOverview) ? DB.searchOverview.slice() : [];
  LAST_SEARCH_LOG = Array.isArray(DB.searchLog) ? DB.searchLog.slice() : [];
  SearchLog.lines = LAST_SEARCH_LOG.slice();

  // Restore every timetable solution that was on screen, and re-select whichever one
  // was active, instead of forcing a fresh "Generate timetable" click.
  if(Array.isArray(DB.timetableVariants) && DB.timetableVariants.length){
    LAST_VARIANTS = DB.timetableVariants;
    const idx = Number.isInteger(DB.timetableSelectedIndex) ? DB.timetableSelectedIndex : 0;
    LAST_RESULT = LAST_VARIANTS[idx] || LAST_VARIANTS[0] || DB.lastResult || null;
    populateVariantSelector();
    if(LAST_VARIANTS.length > 1) document.getElementById('variantSelect').value = String(Math.max(0, idx));
    if(LAST_RESULT) renderResults(LAST_RESULT);
  } else if(DB.lastResult && Array.isArray(DB.lastResult.scheduled)){
    LAST_RESULT = DB.lastResult;
    LAST_VARIANTS = [LAST_RESULT];
    populateVariantSelector();
    renderResults(LAST_RESULT);
  } else {
    LAST_RESULT = null;
    LAST_VARIANTS = [];
    document.getElementById('resultsPanel').style.display = 'none';
    document.getElementById('unresolvedPanel').style.display = 'none';
    document.getElementById('statsRow').style.display = 'none';
    document.getElementById('variantRow').style.display = 'none';
  }
  renderAcceptedStatus();
  renderAcceptedSchedule();
  showLogForSelected();
  applyUiState(DB.uiState);
  updateFixedPinsBanner();
  updatePhase1TeacherOrderBtn();
  syncForbidUnlistedGroupGapsCheckbox();
  syncLookaheadEveryLayoutCheckbox();
  syncTeacherSwapProbeCheckbox();
  renderOneOneTab();
  renderRpianoTab();
}

document.getElementById('exportDbBtn').addEventListener('click', () => {
  downloadFile('bartokkonzi_database.json', JSON.stringify(buildFullExportObject(), null, 1), 'application/json');
  markWorkClean();
});
document.getElementById('importDbInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      restoreFromLoadedObject(JSON.parse(reader.result));
      markWorkClean();
      alert('Database loaded — tables, smallGroups, timetable, search log, quotas, and UI state were all restored exactly as saved.');
    } catch(err){
      alert('Could not read that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- Google Sheets / original Drive workbook ----------
// The seed was typed up from a multi-tab spreadsheet (STUDENTS, LESSON, CLASS_CONST,
// TEACHER_ID, …). People still keep that workbook as the source of truth. This reads
// it either live (public "anyone with the link" Sheets URL via the gviz JSONP API —
// no Google Cloud project needed) or from File → Download → .xlsx.
const SHEETS_URL_KEY = 'bartok_jazz_planner_sheets_url';
const DEFAULT_SHEETS_URL = 'https://docs.google.com/spreadsheets/d/1VmcZq9AyYb-c3iYHSv0Q8Lh90UwnceAxaQvy6lfJyXU/edit?usp=sharing';
const SHEET_ALIASES = {
  students: ['STUDENTS','STUDENT'],
  lessons: ['LESSONS','LESSON','LESSON GROUPS','LESSON_GROUPS'],
  teacherAvail: ['TEACHER_CONST','TEACHER availability','TEACHER AVAILABILITY','TEACHER_AVAILABILITY','TAVAIL'],
  classAvail: ['CLASS_CONST','CLASS RESERVATIONS','CLASS_RESERVATIONS','CAVAIL'],
  breaks: ['BREAK_MANAGEMENT','BREAK MANAGEMENT','BREAKS'],
  refTeachers: ['TEACHERS','TEACHER_ID','TEACHERID'],
  refClasses: ['CLASS','CLASSID','CLASS_ID','CLASSES'],
  refGroups: ['GROUPS','GROUP','GROUP_ID'],
  refInstruments: ['INSTR','INSTRUMENTS','INSTR_ID'],
  refRooms: ['ROOMS','ROOM','ROOM_ID'],
  smallGroupQuotas: ['SMALLGR_QUOTAS','SMALLGRQUOTAS','SMALLGR_QUOTA','SMALL_GROUP_QUOTAS','SMALL GROUP QUOTAS'],
  smallGroups: ['SMALL_GROUPS','SMALL GROUPS','SMALLGROUPS','SMALL_GROUP','SMALLGROUP'],
  oneToOne: ['1_1','1/1','ONE_TO_ONE','ONETOONE','ONEONE','1 1'],
  rpiano: ['rpiano','RPiano','RPIANO','RP_PIANO','RP PIANO','rjpiano','RJPiano','JRPiano','JRPIANO','JR_PIANO','JR PIANO','RJPIANO','RJ_PIANO','RJ PIANO','REQUIRED JAZZ PIANO','JAZZ REQUIRED PIANO','JAZZ PIANO'],
  acceptedSchedule: ['ACCEPTED_SCHEDULE','ACCEPTED SCHEDULE','ACCEPTED','SCHEDULE'],
};
const GROUP_NAME_FIELDS = [
  {name:'IMPR', id:'IMPR_ID', type:'IMPR'},
  {name:'VOC', id:'VOC_ID', type:'VOC'},
  {name:'JTH', id:'JTH_ID', type:'JAZZTHEO'},
  {name:'SOLF', id:'SOLF_ID', type:'SOLF'},
  {name:'JHIST', id:'JHIST_ID', type:'JAZZHIS'},
  {name:'RHIMPR', id:'RHIMPR_ID', type:'RHYTHM'},
  {name:'AC', id:'AC_ID', type:'AC'},
];

function setSheetsStatus(text, isError){
  const el = document.getElementById('sheetsStatus');
  if(!el) return;
  el.textContent = text;
  el.style.color = isError ? '#e0576b' : '';
}
function normHeader(h){
  return String(h == null ? '' : h).trim().toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'');
}
function cleanCellText(s){
  const t = String(s == null ? '' : s).trim();
  if(!t || t === '#N/A' || t === '#NA' || t === '#REF!' || t === '#VALUE!' || t === '#DIV/0!') return '';
  return t;
}
function gvizDateToTime(v){
  const m = /^Date\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(String(v == null ? '' : v));
  if(!m) return '';
  return String(m[4]).padStart(2,'0') + ':' + String(m[5]).padStart(2,'0');
}
function gvizTimeOfDay(v){
  if(!Array.isArray(v) || v.length < 2) return '';
  const h = Number(v[0]), m = Number(v[1]);
  if(!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return '';
  return String(h).padStart(2,'0') + ':' + String(Math.floor(m)).padStart(2,'0');
}
function cellStr(c){
  if(c == null) return '';
  if(typeof c !== 'object'){
    return gvizDateToTime(c) || gvizTimeOfDay(c) || cleanCellText(c);
  }
  const fromV = gvizDateToTime(c.v) || gvizTimeOfDay(c.v);
  if(fromV) return fromV;
  if(c.f != null && String(c.f).trim() !== '') return cleanCellText(c.f);
  if(c.v == null) return '';
  return cleanCellText(c.v);
}
function isBlankHeader(h){
  const n = normHeader(h);
  return !n || n === 'EMPTY' || /^EMPTY_\d+$/.test(n);
}
const ID_PAIR_PARENTS = new Set(['INSTR','CLASS','IMPR','VOC','JTH','SOLF','JHIST','RHIMPR','AC','TEACHER','GROUP']);
function inferHeaders(labels, colTypes, sheetKey){
  const out = labels.map(h => isBlankHeader(h) ? '' : normHeader(h));
  if(!out[0]) out[0] = 'ID';
  for(let i=1;i<out.length;i++){
    const prev = out[i-1];
    const typ = (colTypes && colTypes[i]) || '';
    if(sheetKey === 'refClasses' && !out[i] && (prev === 'CLASS' || prev === 'CLASS_ID' || prev === 'CLASSID' || prev === 'ID' || prev === 'NAME')){
      out[i] = 'MUCLASS_TYPE';
      continue;
    }
    if(sheetKey === 'smallGroups' && !out[i] && prev === 'TEACHER_ID'){
      out[i] = 'DURATION_MIN';
      continue;
    }
    if(sheetKey === 'smallGroups' && !out[i] && (prev === 'CLASS' || prev === 'CLASS_ID')){
      out[i] = 'MUCLASS_TYPE';
      continue;
    }
    if(ID_PAIR_PARENTS.has(prev) && (!out[i] || out[i] === 'GROUP_ID')){
      out[i] = prev + '_ID';
      continue;
    }
    if(out[i]) continue;
    if(sheetKey === 'classAvail' && !out[i] && prev === 'DAY'){
      const later = out.slice(i + 1);
      out[i] = later.some(h => h === 'START') ? 'L_STAR' : 'START';
      continue;
    }
    if(sheetKey === 'classAvail' && !out[i] && (prev === 'L_STAR' || prev === 'L_START' || prev === 'LSTAR')){
      out[i] = 'L_END';
      continue;
    }
    if(sheetKey === 'classAvail' && !out[i] && (prev === 'L_END' || prev === 'LEND')){
      out[i] = 'START';
      continue;
    }
    if(prev === 'FIXED_DAY' || prev === 'FIXEDDAY' || prev === 'PIN_DAY'){
      out[i] = 'FIXED_START';
      continue;
    }
    if(prev === 'FIXED_START' || prev === 'FIXEDSTART' || prev === 'PIN_START'){
      out[i] = 'FIXED_END';
      continue;
    }
    if(prev === 'SCHEDULED_DAY'){
      out[i] = 'SCHEDULED_START';
      continue;
    }
    if(prev === 'SCHEDULED_START'){
      out[i] = 'SCHEDULED_END';
      continue;
    }
    if(typ === 'datetime' || typ === 'timeofday' || prev === 'DAY' || prev === 'START'){
      out[i] = prev === 'START' ? 'END' : 'START';
      continue;
    }
    if(sheetKey === 'lessons' && (prev === 'TEACHER_ID' || prev === 'DURATION_MIN')){
      out[i] = prev === 'TEACHER_ID' ? 'DURATION_MIN' : 'ROOM_LOCK';
      continue;
    }
    if(sheetKey === 'smallGroupQuotas' && (prev === 'TEACHER_ID' || prev === 'TEACHER')){
      out[i] = 'SMALLGR_AMOUNT';
      continue;
    }
    if(sheetKey === 'teacherAvail' && !out[i] && prev === 'TYPE'){
      out[i] = 'SCOPE';
      continue;
    }
  }
  return out;
}
function sheetLooksLike(key, rows){
  if(!rows || !rows.length) return false;
  const headers = Object.keys(rows[0]);
  const has = (...ns) => ns.some(n => headers.includes(normHeader(n)));
  if(key === 'students') return has('NAME1');
  if(key === 'lessons') return !has('SMALL_GROUP_ID') && (has('LESSON_ID') || has('DURATION_MIN') || has('LESSON_NAME'));
  if(key === 'smallGroups') return has('SMALL_GROUP_ID') || (has('ROLE') && (has('SMALL_GROUP') || has('STUDENT_ID')));
  if(key === 'teacherAvail') return has('DAY') && has('TYPE');
  if(key === 'classAvail') return has('DAY') && has('START') && (has('CLASS') || has('CLASSID') || has('CLASS_ID'));
  if(key === 'breaks') return has('BREAK_MIN') || has('BREAK_ID') || has('BREAK_COUNT');
  if(key === 'refTeachers') return has('NAME') && (has('ID') || has('TEACHER_ID')) && !has('NAME1') && !has('DAY');
  if(key === 'refClasses') return has('MUCLASS_TYPE') || has('JCLASS_TYPE') || has('JCLASS') || (has('CLASS') && (has('CLASS_ID') || has('CLASSID')) && !has('NAME1'));
  if(key === 'refGroups') return has('TYPE') && has('NAME') && !has('NAME1') && !has('INSTR');
  if(key === 'refInstruments') return has('INSTR') && has('TYPE') && !has('NAME1');
  if(key === 'refRooms') return (has('ROOM_ID') || (has('ROOM') && (has('ID') || has('NAME')))) && !has('NAME1') && !has('DAY') && !has('DURATION_MIN') && !has('LESSON_ID') && !has('SMALL_GROUP_ID') && !has('ROLE');
  if(key === 'smallGroupQuotas') return has('SMALLGRQUOTA_ID') || has('SMGQ_ID') || has('SMALLGR_AMOUNT') || has('SMALLGR_QUOTA');
  if(key === 'oneToOne' || key === 'rpiano') return has('NAME1') && has('INSTR') && !has('CLASS_ID') && !has('CLASSID') && !has('IMPR') && !has('IMPR_ID');
  if(key === 'acceptedSchedule') return has('STATUS') && (has('STUDENTS') || has('STUDENT_IDS')) && (has('LESSON_ID') || has('KIND'));
  return true;
}
function rowGet(row, ...aliases){
  for(const a of aliases){
    const k = normHeader(a);
    if(row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}
function lookupRoomId(v, rById, rByName){
  if(!v) return '';
  const k = String(v).trim().toLowerCase();
  if(rById && rById[k]) return rById[k].id;
  if(rByName && rByName[k]) return rByName[k].id;
  return '';
}
function roomFieldsFromValue(raw, rById, rByName){
  const v = cleanCellText(raw);
  const roomId = lookupRoomId(v, rById, rByName);
  if(!roomId) return { roomId: '', room: '' };
  return { roomId, room: resolveName(rById, roomId, v) };
}
function parseRoomAssignment(row, rById, rByName){
  const idRaw = rowGet(row, 'ROOM_ID');
  const nameRaw = rowGet(row, 'ROOM', 'ROOM_LOCK', 'ROOMLOCK', 'ROOM_NAME');
  const fromId = roomFieldsFromValue(idRaw, rById, rByName);
  if(fromId.roomId) return fromId;
  return roomFieldsFromValue(nameRaw, rById, rByName);
}
function isMatrixRoomLockId(v){
  const n = normHeader(v);
  return n === 'ROOM' || n === 'ROOM_LOCK' || n === 'ROOMLOCK' || n === 'ROOM_ID' || n === 'ROOM_NAME';
}
function normDay(v){
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if(!s) return '';
  if(DAYS.includes(s)) return s;
  const map = {
    MONDAY:'MON', MON:'MON', HETFO:'MON', 'HÉTFŐ':'MON',
    TUESDAY:'TUE', TUE:'TUE', TUES:'TUE', KEDD:'TUE',
    WEDNESDAY:'WED', WED:'WED', SZERDA:'WED',
    THURSDAY:'THU', THU:'THU', THUR:'THU', THURS:'THU', CSUTORTOK:'THU', 'CSÜTÖRTÖK':'THU',
    FRIDAY:'FRI', FRI:'FRI', PENTEK:'FRI', 'PÉNTEK':'FRI',
  };
  const compact = s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z]/g,'');
  return map[s] || map[compact] || '';
}
function looksLikeTime(v){ return /^\d{1,2}[:.]\d{2}/.test(String(v == null ? '' : v).trim()); }
function normTime(v){
  const s = String(v == null ? '' : v).trim();
  if(!s) return '';
  const fromGviz = gvizDateToTime(s);
  if(fromGviz) return fromGviz;
  const m = /(\d{1,2})[:.](\d{2})/.exec(s);
  if(!m) return s;
  return String(parseInt(m[1],10)).padStart(2,'0') + ':' + m[2];
}
function rowsFromObjects(objs){
  return (objs || []).map(o => {
    const n = {};
    Object.keys(o).forEach(k => { n[normHeader(k)] = o[k] == null ? '' : String(o[k]).trim(); });
    return n;
  }).filter(r => Object.values(r).some(v => v !== ''));
}
function parseSpreadsheetId(url){
  const raw = String(url || '').trim();
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if(m) return m[1];
  if(/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  return null;
}
function parseGvizTable(resp, sheetKey){
  if(!resp || resp.status === 'error'){
    const msg = resp && resp.errors && resp.errors[0] ? (resp.errors[0].message || resp.errors[0].reason) : 'sheet error';
    throw new Error(msg);
  }
  const table = resp.table;
  if(!table) return [];
  const cols = table.cols || [];
  let labels = cols.map(c => (c && c.label != null) ? String(c.label).trim() : '');
  let dataRows = table.rows || [];
  const letterish = labels.every((l,i) => !l || l === String.fromCharCode(65 + i));
  if(letterish && dataRows.length){
    labels = (dataRows[0].c || []).map(c => cellStr(c) || '');
    dataRows = dataRows.slice(1);
  }
  const colTypes = cols.map(c => (c && c.type) || '');
  const headers = inferHeaders(labels, colTypes, sheetKey);
  return dataRows.map(r => {
    const row = {};
    headers.forEach((h,i) => {
      if(!h) return;
      row[h] = cellStr((r.c || [])[i]);
    });
    return row;
  }).filter(r => Object.values(r).some(v => v !== ''));
}
function fetchGvizSheet(spreadsheetId, sheetName, sheetKey){
  return new Promise((resolve, reject) => {
    const cb = '__bjpSheet_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out loading “'+sheetName+'”')); }, 20000);
    function cleanup(){
      clearTimeout(timer);
      try { delete window[cb]; } catch(e){ window[cb] = undefined; }
      if(script.parentNode) script.parentNode.removeChild(script);
    }
    window[cb] = function(resp){
      cleanup();
      try { resolve(parseGvizTable(resp, sheetKey)); }
      catch(err){ reject(err); }
    };
    script.onerror = () => { cleanup(); reject(new Error('Could not reach Google Sheets')); };
    const q = new URLSearchParams({
      tqx: 'out:json;responseHandler:'+cb,
      sheet: sheetName,
      headers: (sheetKey === 'oneToOne' || sheetKey === 'rpiano') ? '1' : '0',
      tq: 'select *'
    });
    script.src = 'https://docs.google.com/spreadsheets/d/'+spreadsheetId+'/gviz/tq?'+q.toString();
    document.body.appendChild(script);
  });
}
async function loadTablesFromSheetsUrl(spreadsheetId){
  const tables = {};
  const found = [];
  const missing = [];
  for(const [key, aliases] of Object.entries(SHEET_ALIASES)){
    let rows = null, used = '';
    for(const name of aliases){
      try {
        const got = await fetchGvizSheet(spreadsheetId, name, key);
        if(!sheetLooksLike(key, got)) continue;
        rows = got;
        used = name;
        break;
      } catch(e){
        // try next tab name
      }
    }
    if(rows){
      tables[key] = rows;
      found.push(used);
    } else {
      missing.push(key);
    }
  }
  if(!found.length){
    throw new Error('No matching tabs found. Share the workbook as “Anyone with the link → Viewer”, or upload an .xlsx. Expected DATABASE_2627 tabs: STUDENTS, TEACHER_CONST, CLASS_CONST, LESSONS, SMALL_GROUPS, SMALLGR_QUOTAS, 1_1, rpiano, TEACHERS, BREAK_MANAGEMENT, CLASS, GROUPS, ROOMS, INSTR.');
  }
  return {tables, found, missing};
}
function loadXlsxLib(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('Spreadsheet parser failed to load'));
    s.onerror = () => reject(new Error('Could not load the spreadsheet parser (need a network connection for the first .xlsx import)'));
    document.head.appendChild(s);
  });
}
function matchSheetKey(name){
  const n = normHeader(name);
  for(const [key, aliases] of Object.entries(SHEET_ALIASES)){
    if(n === normHeader(key) || aliases.some(a => normHeader(a) === n)) return key;
  }
  return null;
}
async function loadTablesFromXlsx(file){
  const XLSX = await loadXlsxLib();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const tables = {};
  const found = [];
  wb.SheetNames.forEach(name => {
    const key = matchSheetKey(name);
    if(!key) return;
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], {header:1, raw:false, defval:''});
    if(!matrix.length) return;
    const headers = inferHeaders(matrix[0].map(x => String(x == null ? '' : x)), null, key);
    const rows = matrix.slice(1).map(arr => {
      const row = {};
      headers.forEach((h,i) => { if(h) row[h] = cleanCellText(arr[i]); });
      return row;
    }).filter(r => Object.values(r).some(v => v !== ''));
    if(rows.length && !sheetLooksLike(key, rows)) return;
    tables[key] = rows;
    found.push(name);
  });
  const missing = Object.keys(SHEET_ALIASES).filter(k => !tables[k]);
  if(!found.length){
    throw new Error('No matching tabs in that workbook. Found: '+(wb.SheetNames.join(', ') || 'none')+'. Expected STUDENTS, LESSON, TEACHER availability, CLASS_CONST, …');
  }
  return {tables, found, missing};
}
function lookupMapBy(list, field){
  const m = {};
  (list || []).forEach(r => {
    const k = String(r[field] || '').trim().toLowerCase();
    if(k) m[k] = r;
  });
  return m;
}
function resolveId(byId, byName, idVal, nameVal){
  if(idVal && byId[idVal.toLowerCase()]) return byId[idVal.toLowerCase()].id;
  if(nameVal && byName[nameVal.toLowerCase()]) return byName[nameVal.toLowerCase()].id;
  return idVal || '';
}
function resolveName(byId, idVal, nameVal){
  if(idVal && byId[idVal.toLowerCase()]) return byId[idVal.toLowerCase()].name;
  return nameVal || '';
}
function nextId(prefix, rows, field){
  const nums = (rows || []).map(r => parseInt(String(r[field] || '').replace(prefix,''), 10)).filter(n => n > 0);
  return prefix + ((nums.length ? Math.max(...nums) : 0) + 1);
}
function nextQuotaId(rows){
  const nums = (rows || []).map(r => {
    const m = /^SMGQ(\d+)$/i.exec(String(r.id || '').trim());
    return m ? parseInt(m[1], 10) : 0;
  }).filter(n => n > 0);
  return 'SMGQ' + ((nums.length ? Math.max(...nums) : 0) + 1);
}

function sheetsTablesToDb(tables){
  const keep = [];
  function take(key){
    if(tables[key] && tables[key].length) return tables[key];
    if(DB[key] && DB[key].length){
      keep.push(key);
      return JSON.parse(JSON.stringify(DB[key]));
    }
    return [];
  }

  let refTeachers = (tables.refTeachers && tables.refTeachers.length)
    ? tables.refTeachers.map((r,i) => ({
        id: rowGet(r,'ID','TEACHER_ID'),
        name: rowGet(r,'NAME','TEACHER')
      })).filter(r => r.id || r.name)
    : take('refTeachers');
  refTeachers.forEach((r,i) => { if(!r.id) r.id = nextId('TEAC', refTeachers, 'id'); });

  let refClasses = (tables.refClasses && tables.refClasses.length)
    ? tables.refClasses.map(r => {
        const name = rowGet(r,'NAME','CLASS');
        const explicit = rowGet(r,'MUCLASS_TYPE','JCLASS_TYPE','JCLASS','YEAR','GRADE');
        const fromName = (/^(\d+)/.exec(name) || [])[1] || '';
        return {
          id: rowGet(r,'ID','CLASS_ID','CLASSID'),
          name,
          muclass: explicit || fromName
        };
      }).filter(r => r.id || r.name)
    : take('refClasses');
  refClasses.forEach(r => { if(!r.id) r.id = nextId('CL', refClasses, 'id'); });

  let refGroups = (tables.refGroups && tables.refGroups.length)
    ? tables.refGroups.map(r => ({
        id: rowGet(r,'ID','GROUP_ID'),
        name: rowGet(r,'NAME','GROUP'),
        type: rowGet(r,'TYPE')
      })).filter(r => r.id || r.name)
    : take('refGroups');
  refGroups.forEach(r => { if(!r.id) r.id = nextId('GR', refGroups, 'id'); });

  let refInstruments = (tables.refInstruments && tables.refInstruments.length)
    ? tables.refInstruments.map(r => ({
        id: rowGet(r,'ID','INSTR_ID'),
        name: rowGet(r,'NAME','INSTR','INSTRUMENT'),
        type: rowGet(r,'TYPE')
      })).filter(r => r.id || r.name)
    : take('refInstruments');
  refInstruments.forEach(r => { if(!r.id) r.id = nextId('INST', refInstruments, 'id'); });

  let refRooms;
  if(tables.refRooms && tables.refRooms.length){
    refRooms = tables.refRooms.map((r,i) => ({
      id: rowGet(r,'ROOM_ID','ID') || ('ROOM'+(i+1)),
      name: rowGet(r,'ROOM','NAME')
    })).filter(r => r.id || r.name);
  } else if(tables.refRooms){
    refRooms = [];
  } else {
    refRooms = take('refRooms');
  }

  const tById = lookupMapBy(refTeachers, 'id');
  const tByName = lookupMapBy(refTeachers, 'name');
  const cById = lookupMapBy(refClasses, 'id');
  const cByName = lookupMapBy(refClasses, 'name');
  const gById = lookupMapBy(refGroups, 'id');
  const gByName = lookupMapBy(refGroups, 'name');
  const iById = lookupMapBy(refInstruments, 'id');
  const iByName = lookupMapBy(refInstruments, 'name');
  const rById = lookupMapBy(refRooms, 'id');
  const rByName = lookupMapBy(refRooms, 'name');

  let students;
  if(tables.students && tables.students.length){
    students = tables.students.map((r,i) => {
      const s = {
        ID: rowGet(r,'ID','STUDENT_ID') || ('ST'+(i+1)),
        NAME1: rowGet(r,'NAME1'), NAME2: rowGet(r,'NAME2'), NAME3: rowGet(r,'NAME3'),
        PUBLIC_NAME: rowGet(r,'PUBLIC_NAME'),
        INSTR: rowGet(r,'INSTR','INSTRUMENT'), INSTR_ID: rowGet(r,'INSTR_ID'),
        CLASS: rowGet(r,'CLASS'), CLASS_ID: rowGet(r,'CLASS_ID'),
        IMPR: rowGet(r,'IMPR'), IMPR_ID: rowGet(r,'IMPR_ID'),
        VOC: rowGet(r,'VOC'), VOC_ID: rowGet(r,'VOC_ID'),
        JTH: rowGet(r,'JTH'), JTH_ID: rowGet(r,'JTH_ID'),
        SOLF: rowGet(r,'SOLF'), SOLF_ID: rowGet(r,'SOLF_ID'),
        JHIST: rowGet(r,'JHIST'), JHIST_ID: rowGet(r,'JHIST_ID'),
        RHIMPR: rowGet(r,'RHIMPR'), RHIMPR_ID: rowGet(r,'RHIMPR_ID'),
        AC: rowGet(r,'AC'), AC_ID: rowGet(r,'AC_ID'),
      };
      s.INSTR_ID = resolveId(iById, iByName, s.INSTR_ID, s.INSTR);
      s.INSTR = resolveName(iById, s.INSTR_ID, s.INSTR);
      s.CLASS_ID = resolveId(cById, cByName, s.CLASS_ID, s.CLASS);
      s.CLASS = resolveName(cById, s.CLASS_ID, s.CLASS);
      GROUP_NAME_FIELDS.forEach(f => {
        const typed = refGroups.filter(g => !f.type || g.type === f.type);
        const idMap = lookupMapBy(typed.length ? typed : refGroups, 'id');
        const nameMap = lookupMapBy(typed.length ? typed : refGroups, 'name');
        s[f.id] = resolveId(idMap, nameMap, s[f.id], s[f.name]) || s[f.id];
        s[f.name] = resolveName(gById, s[f.id], s[f.name]);
      });
      return s;
    });
  } else {
    students = take('students');
  }
  if(!students.length) throw new Error('No STUDENTS rows found.');

  let lessons;
  if(tables.lessons && tables.lessons.length){
    lessons = tables.lessons.map((r,i) => {
      const group = rowGet(r,'GROUP');
      const groupId = resolveId(gById, gByName, rowGet(r,'GROUP_ID'), group);
      const teacher = rowGet(r,'TEACHER');
      const teacherId = resolveId(tById, tByName, rowGet(r,'TEACHER_ID'), teacher);
      const room = parseRoomAssignment(r, rById, rByName);
      return {
        id: rowGet(r,'LESSON_ID','ID') || ('LES'+(i+1)),
        name: rowGet(r,'NAME','LESSON_NAME','LESSON'),
        group: resolveName(gById, groupId, group),
        groupId,
        teacher: resolveName(tById, teacherId, teacher),
        teacherId,
        duration: parseInt(rowGet(r,'DURATION_MIN','DURATION'),10) || 90,
        roomId: room.roomId,
        room: room.room,
        fixedDay: normDay(rowGet(r,'FIXED_DAY','FIXEDDAY','PIN_DAY')),
        fixedStart: normTime(rowGet(r,'FIXED_START','FIXEDSTART','PIN_START')),
        fixedEnd: normTime(rowGet(r,'FIXED_END','FIXEDEND','PIN_END')),
        scheduledDay: normDay(rowGet(r,'SCHEDULED_DAY')),
        scheduledStart: normTime(rowGet(r,'SCHEDULED_START')),
        scheduledEnd: normTime(rowGet(r,'SCHEDULED_END')),
      };
    });
  } else {
    lessons = take('lessons');
  }

  let teacherAvail;
  if(tables.teacherAvail && tables.teacherAvail.length){
    teacherAvail = tables.teacherAvail.map(r => {
      const teacher = rowGet(r,'TEACHER','NAME');
      const teacherId = resolveId(tById, tByName, rowGet(r,'TEACHER_ID'), teacher);
      const type = (rowGet(r,'TYPE') || 'AVAILABLE').toUpperCase();
      return {
        teacher: resolveName(tById, teacherId, teacher),
        teacherId,
        day: normDay(rowGet(r,'DAY')),
        start: normTime(rowGet(r,'START') || (looksLikeTime(rowGet(r,'DAY_ID')) ? rowGet(r,'DAY_ID') : '')),
        end: normTime(rowGet(r,'END')),
        type: TYPE_OPTIONS.includes(type) ? type : 'AVAILABLE',
        scope: normalizeAvailScope(rowGet(r,'SCOPE','USE','FOR','USAGE','SLOT')),
        option: rowGet(r,'OPTION','NOTE'),
      };
    }).filter(r => r.teacherId || r.teacher);
  } else {
    teacherAvail = take('teacherAvail');
  }

  let classAvail;
  if(tables.classAvail && tables.classAvail.length){
    classAvail = tables.classAvail.map(r => {
      const cls = rowGet(r,'CLASS','NAME');
      const classId = resolveId(cById, cByName, rowGet(r,'CLASS_ID','CLASSID'), cls);
      return {
        class: resolveName(cById, classId, cls),
        classId,
        day: normDay(rowGet(r,'DAY')),
        lStar: rowGet(r,'L_STAR','LSTAR','L_START','LSTART','LESSON_START'),
        lEnd: rowGet(r,'L_END','LEND','LESSON_END'),
        start: normTime(rowGet(r,'START')),
        end: normTime(rowGet(r,'END')),
        avail: rowGet(r,'AVAIL','AVAILABLE'),
        note: rowGet(r,'NOTE','OPTION'),
      };
    }).filter(r => (r.classId || r.class) && r.day && (r.start || r.end));
  } else {
    classAvail = take('classAvail');
  }

  let breaks;
  if(tables.breaks && tables.breaks.length){
    breaks = tables.breaks.map((r,i) => {
      const teacher = rowGet(r,'NAME','TEACHER');
      const teacherId = resolveId(tById, tByName, rowGet(r,'TEACHER_ID'), teacher);
      return {
        id: rowGet(r,'BREAK_ID','ID','BRID') || ('BRID'+(i+1)),
        teacherId,
        teacher: resolveName(tById, teacherId, teacher),
        breakMinutes: parseInt(rowGet(r,'BREAK_MIN','BREAKMIN','MINUTES'),10) || 0,
        breakCount: parseInt(rowGet(r,'BREAK_COUNT','BREAKCOUNT','COUNT'),10) || 0,
      };
    }).filter(r => r.teacherId || r.teacher);
  } else if(tables.breaks){
    breaks = [];
  } else {
    breaks = take('breaks');
  }

  let smallGroupQuotas;
  if(tables.smallGroupQuotas && tables.smallGroupQuotas.length){
    smallGroupQuotas = tables.smallGroupQuotas.map((r,i) => {
      const teacher = rowGet(r,'NAME','TEACHER');
      const teacherId = resolveId(tById, tByName, rowGet(r,'TEACHER_ID'), teacher);
      return {
        id: rowGet(r,'SMALLGRQUOTA_ID','SMGQ_ID','ID') || ('SMGQ'+(i+1)),
        teacherId,
        teacher: resolveName(tById, teacherId, teacher),
        amount: parseInt(rowGet(r,'SMALLGR_AMOUNT','SMALLGR_QUOTA','AMOUNT','QUOTA'),10) || 0,
      };
    }).filter(r => r.teacherId || r.teacher);
  } else if(tables.smallGroupQuotas){
    smallGroupQuotas = [];
  } else {
    smallGroupQuotas = take('smallGroupQuotas');
  }

  let oneToOne;
  if(tables.oneToOne && tables.oneToOne.length){
    oneToOne = mergeMatrixColumnRooms(parseOneToOneTable(tables.oneToOne, refTeachers, refRooms), DB.oneToOne);
  } else if(DB.oneToOne && (DB.oneToOne.columns || DB.oneToOne.hours)){
    keep.push('oneToOne');
    oneToOne = JSON.parse(JSON.stringify(DB.oneToOne));
  } else {
    oneToOne = {columns: [], hours: {}};
  }

  let rpiano;
  if(tables.rpiano && tables.rpiano.length){
    rpiano = mergeMatrixColumnRooms(parseOneToOneTable(tables.rpiano, refTeachers, refRooms), DB.rpiano);
  } else if(DB.rpiano && (DB.rpiano.columns || DB.rpiano.hours)){
    keep.push('rpiano');
    rpiano = JSON.parse(JSON.stringify(DB.rpiano));
  } else {
    rpiano = {columns: [], hours: {}};
  }

  let acceptedSchedule;
  if(tables.acceptedSchedule && tables.acceptedSchedule.length){
    acceptedSchedule = tables.acceptedSchedule.map(r => ({
      lessonId: rowGet(r,'LESSON_ID','ID'),
      name: rowGet(r,'NAME','LESSON_NAME','LESSON'),
      kind: rowGet(r,'KIND') || (isSmallGroupId(rowGet(r,'LESSON_ID')) ? 'smallgroup' : 'lesson'),
      group: rowGet(r,'GROUP'),
      groupId: rowGet(r,'GROUP_ID'),
      teacher: rowGet(r,'TEACHER'),
      teacherId: rowGet(r,'TEACHER_ID'),
      day: normDay(rowGet(r,'DAY')),
      start: normTime(rowGet(r,'START')),
      end: normTime(rowGet(r,'END')),
      duration: parseInt(rowGet(r,'DURATION_MIN','DURATION'),10) || '',
      ...parseRoomAssignment(r, rById, rByName),
      studentCount: parseInt(rowGet(r,'STUDENT_COUNT'),10) || 0,
      students: rowGet(r,'STUDENTS'),
      studentIds: rowGet(r,'STUDENT_IDS','STUDENT_ID'),
      status: rowGet(r,'STATUS') || 'scheduled',
      note: rowGet(r,'NOTE'),
    })).filter(r => r.lessonId || r.name);
  } else {
    acceptedSchedule = take('acceptedSchedule');
  }

  let smallGroupsState = null;
  if(tables.smallGroups && tables.smallGroups.length){
    smallGroupsState = parseSmallGroupsTable(tables.smallGroups, students, {
      refTeachers, refClasses, refRooms, tById, tByName, rById, rByName
    });
  }

  return {
    db: normalizeDbRooms({
      students, lessons, teacherAvail, classAvail,
      refTeachers, refClasses, refGroups, refInstruments, refRooms,
      smallGroupQuotas, breaks, oneToOne, rpiano,
      smallGroupsState, timetableVariants: [], lastResult: null,
      acceptedTimetable: null, acceptedSchedule, searchLog: [], searchOverview: [],
      scheduleFingerprint: null,
    }),
    keep,
  };
}

async function importFromDriveTables(loaded, sourceLabel){
  const {db, keep} = sheetsTablesToDb(loaded.tables);
  if(!dbLooksEmpty()){
    let msg = 'Replace the working tables with this Google Sheet? Small groups come from the SMALL_GROUPS tab when it is present; the current timetable is still cleared so it does not point at old IDs.';
    if(WORK_DIRTY || hasUnacceptedDrags()){
      msg = 'This tab has work that is only in the browser autosave (including any dragged times). ' + msg;
    }
    if(!confirm(msg)){
    setSheetsStatus('Load cancelled.');
    return;
    }
  }
  restoreFromLoadedObject(db);
  markWorkDirty();
  const sgN = (db.smallGroupsState && db.smallGroupsState.smallGroups || []).length;
  const bits = [
    `${db.students.length} students`,
    `${db.lessons.length} lessons`,
    `${db.teacherAvail.length} teacher-avail`,
    `${db.classAvail.length} reservations`,
    `${db.refTeachers.length} teachers`,
    sgN ? `${sgN} small groups` : 'no SMALL_GROUPS tab',
    `${collectOneOneAssignments(db.oneToOne).length} 1/1 hours`,
    `${collectOneOneAssignments(db.rpiano).length} Required Piano hours`,
  ];
  const extra = keep.length ? ` Kept existing ${keep.join(', ')} (those tabs were missing).` : '';
  const sgNote = sgN ? ' Generate small groups still available if you want a fresh roster.' : ' Small Groups were left empty — Generate still available.';
  setSheetsStatus(`✓ Loaded ${sourceLabel} — ${bits.join(', ')}. Tabs: ${loaded.found.join(', ')}.${extra} Timetable was cleared.${sgNote}`);
}

document.getElementById('sheetsLoadBtn').addEventListener('click', async () => {
  const url = document.getElementById('sheetsUrlInput').value.trim();
  const id = parseSpreadsheetId(url);
  if(!id){ setSheetsStatus('Paste a Google Sheets URL (or the spreadsheet id).', true); return; }
  try { localStorage.setItem(SHEETS_URL_KEY, url); } catch(e){ /* ignore */ }
  setSheetsStatus('Reading workbook from Google…');
  try {
    const loaded = await loadTablesFromSheetsUrl(id);
    await importFromDriveTables(loaded, 'Google Sheets');
  } catch(err){
    setSheetsStatus('Could not load that spreadsheet: ' + err.message, true);
  }
});
document.getElementById('sheetsXlsxInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if(!file) return;
  setSheetsStatus('Reading '+file.name+'…');
  try {
    const loaded = await loadTablesFromXlsx(file);
    await importFromDriveTables(loaded, file.name);
  } catch(err){
    setSheetsStatus('Could not read that file: ' + err.message, true);
  }
});

// Write the working tables back as the same DATABASE_2627 workbook the import reads:
// same tab names, same column headers. Upload the .xlsx to Drive or File → Import
// into the existing sheet — the browser cannot write the live Google Sheet itself.
const DRIVE_EXPORT_SPECS = [
  {
    key: 'students', name: 'STUDENTS',
    headers: ['STUDENT_ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID','CLASS','CLASS_ID','IMPR','IMPR_ID','VOC','VOC_ID','JTH','JTH_ID','SOLF','SOLF_ID','JHIST','JHIST_ID','RHIMPR','RHIMPR_ID','AC','AC_ID'],
    rows: (db) => (db.students || []).map(s => [
      s.ID, s.NAME1, s.NAME2, s.NAME3, s.PUBLIC_NAME,
      s.INSTR, s.INSTR_ID, s.CLASS, s.CLASS_ID,
      s.IMPR, s.IMPR_ID, s.VOC, s.VOC_ID, s.JTH, s.JTH_ID,
      s.SOLF, s.SOLF_ID, s.JHIST, s.JHIST_ID, s.RHIMPR, s.RHIMPR_ID, s.AC, s.AC_ID
    ])
  },
  {
    key: 'teacherAvail', name: 'TEACHER_CONST',
    headers: ['TEACHER','TEACHER_ID','DAY','START','END','TYPE','SCOPE','NOTE'],
    rows: (db) => (db.teacherAvail || []).map(r => [
      r.teacher, r.teacherId, r.day, exportTime(r.start), exportTime(r.end), r.type, normalizeAvailScope(r.scope), r.option
    ])
  },
  {
    key: 'classAvail', name: 'CLASS_CONST',
    headers: ['CLASS','CLASS_ID','DAY','L_STAR','L_END','START','END','AVAIL','NOTE'],
    rows: (db) => (db.classAvail || []).map(r => [
      r.class, r.classId, r.day, r.lStar || '', r.lEnd || '',
      exportTime(r.start), exportTime(r.end), r.avail || 'RESERVED', r.note
    ])
  },
  {
    key: 'lessons', name: 'LESSONS',
    headers: ['LESSON_ID','LESSON NAME','GROUP','GROUP_ID','TEACHER','TEACHER_ID','DURATION_MIN','ROOM_ID','ROOM','FIXED_DAY','FIXED_START','FIXED_END','SCHEDULED_DAY','SCHEDULED_START','SCHEDULED_END','SCHEDULED_DATA'],
    rows: (db) => (db.lessons || []).map(r => [
      r.id, r.name, r.group, r.groupId, r.teacher, r.teacherId,
      r.duration, itemRoomId(r), itemRoomLabel(r),
      r.fixedDay || '', exportTime(r.fixedStart), exportTime(r.fixedEnd),
      r.scheduledDay || '', exportTime(r.scheduledStart), exportTime(r.scheduledEnd),
      formatLessonScheduledData(r)
    ])
  },
  {
    key: 'smallGroupQuotas', name: 'SMALLGR_QUOTAS',
    headers: ['SMALLGRQUOTA_ID','TEACHER','TEACHER_ID','SMALLGR_AMOUNT'],
    rows: (db) => (db.smallGroupQuotas || []).map(r => [r.id, r.teacher, r.teacherId, r.amount])
  },
  {
    key: 'refTeachers', name: 'TEACHERS',
    headers: ['TEACHER_ID','NAME'],
    rows: (db) => (db.refTeachers || []).map(r => [r.id, r.name])
  },
  {
    key: 'breaks', name: 'BREAK_MANAGEMENT',
    headers: ['BREAK_ID','TEACHER','TEACHER_ID','BREAK_MIN','BREAK_COUNT'],
    rows: (db) => (db.breaks || []).map(r => [r.id, r.teacher, r.teacherId, r.breakMinutes, r.breakCount])
  },
  {
    key: 'refClasses', name: 'CLASS',
    headers: ['CLASS_ID','CLASS','MUCLASS_TYPE'],
    rows: (db) => (db.refClasses || []).map(r => [r.id, r.name, r.muclass])
  },
  {
    key: 'refGroups', name: 'GROUPS',
    headers: ['GROUP_ID','TYPE','NAME'],
    rows: (db) => (db.refGroups || []).map(r => [r.id, r.type, r.name])
  },
  {
    key: 'refRooms', name: 'ROOMS',
    headers: ['ROOM_ID','ROOM'],
    rows: (db) => (db.refRooms || []).map(r => [r.id, r.name])
  },
  {
    key: 'refInstruments', name: 'INSTR',
    headers: ['INSTR_ID','TYPE','INSTR'],
    rows: (db) => (db.refInstruments || []).map(r => [r.id, r.type, r.name])
  },
  {
    key: 'acceptedSchedule', name: 'ACCEPTED_SCHEDULE',
    headers: ['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_ID','ROOM','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA'],
    rows: (db) => (db.acceptedSchedule || []).map(r => [
      r.lessonId, r.name, r.kind, r.teacher, r.teacherId,
      r.day, r.start, r.end, r.duration, itemRoomId(r), itemRoomLabel(r),
      r.studentCount, r.students, r.studentIds, r.status, r.note, formatAcceptedScheduledData(r)
    ])
  },
];
function exportTime(v){
  return normTime(v) || '';
}
function exportCell(v){
  if(v == null) return '';
  return String(v);
}
function dbToDriveTables(db){
  const tables = {};
  DRIVE_EXPORT_SPECS.forEach(spec => {
    tables[spec.key] = spec.rows(db).map(vals => {
      const row = {};
      spec.headers.forEach((h,i) => { row[normHeader(h)] = exportCell(vals[i]); });
      return row;
    });
  });
  const sgAoa = smallGroupsCsvAoa(db.smallGroupsState || {smallGroups: []});
  const sgHeaders = (sgAoa[0] || SMALL_GROUPS_CSV_HEADERS).map(h => normHeader(h));
  tables.smallGroups = sgAoa.slice(1).map(vals => {
    const row = {};
    sgHeaders.forEach((h,i) => { if(h) row[h] = exportCell(vals[i]); });
    return row;
  });
  return tables;
}
function driveTablesToAoa(db){
  const sheets = DRIVE_EXPORT_SPECS.map(spec => ({
    name: spec.name,
    aoa: [spec.headers].concat(spec.rows(db).map(vals => vals.map(exportCell)))
  }));
  const sgAt = sheets.findIndex(s => s.name === 'SMALLGR_QUOTAS');
  const sgSheet = {
    name: 'SMALL_GROUPS',
    aoa: smallGroupsCsvAoa(db.smallGroupsState || {smallGroups: []}).map(row => row.map(exportCell))
  };
  if(sgAt < 0) sheets.push(sgSheet);
  else sheets.splice(sgAt, 0, sgSheet);
  const i = sheets.findIndex(s => s.name === 'SMALLGR_QUOTAS');
  const at = i < 0 ? sheets.length : i + 1;
  sheets.splice(at, 0, oneToOneAoa(db), rpianoAoa(db));
  return sheets;
}
async function exportDriveXlsx(){
  setSheetsStatus('Building DATABASE_2627 workbook…');
  try {
    const XLSX = await loadXlsxLib();
    const wb = XLSX.utils.book_new();
    driveTablesToAoa(DB).forEach(sheet => {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.aoa), sheet.name);
    });
    const out = XLSX.write(wb, {bookType:'xlsx', type:'array'});
    downloadFile(
      'DATABASE_2627.xlsx',
      new Blob([out], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
    );
    const counts = DRIVE_EXPORT_SPECS.map(s => `${s.name} ${(DB[s.key] || []).length}`).join(', ');
    setSheetsStatus('✓ Downloaded DATABASE_2627.xlsx — same tabs as the Drive workbook. Upload it to Drive, or File → Import into the existing sheet. '+counts+'.');
  } catch(err){
    setSheetsStatus('Could not export the workbook: ' + err.message, true);
  }
}
document.getElementById('sheetsExportBtn').addEventListener('click', exportDriveXlsx);
(function initSheetsUrl(){
  const inp = document.getElementById('sheetsUrlInput');
  if(!inp) return;
  try {
    inp.value = localStorage.getItem(SHEETS_URL_KEY) || DEFAULT_SHEETS_URL;
  } catch(e){
    inp.value = DEFAULT_SHEETS_URL;
  }
})();

// ==================== SMALL GROUPS ====================
const SMALL_GROUP_TYPES = ['bass','drum','acc','sol'];
const SMALL_GROUP_SCARCE = new Set(['bass','drum']);

function studentType(s){ return instrType(s.INSTR_ID); }
function studentMuclass(s){ return classMuclass(s.CLASS_ID); } // '' if no class / no muclass set

// Grade ordering for "try a neighboring grade before giving up" matching.
// 1 and 13 are the same level (post-12 year), so they're treated as identical here.
const MUCLASS_LEVEL_ORDER = ['9','10','11','12','L1_13','2','3'];
function muclassLevelKey(j){ return (j === '1' || j === '13') ? 'L1_13' : j; }
function muclassDistance(a, b){
  if(!a || !b) return Infinity;
  const ka = muclassLevelKey(a), kb = muclassLevelKey(b);
  if(ka === kb) return 0; // exact match, or 1↔13 (same level)
  const ia = MUCLASS_LEVEL_ORDER.indexOf(ka), ib = MUCLASS_LEVEL_ORDER.indexOf(kb);
  if(ia === -1 || ib === -1) return Infinity; // custom/unrecognized muclass value: only matches itself
  return Math.abs(ia - ib);
}

function generateSmallGroups(numSmallGroups){
  const eligible = DB.students.filter(s => studentMuclass(s) !== '');
  const excluded = DB.students.filter(s => studentMuclass(s) === '');

  const neverUsed = {}, usedOnce = {}, appearances = {};
  SMALL_GROUP_TYPES.forEach(t => { neverUsed[t] = eligible.filter(s => studentType(s) === t); usedOnce[t] = []; });
  eligible.forEach(s => { appearances[s.ID] = 0; });

  const smallGroups = Array.from({length:numSmallGroups}, (_, i) => {
    const rec = emptySmallGroupRecord('SG' + (i+1));
    rec.roomId = defaultRoomId();
    rec.room = roomName(rec.roomId);
    return rec;
  });

  // Picks the closest-grade match available: exact/same-level first, then the nearest
  // neighboring grade in MUCLASS_LEVEL_ORDER, and only if the type's pool is truly empty
  // does it fall back to anyone at all (or, for bass/drum, a repeat).
  function pick(type, targetMuclass, avoidIds){
    let cands = neverUsed[type].filter(s => !avoidIds.has(s.ID));
    if(cands.length){
      if(targetMuclass){
        cands = cands.slice().sort((a,b) => muclassDistance(studentMuclass(a), targetMuclass) - muclassDistance(studentMuclass(b), targetMuclass));
      }
      const chosen = cands[0];
      neverUsed[type] = neverUsed[type].filter(s => s !== chosen);
      usedOnce[type].push(chosen);
      return chosen;
    }
    if(SMALL_GROUP_SCARCE.has(type)){
      let rcands = usedOnce[type].filter(s => !avoidIds.has(s.ID));
      if(rcands.length){
        if(targetMuclass){
          rcands = rcands.slice().sort((a,b) => muclassDistance(studentMuclass(a), targetMuclass) - muclassDistance(studentMuclass(b), targetMuclass));
        }
        const chosen = rcands[0];
        usedOnce[type] = usedOnce[type].filter(s => s !== chosen);
        return chosen;
      }
    }
    return null;
  }

  // PASS 1: fully same-grade small groups, one level at a time (1 and 13 pooled together as one
  // level), limited by the scarcest type present at that level.
  const levelKeys = [...new Set(eligible.map(s => muclassLevelKey(studentMuclass(s))))]
    .sort((a,b) => {
      const ia = MUCLASS_LEVEL_ORDER.indexOf(a), ib = MUCLASS_LEVEL_ORDER.indexOf(b);
      if(ia === -1 && ib === -1) return a.localeCompare(b);
      if(ia === -1) return 1;
      if(ib === -1) return -1;
      return ia - ib;
    });
  let smallGroupI = 0;
  for(const levelKey of levelKeys){
    const counts = {}; SMALL_GROUP_TYPES.forEach(t => { counts[t] = neverUsed[t].filter(s => muclassLevelKey(studentMuclass(s))===levelKey).length; });
    const n = Math.min(...SMALL_GROUP_TYPES.map(t => counts[t]));
    for(let k=0; k<n && smallGroupI<numSmallGroups; k++){
      const avoid = new Set(); const picks = {}; let ok = true;
      // pick a representative student first to anchor the target grade for this small group
      let anchorPick = null;
      for(const t of SMALL_GROUP_TYPES){
        const cand = neverUsed[t].find(s => muclassLevelKey(studentMuclass(s)) === levelKey && !avoid.has(s.ID));
        if(cand){ anchorPick = cand; break; }
      }
      const g = anchorPick ? studentMuclass(anchorPick) : levelKey;
      for(const t of SMALL_GROUP_TYPES){
        const chosen = pick(t, g, avoid);
        if(!chosen){ ok = false; break; }
        picks[t] = chosen; avoid.add(chosen.ID);
      }
      if(ok){
        SMALL_GROUP_TYPES.forEach(t => { smallGroups[smallGroupI][t].push(picks[t]); appearances[picks[t].ID]++; });
        smallGroupI++;
      }
    }
  }

  // PASS 2: fill the rest, anchored on bass (then drum) — pick() itself now prefers the
  // closest grade (same level, then nearest neighbor) before falling back to anyone.
  while(smallGroupI < numSmallGroups){
    const anchorType = (neverUsed.bass.length || usedOnce.bass.length) ? 'bass'
                       : (neverUsed.drum.length || usedOnce.drum.length) ? 'drum' : null;
    if(!anchorType) break;
    const avoid = new Set();
    const anchor = pick(anchorType, null, avoid);
    if(!anchor) break;
    smallGroups[smallGroupI][anchorType].push(anchor); appearances[anchor.ID]++;
    avoid.add(anchor.ID);
    const targetG = studentMuclass(anchor);
    for(const t of SMALL_GROUP_TYPES){
      if(t === anchorType) continue;
      const chosen = pick(t, targetG, avoid);
      if(chosen){ smallGroups[smallGroupI][t].push(chosen); appearances[chosen.ID]++; avoid.add(chosen.ID); }
    }
    smallGroupI++;
  }

  function smallGroupSize(i){ return SMALL_GROUP_TYPES.reduce((sum,t) => sum + smallGroups[i][t].length, 0); }
  function smallGroupMuclasses(i){
    const c = {};
    SMALL_GROUP_TYPES.forEach(t => smallGroups[i][t].forEach(s => { const j = studentMuclass(s); c[j] = (c[j]||0)+1; }));
    return c;
  }
  // How well a candidate grade fits a small group's existing mix: exact/same-level members count
  // most, near neighbors count a bit, anything else counts nothing.
  function closenessScore(smallGroupIdx, candidateMuclass){
    const jc = smallGroupMuclasses(smallGroupIdx);
    let score = 0;
    for(const [g, n] of Object.entries(jc)){
      const d = muclassDistance(g, candidateMuclass);
      if(d === 0) score += 3*n;
      else if(d === 1) score += 1.5*n;
      else if(d === 2) score += 0.5*n;
    }
    return score;
  }

  // PASS 3: place every remaining surplus acc/sol student as an extra member — at most one
  // extra per type per small group, preferring small groups that are already grade-close to the student
  // (same/neighboring grade), and preferring small groups not already carrying the OTHER type's
  // extra (keeps sizes close to 4-6).
  for(const t of ['acc','sol']){
    const otherFlag = t === 'acc' ? 'sol' : 'acc';
    const flagKey = '_extra_' + t;
    smallGroups.forEach(b => { b[flagKey] = false; });
    const otherFlagKey = '_extra_' + otherFlag;
    smallGroups.forEach(b => { if(b[otherFlagKey] === undefined) b[otherFlagKey] = false; });

    const leftovers = neverUsed[t].slice();
    leftovers.forEach(person => {
      let best = -1, bestScore = null;
      for(let i=0; i<numSmallGroups; i++){
        if(smallGroups[i][flagKey]) continue;
        const score = [closenessScore(i, studentMuclass(person)), smallGroups[i][otherFlagKey] ? 0 : 1, -smallGroupSize(i)];
        if(bestScore === null || score[0] > bestScore[0] || (score[0]===bestScore[0] && score[1] > bestScore[1]) ||
           (score[0]===bestScore[0] && score[1]===bestScore[1] && score[2] > bestScore[2])){
          bestScore = score; best = i;
        }
      }
      if(best === -1){
        // every small group already has its one extra of this type: allow a second as a last resort
        for(let i=0; i<numSmallGroups; i++){
          const score = [closenessScore(i, studentMuclass(person)), -smallGroupSize(i)];
          if(bestScore === null || score[0] > bestScore[0] || (score[0]===bestScore[0] && score[1] > bestScore[1])){
            bestScore = score; best = i;
          }
        }
      }
      smallGroups[best][t].push(person); appearances[person.ID]++;
      smallGroups[best][flagKey] = true;
      neverUsed[t] = neverUsed[t].filter(s => s !== person);
    });
  }

  return {smallGroups, excluded, appearances, eligibleCount: eligible.length, nextSmallGroupSeq: numSmallGroups + 1};
}

function computeSmallGroupAppearanceCounts(smallGroups){
  const counts = {};
  smallGroups.forEach(b => SMALL_GROUP_TYPES.forEach(t => b[t].forEach(s => { counts[s.ID] = (counts[s.ID]||0) + 1; })));
  return counts;
}

function studentDisplayName(s){ return `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`; }

const SMALL_GROUPS_CSV_HEADERS = [
  'SMALL_GROUP_ID','SMALL_GROUP',
  'TEACHER','TEACHER_ID','DURATION_MIN','ROOM_ID','ROOM',
  'FIXED_DAY','FIXED_START','FIXED_END',
  'SCHEDULED_DAY','SCHEDULED_START','SCHEDULED_END','SCHEDULED_TEACHER','SCHEDULED_TEACHER_ID',
  'ROLE','STUDENT_ID','NAME','INSTRUMENT','CLASS','MUCLASS_TYPE'
];
function smallGroupCsvSharedCells(sg){
  const teacherId = (sg && sg.teacherId) || '';
  return [
    (sg && sg.id) || '',
    smallGroupShortLabel(sg),
    teacherId ? teacherName(teacherId) : '',
    teacherId,
    (sg && sg.duration) != null && sg.duration !== '' ? sg.duration : 90,
    itemRoomId(sg),
    itemRoomLabel(sg),
    (sg && sg.fixedDay) || '',
    exportTime(sg && sg.fixedStart),
    exportTime(sg && sg.fixedEnd),
    (sg && sg.scheduledDay) || '',
    exportTime(sg && sg.scheduledStart),
    exportTime(sg && sg.scheduledEnd),
    (sg && sg.scheduledTeacher) || ((sg && sg.scheduledTeacherId) ? teacherName(sg.scheduledTeacherId) : ''),
    (sg && sg.scheduledTeacherId) || ''
  ];
}
function smallGroupsCsvAoa(state){
  const rows = [SMALL_GROUPS_CSV_HEADERS.slice()];
  ((state && state.smallGroups) || []).forEach(sg => {
    const shared = smallGroupCsvSharedCells(sg);
    let any = false;
    SMALL_GROUP_TYPES.forEach(t => {
      (sg[t] || []).forEach(s => {
        any = true;
        rows.push(shared.concat([
          t.toUpperCase(),
          s.ID || '',
          studentDisplayName(s),
          instrName(s.INSTR_ID),
          className(s.CLASS_ID),
          studentMuclass(s)
        ]));
      });
    });
    if(!any) rows.push(shared.concat(['','','','','','']));
  });
  return rows;
}

function parseSmallGroupsTable(rows, students, ctx){
  ctx = ctx || {};
  const tById = ctx.tById || lookupMapBy(ctx.refTeachers || [], 'id');
  const tByName = ctx.tByName || lookupMapBy(ctx.refTeachers || [], 'name');
  const rById = ctx.rById || lookupMapBy(ctx.refRooms || [], 'id');
  const rByName = ctx.rByName || lookupMapBy(ctx.refRooms || [], 'name');
  const refClasses = ctx.refClasses || [];
  const byId = {};
  const order = [];
  function muclassOf(s){
    const c = refClasses.find(r => r.id === (s && s.CLASS_ID));
    if(!c) return '';
    return (c.muclass != null && String(c.muclass).trim() !== '') ? String(c.muclass).trim() : String(c.jclass || '').trim();
  }
  function fillIfEmpty(rec, key, val){
    if(val && !rec[key]) rec[key] = val;
  }
  (rows || []).forEach(r => {
    let id = rowGet(r, 'SMALL_GROUP_ID', 'SG_ID');
    if(!id){
      const label = rowGet(r, 'SMALL_GROUP');
      const m = /(?:SG\s*|SMALL\s*GROUP\s+)(\d+)/i.exec(label);
      if(m) id = 'SG' + m[1];
    }
    if(!id || normHeader(id) === 'SMALL_GROUP_ID') return;
    const teacher = rowGet(r, 'TEACHER');
    const teacherId = resolveId(tById, tByName, rowGet(r, 'TEACHER_ID'), teacher);
    const room = parseRoomAssignment(r, rById, rByName);
    const scheduledTeacher = rowGet(r, 'SCHEDULED_TEACHER');
    const scheduledTeacherId = resolveId(tById, tByName, rowGet(r, 'SCHEDULED_TEACHER_ID'), scheduledTeacher);
    if(!byId[id]){
      const rec = emptySmallGroupRecord(id);
      rec.teacherId = teacherId || '';
      rec.duration = parseInt(rowGet(r, 'DURATION_MIN', 'DURATION'), 10) || 90;
      rec.roomId = room.roomId || '';
      rec.room = room.room || '';
      rec.fixedDay = normDay(rowGet(r, 'FIXED_DAY', 'FIXEDDAY', 'PIN_DAY'));
      rec.fixedStart = normTime(rowGet(r, 'FIXED_START', 'FIXEDSTART', 'PIN_START'));
      rec.fixedEnd = normTime(rowGet(r, 'FIXED_END', 'FIXEDEND', 'PIN_END'));
      rec.scheduledDay = normDay(rowGet(r, 'SCHEDULED_DAY'));
      rec.scheduledStart = normTime(rowGet(r, 'SCHEDULED_START'));
      rec.scheduledEnd = normTime(rowGet(r, 'SCHEDULED_END'));
      rec.scheduledTeacherId = scheduledTeacherId || '';
      rec.scheduledTeacher = resolveName(tById, rec.scheduledTeacherId, scheduledTeacher);
      byId[id] = rec;
      order.push(id);
    } else {
      const rec = byId[id];
      fillIfEmpty(rec, 'teacherId', teacherId);
      if(!itemRoomId(rec) && room.roomId){
        rec.roomId = room.roomId;
        rec.room = room.room;
      }
      fillIfEmpty(rec, 'fixedDay', normDay(rowGet(r, 'FIXED_DAY', 'FIXEDDAY', 'PIN_DAY')));
      fillIfEmpty(rec, 'fixedStart', normTime(rowGet(r, 'FIXED_START', 'FIXEDSTART', 'PIN_START')));
      fillIfEmpty(rec, 'fixedEnd', normTime(rowGet(r, 'FIXED_END', 'FIXEDEND', 'PIN_END')));
      fillIfEmpty(rec, 'scheduledDay', normDay(rowGet(r, 'SCHEDULED_DAY')));
      fillIfEmpty(rec, 'scheduledStart', normTime(rowGet(r, 'SCHEDULED_START')));
      fillIfEmpty(rec, 'scheduledEnd', normTime(rowGet(r, 'SCHEDULED_END')));
      fillIfEmpty(rec, 'scheduledTeacherId', scheduledTeacherId);
      fillIfEmpty(rec, 'scheduledTeacher', resolveName(tById, scheduledTeacherId, scheduledTeacher));
    }
    const role = rowGet(r, 'ROLE', 'TYPE').toLowerCase();
    const sid = rowGet(r, 'STUDENT_ID', 'STUDENT');
    if(!role || !SMALL_GROUP_TYPES.includes(role) || !sid) return;
    const student = (students || []).find(s => String(s.ID) === sid);
    if(!student) return;
    const rec = byId[id];
    if(!rec[role].some(s => s.ID === student.ID)) rec[role].push(student);
  });
  const smallGroups = order.map(id => byId[id]);
  const appearances = computeSmallGroupAppearanceCounts(smallGroups);
  const excluded = (students || []).filter(s => muclassOf(s) === '');
  const eligibleCount = (students || []).filter(s => muclassOf(s) !== '').length;
  return normalizeSmallGroupsState({
    smallGroups, excluded, appearances, eligibleCount
  });
}

function smallGroupContainsStudent(sg, sid){
  const id = String(sid);
  return SMALL_GROUP_TYPES.some(t => (sg[t] || []).some(s => String(s.ID) === id));
}
function smallGroupRoleForStudent(s){
  const type = studentType(s);
  return SMALL_GROUP_TYPES.includes(type) ? type : 'sol';
}
function setSmallGroupStudentMembership(sg, student, on){
  if(!sg || !student) return false;
  const sid = String(student.ID);
  const had = smallGroupContainsStudent(sg, sid);
  if(on){
    if(had) return false;
    const role = smallGroupRoleForStudent(student);
    sg[role] = sg[role] || [];
    sg[role].push(student);
    return true;
  }
  if(!had) return false;
  SMALL_GROUP_TYPES.forEach(t => {
    sg[t] = (sg[t] || []).filter(s => String(s.ID) !== sid);
  });
  return true;
}

let EDITING_SMALL_GROUP_INDEX = null;
function hideSmallGroupStudentsEditor(){
  EDITING_SMALL_GROUP_INDEX = null;
  setModalOverlay('smallGroupStudentsOverlay', false);
}
function isSmallGroupStudentsEditorOpen(){
  return overlayIsOpen(document.getElementById('smallGroupStudentsOverlay'));
}
function applySmallGroupStudentsFilter(){
  const q = ((document.getElementById('smallGroupStudentsFilter') || {}).value || '').trim().toLowerCase();
  const table = document.getElementById('smallGroupStudentsTable');
  if(!table || !table.querySelectorAll) return;
  table.querySelectorAll('tbody tr').forEach(tr => {
    const hay = (tr.getAttribute && tr.getAttribute('data-search') || '').toLowerCase();
    tr.style.display = !q || hay.includes(q) ? '' : 'none';
  });
}
function showSmallGroupStudentsEditor(index){
  if(SEARCH_UI_LOCK) return;
  if(!LAST_SMALL_GROUPS || !LAST_SMALL_GROUPS.smallGroups || !LAST_SMALL_GROUPS.smallGroups[index]) return;
  abortCalendarInteraction();
  setModalOverlay('searchLogOverlay', false);
  setModalOverlay('smallGroupQuotasOverlay', false);
  hideGenerateConfirm();
  EDITING_SMALL_GROUP_INDEX = index;
  const filter = document.getElementById('smallGroupStudentsFilter');
  if(filter) filter.value = '';
  renderSmallGroupStudentsEditor();
  setModalOverlay('smallGroupStudentsOverlay', true);
}
function renderSmallGroupStudentsEditor(){
  const sg = LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups && LAST_SMALL_GROUPS.smallGroups[EDITING_SMALL_GROUP_INDEX];
  const title = document.getElementById('smallGroupStudentsTitle');
  const table = document.getElementById('smallGroupStudentsTable');
  if(!sg || !table){
    hideSmallGroupStudentsEditor();
    return;
  }
  if(title) title.textContent = `Edit students — ${smallGroupShortLabel(sg)}`;
  const members = new Set(SMALL_GROUP_TYPES.flatMap(t => (sg[t] || []).map(s => String(s.ID))));
  const students = (DB.students || []).slice().sort((a,b) =>
    studentDisplayName(a).localeCompare(studentDisplayName(b), undefined, {sensitivity:'base'})
  );
  let html = `<thead><tr>
    <th style="width:36px"></th>
    <th>Name</th>
    <th>Instrument</th>
    <th>Class</th>
    <th>MUCLASS type</th>
  </tr></thead><tbody>`;
  students.forEach(s => {
    const name = studentDisplayName(s);
    const instr = instrName(s.INSTR_ID) || '—';
    const cls = className(s.CLASS_ID) || '—';
    const mu = studentMuclass(s) || '—';
    const sid = String(s.ID);
    const search = `${name} ${instr} ${cls} ${mu} ${sid}`;
    const on = members.has(sid);
    html += `<tr data-sid="${escapeAttr(sid)}" data-search="${escapeAttr(search)}" class="${on ? 'is-member' : ''}">
      <td><input type="checkbox" class="small-group-student-check" data-sid="${escapeAttr(sid)}"${on ? ' checked' : ''}></td>
      <td>${escapeAttr(name)}</td>
      <td>${escapeAttr(instr)}</td>
      <td>${escapeAttr(cls)}</td>
      <td>${escapeAttr(mu)}</td>
    </tr>`;
  });
  html += '</tbody>';
  table.innerHTML = html;
  function toggleSid(sid, on){
    const live = LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups && LAST_SMALL_GROUPS.smallGroups[EDITING_SMALL_GROUP_INDEX];
    const student = (DB.students || []).find(x => String(x.ID) === String(sid));
    if(!live || !student) return;
    if(!setSmallGroupStudentMembership(live, student, on)) return;
    LAST_SMALL_GROUPS.appearances = computeSmallGroupAppearanceCounts(LAST_SMALL_GROUPS.smallGroups);
    renderSmallGroupsResults(LAST_SMALL_GROUPS);
    markWorkDirty();
    const row = table.querySelector(`tr[data-sid="${String(sid).replace(/"/g, '')}"]`);
    if(row && row.classList) row.classList.toggle('is-member', !!on);
  }
  if(table.querySelectorAll){
    table.querySelectorAll('.small-group-student-check').forEach(cb => {
      cb.addEventListener('change', e => {
        toggleSid(e.currentTarget.dataset.sid, e.currentTarget.checked);
      });
    });
    table.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', e => {
        if(e.target && e.target.closest && e.target.closest('input')) return;
        const cb = tr.querySelector && tr.querySelector('input[type="checkbox"]');
        if(!cb) return;
        cb.checked = !cb.checked;
        toggleSid(cb.dataset.sid, cb.checked);
      });
    });
  }
  applySmallGroupStudentsFilter();
}

function renderSmallGroupCard(sg, index, appearanceCounts){
  const jc = {};
  SMALL_GROUP_TYPES.forEach(t => sg[t].forEach(s => { const j = studentMuclass(s); jc[j] = (jc[j]||0)+1; }));
  const jmix = Object.entries(jc).sort((a,b)=>b[1]-a[1]).map(([g,n]) => `${g}×${n}`).join(' · ');

  let rows = '';
  SMALL_GROUP_TYPES.forEach(t => {
    sg[t].forEach(s => {
      const isDouble = (appearanceCounts[s.ID]||0) >= 2;
      rows += `<div class="small-group-member${isDouble?' double-booked':''}">
        <span class="role">${t.toUpperCase()}</span>
        <span class="who">${studentDisplayName(s)}<br><span class="cls">${instrName(s.INSTR_ID)} · ${className(s.CLASS_ID)||'—'}</span></span>
      </div>`;
    });
  });

  const quotaTeachers = (DB.smallGroupQuotas || [])
    .filter(quota => quota.teacherId && (parseInt(quota.amount, 10) || 0) > 0)
    .map(quota => ({
      id: quota.teacherId,
      name: quota.teacher || teacherName(quota.teacherId),
      amount: parseInt(quota.amount, 10) || 0
    }))
    .sort((a,b) => a.name.localeCompare(b.name));
  const teacherOptions = ['<option value="">— auto-match by quota</option>'].concat(
    quotaTeachers.map(t =>
      `<option value="${escapeAttr(t.id)}" ${t.id===sg.teacherId?'selected':''}>${escapeAttr(`${t.name} (quota ${t.amount})`)}</option>`
    )
  ).join('');

  return `<div class="small-group-card">
    <h4><span>${escapeAttr(smallGroupShortLabel(sg))} <span class="small-group-jmix">${jmix}</span></span><button class="small-group-member-remove small-group-delete-btn" data-small-group="${index}" title="Delete this small group">✕</button></h4>
    <div class="small-group-teacher-row small-group-teacher-assign">
      <label title="Uses 1 of this teacher's SMALL GROUP QUOTA. Leave on '—' to auto-match. A teacher with no remaining quota cannot take the sg.">Teacher override</label>
      <select class="small-group-teacher-select" data-small-group="${index}">${teacherOptions}</select>
    </div>
    <div class="small-group-teacher-row">
      <label>Duration</label>
      <input type="number" class="small-group-duration-input" data-small-group="${index}" value="${sg.duration ?? 90}" min="15" step="15" style="width:64px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:12px;">
      <label class="small-group-room-toggle">Room
        <select class="small-group-room-select" data-small-group="${index}">
          <option value="">— none</option>
          ${(DB.refRooms || []).map(r => `<option value="${escapeAttr(r.id)}" ${r.id===itemRoomId(sg)?'selected':''}>${escapeAttr(r.name || r.id)}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="small-group-teacher-row" title="Optional — pin this small group to an exact slot. Overlapping a class reservation or an illegal teacher gap still places it (warning). Fails if no matching teacher is free.">
      <label>Fixed time</label>
      <select class="small-group-fixedday-select" data-small-group="${index}" style="width:64px;padding:6px 4px;font-size:11px;">
        <option value="">—</option>
        ${DAYS.map(d => `<option value="${d}" ${sg.fixedDay===d?'selected':''}>${d}</option>`).join('')}
      </select>
      <input type="text" class="small-group-fixedstart-input" data-small-group="${index}" value="${escapeAttr(sg.fixedStart||'')}" placeholder="09:00" style="width:56px;padding:6px 6px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:11px;">
      <span style="color:var(--ink-dim);font-size:11px;">–</span>
      <input type="text" class="small-group-fixedend-input" data-small-group="${index}" value="${escapeAttr(sg.fixedEnd||'')}" placeholder="10:30" style="width:56px;padding:6px 6px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:11px;">
    </div>
    <div class="small-group-teacher-row small-group-scheduled-row" title="Filled by ✓ Accept this schedule. Generate ignores this — use Fixed time / Teacher override to pin the next search.">
      <label>Scheduled</label>
      <span>${sg.scheduledDay
        ? escapeAttr(`${sg.scheduledTeacher || teacherName(sg.scheduledTeacherId) || '—'} · ${sg.scheduledDay} ${sg.scheduledStart || ''}–${sg.scheduledEnd || ''}`)
        : '—'}</span>
    </div>
    ${rows}
    <div class="small-group-edit-row">
      <button type="button" class="btn secondary small small-group-edit-students-btn" data-small-group="${index}">Edit students</button>
    </div>
  </div>`;
}

document.getElementById('generateSmallGroupsBtn').addEventListener('click', requestGenerateSmallGroups);

function requestGenerateSmallGroups(){
  if(SEARCH_UI_LOCK) return;
  showGenerateConfirm('smallgroups');
}
function queueGenerateSmallGroups(clearAccepted){
  hideGenerateConfirm();
  setSmallGroupsBusy(true);
  setTimeout(() => {
    try {
      runGenerateSmallGroups(clearAccepted);
    } finally {
      setSmallGroupsBusy(false);
    }
  }, 0);
}
function runGenerateSmallGroups(clearAccepted, count){
  hideGenerateConfirm();
  const raw = count != null ? count : parseInt((document.getElementById('smallGroupCountInput') || {}).value, 10);
  const n = Math.max(1, raw || 17);
  const hadScheduled = hasAcceptedRecord();
  if(clearAccepted && hadScheduled) clearAcceptedScheduledRecord();
  clearGeneratedTimetableGrid();
  LAST_SMALL_GROUPS = generateSmallGroups(n);
  renderSmallGroupsResults(LAST_SMALL_GROUPS);
  markWorkDirty();
  return LAST_SMALL_GROUPS;
}

document.getElementById('addSmallGroupBtn').addEventListener('click', () => {
  if(!LAST_SMALL_GROUPS){
    LAST_SMALL_GROUPS = {smallGroups: [], excluded: [], appearances: {}, eligibleCount: 0, nextSmallGroupSeq: 1};
  }
  LAST_SMALL_GROUPS.smallGroups.push(emptySmallGroupRecord(mintSmallGroupId(LAST_SMALL_GROUPS)));
  renderSmallGroupsResults(LAST_SMALL_GROUPS);
  markWorkDirty();
});

// ---------- Small Group Quotas modal ----------
function scheduledSmallGroupCountsByTeacher(){
  const counts = {};
  if(!LAST_RESULT) return counts;
  LAST_RESULT.scheduled.forEach(s => {
    if(s.lessonId && isSmallGroupId(s.lessonId) && s.teacherId){
      counts[s.teacherId] = (counts[s.teacherId] || 0) + 1;
    }
  });
  return counts;
}

function renderSmallGroupQuotasModal(){
  const el = document.getElementById('smallGroupQuotasTable');
  const usedBy = scheduledSmallGroupCountsByTeacher();
  let html = '<thead><tr><th>SMALLGRQUOTA_ID</th><th>NAME</th><th style="min-width:110px">SMALLGR_AMOUNT</th><th>USED</th><th></th></tr></thead><tbody>';
  (DB.smallGroupQuotas || []).forEach((quota, i) => {
    const used = usedBy[quota.teacherId] || 0;
    const cap = parseInt(quota.amount,10) || 0;
    html += `<tr data-idx="${i}">
      <td>${escapeAttr(quota.id)}</td>
      <td>${escapeAttr(quota.teacher || teacherName(quota.teacherId))}</td>
      <td style="min-width:110px"><input data-idx="${i}" value="${escapeAttr(quota.amount ?? 0)}" style="width:70px;"></td>
      <td>${LAST_RESULT ? `${used} / ${cap}` : '—'}</td>
      <td><button class="btn danger small" data-remove="${i}" title="Remove this teacher from the Small Group Quotas list entirely">✕</button></td>
    </tr>`;
  });
  html += '</tbody>';
  el.innerHTML = html;

  function updateTotal(){
    const total = (DB.smallGroupQuotas || []).reduce((s,quota) => s + (parseInt(quota.amount,10) || 0), 0);
    const used = Object.values(scheduledSmallGroupCountsByTeacher()).reduce((s,n) => s + n, 0);
    document.getElementById('smallGroupQuotasTotal').textContent = LAST_RESULT ? `${used} used / ${total} quota` : String(total);
  }
  el.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      DB.smallGroupQuotas[idx].amount = e.target.value;
      updateTotal();
    });
  });
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.remove, 10);
      DB.smallGroupQuotas.splice(idx, 1);
      renderSmallGroupQuotasModal();
    });
  });
  updateTotal();

  // "+ Add teacher" row — only teachers not already in the list are offered, since a
  // teacher not present here should never be eligible for an auto-matched sg.
  const addRow = document.getElementById('smallGroupQuotasAddSelect');
  if(addRow){
    const listedIds = new Set((DB.smallGroupQuotas || []).map(quota => quota.teacherId));
    const available = DB.refTeachers.filter(t => !listedIds.has(t.id));
    addRow.innerHTML = '<option value="">Add a teacher…</option>' +
      available.map(t => `<option value="${escapeAttr(t.id)}">${escapeAttr(t.name)}</option>`).join('');
  }
}
document.getElementById('smallGroupQuotasAddBtn').addEventListener('click', () => {
  const sel = document.getElementById('smallGroupQuotasAddSelect');
  const teacherId = sel.value;
  if(!teacherId) return;
  const t = DB.refTeachers.find(x => x.id === teacherId);
  if(!t) return;
  DB.smallGroupQuotas = DB.smallGroupQuotas || [];
  DB.smallGroupQuotas.push({id: nextQuotaId(DB.smallGroupQuotas), teacherId: t.id, teacher: t.name, amount: 1});
  renderSmallGroupQuotasModal();
});
document.getElementById('smallGroupQuotasBtn').addEventListener('click', () => {
  hideSmallGroupStudentsEditor();
  renderSmallGroupQuotasModal();
  setModalOverlay('smallGroupQuotasOverlay', true);
});
document.getElementById('smallGroupQuotasCloseBtn').addEventListener('click', () => {
  setModalOverlay('smallGroupQuotasOverlay', false);
});
document.getElementById('smallGroupQuotasOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'smallGroupQuotasOverlay') setModalOverlay('smallGroupQuotasOverlay', false);
});
const smallGroupStudentsCloseBtn = document.getElementById('smallGroupStudentsCloseBtn');
if(smallGroupStudentsCloseBtn) smallGroupStudentsCloseBtn.addEventListener('click', hideSmallGroupStudentsEditor);
const smallGroupStudentsOverlay = document.getElementById('smallGroupStudentsOverlay');
if(smallGroupStudentsOverlay) smallGroupStudentsOverlay.addEventListener('click', (e) => {
  if(e.target.id === 'smallGroupStudentsOverlay') hideSmallGroupStudentsEditor();
});
const smallGroupStudentsFilter = document.getElementById('smallGroupStudentsFilter');
if(smallGroupStudentsFilter) smallGroupStudentsFilter.addEventListener('input', applySmallGroupStudentsFilter);

function renderSmallGroupsResults(result){
  const {smallGroups, excluded, eligibleCount} = result;
  document.getElementById('smallGroupsResultsPanel').style.display = 'block';

  const appearanceCounts = computeSmallGroupAppearanceCounts(smallGroups);
  const covered = Object.values(appearanceCounts).filter(v => v > 0).length;
  const twice = Object.values(appearanceCounts).filter(v => v >= 2).length;
  const statsRow = document.getElementById('smallGroupsStatsRow');
  statsRow.style.display = 'flex';
  statsRow.innerHTML = `
    <div class="stat"><div class="num">${smallGroups.length}</div><div class="lbl">Small Groups</div></div>
    <div class="stat"><div class="num">${covered}/${eligibleCount}</div><div class="lbl">Students placed</div></div>
    <div class="stat"><div class="num">${twice}</div><div class="lbl">Placed in 2 small groups</div></div>
    <div class="stat"><div class="num">${excluded.length}</div><div class="lbl">No class (excluded)</div></div>
  `;

  document.getElementById('smallGroupsGrid').innerHTML = smallGroups.map((b,i) => renderSmallGroupCard(b, i, appearanceCounts)).join('');

  document.querySelectorAll('.small-group-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups.splice(bi, 1);
      if(EDITING_SMALL_GROUP_INDEX === bi) hideSmallGroupStudentsEditor();
      else if(EDITING_SMALL_GROUP_INDEX > bi) EDITING_SMALL_GROUP_INDEX -= 1;
      renderSmallGroupsResults(LAST_SMALL_GROUPS);
      markWorkDirty();
    });
  });
  document.querySelectorAll('.small-group-edit-students-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      showSmallGroupStudentsEditor(parseInt(e.currentTarget.dataset.smallGroup, 10));
    });
  });
  document.querySelectorAll('.small-group-teacher-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups[bi].teacherId = e.currentTarget.value;
      markWorkDirty();
    });
  });
  function clampSmallGroupBookedWindow(bi){
    const sg = LAST_SMALL_GROUPS.smallGroups[bi];
    if(!clampBookedWindowToDuration(sg)) return;
    const endInp = document.querySelector(`.small-group-fixedend-input[data-small-group="${bi}"]`);
    if(endInp) endInp.value = sg.fixedEnd;
  }
  document.querySelectorAll('.small-group-duration-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups[bi].duration = parseInt(e.currentTarget.value, 10) || 90;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampSmallGroupBookedWindow(parseInt(e.currentTarget.dataset.smallGroup, 10));
    });
  });
  document.querySelectorAll('.small-group-room-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      const sg = LAST_SMALL_GROUPS.smallGroups[bi];
      sg.roomId = e.currentTarget.value;
      sg.room = roomName(sg.roomId);
      markWorkDirty();
    });
  });
  document.querySelectorAll('.small-group-fixedday-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups[bi].fixedDay = e.currentTarget.value;
      markWorkDirty();
      updateFixedPinsBanner();
    });
  });
  document.querySelectorAll('.small-group-fixedstart-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups[bi].fixedStart = e.currentTarget.value;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampSmallGroupBookedWindow(parseInt(e.currentTarget.dataset.smallGroup, 10));
    });
  });
  document.querySelectorAll('.small-group-fixedend-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.smallGroup, 10);
      LAST_SMALL_GROUPS.smallGroups[bi].fixedEnd = e.currentTarget.value;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampSmallGroupBookedWindow(parseInt(e.currentTarget.dataset.smallGroup, 10));
    });
  });

  const exclPanel = document.getElementById('smallGroupsExcludedPanel');
  if(excluded.length){
    exclPanel.style.display = 'block';
    document.getElementById('smallGroupsExcludedList').innerHTML = excluded.map(s =>
      `<li><b>${studentDisplayName(s)}</b> — ${instrName(s.INSTR_ID)} (${s.ID}, no CLASS assigned)</li>`
    ).join('');
  } else {
    exclPanel.style.display = 'none';
  }
  updateFixedPinsBanner();
}

document.getElementById('downloadSmallGroupsBtn').addEventListener('click', () => {
  if(!LAST_SMALL_GROUPS){ alert('Generate the small groups first.'); return; }
  const aoa = smallGroupsCsvAoa(LAST_SMALL_GROUPS);
  downloadFile('bartokkonzi_small_groups.csv', aoa.map(toCsvRow).join('\r\n'));
});

// ---------- 1/1 individual-lesson scheduler ----------
// Packs one-person lessons around the accepted group timetable. Hard constraints:
// teacher availability, class reservations (every leftover gap, not only the largest),
// no overlap with accepted bookings or other 1/1. Breaks are flexible: if the
// teacher already has a lesson that day, sit flush against it; if the day is
// empty, start as early as the leftover hole allows and chain forward.
// Then spread evenly across available days.
// A matrix cell is one weekly load. Round 1 packs every cell as one block.
// If that teacher still has no complete layout, round 2 keeps the placed
// blocks and splits only the leftovers. If that is still incomplete, round 3
// splits every cell (including ones that already sat) and packs from one pool.
// Allowed splits (1/1 and Required Piano): 60 → 2×30, 90 → 2×45 or 60+30,
// 120 → 2×60. A 30-min lesson stays 30. Two pieces of the same
// student×teacher may share a day only when they sit flush.
const ONEONE_SNAP = 5;

function parseIdList(s){
  return String(s == null ? '' : s).split(/[,;]+/).map(x => String(x).trim()).filter(Boolean);
}
function snapUpMin(mins){
  return Math.ceil(mins / ONEONE_SNAP) * ONEONE_SNAP;
}
function snapDownMin(mins){
  return Math.floor(mins / ONEONE_SNAP) * ONEONE_SNAP;
}
function shuffledCopy(arr, rng){
  const a = (arr || []).slice();
  const rand = rng || Math.random;
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function shuffleWithinGroups(arr, keyFn, rng){
  const groups = new Map();
  const order = [];
  (arr || []).forEach(item => {
    const k = keyFn(item);
    if(!groups.has(k)){
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k).push(item);
  });
  const out = [];
  order.forEach(k => out.push.apply(out, shuffledCopy(groups.get(k), rng)));
  return out;
}
function acceptedBusyMaps(rows){
  const teacherBusy = {};
  const studentBusy = {};
  const roomBusy = {};
  (rows || []).forEach(r => {
    if(r.status && r.status !== 'scheduled') return;
    const day = r.day;
    const start = typeof r.start === 'number' ? r.start : toMin(r.start);
    const end = typeof r.end === 'number' ? r.end : toMin(r.end);
    if(!day || !DAYS.includes(day) || start == null || end == null || !(start < end)) return;
    if(r.teacherId){
      teacherBusy[r.teacherId] = teacherBusy[r.teacherId] || {};
      teacherBusy[r.teacherId][day] = teacherBusy[r.teacherId][day] || [];
      teacherBusy[r.teacherId][day].push({start, end, name: r.name || ''});
    }
    parseIdList(r.studentIds || r.studentId).forEach(sid => {
      studentBusy[sid] = studentBusy[sid] || {};
      studentBusy[sid][day] = studentBusy[sid][day] || [];
      studentBusy[sid][day].push({start, end, name: r.name || ''});
    });
    occupyRoom(roomBusy, itemRoomId(r), day, start, end);
  });
  return {teacherBusy, studentBusy, roomBusy};
}
function intervalGapScore(start, end, busy){
  if(!busy || !busy.length) return 0;
  let best = DEFAULT_END - DEFAULT_START;
  let adjacent = false;
  busy.forEach(iv => {
    if(iv.end === start || iv.start === end) adjacent = true;
    if(start >= iv.end) best = Math.min(best, start - iv.end);
    else if(end <= iv.start) best = Math.min(best, iv.start - end);
  });
  return adjacent ? 0 : best;
}
function candidateStartsForInterval(s, e, duration, teacherBusy, dense){
  const starts = new Set();
  const first = snapUpMin(s);
  const last = snapDownMin(e - duration);
  if(first <= last){
    starts.add(first);
    starts.add(last);
    if(dense){
      for(let t = first; t <= last; t += 15) starts.add(t);
    }
  }
  (teacherBusy || []).forEach(iv => {
    const after = snapUpMin(iv.end);
    if(after >= s && after + duration <= e) starts.add(after);
    const before = snapDownMin(iv.start - duration);
    if(before >= s && before + duration <= e) starts.add(before);
  });
  return [...starts].filter(t => t >= s && t + duration <= e);
}

function parseOneOneHours(v){
  if(typeof v === 'number') return v > 0 && Number.isFinite(v) ? v : 0;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '').replace(',', '.');
  if(!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function oneOneHoursToMinutes(hours){
  const h = parseOneOneHours(hours);
  if(!h) return 0;
  return Math.max(15, Math.round(h * 60 / ONEONE_SNAP) * ONEONE_SNAP);
}
function oneOneSplitPlans(duration){
  const dur = clampOneOneDuration(duration);
  if(dur === 60) return [[30, 30]];
  if(dur === 90) return [[45, 45], [60, 30], [30, 60]];
  if(dur === 120) return [[60, 60]];
  return [];
}
function oneOneHalves(duration){
  const plans = oneOneSplitPlans(duration);
  return plans.length ? plans[0].slice() : null;
}
function formatOneOneHours(h){
  const n = parseOneOneHours(h);
  if(!n) return '';
  return String(n);
}
function matrixIdentityHeader(nh){
  return !!(nh && ({
    STUDENT_ID:1, ID:1, NAME1:1, NAME2:1, NAME3:1, PUBLIC_NAME:1,
    INSTR:1, INSTR_ID:1, NAME:1, ROOM:1, ROOM_LOCK:1, ROOMLOCK:1, ROOM_ID:1, ROOM_NAME:1
  })[nh]);
}
function matchTeacherRoomHeader(nh, tByNorm){
  if(!nh || !tByNorm) return null;
  const suffixes = ['_ROOM_LOCK', '_ROOMLOCK', '_ROOM_ID', '_ROOM'];
  for(let i = 0; i < suffixes.length; i++){
    const suf = suffixes[i];
    if(nh.length > suf.length && nh.slice(-suf.length) === suf){
      const t = tByNorm[nh.slice(0, -suf.length)];
      if(t && t.id) return t;
    }
  }
  const prefixes = ['ROOM_LOCK_', 'ROOMLOCK_', 'ROOM_ID_', 'ROOM_'];
  for(let i = 0; i < prefixes.length; i++){
    const pre = prefixes[i];
    if(nh.length > pre.length && nh.slice(0, pre.length) === pre){
      const t = tByNorm[nh.slice(pre.length)];
      if(t && t.id) return t;
    }
  }
  return null;
}
function parseOneToOneTable(rows, refTeachers, refRooms){
  const teachers = refTeachers || [];
  const rooms = refRooms || (DB && DB.refRooms) || [];
  const rById = lookupMapBy(rooms, 'id');
  const rByName = lookupMapBy(rooms, 'name');
  const tByNorm = {};
  teachers.forEach(t => {
    if(t && t.name) tByNorm[normHeader(t.name)] = t;
    if(t && t.id) tByNorm[normHeader(t.id)] = t;
  });
  const columns = [];
  const seen = new Set();
  const headerKeys = rows && rows[0] ? Object.keys(rows[0]) : [];
  const roomHeaders = [];
  headerKeys.forEach(h => {
    const nh = normHeader(h);
    if(!nh || matrixIdentityHeader(nh)) return;
    if(matchTeacherRoomHeader(nh, tByNorm)){
      roomHeaders.push(h);
      return;
    }
    const t = tByNorm[nh];
    if(!t || !t.id || seen.has(t.id)) return;
    seen.add(t.id);
    columns.push({id: t.id, name: t.name, roomId: '', room: ''});
  });
  const hours = {};
  let hasRoomRow = false;
  const roomColumnIds = [];
  const roomOwned = new Set();
  function colByTeacher(tid){
    return columns.find(c => c.id === tid);
  }
  (rows || []).forEach(r => {
    const sid = rowGet(r, 'STUDENT_ID', 'ID');
    if(!sid) return;
    if(isMatrixRoomLockId(sid)){
      hasRoomRow = true;
      headerKeys.forEach(h => {
        const nh = normHeader(h);
        if(!nh || matrixIdentityHeader(nh) || matchTeacherRoomHeader(nh, tByNorm)) return;
        const t = tByNorm[nh];
        if(!t || !t.id) return;
        const col = colByTeacher(t.id);
        if(!col) return;
        const fields = roomFieldsFromValue(r[h], rById, rByName);
        col.roomId = fields.roomId;
        col.room = fields.room;
      });
      return;
    }
    headerKeys.forEach(h => {
      const nh = normHeader(h);
      if(!nh || matrixIdentityHeader(nh) || matchTeacherRoomHeader(nh, tByNorm)) return;
      const t = tByNorm[nh];
      if(!t || !t.id) return;
      const n = parseOneOneHours(r[h]);
      if(!n) return;
      hours[sid] = hours[sid] || {};
      hours[sid][t.id] = n;
    });
  });
  roomHeaders.forEach(h => {
    const t = matchTeacherRoomHeader(normHeader(h), tByNorm);
    if(!t || !t.id) return;
    const col = colByTeacher(t.id) || (() => {
      const c = {id: t.id, name: t.name, roomId: '', room: ''};
      columns.push(c);
      return c;
    })();
    if(!roomOwned.has(t.id)){
      roomOwned.add(t.id);
      roomColumnIds.push(t.id);
    }
    let found = {roomId: '', room: ''};
    (rows || []).some(r => {
      const sid = rowGet(r, 'STUDENT_ID', 'ID');
      if(!sid || isMatrixRoomLockId(sid)) return false;
      const fields = roomFieldsFromValue(r[h], rById, rByName);
      if(!fields.roomId) return false;
      found = fields;
      return true;
    });
    col.roomId = found.roomId;
    col.room = found.room;
  });
  const hasStudentRooms = headerKeys.some(h => isMatrixRoomLockId(h));
  const studentRooms = {};
  if(hasStudentRooms){
    (rows || []).forEach(r => {
      const sid = rowGet(r, 'STUDENT_ID', 'ID');
      if(!sid || isMatrixRoomLockId(sid)) return;
      studentRooms[sid] = parseRoomAssignment(r, rById, rByName);
    });
  }
  return {columns, hours, hasRoomRow, roomColumnIds, studentRooms, hasStudentRooms};
}
function teacherMatrixRoom(matrix, teacherId){
  const col = ((matrix && matrix.columns) || []).find(c => c && c.id === teacherId);
  return roomFieldsOf(col || {});
}
function studentMatrixRoom(matrix, studentId){
  return roomFieldsOf(((matrix && matrix.studentRooms) || {})[studentId] || {});
}
function sessionLock(matrix, studentId, teacherId){
  const stu = studentMatrixRoom(matrix, studentId);
  if(itemRoomId(stu)) return stu;
  return teacherMatrixRoom(matrix, teacherId);
}
function migrateStudentRooms(matrix){
  if(!matrix) return matrix;
  matrix.studentRooms = matrix.studentRooms || {};
  Object.keys(matrix.studentRooms).forEach(sid => {
    const rec = matrix.studentRooms[sid];
    if(rec) migrateRoomLock(rec, {defaultOn:false});
  });
  return matrix;
}
function mergeMatrixColumnRooms(next, prev){
  if(!next) return next;
  next.columns = next.columns || [];
  if(next.hasStudentRooms){
    next.studentRooms = next.studentRooms || {};
  } else {
    next.studentRooms = Object.assign({}, (prev && prev.studentRooms) || {}, next.studentRooms || {});
  }
  const owned = new Set(next.roomColumnIds || []);
  if(next.hasRoomRow){
    next.columns.forEach(c => migrateRoomLock(c, {defaultOn:false}));
    return next;
  }
  const byId = {};
  ((prev && prev.columns) || []).forEach(c => {
    if(c && c.id) byId[c.id] = c;
  });
  next.columns.forEach(c => {
    if(!c) return;
    if(owned.has(c.id)){
      migrateRoomLock(c, {defaultOn:false});
      return;
    }
    if(itemRoomId(c)){
      migrateRoomLock(c, {defaultOn:false});
      return;
    }
    const old = byId[c.id];
    if(old && itemRoomId(old)){
      c.roomId = old.roomId;
      c.room = old.room || roomName(old.roomId);
    } else {
      migrateRoomLock(c, {defaultOn:false});
    }
  });
  return next;
}
function stampTeacherRoomOnScheduled(list, teacherId, fields, matrix){
  (list || []).forEach(s => {
    if(!s || s.teacherId !== teacherId) return;
    if(itemRoomId(studentMatrixRoom(matrix, s.studentId))) return;
    Object.assign(s, fields);
  });
}
function restampStudentSessions(list, matrix, studentId){
  (list || []).forEach(s => {
    if(s && s.studentId === studentId) Object.assign(s, sessionLock(matrix, studentId, s.teacherId));
  });
}
function setMatrixTeacherRoom(matrix, teacherId, roomId, kind){
  if(!matrix || !teacherId) return;
  matrix.columns = matrix.columns || [];
  let col = matrix.columns.find(c => c && c.id === teacherId);
  if(!col){
    col = {id: teacherId, name: teacherName(teacherId) || teacherId};
    matrix.columns.push(col);
  }
  col.roomId = String(roomId || '').trim();
  col.room = col.roomId ? (roomName(col.roomId) || col.roomId) : '';
  const fields = roomFieldsOf(col);
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  if(state){
    stampTeacherRoomOnScheduled(state.scheduled, teacherId, fields, matrix);
    (state.variants || []).forEach(v => stampTeacherRoomOnScheduled(v && v.scheduled, teacherId, fields, matrix));
    if((state.scheduled || []).some(s => s.teacherId === teacherId)) markLayoutNeedsAccept(kind);
  }
}
function setMatrixStudentRoom(matrix, studentId, roomId, kind){
  if(!matrix || !studentId) return;
  matrix.studentRooms = matrix.studentRooms || {};
  const rid = String(roomId || '').trim();
  if(!rid) delete matrix.studentRooms[studentId];
  else matrix.studentRooms[studentId] = {roomId: rid, room: roomName(rid) || rid};
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  if(state){
    restampStudentSessions(state.scheduled, matrix, studentId);
    (state.variants || []).forEach(v => restampStudentSessions(v && v.scheduled, matrix, studentId));
    if((state.scheduled || []).some(s => s.studentId === studentId)) markLayoutNeedsAccept(kind);
  }
}
function hoursMatrixAoa(db, matrix, sheetName){
  const m = matrix || {columns: [], hours: {}};
  const cols = m.columns || [];
  const headers = ['STUDENT_ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID','ROOM']
    .concat(cols.map(c => c.name));
  const rooms = m.studentRooms || {};
  const rows = (db.students || []).map(s => {
    const line = [s.ID, s.NAME1, s.NAME2, s.NAME3, s.PUBLIC_NAME, s.INSTR, s.INSTR_ID, itemRoomLabel(rooms[s.ID]) || ''];
    cols.forEach(c => {
      const h = ((m.hours || {})[s.ID] || {})[c.id];
      line.push(!h ? '' : (Number.isInteger(h) ? String(h) : String(h).replace('.', ',')));
    });
    return line;
  });
  return {name: sheetName, aoa: [headers].concat(rows)};
}
function oneToOneAoa(db){
  return hoursMatrixAoa(db, db.oneToOne, '1_1');
}
function rpianoAoa(db){
  return hoursMatrixAoa(db, db.rpiano, 'rpiano');
}
function collectOneOneAssignments(matrix){
  const m = matrix || {hours: {}};
  const out = [];
  Object.keys(m.hours || {}).forEach(sid => {
    Object.keys(m.hours[sid] || {}).forEach(tid => {
      const h = parseOneOneHours(m.hours[sid][tid]);
      if(!h) return;
      out.push({studentId: sid, teacherId: tid, hours: h, duration: oneOneHoursToMinutes(h)});
    });
  });
  return out;
}

function clampOneOneDuration(n){
  const v = parseInt(n, 10);
  if(!Number.isFinite(v)) return 60;
  return Math.max(15, Math.min(360, v));
}
function durationForOneOneStudent(sid, opts){
  const map = (opts && opts.durations) || {};
  if(map[sid] != null && map[sid] !== '') return clampOneOneDuration(map[sid]);
  return clampOneOneDuration(opts && opts.duration);
}

function scheduleOneToOne(opts){
  const teacherId = opts && opts.teacherId;
  const duration = clampOneOneDuration(opts && opts.duration);
  const perStudent = Math.max(1, Math.min(3, parseInt(opts && opts.perStudent, 10) || 1));
  const studentIds = ((opts && opts.studentIds) || []).filter(Boolean);
  const accepted = (opts && opts.acceptedRows) || (DB.acceptedSchedule || []);
  const extra = (opts && opts.existingOneOne) || [];
  const tname = teacherName(teacherId) || teacherId || '';
  const wins = teacherId ? teacherDayWindows(teacherId, 'oneone') : {};
  const rng = (opts && opts.rng) || Math.random.bind(Math);
  const randomize = !!(opts && opts.randomize);
  let days = DAYS.filter(d => wins[d]);
  if(randomize) days = shuffledCopy(days, rng);
  const scheduled = [];
  const unresolved = [];

  function failAll(reason){
    studentIds.forEach(id => {
      const st = (DB.students || []).find(s => s.ID === id);
      unresolved.push({studentId: id, name: st ? studentDisplayName(st) : id, teacherId, reason});
    });
    return {scheduled, unresolved, duration, teacherId, dayCount: {}, target: 0};
  }
  if(!teacherId) return failAll('no teacher selected');
  if(!days.length) return failAll('teacher has no availability rows');
  if(!studentIds.length) return {scheduled, unresolved, duration, teacherId, dayCount: {}, target: 0};

  const extraRows = extra.map(s => ({
    status: 'scheduled',
    teacherId: s.teacherId,
    day: s.day,
    start: s.start,
    end: s.end,
    studentIds: s.studentIds || s.studentId || '',
    name: s.name,
    ...roomFieldsOf(s)
  }));
  const maps = acceptedBusyMaps(accepted.concat(extraRows));
  maps.roomBusy = maps.roomBusy || {};
  const tBusy = {};
  DAYS.forEach(d => { tBusy[d] = ((maps.teacherBusy[teacherId] || {})[d] || []).slice(); });
  const matrix = (opts && opts.matrix)
    || ((opts && opts.source) === 'rpiano' ? DB.rpiano : DB.oneToOne);
  function lockFor(student){
    const stu = studentMatrixRoom(matrix, student && student.ID);
    if(itemRoomId(stu)) return stu;
    if(opts && Object.prototype.hasOwnProperty.call(opts, 'roomId')) return roomFieldsOf(opts);
    return teacherMatrixRoom(matrix, teacherId);
  }

  let jobs = [];
  studentIds.forEach(sid => {
    const student = (DB.students || []).find(s => s.ID === sid);
    if(!student){
      unresolved.push({studentId: sid, name: sid, teacherId, reason: 'student not in the roster'});
      return;
    }
    const dur = durationForOneOneStudent(sid, opts);
    for(let k=0; k<perStudent; k++) jobs.push({student, copy: k, duration: dur});
  });

  const target0 = Math.ceil(jobs.length / Math.max(1, days.length));
  let target = target0;
  const dayCount = {};
  days.forEach(d => { dayCount[d] = 0; });

  function studentDaySlots(student, day, dur){
    const win = wins[day];
    if(!win) return [];
    // Subtract CLASS_CONST reservations from the teacher's actual window.
    // Do not use classFreeGaps here: that clips to 08:00–20:00, so a teacher
    // available until 20:30 (or from 07:30) would lose a legal 1/1 hole.
    const reserved = (student.CLASS_ID ? (DB.classAvail || []).filter(r =>
      r.classId === student.CLASS_ID && r.day === day && (r.start || r.end)
    ) : []).map(r => ({
      start: toMin(r.start) ?? DEFAULT_START,
      end: toMin(r.end) ?? DEFAULT_END
    }));
    let ivs = subtractBusyFromIntervals(teacherWindowIntervals(win), reserved);
    const busy = (tBusy[day] || []).concat(((maps.studentBusy[student.ID] || {})[day]) || []);
    const rid = itemRoomId(lockFor(student));
    const rBusy = rid ? ((maps.roomBusy[rid] || {})[day] || []) : [];
    ivs = subtractBusyFromIntervals(ivs, busy);
    if(rBusy.length) ivs = subtractBusyFromIntervals(ivs, rBusy);
    const slots = [];
    ivs.forEach(([s,e]) => {
      candidateStartsForInterval(s, e, dur, busy.concat(rBusy), randomize).forEach(start => {
        const end = start + dur;
        if(busy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return;
        if(roomSlotTaken(maps.roomBusy, rid, day, start, end)) return;
        if(overlappingClassReservation(student.CLASS_ID, day, start, end)) return;
        if(teacherWindowClash(teacherId, tname, day, start, end, 'oneone')) return;
        slots.push({day, start, end, gap: intervalGapScore(start, end, tBusy[day]), rank: win.rank});
      });
    });
    const have = scheduled.filter(s => s.studentId === student.ID && s.day === day);
    if(!have.length) return slots;
    return slots.filter(sl => have.some(ex => sl.start === ex.end || sl.end === ex.start));
  }

  const prefix = (opts && opts.idPrefix) || 'O2O';
  const label = (opts && opts.lessonLabel) || '1/1';
  const source = (opts && opts.source) || 'oneone';
  const allowSplit = ((parseInt(opts && opts.perStudent, 10) || 1) === 1);
  const placedByPair = {};

  function snapshotBusy(){
    return {
      tBusy: JSON.parse(JSON.stringify(tBusy)),
      studentBusy: JSON.parse(JSON.stringify(maps.studentBusy)),
      roomBusy: JSON.parse(JSON.stringify(maps.roomBusy || {})),
      dayCount: Object.assign({}, dayCount),
      n: scheduled.length
    };
  }
  function restoreBusy(snap){
    DAYS.forEach(d => { tBusy[d] = ((snap.tBusy || {})[d] || []).slice(); });
    Object.keys(maps.studentBusy).forEach(k => { delete maps.studentBusy[k]; });
    Object.assign(maps.studentBusy, JSON.parse(JSON.stringify(snap.studentBusy || {})));
    Object.keys(maps.roomBusy || {}).forEach(k => { delete maps.roomBusy[k]; });
    Object.assign(maps.roomBusy, JSON.parse(JSON.stringify(snap.roomBusy || {})));
    Object.keys(dayCount).forEach(k => { delete dayCount[k]; });
    Object.assign(dayCount, snap.dayCount || {});
    scheduled.length = snap.n;
  }
  function pickSlot(slots){
    if(!slots.length) return null;
    slots.sort((a,b) => {
      const overA = Math.max(0, (dayCount[a.day] + 1) - target);
      const overB = Math.max(0, (dayCount[b.day] + 1) - target);
      return a.gap - b.gap
        || overA - overB
        || dayCount[a.day] - dayCount[b.day]
        || a.rank - b.rank
        || DAYS.indexOf(a.day) - DAYS.indexOf(b.day)
        || a.start - b.start;
    });
    const tight = randomize ? slots.filter(s => s.gap === slots[0].gap) : slots;
    return (randomize && tight.length > 1)
      ? tight[Math.floor(rng() * tight.length)]
      : slots[0];
  }
  function occupySlot(student, pick, duration, copy, split, pairId){
    const fields = lockFor(student);
    const rid = itemRoomId(fields);
    const item = {
      lessonId: prefix + '-' + teacherId + '-' + student.ID + (copy ? '-' + (copy + 1) : ''),
      name: studentDisplayName(student) + ' ' + label + (split ? ' · ' + duration + '′' : ''),
      group: label, groupId: '',
      teacherId, teacher: tname,
      day: pick.day, start: pick.start, end: pick.end,
      studentCount: 1,
      studentNames: [studentDisplayName(student)],
      studentId: student.ID,
      studentIds: student.ID,
      ...roomFieldsOf(fields),
      source,
      duration
    };
    scheduled.push(item);
    tBusy[pick.day].push({start: pick.start, end: pick.end, name: item.name});
    maps.studentBusy[student.ID] = maps.studentBusy[student.ID] || {};
    maps.studentBusy[student.ID][pick.day] = maps.studentBusy[student.ID][pick.day] || [];
    maps.studentBusy[student.ID][pick.day].push({start: pick.start, end: pick.end});
    occupyRoom(maps.roomBusy, rid, pick.day, pick.start, pick.end);
    dayCount[pick.day] = (dayCount[pick.day] || 0) + 1;
    if(pairId){
      placedByPair[pairId] = placedByPair[pairId] || [];
      placedByPair[pairId].push(item);
    }
    return item;
  }
  function unoccupy(item){
    if(!item) return;
    const i = scheduled.indexOf(item);
    if(i >= 0) scheduled.splice(i, 1);
    const tb = tBusy[item.day] || [];
    const ti = tb.findIndex(iv => iv.start === item.start && iv.end === item.end);
    if(ti >= 0) tb.splice(ti, 1);
    const sb = ((maps.studentBusy[item.studentId] || {})[item.day] || []);
    const si = sb.findIndex(iv => iv.start === item.start && iv.end === item.end);
    if(si >= 0) sb.splice(si, 1);
    vacateRoom(maps.roomBusy, itemRoomId(item), item.day, item.start, item.end);
    dayCount[item.day] = Math.max(0, (dayCount[item.day] || 0) - 1);
  }
  function failReason(student){
    return itemRoomId(lockFor(student))
      ? 'no shared free slot with the teacher (accepted bookings, class reservations, room lock, or availability)'
      : 'no shared free slot with the teacher (accepted bookings, class reservations, or availability)';
  }
  function tryPlaceBlock(student, duration, copy, split, pairId){
    const pick = pickSlot(days.flatMap(d => studentDaySlots(student, d, duration)));
    if(!pick) return null;
    return occupySlot(student, pick, duration, copy, !!split, pairId);
  }
  function tryPlacePlan(student, parts, pairId){
    const snap = snapshotBusy();
    if(pairId) placedByPair[pairId] = [];
    for(let i = 0; i < parts.length; i++){
      const pick = pickSlot(days.flatMap(d => studentDaySlots(student, d, parts[i])));
      if(!pick){
        restoreBusy(snap);
        if(pairId) placedByPair[pairId] = [];
        return false;
      }
      occupySlot(student, pick, parts[i], i, true, pairId);
    }
    return true;
  }

  function studentFreeMinutes(student, dur){
    let n = 0;
    days.forEach(day => {
      const win = wins[day];
      if(!win) return;
      const reserved = (student.CLASS_ID ? (DB.classAvail || []).filter(r =>
        r.classId === student.CLASS_ID && r.day === day && (r.start || r.end)
      ) : []).map(r => ({
        start: toMin(r.start) ?? DEFAULT_START,
        end: toMin(r.end) ?? DEFAULT_END
      }));
      let ivs = subtractBusyFromIntervals(teacherWindowIntervals(win), reserved);
      const busy = (tBusy[day] || []).concat(((maps.studentBusy[student.ID] || {})[day]) || []);
      const rid = itemRoomId(lockFor(student));
      const rBusy = rid ? ((maps.roomBusy[rid] || {})[day] || []) : [];
      ivs = subtractBusyFromIntervals(ivs, busy);
      if(rBusy.length) ivs = subtractBusyFromIntervals(ivs, rBusy);
      ivs.forEach(([s,e]) => {
        if(e - s >= dur) n += (e - s);
      });
    });
    return n;
  }
  function packJobs(list, asHalves){
    Object.keys(placedByPair).forEach(k => { delete placedByPair[k]; });
    Object.keys(dayCount).forEach(k => { dayCount[k] = 0; });
    days.forEach(d => { dayCount[d] = dayCount[d] || 0; });
    target = Math.ceil(list.length / Math.max(1, days.length));
    days.forEach(d => { dayCount[d] = dayCount[d] || 0; });
    list.forEach(job => {
      job.flexDays = days.filter(d => studentDaySlots(job.student, d, job.duration).length).length;
      job.freeMin = studentFreeMinutes(job.student, job.duration);
    });
    list.sort((a,b) => a.flexDays - b.flexDays || b.duration - a.duration || a.freeMin - b.freeMin || String(a.student.ID).localeCompare(String(b.student.ID)) || (a.copy || 0) - (b.copy || 0));
    if(randomize) list = shuffleWithinGroups(list, j => j.flexDays + ':' + j.duration, rng);
    const leftoverJobs = [];
    const leftoverPairs = new Set();
    const jobsByPair = {};
    list.forEach(j => {
      if(j.pairId) (jobsByPair[j.pairId] = jobsByPair[j.pairId] || []).push(j);
    });
    list.forEach(job => {
      if(job.pairId && leftoverPairs.has(job.pairId)) return;
      if(tryPlaceBlock(job.student, job.duration, job.copy, !!job.splitFrom, job.pairId)) return;
      leftoverJobs.push(job);
      if(!job.pairId) return;
      leftoverPairs.add(job.pairId);
      (placedByPair[job.pairId] || []).slice().forEach(unoccupy);
      placedByPair[job.pairId] = [];
      (jobsByPair[job.pairId] || []).forEach(j => {
        if(j !== job) leftoverJobs.push(j);
      });
    });
    leftoverJobs.forEach(job => {
      if(!job.pairId) return;
      tryPlaceBlock(job.student, job.duration, job.copy, !!job.splitFrom, job.pairId);
    });
    leftoverJobs.forEach(job => {
      if(job.pairId) return;
      unresolved.push({
        studentId: job.student.ID,
        name: studentDisplayName(job.student),
        teacherId,
        reason: failReason(job.student)
      });
    });
    [...new Set(list.map(j => j.pairId).filter(Boolean))].forEach(pid => {
      const pieces = (placedByPair[pid] || []).filter(it => scheduled.includes(it));
      if(pieces.length === 2) return;
      pieces.forEach(unoccupy);
      placedByPair[pid] = [];
      const sample = list.find(j => j.pairId === pid);
      const alts = (sample && sample.altPlans) || [];
      let ok = false;
      for(let i = 0; i < alts.length && !ok; i++){
        ok = tryPlacePlan(sample.student, alts[i], pid);
      }
      if(ok) return;
      const student = sample ? sample.student : (DB.students || []).find(s => s.ID === pid);
      const sid = student && student.ID ? student.ID : pid;
      if(unresolved.some(u => u.studentId === sid)) return;
      unresolved.push({
        studentId: sid,
        name: student ? studentDisplayName(student) : sid,
        teacherId,
        reason: failReason(student || {ID: sid})
      });
    });
  }

  function captureLayout(){
    return {
      snap: snapshotBusy(),
      scheduled: scheduled.slice(),
      unresolved: unresolved.slice()
    };
  }
  function applyLayout(cap){
    restoreBusy(cap.snap);
    scheduled.length = 0;
    cap.scheduled.forEach(s => scheduled.push(s));
    unresolved.length = 0;
    cap.unresolved.forEach(u => unresolved.push(u));
  }
  function isGhost(u){
    return u && u.reason === 'student not in the roster';
  }
  function hasRealUnresolved(){
    return unresolved.some(u => !isGhost(u));
  }
  function splitPoolJobs(list){
    const halfJobs = [];
    list.forEach(j => {
      const plans = oneOneSplitPlans(j.duration);
      if(!plans.length){
        halfJobs.push({student: j.student, copy: j.copy, duration: j.duration});
        return;
      }
      const pid = j.student.ID + '#' + (j.copy || 0);
      const alts = plans.slice(1);
      plans[0].forEach((dur, i) => {
        halfJobs.push({student: j.student, copy: i, duration: dur, pairId: pid, splitFrom: j.duration, altPlans: alts});
      });
    });
    return halfJobs;
  }
  function trySplitJob(j){
    const plans = oneOneSplitPlans(j.duration);
    if(!plans.length) return false;
    const pid = j.student.ID + '#' + (j.copy || 0);
    for(let i = 0; i < plans.length; i++){
      if(tryPlacePlan(j.student, plans[i], pid)) return true;
    }
    return false;
  }

  const startSnap = snapshotBusy();
  packJobs(jobs, false);
  const ghosts = unresolved.filter(isGhost);
  if(allowSplit && hasRealUnresolved()){
    const round1 = captureLayout();
    const retryIds = new Set(unresolved.filter(u => !isGhost(u)).map(u => u.studentId));
    unresolved.length = 0;
    ghosts.forEach(u => unresolved.push(u));
    jobs.forEach(j => {
      if(!retryIds.has(j.student.ID)) return;
      if(trySplitJob(j)) return;
      unresolved.push({
        studentId: j.student.ID,
        name: studentDisplayName(j.student),
        teacherId,
        reason: failReason(j.student)
      });
    });
    if(!hasRealUnresolved()){
      // Round 2 placed every leftover; keep the original blocks.
    } else {
      const round2 = captureLayout();
      restoreBusy(startSnap);
      scheduled.length = 0;
      unresolved.length = 0;
      packJobs(splitPoolJobs(jobs), true);
      ghosts.forEach(u => {
        if(!unresolved.some(x => x.studentId === u.studentId)) unresolved.push(u);
      });
      const round3 = captureLayout();
      const best = [round1, round2, round3].sort(compareOneOneResults)[0];
      applyLayout(best);
    }
  }

  scheduled.sort((a,b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
  return {scheduled, unresolved, duration, teacherId, dayCount, target};
}

function scheduleAllOneToOne(opts){
  const matrix = (opts && opts.matrix) || ((opts && opts.source) === 'rpiano' ? DB.rpiano : DB.oneToOne);
  const assignments = (opts && opts.assignments) || collectOneOneAssignments(matrix);
  const accepted = (opts && opts.acceptedRows) || (DB.acceptedSchedule || []);
  const rng = (opts && opts.rng) || Math.random.bind(Math);
  const randomize = !!(opts && opts.randomize);
  const byTeacher = {};
  assignments.forEach(a => {
    if(!a.teacherId || !a.studentId) return;
    byTeacher[a.teacherId] = byTeacher[a.teacherId] || [];
    byTeacher[a.teacherId].push(a);
  });
  let teacherIds = Object.keys(byTeacher).sort((a,b) => {
    const da = DAYS.filter(d => teacherDayWindows(a, 'oneone')[d]).length;
    const dbn = DAYS.filter(d => teacherDayWindows(b, 'oneone')[d]).length;
    return da - dbn || byTeacher[b].length - byTeacher[a].length || String(teacherName(a)).localeCompare(String(teacherName(b)));
  });
  if(randomize) teacherIds = shuffledCopy(teacherIds, rng);
  let existing = ((opts && opts.existingOneOne) || []).slice();
  const scheduled = [];
  const unresolved = [];
  teacherIds.forEach(tid => {
    const list = byTeacher[tid];
    const durations = {};
    list.forEach(a => { durations[a.studentId] = a.duration; });
    const lock = teacherMatrixRoom(matrix, tid);
    const result = scheduleOneToOne({
      teacherId: tid,
      studentIds: list.map(a => a.studentId),
      durations,
      duration: 60,
      perStudent: 1,
      acceptedRows: accepted,
      existingOneOne: existing,
      source: opts && opts.source,
      lessonLabel: opts && opts.lessonLabel,
      idPrefix: opts && opts.idPrefix,
      matrix,
      roomId: lock.roomId,
      room: lock.room,
      randomize,
      rng
    });
    existing = existing.concat(result.scheduled);
    scheduled.push.apply(scheduled, result.scheduled);
    unresolved.push.apply(unresolved, result.unresolved);
  });
  scheduled.sort((a,b) => String(a.teacher||'').localeCompare(String(b.teacher||'')) || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
  return {scheduled, unresolved, assignmentCount: assignments.length};
}

let ONEONE_SEARCH_ATTEMPTS = 15;
let RPIANO_SEARCH_ATTEMPTS = 15;
const ONEONE_SEARCH_ATTEMPTS_MAX = 5000;
const ONEONE_SEARCH_MAX_TRIES = 60;
function clampOneOneSearchAttempts(n){
  const v = parseInt(n, 10);
  if(!Number.isFinite(v)) return 15;
  return Math.max(1, Math.min(ONEONE_SEARCH_ATTEMPTS_MAX, v));
}
function oneOneSearchMaxTries(attempts){
  const n = clampOneOneSearchAttempts(attempts);
  return Math.max(n, n * 4);
}
function oneOneAttemptsInputId(kind){
  return kind === 'rpiano' ? 'rpianoSearchAttempts' : 'oneoneSearchAttempts';
}
function readOneOneSearchAttempts(kind){
  const piano = kind === 'rpiano';
  const el = document.getElementById(oneOneAttemptsInputId(kind));
  let v;
  if(el && String(el.value || '').trim() !== ''){
    v = clampOneOneSearchAttempts(el.value);
  } else {
    v = clampOneOneSearchAttempts(piano ? RPIANO_SEARCH_ATTEMPTS : ONEONE_SEARCH_ATTEMPTS);
  }
  if(piano) RPIANO_SEARCH_ATTEMPTS = v;
  else ONEONE_SEARCH_ATTEMPTS = v;
  if(el) el.value = String(v);
  return v;
}
function lessonStartMinutes(row){
  if(!row) return null;
  return typeof row.start === 'number' ? row.start : toMin(row.start);
}
function lessonEndMinutes(row){
  if(!row) return null;
  return typeof row.end === 'number' ? row.end : toMin(row.end);
}
function scheduledIdleGapMinutes(rows){
  const by = {};
  (rows || []).forEach(r => {
    if(!r || r.status === 'unscheduled') return;
    const tid = r.teacherId;
    const day = r.day;
    const start = lessonStartMinutes(r);
    const end = lessonEndMinutes(r);
    if(!tid || !day || start == null || end == null) return;
    (by[tid] = by[tid] || {});
    (by[tid][day] = by[tid][day] || []).push({start, end});
  });
  let total = 0;
  Object.keys(by).forEach(tid => {
    Object.keys(by[tid]).forEach(day => {
      const list = by[tid][day].sort((a,b) => a.start - b.start || a.end - b.end);
      for(let i=1;i<list.length;i++){
        const gap = list[i].start - list[i-1].end;
        if(gap > 0) total += gap;
      }
    });
  });
  return total;
}
function attachOneOneLayoutScore(result, acceptedRows){
  if(!result) return result;
  result.idleGapMinutes = scheduledIdleGapMinutes((acceptedRows || []).concat(result.scheduled || []));
  return result;
}
function oneOneCoverageCount(result){
  const keys = new Set();
  ((result && result.scheduled) || []).forEach(s => {
    if(s && s.studentId && s.teacherId) keys.add(s.teacherId + '::' + s.studentId);
  });
  return keys.size;
}
function oneOneAvgDayStartMinutes(rows){
  const first = {};
  (rows || []).forEach(r => {
    if(!r || r.status === 'unscheduled') return;
    const tid = r.teacherId;
    const day = r.day;
    const start = lessonStartMinutes(r);
    if(!tid || !day || start == null) return;
    const k = tid + '\t' + day;
    if(first[k] == null || start < first[k]) first[k] = start;
  });
  const vals = Object.keys(first).map(k => first[k]);
  if(!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function oneOneResultScore(result){
  const idle = result && Number.isFinite(result.idleGapMinutes)
    ? result.idleGapMinutes
    : scheduledIdleGapMinutes(result && result.scheduled);
  return [
    ((result && result.unresolved) || []).length,
    -oneOneCoverageCount(result),
    ((result && result.scheduled) || []).length,
    idle,
    oneOneAvgDayStartMinutes(result && result.scheduled)
  ];
}
function compareOneOneResults(a, b){
  const sa = oneOneResultScore(a), sb = oneOneResultScore(b);
  for(let i=0;i<sa.length;i++){
    if(sa[i] !== sb[i]) return sa[i] - sb[i];
  }
  return 0;
}
function mergeIndividualVariants(prev, fresh){
  const merged = new Map();
  (prev || []).forEach(v => merged.set(resultSignature(v), v));
  (fresh || []).forEach(v => {
    const sig = resultSignature(v);
    if(!merged.has(sig)) merged.set(sig, v);
  });
  return [...merged.values()].sort(compareOneOneResults).slice(0, 30);
}
function oneOneResultLogLine(result){
  const pairs = oneOneCoverageCount(result);
  const left = ((result && result.unresolved) || []).length;
  const idle = result && Number.isFinite(result.idleGapMinutes) ? `, ${result.idleGapMinutes} min idle` : '';
  return `${pairs} placed, ${left} left${idle}`;
}
function scheduleAllOneToOneSearch(opts){
  const accepted = (opts && opts.acceptedRows) || [];
  const target = Math.max(1, (opts && opts.attempts) || readOneOneSearchAttempts());
  const maxTries = Math.max(target, (opts && opts.maxTries) || oneOneSearchMaxTries(target));
  const seen = new Map();
  const first = attachOneOneLayoutScore(
    scheduleAllOneToOne(Object.assign({}, opts, {randomize: false})),
    accepted
  );
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  seen.set(resultSignature(first), first);
  let n = 2;
  while(seen.size < target && n <= maxTries){
    const result = attachOneOneLayoutScore(
      scheduleAllOneToOne(Object.assign({}, opts, {randomize: true})),
      accepted
    );
    result.attemptNo = n;
    result.attemptKind = 'random';
    const sig = resultSignature(result);
    if(!seen.has(sig)) seen.set(sig, result);
    n++;
  }
  return [...seen.values()].sort(compareOneOneResults);
}
async function scheduleAllOneToOneSearchAsync(opts, onTick){
  const accepted = (opts && opts.acceptedRows) || [];
  const target = Math.max(1, (opts && opts.attempts) || readOneOneSearchAttempts());
  const maxTries = Math.max(target, (opts && opts.maxTries) || oneOneSearchMaxTries(target));
  const seen = new Map();
  setSearchLiveHeadline(`Attempt 1 / ${target} — fewest teacher days first`);
  if(onTick) onTick(0, maxTries, `Starting 1 / ${target}`);
  await yieldUi();
  if(SEARCH_CANCELLED) return [];
  const first = attachOneOneLayoutScore(
    scheduleAllOneToOne(Object.assign({}, opts, {randomize: false})),
    accepted
  );
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  seen.set(resultSignature(first), first);
  searchLiveSay(`Attempt 1: ${oneOneResultLogLine(first)} — baseline kept.`, 'ok');
  if(onTick) onTick(1, maxTries, `1 / ${target} distinct · try 1`);
  await yieldUi();
  let n = 2;
  while(seen.size < target && n <= maxTries){
    if(SEARCH_CANCELLED) break;
    setSearchLiveHeadline(`Attempt ${n} / ${target} — shuffled mix`);
    const result = attachOneOneLayoutScore(
      scheduleAllOneToOne(Object.assign({}, opts, {randomize: true})),
      accepted
    );
    result.attemptNo = n;
    result.attemptKind = 'random';
    const sig = resultSignature(result);
    if(!seen.has(sig)){
      seen.set(sig, result);
      searchLiveSay(`Attempt ${n}: ${oneOneResultLogLine(result)} — distinct, ${seen.size} / ${target}.`, 'ok');
    } else if(n % 5 === 0){
      searchLiveSay(`Attempt ${n}: same week as an earlier try — discarded. ${seen.size} / ${target} so far.`, 'info');
    }
    if(onTick) onTick(n, maxTries, `${seen.size} / ${target} distinct · try ${n}`);
    n++;
    await yieldUi();
  }
  const variants = [...seen.values()].sort(compareOneOneResults);
  const best = variants[0];
  searchLiveSay(SEARCH_CANCELLED
    ? `Stopped after try ${n - 1}. Kept ${variants.length} layout(s); best: ${best ? oneOneResultLogLine(best) : '—'}.`
    : `${variants.length} distinct layout(s). Best: ${best ? oneOneResultLogLine(best) : '—'}.`,
    SEARCH_CANCELLED ? 'warn' : 'ok');
  return variants;
}
const VARIANT_LOOKAHEAD_ATTEMPTS = 1;
const VARIANT_LOOKAHEAD_MAX_TRIES = 1;
function compareScoreTuple(a, b){
  const n = Math.max((a || []).length, (b || []).length);
  for(let i=0;i<n;i++){
    const av = a && a[i] != null ? a[i] : 0;
    const bv = b && b[i] != null ? b[i] : 0;
    if(av !== bv) return av - bv;
  }
  return 0;
}
function variantLeftOut(v){
  return ((v && v.unresolved) || []).length;
}
function groupLookaheadScore(v){
  const L = (v && v.lookahead) || {};
  return [
    variantLeftOut(v),
    L.oneUnresolved == null ? 1e9 : L.oneUnresolved,
    L.pianoUnresolved == null ? 1e9 : L.pianoUnresolved,
    -(L.onePlaced || 0),
    -(L.pianoPlaced || 0)
  ];
}
function oneOneLookaheadScore(v){
  const L = (v && v.lookahead) || {};
  return [
    variantLeftOut(v),
    L.pianoUnresolved == null ? 1e9 : L.pianoUnresolved,
    -(L.pianoPlaced || 0)
  ];
}
function markSuggestedByLookahead(variants, scoreFn){
  (variants || []).forEach(v => { if(v) v.suggested = false; });
  if(!variants || !variants.length) return -1;
  let bestI = 0;
  let bestS = scoreFn(variants[0]);
  for(let i=1;i<variants.length;i++){
    const s = scoreFn(variants[i]);
    if(compareScoreTuple(s, bestS) < 0){
      bestI = i;
      bestS = s;
    }
  }
  if(variants[bestI]) variants[bestI].suggested = true;
  return bestI;
}
function suggestedVariantIndex(variants){
  const list = variants || [];
  const i = list.findIndex(v => v && v.suggested);
  return i >= 0 ? i : 0;
}
function withQuietSearchLog(fn){
  const prevQuiet = SearchLog.quiet;
  SearchLog.quiet = true;
  try { return fn(); }
  finally { SearchLog.quiet = prevQuiet; }
}
function probeBestIndividual(opts){
  return withQuietSearchLog(() => {
    const variants = scheduleAllOneToOneSearch(Object.assign({
      attempts: VARIANT_LOOKAHEAD_ATTEMPTS,
      maxTries: VARIANT_LOOKAHEAD_MAX_TRIES
    }, opts));
    return variants[0] || {scheduled: [], unresolved: []};
  });
}
function formatLookaheadLabel(L, kind){
  if(!L) return '';
  const bits = [];
  if(kind !== 'oneone' && L.oneTotal){
    bits.push(`1/1 ${L.onePlaced}/${L.oneTotal} placed, ${L.oneUnresolved} left out`);
  }
  if(L.pianoTotal){
    bits.push(`piano ${L.pianoPlaced}/${L.pianoTotal} placed, ${L.pianoUnresolved} left out`);
  }
  return bits.length ? ' · ' + bits.join(' · ') : '';
}
function variantDisplayName(i){
  return i === 0 ? 'Best' : `Variant ${i + 1}`;
}
function fillGroupLookahead(v, oneJobs, pianoJobs){
  const accepted = (buildAcceptedScheduleRows(v) || []).filter(r => r.status === 'scheduled');
  const one = oneJobs.length
    ? probeBestIndividual({matrix: DB.oneToOne, acceptedRows: accepted})
    : {scheduled: [], unresolved: []};
  const piano = pianoJobs.length
    ? probeBestIndividual({
        matrix: DB.rpiano,
        acceptedRows: accepted.concat(busyRowsFromScheduled(one.scheduled)),
        source: 'rpiano',
        lessonLabel: 'piano',
        idPrefix: 'RP'
      })
    : {scheduled: [], unresolved: []};
  v.lookahead = {
    oneUnresolved: one.unresolved.length,
    onePlaced: one.scheduled.length,
    oneTotal: oneJobs.length,
    pianoUnresolved: piano.unresolved.length,
    pianoPlaced: piano.scheduled.length,
    pianoTotal: pianoJobs.length
  };
}
function beginGroupLookahead(variants){
  const list = variants || [];
  const oneJobs = collectOneOneAssignments(DB.oneToOne);
  const pianoJobs = collectOneOneAssignments(DB.rpiano);
  list.forEach(v => {
    if(!v) return;
    v.suggested = false;
    v.lookahead = null;
  });
  if(!list.length || (!oneJobs.length && !pianoJobs.length)) return null;
  return {list, oneJobs, pianoJobs};
}
function attachGroupLookahead(variants, onTick){
  const prep = beginGroupLookahead(variants);
  if(!prep) return -1;
  const {list, oneJobs, pianoJobs} = prep;
  for(let i=0;i<list.length;i++){
    const v = list[i];
    if(!v) continue;
    if(onTick) onTick(i + 1, list.length);
    fillGroupLookahead(v, oneJobs, pianoJobs);
  }
  return markSuggestedByLookahead(list, groupLookaheadScore);
}
async function attachGroupLookaheadAsync(variants, onTick){
  const prep = beginGroupLookahead(variants);
  if(!prep) return -1;
  const {list, oneJobs, pianoJobs} = prep;
  for(let i=0;i<list.length;i++){
    const v = list[i];
    if(!v) continue;
    if(onTick) onTick(i + 1, list.length);
    await yieldUi();
    fillGroupLookahead(v, oneJobs, pianoJobs);
  }
  return markSuggestedByLookahead(list, groupLookaheadScore);
}
function attachOneOneLookahead(variants){
  const list = variants || [];
  const pianoJobs = collectOneOneAssignments(DB.rpiano);
  list.forEach(v => {
    if(!v) return;
    v.suggested = false;
    v.lookahead = null;
  });
  if(!list.length || !pianoJobs.length) return -1;
  const groupBusy = DB.acceptedSchedule || [];
  list.forEach(v => {
    const piano = probeBestIndividual({
      matrix: DB.rpiano,
      acceptedRows: groupBusy.concat(busyRowsFromScheduled(v.scheduled)),
      source: 'rpiano',
      lessonLabel: 'piano',
      idPrefix: 'RP'
    });
    v.lookahead = {
      pianoUnresolved: piano.unresolved.length,
      pianoPlaced: piano.scheduled.length,
      pianoTotal: pianoJobs.length
    };
  });
  return markSuggestedByLookahead(list, oneOneLookaheadScore);
}
async function attachOneOneLookaheadAsync(variants, onTick){
  const list = variants || [];
  const pianoJobs = collectOneOneAssignments(DB.rpiano);
  list.forEach(v => {
    if(!v) return;
    v.suggested = false;
    v.lookahead = null;
  });
  if(!list.length || !pianoJobs.length) return -1;
  const groupBusy = DB.acceptedSchedule || [];
  for(let i=0;i<list.length;i++){
    const v = list[i];
    if(!v) continue;
    if(SEARCH_CANCELLED) break;
    if(onTick) onTick(i + 1, list.length);
    await yieldUi();
    const piano = probeBestIndividual({
      matrix: DB.rpiano,
      acceptedRows: groupBusy.concat(busyRowsFromScheduled(v.scheduled)),
      source: 'rpiano',
      lessonLabel: 'piano',
      idPrefix: 'RP'
    });
    v.lookahead = {
      pianoUnresolved: piano.unresolved.length,
      pianoPlaced: piano.scheduled.length,
      pianoTotal: pianoJobs.length
    };
  }
  return markSuggestedByLookahead(list, oneOneLookaheadScore);
}
function variantOptionText(v, i, kind){
  const mark = v && v.suggested ? '★ ' : '';
  const name = variantDisplayName(i);
  const placed = ((v && v.scheduled) || []).length;
  const left = variantLeftOut(v);
  if(kind === 'group'){
    const sgTotal = getSmallGroupLessons().length;
    const sgLeft = ((v && v.unresolved) || []).filter(u => u.lesson && u.lesson.id && isSmallGroupId(u.lesson.id)).length;
    const sgOk = sgTotal - sgLeft;
    return `${mark}${name} · ${sgOk}/${sgTotal} SG · ${left} left`;
  }
  const pairs = oneOneCoverageCount(v);
  const extra = placed > pairs ? ` · ${placed} sessions` : '';
  return `${mark}${name} · ${pairs} placed${extra} · ${left} left`;
}
function lookaheadStatHtml(label, placed, total, left){
  if(!total) return '';
  const cls = left ? 'is-warn' : 'is-ok';
  return `<div class="variant-preview-stat ${cls}"><span class="variant-preview-k">${escapeAttr(label)}</span><span class="variant-preview-v">${placed}/${total}</span><span class="variant-preview-left">${left} left</span></div>`;
}
function renderLookaheadSummary(el, variants, kind, selectedIdx){
  if(!el) return;
  const v = (variants || [])[selectedIdx];
  const L = v && v.lookahead;
  if(!L){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const parts = [];
  if(kind !== 'oneone' && L.oneTotal){
    parts.push(lookaheadStatHtml('1/1 next', L.onePlaced, L.oneTotal, L.oneUnresolved));
  }
  if(L.pianoTotal){
    parts.push(lookaheadStatHtml('Piano next', L.pianoPlaced, L.pianoTotal, L.pianoUnresolved));
  }
  if(!parts.length){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = parts.join('');
}
function stripLookaheadLogSection(lines){
  const list = lines || [];
  const i = list.findIndex(l => l && l.type === 'section' && l.text === 'Lookahead');
  if(i < 0) return list.slice();
  return list.slice(0, i);
}
function lookaheadLogLines(v, i, kind){
  const mark = v && v.suggested ? '★ ' : '';
  const name = mark + variantDisplayName(i);
  const bits = formatLookaheadLabel(v && v.lookahead, kind).replace(/^ · /, '');
  const lines = [{type:'section', text:'Lookahead'}];
  if(bits) lines.push({type:'ok', text:`${name}: ${bits}`});
  else lines.push({type:'info', text:`${name}: no 1/1 or piano hours to preview`});
  return lines;
}
function logGroupLookahead(variants){
  const list = variants || [];
  if(!list.length) return;
  const starI = suggestedVariantIndex(list);
  const v = list[starI];
  if(v && v.lookahead){
    SearchLog.section('Lookahead');
    SearchLog.info(lookaheadEveryLayoutEnabled()
      ? 'Every distinct layout was probed with a deterministic 1/1 pack, then Required Piano in those leftover holes. ★ is the layout with the fewest leftover items on this tab (every unplaced lesson, not small groups first), then fewest unplaced 1/1, then fewest unplaced piano. Search log and the Solution list open on ★.'
      : `The best ${SCHEDULE_VARIANT_KEEP} layouts were probed with a deterministic 1/1 pack, then Required Piano in those leftover holes. ★ is the layout with the fewest leftover items among those (every unplaced lesson, not small groups first), then fewest unplaced 1/1, then fewest unplaced piano. Search log and the Solution list open on ★.`);
    const bits = formatLookaheadLabel(v.lookahead, 'group').replace(/^ · /, '') || 'no 1/1 or piano hours to preview';
    SearchLog.ok(`★ ${variantDisplayName(starI)}: ${bits}`);
    if(starI > 0 && list[0] && list[0].lookahead){
      const other = formatLookaheadLabel(list[0].lookahead, 'group').replace(/^ · /, '');
      SearchLog.info(`Best (fewest leftover items, then least idle) is still the first option${other ? ': ' + other : ''}.`);
    }
  }
  list.forEach((item, i) => {
    if(!item || !item.lookahead) return;
    item.searchLog = stripLookaheadLogSection(item.searchLog).concat(lookaheadLogLines(item, i, 'group'));
  });
}
function collectSwappableGroupLessons(){
  return (DB.lessons || []).filter(l =>
    l && l.id && !isSmallGroupId(l.id) && l.teacherId && !l.fixedDay
    && lessonDurationMinutes(l) > 0
  );
}
function matchLessonsByDuration(listA, listB){
  const bucket = list => {
    const m = {};
    (list || []).slice().sort((a,b) => String(a.id).localeCompare(String(b.id))).forEach(l => {
      const d = lessonDurationMinutes(l);
      (m[d] = m[d] || []).push(l);
    });
    return m;
  };
  const a = bucket(listA), b = bucket(listB);
  const pairs = [];
  Object.keys(a).sort((x,y) => Number(x) - Number(y)).forEach(d => {
    const la = a[d], lb = b[d] || [];
    const n = Math.min(la.length, lb.length);
    for(let i=0;i<n;i++) pairs.push([la[i], lb[i]]);
  });
  return pairs;
}
function describeTeacherSwap(cand){
  const pairBits = ((cand && cand.pairs) || []).map(([a,b]) => {
    const d = lessonDurationMinutes(a);
    const ta = (a && (a.teacher || teacherName(a.teacherId))) || (a && a.teacherId) || '';
    const tb = (b && (b.teacher || teacherName(b.teacherId))) || (b && b.teacherId) || '';
    return `${(a && (a.name || a.id)) || '?'} (${ta}) ↔ ${(b && (b.name || b.id)) || '?'} (${tb}) · ${d} min`;
  });
  if(cand && cand.kind === 'teachers' && pairBits.length > 1){
    const a = cand.pairs[0][0], b = cand.pairs[0][1];
    const ta = (a && (a.teacher || teacherName(a.teacherId))) || (a && a.teacherId) || '';
    const tb = (b && (b.teacher || teacherName(b.teacherId))) || (b && b.teacherId) || '';
    return `If Generate had swapped ${ta} and ${tb} on their matching group lessons (${pairBits.join('; ')})`;
  }
  return pairBits.length ? `If Generate had swapped ${pairBits.join('; ')}` : '';
}
function collectTeacherSwapCandidates(){
  const lessons = collectSwappableGroupLessons();
  const oneTeachers = new Set(collectOneOneAssignments(DB.oneToOne).concat(collectOneOneAssignments(DB.rpiano)).map(a => a.teacherId));
  const byTeacher = {};
  lessons.forEach(l => {
    (byTeacher[l.teacherId] = byTeacher[l.teacherId] || []).push(l);
  });
  Object.keys(byTeacher).forEach(tid => {
    byTeacher[tid].sort((a,b) => String(a.id).localeCompare(String(b.id)));
  });
  const seen = new Set();
  const out = [];
  function addPairs(pairs, kind){
    if(!pairs || !pairs.length) return;
    if(pairs.some(([a,b]) => !a || !b || a.teacherId === b.teacherId || a.id === b.id)) return;
    const key = pairs.map(p => [p[0].id, p[1].id].sort().join('|')).sort().join(';');
    if(seen.has(key)) return;
    seen.add(key);
    const cand = {kind, pairs, label: ''};
    cand.label = describeTeacherSwap(cand);
    out.push(cand);
  }
  const byDurTeacher = {};
  lessons.forEach(l => {
    const d = lessonDurationMinutes(l);
    byDurTeacher[d] = byDurTeacher[d] || {};
    if(!byDurTeacher[d][l.teacherId]) byDurTeacher[d][l.teacherId] = l;
  });
  Object.keys(byDurTeacher).forEach(d => {
    const tids = Object.keys(byDurTeacher[d]).sort();
    for(let i=0;i<tids.length;i++){
      for(let j=i+1;j<tids.length;j++){
        addPairs([[byDurTeacher[d][tids[i]], byDurTeacher[d][tids[j]]]], 'lesson');
      }
    }
  });
  const tids = Object.keys(byTeacher).sort();
  for(let i=0;i<tids.length;i++){
    for(let j=i+1;j<tids.length;j++){
      const matched = matchLessonsByDuration(byTeacher[tids[i]], byTeacher[tids[j]]);
      if(matched.length >= 2) addPairs(matched, 'teachers');
    }
  }
  out.sort((a,b) => {
    const score = c => {
      const ts = new Set(c.pairs.flatMap(p => [p[0].teacherId, p[1].teacherId]));
      return [...ts].filter(t => oneTeachers.has(t)).length;
    };
    return score(b) - score(a) || String(a.label).localeCompare(String(b.label));
  });
  return out.slice(0, TEACHER_SWAP_EVAL_MAX);
}
function withLessonTeacherSwaps(pairs, fn){
  const snap = [];
  (pairs || []).forEach(([a,b]) => {
    if(!a || !b) return;
    snap.push({l:a, teacherId:a.teacherId, teacher:a.teacher});
    snap.push({l:b, teacherId:b.teacherId, teacher:b.teacher});
  });
  (pairs || []).forEach(([a,b]) => {
    if(!a || !b) return;
    const ta = a.teacherId, na = a.teacher;
    a.teacherId = b.teacherId;
    a.teacher = b.teacher;
    b.teacherId = ta;
    b.teacher = na;
  });
  try { return fn(); }
  finally {
    snap.forEach(s => {
      s.l.teacherId = s.teacherId;
      s.l.teacher = s.teacher;
    });
  }
}
async function withLessonTeacherSwapsAsync(pairs, fn){
  const snap = [];
  (pairs || []).forEach(([a,b]) => {
    if(!a || !b) return;
    snap.push({l:a, teacherId:a.teacherId, teacher:a.teacher});
    snap.push({l:b, teacherId:b.teacherId, teacher:b.teacher});
  });
  (pairs || []).forEach(([a,b]) => {
    if(!a || !b) return;
    const ta = a.teacherId, na = a.teacher;
    a.teacherId = b.teacherId;
    a.teacher = b.teacher;
    b.teacherId = ta;
    b.teacher = na;
  });
  try { return await fn(); }
  finally {
    snap.forEach(s => {
      s.l.teacherId = s.teacherId;
      s.l.teacher = s.teacher;
    });
  }
}
function teacherSwapSearchAttempts(candCount){
  const want = Math.max(1, Math.min(TEACHER_SWAP_SEARCH_ATTEMPTS, readScheduleSearchAttempts()));
  const n = Math.max(1, candCount || 1);
  return Math.max(1, Math.min(want, Math.ceil(TEACHER_SWAP_PACK_BUDGET / n)));
}
function considerSwapPack(best, result, oneJobs, pianoJobs){
  fillGroupLookahead(result, oneJobs, pianoJobs);
  if(!best || compareScoreTuple(groupLookaheadScore(result), groupLookaheadScore(best)) < 0) return result;
  return best;
}
function searchBestLayoutWithLookahead(attempts){
  attempts = Math.max(1, attempts || 1);
  const oneJobs = collectOneOneAssignments(DB.oneToOne);
  const pianoJobs = collectOneOneAssignments(DB.rpiano);
  let best = null;
  for(let i = 0; i < attempts; i++){
    if(SEARCH_CANCELLED) break;
    const result = runScheduler(i > 0, {quiet: true});
    result.swapAttempts = i + 1;
    best = considerSwapPack(best, result, oneJobs, pianoJobs);
  }
  if(best) best.swapSearchAttempts = attempts;
  return best;
}
async function searchBestLayoutWithLookaheadAsync(attempts, onTick){
  attempts = Math.max(1, attempts || 1);
  const oneJobs = collectOneOneAssignments(DB.oneToOne);
  const pianoJobs = collectOneOneAssignments(DB.rpiano);
  let best = null;
  for(let i = 0; i < attempts; i++){
    if(SEARCH_CANCELLED) break;
    if(onTick) onTick(i + 1, attempts);
    const result = runScheduler(i > 0, {quiet: true});
    result.swapAttempts = i + 1;
    best = considerSwapPack(best, result, oneJobs, pianoJobs);
    await yieldUi();
  }
  if(best) best.swapSearchAttempts = attempts;
  return best;
}
function evaluateHypotheticalTeacherSwap(pairs, attempts){
  return withLessonTeacherSwaps(pairs, () => searchBestLayoutWithLookahead(attempts));
}
async function evaluateHypotheticalTeacherSwapAsync(pairs, attempts, onTick){
  return withLessonTeacherSwapsAsync(pairs, () => searchBestLayoutWithLookaheadAsync(attempts, onTick));
}
function teacherSwapBeats(baseline, hyp){
  if(!baseline || !hyp) return false;
  return compareScoreTuple(groupLookaheadScore(hyp), groupLookaheadScore(baseline)) < 0;
}
function teacherSwapDeltaLine(sugg, baseline){
  const bL = (baseline && baseline.lookahead) || {};
  const sL = (sugg && sugg.lookahead) || {};
  const parts = [];
  const bLeft = variantLeftOut(baseline);
  const sLeft = sugg && sugg.unresolvedN != null ? sugg.unresolvedN : variantLeftOut(sugg);
  if(sLeft !== bLeft) parts.push(`group leftover ${sLeft} instead of ${bLeft}`);
  if(sL.oneUnresolved != null && bL.oneUnresolved != null && sL.oneUnresolved !== bL.oneUnresolved){
    parts.push(`1/1 left ${sL.oneUnresolved} instead of ${bL.oneUnresolved}`);
  }
  if(sL.pianoUnresolved != null && bL.pianoUnresolved != null && sL.pianoUnresolved !== bL.pianoUnresolved){
    parts.push(`piano left ${sL.pianoUnresolved} instead of ${bL.pianoUnresolved}`);
  }
  return parts.join(', ') || 'a better leftover preview';
}
function recordTeacherSwapHits(baseline, cands, onTick){
  const better = [];
  const attempts = teacherSwapSearchAttempts((cands || []).length);
  for(let i=0;i<cands.length;i++){
    if(SEARCH_CANCELLED) break;
    if(onTick) onTick(i + 1, cands.length);
    const hyp = evaluateHypotheticalTeacherSwap(cands[i].pairs, attempts);
    if(!teacherSwapBeats(baseline, hyp)) continue;
    better.push(teacherSwapHitFrom(cands[i], hyp));
  }
  better.sort((a,b) => compareScoreTuple(
    groupLookaheadScore({unresolved: Array(a.unresolvedN), lookahead: a.lookahead}),
    groupLookaheadScore({unresolved: Array(b.unresolvedN), lookahead: b.lookahead})
  ));
  return better.slice(0, TEACHER_SWAP_KEEP);
}
function teacherSwapHitFrom(cand, hyp){
  return {
    kind: cand.kind,
    label: cand.label,
    pairs: cand.pairs.map(([a,b]) => [
      {id:a.id, name:a.name, teacherId:a.teacherId, teacher:a.teacher, duration:lessonDurationMinutes(a)},
      {id:b.id, name:b.name, teacherId:b.teacherId, teacher:b.teacher, duration:lessonDurationMinutes(b)}
    ]),
    lookahead: hyp && hyp.lookahead,
    unresolvedN: (((hyp && hyp.unresolved) || []).length),
    scheduledN: (((hyp && hyp.scheduled) || []).length),
    swapSearchAttempts: (hyp && hyp.swapSearchAttempts) || 1
  };
}
function clearTeacherSwapsOnLayouts(variants){
  (variants || []).forEach(v => { if(v) v.teacherSwaps = []; });
  LAST_TEACHER_SWAP_SUGGESTIONS = [];
}
function selectedTeacherSwaps(){
  return (LAST_RESULT && LAST_RESULT.teacherSwaps) || LAST_TEACHER_SWAP_SUGGESTIONS || [];
}
function attachTeacherSwapsToLayouts(variants, evaluated){
  (variants || []).forEach(v => {
    if(!v) return;
    const hits = [];
    (evaluated || []).forEach(e => {
      if(teacherSwapBeats(v, e.hyp)) hits.push(teacherSwapHitFrom(e.cand, e.hyp));
    });
    hits.sort((a,b) => compareScoreTuple(
      groupLookaheadScore({unresolved: Array(a.unresolvedN), lookahead: a.lookahead}),
      groupLookaheadScore({unresolved: Array(b.unresolvedN), lookahead: b.lookahead})
    ));
    v.teacherSwaps = hits.slice(0, TEACHER_SWAP_KEEP);
  });
  LAST_TEACHER_SWAP_SUGGESTIONS = selectedTeacherSwaps();
}
function collectTeacherSwapSuggestions(baseline){
  LAST_TEACHER_SWAP_SUGGESTIONS = [];
  if(!baseline) return [];
  if(!teacherSwapProbeEnabled()) return [];
  const hits = recordTeacherSwapHits(baseline, collectTeacherSwapCandidates(), null);
  baseline.teacherSwaps = hits;
  LAST_TEACHER_SWAP_SUGGESTIONS = hits;
  return hits;
}
function collectTeacherSwapSuggestionsForLayouts(variants){
  const list = variants || [];
  if(!teacherSwapProbeEnabled()){
    clearTeacherSwapsOnLayouts(list);
    return [];
  }
  const cands = collectTeacherSwapCandidates();
  const attempts = teacherSwapSearchAttempts(cands.length);
  const evaluated = [];
  for(let i=0;i<cands.length;i++){
    if(SEARCH_CANCELLED) break;
    evaluated.push({cand: cands[i], hyp: evaluateHypotheticalTeacherSwap(cands[i].pairs, attempts)});
  }
  attachTeacherSwapsToLayouts(list, evaluated);
  return selectedTeacherSwaps();
}
async function collectTeacherSwapSuggestionsForLayoutsAsync(variants, onTick){
  const list = variants || [];
  if(!teacherSwapProbeEnabled()){
    clearTeacherSwapsOnLayouts(list);
    return [];
  }
  const cands = collectTeacherSwapCandidates();
  const attempts = teacherSwapSearchAttempts(cands.length);
  const evaluated = [];
  const total = Math.max(1, cands.length);
  for(let i=0;i<cands.length;i++){
    if(SEARCH_CANCELLED) break;
    if(onTick) onTick(i + 1, total, `Teacher swap ${i + 1} / ${total}`);
    await yieldUi();
    evaluated.push({
      cand: cands[i],
      hyp: await evaluateHypotheticalTeacherSwapAsync(cands[i].pairs, attempts, (done, n) => {
        if(onTick) onTick(i + 1, total, `Teacher swap ${i + 1} / ${total} · pack ${done} / ${n}`);
      })
    });
  }
  attachTeacherSwapsToLayouts(list, evaluated);
  (list || []).forEach((v, i) => {
    const n = ((v && v.teacherSwaps) || []).length;
    if(n) searchLiveSay(`${variantDisplayName(i)}: ${n} improving swap(s) — not applied.`, 'ok');
    else searchLiveSay(`${variantDisplayName(i)}: no improving swap.`, 'info');
  });
  return selectedTeacherSwaps();
}
function stripTeacherSwapLogSection(lines){
  const list = lines || [];
  const i = list.findIndex(l => l && l.type === 'section' && l.text === 'Hypothetical teacher swaps');
  if(i < 0) return list.slice();
  return list.slice(0, i);
}
function teacherSwapLogLines(v, i){
  const hits = (v && v.teacherSwaps) || [];
  const name = (v && v.suggested ? '★ ' : '') + variantDisplayName(i);
  const lines = [{type:'section', text:'Hypothetical teacher swaps'}];
  lines.push({type:'info', text:'Each swap re-ran the group search (shuffled packs) and a 1/1 preview, then kept the better leftover week. The Lesson groups table and the grid were not changed.'});
  if(!hits.length){
    lines.push({type:'info', text:`${name}: no improving swap.`});
    return lines;
  }
  hits.forEach(s => {
    lines.push({type:'ok', text:`${name}: ${s.label} — ${teacherSwapDeltaLine(s, v)}.`});
  });
  return lines;
}
function logTeacherSwapSuggestions(){
  const list = LAST_VARIANTS || [];
  if(!teacherSwapProbeEnabled()){
    list.forEach(item => {
      if(item) item.searchLog = stripTeacherSwapLogSection(item.searchLog);
    });
    return;
  }
  SearchLog.section('Hypothetical teacher swaps');
  const any = list.some(v => v && v.teacherSwaps && v.teacherSwaps.length);
  if(!any){
    SearchLog.info('Re-ran the group search with each same-duration teacher swap (shuffled packs + 1/1 preview). None beat leftover 1/1 / piano. The Lesson groups table and the grid were not changed.');
  } else {
    SearchLog.info('Re-ran the group search with each same-duration teacher swap. These staffing swaps were not applied — change the teacher on those Lesson groups rows and Generate again if you want them.');
    list.forEach((v, i) => {
      const n = ((v && v.teacherSwaps) || []).length;
      if(n) SearchLog.ok(`${v && v.suggested ? '★ ' : ''}${variantDisplayName(i)}: ${n} improving swap(s).`);
      else SearchLog.info(`${variantDisplayName(i)}: no improving swap.`);
    });
  }
  list.forEach((item, i) => {
    if(!item) return;
    item.searchLog = stripTeacherSwapLogSection(item.searchLog).concat(teacherSwapLogLines(item, i));
  });
}
function renderTeacherSwapSuggestions(){
  const el = document.getElementById('teacherSwapSuggestions');
  if(!el) return;
  if(!teacherSwapProbeEnabled()){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const v = LAST_RESULT;
  const list = (v && v.teacherSwaps) || [];
  LAST_TEACHER_SWAP_SUGGESTIONS = list;
  if(!list.length){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `<p class="teacher-swap-suggest-title">If teachers had been swapped during Generate — not applied</p><ul>` +
    list.map(s => `<li>${escapeAttr(s.label)} — ${escapeAttr(teacherSwapDeltaLine(s, v))}.</li>`).join('') +
    `</ul>`;
}
function individualSearchFingerprint(kind, scopeTeacherId){
  const matrix = kind === 'rpiano' ? DB.rpiano : DB.oneToOne;
  const prev = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  const kept = scopeTeacherId
    ? ((prev && prev.scheduled) || [])
      .filter(s => s.teacherId !== scopeTeacherId)
      .map(s => [s.lessonId, s.day, s.start, s.end, s.teacherId])
    : [];
  return JSON.stringify({
    kind,
    scopeTeacherId: scopeTeacherId || '',
    kept,
    accepted: (DB.acceptedSchedule || []).map(r => [r.lessonId, r.day, r.start, r.end, r.teacherId]),
    oneone: kind === 'rpiano' ? ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).map(s => [s.lessonId, s.day, s.start, s.end]) : null,
    hours: (matrix && matrix.hours) || {},
    rooms: ((matrix && matrix.columns) || []).map(c => [c.id, c.roomId || '']),
    studentRooms: Object.keys((matrix && matrix.studentRooms) || {}).sort().map(sid => [sid, (matrix.studentRooms[sid] && matrix.studentRooms[sid].roomId) || ''])
  });
}
function assignmentsForGenerate(matrix, teacherId){
  const all = collectOneOneAssignments(matrix);
  if(!teacherId) return all;
  return all.filter(a => a.teacherId === teacherId);
}
function cloneIndividualKeep(state, teacherId){
  if(!teacherId) return {scheduled: [], unresolved: []};
  return {
    scheduled: JSON.parse(JSON.stringify((state && state.scheduled || []).filter(s => s.teacherId !== teacherId))),
    unresolved: JSON.parse(JSON.stringify((state && state.unresolved || []).filter(u => u.teacherId !== teacherId)))
  };
}
function mergeKeptIntoVariants(variants, keep){
  const keptSched = (keep && keep.scheduled) || [];
  const keptUn = (keep && keep.unresolved) || [];
  if(!keptSched.length && !keptUn.length) return variants || [];
  return (variants || []).map(v => {
    const scheduled = keptSched.concat((v.scheduled || []).map(s => Object.assign({}, s)));
    scheduled.sort((a,b) => String(a.teacher||'').localeCompare(String(b.teacher||'')) || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
    return Object.assign({}, v, {
      scheduled,
      unresolved: keptUn.concat(v.unresolved || [])
    });
  });
}
function individualSearchOpts(kind, assignments, keep){
  const attempts = readOneOneSearchAttempts(kind);
  const base = {
    assignments,
    existingOneOne: keep && keep.scheduled,
    attempts,
    maxTries: oneOneSearchMaxTries(attempts)
  };
  if(kind === 'rpiano'){
    return Object.assign(base, {
      acceptedRows: (DB.acceptedSchedule || []).concat(busyRowsFromScheduled(LAST_ONEONE && LAST_ONEONE.scheduled)),
      source: 'rpiano',
      lessonLabel: 'piano',
      idPrefix: 'RP'
    });
  }
  return Object.assign(base, {acceptedRows: DB.acceptedSchedule || []});
}
function generateIndividualScoped(kind, scopeTeacherId){
  const matrix = kind === 'rpiano' ? ensureRpianoMatrix() : ensureOneToOneMatrix();
  const assignments = assignmentsForGenerate(matrix, scopeTeacherId);
  const keep = cloneIndividualKeep(kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE, scopeTeacherId);
  return {
    assignments,
    keep,
    variants: mergeKeptIntoVariants(scheduleAllOneToOneSearch(individualSearchOpts(kind, assignments, keep)), keep)
  };
}
async function generateIndividualScopedAsync(kind, scopeTeacherId, onTick){
  const matrix = kind === 'rpiano' ? ensureRpianoMatrix() : ensureOneToOneMatrix();
  const assignments = assignmentsForGenerate(matrix, scopeTeacherId);
  const keep = cloneIndividualKeep(kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE, scopeTeacherId);
  const variants = await scheduleAllOneToOneSearchAsync(individualSearchOpts(kind, assignments, keep), onTick);
  return {
    assignments,
    keep,
    variants: mergeKeptIntoVariants(variants, keep)
  };
}
function fillIndividualGenerateTeacherSelect(sel, matrix){
  if(!sel) return;
  const ids = [...new Set(collectOneOneAssignments(matrix).map(a => a.teacherId).filter(Boolean))]
    .sort((a,b) => String(teacherName(a)||a).localeCompare(String(teacherName(b)||b)));
  const current = sel.value;
  const pick = ids.includes(current) ? current : '';
  sel.innerHTML = `<option value="">All teachers</option>` + ids.map(id =>
    `<option value="${escapeAttr(id)}"${id===pick?' selected':''}>${escapeAttr(teacherName(id)||id)}</option>`
  ).join('');
}
function individualGenerateBtnLabel(kind){
  const sel = document.getElementById(kind === 'rpiano' ? 'rpianoGenerateTeacher' : 'oneoneGenerateTeacher');
  const tid = sel && sel.value;
  const who = tid ? (teacherName(tid) || tid) : '';
  if(kind === 'rpiano') return who ? `▶ Generate ${who}` : '▶ Generate Required Piano';
  return who ? `▶ Generate 1/1 · ${who}` : '▶ Generate all 1/1';
}
function applyIndividualSearch(kind, fresh, viewTeacherId, scopeTeacherId){
  const fp = individualSearchFingerprint(kind, scopeTeacherId);
  const prev = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  let variants = fresh || [];
  if(prev && prev.inputFingerprint === fp && prev.variants && prev.variants.length){
    variants = mergeIndividualVariants(prev.variants, fresh);
  }
  const best = variants[0] || {scheduled: [], unresolved: []};
  const state = {
    viewTeacherId: viewTeacherId || (best.scheduled[0] && best.scheduled[0].teacherId) || '',
    scheduled: best.scheduled,
    unresolved: best.unresolved,
    accepted: false,
    variants,
    selectedIndex: 0,
    inputFingerprint: fp
  };
  if(kind === 'rpiano') LAST_RPIANO = state;
  else {
    LAST_ONEONE = state;
    LAST_RPIANO = null;
  }
  return state;
}
function populateIndividualVariantSelector(kind){
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  const row = document.getElementById(kind === 'rpiano' ? 'rpianoVariantRow' : 'oneoneVariantRow');
  const sel = document.getElementById(kind === 'rpiano' ? 'rpianoVariantSelect' : 'oneoneVariantSelect');
  if(!row || !sel) return;
  const variants = (state && state.variants) || [];
  const idx = variants.length
    ? Math.max(0, Math.min((state && state.selectedIndex) || 0, variants.length - 1))
    : 0;
  const many = variants.length > 1;
  row.style.display = many ? 'flex' : 'none';
  if(many){
    sel.innerHTML = variants.map((v, i) =>
      `<option value="${i}">${variantOptionText(v, i, kind)}</option>`
    ).join('');
    sel.value = String(idx);
  }
  if(kind === 'oneone'){
    renderLookaheadSummary(document.getElementById('oneoneLookaheadSummary'), variants, 'oneone', idx);
  }
}
function selectIndividualVariant(kind, idx){
  if(SEARCH_UI_LOCK) return;
  const state = kind === 'rpiano' ? LAST_RPIANO : LAST_ONEONE;
  if(!state || !state.variants || !state.variants[idx]) return;
  const v = state.variants[idx];
  state.selectedIndex = idx;
  state.scheduled = v.scheduled;
  state.unresolved = v.unresolved;
  state.accepted = false;
  state.dragUndo = [];
  state.dragBaseline = null;
  if(kind === 'rpiano'){
    renderRpianoTab();
  } else {
    LAST_RPIANO = null;
    renderOneOneTab();
    updateAllTabLocks();
  }
  markWorkDirty();
}

function isTimetableAccepted(){
  return !!(LAST_RESULT && LAST_RESULT.accepted && (LAST_RESULT.scheduled || []).length);
}
function canOpenOneOne(){
  return isTimetableAccepted();
}
function canOpenReports(){
  return isTimetableAccepted() || hasAcceptedOneOne() || hasAcceptedRpiano();
}
function updateAllTabLocks(){
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const tab = btn.dataset.tab;
    const ok = SEARCH_UI_LOCK ? false : canSwitchTab(tab);
    btn.classList.toggle('is-locked', !ok);
    btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    const reason = SEARCH_UI_LOCK
      ? 'Search is running — wait until it finishes.'
      : (ok ? '' : tabLockReason(tab));
    if(reason) btn.title = reason;
    else if(tab === 'oneone') btn.title = '1/1 individual lessons';
    else if(tab === 'rpiano') btn.title = 'Required Piano';
    else if(tab === 'reports') btn.title = 'Filter the week calendar';
    else btn.removeAttribute('title');
  });
}
function updateOneOneTabLock(){ updateAllTabLocks(); }
function updateRpianoTabLock(){ updateAllTabLocks(); }
function hasAcceptedOneOne(){
  return !!(LAST_ONEONE && LAST_ONEONE.accepted && (LAST_ONEONE.scheduled || []).length);
}
function hasAcceptedRpiano(){
  return !!(LAST_RPIANO && LAST_RPIANO.accepted && (LAST_RPIANO.scheduled || []).length);
}
function canOpenRpiano(){
  return canOpenOneOne() && hasAcceptedOneOne();
}
function busyRowsFromScheduled(items){
  return (items || []).filter(s => s && s.day && s.start != null && s.end != null).map(s => {
    let ids = s.studentIds || s.studentId || '';
    if(!String(ids).trim()){
      ids = studentsForScheduledItem(s).map(st => st.ID).filter(Boolean).join(', ');
    }
    return {
      status: 'scheduled',
      teacherId: s.teacherId,
      day: s.day,
      start: s.start,
      end: s.end,
      studentIds: ids,
      name: s.name || '',
      ...roomFieldsOf(s)
    };
  });
}
function teacherIndividualItems(teacherId, kind){
  if(!teacherId) return [];
  const one = ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).filter(s => s.teacherId === teacherId);
  const piano = ((LAST_RPIANO && LAST_RPIANO.scheduled) || []).filter(s => s.teacherId === teacherId);
  const showOne = kind === 'oneone' || hasAcceptedOneOne();
  const showPiano = kind === 'rpiano' || hasAcceptedRpiano();
  return (showOne ? one : []).concat(showPiano ? piano : []).filter(i => i.start != null && i.end != null && i.day);
}
function oneoneAcceptedItemsForTeacher(teacherId){
  return (DB.acceptedSchedule || []).filter(r => r.status === 'scheduled' && r.teacherId === teacherId && r.day && toMin(r.start) != null).map(r => ({
    lessonId: r.lessonId || ('ACC-' + r.name),
    name: r.name || '',
    teacherId: r.teacherId,
    teacher: r.teacher,
    day: r.day,
    start: toMin(r.start),
    end: toMin(r.end),
    studentCount: r.studentCount || parseIdList(r.studentIds).length,
    studentNames: r.students ? String(r.students).split(',').map(x => x.trim()).filter(Boolean) : [],
    studentIds: r.studentIds || '',
    ...roomFieldsOf(r),
    source: 'accepted'
  }));
}
function teacherWeekItems(teacherId, kind){
  if(!teacherId) return [];
  return oneoneAcceptedItemsForTeacher(teacherId)
    .concat(teacherIndividualItems(teacherId, kind))
    .filter(i => i.start != null && i.end != null && i.day);
}
function individualTeacherIds(kind){
  const ids = [];
  if(kind !== 'rpiano'){
    collectOneOneAssignments(DB.oneToOne).forEach(a => { if(a.teacherId) ids.push(a.teacherId); });
    ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).forEach(s => { if(s.teacherId) ids.push(s.teacherId); });
  }
  if(kind !== 'oneone'){
    collectOneOneAssignments(DB.rpiano).forEach(a => { if(a.teacherId) ids.push(a.teacherId); });
    ((LAST_RPIANO && LAST_RPIANO.scheduled) || []).forEach(s => { if(s.teacherId) ids.push(s.teacherId); });
  }
  return [...new Set(ids)].sort((a,b) => String(teacherName(a)||a).localeCompare(String(teacherName(b)||b)));
}
function fillIndividualTeacherFilter(sel, stateObj, emptyLabel, kind){
  if(!sel) return;
  const ids = individualTeacherIds(kind);
  if(!ids.length){
    sel.innerHTML = `<option value="">${emptyLabel}</option>`;
    return;
  }
  const current = (stateObj && stateObj.viewTeacherId) || sel.value || ids[0];
  const pick = ids.includes(current) ? current : ids[0];
  sel.innerHTML = ids.map(id => `<option value="${escapeAttr(id)}" ${id===pick?'selected':''}>${escapeAttr(teacherName(id)||id)}</option>`).join('');
  if(stateObj) stateObj.viewTeacherId = sel.value;
}
function renderTeacherWeekGrid(grid, sel, stateObj, emptyHtml, kind){
  if(!grid) return;
  fillIndividualTeacherFilter(sel, stateObj, '— generate first —', kind);
  const teacherId = (sel && sel.value) || (stateObj && stateObj.viewTeacherId) || '';
  const items = teacherWeekItems(teacherId, kind);
  LAST_AUDIT = auditTimetable(combinedWeekItems(kind));
  if(!items.length){
    grid.innerHTML = emptyHtml;
    const wrap = document.getElementById((kind === 'rpiano' ? 'rpiano' : 'oneone') + 'AuditWrap');
    if(wrap) wrap.style.display = 'none';
    updateIndividualUndo(kind);
    return;
  }
  renderCalendar(grid, items, false, kind);
  attachHoverTooltips(grid);
  attachCalendarDrag(grid);
  renderAuditPanel({
    prefix: kind === 'rpiano' ? 'rpiano' : 'oneone',
    lessonIds: items.map(i => i.lessonId).filter(Boolean)
  });
  updateIndividualUndo(kind);
}

function renderOneOneGrid(){
  renderTeacherWeekGrid(
    document.getElementById('oneoneGrid'),
    document.getElementById('oneoneTeacherFilter'),
    LAST_ONEONE,
    '<p class="dataio-hint" style="margin:0">Open the 1/1 matrix, then Generate all 1/1. Pick a teacher here to see grey accepted blocks, gold 1/1, and teal Required Piano.</p>',
    'oneone'
  );
}

function renderHoursMatrixPanel(opts){
  const box = document.getElementById(opts.wrapId);
  const countEl = document.getElementById(opts.countId);
  if(!box) return;
  const m = opts.matrix || {columns: [], hours: {}};
  const cols = m.columns || [];
  const q = (document.getElementById(opts.filterId) || {}).value || '';
  const qn = String(q).trim().toLowerCase();
  const students = (DB.students || []).filter(s => {
    if(!qn) return true;
    const blob = `${studentDisplayName(s)} ${s.ID} ${instrName(s.INSTR_ID)||''}`.toLowerCase();
    return blob.includes(qn);
  });
  const assignments = collectOneOneAssignments(m);
  if(countEl){
    countEl.textContent = `${assignments.length} filled cells · ${students.length} student${students.length===1?'':'s'}`;
  }
  if(!cols.length){
    box.innerHTML = `<p class="dataio-hint" style="padding:12px;margin:0">${opts.emptyHtml}</p>`;
    return;
  }
  const rooms = (DB.refRooms || []).slice().sort((a,b) => String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const head = `<thead><tr>
    <th class="is-sticky">Student</th>
    <th class="oneone-roomcol">Room</th>
    ${cols.map(c => `<th class="oneone-tcol">${escapeAttr(c.name)}</th>`).join('')}
  </tr></thead>`;
  const body = students.map(s => {
    const cells = cols.map(c => {
      const val = formatOneOneHours(((m.hours || {})[s.ID] || {})[c.id]);
      const filled = val ? ' is-filled' : '';
      return `<td class="oneone-tcol${filled}"><input type="number" class="oneone-cell" data-sid="${escapeAttr(s.ID)}" data-tid="${escapeAttr(c.id)}" min="0" max="6" step="0.5" value="${escapeAttr(val)}" title="Hours with ${escapeAttr(c.name)} (1 = 60 min)"></td>`;
    }).join('');
    const rid = itemRoomId(studentMatrixRoom(m, s.ID));
    const optsHtml = rooms.map(r => `<option value="${escapeAttr(r.id)}" ${r.id===rid?'selected':''}>${escapeAttr(r.name || r.id)}</option>`).join('');
    return `<tr>
      <td class="is-sticky"><div class="oneone-sid">${escapeAttr(s.ID)}</div><div class="oneone-sname">${escapeAttr(studentDisplayName(s))}</div><div class="meta" style="font-size:10px;color:var(--ink-dim)">${escapeAttr(instrName(s.INSTR_ID)||'—')}</div></td>
      <td class="oneone-roomcol"><select class="oneone-col-room" data-sid="${escapeAttr(s.ID)}" title="Lock this student's individual lessons into a room. Blank = no lock."><option value="">Room —</option>${optsHtml}</select></td>
      ${cells}
    </tr>`;
  }).join('');
  const tableClass = opts.tableClass ? `oneone-matrix ${opts.tableClass}` : 'oneone-matrix';
  box.innerHTML = `<table class="${tableClass}">${head}<tbody>${body}</tbody></table>`;
  box.querySelectorAll('input.oneone-cell').forEach(inp => {
    inp.addEventListener('change', () => {
      opts.setHours(inp.dataset.sid, inp.dataset.tid, inp.value);
      const hours = ((opts.matrix.hours || {})[inp.dataset.sid] || {})[inp.dataset.tid];
      inp.value = formatOneOneHours(hours);
      inp.closest('td')?.classList.toggle('is-filled', !!inp.value);
      markWorkDirty();
      if(countEl){
        const n = collectOneOneAssignments(opts.matrix).length;
        countEl.textContent = `${n} filled cells · ${students.length} student${students.length===1?'':'s'}`;
      }
    });
  });
  box.querySelectorAll('select.oneone-col-room').forEach(sel => {
    sel.addEventListener('change', () => {
      setMatrixStudentRoom(opts.matrix, sel.dataset.sid, sel.value, opts.kind);
      markWorkDirty();
      if(opts.kind === 'rpiano') renderRpianoGrid();
      else renderOneOneGrid();
    });
  });
}
function renderUnresolvedList(wrapId, listId, unresolved){
  const wrap = document.getElementById(wrapId);
  const ul = document.getElementById(listId);
  if(!wrap || !ul) return;
  wrap.style.display = unresolved.length ? 'block' : 'none';
  ul.innerHTML = unresolved.map(u => {
    const t = u.teacherId ? (teacherName(u.teacherId) || u.teacherId) + ' · ' : '';
    return `<li><b>${escapeAttr(u.name || u.studentId)}</b> — ${escapeAttr(t + (u.reason || 'no slot'))}</li>`;
  }).join('');
}
function renderPlacementStats(statsId, scheduled, unresolved, placedLabel){
  const stats = document.getElementById(statsId);
  if(!stats) return;
  if(!scheduled.length){
    stats.style.display = 'none';
    return;
  }
  stats.style.display = 'flex';
  const daysUsed = new Set(scheduled.map(s => s.day)).size;
  const teachersUsed = new Set(scheduled.map(s => s.teacherId)).size;
  stats.innerHTML = `
    <div class="stat"><div class="num">${scheduled.length}</div><div class="lbl">${placedLabel}</div></div>
    <div class="stat"><div class="num">${unresolved.length}</div><div class="lbl">Unplaced</div></div>
    <div class="stat"><div class="num">${teachersUsed}</div><div class="lbl">Teachers</div></div>
    <div class="stat"><div class="num">${daysUsed}</div><div class="lbl">Days used</div></div>`;
}

function renderOneOneTab(){
  updateOneOneTabLock();
  updateRpianoTabLock();
  ensureOneToOneMatrix();
  fillIndividualGenerateTeacherSelect(document.getElementById('oneoneGenerateTeacher'), DB.oneToOne);
  const genBtn = document.getElementById('oneoneGenerateBtn');
  if(genBtn && genBtn.textContent !== 'Generating…') genBtn.textContent = individualGenerateBtnLabel('oneone');
  const summary = document.getElementById('oneoneSummary');
  const tag = document.getElementById('oneoneStatusTag');
  const scheduled = (LAST_ONEONE && LAST_ONEONE.scheduled) || [];
  const unresolved = (LAST_ONEONE && LAST_ONEONE.unresolved) || [];
  const assignments = collectOneOneAssignments(DB.oneToOne);
  const teacherN = new Set(assignments.map(a => a.teacherId)).size;
  if(summary){
    if(!isTimetableAccepted()){
      summary.textContent = hasAcceptedRecord()
        ? 'Accept this schedule first — dragging or regenerating group lessons locks 1/1 until you Accept again.'
        : 'Accept a timetable first.';
    } else if(LAST_ONEONE && LAST_ONEONE.accepted){
      const pairs = oneOneCoverageCount(LAST_ONEONE);
      summary.textContent = `1/1 accepted — ${pairs} frozen${scheduled.length > pairs ? ` · ${scheduled.length} sessions` : ''}. Required Piano is unlocked.`;
    } else if(scheduled.length){
      const nVar = (LAST_ONEONE.variants || []).length;
      const pairs = oneOneCoverageCount(LAST_ONEONE);
      const sess = scheduled.length > pairs ? ` · ${scheduled.length} sessions` : '';
      summary.textContent = `${pairs} 1/1 placed${sess}${nVar > 1 ? ` · ${nVar} layouts` : ''}. Accept 1/1 to freeze this layout (including any dragged times).`;
    } else if(assignments.length){
      summary.textContent = `${assignments.length} 1/1 hours across ${teacherN} teacher${teacherN===1?'':'s'} · 1 = 60 min, 1.5 = 90, 2 = 120. Generate, then Accept 1/1 before piano.`;
    } else {
      summary.textContent = 'Fill hours in the matrix below (1 = 60 min), then Generate all 1/1.';
    }
  }
  if(tag){
    tag.textContent = scheduled.length
      ? `${oneOneCoverageCount(LAST_ONEONE)} placed${scheduled.length > oneOneCoverageCount(LAST_ONEONE) ? ` · ${scheduled.length} sessions` : ''}${unresolved.length ? ` · ${unresolved.length} left out` : ''}${((LAST_ONEONE.variants||[]).length > 1) ? ` · ${(LAST_ONEONE.variants||[]).length} layouts` : ''}${LAST_ONEONE && LAST_ONEONE.accepted ? ' · accepted' : ''}`
      : '';
  }
  renderPlacementStats('oneoneStatsRow', scheduled, unresolved, '1/1 placed');
  renderUnresolvedList('oneoneUnresolvedWrap', 'oneoneUnresolvedList', unresolved);
  populateIndividualVariantSelector('oneone');
  const acceptBtn = document.getElementById('oneoneAcceptBtn');
  if(acceptBtn){
    acceptBtn.disabled = !scheduled.length || !!(LAST_ONEONE && LAST_ONEONE.accepted);
    acceptBtn.textContent = (LAST_ONEONE && LAST_ONEONE.accepted) ? '✓ 1/1 accepted' : '✓ Accept 1/1';
  }
  renderOneOneGrid();
  renderOneOneMatrix();
  fillAcceptedSchedulePanel({
    panel: 'oneoneAcceptedSchedulePanel',
    table: 'oneoneAcceptedScheduleTable',
    tag: 'oneoneAcceptedScheduleTag'
  }, hasAcceptedOneOne() ? (LAST_ONEONE.acceptedSchedule || individualAcceptedRows(LAST_ONEONE, '1/1')) : []);
}

function ensureOneToOneMatrix(){
  DB.oneToOne = DB.oneToOne || {columns: [], hours: {}};
  DB.oneToOne.columns = DB.oneToOne.columns || [];
  DB.oneToOne.hours = DB.oneToOne.hours || {};
  const emptyHours = !Object.keys(DB.oneToOne.hours).length;
  if(emptyHours && SEED.oneToOne && SEED.oneToOne.hours && Object.keys(SEED.oneToOne.hours).length){
    DB.oneToOne = JSON.parse(JSON.stringify(SEED.oneToOne));
  }
  if(!DB.oneToOne.columns.length && (DB.refTeachers || []).length){
    DB.oneToOne.columns = (DB.refTeachers || []).map(t => ({id: t.id, name: t.name}));
  }
  (DB.oneToOne.columns || []).forEach(c => migrateRoomLock(c, {defaultOn:false}));
  migrateStudentRooms(DB.oneToOne);
  return DB.oneToOne;
}
function fillOneOneTeacherFilter(){
  fillIndividualTeacherFilter(document.getElementById('oneoneTeacherFilter'), LAST_ONEONE, '— generate 1/1 first —', 'oneone');
}
function setOneOneHours(studentId, teacherId, hours){
  ensureOneToOneMatrix();
  DB.oneToOne.hours[studentId] = DB.oneToOne.hours[studentId] || {};
  const n = parseOneOneHours(hours);
  if(!n) delete DB.oneToOne.hours[studentId][teacherId];
  else DB.oneToOne.hours[studentId][teacherId] = n;
}
function renderOneOneMatrix(){
  renderHoursMatrixPanel({
    wrapId: 'oneoneMatrixWrap',
    countId: 'oneoneMatrixCount',
    filterId: 'oneoneMatrixFilter',
    matrix: ensureOneToOneMatrix(),
    setHours: setOneOneHours,
    kind: 'oneone',
    emptyHtml: 'No teacher columns — load the Drive 1_1 tab or add teachers in Reference tables.'
  });
}
function setOneOneGenerateBusy(busy){
  setSearchUiLock(busy);
  const btn = document.getElementById('oneoneGenerateBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : individualGenerateBtnLabel('oneone');
  const attempts = document.getElementById('oneoneSearchAttempts');
  if(attempts) attempts.disabled = !!busy;
  const teacher = document.getElementById('oneoneGenerateTeacher');
  if(teacher) teacher.disabled = !!busy;
}
function finishIndividualGeneratePaint(kind){
  if(kind === 'rpiano'){
    renderRpianoTab();
    renderOneOneTab();
  } else {
    renderOneOneTab();
    renderRpianoTab();
  }
  if(LAST_RESULT) renderGrid();
  markWorkDirty();
}
function runOneOneGenerate(){
  if(SEARCH_UI_LOCK) return;
  if(!isTimetableAccepted()){
    alert('Accept this schedule first. Generate 1/1 only runs while the current group grid is accepted.');
    return;
  }
  ensureOneToOneMatrix();
  const scopeTeacherId = (document.getElementById('oneoneGenerateTeacher') || {}).value || '';
  const assignments = assignmentsForGenerate(DB.oneToOne, scopeTeacherId);
  if(!assignments.length){
    alert(scopeTeacherId
      ? 'That teacher has no 1/1 hours in the matrix.'
      : 'The 1/1 matrix is empty. Fill hours in the table (1 = 60 min).');
    return;
  }
  const attempts = readOneOneSearchAttempts('oneone');
  const maxTries = oneOneSearchMaxTries(attempts);
  const who = scopeTeacherId ? (teacherName(scopeTeacherId) || scopeTeacherId) : '';
  resetSearchCancel();
  setOneOneGenerateBusy(true);
  openSearchLive(who ? `Generate 1/1 · ${who}` : 'Generate all 1/1');
  searchLiveSay(`${attempts} distinct layout(s); up to ${maxTries} tries. Packing into accepted group holes.`, 'info');
  if(who) searchLiveSay(`Only ${who} — other teachers stay.`, 'info');
  setSearchLiveProgress(0, maxTries, 'Starting…');
  (async () => {
    try {
      const scoped = await generateIndividualScopedAsync('oneone', scopeTeacherId, (done, total, label) => {
        setSearchLiveProgress(done, total, label);
      });
      if(!(scoped.variants || []).length){
        searchLiveSay(SEARCH_CANCELLED ? 'Stopped before a layout was kept.' : 'No layout produced.', 'warn');
        return;
      }
      const viewId = scopeTeacherId || (document.getElementById('oneoneTeacherFilter') || {}).value;
      const state = applyIndividualSearch('oneone', scoped.variants, viewId, scopeTeacherId);
      if(state && state.variants){
        const pianoN = collectOneOneAssignments(DB.rpiano).length;
        if(pianoN){
          setSearchLiveHeadline('Previewing Required Piano');
          searchLiveSay('Checking leftover piano holes on the kept layouts — this picks ★.', 'info');
          await attachOneOneLookaheadAsync(state.variants, (i, n) => {
            setSearchLiveHeadline(`Piano preview ${i} / ${n}`);
            searchLiveSay(`Trying leftover piano on 1/1 layout ${i} of ${n}…`, 'info');
            setSearchLiveProgress(i, n, `Piano preview ${i} / ${n}`);
          });
        } else {
          attachOneOneLookahead(state.variants);
        }
        const starI = suggestedVariantIndex(state.variants);
        const v = state.variants[starI];
        if(v){
          state.selectedIndex = starI;
          state.scheduled = v.scheduled;
          state.unresolved = v.unresolved;
        }
      }
      finishIndividualGeneratePaint('oneone');
      setSearchLiveHeadline('Done');
      searchLiveSay('Search finished. The grid shows the ★ layout.', 'ok');
    } finally {
      closeSearchLive();
      setOneOneGenerateBusy(false);
      setSearchLiveProgress(0, 0);
    }
  })();
}
function acceptOneOneSchedule(){
  if(SEARCH_UI_LOCK) return;
  if(!LAST_ONEONE || !(LAST_ONEONE.scheduled || []).length){
    alert('Generate 1/1 first.');
    return;
  }
  LAST_ONEONE.accepted = true;
  LAST_ONEONE.acceptedAt = new Date().toISOString();
  LAST_ONEONE.acceptedSchedule = individualAcceptedRows(LAST_ONEONE, '1/1');
  LAST_ONEONE.dragUndo = [];
  LAST_ONEONE.dragBaseline = cloneLessonSlots(LAST_ONEONE.scheduled);
  renderOneOneTab();
  renderRpianoTab();
  if(LAST_RESULT) renderGrid();
  markWorkDirty();
  alert('1/1 accepted — those slots are frozen. Required Piano stays on file if you already accepted it; Generate 1/1 replaces it.');
}

document.getElementById('oneoneGenerateBtn').addEventListener('click', runOneOneGenerate);
document.getElementById('oneoneAcceptBtn').addEventListener('click', acceptOneOneSchedule);
document.getElementById('oneoneUndoBtn').addEventListener('click', () => undoIndividualDrag('oneone'));
document.getElementById('oneoneVariantSelect').addEventListener('change', (e) => {
  selectIndividualVariant('oneone', parseInt(e.target.value, 10) || 0);
});
document.getElementById('oneoneMatrixFilter').addEventListener('input', renderOneOneMatrix);
document.getElementById('oneoneTeacherFilter').addEventListener('change', () => {
  LAST_ONEONE = LAST_ONEONE || {scheduled: [], unresolved: []};
  LAST_ONEONE.viewTeacherId = document.getElementById('oneoneTeacherFilter').value;
  renderOneOneGrid();
});
function syncIndividualWeekFromGenerate(kind){
  const gen = document.getElementById(kind === 'rpiano' ? 'rpianoGenerateTeacher' : 'oneoneGenerateTeacher');
  const tid = gen && gen.value;
  if(!tid) return;
  if(kind === 'rpiano'){
    LAST_RPIANO = LAST_RPIANO || {scheduled: [], unresolved: []};
    LAST_RPIANO.viewTeacherId = tid;
    renderRpianoGrid();
  } else {
    LAST_ONEONE = LAST_ONEONE || {scheduled: [], unresolved: []};
    LAST_ONEONE.viewTeacherId = tid;
    renderOneOneGrid();
  }
}
document.getElementById('oneoneGenerateTeacher').addEventListener('change', () => {
  const btn = document.getElementById('oneoneGenerateBtn');
  if(btn && btn.textContent !== 'Generating…') btn.textContent = individualGenerateBtnLabel('oneone');
  syncIndividualWeekFromGenerate('oneone');
});
function onOneOneSearchAttemptsChange(){
  readOneOneSearchAttempts('oneone');
  markWorkDirty();
}
function onRpianoSearchAttemptsChange(){
  readOneOneSearchAttempts('rpiano');
  markWorkDirty();
}
const oneoneSearchAttemptsEl = document.getElementById('oneoneSearchAttempts');
if(oneoneSearchAttemptsEl) oneoneSearchAttemptsEl.addEventListener('change', onOneOneSearchAttemptsChange);
const rpianoSearchAttemptsEl = document.getElementById('rpianoSearchAttempts');
if(rpianoSearchAttemptsEl) rpianoSearchAttemptsEl.addEventListener('change', onRpianoSearchAttemptsChange);
document.getElementById('exportOneoneAcceptedBtn').addEventListener('click', () => {
  const rows = hasAcceptedOneOne()
    ? ((LAST_ONEONE.acceptedSchedule && LAST_ONEONE.acceptedSchedule.length)
      ? LAST_ONEONE.acceptedSchedule
      : individualAcceptedRows(LAST_ONEONE, '1/1'))
    : [];
  downloadAcceptedScheduleCsv(rows, 'bartokkonzi_accepted_1_1.csv');
});

function ensureRpianoMatrix(){
  DB.rpiano = DB.rpiano || {columns: [], hours: {}};
  DB.rpiano.columns = DB.rpiano.columns || [];
  DB.rpiano.hours = DB.rpiano.hours || {};
  const emptyHours = !Object.keys(DB.rpiano.hours).length;
  if(emptyHours && SEED.rpiano && SEED.rpiano.hours && Object.keys(SEED.rpiano.hours).length){
    DB.rpiano = JSON.parse(JSON.stringify(SEED.rpiano));
  }
  (DB.rpiano.columns || []).forEach(c => migrateRoomLock(c, {defaultOn:false}));
  migrateStudentRooms(DB.rpiano);
  return DB.rpiano;
}
function setRpianoHours(studentId, teacherId, hours){
  ensureRpianoMatrix();
  DB.rpiano.hours[studentId] = DB.rpiano.hours[studentId] || {};
  const n = parseOneOneHours(hours);
  if(!n) delete DB.rpiano.hours[studentId][teacherId];
  else DB.rpiano.hours[studentId][teacherId] = n;
}
function renderRpianoMatrix(){
  renderHoursMatrixPanel({
    wrapId: 'rpianoMatrixWrap',
    countId: 'rpianoMatrixCount',
    filterId: 'rpianoMatrixFilter',
    matrix: ensureRpianoMatrix(),
    setHours: setRpianoHours,
    kind: 'rpiano',
    tableClass: 'is-rpiano',
    emptyHtml: 'No piano teacher columns — load the Drive rpiano tab.'
  });
}
function renderRpianoGrid(){
  renderTeacherWeekGrid(
    document.getElementById('rpianoGrid'),
    document.getElementById('rpianoTeacherFilter'),
    LAST_RPIANO,
    '<p class="dataio-hint" style="margin:0">Accept 1/1, then Generate Required Piano. Pick a teacher to see grey accepted blocks, gold 1/1, and teal Required Piano.</p>',
    'rpiano'
  );
}
function renderRpianoTab(){
  updateRpianoTabLock();
  ensureRpianoMatrix();
  fillIndividualGenerateTeacherSelect(document.getElementById('rpianoGenerateTeacher'), DB.rpiano);
  const summary = document.getElementById('rpianoSummary');
  const tag = document.getElementById('rpianoStatusTag');
  const scheduled = (LAST_RPIANO && LAST_RPIANO.scheduled) || [];
  const unresolved = (LAST_RPIANO && LAST_RPIANO.unresolved) || [];
  const assignments = collectOneOneAssignments(DB.rpiano);
  const teacherN = new Set(assignments.map(a => a.teacherId)).size;
  if(summary){
    if(!canOpenOneOne()){
      summary.textContent = 'Accept this schedule first — Required Piano only opens while the current group grid and 1/1 are accepted.';
    } else if(!hasAcceptedOneOne()){
      summary.textContent = 'Accept 1/1 first — piano packs into leftover holes around the frozen week and 1/1.';
    } else if(LAST_RPIANO && LAST_RPIANO.accepted){
      const pairs = oneOneCoverageCount(LAST_RPIANO);
      summary.textContent = `Required Piano accepted — ${pairs} frozen${scheduled.length > pairs ? ` · ${scheduled.length} sessions` : ''}.`;
    } else if(scheduled.length){
      const nVar = (LAST_RPIANO.variants || []).length;
      const pairs = oneOneCoverageCount(LAST_RPIANO);
      const sess = scheduled.length > pairs ? ` · ${scheduled.length} sessions` : '';
      summary.textContent = `${pairs} piano hours placed${sess}${nVar > 1 ? ` · ${nVar} layouts` : ''}. Accept Required Piano to freeze this layout (including any dragged times).`;
    } else if(assignments.length){
      summary.textContent = `${assignments.length} Required Piano hours across ${teacherN} teacher${teacherN===1?'':'s'} · 1 = 60 min, 0.5 = 30. Generate, then Accept to freeze the slots.`;
    } else {
      summary.textContent = 'Fill hours in the matrix below (1 = 60 min), then Generate Required Piano.';
    }
  }
  if(tag){
    tag.textContent = scheduled.length
      ? `${oneOneCoverageCount(LAST_RPIANO)} placed${scheduled.length > oneOneCoverageCount(LAST_RPIANO) ? ` · ${scheduled.length} sessions` : ''}${unresolved.length ? ` · ${unresolved.length} left out` : ''}${((LAST_RPIANO.variants||[]).length > 1) ? ` · ${(LAST_RPIANO.variants||[]).length} layouts` : ''}${LAST_RPIANO && LAST_RPIANO.accepted ? ' · accepted' : ''}`
      : '';
  }
  renderPlacementStats('rpianoStatsRow', scheduled, unresolved, 'RP placed');
  renderUnresolvedList('rpianoUnresolvedWrap', 'rpianoUnresolvedList', unresolved);
  populateIndividualVariantSelector('rpiano');
  const acceptBtn = document.getElementById('rpianoAcceptBtn');
  if(acceptBtn){
    acceptBtn.disabled = !scheduled.length || !!(LAST_RPIANO && LAST_RPIANO.accepted) || !hasAcceptedOneOne();
    acceptBtn.textContent = (LAST_RPIANO && LAST_RPIANO.accepted) ? '✓ Required Piano accepted' : '✓ Accept Required Piano';
  }
  const genBtn = document.getElementById('rpianoGenerateBtn');
  if(genBtn && genBtn.textContent !== 'Generating…'){
    genBtn.disabled = !hasAcceptedOneOne();
    genBtn.textContent = individualGenerateBtnLabel('rpiano');
  }
  renderRpianoGrid();
  renderRpianoMatrix();
  fillAcceptedSchedulePanel({
    panel: 'rpianoAcceptedSchedulePanel',
    table: 'rpianoAcceptedScheduleTable',
    tag: 'rpianoAcceptedScheduleTag'
  }, hasAcceptedRpiano() ? (LAST_RPIANO.acceptedSchedule || individualAcceptedRows(LAST_RPIANO, 'piano')) : []);
}
function setRpianoGenerateBusy(busy){
  setSearchUiLock(busy);
  const btn = document.getElementById('rpianoGenerateBtn');
  if(!btn) return;
  btn.textContent = busy ? 'Generating…' : individualGenerateBtnLabel('rpiano');
  btn.disabled = busy || !hasAcceptedOneOne();
  const attempts = document.getElementById('rpianoSearchAttempts');
  if(attempts) attempts.disabled = !!busy;
  const teacher = document.getElementById('rpianoGenerateTeacher');
  if(teacher) teacher.disabled = !!busy;
}
function runRpianoGenerate(){
  if(SEARCH_UI_LOCK) return;
  if(!hasAcceptedOneOne()){
    alert('Accept 1/1 first.');
    return;
  }
  ensureRpianoMatrix();
  const scopeTeacherId = (document.getElementById('rpianoGenerateTeacher') || {}).value || '';
  const assignments = assignmentsForGenerate(DB.rpiano, scopeTeacherId);
  if(!assignments.length){
    alert(scopeTeacherId
      ? 'That teacher has no Required Piano hours in the matrix.'
      : 'The Required Piano matrix is empty. Fill hours in the table (1 = 60 min).');
    return;
  }
  const attemptsN = readOneOneSearchAttempts('rpiano');
  const maxTries = oneOneSearchMaxTries(attemptsN);
  const who = scopeTeacherId ? (teacherName(scopeTeacherId) || scopeTeacherId) : '';
  resetSearchCancel();
  setRpianoGenerateBusy(true);
  openSearchLive(who ? `Generate Required Piano · ${who}` : 'Generate Required Piano');
  searchLiveSay(`${attemptsN} distinct layout(s); up to ${maxTries} tries. Packing into leftover holes around the accepted week and 1/1.`, 'info');
  if(who) searchLiveSay(`Only ${who} — other piano teachers stay.`, 'info');
  setSearchLiveProgress(0, maxTries, 'Starting…');
  (async () => {
    try {
      const scoped = await generateIndividualScopedAsync('rpiano', scopeTeacherId, (done, total, label) => {
        setSearchLiveProgress(done, total, label);
      });
      if(!(scoped.variants || []).length){
        searchLiveSay(SEARCH_CANCELLED ? 'Stopped before a layout was kept.' : 'No layout produced.', 'warn');
        return;
      }
      const viewId = scopeTeacherId || (document.getElementById('rpianoTeacherFilter') || {}).value;
      applyIndividualSearch('rpiano', scoped.variants, viewId, scopeTeacherId);
      finishIndividualGeneratePaint('rpiano');
      setSearchLiveHeadline('Done');
      searchLiveSay('Search finished. The grid shows the best layout.', 'ok');
    } finally {
      closeSearchLive();
      setRpianoGenerateBusy(false);
      setSearchLiveProgress(0, 0);
    }
  })();
}
function acceptRpianoSchedule(){
  if(SEARCH_UI_LOCK) return;
  if(!hasAcceptedOneOne()){
    alert('Accept 1/1 first.');
    return;
  }
  if(!LAST_RPIANO || !(LAST_RPIANO.scheduled || []).length){
    alert('Generate Required Piano first.');
    return;
  }
  LAST_RPIANO.accepted = true;
  LAST_RPIANO.acceptedAt = new Date().toISOString();
  LAST_RPIANO.acceptedSchedule = individualAcceptedRows(LAST_RPIANO, 'piano');
  LAST_RPIANO.dragUndo = [];
  LAST_RPIANO.dragBaseline = cloneLessonSlots(LAST_RPIANO.scheduled);
  renderRpianoTab();
  renderOneOneTab();
  if(LAST_RESULT) renderGrid();
  markWorkDirty();
  alert('Required Piano accepted — those slots are frozen.');
}

document.getElementById('rpianoGenerateBtn').addEventListener('click', runRpianoGenerate);
document.getElementById('rpianoAcceptBtn').addEventListener('click', acceptRpianoSchedule);
document.getElementById('rpianoUndoBtn').addEventListener('click', () => undoIndividualDrag('rpiano'));
document.getElementById('rpianoVariantSelect').addEventListener('change', (e) => {
  selectIndividualVariant('rpiano', parseInt(e.target.value, 10) || 0);
});
document.getElementById('rpianoMatrixFilter').addEventListener('input', renderRpianoMatrix);
document.getElementById('rpianoTeacherFilter').addEventListener('change', () => {
  LAST_RPIANO = LAST_RPIANO || {scheduled: [], unresolved: []};
  LAST_RPIANO.viewTeacherId = document.getElementById('rpianoTeacherFilter').value;
  renderRpianoGrid();
});
document.getElementById('rpianoGenerateTeacher').addEventListener('change', () => {
  const btn = document.getElementById('rpianoGenerateBtn');
  if(btn && btn.textContent !== 'Generating…') btn.textContent = individualGenerateBtnLabel('rpiano');
  syncIndividualWeekFromGenerate('rpiano');
});
document.getElementById('exportRpianoAcceptedBtn').addEventListener('click', () => {
  const rows = hasAcceptedRpiano()
    ? ((LAST_RPIANO.acceptedSchedule && LAST_RPIANO.acceptedSchedule.length)
      ? LAST_RPIANO.acceptedSchedule
      : individualAcceptedRows(LAST_RPIANO, 'piano'))
    : [];
  downloadAcceptedScheduleCsv(rows, 'bartokkonzi_accepted_rpiano.csv');
});


// ---------- FIXED pins banner + browser autosave ----------
const AUTOSAVE_KEY = 'bartok_jazz_planner_autosave';
const AUTOSAVE_META_KEY = 'bartok_jazz_planner_autosave_meta';
let AUTOSAVE_TIMER = null;
let WORK_DIRTY = false;

function autosaveEnabled(){
  return !(typeof window !== 'undefined' && window.__BJP_HARNESS);
}
function collectFixedPins(){
  const lessons = (DB.lessons || []).filter(l => l.fixedDay);
  const smallGroups = (LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups || []).filter(b => b.fixedDay);
  return {lessons, smallGroups};
}
function clearAllFixedPins(){
  (DB.lessons || []).forEach(l => { l.fixedDay = ''; l.fixedStart = ''; l.fixedEnd = ''; });
  if(LAST_SMALL_GROUPS && LAST_SMALL_GROUPS.smallGroups){
    LAST_SMALL_GROUPS.smallGroups.forEach(b => { b.fixedDay = ''; b.fixedStart = ''; b.fixedEnd = ''; });
  }
  renderLessons();
  if(LAST_SMALL_GROUPS) renderSmallGroupsResults(LAST_SMALL_GROUPS);
  updateFixedPinsBanner();
  markWorkDirty();
}
function updateFixedPinsBanner(){
  const {lessons, smallGroups} = collectFixedPins();
  const n = lessons.length + smallGroups.length;
  const text = n
    ? `${lessons.length} lesson${lessons.length === 1 ? '' : 's'}${smallGroups.length ? ` · ${smallGroups.length} small group${smallGroups.length === 1 ? '' : 's'}` : ''} pinned with FIXED times — Generate locks those slots. Leftover pins from an older Accept stay until you clear them.`
    : '';
  ['fixedPinsBanner', 'fixedPinsBannerLessons', 'fixedPinsBannerSmallGroups'].forEach(id => {
    const el = document.getElementById(id);
    if(!el || !el.style) return;
    el.style.display = n ? 'flex' : 'none';
    const count = el.querySelector('.fixed-pins-count');
    if(count) count.textContent = text;
  });
}
function markWorkDirty(){
  WORK_DIRTY = true;
  scheduleAutosave();
  updateAutosaveStatus();
}
function markWorkClean(){
  WORK_DIRTY = false;
  flushAutosave();
  updateAutosaveStatus();
}
function scheduleAutosave(){
  if(!autosaveEnabled()) return;
  if(AUTOSAVE_TIMER) clearTimeout(AUTOSAVE_TIMER);
  AUTOSAVE_TIMER = setTimeout(flushAutosave, 700);
}
function flushAutosave(){
  AUTOSAVE_TIMER = null;
  if(!autosaveEnabled()) return;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildFullExportObject()));
    localStorage.setItem(AUTOSAVE_META_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      dirty: WORK_DIRTY
    }));
  } catch(e){ /* quota / private mode */ }
  updateAutosaveStatus();
}
function updateAutosaveStatus(){
  const el = document.getElementById('autosaveStatus');
  if(!el) return;
  try {
    const raw = localStorage.getItem(AUTOSAVE_META_KEY);
    if(!raw){ el.textContent = 'Autosave: nothing stored in this browser yet.'; return; }
    const meta = JSON.parse(raw);
    const when = meta.savedAt ? new Date(meta.savedAt).toLocaleString() : '';
    el.textContent = WORK_DIRTY
      ? `Autosaved ${when} — not yet in a JSON / cloud file.`
      : `Autosaved ${when}.`;
  } catch(e){}
}
function restoreAutosaveIfAny(){
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if(!raw) return false;
    restoreFromLoadedObject(JSON.parse(raw));
    WORK_DIRTY = true;
    try {
      const meta = JSON.parse(localStorage.getItem(AUTOSAVE_META_KEY) || 'null');
      if(meta && meta.dirty === false) WORK_DIRTY = false;
    } catch(e){}
    const note = document.getElementById('autosaveRestoreNote');
    if(note){
      note.style.display = 'block';
      try {
        const meta = JSON.parse(localStorage.getItem(AUTOSAVE_META_KEY) || 'null');
        note.textContent = meta && meta.savedAt
          ? `Restored this browser’s last autosave (${new Date(meta.savedAt).toLocaleString()}).`
          : 'Restored this browser’s last autosave.';
      } catch(e){
        note.textContent = 'Restored this browser’s last autosave.';
      }
    }
    updateAutosaveStatus();
    updateFixedPinsBanner();
    return true;
  } catch(e){
    console.error('autosave restore failed', e);
    try {
      DB = JSON.parse(JSON.stringify(SEED));
      DB.smallGroupQuotas = DB.smallGroupQuotas || [];
      DB.refRooms = DB.refRooms || [];
      normalizeDbRooms(DB);
      LAST_SMALL_GROUPS = null;
      LAST_RESULT = null;
      LAST_VARIANTS = [];
      LAST_ONEONE = null;
      LAST_RPIANO = null;
      renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderRefTables(); renderBreaksTable();
    } catch(e2){}
    return false;
  }
}
function discardAutosaveAndReloadSeed(){
  if(!confirm('Clear every table and drop this browser’s autosave? Small groups and the timetable will be cleared. Load Google Sheets again to fill the planner.')) return;
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
    localStorage.removeItem(AUTOSAVE_META_KEY);
  } catch(e){}
  DB = JSON.parse(JSON.stringify(SEED));
  DB.smallGroupQuotas = DB.smallGroupQuotas || [];
  DB.refRooms = DB.refRooms || [];
  normalizeDbRooms(DB);
  LAST_SMALL_GROUPS = null;
  LAST_RESULT = null;
  LAST_VARIANTS = [];
  LAST_FINGERPRINT = null;
  LAST_SEARCH_LOG = [];
  LAST_SEARCH_OVERVIEW = [];
  LAST_AUDIT = null;
  SearchLog.lines = [];
  DB.acceptedSchedule = [];
  DB.acceptedTimetable = null;
  LAST_ONEONE = null;
  LAST_RPIANO = null;
  WORK_DIRTY = false;
  renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderRefTables(); renderBreaksTable();
  const smallGroupsPanel = document.getElementById('smallGroupsResultsPanel');
  const exclPanel = document.getElementById('smallGroupsExcludedPanel');
  const stats = document.getElementById('smallGroupsStatsRow');
  if(smallGroupsPanel) smallGroupsPanel.style.display = 'none';
  if(exclPanel) exclPanel.style.display = 'none';
  if(stats) stats.style.display = 'none';
  const resultsPanel = document.getElementById('resultsPanel');
  const unresolvedPanel = document.getElementById('unresolvedPanel');
  const statsRow = document.getElementById('statsRow');
  const variantRow = document.getElementById('variantRow');
  if(resultsPanel) resultsPanel.style.display = 'none';
  if(unresolvedPanel) unresolvedPanel.style.display = 'none';
  if(statsRow) statsRow.style.display = 'none';
  if(variantRow) variantRow.style.display = 'none';
  renderAcceptedStatus();
  renderAcceptedSchedule();
  renderOneOneTab();
  renderRpianoTab();
  updateFixedPinsBanner();
  const note = document.getElementById('autosaveRestoreNote');
  if(note) note.style.display = 'none';
  updateAutosaveStatus();
}
document.getElementById('clearFixedPinsBtn').addEventListener('click', clearAllFixedPins);
document.getElementById('clearFixedPinsBtnLessons').addEventListener('click', clearAllFixedPins);
document.getElementById('clearFixedPinsBtnSmallGroups').addEventListener('click', clearAllFixedPins);
document.getElementById('discardAutosaveBtn').addEventListener('click', discardAutosaveAndReloadSeed);
['reportClassFilter','reportStudentFilter','reportMuclassFilter','reportRoomFilter','reportTeacherFilter','reportKindFilter','reportShowClassReservations'].forEach(id => {
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener('change', () => {
    readReportFiltersFromUi();
    renderReportsTab();
  });
});
document.getElementById('reportClearBtn').addEventListener('click', () => {
  REPORT_FILTERS = emptyReportFilters();
  renderReportsTab();
});
document.getElementById('reportCsvBtn').addEventListener('click', downloadReportCsv);
document.getElementById('reportPrintBtn').addEventListener('click', printReports);
window.addEventListener('pagehide', flushAutosave);
window.addEventListener('beforeunload', flushAutosave);

// ---------- Init ----------
try {
  restoreAutosaveIfAny();
renderStudents();
renderLessons();
renderAvail();
renderCAvail();
renderRefTables();
renderBreaksTable();
renderAcceptedStatus();
  renderAcceptedSchedule();
  updateFixedPinsBanner();
  updatePhase1TeacherOrderBtn();
  syncForbidUnlistedGroupGapsCheckbox();
  syncLookaheadEveryLayoutCheckbox();
  syncTeacherSwapProbeCheckbox();
  updateAutosaveStatus();
  renderOneOneTab();
  renderRpianoTab();
  if(dbLooksEmpty()) showTab('cloud');
} catch(e){
  showBootError(e);
}

// ---------- Collapsible "About this section" hints on every tab ----------
document.querySelectorAll('.hint-toggle').forEach(btn => {
  const hint = btn.nextElementSibling;
  btn.addEventListener('click', () => {
    const isOpen = btn.classList.toggle('open');
    if(hint) hint.classList.toggle('hint-collapsed', !isOpen);
  });
});

// ---------- Cloud database (Supabase) ----------
// GitHub Pages only serves static files — it can't run server-side code — so a
// same-origin "/api/..." function endpoint isn't an option here. This talks straight to
// Supabase's REST API from the browser instead, which works from any static host
// (GitHub Pages, Cloudflare Pages, Netlify, anywhere). A tiny REST-only integration (no
// SDK) against a single table, `planner_state`, holding one row (id='main') whose `data`
// column is the exact same JSON blob the file export produces. The URL + key are stored
// in this browser's localStorage so they only need to be entered once per device — the
// DATA itself lives in Supabase, not locally, so it's genuinely shared across every
// device/browser that connects with the same keys.
const SUPABASE_CONFIG_KEY = 'bartok_jazz_planner_supabase_config';
let SUPABASE_CONFIG = null;

function loadSupabaseConfig(){
  try {
    const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}
function saveSupabaseConfig(cfg){
  try { localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(cfg)); } catch(e){ /* ignore */ }
}

// Supabase now issues two key formats: legacy JWT `anon` keys (base64, start with
// "eyJ") which traditionally go in both the apikey AND Authorization: Bearer headers,
// and the newer sb_publishable_ / sb_secret_ keys, which only ever go in the apikey
// header — sending those via Authorization: Bearer isn't the right transport. This
// works with either kind without the person needing to know which one they have.
function supabaseAuthHeaders(key){
  const headers = { 'apikey': key };
  if(key.startsWith('eyJ')) headers['Authorization'] = `Bearer ${key}`;
  return headers;
}
async function supabaseUpsertState(cfg, payload){
  const res = await fetch(`${cfg.url.replace(/\/$/,'')}/rest/v1/planner_state?on_conflict=id`, {
    method: 'POST',
    headers: {
      ...supabaseAuthHeaders(cfg.key),
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify([{ id: 'main', data: payload, updated_at: new Date().toISOString() }])
  });
  if(!res.ok) throw new Error(`Supabase save failed (${res.status}): ${(await res.text()).slice(0,300)}`);
}
async function supabaseFetchState(cfg){
  const res = await fetch(`${cfg.url.replace(/\/$/,'')}/rest/v1/planner_state?id=eq.main&select=data,updated_at`, {
    headers: supabaseAuthHeaders(cfg.key)
  });
  if(!res.ok) throw new Error(`Supabase load failed (${res.status}): ${(await res.text()).slice(0,300)}`);
  const rows = await res.json();
  return rows[0] || null;
}

function setCloudStatus(text, isError){
  const el = document.getElementById('cloudStatus');
  if(!el) return;
  el.textContent = text;
  el.style.color = isError ? '#e0576b' : '';
}
function setCloudButtonsEnabled(enabled){
  ['cloudSaveBtn','cloudLoadBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if(btn) btn.disabled = !enabled;
  });
}

document.getElementById('cloudConnectBtn').addEventListener('click', async () => {
  const url = document.getElementById('cloudUrlInput').value.trim();
  const key = document.getElementById('cloudKeyInput').value.trim();
  if(!url || !key){ setCloudStatus('Enter both the Project URL and the key first.', true); return; }
  const cfg = {url, key};
  setCloudStatus('Connecting…');
  try {
    const row = await supabaseFetchState(cfg);
    SUPABASE_CONFIG = cfg;
    saveSupabaseConfig(cfg);
    setCloudButtonsEnabled(true);
    if(row){
      setCloudStatus(`Connected — found saved data from ${new Date(row.updated_at).toLocaleString()}. Click "Load from Cloud" to pull it in.`);
    } else {
      setCloudStatus('Connected — no saved data there yet. Click "Save All to Cloud" to push your current work.');
    }
  } catch(err){
    setCloudStatus('Could not connect: ' + err.message, true);
  }
});

document.getElementById('cloudSaveBtn').addEventListener('click', async () => {
  if(!SUPABASE_CONFIG){ setCloudStatus('Connect first.', true); return; }
  setCloudStatus('Saving to cloud…');
  try {
    await supabaseUpsertState(SUPABASE_CONFIG, buildFullExportObject());
    markWorkClean();
    setCloudStatus('✓ Saved to cloud at ' + new Date().toLocaleString());
  } catch(err){
    setCloudStatus('Save failed: ' + err.message, true);
  }
});

document.getElementById('cloudLoadBtn').addEventListener('click', async () => {
  if(!SUPABASE_CONFIG){ setCloudStatus('Connect first.', true); return; }
  setCloudStatus('Loading from cloud…');
  try {
    const row = await supabaseFetchState(SUPABASE_CONFIG);
    if(!row){ setCloudStatus('Nothing saved in the cloud yet.', true); return; }
    if(WORK_DIRTY || hasUnacceptedDrags()){
      if(!confirm('This tab has work that is only in the browser autosave (including any dragged times). Load from cloud and replace it?')){
        setCloudStatus('Load cancelled.');
        return;
      }
    }
    restoreFromLoadedObject(row.data);
    markWorkClean();
    setCloudStatus('✓ Loaded from cloud — last saved ' + new Date(row.updated_at).toLocaleString());
  } catch(err){
    setCloudStatus('Load failed: ' + err.message, true);
  }
});

// Auto-connect (but don't auto-load — the person decides when to pull cloud data over
// whatever they're already looking at) if this browser already has saved credentials.
(function initCloudConfig(){
  const cfg = loadSupabaseConfig();
  if(!cfg) return;
  document.getElementById('cloudUrlInput').value = cfg.url;
  document.getElementById('cloudKeyInput').value = cfg.key;
  SUPABASE_CONFIG = cfg;
  setCloudButtonsEnabled(true);
  setCloudStatus('Connected (saved credentials). Click "Load from Cloud" to pull the latest, or "Save All to Cloud" to push.');
})();
