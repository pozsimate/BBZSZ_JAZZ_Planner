// ---------- Load seed data ----------
const SEED = JSON.parse(document.getElementById('seed-data').textContent);
let DB = JSON.parse(JSON.stringify(SEED)); // working copy (deep clone)

const DAYS = ["MON","TUE","WED","THU","FRI"];
const DAY_LABEL = {MON:"Monday",TUE:"Tuesday",WED:"Wednesday",THU:"Thursday",FRI:"Friday"};
const DEFAULT_START = 8*60, DEFAULT_END = 20*60;
const TYPE_OPTIONS = ["AVAILABLE","PREFERRED","FALLBACK","CANDIDATE","AVOID"];

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

// A pinned window must be exactly the lesson/band duration. Snap FIXED END to start+duration
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
function classJclass(id){ const c = DB.refClasses.find(r => r.id === id); return (c && c.jclass) || ''; }
function groupName(id){ return lookupMap(DB.refGroups)[id] || ''; }
function instrName(id){ return lookupMap(DB.refInstruments)[id] || ''; }
function instrType(id){ const i = DB.refInstruments.find(r => r.id === id); return (i && i.type) || ''; }

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
  {key:'room321', label:'ROOM 321', type:'checkbox'},
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
  {key:'option', label:'OPTION', type:'text'},
];

const CAVAIL_COLDEFS = [
  {key:'classId', label:'CLASS', type:'select', options:classOpts, syncField:'class'},
  {key:'day', label:'DAY', type:'daySelect'},
  {key:'start', label:'START', type:'text'},
  {key:'end', label:'END', type:'text'},
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
  {key:'jclass', label:'JCLASS TYPE', type:'text', width:'110px'},
];

const INSTR_REF_COLDEFS = [
  {key:'id', label:'ID', type:'text'},
  {key:'name', label:'NAME', type:'text'},
  {key:'type', label:'TYPE', type:'text', width:'90px'},
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
  renderTable(document.getElementById('refTeachersTable'), DB.refTeachers, TEACHER_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refClassesTable'), DB.refClasses, CLASS_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refGroupsTable'), DB.refGroups, GROUP_REF_COLDEFS, refreshDependents);
  renderTable(document.getElementById('refInstrumentsTable'), DB.refInstruments, INSTR_REF_COLDEFS, refreshDependents);
  document.getElementById('refTeacherCount').textContent = DB.refTeachers.length + ' teachers';
  document.getElementById('refClassCount').textContent = DB.refClasses.length + ' classes';
  document.getElementById('refGroupCount').textContent = DB.refGroups.length + ' groups';
  document.getElementById('refInstrCount').textContent = DB.refInstruments.length + ' instruments';
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
  "IMPR","IMPR_ID","VOC","VOC_ID","JTH","JTH_ID","SOLF","SOLF_ID","JHIST","JHIST_ID","RHIMPR","RHIMPR_ID","AC","AC_ID","BAND1"];

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
  DB.lessons.push({id:'LES'+n,name:'',group:'',groupId:'',teacher:'',teacherId:'',duration:90,room321:false,fixedDay:'',fixedStart:'',fixedEnd:'',scheduledDay:'',scheduledStart:'',scheduledEnd:''});
  renderLessons();
});
document.getElementById('addAvailBtn').addEventListener('click', () => {
  DB.teacherAvail.push({teacher:'',teacherId:'',day:'MON',start:'',end:'',type:'AVAILABLE',option:''});
  renderAvail();
});
document.getElementById('addCAvailBtn').addEventListener('click', () => {
  DB.classAvail.push({class:'',classId:'',day:'MON',start:'',end:'',note:''});
  renderCAvail();
});
document.getElementById('addRefTeacher').addEventListener('click', () => {
  DB.refTeachers.push({id:'TEAC'+(DB.refTeachers.length+1), name:''}); renderRefTables(); renderBreaksTable();
});
document.getElementById('addRefClass').addEventListener('click', () => {
  DB.refClasses.push({id:'CL'+(DB.refClasses.length+1), name:'', jclass:''}); renderRefTables();
});
document.getElementById('addRefGroup').addEventListener('click', () => {
  DB.refGroups.push({id:'GR'+(DB.refGroups.length+1), name:'', type:''}); renderRefTables();
});
document.getElementById('addRefInstr').addEventListener('click', () => {
  DB.refInstruments.push({id:'INST'+(DB.refInstruments.length+1), name:'', type:''}); renderRefTables();
});

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if(btn.dataset.tab === 'oneone' && !hasAcceptedRecord()){
      alert('Accept a timetable first. 1/1 packs individual lessons into the holes of that week.');
      return;
    }
    if(btn.dataset.tab === 'rjpiano' && !hasAcceptedOneOne()){
      alert('Accept 1/1 first. Required Jazz Piano packs piano hours into the leftover holes of that week.');
      return;
    }
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p=>p.style.display='none');
    const panel = document.getElementById('tab-'+btn.dataset.tab);
    if(panel) panel.style.display='block';
    if(btn.dataset.tab === 'timetable' && LAST_RESULT) renderGrid();
    if(btn.dataset.tab === 'oneone') renderOneOneTab();
    if(btn.dataset.tab === 'rjpiano') renderRjPianoTab();
  });
});

// ---------- Scheduler ----------
function studentsInGroup(groupId){
  const fields = ["IMPR_ID","VOC_ID","JTH_ID","SOLF_ID","JHIST_ID","RHIMPR_ID","AC_ID"];
  return DB.students.filter(s => fields.some(f => s[f] === groupId));
}

// Resolves the participants of a lesson-like entry: explicit member IDs (used by band
// rehearsals) take priority; otherwise falls back to the usual subject-group lookup.
function lessonStudents(l){
  if(l.memberIds && l.memberIds.length){
    return l.memberIds.map(id => DB.students.find(s => s.ID === id)).filter(Boolean);
  }
  return studentsInGroup(l.groupId);
}

// Turns the current band roster (from the Bands tab) into lesson-shaped entries. Bands
// are teacher-less by default now — the scheduler places them by member availability
// first and matches a teacher afterward based on BAND QUOTA (see runScheduler). If the
// user manually picked a teacher on the Bands tab for a specific band, that's honoured
// as a fixed override and the band is scheduled the normal teacher-first way instead.
// Recomputed fresh every time the timetable is generated, so edits on the Bands tab are
// always picked up. Bands with no members are skipped.
function bandIdSeq(id){
  const m = /^BAND(\d+)$/i.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : 0;
}
function bandShortLabel(band){
  const n = bandIdSeq(band && band.id);
  return n ? ('Band ' + n) : 'Band';
}
function bandDisplayName(band){
  return bandShortLabel(band) + ' rehearsal';
}
function emptyBandRecord(id){
  return {
    id: id || '',
    bass:[], drum:[], acc:[], sol:[],
    teacherId:'', room321:true, duration:90,
    fixedDay:'', fixedStart:'', fixedEnd:'',
    scheduledDay:'', scheduledStart:'', scheduledEnd:'',
    scheduledTeacherId:'', scheduledTeacher:''
  };
}
function ensureBandIdentities(state){
  if(!state) return state;
  state.bands = state.bands || [];
  let maxN = 0;
  state.bands.forEach((b, i) => {
    if(!b.id) b.id = 'BAND' + (i + 1);
    maxN = Math.max(maxN, bandIdSeq(b.id));
  });
  const stored = parseInt(state.nextBandSeq, 10) || 0;
  state.nextBandSeq = Math.max(maxN + 1, stored, 1);
  return state;
}
function mintBandId(state){
  ensureBandIdentities(state);
  const id = 'BAND' + state.nextBandSeq;
  state.nextBandSeq += 1;
  return id;
}
function findBandById(lessonId){
  if(!LAST_BANDS || !LAST_BANDS.bands) return null;
  return LAST_BANDS.bands.find(b => b.id === lessonId) || null;
}
function getBandLessons(){
  if(!LAST_BANDS || !LAST_BANDS.bands) return [];
  ensureBandIdentities(LAST_BANDS);
  const out = [];
  LAST_BANDS.bands.forEach(band => {
    const memberIds = BAND_TYPES.flatMap(t => band[t].map(s => s.ID));
    if(memberIds.length === 0) return;
    out.push({
      id: band.id,
      name: bandDisplayName(band),
      group: 'BAND', groupId: '',
      teacherId: band.teacherId || '', teacher: band.teacherId ? teacherName(band.teacherId) : '',
      duration: parseInt(band.duration,10) || 90,
      room321: !!band.room321,
      fixedDay: band.fixedDay || '', fixedStart: band.fixedStart || '', fixedEnd: band.fixedEnd || '',
      memberIds,
    });
  });
  return out;
}

function teacherDayWindows(teacherId){
  const rows = DB.teacherAvail.filter(r => r.teacherId === teacherId && r.type !== 'AVOID' && r.day && DAYS.includes(r.day));
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
  const avoidDays = new Set(DB.teacherAvail.filter(r=>r.teacherId===teacherId && r.type==='AVOID').map(r=>r.day));
  avoidDays.forEach(d => delete byDay[d]);
  return byDay;
}

// CLASS RESERVATIONS sheet: each row is a time the class is BUSY (regular schoolwork),
// not a time it's free. A class's actual free window for a jazz lesson is whatever's
// left over that day once every reservation is subtracted — we return the largest such
// gap. A class/day with no reservation rows at all is treated as free all day.
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

