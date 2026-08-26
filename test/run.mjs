#!/usr/bin/env node
// Deterministic whole-app suite. Does not hit Google Drive and does not run
// the multi-minute endurance fuzzer.
//
//   npm test
//   node test/run.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['test/logic.mjs'],
  ['test/accept.mjs'],
  ['test/drag.mjs'],
  ['test/oneone.mjs'],
  ['test/rpiano.mjs'],
  ['test/donow.mjs'],
  ['test/coverage.mjs', '--quick'],
  ['test/e2e-drive.mjs', '--seed-only', '--quick']
];

function main(){
  let failed = 0;
  const t0 = Date.now();
  for(const args of SUITES){
    const label = args.join(' ');
    console.log('\n' + '═'.repeat(64));
    console.log('▶ ' + label);
    console.log('═'.repeat(64));
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env
    });
    if(r.status !== 0){
      failed++;
      console.error(`\nSuite failed: ${label} (exit ${r.status})`);
    }
  }
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '═'.repeat(64));
  if(failed){
    console.error(`${failed} suite(s) failed in ${sec}s`);
    process.exit(1);
  }
  console.log(`All ${SUITES.length} suites passed in ${sec}s`);
}

main();
