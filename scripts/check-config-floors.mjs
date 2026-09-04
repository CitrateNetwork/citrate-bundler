#!/usr/bin/env node
// CI tripwire (BUN-B-001): diff the generated bundler.config.json against the
// ERC-7562 constant table and fail on any value below floor.
//
// Usage:
//   node scripts/check-config-floors.mjs [path/to/bundler.config.json]
//
// With no argument it generates the config by running the real entrypoint in
// dry-run mode into a temp dir, so it validates what the image would actually
// ship — not a hand-maintained copy.

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkConfigFloors, ERC7562_FLOORS } from './erc7562-floors.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function generateConfigViaEntrypoint() {
  const dir = mkdtempSync(join(tmpdir(), 'bundler-cfg-'));
  execFileSync('sh', [join(here, 'citrate-bundler-entrypoint.sh')], {
    env: {
      ...process.env,
      MNEMONIC: 'test test test test test test test test test test test junk',
      NETWORK: 'https://rpc.citrate.ai',
      ENTRYPOINT: '0x0000000000000000000000000000000000000000',
      CFG_DIR: dir,
      // Keep the boot guard happy so config generation proceeds. This flag
      // combination is irrelevant to the floors being written.
      BUNDLER_UNSAFE: 'false',
      GATE_REQUIRE_API_KEY: 'false',
      CITRATE_ENTRYPOINT_DRY_RUN: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return join(dir, 'bundler.config.json');
}

const path = process.argv[2] ?? generateConfigViaEntrypoint();

let config;
try {
  config = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`check-config-floors: cannot read/parse ${path}: ${err.message}`);
  process.exit(2);
}

const violations = checkConfigFloors(config);
if (violations.length > 0) {
  console.error(`check-config-floors: ${path} violates ERC-7562 reputation floors (BUN-B-001):`);
  for (const v of violations) {
    console.error(`  - ${v.field}=${v.got} is below floor ${v.floor}`);
  }
  process.exit(1);
}

console.log(
  `check-config-floors: OK — minStake >= ${ERC7562_FLOORS.minStake} wei, ` +
    `minUnstakeDelay >= ${ERC7562_FLOORS.minUnstakeDelay} s (${path})`,
);