// A teacher's allowed break: `minutes` is the unit, `count` is how many units they
// may spend across the whole week (not per day). Defaults to 0/0 — no gaps at all.
function teacherBreakSettings(teacherId){
  const b = (DB.breaks || []).find(r => r.teacherId === teacherId);
  return {
    minutes: Math.max(0, parseInt(b && b.breakMinutes, 10) || 0),
    count: Math.max(0, parseInt(b && b.breakCount, 10) || 0),
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

function teacherWindowClash(teacherId, teacherLabel, day, start, end){
  if(!teacherId) return null;
  const w = teacherDayWindows(teacherId)[day];
  const label = teacherLabel || teacherName(teacherId) || teacherId;
  if(!w) return `teacher ${label} is not available on ${DAY_LABEL[day]}`;
  if(start < w.start || end > w.end){
    return `teacher ${label} is only available ${DAY_LABEL[day]} ${toHHMM(w.start)}–${toHHMM(w.end)}`;
  }
  return null;
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

// Finds the earliest start >= windowStart, within [windowStart, windowEnd - duration],
// that sits with ZERO gap right after (or right before) an existing booking sharing at
// least one of this lesson's jclass types that day — and that doesn't clash with the
// busy list given. Returns null if no such snap point exists (caller then falls back
// to windowStart as usual). This is a soft "try to cluster same-grade lessons" nudge,
// not a hard rule — if nothing snaps, normal placement proceeds unchanged.
function findJclassSnapStart(item, day, windowStart, windowEnd, jclassBusy, busy){
  if(!item.jclassTypes || item.jclassTypes.size === 0) return null;
  let neighborIntervals = [];
  item.jclassTypes.forEach(t => {
    const list = (jclassBusy[t] && jclassBusy[t][day]) || [];
    neighborIntervals = neighborIntervals.concat(list);
  });
  if(neighborIntervals.length === 0) return null;

  const candidates = [];
  neighborIntervals.forEach(iv => {
    candidates.push(iv.end);          // snap right after this neighbor
    candidates.push(iv.start - item.duration); // snap right before this neighbor
  });
  candidates.sort((a,b) => a-b);

  for(const t of candidates){
    if(t < windowStart || t + item.duration > windowEnd) continue;
    const clash = busy.some(iv => intervalsOverlap(t, t+item.duration, iv.start, iv.end));
    if(!clash) return t;
  }
  return null;
}

// BREAK MIN is the unit, BREAK COUNT is how many units a teacher may spend in their
// whole timetable (Mon–Fri combined). A gap may be 0, or any positive multiple of
// BREAK MIN (45×2 → one 90-minute hole, or two 45-minute holes on the same or
// different days). Any other length is illegal. Not listed / 0/0 → no gaps.
function breakUnitsForGap(gap, minutes){
  if(gap === 0) return 0;
  if(gap > 0 && minutes > 0 && gap % minutes === 0) return gap / minutes;
  return null;
}
function breakUnitsInIntervals(intervals, minutes){
  if(!intervals || intervals.length <= 1) return 0;
  const busy = intervals.slice().sort((a,b)=>a.start-b.start);
  let units = 0;
  for(let i=1;i<busy.length;i++){
    const gap = busy[i].start - busy[i-1].end;
    if(gap < 0) return Infinity;
    const extra = breakUnitsForGap(gap, minutes);
    if(extra === null) return Infinity;
    units += extra;
  }
  return units;
}
function breakUnitsAcrossDays(byDay, minutes){
  let units = 0;
  DAYS.forEach(day => { units += breakUnitsInIntervals((byDay && byDay[day]) || [], minutes); });
  return units;
}
function breakUnitsUsedOutsideSegment(teacherBusy, teacherId, day, seg, minutes){
  let units = 0;
  DAYS.forEach(d => {
    const ivs = ((teacherBusy[teacherId] && teacherBusy[teacherId][d]) || []).slice();
    if(d !== day){
      units += breakUnitsInIntervals(ivs, minutes);
    } else {
      units += breakUnitsInIntervals(ivs.filter(iv => iv.end <= seg.start), minutes);
      units += breakUnitsInIntervals(ivs.filter(iv => iv.start >= seg.end), minutes);
    }
  });
  return units;
}
function breakGapOk(gap, breakSettings, breaksUsed){
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
  if(item.lesson.room321){
    const roomList = roomBusy[day] || [];
    if(roomList.some(iv => intervalsOverlap(start, start+item.duration, iv.start, iv.end))) return true;
  }
  return false;
}

// First item of a chain: attach flush to a preceding fixed booking when one exists
// (hard no-gap rule). Jclass snap is only a soft preference and must not open an
// illegal hole after that booking.
function pickFirstItemStart(item, day, studentBusy, roomBusy, breakSettings, jclassBusy, existingTeacherBusy, breaksUsed){
  breaksUsed = breaksUsed || 0;
  const studentBusyForItem = [];
  item.students.forEach(s => {
    const list = (studentBusy[s.ID] && studentBusy[s.ID][day]) || [];
    studentBusyForItem.push(...list);
  });
  const snap = findJclassSnapStart(item, day, item.winStart, item.winEnd, jclassBusy, studentBusyForItem);
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
  if(snap !== null) tryStarts.push(snap);
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

function simulateOrder(order, day, studentBusy, roomBusy, breakSettings, jclassBusy, existingTeacherBusy, initialBreaksUsed){
  existingTeacherBusy = existingTeacherBusy || [];
  let currentEnd = null;
  let breaksUsed = initialBreaksUsed || 0;
  const placements = [];
  for(const item of order){
    let candidateStart;
    let gapBase;
    if(currentEnd === null){
      const first = pickFirstItemStart(item, day, studentBusy, roomBusy, breakSettings, jclassBusy, existingTeacherBusy, breaksUsed);
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

// Tries every ordering (small sets) — or a few sensible heuristics for large sets —
// to find the arrangement that packs as many of this teacher's remaining lessons as
// possible into one block on this day (gap-free, except for the teacher's allowed break
// budget) — but never more than maxCount, so a single day doesn't hoover up lessons that
// should be spread across the teacher's other available days (see scheduleTeacherAcrossDays).
function bestPermutationPlacements(items, day, studentBusy, roomBusy, breakSettings, jclassBusy, maxCount, existingTeacherBusy, initialBreaksUsed){
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
    const placements = simulateOrder(order, day, studentBusy, roomBusy, breakSettings, jclassBusy, existingTeacherBusy, initialBreaksUsed).slice(0, cap);
    if(placements.length > best.length) best = placements;
    if(best.length === cap) break; // reached the target for this day, stop searching
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

function scheduleTeacherAcrossDays(teacherId, items, teacherBusy, studentBusy, roomBusy, jclassBusy, randomize){
  const dayWin = teacherDayWindows(teacherId);
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
  // which can incidentally free up a teacher's day that a stuck band needed.
  const orderedTiers = randomize ? tiers.map(shuffleArray) : tiers;

  for(const tier of orderedTiers){
    let daysLeftInTier = tier.length;
    for(const [day, win] of tier){
      if(remaining.length === 0) break;
      const target = Math.ceil(remaining.length / daysLeftInTier);
      daysLeftInTier--;

      // Split the day into free segments around anything this teacher already has that
      // day (e.g. a FIXED lesson/band from Phase 0) — packing then fills each segment
      // independently, gap-free within it, instead of building one forward chain that
      // simply gives up the moment it would need to "jump over" an obstacle. This is what
      // lets lessons land snugly both before AND after a fixed booking in the middle of
      // the day. A hole on either side of that booking is a real gap and must pass the
      // same Break Management rule as a gap between two packed lessons.
      const existingBusy = ((teacherBusy[teacherId] && teacherBusy[teacherId][day]) || []).slice().sort((a,b)=>a.start-b.start);
      const segments = [];
      let cursor = win.start;
      existingBusy.forEach(iv => {
        if(iv.start > cursor) segments.push({
          start:cursor, end:iv.start,
          precededByObstacle: existingBusy.some(e => e.end === cursor),
          followedByObstacle: true
        });
        cursor = Math.max(cursor, iv.end);
      });
      if(cursor < win.end) segments.push({
        start:cursor, end:win.end,
        precededByObstacle: existingBusy.some(e => e.end === cursor),
        followedByObstacle: false
      });

      let dayTarget = target;
      for(const seg of segments){
        if(remaining.length === 0 || dayTarget <= 0) break;

        const withWindow = remaining.map(it => {
          let start = seg.start, end = seg.end, feasible = true;
          for(const s of it.students){
            const cw = classWindow(s.CLASS_ID, day);
            if(!cw){ feasible = false; break; }
            start = Math.max(start, cw[0]);
            end = Math.min(end, cw[1]);
          }
          return {...it, feasible, winStart:start, winEnd:end};
        }).filter(it => it.feasible && it.winStart + it.duration <= it.winEnd);

        if(withWindow.length === 0) continue;

        // Tell simulateOrder about the preceding fixed booking so the first item
        // attaches to it (or uses an allowed break) instead of starting later.
        // Budget already spent in this teacher's WEEK, minus the hole this segment fills.
        const alreadyUsed = breakUnitsUsedOutsideSegment(teacherBusy, teacherId, day, seg, breakSettings.minutes);
        const existingForSim = seg.precededByObstacle ? [{start: seg.start - 1, end: seg.start}] : [];

        let best = [];
        for(let cap = Math.min(dayTarget, withWindow.length); cap >= 1; cap--){
          const packed = bestPermutationPlacements(withWindow, day, studentBusy, roomBusy, breakSettings, jclassBusy, cap, existingForSim, alreadyUsed);
          if(packed.length === 0) break;

          const options = [];
          if(seg.followedByObstacle){
            const shifted = tryShiftChainTo(packed, seg.end, day, studentBusy, roomBusy);
            if(shifted) options.push(shifted);
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
            if(p.lesson.room321){
              roomBusy[day] = roomBusy[day] || [];
              roomBusy[day].push({start:p.start, end:p.end});
            }
            (p.jclassTypes || []).forEach(t => {
              jclassBusy[t] = jclassBusy[t] || {};
              jclassBusy[t][day] = jclassBusy[t][day] || [];
              jclassBusy[t][day].push({start:p.start, end:p.end});
            });
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

function variantLogHeader(result){
  const n = result && result.attemptNo;
  const kind = result && result.attemptKind === 'deterministic' ? 'deterministic'
    : result && result.attemptKind === 'random' ? 'random' : '';
  const label = n
    ? `Search log — attempt ${n}${kind ? ' ('+kind+')' : ''}`
    : 'Search log — this layout';
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
  const bands = result.unresolved.filter(u => u.lesson.id && String(u.lesson.id).startsWith('BAND')).length;
  const extra = bands ? `, ${bands} band${bands===1?'':'s'} stuck` : '';
  return `${result.scheduled.length} scheduled, ${result.unresolved.length} unresolved${extra}`;
}

function logQuotaLedger(scheduled, heading){
  SearchLog.section(heading || 'Band quota ledger');
  const used = {};
  (scheduled || []).forEach(s => {
    if(s.lessonId && String(s.lessonId).startsWith('BAND') && s.teacherId){
      (used[s.teacherId] = used[s.teacherId] || []).push(`${s.name} (${DAY_LABEL[s.day]} ${toHHMM(s.start)})`);
    }
  });
  const listed = new Set();
  (DB.bandQuotas || []).forEach(bq => {
    listed.add(bq.teacherId);
    const cap = parseInt(bq.amount, 10) || 0;
    const list = used[bq.teacherId] || [];
    const left = cap - list.length;
    const names = list.length ? list.join(', ') : 'none';
    const line = `${bq.teacher || teacherName(bq.teacherId)}: ${list.length} used / ${cap} quota (${left < 0 ? 'OVER' : left + ' left'}) — ${names}`;
    if(list.length > cap) SearchLog.warn(line);
    else SearchLog.ok(line);
  });
  Object.keys(used).forEach(tid => {
    if(!listed.has(tid)){
      SearchLog.warn(`${teacherName(tid) || tid}: ${used[tid].length} band(s) but not on the quota list — ${used[tid].join(', ')}`);
    }
  });
  const totalUsed = Object.values(used).reduce((n, a) => n + a.length, 0);
  const totalCap = (DB.bandQuotas || []).reduce((n, bq) => n + (parseInt(bq.amount, 10) || 0), 0);
  SearchLog.info(`Total: ${totalUsed} bands assigned against ${totalCap} quota slots`);
}

function runScheduler(randomize){
  // Isolate this attempt's walkthrough so each kept variant can show its own log.
  const parentLines = SearchLog.lines;
  const parentQuiet = SearchLog.quiet;
  SearchLog.lines = [];
  SearchLog.quiet = false;

  const teacherBusy = {};
  const studentBusy = {};
  const roomBusy = {}; // day -> [{start,end}] — shared across every teacher, for ROOM 321 lessons
  const jclassBusy = {}; // jclassType -> day -> [{start,end}] — shared across every teacher, soft "keep same-grade lessons together" nudge

  // BAND QUOTA pool — shared by manual "Teacher override" assignments (phase 1) and
  // automatic matching (phase 3), so a manually-picked teacher counts against their
  // quota exactly like an auto-matched one does. Only teachers with an actual entry in
  // DB.bandQuotas are ever eligible — a teacher not listed there simply never appears in
  // quotaRemaining, so `quotaRemaining[t.id] || 0` correctly resolves to 0 for them and
  // they're never auto-matched to a band.
  const quotaRemaining = {};
  (DB.bandQuotas || []).forEach(bq => { quotaRemaining[bq.teacherId] = Math.max(0, parseInt(bq.amount,10) || 0); });

  const allBandLessons = getBandLessons();
  const manualBandLessons = allBandLessons.filter(l => l.teacherId);   // user picked a teacher on the Bands tab: schedule the normal way
  const autoBandLessons = allBandLessons.filter(l => !l.teacherId);    // teacher-less: place by member availability, match a teacher after

  const scheduled = [];
  const unresolved = [];

  if(!SearchLog.quiet){
    SearchLog.section(randomize ? 'This attempt (shuffled)' : 'This attempt (deterministic)');
    SearchLog.info(`${DB.lessons.length} subject lessons · ${manualBandLessons.length} bands with a teacher override · ${autoBandLessons.length} bands to auto-match`);
    const qParts = (DB.bandQuotas || []).map(bq => `${bq.teacher || teacherName(bq.teacherId)} ${quotaRemaining[bq.teacherId]}/${bq.amount}`);
    SearchLog.info(qParts.length ? `Band quotas at start: ${qParts.join(', ')}` : 'Band quotas: none listed — auto-match cannot assign any teacher');
    const br = (DB.breaks || []).filter(b => (parseInt(b.breakMinutes,10)||0) > 0);
    SearchLog.info(br.length
      ? `Week break budget: ${br.map(b => `${b.teacher || teacherName(b.teacherId)} ${b.breakMinutes} min × ${b.breakCount}`).join(', ')}`
      : 'Week break budget: none — a teacher\'s own lessons must sit flush');
    SearchLog.info('Hard checks: teacher availability, class reservations, ROOM 321, no student/teacher double-book, break units across the week');
  }

  // ---------- PHASE 0: fixed-time lessons/bands — no searching, no negotiating. Placed
  // first (before anything else), so every other flexible item naturally routes around
  // them. A lesson/band only needs FIXED DAY set to be "fixed"; FIXED START/END give the
  // exact window (falls back to the lesson's own duration ending 90 min after start, or
  // the whole day, if end is left blank). A fixed slot still has to pass the same hard
  // constraints as a searched one: teacher availability, class reservations, no
  // double-booking a student/teacher, ROOM 321, and the teacher's week break budget
  // (a second pin that opens an illegal hole next to the first is rejected). If any
  // of those fail it's left unresolved — no alternative time is ever substituted for it.
  function pushFixedPlacement(l, teacherId, teacherLabel, day, start, end, students){
    scheduled.push({
      lessonId: l.id, name: l.name, group: l.group || '', groupId: l.groupId || '',
      teacher: teacherLabel, teacherId: teacherId,
      day, start, end,
      studentCount: students.length, room321: !!l.room321,
      studentNames: students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
    });
    students.forEach(s => {
      studentBusy[s.ID] = studentBusy[s.ID] || {};
      studentBusy[s.ID][day] = studentBusy[s.ID][day] || [];
      studentBusy[s.ID][day].push({start, end});
    });
    if(l.room321){
      roomBusy[day] = roomBusy[day] || [];
      roomBusy[day].push({start, end});
    }
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
    if(breakUnitsAcrossDays(byDay, bs.minutes) <= bs.count) return null;
    const label = teacherLabel || teacherName(teacherId) || teacherId;
    if(bs.minutes === 0 || bs.count === 0){
      return `teacher ${label} has no break budget, so this pinned slot would leave an illegal gap next to another booking`;
    }
    return `teacher ${label}'s break budget is ${bs.minutes} min × ${bs.count} and this pinned slot would overspend it`;
  }

  const fixedRegularLessons = DB.lessons.filter(l => l.fixedDay);
  const fixedManualBands = manualBandLessons.filter(l => l.fixedDay);
  const fixedAutoBands = autoBandLessons.filter(l => l.fixedDay);
  if(!SearchLog.quiet){
    const nFixed = fixedRegularLessons.length + fixedManualBands.length + fixedAutoBands.length;
    SearchLog.section('Phase 0 — pinned slots (no search)');
    SearchLog.info(nFixed ? `${nFixed} item(s) have FIXED DAY — placed first, everyone else routes around them` : 'No pinned slots');
  }

  fixedRegularLessons.concat(fixedManualBands).forEach(l => {
    const win = parseFixedWindow(l);
    const students = lessonStudents(l);
    if(!win){
      SearchLog.warn(`${l.name}: fixed slot rejected — invalid FIXED DAY / START / END`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:'invalid fixed time — check FIXED DAY / FIXED START / FIXED END.'});
      return;
    }
    const {day, start, end} = win;
    let clash = teacherWindowClash(l.teacherId, l.teacher, day, start, end)
      || studentReservationClash(students, day, start, end);
    if(!clash && l.id && String(l.id).startsWith('BAND')){
      if((quotaRemaining[l.teacherId] || 0) <= 0){
        clash = `teacher ${l.teacher || teacherName(l.teacherId) || l.teacherId} has no remaining BAND QUOTA — add them in ⚙ Band Quotas (Bands tab) or raise their amount`;
      }
    }
    if(!clash){
      const tBusy = (teacherBusy[l.teacherId] && teacherBusy[l.teacherId][day]) || [];
      if(tBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) clash = `the teacher already has a fixed booking at ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}`;
    }
    if(!clash){
      clash = studentFixedBookingClash(students, studentBusy, day, start, end, 'students');
    }
    if(!clash && l.room321){
      const rBusy = roomBusy[day] || [];
      if(rBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) clash = `ROOM 321 is already taken by another fixed booking then`;
    }
    if(!clash){
      clash = pinnedBreaksClash(l.teacherId, l.teacher, day, start, end);
    }
    if(clash){
      SearchLog.warn(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} — ${clash}`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:`fixed to ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}, but ${clash} — no alternative time is tried for a fixed slot.`});
    } else {
      if(win.adjusted) SearchLog.info(`${l.name}: FIXED window snapped to ${win.duration} min — booked ${toHHMM(start)}–${toHHMM(end)}`);
      SearchLog.ok(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)}${l.teacherId ? ' · '+ (l.teacher||teacherName(l.teacherId)) : ''}${l.id && String(l.id).startsWith('BAND') ? ' · uses 1 band quota' : ''}`);
      pushFixedPlacement(l, l.teacherId, l.teacher, day, start, end, students);
      if(l.id && String(l.id).startsWith('BAND') && l.teacherId){
        quotaRemaining[l.teacherId]--;
        SearchLog.info(`Quota ${l.teacher || teacherName(l.teacherId)}: consume 1 (pinned) → ${quotaRemaining[l.teacherId]} left`);
      }
    }
  });

  fixedAutoBands.forEach(l => {
    const win = parseFixedWindow(l);
    const students = lessonStudents(l);
    if(!win){
      SearchLog.warn(`${l.name}: fixed slot rejected — invalid FIXED DAY / START / END`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:'invalid fixed time — check FIXED DAY / FIXED START / FIXED END.'});
      return;
    }
    const {day, start, end} = win;
    let clash = studentReservationClash(students, day, start, end);
    if(!clash){
      clash = studentFixedBookingClash(students, studentBusy, day, start, end, 'members');
    }
    if(!clash && l.room321){
      const rBusy = roomBusy[day] || [];
      if(rBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) clash = `ROOM 321 is already taken by another fixed booking then`;
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
    const candidate = DB.refTeachers
      .filter(t => (quotaRemaining[t.id] || 0) > 0)
      .filter(t => {
        const w = teacherDayWindows(t.id)[day];
        if(!w || start < w.start || end > w.end) return false;
        const tBusy = (teacherBusy[t.id] && teacherBusy[t.id][day]) || [];
        if(tBusy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return false;
        return !pinnedBreaksClash(t.id, t.name, day, start, end);
      })
      .sort((a,b) => gapForFixedCandidate(a.id) - gapForFixedCandidate(b.id) || (quotaRemaining[b.id]||0) - (quotaRemaining[a.id]||0))[0];
    if(candidate){
      if(win.adjusted) SearchLog.info(`${l.name}: FIXED window snapped to ${win.duration} min — booked ${toHHMM(start)}–${toHHMM(end)}`);
      quotaRemaining[candidate.id]--;
      SearchLog.ok(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} · auto-matched ${candidate.name} (quota left ${quotaRemaining[candidate.id]})`);
      SearchLog.info(`Quota ${candidate.name}: consume 1 (pinned auto-match) → ${quotaRemaining[candidate.id]} left`);
      pushFixedPlacement(l, candidate.id, candidate.name, day, start, end, students);
    } else {
      SearchLog.warn(`${l.name}: pinned ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} — members free, but no quota teacher is free then`);
      unresolved.push({lesson:l, students, dayWin:{}, customReason:`a fixed slot of ${DAY_LABEL[day]} ${toHHMM(start)}–${toHHMM(end)} was requested and its members are free then, but no teacher with remaining BAND QUOTA is available at exactly that time — raise a teacher's quota in ⚙ Band Quotas (Bands tab), set a "Teacher override" on this band instead, or adjust the fixed time.`});
    }
  });

  const fixedIds = new Set(fixedRegularLessons.concat(fixedManualBands, fixedAutoBands).map(l => l.id));

  // ---------- PHASE 1: regular subject lessons + any manually-assigned bands, teacher-first ----------
  const byTeacher = {};
  DB.lessons.concat(manualBandLessons).filter(l => !fixedIds.has(l.id)).forEach(l => {
    const students = lessonStudents(l);
    if(l.id && String(l.id).startsWith('BAND')){
      if((quotaRemaining[l.teacherId] || 0) <= 0){
        SearchLog.warn(`${l.name}: ${l.teacher || teacherName(l.teacherId)} has no remaining band quota — not scheduled`);
        unresolved.push({lesson:l, students, dayWin: teacherDayWindows(l.teacherId), customReason:`teacher ${l.teacher || teacherName(l.teacherId) || l.teacherId} has no remaining BAND QUOTA — add them in ⚙ Band Quotas (Bands tab) or raise their amount.`});
        return;
      }
      SearchLog.info(`Quota ${l.teacher || teacherName(l.teacherId)}: ${quotaRemaining[l.teacherId]} → ${quotaRemaining[l.teacherId]-1} (reserve for ${l.name})`);
      quotaRemaining[l.teacherId]--; // reserve; refunded below if this band cannot be placed
    }
    const duration = parseInt(l.duration,10) || 45;
    const jclassTypes = new Set(students.map(s => classJclass(s.CLASS_ID)).filter(Boolean));
    byTeacher[l.teacherId] = byTeacher[l.teacherId] || [];
    byTeacher[l.teacherId].push({lesson:l, students, duration, jclassTypes});
  });

  const teacherIds = Object.keys(byTeacher).sort((a,b) => {
    const da = Object.keys(teacherDayWindows(a)).length;
    const db = Object.keys(teacherDayWindows(b)).length;
    if(da !== db) return da - db;
    const totalA = byTeacher[a].reduce((s,i)=>s+i.duration,0);
    const totalB = byTeacher[b].reduce((s,i)=>s+i.duration,0);
    return totalB - totalA;
  });

  if(!SearchLog.quiet){
    SearchLog.section('Phase 1 — teacher-first (subjects + override bands)');
    SearchLog.info(`Teachers in order of fewest available days, then most minutes. Days used by rank (PREFERRED/AVAILABLE → FALLBACK → CANDIDATE), packed flush within a day.`);
  }
  teacherIds.forEach(teacherId => {
    const {placed, unresolved: leftover} = scheduleTeacherAcrossDays(teacherId, byTeacher[teacherId], teacherBusy, studentBusy, roomBusy, jclassBusy, randomize);
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
        studentCount: p.students.length, room321: !!p.lesson.room321,
        studentNames: p.students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
      });
    });
    leftover.forEach(it => {
      if(it.lesson.id && String(it.lesson.id).startsWith('BAND') && it.lesson.teacherId){
        quotaRemaining[it.lesson.teacherId] = (quotaRemaining[it.lesson.teacherId] || 0) + 1;
        SearchLog.info(`Quota ${it.lesson.teacher || teacherName(it.lesson.teacherId)}: refund +1 — ${it.lesson.name} did not get a slot`);
      }
      unresolved.push({lesson: it.lesson, students: it.students, dayWin: teacherDayWindows(teacherId)});
    });
  });

  // ---------- PHASE 2+3 (merged + local search): place teacher-less bands where BOTH
  // their members and a quota-holding teacher are simultaneously free, treating "which
  // band gets which slot" as a small constraint problem rather than pure first-come,
  // first-served — a naive greedy pass can leave a couple of bands stranded even when
  // the total BAND QUOTA exactly equals the band count, because an early, flexible band
  // can grab a slot that only a later, more constrained band actually needed. This does
  // two things about that: (1) processes the most constrained bands first, and (2) if a
  // band still can't be placed, tries bumping one already-placed band to a different
  // valid slot to free up room for it (a single-step local search / augmenting swap).
  const quotaTeachers = DB.refTeachers.filter(t => (quotaRemaining[t.id] || 0) > 0);

  function bandSlotOptions(students, duration){
    const opts = [];
    for(const day of DAYS){
      let start = DEFAULT_START, end = DEFAULT_END, feasible = true;
      for(const s of students){
        const cw = classWindow(s.CLASS_ID, day);
        if(!cw){ feasible = false; break; }
        start = Math.max(start, cw[0]); end = Math.min(end, cw[1]);
      }
      if(!feasible || start + duration > end) continue;
      for(let t = start; t + duration <= end; t += 15) opts.push({day, start:t, end:t+duration});
    }
    return opts;
  }
  function conflictsWithBase(day, start, end, students, room321){
    for(const s of students){
      const list = (studentBusy[s.ID] && studentBusy[s.ID][day]) || [];
      if(list.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return true;
    }
    if(room321){
      const list = roomBusy[day] || [];
      if(list.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return true;
    }
    return false;
  }
  // Checks a candidate (day,start,end) against every OTHER already-made auto-band
  // assignment (excluding index `excludeIdx`) for student/room/teacher clashes.
  // Pass teacherId to also check for a same-teacher double-booking.
  function conflictsWithAssignments(day, start, end, students, room321, teacherId, assignments, excludeIdx){
    for(let i=0;i<assignments.length;i++){
      if(i === excludeIdx || !assignments[i]) continue;
      const a = assignments[i];
      if(a.day !== day || !intervalsOverlap(start, end, a.start, a.end)) continue;
      if(teacherId && a.teacherId === teacherId) return true;
      if(room321 && a.room321) return true;
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
    const win = teacherDayWindows(teacherId)[day];
    return !!win && start >= win.start && end <= win.end;
  }
  // Checks against the teacher's existing commitments from Phase 1 (regular subject
  // lessons and any manually-assigned bands) — this was missing before and could let an
  // auto-matched band double-book a teacher who already had a regular lesson right then.
  function teacherBusyConflict(teacherId, day, start, end){
    const list = (teacherBusy[teacherId] && teacherBusy[teacherId][day]) || [];
    return list.some(iv => intervalsOverlap(start, end, iv.start, iv.end));
  }

  function structuralOptionCount(students, duration){
    let count = 0;
    bandSlotOptions(students, duration).forEach(opt => {
      quotaTeachers.forEach(t => { if(teacherWindowOk(t.id, opt.day, opt.start, opt.end)) count++; });
    });
    return count;
  }

  const bandItems = autoBandLessons
    .filter(l => !fixedIds.has(l.id)) // already handled in Phase 0
    .map(l => ({l, students: lessonStudents(l), duration: parseInt(l.duration,10) || 90}))
    .sort((a,b) => structuralOptionCount(a.students, a.duration) - structuralOptionCount(b.students, b.duration) || (b.students.length - a.students.length));

  const assignments = new Array(bandItems.length).fill(null);

  // Recursive augmenting-path search: tries to place band `idx` in some free slot with
  // some teacher who still has quota; if every teacher who could otherwise take that slot
  // is already full, it tries "bumping" one of that teacher's current bands to a different
  // teacher/slot instead (recursively, up to `depth` hops) to free up the room — a proper
  // multi-step reshuffle, not just a single swap. `visited` stops a band from being bumped
  // more than once within the same top-level attempt, to avoid endless back-and-forth.
  // How close a candidate slot sits to this teacher's nearest existing commitment that
  // day — regular lessons, other bands, anything already in teacherBusy/assignments.
  // 0 = perfectly adjacent (no gap at all), Infinity = teacher has nothing booked that
  // day (so there's no gap to minimize against). Used to prefer teachers whose day
  // already has something nearby, packing the new band right up against it.
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
    return breakUnitsAcrossDays(byDay, bs.minutes) <= bs.count;
  }

  function teacherWeekGapsValid(teacherId){
    const bs = teacherBreakSettings(teacherId);
    return breakUnitsAcrossDays(teacherWeekByDay(teacherId, -1), bs.minutes) <= bs.count;
  }

  function tryPlaceRecursive(idx, depth, visited){
    if(visited.has(idx)) return false;
    visited.add(idx);
    const {l, students, duration} = bandItems[idx];
    if(students.length === 0){ visited.delete(idx); return false; }

    // Gather every feasible (slot, teacher) combination up front — not just the first
    // slot that happens to work — so the one with the smallest gap to that teacher's
    // existing schedule can be picked, rather than whichever comes first in time order.
    const feasibleOpts = bandSlotOptions(students, duration).filter(opt =>
      !conflictsWithBase(opt.day, opt.start, opt.end, students, l.room321) &&
      !conflictsWithAssignments(opt.day, opt.start, opt.end, students, l.room321, null, assignments, idx)
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
        a.gap - b.gap ||
        ((quotaRemaining[b.teacherId]||0) - teacherQuotaUsed(b.teacherId, assignments, idx)) - ((quotaRemaining[a.teacherId]||0) - teacherQuotaUsed(a.teacherId, assignments, idx)) ||
        DAYS.indexOf(a.opt.day) - DAYS.indexOf(b.opt.day) ||
        a.opt.start - b.opt.start
      );
      const best = directChoices[0];
      assignments[idx] = {day:best.opt.day, start:best.opt.start, end:best.opt.end, teacherId:best.teacherId, students, room321: !!l.room321};
      return true; // stays in `visited` — it's now committed, not up for further bumping in this search
    }

    if(depth > 0){
      // every eligible teacher for every feasible slot is at capacity — try bumping one
      // of a teacher's other bands elsewhere to open up a spot, then retry. Still prefers
      // the smallest-gap (slot, teacher) combination first.
      const bumpChoices = [];
      feasibleOpts.forEach(opt => {
        quotaTeachers.forEach(t => {
          if(!teacherWindowOk(t.id, opt.day, opt.start, opt.end)) return;
          if(teacherBusyConflict(t.id, opt.day, opt.start, opt.end)) return; // t has a REGULAR lesson right then — bumping other bands won't free that up
          if(conflictsWithAssignments(opt.day, opt.start, opt.end, [], false, t.id, assignments, idx)) return; // t is genuinely busy then, bumping won't help
          if(!teacherGapsOk(t.id, opt.day, opt.start, opt.end, idx)) return; // HARD rule here too, both sides
          const gap = teacherGapAt(t.id, opt.day, opt.start, opt.end, idx);
          bumpChoices.push({opt, teacherId: t.id, gap});
        });
      });
      bumpChoices.sort((a,b) => a.gap - b.gap || DAYS.indexOf(a.opt.day) - DAYS.indexOf(b.opt.day) || a.opt.start - b.opt.start);

      for(const choice of bumpChoices){
        const {opt, teacherId: t} = choice;
        const usingT = assignments.map((a,i) => (a && a.teacherId === t) ? i : -1).filter(i => i >= 0 && i !== idx);
        for(const cIdx of usingT){
          // Snapshot the WHOLE assignments array, not just cIdx — relocating cIdx can
          // itself trigger nested bumps of other bands, and if this attempt ultimately
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
               !conflictsWithAssignments(opt.day, opt.start, opt.end, students, l.room321, t, assignments, idx)){
              assignments[idx] = {day:opt.day, start:opt.start, end:opt.end, teacherId:t, students, room321: !!l.room321};
              return true;
            }
          }
          for(let k=0;k<assignments.length;k++) assignments[k] = snapshot[k]; // full rollback, including nested side effects
        }
      }
    }

    visited.delete(idx); // backtrack: this branch failed, let a different branch reconsider this band later
    return false;
  }

  const SWAP_DEPTH = 4;
  if(!SearchLog.quiet){
    SearchLog.section('Phase 2 — auto-match bands');
    SearchLog.info(bandItems.length
      ? `${bandItems.length} teacher-less band(s), most constrained first (fewest member+teacher slot options). Picks the tightest legal gap; can reshuffle up to ${SWAP_DEPTH} hops.`
      : 'No teacher-less bands');
  }
  bandItems.forEach((_, idx) => { if(!assignments[idx]) tryPlaceRecursive(idx, SWAP_DEPTH, new Set()); });

  // Final safety pass: a LATER band's bump chain can relocate a band that an EARLIER,
  // already-committed band was relying on for zero-gap adjacency — nothing re-validates
  // that earlier band automatically when its neighbor moves away. Rather than ever ship a
  // schedule with a stray gap that breaks the hard "no gap unless Break Management allows
  // it" rule, re-check every commitment after all placement is done; anything that no
  // longer complies gets unassigned and re-attempted (which may find it a new, valid home,
  // or correctly leave it unresolved) — repeated until the whole set is self-consistent.
  for(let round = 0; round < bandItems.length + 5; round++){
    const teacherIds = new Set();
    assignments.forEach(a => { if(a) teacherIds.add(a.teacherId); });
    let anyInvalid = false;
    teacherIds.forEach(teacherId => {
      if(!teacherWeekGapsValid(teacherId)){
        anyInvalid = true;
        SearchLog.warn(`Break-budget repair: ${teacherName(teacherId) || teacherId} went over the week limit after a reshuffle — unassigned their auto bands and retried`);
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
        const roomClash = a.room321 && b.room321;
        const aIds = new Set(a.students.map(s => s.ID));
        const studentClash = b.students.some(s => aIds.has(s.ID));
        if(!sameTeacher && !roomClash && !studentClash) continue;
        anyInvalid = true;
        SearchLog.warn(`Reshuffle repair: ${bandItems[i].l.name} and ${bandItems[j].l.name} overlap after a bump — unassigned the later one and retried`);
        assignments[j] = null;
      }
    }
    if(!anyInvalid) break;
    bandItems.forEach((_, idx) => { if(!assignments[idx]) tryPlaceRecursive(idx, SWAP_DEPTH, new Set()); });
  }

  bandItems.forEach((item, idx) => {
    const a = assignments[idx];
    if(a){
      const teacher = DB.refTeachers.find(t => t.id === a.teacherId);
      const usedHere = teacherQuotaUsed(a.teacherId, assignments, -1);
      const left = (quotaRemaining[a.teacherId] || 0) - usedHere;
      SearchLog.ok(`${item.l.name}: ${teacher ? teacher.name : a.teacherId} · ${DAY_LABEL[a.day]} ${toHHMM(a.start)}–${toHHMM(a.end)}${a.room321 ? ' · ROOM 321' : ''} · quota ${usedHere} this phase, ${left} left`);
      SearchLog.info(`Quota ${teacher ? teacher.name : a.teacherId}: consume 1 (auto-match ${item.l.name}) → ${left} left of remaining pool`);
      scheduled.push({
        lessonId: item.l.id, name: item.l.name, group: 'BAND', groupId: '',
        teacher: teacher ? teacher.name : a.teacherId, teacherId: a.teacherId,
        day: a.day, start: a.start, end: a.end,
        studentCount: item.students.length, room321: !!item.l.room321,
        studentNames: item.students.map(s => `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`).sort()
      });
    } else if(item.students.length === 0){
      SearchLog.warn(`${item.l.name}: no members`);
      unresolved.push({lesson:item.l, students:item.students, dayWin:{}, customReason:'this band has no members.'});
    } else {
      const anyOpt = bandSlotOptions(item.students, item.duration).find(opt => !conflictsWithBase(opt.day, opt.start, opt.end, item.students, item.l.room321));
      const customReason = anyOpt
        ? `a free time for its ${item.students.length} members exists (e.g. ${DAY_LABEL[anyOpt.day]} ${toHHMM(anyOpt.start)}–${toHHMM(anyOpt.end)}), but no combination of a quota-holding teacher and a reshuffle of the other bands could cover it — raise a teacher's quota in ⚙ Band Quotas (Bands tab), or pick a teacher manually via "Teacher override" on this band.`
        : `no time slot found where all ${item.students.length} members are simultaneously free.`;
      SearchLog.warn(`${item.l.name}: ${anyOpt ? `members free e.g. ${DAY_LABEL[anyOpt.day]} ${toHHMM(anyOpt.start)}–${toHHMM(anyOpt.end)}, but no quota teacher + legal gap` : `no slot where all ${item.students.length} members are free`}`);
      unresolved.push({lesson:item.l, students:item.students, dayWin:{}, customReason});
    }
  });

  scheduled.sort((a,b)=> DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.start-b.start);
  logQuotaLedger(scheduled, 'Band quota ledger (this attempt)');
  const attemptLog = SearchLog.lines.slice();
  SearchLog.lines = parentLines;
  SearchLog.quiet = parentQuiet;
  return {scheduled, unresolved, searchLog: attemptLog};
}

// ---------- Rendering results ----------
let LAST_RESULT = null;
let LAST_AUDIT = null; // latest constraint-check of LAST_RESULT.scheduled (rebuilt after generate / every drag)
let LAST_VARIANTS = []; // every distinct valid full-schedule solution found so far, best first
let LAST_FINGERPRINT = null; // detects whether the source data changed since the last Generate click

// Fingerprints everything that actually affects the schedule (every editable table plus
// the current band roster). Used so repeated "Generate timetable" clicks can safely keep
// accumulating candidate solutions instead of throwing the old ones away — pressing the
// button again should only ever find as-good-or-better results, never worse, as long as
// nothing was edited in between. If the fingerprint changes (any edit anywhere), the
// accumulated variants are correctly discarded and the search starts clean.
function computeScheduleFingerprint(){
  const bandsSummary = (LAST_BANDS && LAST_BANDS.bands) ? LAST_BANDS.bands.map(b => ({
    id: b.id||'',
    bass: b.bass.map(s=>s.ID), drum: b.drum.map(s=>s.ID), acc: b.acc.map(s=>s.ID), sol: b.sol.map(s=>s.ID),
    teacherId: b.teacherId||'', room321: !!b.room321, duration: b.duration||90,
    fixedDay: b.fixedDay||'', fixedStart: b.fixedStart||'', fixedEnd: b.fixedEnd||''
  })) : null;
  const lessonsSummary = (DB.lessons || []).map(l => ({
    id: l.id, name: l.name, group: l.group, groupId: l.groupId,
    teacher: l.teacher, teacherId: l.teacherId, duration: l.duration,
    room321: !!l.room321,
    fixedDay: l.fixedDay||'', fixedStart: l.fixedStart||'', fixedEnd: l.fixedEnd||''
  }));
  return JSON.stringify({
    students: DB.students, lessons: lessonsSummary, teacherAvail: DB.teacherAvail, classAvail: DB.classAvail,
    refTeachers: DB.refTeachers, refClasses: DB.refClasses, refGroups: DB.refGroups, refInstruments: DB.refInstruments,
    bandQuotas: DB.bandQuotas, breaks: DB.breaks,
    bands: bandsSummary
  });
}

// Runs the whole pipeline several times: once with the normal deterministic layout, then
// several more with the regular lessons (and manually-assigned bands) laid out slightly
// differently each time — different day choices among a teacher's equally-ranked days,
// different internal ordering — since Phase 1 commits to one specific regular-lesson
// layout before the teacher-less bands ever get a say, and that specific layout can
// occasionally block a band that a different (equally valid) regular-lesson layout
// wouldn't have. Every distinct attempt is kept (not just the best), sorted best-first,
// so the person can browse the alternatives on the Timetable tab instead of only ever
// seeing the one automatically-picked "best" solution.
const SCHEDULE_SEARCH_ATTEMPTS = 15;
function resultScore(result){
  const unresolvedBands = result.unresolved.filter(u => u.lesson.id && u.lesson.id.startsWith('BAND')).length;
  return [unresolvedBands, result.unresolved.length];
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
    push('info', 'Later shuffled attempts try a different day/lesson order so a leftover band or lesson can take a hole this layout did not leave.');
    reds.forEach(u => push('warn', `${u.lesson.name}: still red — ${shortUnresolvedReason(u)}`));
    return lines;
  }

  if(!reds.length){
    push('ok', 'Attempt 1 already had nothing unresolved. This layout is another valid arrangement.');
  } else {
    push('info', `Attempt 1 left ${reds.length} in red: ${reds.map(u => u.lesson.name).join(', ')}`);
    push('info', 'This attempt reshuffled which of a teacher\'s equally-ranked days get packed first, and the order of their lessons, to free a hole a stuck band or leftover lesson needed.');
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
          } else if(id && String(id).startsWith('BAND')){
            push('info', `That time was free for ${placed.teacher || teacherName(tid)} in attempt 1 — the block was members, another band, ROOM 321, or quota matching. The reshuffled week made the combination legal.`);
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
  const seen = new Map(); // signature -> result
  const foundOnAttempt = new Map(); // signature -> attempt number
  SearchLog.quiet = false;
  const first = runScheduler(false); // deterministic baseline always included
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  SearchLog.always('ok', `Attempt 1 (deterministic): ${resultLogLine(first)}`);
  const firstSig = resultSignature(first);
  seen.set(firstSig, first);
  foundOnAttempt.set(firstSig, 1);
  SearchLog.always('section', 'Further attempts');
  SearchLog.always('info', `${SCHEDULE_SEARCH_ATTEMPTS - 1} more tries with shuffled day order / lesson order — looking for a layout that unblocks a stuck band`);
  for(let i = 0; i < SCHEDULE_SEARCH_ATTEMPTS - 1; i++){
    const attempt = runScheduler(true);
    attempt.attemptNo = i + 2;
    attempt.attemptKind = 'random';
    const sig = resultSignature(attempt);
    if(seen.has(sig)){
      SearchLog.always('info', `Attempt ${i+2}: same layout as an earlier one — discarded`);
    } else {
      seen.set(sig, attempt);
      foundOnAttempt.set(sig, i+2);
      SearchLog.always('ok', `Attempt ${i+2} (random): ${resultLogLine(attempt)} — kept`);
    }
  }
  const variants = [...seen.values()];
  variants.sort((a,b) => {
    const sa = resultScore(a), sb = resultScore(b);
    return sa[0] !== sb[0] ? sa[0]-sb[0] : sa[1]-sb[1];
  });
  const best = variants[0];
  const bestN = foundOnAttempt.get(resultSignature(best));
  SearchLog.section('Pick');
  SearchLog.info(`Ranking: fewest unresolved bands, then fewest unresolved items overall. ${variants.length} distinct layout(s) this click.`);
  SearchLog.ok(`Best this click is attempt ${bestN}: ${resultLogLine(best)}. Open Search log after picking a variant to see that layout's full walkthrough.`);
  variants.forEach(v => {
    const extra = collectHowRedsCleared(first, v, v.attemptNo);
    v.searchLog = (v.searchLog || []).concat(extra);
  });
  logHowRedsCleared(first, best, bestN);
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
    || (LAST_BANDS && LAST_BANDS.bands && LAST_BANDS.bands.some(b => b.scheduledDay)));
}
function hasUnacceptedDrags(){
  const v = LAST_RESULT;
  if(!v) return false;
  if(v.dragUndo && v.dragUndo.length) return true;
  if(v.dragBaseline && !lessonSlotsMatch(v.scheduled, v.dragBaseline)) return true;
  return false;
}
let PENDING_GENERATE = 'timetable';
const GENERATE_CONFIRM_BODY = {
  timetable: 'Generate can search again and leave the frozen roster in place, or clear it (and the SCHEDULED columns) so the next search starts unconstrained. Generate still only reads FIXED times and band Teacher override.',
  bands: 'New bands replace the current roster and clear the generated timetable grid. You can leave the frozen accepted roster in place, or clear it (and the SCHEDULED columns) so the next search starts unconstrained. Generate still only reads FIXED times and band Teacher override.'
};
const GENERATE_CONFIRM_EXTRA = {
  timetable: 'The current grid also has dragged times that were not accepted — a new search replaces the grid.',
  bands: 'The current generated timetable is cleared either way — new bands change who is in each rehearsal.'
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
function isGenerateConfirmOpen(){
  return overlayIsOpen(document.getElementById('generateConfirmOverlay'));
}
function showGenerateConfirm(kind){
  abortCalendarInteraction();
  setModalOverlay('searchLogOverlay', false);
  setModalOverlay('bandQuotasOverlay', false);
  PENDING_GENERATE = kind === 'bands' ? 'bands' : 'timetable';
  const extra = document.getElementById('generateConfirmExtra');
  const body = document.getElementById('generateConfirmBody');
  if(body) body.textContent = GENERATE_CONFIRM_BODY[PENDING_GENERATE];
  if(extra){
    extra.textContent = GENERATE_CONFIRM_EXTRA[PENDING_GENERATE];
    extra.style.display = PENDING_GENERATE === 'bands' || hasUnacceptedDrags() ? 'block' : 'none';
  }
  setModalOverlay('generateConfirmOverlay', true);
}
function queuePendingGenerate(clearAccepted){
  if(PENDING_GENERATE === 'bands') queueGenerateBands(clearAccepted);
  else queueGenerateTimetable(clearAccepted);
}
function setGenerateBusy(busy){
  const btn = document.getElementById('generateBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : '▶ Generate group lessons';
}
function setBandsBusy(busy){
  const btn = document.getElementById('generateBandsBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : '▶ Generate bands';
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
  updateTimetableAcceptBtn();
}
function queueGenerateTimetable(clearAccepted){
  hideGenerateConfirm();
  setGenerateBusy(true);
  setTimeout(() => {
    try {
      runGenerateTimetable(clearAccepted);
    } finally {
      setGenerateBusy(false);
    }
  }, 0);
}
function runGenerateTimetable(clearAccepted){
  hideGenerateConfirm();
  discardVariantDragEdits();
  const hadScheduled = hasAcceptedRecord();
  if(clearAccepted && hadScheduled) clearAcceptedScheduledRecord();
  SearchLog.reset();
  const fp = computeScheduleFingerprint();
  SearchLog.section('Generate group lessons');
  if(clearAccepted && hadScheduled) SearchLog.info('SCHEDULED columns from the last Accept were cleared — this search starts unconstrained');
  else if(hadScheduled) SearchLog.info('Accepted schedule kept — this search does not read SCHEDULED columns');
  if(fp !== LAST_FINGERPRINT){
    SearchLog.info('Inputs changed (or first run) — previous solution pool cleared, search starts clean');
    LAST_VARIANTS = [];
    LAST_FINGERPRINT = fp;
  } else {
    SearchLog.info('Same inputs as last click — new layouts are added to the pool (max 30), nothing already found is dropped');
  }
  const freshVariants = runSchedulerSearchAll();
  const merged = new Map();
  LAST_VARIANTS.forEach(v => merged.set(resultSignature(v), v));
  freshVariants.forEach(v => { const sig = resultSignature(v); if(!merged.has(sig)) merged.set(sig, v); });
  LAST_VARIANTS = [...merged.values()].sort((a,b) => {
    const sa = resultScore(a), sb = resultScore(b);
    return sa[0] !== sb[0] ? sa[0]-sb[0] : sa[1]-sb[1];
  }).slice(0, 30); // cap so this can't grow unbounded across many clicks
  LAST_VARIANTS.forEach(v => { if(v) v.accepted = false; });
  LAST_RESULT = LAST_VARIANTS[0];
  if(LAST_RESULT){
    LAST_RESULT.accepted = false;
    LAST_RESULT.dragUndo = [];
    LAST_RESULT.dragBaseline = null;
  }
  if(LAST_VARIANTS.length > freshVariants.length){
    SearchLog.info(`Pool now has ${LAST_VARIANTS.length} distinct layouts (including ones from earlier clicks)`);
  }
  LAST_SEARCH_OVERVIEW = SearchLog.lines.slice();
  showLogForSelected();
  populateVariantSelector();
  renderResults(LAST_RESULT);
  markWorkDirty();
}
function requestGenerateTimetable(){
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
document.getElementById('generateCancelBtn').addEventListener('click', hideGenerateConfirm);
document.getElementById('generateKeepAcceptedBtn').addEventListener('click', () => queuePendingGenerate(false));
document.getElementById('generateClearAcceptedBtn').addEventListener('click', () => queuePendingGenerate(true));
document.getElementById('generateConfirmOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'generateConfirmOverlay') hideGenerateConfirm();
});
document.addEventListener('keydown', (e) => {
  if(e.key !== 'Escape') return;
  if(CAL_DRAG) return;
  if(!isGenerateConfirmOpen()) return;
  e.preventDefault();
  hideGenerateConfirm();
});

function populateVariantSelector(){
  const row = document.getElementById('variantRow');
  const sel = document.getElementById('variantSelect');
  if(LAST_VARIANTS.length <= 1){
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';
  const bandTotal = getBandLessons().length;
  sel.innerHTML = LAST_VARIANTS.map((v, i) => {
    const bandsUnresolved = v.unresolved.filter(u => u.lesson.id && u.lesson.id.startsWith('BAND')).length;
    const bandsOk = bandTotal - bandsUnresolved;
    const label = i === 0 ? 'Best' : `Variant ${i+1}`;
    const attempt = v.attemptNo ? ` · attempt ${v.attemptNo}` : '';
    return `<option value="${i}">${label}${attempt} — ${bandsOk}/${bandTotal} bands, ${v.scheduled.length} scheduled, ${v.unresolved.length} unresolved</option>`;
  }).join('');
  sel.value = '0';
}
function renderSearchLogBody(){
  const el = document.getElementById('searchLogBody');
  if(!el) return;
  const title = document.getElementById('searchLogTitle');
  const hint = document.getElementById('searchLogHint');
  if(title){
    title.textContent = LAST_RESULT && LAST_RESULT.attemptNo
      ? `Search log — attempt ${LAST_RESULT.attemptNo}`
      : 'Search log';
  }
  if(hint){
    hint.textContent = LAST_VARIANTS.length > 1
      ? 'Walkthrough of the currently selected variant — how it packed, how attempt-1 reds were cleared or not, and that layout\'s quota ledger. Switch the variant dropdown to see another log.'
      : 'How this layout was built, including unresolved (red) items and the quota ledger.';
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
  renderSearchLogBody();
  setModalOverlay('searchLogOverlay', true);
});
document.getElementById('searchLogCloseBtn').addEventListener('click', () => {
  setModalOverlay('searchLogOverlay', false);
});
document.getElementById('searchLogOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'searchLogOverlay') setModalOverlay('searchLogOverlay', false);
});

document.getElementById('variantSelect').addEventListener('change', (e) => {
  const idx = parseInt(e.target.value, 10) || 0;
  LAST_RESULT = LAST_VARIANTS[idx];
  showLogForSelected();
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
    <div class="stat"><div class="num">${DB.lessons.length + getBandLessons().length}</div><div class="lbl">Lesson groups</div></div>
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

  const quotasOverlay = document.getElementById('bandQuotasOverlay');
  if(overlayIsOpen(quotasOverlay)) renderBandQuotasModal();
}

document.getElementById('viewMode').addEventListener('change', renderGrid);
document.getElementById('teacherFilter').addEventListener('change', renderGrid);
document.querySelector('#viewMode').addEventListener('change', (e)=>{
  document.getElementById('teacherFilter').style.display = e.target.value==='teacher' ? 'inline-block':'none';
});

function renderGrid(){
  if(!LAST_RESULT) return;
  abortCalendarInteraction();
  LAST_AUDIT = auditTimetable(timetableAuditItems(LAST_RESULT.scheduled));
  const mode = document.getElementById('viewMode').value;
  const grid = document.getElementById('ttGrid');
  const legend = document.getElementById('ttLegend');
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
  // to cluster in one hue band, which is why everyone looked blue before).
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
    const dayItems = layoutColumns(items.filter(i => i.day === day));
    let blocksHtml = '';
    dayItems.forEach(i => {
      const top = (i.start - CAL_DAY_START) * CAL_PX_PER_MIN;
      const height = Math.max((i.end - i.start) * CAL_PX_PER_MIN - 2, 14);
      const widthPct = 100 / i._totalCols;
      const leftPct = i._col * widthPct;
      const style = (colorByTeacher && !i.source) ? (() => {
        const c = colorForTeacher(i.teacherId);
        return `background:${c.bg};border-left-color:${c.border};`;
      })() : '';
      const teacherLine = (colorByTeacher && !i.source) ? `<span class="meta">${i.teacher||i.teacherId}</span>` : '';
      const roomTag = i.room321 ? ' 🔒321' : '';
      const studentTitle = escapeAttr((i.studentNames && i.studentNames.length) ? `${i.name} — ${i.studentNames.length} students:\n${i.studentNames.join('\n')}` : i.name);
      const sourceCls = i.source === 'accepted' ? ' is-accepted-bg'
        : (i.source === 'oneone' ? ' is-oneone'
        : (i.source === 'rjpiano' ? ' is-rjpiano' : ''));
      const canDrag = dragSource ? i.source === dragSource : !i.source;
      const conflictCls = itemHasConflict(i) ? ' has-conflict' : '';
      const countLabel = i.studentCount === 1 ? '1 student' : `${i.studentCount} students`;
      blocksHtml += `<div class="cal-block${conflictCls}${sourceCls}${canDrag ? ' is-draggable' : ''}" data-lesson-id="${escapeAttr(i.lessonId)}" data-source="${escapeAttr(i.source || '')}" data-draggable="${canDrag ? '1' : ''}" data-tooltip="${studentTitle}" style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);${style}">
        <b>${i.name}${roomTag}</b>${teacherLine}<span class="meta">${toHHMM(i.start)}–${toHHMM(i.end)} · ${countLabel}</span>
      </div>`;
    });
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
      <td><div class="lesson-block${itemHasConflict(i) ? ' has-conflict' : ''}" data-tooltip="${studentTitle}"><b>${i.name}${i.room321 ? ' 🔒321' : ''}</b><span class="meta">${i.group} · ${i.lessonId}</span></div></td>
      <td>${i.teacher||i.teacherId}</td>
      <td>${i.studentCount}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  containerEl.innerHTML = html;
}

function lookupLessonForScheduled(item){
  if(!item || !item.lessonId) return null;
  if(String(item.lessonId).startsWith('BAND')){
    return getBandLessons().find(l => l.id === item.lessonId) || null;
  }
  return DB.lessons.find(l => l.id === item.lessonId) || null;
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
  if(typeof hasAcceptedRjPiano === 'function' && hasAcceptedRjPiano()){
    out.push.apply(out, (LAST_RJPIANO && LAST_RJPIANO.scheduled) || []);
  }
  return out.filter(i => i && i.day && i.start != null && i.end != null);
}
function generatedIndividualItems(){
  return ((LAST_ONEONE && LAST_ONEONE.scheduled) || [])
    .concat((LAST_RJPIANO && LAST_RJPIANO.scheduled) || [])
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
    room321: !!r.room321,
    source: 'accepted'
  }));
}
function combinedWeekItems(){
  return acceptedGroupItems().concat(generatedIndividualItems());
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
    const isIndividual = item.source === 'oneone' || item.source === 'rjpiano';
    if(!isIndividual && (item.start < DEFAULT_START || item.end > DEFAULT_END)){
      addIssue(`<b>${item.name}</b> sits outside the 08:00–20:00 school day (${itemSlotLabel(item)})`, item.lessonId);
    }
    const tw = teacherWindowClash(item.teacherId, item.teacher, item.day, item.start, item.end);
    if(tw) addIssue(`<b>${item.name}</b> ${itemSlotLabel(item)} — ${tw}`, item.lessonId);
    const sr = studentReservationClash(studentsOf.get(item) || [], item.day, item.start, item.end);
    if(sr) addIssue(`<b>${item.name}</b> ${itemSlotLabel(item)} — ${sr}`, item.lessonId);
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
      if(a.room321 && b.room321){
        addIssue(`<b>${a.name}</b> and <b>${b.name}</b> both need ROOM 321 at ${when}`, a.lessonId, b.lessonId);
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
        const gap = cur.start - prev.end;
        if(gap < 0) continue;
        const extra = breakUnitsForGap(gap, bs.minutes);
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
    if(units > bs.count){
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
        ? 'No constraint issues. Drag any lesson to another day or time — the move always sticks, and this list will show whatever breaks, including clashes with frozen 1/1 and Required Jazz Piano. Gap problems sit under WARNINGS — hover to read them.'
        : 'No constraint issues. Drag a lesson — the move always sticks. This list re-checks teacher windows, class reservations, double-bookings, ROOM 321, and break gaps against the accepted week plus 1/1 and Required Jazz Piano. Gap problems sit under WARNINGS — hover to read them.';
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
}
function markLayoutNeedsAccept(kind){
  if(kind === 'oneone' && LAST_ONEONE){
    LAST_ONEONE.accepted = false;
    return;
  }
  if(kind === 'rjpiano' && LAST_RJPIANO){
    LAST_RJPIANO.accepted = false;
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
  const state = kind === 'rjpiano' ? LAST_RJPIANO : LAST_ONEONE;
  if(!state || !state.dragUndo || !state.dragUndo.length) return;
  const step = state.dragUndo.pop();
  const item = (state.scheduled || []).find(it => String(it.lessonId) === String(step.lessonId));
  if(item && step.from){
    item.day = step.from.day;
    item.start = step.from.start;
    item.end = step.from.end;
  }
  if(kind === 'rjpiano') renderRjPianoTab();
  else renderOneOneTab();
  markWorkDirty();
}
function updateIndividualUndo(kind){
  const btn = document.getElementById(kind === 'rjpiano' ? 'rjpianoUndoBtn' : 'oneoneUndoBtn');
  if(!btn) return;
  const state = kind === 'rjpiano' ? LAST_RJPIANO : LAST_ONEONE;
  btn.disabled = !(state && state.dragUndo && state.dragUndo.length);
}
function resetVariantDrags(){
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
    LAST_RJPIANO && LAST_RJPIANO.scheduled
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
  if(kind === 'oneone' || kind === 'rjpiano'){
    const state = kind === 'oneone' ? LAST_ONEONE : LAST_RJPIANO;
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
    else renderRjPianoTab();
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
  if(e.button != null && e.button !== 0) return;
  const block = e.currentTarget;
  if(block.dataset.draggable !== '1') return;
  const lessonId = block.dataset.lessonId;
  const item = scheduledItemById(lessonId);
  if(!item) return;
  const container = block.closest('#ttGrid') || block.closest('#oneoneGrid') || block.closest('#rjpianoGrid') || block.closest('.cal-wrap');
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
    kind: source === 'oneone' || source === 'rjpiano' ? source : 'timetable',
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
  if(tabId === 'rjpiano'){
    if(!LAST_RJPIANO || !LAST_RJPIANO.dragUndo || !LAST_RJPIANO.dragUndo.length) return;
    e.preventDefault();
    undoIndividualDrag('rjpiano');
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
  if(i.lessonId && String(i.lessonId).startsWith('BAND')){
    const band = findBandById(i.lessonId);
    if(band) return BAND_TYPES.flatMap(t => band[t] || []).map(studentDisplayName).sort();
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
    'PRODID:-//BartokKonzi JAZZ//Timetable 2026//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Bartók JAZZ 2026',
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
    const uid = (i.lessonId || 'LES')+'-'+i.day+'@bartokkonzi-jazz';
    lines.push('BEGIN:VEVENT');
    lines.push('UID:'+uid);
    lines.push('DTSTAMP:'+stamp);
    lines.push('DTSTART;TZID=Europe/Budapest:'+icsLocal(when, i.start));
    lines.push('DTEND;TZID=Europe/Budapest:'+icsLocal(when, i.end));
    lines.push('RRULE:FREQ=WEEKLY;BYDAY='+ICS_DOW[i.day]+';UNTIL=20270615T200000Z');
    lines.push(icsFold('SUMMARY:'+icsEscape(title)));
    if(students.length) lines.push(icsFold('DESCRIPTION:'+icsEscape(students.join('\n'))));
    if(i.room321) lines.push('LOCATION:Room 321');
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
    room321: !!r.room321
  }));
}
document.getElementById('exportCalendarBtn').addEventListener('click', () => {
  const scheduled = acceptedItemsForExport().filter(i => i && i.day && i.start != null && i.end != null);
  if(!scheduled.length){
    alert('Accept a schedule first.');
    return;
  }
  const ics = buildTimetableIcs(scheduled, new Date());
  downloadFile('bartokkonzi_jazz_timetable.ics', ics, 'text/calendar;charset=utf-8');
  alert('Saved bartokkonzi_jazz_timetable.ics — in Google Calendar open Settings → Import & export → Import. Weekly events run through 15 June 2027. Import into a new calendar if you want to delete the whole set later.');
});

function renderAcceptedStatus(){
  const el = document.getElementById('acceptedStatus');
  if(!el) return;
  if(DB.acceptedTimetable && DB.acceptedTimetable.acceptedAt){
    const d = new Date(DB.acceptedTimetable.acceptedAt);
    const n = (DB.acceptedSchedule || []).filter(r => r.status === 'scheduled').length;
    const u = (DB.acceptedSchedule || []).filter(r => r.status === 'unresolved').length;
    el.textContent = `✓ Accepted ${d.toLocaleString()} — ${n} rows in Accepted schedule${u ? `, ${u} unresolved` : ''}. SCHEDULED columns on Lesson groups / Bands were filled; FIXED times and teacher overrides were left alone.`;
  } else {
    el.textContent = '';
  }
  updateOneOneTabLock();
  updateRjPianoTabLock();
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
    const kind = String(item.lessonId || '').startsWith('BAND') ? 'band' : 'lesson';
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
      room321: !!item.room321,
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
    const kind = String(l.id || '').startsWith('BAND') ? 'band' : 'lesson';
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
      room321: !!l.room321,
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
  if(LAST_BANDS && LAST_BANDS.bands) LAST_BANDS.bands.forEach(clearScheduledFields);
  DB.acceptedSchedule = [];
  DB.acceptedTimetable = null;
  LAST_ONEONE = null;
  LAST_RJPIANO = null;
  renderLessons();
  if(LAST_BANDS) renderBandsResults(LAST_BANDS);
  renderAcceptedSchedule();
  renderAcceptedStatus();
  renderOneOneTab();
  renderRjPianoTab();
}
function writeAcceptedToSourceTables(result){
  // SCHEDULED_* is a record of the last Accept — the generator never reads it.
  // FIXED / teacher override stay as the user's search constraints.
  (DB.lessons || []).forEach(clearScheduledFields);
  if(LAST_BANDS && LAST_BANDS.bands) LAST_BANDS.bands.forEach(clearScheduledFields);
  let lessonsWritten = 0;
  let bandsWritten = 0;
  (result.scheduled || []).forEach(item => {
    const startH = item.start != null ? toHHMM(item.start) : '';
    const endH = item.end != null ? toHHMM(item.end) : '';
    if(item.lessonId && String(item.lessonId).startsWith('BAND')){
      const band = findBandById(item.lessonId);
      if(!band) return;
      band.scheduledTeacherId = item.teacherId || '';
      band.scheduledTeacher = item.teacher || teacherName(item.teacherId) || '';
      band.scheduledDay = item.day || '';
      band.scheduledStart = startH;
      band.scheduledEnd = endH;
      bandsWritten++;
      return;
    }
    const lesson = (DB.lessons || []).find(l => l.id === item.lessonId);
    if(!lesson) return;
    lesson.scheduledDay = item.day || '';
    lesson.scheduledStart = startH;
    lesson.scheduledEnd = endH;
    lessonsWritten++;
  });
  return {lessonsWritten, bandsWritten};
}

const ACCEPTED_SCHEDULE_CSV_HEADERS = ['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_321','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA'];
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
      room321: !!item.room321,
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
      room321: false,
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
    + '<th>ROOM 321</th><th>KIND</th><th>STATUS</th><th>SCHEDULED DATA</th>'
    + '</tr></thead><tbody>';
  rows.forEach(r => {
    const cls = r.status === 'unresolved' ? ' class="is-unresolved"' : '';
    html += `<tr${cls}>`
      + `<td>${escapeAttr(r.day)}</td>`
      + `<td>${escapeAttr(r.start)}</td>`
      + `<td>${escapeAttr(r.end)}</td>`
      + `<td>${escapeAttr(r.name)}${r.lessonId ? `<div class="meta" style="font-family:var(--mono);font-size:10px;color:var(--ink-dim)">${escapeAttr(r.lessonId)}</div>` : ''}</td>`
      + `<td>${escapeAttr(r.teacher)}</td>`
      + `<td>${r.room321 ? '🔒321' : ''}</td>`
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
    r.day, r.start, r.end, r.duration, r.room321 ? 'TRUE' : 'FALSE',
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
  const {lessonsWritten, bandsWritten} = writeAcceptedToSourceTables(LAST_RESULT);
  renderLessons();
  if(LAST_BANDS) renderBandsResults(LAST_BANDS);
  renderAcceptedSchedule();
  renderAcceptedStatus();
  updateTimetableAcceptBtn();
  updateDragEditButtons();
  markWorkDirty();
  const bits = [`${(DB.acceptedSchedule || []).filter(r => r.status==='scheduled').length} rows in Accepted schedule`];
  if(lessonsWritten) bits.push(`${lessonsWritten} lesson SCHEDULED slot(s)`);
  if(bandsWritten) bits.push(`${bandsWritten} band SCHEDULED slot(s)`);
  alert('Schedule accepted — ' + bits.join(', ') + '. Generate still uses FIXED / teacher override only.');
}

document.getElementById('acceptScheduleBtn').addEventListener('click', acceptTimetableSchedule);

document.getElementById('exportAcceptedBtn').addEventListener('click', () => {
  downloadAcceptedScheduleCsv(DB.acceptedSchedule || [], 'bartokkonzi_jazz_accepted_schedule.csv');
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
    bandCount: document.getElementById('bandCountInput') ? document.getElementById('bandCountInput').value : '',
    viewMode: document.getElementById('viewMode') ? document.getElementById('viewMode').value : 'week',
    teacherFilter: document.getElementById('teacherFilter') ? document.getElementById('teacherFilter').value : '',
    activeTab: activeBtn && activeBtn.dataset.tab ? activeBtn.dataset.tab : 'students'
  };
}

function applyUiState(ui){
  if(!ui) return;
  const bandIn = document.getElementById('bandCountInput');
  if(bandIn && ui.bandCount != null && ui.bandCount !== '') bandIn.value = ui.bandCount;
  if(ui.activeTab){
    const btn = document.querySelector('.tab-btn[data-tab="'+ui.activeTab+'"]');
    if(btn) btn.click();
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
  if(LAST_RESULT && (ui.viewMode || ui.teacherFilter)) renderGrid();
}

function buildFullExportObject(){
  // Bundle every in-memory working field so a JSON (or cloud) save is a full snapshot:
  // tables, quotas, breaks, accepted timetable, band roster, every timetable variant,
  // the selected layout, the search log, the generate fingerprint, and the UI view.
  DB.bandsState = LAST_BANDS;
  DB.timetableVariants = LAST_VARIANTS;
  DB.timetableSelectedIndex = LAST_VARIANTS.indexOf(LAST_RESULT);
  DB.lastResult = LAST_RESULT;
  DB.searchLog = LAST_SEARCH_LOG;
  DB.searchOverview = LAST_SEARCH_OVERVIEW;
  DB.scheduleFingerprint = LAST_FINGERPRINT;
  DB.uiState = collectUiState();
  DB.oneToOneState = LAST_ONEONE;
  DB.rjPianoState = LAST_RJPIANO;
  return DB;
}

function restoreFromLoadedObject(loaded){
  const missing = REQUIRED_DB_KEYS.filter(k => !(k in loaded));
  if(missing.length){
    throw new Error('This data is missing: ' + missing.join(', ') + ' — it doesn\'t look like a BartokKonzi JAZZ database export.');
  }
  DB = loaded;
  DB.bandQuotas = DB.bandQuotas || []; // older exports may not have this yet
  DB.breaks = DB.breaks || []; // older exports may not have this yet
  DB.acceptedSchedule = DB.acceptedSchedule || [];
  DB.oneToOne = DB.oneToOne || {columns: [], hours: {}};
  DB.rjPiano = DB.rjPiano || {columns: [], hours: {}};
  LAST_ONEONE = DB.oneToOneState || LAST_ONEONE || null;
  LAST_RJPIANO = DB.rjPianoState || LAST_RJPIANO || null;
  renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderRefTables(); renderBreaksTable();

  // Restore the band roster exactly as it was when saved.
  LAST_BANDS = DB.bandsState || null;
  if(LAST_BANDS){
    ensureBandIdentities(LAST_BANDS);
    renderBandsResults(LAST_BANDS);
  }
  else {
    const bandsPanel = document.getElementById('bandsResultsPanel');
    const exclPanel = document.getElementById('bandsExcludedPanel');
    const stats = document.getElementById('bandsStatsRow');
    if(bandsPanel) bandsPanel.style.display = 'none';
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
  renderOneOneTab();
  renderRjPianoTab();
}

document.getElementById('exportDbBtn').addEventListener('click', () => {
  downloadFile('bartokkonzi_jazz_database.json', JSON.stringify(buildFullExportObject(), null, 1), 'application/json');
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
      alert('Database loaded — tables, bands, timetable, search log, quotas, and UI state were all restored exactly as saved.');
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
  bandQuotas: ['BAND_QUOTAS','BAND QUOTAS','BAND_QUOTA'],
  oneToOne: ['1_1','1/1','ONE_TO_ONE','ONETOONE','ONEONE','1 1'],
  rjPiano: ['JRPiano','RJPiano','JRPIANO','JR_PIANO','JR PIANO','RJPIANO','RJ_PIANO','RJ PIANO','REQUIRED JAZZ PIANO','JAZZ REQUIRED PIANO','JAZZ PIANO'],
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
function cellStr(c){
  if(c == null) return '';
  if(typeof c !== 'object'){
    return gvizDateToTime(c) || cleanCellText(c);
  }
  if(c.f != null && String(c.f).trim() !== '') return cleanCellText(c.f);
  if(c.v == null) return '';
  return gvizDateToTime(c.v) || cleanCellText(c.v);
}
function isBlankHeader(h){
  const n = normHeader(h);
  return !n || n === 'EMPTY' || /^EMPTY_\d+$/.test(n);
}
const ID_PAIR_PARENTS = new Set(['INSTR','CLASS','IMPR','VOC','JTH','SOLF','JHIST','RHIMPR','AC','TEACHER','GROUP']);
function inferHeaders(labels, colTypes, sheetKey){
  const out = labels.map(h => isBlankHeader(h) ? '' : normHeader(h));
  if(out[0] === 'BANDQ_ID') out[0] = 'BQ_ID';
  if(!out[0]) out[0] = 'ID';
  for(let i=1;i<out.length;i++){
    const prev = out[i-1];
    const typ = (colTypes && colTypes[i]) || '';
    if(sheetKey === 'refClasses' && !out[i] && (prev === 'CLASS' || prev === 'CLASS_ID' || prev === 'CLASSID' || prev === 'ID' || prev === 'NAME')){
      out[i] = 'JCLASS_TYPE';
      continue;
    }
    if(ID_PAIR_PARENTS.has(prev) && (!out[i] || out[i] === 'GROUP_ID')){
      out[i] = prev + '_ID';
      continue;
    }
    if(out[i]) continue;
    if(typ === 'datetime' || typ === 'timeofday' || prev === 'DAY' || prev === 'START'){
      out[i] = prev === 'START' ? 'END' : 'START';
      continue;
    }
    if(sheetKey === 'lessons' && (prev === 'TEACHER_ID' || prev === 'DURATION_MIN')){
      out[i] = prev === 'TEACHER_ID' ? 'DURATION_MIN' : 'ROOM_321';
      continue;
    }
    if(sheetKey === 'bandQuotas' && (prev === 'TEACHER_ID' || prev === 'TEACHER')){
      out[i] = 'BAND_AMOUNT';
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
  if(key === 'lessons') return has('LESSON_ID') || has('DURATION_MIN') || has('LESSON_NAME');
  if(key === 'teacherAvail') return has('DAY') && has('TYPE');
  if(key === 'classAvail') return has('DAY') && has('START') && (has('CLASS') || has('CLASSID') || has('CLASS_ID'));
  if(key === 'breaks') return has('BREAK_MIN') || has('BREAK_ID') || has('BREAK_COUNT');
  if(key === 'refTeachers') return has('NAME') && (has('ID') || has('TEACHER_ID')) && !has('NAME1') && !has('DAY');
  if(key === 'refClasses') return has('JCLASS_TYPE') || has('JCLASS') || (has('CLASS') && (has('CLASS_ID') || has('CLASSID')) && !has('NAME1'));
  if(key === 'refGroups') return has('TYPE') && has('NAME') && !has('NAME1') && !has('INSTR');
  if(key === 'refInstruments') return has('INSTR') && has('TYPE') && !has('NAME1');
  if(key === 'bandQuotas') return has('BQ_ID') || has('BANDQ_ID') || has('BAND_AMOUNT') || has('BAND_QUOTA');
  if(key === 'oneToOne' || key === 'rjPiano') return has('NAME1') && has('INSTR') && !has('CLASS_ID') && !has('CLASSID') && !has('IMPR') && !has('IMPR_ID');
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
function truthyFlag(v){
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'x' || s === 'igen' || s === 'on';
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
      headers: (sheetKey === 'oneToOne' || sheetKey === 'rjPiano') ? '1' : '0',
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
    throw new Error('No matching tabs found. Share the workbook as “Anyone with the link → Viewer”, or upload an .xlsx. Expected DATABASE_2627 tabs: STUDENTS, TEACHER_CONST, CLASS_CONST, LESSONS, BAND_QUOTAS, 1_1, JRPiano, TEACHERS, BREAK_MANAGEMENT, CLASS, GROUPS, INSTR.');
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
        const explicit = rowGet(r,'JCLASS_TYPE','JCLASS','YEAR','GRADE');
        const fromName = (/^(\d+)/.exec(name) || [])[1] || '';
        return {
          id: rowGet(r,'ID','CLASS_ID','CLASSID'),
          name,
          jclass: explicit || fromName
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

  const tById = lookupMapBy(refTeachers, 'id');
  const tByName = lookupMapBy(refTeachers, 'name');
  const cById = lookupMapBy(refClasses, 'id');
  const cByName = lookupMapBy(refClasses, 'name');
  const gById = lookupMapBy(refGroups, 'id');
  const gByName = lookupMapBy(refGroups, 'name');
  const iById = lookupMapBy(refInstruments, 'id');
  const iByName = lookupMapBy(refInstruments, 'name');

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
        BAND1: rowGet(r,'BAND1'),
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
      return {
        id: rowGet(r,'LESSON_ID','ID') || ('LES'+(i+1)),
        name: rowGet(r,'NAME','LESSON_NAME','LESSON'),
        group: resolveName(gById, groupId, group),
        groupId,
        teacher: resolveName(tById, teacherId, teacher),
        teacherId,
        duration: parseInt(rowGet(r,'DURATION_MIN','DURATION'),10) || 90,
        room321: truthyFlag(rowGet(r,'ROOM_321','ROOM321','ROOM')),
        fixedDay: normDay(rowGet(r,'FIXED_DAY')),
        fixedStart: normTime(rowGet(r,'FIXED_START')),
        fixedEnd: normTime(rowGet(r,'FIXED_END')),
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
        start: normTime(rowGet(r,'START')),
        end: normTime(rowGet(r,'END')),
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

  let bandQuotas;
  if(tables.bandQuotas && tables.bandQuotas.length){
    bandQuotas = tables.bandQuotas.map((r,i) => {
      const teacher = rowGet(r,'NAME','TEACHER');
      const teacherId = resolveId(tById, tByName, rowGet(r,'TEACHER_ID'), teacher);
      return {
        id: rowGet(r,'BQ_ID','BANDQ_ID','ID') || ('BQ'+(i+1)),
        teacherId,
        teacher: resolveName(tById, teacherId, teacher),
        amount: parseInt(rowGet(r,'BAND_QUOTA','BAND_AMOUNT','AMOUNT','QUOTA'),10) || 0,
      };
    }).filter(r => r.teacherId || r.teacher);
  } else if(tables.bandQuotas){
    bandQuotas = [];
  } else {
    bandQuotas = take('bandQuotas');
  }

  let oneToOne;
  if(tables.oneToOne && tables.oneToOne.length){
    oneToOne = parseOneToOneTable(tables.oneToOne, refTeachers);
  } else if(DB.oneToOne && (DB.oneToOne.columns || DB.oneToOne.hours)){
    keep.push('oneToOne');
    oneToOne = JSON.parse(JSON.stringify(DB.oneToOne));
  } else {
    oneToOne = {columns: [], hours: {}};
  }

  let rjPiano;
  if(tables.rjPiano && tables.rjPiano.length){
    rjPiano = parseOneToOneTable(tables.rjPiano, refTeachers);
  } else if(DB.rjPiano && (DB.rjPiano.columns || DB.rjPiano.hours)){
    keep.push('rjPiano');
    rjPiano = JSON.parse(JSON.stringify(DB.rjPiano));
  } else {
    rjPiano = {columns: [], hours: {}};
  }

  let acceptedSchedule;
  if(tables.acceptedSchedule && tables.acceptedSchedule.length){
    acceptedSchedule = tables.acceptedSchedule.map(r => ({
      lessonId: rowGet(r,'LESSON_ID','ID'),
      name: rowGet(r,'NAME','LESSON_NAME','LESSON'),
      kind: rowGet(r,'KIND') || (String(rowGet(r,'LESSON_ID')).startsWith('BAND') ? 'band' : 'lesson'),
      group: rowGet(r,'GROUP'),
      groupId: rowGet(r,'GROUP_ID'),
      teacher: rowGet(r,'TEACHER'),
      teacherId: rowGet(r,'TEACHER_ID'),
      day: normDay(rowGet(r,'DAY')),
      start: normTime(rowGet(r,'START')),
      end: normTime(rowGet(r,'END')),
      duration: parseInt(rowGet(r,'DURATION_MIN','DURATION'),10) || '',
      room321: truthyFlag(rowGet(r,'ROOM_321','ROOM321')),
      studentCount: parseInt(rowGet(r,'STUDENT_COUNT'),10) || 0,
      students: rowGet(r,'STUDENTS'),
      studentIds: rowGet(r,'STUDENT_IDS','STUDENT_ID'),
      status: rowGet(r,'STATUS') || 'scheduled',
      note: rowGet(r,'NOTE'),
    })).filter(r => r.lessonId || r.name);
  } else {
    acceptedSchedule = take('acceptedSchedule');
  }

  return {
    db: {
      students, lessons, teacherAvail, classAvail,
      refTeachers, refClasses, refGroups, refInstruments,
      bandQuotas, breaks, oneToOne, rjPiano,
      bandsState: null, timetableVariants: [], lastResult: null,
      acceptedTimetable: null, acceptedSchedule, searchLog: [], searchOverview: [],
      scheduleFingerprint: null,
    },
    keep,
  };
}

async function importFromDriveTables(loaded, sourceLabel){
  const {db, keep} = sheetsTablesToDb(loaded.tables);
  let msg = 'Replace the working tables with this Google Sheet? Bands and the current timetable will be cleared so they do not point at old IDs.';
  if(WORK_DIRTY || hasUnacceptedDrags()){
    msg = 'This tab has work that is only in the browser autosave (including any dragged times). ' + msg;
  }
  if(!confirm(msg)){
    setSheetsStatus('Load cancelled.');
    return;
  }
  restoreFromLoadedObject(db);
  markWorkDirty();
  const bits = [
    `${db.students.length} students`,
    `${db.lessons.length} lessons`,
    `${db.teacherAvail.length} teacher-avail`,
    `${db.classAvail.length} reservations`,
    `${db.refTeachers.length} teachers`,
    `${collectOneOneAssignments(db.oneToOne).length} 1/1 hours`,
    `${collectOneOneAssignments(db.rjPiano).length} Required Jazz Piano hours`,
  ];
  const extra = keep.length ? ` Kept existing ${keep.join(', ')} (those tabs were missing).` : '';
  setSheetsStatus(`✓ Loaded ${sourceLabel} — ${bits.join(', ')}. Tabs: ${loaded.found.join(', ')}.${extra} Bands and timetable were cleared.`);
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
    headers: ['TEACHER','TEACHER_ID','DAY','START','END','TYPE','NOTE'],
    rows: (db) => (db.teacherAvail || []).map(r => [
      r.teacher, r.teacherId, r.day, exportTime(r.start), exportTime(r.end), r.type, r.option
    ])
  },
  {
    key: 'classAvail', name: 'CLASS_CONST',
    headers: ['CLASS','CLASS_ID','DAY','START','END','AVAIL','NOTE'],
    rows: (db) => (db.classAvail || []).map(r => [
      r.class, r.classId, r.day, exportTime(r.start), exportTime(r.end), 'RESERVED', r.note
    ])
  },
  {
    key: 'lessons', name: 'LESSONS',
    headers: ['LESSON_ID','LESSON NAME','GROUP','GROUP_ID','TEACHER','TEACHER_ID','DURATION_MIN','ROOM_321','FIXED_DAY','FIXED_START','FIXED_END','SCHEDULED_DAY','SCHEDULED_START','SCHEDULED_END','SCHEDULED_DATA'],
    rows: (db) => (db.lessons || []).map(r => [
      r.id, r.name, r.group, r.groupId, r.teacher, r.teacherId,
      r.duration, r.room321 ? 'TRUE' : 'FALSE',
      r.fixedDay || '', exportTime(r.fixedStart), exportTime(r.fixedEnd),
      r.scheduledDay || '', exportTime(r.scheduledStart), exportTime(r.scheduledEnd),
      formatLessonScheduledData(r)
    ])
  },
  {
    key: 'bandQuotas', name: 'BAND_QUOTAS',
    headers: ['BQ_ID','TEACHER','TEACHER_ID','BAND_AMOUNT'],
    rows: (db) => (db.bandQuotas || []).map(r => [r.id, r.teacher, r.teacherId, r.amount])
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
    headers: ['CLASS_ID','CLASS','JCLASS_TYPE'],
    rows: (db) => (db.refClasses || []).map(r => [r.id, r.name, r.jclass])
  },
  {
    key: 'refGroups', name: 'GROUPS',
    headers: ['GROUP_ID','TYPE','NAME'],
    rows: (db) => (db.refGroups || []).map(r => [r.id, r.type, r.name])
  },
  {
    key: 'refInstruments', name: 'INSTR',
    headers: ['INSTR_ID','TYPE','INSTR'],
    rows: (db) => (db.refInstruments || []).map(r => [r.id, r.type, r.name])
  },
  {
    key: 'acceptedSchedule', name: 'ACCEPTED_SCHEDULE',
    headers: ['LESSON_ID','NAME','KIND','TEACHER','TEACHER_ID','DAY','START','END','DURATION_MIN','ROOM_321','STUDENT_COUNT','STUDENTS','STUDENT_IDS','STATUS','NOTE','SCHEDULED_DATA'],
    rows: (db) => (db.acceptedSchedule || []).map(r => [
      r.lessonId, r.name, r.kind, r.teacher, r.teacherId,
      r.day, r.start, r.end, r.duration, r.room321 ? 'TRUE' : 'FALSE',
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
  return tables;
}
function driveTablesToAoa(db){
  const sheets = DRIVE_EXPORT_SPECS.map(spec => ({
    name: spec.name,
    aoa: [spec.headers].concat(spec.rows(db).map(vals => vals.map(exportCell)))
  }));
  const i = sheets.findIndex(s => s.name === 'BAND_QUOTAS');
  const at = i < 0 ? sheets.length : i + 1;
  sheets.splice(at, 0, oneToOneAoa(db), rjPianoAoa(db));
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

// ==================== BANDS ====================
const BAND_TYPES = ['bass','drum','acc','sol'];
const BAND_SCARCE = new Set(['bass','drum']);

function studentType(s){ return instrType(s.INSTR_ID); }
function studentJclass(s){ return classJclass(s.CLASS_ID); } // '' if no class / no jclass set

// Grade ordering for "try a neighboring grade before giving up" matching.
// 1 and 13 are the same level (post-12 year), so they're treated as identical here.
const JCLASS_LEVEL_ORDER = ['9','10','11','12','L1_13','2','3'];
function jclassLevelKey(j){ return (j === '1' || j === '13') ? 'L1_13' : j; }
function jclassDistance(a, b){
  if(!a || !b) return Infinity;
  const ka = jclassLevelKey(a), kb = jclassLevelKey(b);
  if(ka === kb) return 0; // exact match, or 1↔13 (same level)
  const ia = JCLASS_LEVEL_ORDER.indexOf(ka), ib = JCLASS_LEVEL_ORDER.indexOf(kb);
  if(ia === -1 || ib === -1) return Infinity; // custom/unrecognized jclass value: only matches itself
  return Math.abs(ia - ib);
}

let LAST_BANDS = null;

function generateBands(numBands){
  const eligible = DB.students.filter(s => studentJclass(s) !== '');
  const excluded = DB.students.filter(s => studentJclass(s) === '');

  const neverUsed = {}, usedOnce = {}, appearances = {};
  BAND_TYPES.forEach(t => { neverUsed[t] = eligible.filter(s => studentType(s) === t); usedOnce[t] = []; });
  eligible.forEach(s => { appearances[s.ID] = 0; });

  const bands = Array.from({length:numBands}, (_, i) => emptyBandRecord('BAND' + (i+1)));

  // Picks the closest-grade match available: exact/same-level first, then the nearest
  // neighboring grade in JCLASS_LEVEL_ORDER, and only if the type's pool is truly empty
  // does it fall back to anyone at all (or, for bass/drum, a repeat).
  function pick(type, targetJclass, avoidIds){
    let cands = neverUsed[type].filter(s => !avoidIds.has(s.ID));
    if(cands.length){
      if(targetJclass){
        cands = cands.slice().sort((a,b) => jclassDistance(studentJclass(a), targetJclass) - jclassDistance(studentJclass(b), targetJclass));
      }
      const chosen = cands[0];
      neverUsed[type] = neverUsed[type].filter(s => s !== chosen);
      usedOnce[type].push(chosen);
      return chosen;
    }
    if(BAND_SCARCE.has(type)){
      let rcands = usedOnce[type].filter(s => !avoidIds.has(s.ID));
      if(rcands.length){
        if(targetJclass){
          rcands = rcands.slice().sort((a,b) => jclassDistance(studentJclass(a), targetJclass) - jclassDistance(studentJclass(b), targetJclass));
        }
        const chosen = rcands[0];
        usedOnce[type] = usedOnce[type].filter(s => s !== chosen);
        return chosen;
      }
    }
    return null;
  }

  // PASS 1: fully same-grade bands, one level at a time (1 and 13 pooled together as one
  // level), limited by the scarcest type present at that level.
  const levelKeys = [...new Set(eligible.map(s => jclassLevelKey(studentJclass(s))))]
    .sort((a,b) => {
      const ia = JCLASS_LEVEL_ORDER.indexOf(a), ib = JCLASS_LEVEL_ORDER.indexOf(b);
      if(ia === -1 && ib === -1) return a.localeCompare(b);
      if(ia === -1) return 1;
      if(ib === -1) return -1;
      return ia - ib;
    });
  let bandI = 0;
  for(const levelKey of levelKeys){
    const counts = {}; BAND_TYPES.forEach(t => { counts[t] = neverUsed[t].filter(s => jclassLevelKey(studentJclass(s))===levelKey).length; });
    const n = Math.min(...BAND_TYPES.map(t => counts[t]));
    for(let k=0; k<n && bandI<numBands; k++){
      const avoid = new Set(); const picks = {}; let ok = true;
      // pick a representative student first to anchor the target grade for this band
      let anchorPick = null;
      for(const t of BAND_TYPES){
        const cand = neverUsed[t].find(s => jclassLevelKey(studentJclass(s)) === levelKey && !avoid.has(s.ID));
        if(cand){ anchorPick = cand; break; }
      }
      const g = anchorPick ? studentJclass(anchorPick) : levelKey;
      for(const t of BAND_TYPES){
        const chosen = pick(t, g, avoid);
        if(!chosen){ ok = false; break; }
        picks[t] = chosen; avoid.add(chosen.ID);
      }
      if(ok){
        BAND_TYPES.forEach(t => { bands[bandI][t].push(picks[t]); appearances[picks[t].ID]++; });
        bandI++;
      }
    }
  }

  // PASS 2: fill the rest, anchored on bass (then drum) — pick() itself now prefers the
  // closest grade (same level, then nearest neighbor) before falling back to anyone.
  while(bandI < numBands){
    const anchorType = (neverUsed.bass.length || usedOnce.bass.length) ? 'bass'
                       : (neverUsed.drum.length || usedOnce.drum.length) ? 'drum' : null;
    if(!anchorType) break;
    const avoid = new Set();
    const anchor = pick(anchorType, null, avoid);
    if(!anchor) break;
    bands[bandI][anchorType].push(anchor); appearances[anchor.ID]++;
    avoid.add(anchor.ID);
    const targetG = studentJclass(anchor);
    for(const t of BAND_TYPES){
      if(t === anchorType) continue;
      const chosen = pick(t, targetG, avoid);
      if(chosen){ bands[bandI][t].push(chosen); appearances[chosen.ID]++; avoid.add(chosen.ID); }
    }
    bandI++;
  }

  function bandSize(i){ return BAND_TYPES.reduce((sum,t) => sum + bands[i][t].length, 0); }
  function bandJclasses(i){
    const c = {};
    BAND_TYPES.forEach(t => bands[i][t].forEach(s => { const j = studentJclass(s); c[j] = (c[j]||0)+1; }));
    return c;
  }
  // How well a candidate grade fits a band's existing mix: exact/same-level members count
  // most, near neighbors count a bit, anything else counts nothing.
  function closenessScore(bandIdx, candidateJclass){
    const jc = bandJclasses(bandIdx);
    let score = 0;
    for(const [g, n] of Object.entries(jc)){
      const d = jclassDistance(g, candidateJclass);
      if(d === 0) score += 3*n;
      else if(d === 1) score += 1.5*n;
      else if(d === 2) score += 0.5*n;
    }
    return score;
  }

  // PASS 3: place every remaining surplus acc/sol student as an extra member — at most one
  // extra per type per band, preferring bands that are already grade-close to the student
  // (same/neighboring grade), and preferring bands not already carrying the OTHER type's
  // extra (keeps sizes close to 4-6).
  for(const t of ['acc','sol']){
    const otherFlag = t === 'acc' ? 'sol' : 'acc';
    const flagKey = '_extra_' + t;
    bands.forEach(b => { b[flagKey] = false; });
    const otherFlagKey = '_extra_' + otherFlag;
    bands.forEach(b => { if(b[otherFlagKey] === undefined) b[otherFlagKey] = false; });

    const leftovers = neverUsed[t].slice();
    leftovers.forEach(person => {
      let best = -1, bestScore = null;
      for(let i=0; i<numBands; i++){
        if(bands[i][flagKey]) continue;
        const score = [closenessScore(i, studentJclass(person)), bands[i][otherFlagKey] ? 0 : 1, -bandSize(i)];
        if(bestScore === null || score[0] > bestScore[0] || (score[0]===bestScore[0] && score[1] > bestScore[1]) ||
           (score[0]===bestScore[0] && score[1]===bestScore[1] && score[2] > bestScore[2])){
          bestScore = score; best = i;
        }
      }
      if(best === -1){
        // every band already has its one extra of this type: allow a second as a last resort
        for(let i=0; i<numBands; i++){
          const score = [closenessScore(i, studentJclass(person)), -bandSize(i)];
          if(bestScore === null || score[0] > bestScore[0] || (score[0]===bestScore[0] && score[1] > bestScore[1])){
            bestScore = score; best = i;
          }
        }
      }
      bands[best][t].push(person); appearances[person.ID]++;
      bands[best][flagKey] = true;
      neverUsed[t] = neverUsed[t].filter(s => s !== person);
    });
  }

  return {bands, excluded, appearances, eligibleCount: eligible.length, nextBandSeq: numBands + 1};
}

function computeBandAppearanceCounts(bands){
  const counts = {};
  bands.forEach(b => BAND_TYPES.forEach(t => b[t].forEach(s => { counts[s.ID] = (counts[s.ID]||0) + 1; })));
  return counts;
}

function studentDisplayName(s){ return `${s.NAME1} ${s.NAME2}${s.NAME3 ? ' '+s.NAME3 : ''}`; }

function renderBandCard(band, index, appearanceCounts){
  const jc = {};
  BAND_TYPES.forEach(t => band[t].forEach(s => { const j = studentJclass(s); jc[j] = (jc[j]||0)+1; }));
  const jmix = Object.entries(jc).sort((a,b)=>b[1]-a[1]).map(([g,n]) => `${g}×${n}`).join(' · ');

  let rows = '';
  BAND_TYPES.forEach(t => {
    band[t].forEach(s => {
      const isDouble = (appearanceCounts[s.ID]||0) >= 2;
      rows += `<div class="band-member${isDouble?' double-booked':''}">
        <span class="role">${t.toUpperCase()}</span>
        <span class="who">${studentDisplayName(s)}<br><span class="cls">${instrName(s.INSTR_ID)} · ${className(s.CLASS_ID)||'—'}</span></span>
        <button class="band-member-remove" data-band="${index}" data-type="${t}" data-sid="${s.ID}" title="Remove from this band">✕</button>
      </div>`;
    });
  });

  const quotaTeachers = (DB.bandQuotas || [])
    .filter(bq => bq.teacherId && (parseInt(bq.amount, 10) || 0) > 0)
    .map(bq => ({
      id: bq.teacherId,
      name: bq.teacher || teacherName(bq.teacherId),
      amount: parseInt(bq.amount, 10) || 0
    }))
    .sort((a,b) => a.name.localeCompare(b.name));
  const teacherOptions = ['<option value="">— auto-match by quota</option>'].concat(
    quotaTeachers.map(t =>
      `<option value="${escapeAttr(t.id)}" ${t.id===band.teacherId?'selected':''}>${escapeAttr(`${t.name} (quota ${t.amount})`)}</option>`
    )
  ).join('');

  const memberIds = new Set(BAND_TYPES.flatMap(t => band[t].map(s => s.ID)));
  const addOptions = ['<option value="">+ Add student…</option>'].concat(
    DB.students
      .filter(s => !memberIds.has(s.ID))
      .map(s => `<option value="${escapeAttr(s.ID)}">${escapeAttr(studentDisplayName(s))} — ${escapeAttr(instrName(s.INSTR_ID))}${studentType(s)?'':' (no TYPE)'}</option>`)
  ).join('');

  return `<div class="band-card">
    <h4><span>${escapeAttr(bandShortLabel(band))} <span class="band-jmix">${jmix}</span></span><button class="band-member-remove band-delete-btn" data-band="${index}" title="Delete this band">✕</button></h4>
    <div class="band-teacher-row band-teacher-assign">
      <label title="Uses 1 of this teacher's BAND QUOTA. Leave on '—' to auto-match. A teacher with no remaining quota cannot take the band.">Teacher override</label>
      <select class="band-teacher-select" data-band="${index}">${teacherOptions}</select>
    </div>
    <div class="band-teacher-row">
      <label>Duration</label>
      <input type="number" class="band-duration-input" data-band="${index}" value="${band.duration ?? 90}" min="15" step="15" style="width:64px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:12px;">
      <label class="band-room-toggle"><input type="checkbox" class="band-room321-checkbox" data-band="${index}" ${band.room321!==false?'checked':''}> Room 321</label>
    </div>
    <div class="band-teacher-row" title="Optional — pin this band to an exact slot. Still fails if a member has a class reservation then, or no matching teacher is free.">
      <label>Fixed time</label>
      <select class="band-fixedday-select" data-band="${index}" style="width:64px;padding:6px 4px;font-size:11px;">
        <option value="">—</option>
        ${DAYS.map(d => `<option value="${d}" ${band.fixedDay===d?'selected':''}>${d}</option>`).join('')}
      </select>
      <input type="text" class="band-fixedstart-input" data-band="${index}" value="${escapeAttr(band.fixedStart||'')}" placeholder="09:00" style="width:56px;padding:6px 6px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:11px;">
      <span style="color:var(--ink-dim);font-size:11px;">–</span>
      <input type="text" class="band-fixedend-input" data-band="${index}" value="${escapeAttr(band.fixedEnd||'')}" placeholder="10:30" style="width:56px;padding:6px 6px;border-radius:8px;border:1px solid var(--border);background:var(--surface-solid);font-family:var(--mono);font-size:11px;">
    </div>
    <div class="band-teacher-row band-scheduled-row" title="Filled by ✓ Accept this schedule. Generate ignores this — use Fixed time / Teacher override to pin the next search.">
      <label>Scheduled</label>
      <span>${band.scheduledDay
        ? escapeAttr(`${band.scheduledTeacher || teacherName(band.scheduledTeacherId) || '—'} · ${band.scheduledDay} ${band.scheduledStart || ''}–${band.scheduledEnd || ''}`)
        : '—'}</span>
    </div>
    ${rows}
    <div class="band-add-row">
      <select class="band-add-select" data-band="${index}">${addOptions}</select>
    </div>
  </div>`;
}

document.getElementById('generateBandsBtn').addEventListener('click', requestGenerateBands);

function requestGenerateBands(){
  if(hasAcceptedRecord()){
    showGenerateConfirm('bands');
    return;
  }
  queueGenerateBands(false);
}
function queueGenerateBands(clearAccepted){
  hideGenerateConfirm();
  setBandsBusy(true);
  setTimeout(() => {
    try {
      runGenerateBands(clearAccepted);
    } finally {
      setBandsBusy(false);
    }
  }, 0);
}
function runGenerateBands(clearAccepted, count){
  hideGenerateConfirm();
  const raw = count != null ? count : parseInt((document.getElementById('bandCountInput') || {}).value, 10);
  const n = Math.max(1, raw || 17);
  const hadScheduled = hasAcceptedRecord();
  if(clearAccepted && hadScheduled) clearAcceptedScheduledRecord();
  clearGeneratedTimetableGrid();
  LAST_BANDS = generateBands(n);
  renderBandsResults(LAST_BANDS);
  markWorkDirty();
  return LAST_BANDS;
}

document.getElementById('addBandBtn').addEventListener('click', () => {
  if(!LAST_BANDS){
    LAST_BANDS = {bands: [], excluded: [], appearances: {}, eligibleCount: 0, nextBandSeq: 1};
  }
  LAST_BANDS.bands.push(emptyBandRecord(mintBandId(LAST_BANDS)));
  renderBandsResults(LAST_BANDS);
  markWorkDirty();
});

// ---------- Band Quotas modal ----------
function scheduledBandCountsByTeacher(){
  const counts = {};
  if(!LAST_RESULT) return counts;
  LAST_RESULT.scheduled.forEach(s => {
    if(s.lessonId && String(s.lessonId).startsWith('BAND') && s.teacherId){
      counts[s.teacherId] = (counts[s.teacherId] || 0) + 1;
    }
  });
  return counts;
}

function renderBandQuotasModal(){
  const el = document.getElementById('bandQuotasTable');
  const usedBy = scheduledBandCountsByTeacher();
  let html = '<thead><tr><th>BQ_ID</th><th>NAME</th><th style="min-width:110px">BAND QUOTA</th><th>USED</th><th></th></tr></thead><tbody>';
  (DB.bandQuotas || []).forEach((bq, i) => {
    const used = usedBy[bq.teacherId] || 0;
    const cap = parseInt(bq.amount,10) || 0;
    html += `<tr data-idx="${i}">
      <td>${escapeAttr(bq.id)}</td>
      <td>${escapeAttr(bq.teacher || teacherName(bq.teacherId))}</td>
      <td style="min-width:110px"><input data-idx="${i}" value="${escapeAttr(bq.amount ?? 0)}" style="width:70px;"></td>
      <td>${LAST_RESULT ? `${used} / ${cap}` : '—'}</td>
      <td><button class="btn danger small" data-remove="${i}" title="Remove this teacher from the Band Quotas list entirely">✕</button></td>
    </tr>`;
  });
  html += '</tbody>';
  el.innerHTML = html;

  function updateTotal(){
    const total = (DB.bandQuotas || []).reduce((s,bq) => s + (parseInt(bq.amount,10) || 0), 0);
    const used = Object.values(scheduledBandCountsByTeacher()).reduce((s,n) => s + n, 0);
    document.getElementById('bandQuotasTotal').textContent = LAST_RESULT ? `${used} used / ${total} quota` : String(total);
  }
  el.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(e.target.dataset.idx, 10);
      DB.bandQuotas[idx].amount = e.target.value;
      updateTotal();
    });
  });
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.dataset.remove, 10);
      DB.bandQuotas.splice(idx, 1);
      renderBandQuotasModal();
    });
  });
  updateTotal();

  // "+ Add teacher" row — only teachers not already in the list are offered, since a
  // teacher not present here should never be eligible for an auto-matched band.
  const addRow = document.getElementById('bandQuotasAddSelect');
  if(addRow){
    const listedIds = new Set((DB.bandQuotas || []).map(bq => bq.teacherId));
    const available = DB.refTeachers.filter(t => !listedIds.has(t.id));
    addRow.innerHTML = '<option value="">Add a teacher…</option>' +
      available.map(t => `<option value="${escapeAttr(t.id)}">${escapeAttr(t.name)}</option>`).join('');
  }
}
document.getElementById('bandQuotasAddBtn').addEventListener('click', () => {
  const sel = document.getElementById('bandQuotasAddSelect');
  const teacherId = sel.value;
  if(!teacherId) return;
  const t = DB.refTeachers.find(x => x.id === teacherId);
  if(!t) return;
  DB.bandQuotas = DB.bandQuotas || [];
  const nextN = DB.bandQuotas.length
    ? Math.max(...DB.bandQuotas.map(bq => parseInt((bq.id||'BQ0').replace('BQ',''),10) || 0)) + 1
    : 1;
  DB.bandQuotas.push({id:'BQ'+nextN, teacherId: t.id, teacher: t.name, amount: 1});
  renderBandQuotasModal();
});
document.getElementById('bandQuotasBtn').addEventListener('click', () => {
  renderBandQuotasModal();
  setModalOverlay('bandQuotasOverlay', true);
});
document.getElementById('bandQuotasCloseBtn').addEventListener('click', () => {
  setModalOverlay('bandQuotasOverlay', false);
});
document.getElementById('bandQuotasOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'bandQuotasOverlay') setModalOverlay('bandQuotasOverlay', false);
});

function renderBandsResults(result){
  const {bands, excluded, eligibleCount} = result;
  document.getElementById('bandsResultsPanel').style.display = 'block';

  const appearanceCounts = computeBandAppearanceCounts(bands);
  const covered = Object.values(appearanceCounts).filter(v => v > 0).length;
  const twice = Object.values(appearanceCounts).filter(v => v >= 2).length;
  const statsRow = document.getElementById('bandsStatsRow');
  statsRow.style.display = 'flex';
  statsRow.innerHTML = `
    <div class="stat"><div class="num">${bands.length}</div><div class="lbl">Bands</div></div>
    <div class="stat"><div class="num">${covered}/${eligibleCount}</div><div class="lbl">Students placed</div></div>
    <div class="stat"><div class="num">${twice}</div><div class="lbl">Placed in 2 bands</div></div>
    <div class="stat"><div class="num">${excluded.length}</div><div class="lbl">No class (excluded)</div></div>
  `;

  document.getElementById('bandsGrid').innerHTML = bands.map((b,i) => renderBandCard(b, i, appearanceCounts)).join('');

  document.querySelectorAll('.band-member-remove:not(.band-delete-btn)').forEach(btn => {
    btn.addEventListener('click', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      const type = e.currentTarget.dataset.type;
      const sid = e.currentTarget.dataset.sid;
      LAST_BANDS.bands[bi][type] = LAST_BANDS.bands[bi][type].filter(s => s.ID !== sid);
      renderBandsResults(LAST_BANDS);
      markWorkDirty();
    });
  });
  document.querySelectorAll('.band-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands.splice(bi, 1);
      renderBandsResults(LAST_BANDS);
      markWorkDirty();
    });
  });
  document.querySelectorAll('.band-add-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      const sid = e.currentTarget.value;
      if(!sid) return;
      const student = DB.students.find(s => s.ID === sid);
      if(!student) return;
      let type = studentType(student);
      if(!BAND_TYPES.includes(type)){
        alert(`${studentDisplayName(student)}'s instrument (${instrName(student.INSTR_ID)||'—'}) has no recognized TYPE (sol/acc/bass/drum) — set it in Reference tables → Instruments first. Adding as SOL for now.`);
        type = 'sol';
      }
      if(!LAST_BANDS.bands[bi][type].some(s => s.ID === sid)){
        LAST_BANDS.bands[bi][type].push(student);
      }
      renderBandsResults(LAST_BANDS);
      markWorkDirty();
    });
  });
  document.querySelectorAll('.band-teacher-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].teacherId = e.currentTarget.value;
      markWorkDirty();
    });
  });
  function clampBandBookedWindow(bi){
    const band = LAST_BANDS.bands[bi];
    if(!clampBookedWindowToDuration(band)) return;
    const endInp = document.querySelector(`.band-fixedend-input[data-band="${bi}"]`);
    if(endInp) endInp.value = band.fixedEnd;
  }
  document.querySelectorAll('.band-duration-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].duration = parseInt(e.currentTarget.value, 10) || 90;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampBandBookedWindow(parseInt(e.currentTarget.dataset.band, 10));
    });
  });
  document.querySelectorAll('.band-room321-checkbox').forEach(cb => {
    cb.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].room321 = e.currentTarget.checked;
      markWorkDirty();
    });
  });
  document.querySelectorAll('.band-fixedday-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].fixedDay = e.currentTarget.value;
      markWorkDirty();
      updateFixedPinsBanner();
    });
  });
  document.querySelectorAll('.band-fixedstart-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].fixedStart = e.currentTarget.value;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampBandBookedWindow(parseInt(e.currentTarget.dataset.band, 10));
    });
  });
  document.querySelectorAll('.band-fixedend-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const bi = parseInt(e.currentTarget.dataset.band, 10);
      LAST_BANDS.bands[bi].fixedEnd = e.currentTarget.value;
      markWorkDirty();
    });
    inp.addEventListener('change', e => {
      clampBandBookedWindow(parseInt(e.currentTarget.dataset.band, 10));
    });
  });

  const exclPanel = document.getElementById('bandsExcludedPanel');
  if(excluded.length){
    exclPanel.style.display = 'block';
    document.getElementById('bandsExcludedList').innerHTML = excluded.map(s =>
      `<li><b>${studentDisplayName(s)}</b> — ${instrName(s.INSTR_ID)} (${s.ID}, no CLASS assigned)</li>`
    ).join('');
  } else {
    exclPanel.style.display = 'none';
  }
  updateFixedPinsBanner();
}

