#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sandbox, directory, stat, readFile, createOnly, safe, json } from './test-sandbox.mjs';
import { verifyInstalled, pluginDir, replaceOwned } from './test-install.mjs';
import { connect } from './test-cdp.mjs';
import { startFixtures } from './test-fixtures.mjs';
import { harness } from './test-native-cases.mjs';
import { targetedAction } from './test-target-instrument.mjs';
import { targetedCases } from './test-target-cases.mjs';

const [authorization, main, manifest, ...extra] = process.argv.slice(2);
if (authorization !== '--authorized-targeted' || extra.length) throw Error('Use --authorized-targeted MAIN_SHA MANIFEST_SHA after approval');
const expected = { 'main.js': main, 'manifest.json': manifest };
await verifyInstalled(expected);
const session = JSON.parse(await readFile(join(sandbox, 'native-session.json')));
assert.deepEqual(session.hashes, expected);
const cdp = await connect();
await directory(join(sandbox, 'evidence'));
const evidence = await mkdtemp(join(sandbox, 'evidence', 'targeted-'));
const data = join(pluginDir, 'data.json'), before = await stat(data) ? await readFile(data) : null;
if (before) await createOnly(join(evidence, 'data.before.json'), before);
const result = { status: 'running', evidence, runtime: cdp.runtime, hashes: expected, steps: [], remainingGates: ['SPA automatic path/query new articles NOT MET'], started: new Date().toISOString() };
const token = randomUUID(), h = harness(cdp, token, result);
const target = (op, id) => cdp.evaluate(targetedAction, { op, id, token });
let fixture, initialized = false, instrumented = false;
try {
  await cdp.collectErrors(); fixture = await startFixtures();
  await h.act('init', null, { url: fixture.origin }); initialized = true;
  result.instrumentation = await target('install'); instrumented = true;
  await targetedCases(h, target, fixture, result);
  result.observed = await h.act('summary'); result.trace = await target('trace');
  assert.deepEqual(result.observed.errors, []);
  assert.equal(cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  result.status = 'targeted-covered-cases-passed';
} catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try { await h.capture('final'); } catch (e) { result.screenshotError = String(e); }
  try {
    if (instrumented) {
      result.trace = await target('trace');
      await h.act('unload'); await target('restore'); instrumented = false;
    }
    if (initialized) { result.cleanupErrors = await h.act('cleanup'); assert.deepEqual(result.cleanupErrors, []); }
    if (before) await replaceOwned(data, before);
    else if (await stat(data)) { await safe(data); await unlink(data); }
  } catch (e) { result.cleanupError = String(e); result.status = 'failed'; process.exitCode = 1; }
  if (fixture) { result.http = fixture.requests; await fixture.stop(); }
  result.protocolEvents = cdp.events; result.finished = new Date().toISOString();
  cdp.close(); await createOnly(join(evidence, 'runtime.json'), json(result));
  console.log(json({ status: result.status, evidence, hashes: expected, error: result.error, cleanupError: result.cleanupError, exactMinus3: result.exactMinus3,
    steps: result.steps.map(({ name, status }) => ({ name, status })), remainingGates: result.remainingGates }));
}
