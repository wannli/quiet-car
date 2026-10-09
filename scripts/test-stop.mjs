#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, assertProcess } from './test-cdp.mjs';
import { sandbox, readFile, createOnly, json } from './test-sandbox.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--authorized-stop') throw Error('Requires explicit owned-session shutdown authorization');
const cdp = await connect();
const state = await cdp.evaluate(() => ({ candidateLoaded: !!app.plugins.plugins['auto-web-reader'], harnessPresent: !!window.__autoWebReaderNativeSmoke, nativeLeaves: app.workspace.getLeavesOfType('webviewer').length }));
cdp.close();
if (state.candidateLoaded || state.harnessPresent || state.nativeLeaves) throw Error('Test cleanup incomplete; refusing shutdown before evidence/cleanup inspection');
const record = JSON.parse(await readFile(join(sandbox, 'native-session.json')));
await assertProcess(); // Recheck PID start-time/profile/executable/loopback immediately before signal.
process.kill(record.pid, 'SIGTERM');
let stopped = false;
for (let i = 0; i < 50; i++) {
  await delay(100);
  try {
    const start = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    if (!start || start !== record.started) { stopped = true; break; }
  } catch { stopped = true; break; }
}
const result = { at: new Date().toISOString(), pid: record.pid, recordedStart: record.started, runtime: cdp.runtime, cleanupState: state, signal: 'SIGTERM', stopped, scope: 'Only owned verified PID signaled; no other processes targeted' };
await createOnly(join(sandbox, 'evidence', 'native-stop-' + Date.now() + '.json'), json(result));
console.log(json(result));
if (!stopped) process.exitCode = 1; // No escalation or broad process killing.