document.getElementById('downloadBandsBtn').addEventListener('click', () => {
  if(!LAST_BANDS){ alert('Generate the bands first.'); return; }
  const rows = [toCsvRow(["BAND","TEACHER","DURATION_MIN","ROOM_321","ROLE","STUDENT_ID","NAME","INSTRUMENT","CLASS","JCLASS_TYPE"])];
  LAST_BANDS.bands.forEach(b => {
    const teacher = teacherName(b.teacherId) || '';
    BAND_TYPES.forEach(t => {
      b[t].forEach(s => {
        rows.push(toCsvRow([bandShortLabel(b), teacher, b.duration ?? 90, b.room321!==false ? 'YES' : 'NO', t.toUpperCase(), s.ID, studentDisplayName(s), instrName(s.INSTR_ID), className(s.CLASS_ID), studentJclass(s)]));
      });
    });
  });
  downloadFile('bartokkonzi_jazz_bands.csv', rows.join('\r\n'));
});

// ---------- 1/1 individual-lesson scheduler ----------
// Packs one-person lessons around the accepted group timetable. Hard constraints:
// teacher availability, class reservations (every leftover gap, not only the largest),
// no overlap with accepted bookings or other 1/1. Breaks are flexible: prefer sitting
// flush against an existing teacher block, then spreading evenly across available days.
let LAST_ONEONE = null;
let LAST_RJPIANO = null;
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
function acceptedBusyMaps(rows){
  const teacherBusy = {};
  const studentBusy = {};
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
  });
  return {teacherBusy, studentBusy};
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
function formatOneOneHours(h){
  const n = parseOneOneHours(h);
  if(!n) return '';
  return String(n);
}
function parseOneToOneTable(rows, refTeachers){
  const teachers = refTeachers || [];
  const tByNorm = {};
  teachers.forEach(t => {
    if(t && t.name) tByNorm[normHeader(t.name)] = t;
    if(t && t.id) tByNorm[normHeader(t.id)] = t;
  });
  const identity = new Set(['STUDENT_ID','ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID','NAME']);
  const columns = [];
  const seen = new Set();
  const headerKeys = rows && rows[0] ? Object.keys(rows[0]) : [];
  headerKeys.forEach(h => {
    const nh = normHeader(h);
    if(!nh || identity.has(nh)) return;
    const t = tByNorm[nh];
    if(!t || !t.id || seen.has(t.id)) return;
    seen.add(t.id);
    columns.push({id: t.id, name: t.name});
  });
  const hours = {};
  (rows || []).forEach(r => {
    const sid = rowGet(r, 'STUDENT_ID', 'ID');
    if(!sid) return;
    headerKeys.forEach(h => {
      const nh = normHeader(h);
      if(!nh || identity.has(nh)) return;
      const t = tByNorm[nh];
      if(!t || !t.id) return;
      const n = parseOneOneHours(r[h]);
      if(!n) return;
      hours[sid] = hours[sid] || {};
      hours[sid][t.id] = n;
    });
  });
  return {columns, hours};
}
function hoursMatrixAoa(db, matrix, sheetName){
  const m = matrix || {columns: [], hours: {}};
  const cols = m.columns || [];
  const headers = ['STUDENT_ID','NAME1','NAME2','NAME3','PUBLIC_NAME','INSTR','INSTR_ID'].concat(cols.map(c => c.name));
  const rows = (db.students || []).map(s => {
    const line = [s.ID, s.NAME1, s.NAME2, s.NAME3, s.PUBLIC_NAME, s.INSTR, s.INSTR_ID];
    cols.forEach(c => {
      const h = ((m.hours || {})[s.ID] || {})[c.id];
      if(!h){ line.push(''); return; }
      line.push(Number.isInteger(h) ? String(h) : String(h).replace('.', ','));
    });
    return line;
  });
  return {name: sheetName, aoa: [headers].concat(rows)};
}
function oneToOneAoa(db){
  return hoursMatrixAoa(db, db.oneToOne, '1_1');
}
function rjPianoAoa(db){
  return hoursMatrixAoa(db, db.rjPiano, 'JRPiano');
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
  const wins = teacherId ? teacherDayWindows(teacherId) : {};
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
    name: s.name
  }));
  const maps = acceptedBusyMaps(accepted.concat(extraRows));
  const tBusy = {};
  DAYS.forEach(d => { tBusy[d] = ((maps.teacherBusy[teacherId] || {})[d] || []).slice(); });

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

  const target = Math.ceil(jobs.length / Math.max(1, days.length));
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
    let ivs = subtractBusyFromIntervals([[win.start, win.end]], reserved);
    const busy = (tBusy[day] || []).concat(((maps.studentBusy[student.ID] || {})[day]) || []);
    ivs = subtractBusyFromIntervals(ivs, busy);
    const slots = [];
    ivs.forEach(([s,e]) => {
      candidateStartsForInterval(s, e, dur, tBusy[day], randomize).forEach(start => {
        const end = start + dur;
        if(busy.some(iv => intervalsOverlap(start, end, iv.start, iv.end))) return;
        if(overlappingClassReservation(student.CLASS_ID, day, start, end)) return;
        if(teacherWindowClash(teacherId, tname, day, start, end)) return;
        slots.push({day, start, end, gap: intervalGapScore(start, end, tBusy[day]), rank: win.rank});
      });
    });
    return slots;
  }

  jobs.sort((a,b) => {
    const fa = days.reduce((n,d) => n + (studentDaySlots(a.student, d, a.duration).length ? 1 : 0), 0);
    const fb = days.reduce((n,d) => n + (studentDaySlots(b.student, d, b.duration).length ? 1 : 0), 0);
    return fa - fb || (randomize ? rng() - 0.5 : 0);
  });
  if(randomize) jobs = shuffledCopy(jobs, rng);

  jobs.forEach(job => {
    const slots = days.flatMap(d => studentDaySlots(job.student, d, job.duration));
    if(!slots.length){
      unresolved.push({
        studentId: job.student.ID,
        name: studentDisplayName(job.student),
        teacherId,
        reason: 'no shared free slot with the teacher (accepted bookings, class reservations, or availability)'
      });
      return;
    }
    slots.sort((a,b) => {
      const overA = Math.max(0, (dayCount[a.day] + 1) - target);
      const overB = Math.max(0, (dayCount[b.day] + 1) - target);
      // Pack against existing teacher blocks first. Even-day spread is a
      // tie-break: a 3-hour hole is worse than going one over the per-day target.
      return a.gap - b.gap
        || overA - overB
        || dayCount[a.day] - dayCount[b.day]
        || a.rank - b.rank
        || DAYS.indexOf(a.day) - DAYS.indexOf(b.day)
        || a.start - b.start;
    });
    const tight = randomize ? slots.filter(s => s.gap === slots[0].gap) : slots;
    const pick = (randomize && tight.length > 1)
      ? tight[Math.floor(rng() * tight.length)]
      : slots[0];
    const prefix = (opts && opts.idPrefix) || 'O2O';
    const label = (opts && opts.lessonLabel) || '1/1';
    const source = (opts && opts.source) || 'oneone';
    const item = {
      lessonId: prefix + '-' + teacherId + '-' + job.student.ID + (job.copy ? '-' + (job.copy + 1) : ''),
      name: studentDisplayName(job.student) + ' ' + label,
      group: label, groupId: '',
      teacherId, teacher: tname,
      day: pick.day, start: pick.start, end: pick.end,
      studentCount: 1,
      studentNames: [studentDisplayName(job.student)],
      studentId: job.student.ID,
      studentIds: job.student.ID,
      room321: false,
      source,
      duration: job.duration
    };
    scheduled.push(item);
    tBusy[pick.day].push({start: pick.start, end: pick.end, name: item.name});
    maps.studentBusy[job.student.ID] = maps.studentBusy[job.student.ID] || {};
    maps.studentBusy[job.student.ID][pick.day] = maps.studentBusy[job.student.ID][pick.day] || [];
    maps.studentBusy[job.student.ID][pick.day].push({start: pick.start, end: pick.end});
    dayCount[pick.day]++;
  });

  scheduled.sort((a,b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start);
  return {scheduled, unresolved, duration, teacherId, dayCount, target};
}

