import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function dummyEl(){
  const el = {
    id: '',
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    style: {},
    classList: { add(){}, remove(){}, toggle(){ return false; }, contains(){ return false; } },
    dataset: {},
    options: [],
    files: [],
    parentNode: null,
    nextElementSibling: null,
    addEventListener(){},
    removeEventListener(){},
    appendChild(){ return el; },
    removeChild(){ return el; },
    click(){},
    focus(){},
    querySelector(){ return dummyEl(); },
    querySelectorAll(){ return []; },
  };
  return el;
}

export function loadApp(){
  const seedPath = path.join(ROOT, 'public/seed-data.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');

  const document = {
    getElementById(id){
      if(id === 'seed-data') return { textContent: JSON.stringify(seed) };
      return dummyEl();
    },
    querySelector(){ return dummyEl(); },
    querySelectorAll(){ return []; },
    createElement(){ return dummyEl(); },
    body: dummyEl(),
  };

  const sandbox = {
    console,
    document,
    window: { innerWidth: 1280, innerHeight: 800, document },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    alert(){},
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('fetch disabled in harness'); },
    URL: { createObjectURL(){ return ''; }, revokeObjectURL(){} },
    Blob: class {},
    FileReader: class { readAsText(){} },
    JSON, Math, Date, parseInt, parseFloat, isNaN, Infinity, NaN,
    Array, Object, Map, Set, String, Number, Boolean, Error, TypeError, RegExp, Promise,
    structuredClone: (x) => JSON.parse(JSON.stringify(x)),
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__BJP__ = {\n  get DB(){ return DB; },\n  set DB(v){ DB = v; },\n  get LAST_BANDS(){ return LAST_BANDS; },\n  set LAST_BANDS(v){ LAST_BANDS = v; },\n  runScheduler,\n  generateBands,\n  SearchLog,\n  DAYS,\n  DEFAULT_START,\n  DEFAULT_END,\n  inferHeaders,\n  sheetsTablesToDb,\n  rowGet,\n  sheetLooksLike,\n  dbToDriveTables,\n  driveTablesToAoa,\n  DRIVE_EXPORT_SPECS,\n  buildTimetableIcs,\n  calendarEventTitle\n};`, sandbox, { filename: 'src/app.js' });

  if(!sandbox.__BJP__ || typeof sandbox.__BJP__.runScheduler !== 'function'){
    throw new Error('Failed to load scheduler from src/app.js');
  }
  return { api: sandbox.__BJP__, seed, root: ROOT };
}
