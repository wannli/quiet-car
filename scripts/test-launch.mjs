#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPlan, freePort, sandbox, readFile, createOnly, safe, json } from './test-sandbox.mjs';
import { assertProfileStopped, replaceOwned, verifyInstalled } from './test-install.mjs';
import { connect } from './test-cdp.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--authorized-launch') throw Error('Requires explicit final runtime authorization: --authorized-launch');
const plan = await readPlan();
const profileConfig = JSON.parse(await readFile(join(plan.profile, 'obsidian.json')));
if (profileConfig.updateDisabled !== true) throw Error('Refusing launch with updater enabled. Explicitly approve/run test-profile.mjs --authorized-disable-updates first.');
const receipt = JSON.parse(await readFile(join(sandbox, 'installed-build.json')));
await verifyInstalled(receipt.hashes);
assertProfileStopped();
const log = join(sandbox, 'native-launch-' + Date.now() + '.log');
await createOnly(log, ''); await safe(log);
const output = await open(log, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
let child;
try {
  await freePort(plan.port); // Last operation before spawning; never attach to an occupied port.
  child = spawn(plan.executable, [`--user-data-dir=${plan.profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${plan.port}`],
    { detached: true, stdio: ['ignore', output.fd, output.fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
} finally { await output.close(); }
const started = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const session = { pid: child.pid, started, executable: plan.executable, profile: plan.profile, vault: plan.vault, port: plan.port, log, hashes: receipt.hashes };
await replaceOwned(join(sandbox, 'native-session.json'), json(session));
child.unref();
let last;
for (let i = 0; i < 60; i++) {
  try {
    const cdp = await connect();
    console.log(json({ ...session, runtime: cdp.runtime })); cdp.close(); last = null; break;
  } catch (error) { last = error; await delay(500); }
}
if (last) throw Error('Owned launch could not verify identity; no process killed/restarted. ' + last.message);