function scheduleAllOneToOne(opts){
  const assignments = (opts && opts.assignments) || collectOneOneAssignments((opts && opts.matrix) || DB.oneToOne);
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
    const da = DAYS.filter(d => teacherDayWindows(a)[d]).length;
    const dbn = DAYS.filter(d => teacherDayWindows(b)[d]).length;
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

const ONEONE_SEARCH_ATTEMPTS = 15;
const ONEONE_SEARCH_MAX_TRIES = 60;
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
function oneOneResultScore(result){
  const idle = result && Number.isFinite(result.idleGapMinutes)
    ? result.idleGapMinutes
    : scheduledIdleGapMinutes(result && result.scheduled);
  return [
    ((result && result.unresolved) || []).length,
    -(((result && result.scheduled) || []).length),
    idle
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
function scheduleAllOneToOneSearch(opts){
  const accepted = (opts && opts.acceptedRows) || [];
  const seen = new Map();
  const first = attachOneOneLayoutScore(
    scheduleAllOneToOne(Object.assign({}, opts, {randomize: false})),
    accepted
  );
  first.attemptNo = 1;
  first.attemptKind = 'deterministic';
  seen.set(resultSignature(first), first);
  let n = 2;
  while(seen.size < ONEONE_SEARCH_ATTEMPTS && n <= ONEONE_SEARCH_MAX_TRIES){
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
function individualSearchFingerprint(kind){
  const matrix = kind === 'rjpiano' ? DB.rjPiano : DB.oneToOne;
  return JSON.stringify({
    kind,
    accepted: (DB.acceptedSchedule || []).map(r => [r.lessonId, r.day, r.start, r.end, r.teacherId]),
    oneone: kind === 'rjpiano' ? ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).map(s => [s.lessonId, s.day, s.start, s.end]) : null,
    hours: (matrix && matrix.hours) || {}
  });
}
function applyIndividualSearch(kind, fresh, viewTeacherId){
  const fp = individualSearchFingerprint(kind);
  const prev = kind === 'rjpiano' ? LAST_RJPIANO : LAST_ONEONE;
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
  if(kind === 'rjpiano') LAST_RJPIANO = state;
  else {
    LAST_ONEONE = state;
    LAST_RJPIANO = null;
  }
  return state;
}
function populateIndividualVariantSelector(kind){
  const state = kind === 'rjpiano' ? LAST_RJPIANO : LAST_ONEONE;
  const row = document.getElementById(kind === 'rjpiano' ? 'rjpianoVariantRow' : 'oneoneVariantRow');
  const sel = document.getElementById(kind === 'rjpiano' ? 'rjpianoVariantSelect' : 'oneoneVariantSelect');
  if(!row || !sel) return;
  const variants = (state && state.variants) || [];
  if(variants.length <= 1){
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';
  const idx = Math.max(0, Math.min(state.selectedIndex || 0, variants.length - 1));
  sel.innerHTML = variants.map((v, i) => {
    const label = i === 0 ? 'Best' : `Variant ${i + 1}`;
    const attempt = v.attemptNo ? ` · attempt ${v.attemptNo}` : '';
    const gaps = Number.isFinite(v.idleGapMinutes) ? `, ${v.idleGapMinutes} min gaps` : '';
    return `<option value="${i}">${label}${attempt} — ${v.scheduled.length} placed, ${v.unresolved.length} left out${gaps}</option>`;
  }).join('');
  sel.value = String(idx);
}
function selectIndividualVariant(kind, idx){
  const state = kind === 'rjpiano' ? LAST_RJPIANO : LAST_ONEONE;
  if(!state || !state.variants || !state.variants[idx]) return;
  const v = state.variants[idx];
  state.selectedIndex = idx;
  state.scheduled = v.scheduled;
  state.unresolved = v.unresolved;
  state.accepted = false;
  state.dragUndo = [];
  state.dragBaseline = null;
  if(kind === 'rjpiano') renderRjPianoTab();
  else renderOneOneTab();
  markWorkDirty();
}

function updateOneOneTabLock(){
  const btn = document.querySelector('.tab-btn-oneone');
  if(!btn) return;
  const ok = hasAcceptedRecord();
  btn.classList.toggle('is-locked', !ok);
  btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  btn.title = ok ? '1/1 individual lessons' : 'Accept a timetable first';
}
function hasAcceptedOneOne(){
  return !!(LAST_ONEONE && LAST_ONEONE.accepted && (LAST_ONEONE.scheduled || []).length);
}
function hasAcceptedRjPiano(){
  return !!(LAST_RJPIANO && LAST_RJPIANO.accepted && (LAST_RJPIANO.scheduled || []).length);
}
function updateRjPianoTabLock(){
  const btn = document.querySelector('.tab-btn-rjpiano');
  if(!btn) return;
  const ok = hasAcceptedOneOne();
  btn.classList.toggle('is-locked', !ok);
  btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
  btn.title = ok ? 'Required Jazz Piano' : 'Accept 1/1 first';
}
function busyRowsFromScheduled(items){
  return (items || []).filter(s => s && s.day && s.start != null && s.end != null).map(s => ({
    status: 'scheduled',
    teacherId: s.teacherId,
    day: s.day,
    start: s.start,
    end: s.end,
    studentIds: s.studentIds || s.studentId || '',
    name: s.name || ''
  }));
}
function teacherIndividualItems(teacherId){
  if(!teacherId) return [];
  const one = ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).filter(s => s.teacherId === teacherId);
  const piano = ((LAST_RJPIANO && LAST_RJPIANO.scheduled) || []).filter(s => s.teacherId === teacherId);
  return one.concat(piano).filter(i => i.start != null && i.end != null && i.day);
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
    room321: !!r.room321,
    source: 'accepted'
  }));
}
function teacherWeekItems(teacherId){
  if(!teacherId) return [];
  return oneoneAcceptedItemsForTeacher(teacherId)
    .concat(teacherIndividualItems(teacherId))
    .filter(i => i.start != null && i.end != null && i.day);
}
function individualTeacherIds(kind){
  const ids = [];
  if(kind !== 'rjpiano'){
    collectOneOneAssignments(DB.oneToOne).forEach(a => { if(a.teacherId) ids.push(a.teacherId); });
    ((LAST_ONEONE && LAST_ONEONE.scheduled) || []).forEach(s => { if(s.teacherId) ids.push(s.teacherId); });
  }
  if(kind !== 'oneone'){
    collectOneOneAssignments(DB.rjPiano).forEach(a => { if(a.teacherId) ids.push(a.teacherId); });
    ((LAST_RJPIANO && LAST_RJPIANO.scheduled) || []).forEach(s => { if(s.teacherId) ids.push(s.teacherId); });
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
  const current = sel.value || (stateObj && stateObj.viewTeacherId) || ids[0];
  const pick = ids.includes(current) ? current : ids[0];
  sel.innerHTML = ids.map(id => `<option value="${escapeAttr(id)}" ${id===pick?'selected':''}>${escapeAttr(teacherName(id)||id)}</option>`).join('');
  if(stateObj) stateObj.viewTeacherId = sel.value;
}
function renderTeacherWeekGrid(grid, sel, stateObj, emptyHtml, kind){
  if(!grid) return;
  fillIndividualTeacherFilter(sel, stateObj, '— generate first —', kind);
  const teacherId = (sel && sel.value) || (stateObj && stateObj.viewTeacherId) || '';
  const items = teacherWeekItems(teacherId);
  LAST_AUDIT = auditTimetable(combinedWeekItems());
  if(!items.length){
    grid.innerHTML = emptyHtml;
    const wrap = document.getElementById((kind === 'rjpiano' ? 'rjpiano' : 'oneone') + 'AuditWrap');
    if(wrap) wrap.style.display = 'none';
    updateIndividualUndo(kind);
    return;
  }
  renderCalendar(grid, items, false, kind);
  attachHoverTooltips(grid);
  attachCalendarDrag(grid);
  renderAuditPanel({
    prefix: kind === 'rjpiano' ? 'rjpiano' : 'oneone',
    lessonIds: items.map(i => i.lessonId).filter(Boolean)
  });
  updateIndividualUndo(kind);
}

function renderOneOneGrid(){
  renderTeacherWeekGrid(
    document.getElementById('oneoneGrid'),
    document.getElementById('oneoneTeacherFilter'),
    LAST_ONEONE,
    '<p class="dataio-hint" style="margin:0">Open the 1/1 matrix, then Generate all 1/1. Pick a teacher here to see grey accepted blocks, gold 1/1, and teal Required Jazz Piano.</p>',
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
  const head = `<thead><tr>
    <th class="is-sticky">Student</th>
    ${cols.map(c => `<th class="oneone-tcol">${escapeAttr(c.name)}</th>`).join('')}
  </tr></thead>`;
  const body = students.map(s => {
    const cells = cols.map(c => {
      const val = formatOneOneHours(((m.hours || {})[s.ID] || {})[c.id]);
      const filled = val ? ' is-filled' : '';
      return `<td class="oneone-tcol${filled}"><input type="number" class="oneone-cell" data-sid="${escapeAttr(s.ID)}" data-tid="${escapeAttr(c.id)}" min="0" max="6" step="0.5" value="${escapeAttr(val)}" title="Hours with ${escapeAttr(c.name)} (1 = 60 min)"></td>`;
    }).join('');
    return `<tr>
      <td class="is-sticky"><div class="oneone-sid">${escapeAttr(s.ID)}</div><div class="oneone-sname">${escapeAttr(studentDisplayName(s))}</div><div class="meta" style="font-size:10px;color:var(--ink-dim)">${escapeAttr(instrName(s.INSTR_ID)||'—')}</div></td>
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
  updateRjPianoTabLock();
  ensureOneToOneMatrix();
  const summary = document.getElementById('oneoneSummary');
  const tag = document.getElementById('oneoneStatusTag');
  const scheduled = (LAST_ONEONE && LAST_ONEONE.scheduled) || [];
  const unresolved = (LAST_ONEONE && LAST_ONEONE.unresolved) || [];
  const assignments = collectOneOneAssignments(DB.oneToOne);
  const teacherN = new Set(assignments.map(a => a.teacherId)).size;
  if(summary){
    if(!hasAcceptedRecord()){
      summary.textContent = 'Accept a timetable first.';
    } else if(LAST_ONEONE && LAST_ONEONE.accepted){
      summary.textContent = `1/1 accepted — ${scheduled.length} frozen. Required Jazz Piano is unlocked.`;
    } else if(scheduled.length){
      const nVar = (LAST_ONEONE.variants || []).length;
      summary.textContent = `${scheduled.length} 1/1 placed${nVar > 1 ? ` · ${nVar} layouts` : ''}. Accept 1/1 to freeze this layout (including any dragged times).`;
    } else if(assignments.length){
      summary.textContent = `${assignments.length} 1/1 hours across ${teacherN} teacher${teacherN===1?'':'s'} · 1 = 60 min, 1.5 = 90, 2 = 120. Generate, then Accept 1/1 before piano.`;
    } else {
      summary.textContent = 'Fill hours in the matrix below (1 = 60 min), then Generate all 1/1.';
    }
  }
  if(tag){
    tag.textContent = scheduled.length
      ? `${scheduled.length} placed${unresolved.length ? ` · ${unresolved.length} left out` : ''}${((LAST_ONEONE.variants||[]).length > 1) ? ` · ${(LAST_ONEONE.variants||[]).length} layouts` : ''}${LAST_ONEONE && LAST_ONEONE.accepted ? ' · accepted' : ''}`
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
    emptyHtml: 'No teacher columns — load the Drive 1_1 tab or add teachers in Reference tables.'
  });
}
function setOneOneGenerateBusy(busy){
  const btn = document.getElementById('oneoneGenerateBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : '▶ Generate all 1/1';
}
function runOneOneGenerate(){
  if(!hasAcceptedRecord()){
    alert('Accept a timetable first.');
    return;
  }
  ensureOneToOneMatrix();
  const assignments = collectOneOneAssignments(DB.oneToOne);
  if(!assignments.length){
    alert('The 1/1 matrix is empty. Fill hours in the table (1 = 60 min).');
    return;
  }
  setOneOneGenerateBusy(true);
  setTimeout(() => {
    try {
      const variants = scheduleAllOneToOneSearch({
        matrix: DB.oneToOne,
        acceptedRows: DB.acceptedSchedule || []
      });
      applyIndividualSearch(
        'oneone',
        variants,
        (document.getElementById('oneoneTeacherFilter') || {}).value
      );
      renderOneOneTab();
      renderRjPianoTab();
      if(LAST_RESULT) renderGrid();
      markWorkDirty();
    } finally {
      setOneOneGenerateBusy(false);
    }
  }, 0);
}
function acceptOneOneSchedule(){
  if(!LAST_ONEONE || !(LAST_ONEONE.scheduled || []).length){
    alert('Generate 1/1 first.');
    return;
  }
  LAST_ONEONE.accepted = true;
  LAST_ONEONE.acceptedAt = new Date().toISOString();
  LAST_ONEONE.acceptedSchedule = individualAcceptedRows(LAST_ONEONE, '1/1');
  LAST_ONEONE.dragUndo = [];
  LAST_ONEONE.dragBaseline = cloneLessonSlots(LAST_ONEONE.scheduled);
  LAST_RJPIANO = null;
  renderOneOneTab();
  renderRjPianoTab();
  if(LAST_RESULT) renderGrid();
  markWorkDirty();
  alert('1/1 accepted — those slots are frozen. Required Jazz Piano is unlocked and will pack around the accepted week plus these 1/1 hours.');
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
document.getElementById('exportOneoneAcceptedBtn').addEventListener('click', () => {
  const rows = hasAcceptedOneOne()
    ? ((LAST_ONEONE.acceptedSchedule && LAST_ONEONE.acceptedSchedule.length)
      ? LAST_ONEONE.acceptedSchedule
      : individualAcceptedRows(LAST_ONEONE, '1/1'))
    : [];
  downloadAcceptedScheduleCsv(rows, 'bartokkonzi_jazz_accepted_1_1.csv');
});

function ensureRjPianoMatrix(){
  DB.rjPiano = DB.rjPiano || {columns: [], hours: {}};
  DB.rjPiano.columns = DB.rjPiano.columns || [];
  DB.rjPiano.hours = DB.rjPiano.hours || {};
  const emptyHours = !Object.keys(DB.rjPiano.hours).length;
  if(emptyHours && SEED.rjPiano && SEED.rjPiano.hours && Object.keys(SEED.rjPiano.hours).length){
    DB.rjPiano = JSON.parse(JSON.stringify(SEED.rjPiano));
  }
  return DB.rjPiano;
}
function setRjPianoHours(studentId, teacherId, hours){
  ensureRjPianoMatrix();
  DB.rjPiano.hours[studentId] = DB.rjPiano.hours[studentId] || {};
  const n = parseOneOneHours(hours);
  if(!n) delete DB.rjPiano.hours[studentId][teacherId];
  else DB.rjPiano.hours[studentId][teacherId] = n;
}
function renderRjPianoMatrix(){
  renderHoursMatrixPanel({
    wrapId: 'rjpianoMatrixWrap',
    countId: 'rjpianoMatrixCount',
    filterId: 'rjpianoMatrixFilter',
    matrix: ensureRjPianoMatrix(),
    setHours: setRjPianoHours,
    tableClass: 'is-rjpiano',
    emptyHtml: 'No piano teacher columns — load the Drive JRPiano tab.'
  });
}
function renderRjPianoGrid(){
  renderTeacherWeekGrid(
    document.getElementById('rjpianoGrid'),
    document.getElementById('rjpianoTeacherFilter'),
    LAST_RJPIANO,
    '<p class="dataio-hint" style="margin:0">Accept 1/1, then Generate Required Jazz Piano. Pick a teacher to see grey accepted blocks, gold 1/1, and teal Required Jazz Piano.</p>',
    'rjpiano'
  );
}
function renderRjPianoTab(){
  updateRjPianoTabLock();
  ensureRjPianoMatrix();
  const summary = document.getElementById('rjpianoSummary');
  const tag = document.getElementById('rjpianoStatusTag');
  const scheduled = (LAST_RJPIANO && LAST_RJPIANO.scheduled) || [];
  const unresolved = (LAST_RJPIANO && LAST_RJPIANO.unresolved) || [];
  const assignments = collectOneOneAssignments(DB.rjPiano);
  const teacherN = new Set(assignments.map(a => a.teacherId)).size;
  if(summary){
    if(!hasAcceptedOneOne()){
      summary.textContent = 'Accept 1/1 first — piano packs into leftover holes around the frozen week and 1/1.';
    } else if(LAST_RJPIANO && LAST_RJPIANO.accepted){
      summary.textContent = `Required Jazz Piano accepted — ${scheduled.length} frozen.`;
    } else if(scheduled.length){
      const nVar = (LAST_RJPIANO.variants || []).length;
      summary.textContent = `${scheduled.length} piano hours placed${nVar > 1 ? ` · ${nVar} layouts` : ''}. Accept Required Jazz Piano to freeze this layout (including any dragged times).`;
    } else if(assignments.length){
      summary.textContent = `${assignments.length} Required Jazz Piano hours across ${teacherN} teacher${teacherN===1?'':'s'} · 1 = 60 min, 0.5 = 30. Generate, then Accept to freeze the slots.`;
    } else {
      summary.textContent = 'Fill hours in the matrix below (1 = 60 min), then Generate Required Jazz Piano.';
    }
  }
  if(tag){
    tag.textContent = scheduled.length
      ? `${scheduled.length} placed${unresolved.length ? ` · ${unresolved.length} left out` : ''}${((LAST_RJPIANO.variants||[]).length > 1) ? ` · ${(LAST_RJPIANO.variants||[]).length} layouts` : ''}${LAST_RJPIANO && LAST_RJPIANO.accepted ? ' · accepted' : ''}`
      : '';
  }
  renderPlacementStats('rjpianoStatsRow', scheduled, unresolved, 'RJP placed');
  renderUnresolvedList('rjpianoUnresolvedWrap', 'rjpianoUnresolvedList', unresolved);
  populateIndividualVariantSelector('rjpiano');
  const acceptBtn = document.getElementById('rjpianoAcceptBtn');
  if(acceptBtn){
    acceptBtn.disabled = !scheduled.length || !!(LAST_RJPIANO && LAST_RJPIANO.accepted);
    acceptBtn.textContent = (LAST_RJPIANO && LAST_RJPIANO.accepted) ? '✓ Required Jazz Piano accepted' : '✓ Accept Required Jazz Piano';
  }
  renderRjPianoGrid();
  renderRjPianoMatrix();
  fillAcceptedSchedulePanel({
    panel: 'rjpianoAcceptedSchedulePanel',
    table: 'rjpianoAcceptedScheduleTable',
    tag: 'rjpianoAcceptedScheduleTag'
  }, hasAcceptedRjPiano() ? (LAST_RJPIANO.acceptedSchedule || individualAcceptedRows(LAST_RJPIANO, 'piano')) : []);
}
function setRjPianoGenerateBusy(busy){
  const btn = document.getElementById('rjpianoGenerateBtn');
  if(!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? 'Generating…' : '▶ Generate Required Jazz Piano';
}
function runRjPianoGenerate(){
  if(!hasAcceptedOneOne()){
    alert('Accept 1/1 first.');
    return;
  }
  ensureRjPianoMatrix();
  const assignments = collectOneOneAssignments(DB.rjPiano);
  if(!assignments.length){
    alert('The Required Jazz Piano matrix is empty. Fill hours in the table (1 = 60 min).');
    return;
  }
  setRjPianoGenerateBusy(true);
  setTimeout(() => {
    try {
      const variants = scheduleAllOneToOneSearch({
        matrix: DB.rjPiano,
        acceptedRows: (DB.acceptedSchedule || []).concat(busyRowsFromScheduled(LAST_ONEONE && LAST_ONEONE.scheduled)),
        source: 'rjpiano',
        lessonLabel: 'piano',
        idPrefix: 'RJP'
      });
      applyIndividualSearch(
        'rjpiano',
        variants,
        (document.getElementById('rjpianoTeacherFilter') || {}).value
      );
      renderRjPianoTab();
      renderOneOneTab();
      if(LAST_RESULT) renderGrid();
      markWorkDirty();
    } finally {
      setRjPianoGenerateBusy(false);
    }
  }, 0);
}
function acceptRjPianoSchedule(){
  if(!hasAcceptedOneOne()){
    alert('Accept 1/1 first.');
    return;
  }
  if(!LAST_RJPIANO || !(LAST_RJPIANO.scheduled || []).length){
    alert('Generate Required Jazz Piano first.');
    return;
  }
  LAST_RJPIANO.accepted = true;
  LAST_RJPIANO.acceptedAt = new Date().toISOString();
  LAST_RJPIANO.acceptedSchedule = individualAcceptedRows(LAST_RJPIANO, 'piano');
  LAST_RJPIANO.dragUndo = [];
  LAST_RJPIANO.dragBaseline = cloneLessonSlots(LAST_RJPIANO.scheduled);
  renderRjPianoTab();
  renderOneOneTab();
  if(LAST_RESULT) renderGrid();
  markWorkDirty();
  alert('Required Jazz Piano accepted — those slots are frozen.');
}

document.getElementById('rjpianoGenerateBtn').addEventListener('click', runRjPianoGenerate);
document.getElementById('rjpianoAcceptBtn').addEventListener('click', acceptRjPianoSchedule);
document.getElementById('rjpianoUndoBtn').addEventListener('click', () => undoIndividualDrag('rjpiano'));
document.getElementById('rjpianoVariantSelect').addEventListener('change', (e) => {
  selectIndividualVariant('rjpiano', parseInt(e.target.value, 10) || 0);
});
document.getElementById('rjpianoMatrixFilter').addEventListener('input', renderRjPianoMatrix);
document.getElementById('rjpianoTeacherFilter').addEventListener('change', () => {
  LAST_RJPIANO = LAST_RJPIANO || {scheduled: [], unresolved: []};
  LAST_RJPIANO.viewTeacherId = document.getElementById('rjpianoTeacherFilter').value;
  renderRjPianoGrid();
});
document.getElementById('exportRjpianoAcceptedBtn').addEventListener('click', () => {
  const rows = hasAcceptedRjPiano()
    ? ((LAST_RJPIANO.acceptedSchedule && LAST_RJPIANO.acceptedSchedule.length)
      ? LAST_RJPIANO.acceptedSchedule
      : individualAcceptedRows(LAST_RJPIANO, 'piano'))
    : [];
  downloadAcceptedScheduleCsv(rows, 'bartokkonzi_jazz_accepted_rjpiano.csv');
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
  const bands = (LAST_BANDS && LAST_BANDS.bands || []).filter(b => b.fixedDay);
  return {lessons, bands};
}
function clearAllFixedPins(){
  (DB.lessons || []).forEach(l => { l.fixedDay = ''; l.fixedStart = ''; l.fixedEnd = ''; });
  if(LAST_BANDS && LAST_BANDS.bands){
    LAST_BANDS.bands.forEach(b => { b.fixedDay = ''; b.fixedStart = ''; b.fixedEnd = ''; });
  }
  renderLessons();
  if(LAST_BANDS) renderBandsResults(LAST_BANDS);
  updateFixedPinsBanner();
  markWorkDirty();
}
function updateFixedPinsBanner(){
  const {lessons, bands} = collectFixedPins();
  const n = lessons.length + bands.length;
  const text = n
    ? `${lessons.length} lesson${lessons.length === 1 ? '' : 's'}${bands.length ? ` · ${bands.length} band${bands.length === 1 ? '' : 's'}` : ''} pinned with FIXED times — Generate locks those slots. Leftover pins from an older Accept stay until you clear them.`
    : '';
  ['fixedPinsBanner', 'fixedPinsBannerLessons', 'fixedPinsBannerBands'].forEach(id => {
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
  if(!autosaveEnabled()) return false;
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
    return false;
  }
}
function discardAutosaveAndReloadSeed(){
  if(!confirm('Reload the original seed tables and drop this browser’s autosave? Bands and the timetable will be cleared.')) return;
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
    localStorage.removeItem(AUTOSAVE_META_KEY);
  } catch(e){}
  DB = JSON.parse(JSON.stringify(SEED));
  LAST_BANDS = null;
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
  LAST_RJPIANO = null;
  WORK_DIRTY = false;
  renderStudents(); renderLessons(); renderAvail(); renderCAvail(); renderRefTables(); renderBreaksTable();
  const bandsPanel = document.getElementById('bandsResultsPanel');
  const exclPanel = document.getElementById('bandsExcludedPanel');
  const stats = document.getElementById('bandsStatsRow');
  if(bandsPanel) bandsPanel.style.display = 'none';
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
  renderRjPianoTab();
  updateFixedPinsBanner();
  const note = document.getElementById('autosaveRestoreNote');
  if(note) note.style.display = 'none';
  updateAutosaveStatus();
}
document.getElementById('clearFixedPinsBtn').addEventListener('click', clearAllFixedPins);
document.getElementById('clearFixedPinsBtnLessons').addEventListener('click', clearAllFixedPins);
document.getElementById('clearFixedPinsBtnBands').addEventListener('click', clearAllFixedPins);
document.getElementById('discardAutosaveBtn').addEventListener('click', discardAutosaveAndReloadSeed);

// ---------- Init ----------
renderStudents();
renderLessons();
renderAvail();
renderCAvail();
renderRefTables();
renderBreaksTable();
renderAcceptedStatus();
renderAcceptedSchedule();
updateFixedPinsBanner();
restoreAutosaveIfAny();
updateAutosaveStatus();
renderOneOneTab();
renderRjPianoTab();

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
