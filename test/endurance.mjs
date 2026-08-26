#!/usr/bin/env node
// Brutal endurance fuzzer for runScheduler.
//
// Keeps the real school roster (students / groups / classes) and randomizes
// the constraint surfaces: pinned slots, locked small group teachers, Break Management,
// class reservations (add + drop), small group quotas, teacher availability, durations,
// room locks, and small group rosters. Each scenario is checked by an independent
// invariant suite — overlaps, reservations, teacher windows, exact break units,
// quotas, pinned-slot fidelity.
//
//   node test/endurance.mjs
//   node test/endurance.mjs --runs 2000 --seed 42
//   node test/endurance.mjs --quick
//   node test/endurance.mjs --replay test/last-failure.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './load-app.mjs';
import { makeRng } from './rng.mjs';
import { buildScenario, pickProfile } from './mutate.mjs';
import { checkSchedule, resultSignature, isSmallGroupId } from './invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAIL_PATH = path.join(ROOT, 'test/last-failure.json');

function parseArgs(argv){
  const args = { runs: 2000, seed: (Date.now() ^ (process.pid << 16)) >>> 0, failFast: true, replay: null, searchAll: false };
  for(let i=2;i<argv.length;i++){
    const a = argv[i];
    if(a === '--quick') args.runs = 200;
    else if(a === '--fail-fast') args.failFast = true;
    else if(a === '--keep-going') args.failFast = false;
    else if(a === '--search-all') args.searchAll = true;
    else if(a === '--runs') args.runs = Math.max(1, parseInt(argv[++i], 10) || 2000);
    else if(a === '--seed') args.seed = parseInt(argv[++i], 10) >>> 0;
    else if(a === '--replay') args.replay = argv[++i];
    else if(a === '--help' || a === '-h'){
      console.log(`Usage: node test/endurance.mjs [--runs N] [--seed N] [--quick] [--keep-going] [--replay file]`);
      process.exit(0);
    }
  }
  return args;
}

function summarizeResult(result){
  const smallGroups = (result.unresolved || []).filter(u => u.lesson && isSmallGroupId(u.lesson.id)).length;
  return `${(result.scheduled||[]).length} placed, ${(result.unresolved||[]).length} unresolved (${smallGroups} small groups)`;
}

function runOnce(api, randomize){
  const t0 = Date.now();
  const result = api.runScheduler(!!randomize);
  return { result, ms: Date.now() - t0 };
}

function dumpFailure(payload){
  fs.writeFileSync(FAIL_PATH, JSON.stringify(payload, null, 2));
}

function replayFile(api, file){
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  api.DB = data.db;
  api.LAST_SMALL_GROUPS = data.smallGroups;
  const randomize = !!data.randomize;
  console.log(`Replaying ${file}`);
  console.log(`seed=${data.seed} scenario=${data.scenarioIndex} profile=${data.profile} randomize=${randomize}`);
  console.log(data.ops.join('\n'));
  const { result, ms } = runOnce(api, randomize);
  const errors = checkSchedule(data.db, data.smallGroups, result);
  console.log(`Finished in ${ms}ms — ${summarizeResult(result)}`);
  if(errors.length){
    console.error(`\n${errors.length} invariant(s) still fail:`);
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }
  console.log('Replay passed.');
}

function main(){
  const args = parseArgs(process.argv);
  console.log('Loading scheduler…');
  const { api, seed } = loadApp();
  if(args.replay){
    replayFile(api, path.resolve(args.replay));
    return;
  }

  const rng = makeRng(args.seed);
  console.log(`Endurance: ${args.runs} scenarios · seed ${args.seed}`);
  console.log('Each scenario runs deterministic + shuffled. Failures dump to test/last-failure.json\n');

  let passed = 0;
  let failed = 0;
  let crashes = 0;
  let schedulerRuns = 0;
  let placed = 0;
  let unresolved = 0;
  let maxMs = 0;
  const familyHits = {};
  const tStart = Date.now();

  for(let i=0;i<args.runs;i++){
    const profile = pickProfile(rng, i);
    let scenario;
    try {
      scenario = buildScenario(api, seed, rng, profile);
    } catch(err){
      failed++; crashes++;
      console.error(`\nSCENARIO ${i} crashed while building (${profile}): ${err.stack || err}`);
      if(args.failFast) process.exit(1);
      continue;
    }
    scenario.families.forEach(f => { familyHits[f] = (familyHits[f] || 0) + 1; });

    const modes = args.searchAll ? [false] : [false, true];
    let scenarioFailed = false;
    let firstSig = null;
    for(const randomize of modes){
      let packed;
      try {
        packed = runOnce(api, randomize);
      } catch(err){
        crashes++;
        scenarioFailed = true;
        console.error(`\nSCENARIO ${i} ${profile} randomize=${randomize} THREW: ${err.stack || err}`);
        dumpFailure({
          seed: args.seed, scenarioIndex: i, profile, randomize,
          ops: scenario.ops, db: scenario.db, smallGroups: scenario.smallGroups,
          error: String(err && err.stack || err),
        });
        break;
      }
      schedulerRuns++;
      maxMs = Math.max(maxMs, packed.ms);
      placed += (packed.result.scheduled || []).length;
      unresolved += (packed.result.unresolved || []).length;
      const errors = checkSchedule(scenario.db, scenario.smallGroups, packed.result);
      if(!randomize) firstSig = resultSignature(packed.result);
      if(!randomize && i % 7 === 0){
        const again = runOnce(api, false);
        schedulerRuns++;
        if(resultSignature(again.result) !== firstSig){
          errors.push('deterministic runScheduler(false) is not stable on the same input');
        }
      }
      if(errors.length){
        scenarioFailed = true;
        console.error(`\nSCENARIO ${i} FAILED  profile=${profile}  randomize=${randomize}  ${summarizeResult(packed.result)}`);
        console.error(scenario.ops.join('\n'));
        errors.slice(0, 20).forEach(e => console.error('  - ' + e));
        if(errors.length > 20) console.error(`  … ${errors.length - 20} more`);
        dumpFailure({
          seed: args.seed, scenarioIndex: i, profile, randomize,
          ops: scenario.ops, db: scenario.db, smallGroups: scenario.smallGroups,
          errors, result: {
            scheduled: packed.result.scheduled,
            unresolved: (packed.result.unresolved || []).map(u => ({
              id: u.lesson && u.lesson.id,
              name: u.lesson && u.lesson.name,
              reason: u.customReason || '',
            })),
          },
        });
        break;
      }
    }
    if(scenarioFailed){
      failed++;
      if(args.failFast){
        console.error(`\nDumped to ${FAIL_PATH}`);
        console.error(`Replay: node test/endurance.mjs --replay test/last-failure.json`);
        process.exit(1);
      }
    } else {
      passed++;
    }
    if((i+1) % 25 === 0 || i === 0){
      const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
      process.stdout.write(`  ${i+1}/${args.runs}  ok=${passed} fail=${failed} crash=${crashes}  ${elapsed}s\n`);
    }
  }

  const secs = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log('\n———');
  console.log(`scenarios ${passed}/${args.runs} passed · ${failed} failed · ${crashes} crashed`);
  console.log(`scheduler runs ${schedulerRuns} · avg placed ${(placed/Math.max(1,schedulerRuns)).toFixed(1)} · avg unresolved ${(unresolved/Math.max(1,schedulerRuns)).toFixed(1)}`);
  console.log(`slowest attempt ${maxMs}ms · wall ${secs}s · seed ${args.seed}`);
  console.log('family coverage:', Object.entries(familyHits).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}:${v}`).join('  '));
  if(failed) process.exit(1);
  console.log('All invariant checks passed.');
}

main();
