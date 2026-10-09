#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sandbox, root, vault, stat, safe, readFile, createOnly, directory, freePort, json } from './test-sandbox.mjs';
import { verifyInstalled, replaceOwned } from './test-install.mjs';
import { connect } from './test-cdp.mjs';
import { startFixtures } from './test-fixtures.mjs';
import { diagnosticAction } from './test-diagnostic-actions.mjs';
import { diagnosticInstrument } from './test-diagnostic-instrument.mjs';
const [authorization, main, manifest, ...extra] = process.argv.slice(2);
if (authorization !== '--authorized-diagnostic' || extra.length) throw Error('Explicit diagnostic authorization required');
const hashes = { 'main.js': main, 'manifest.json': manifest };
await verifyInstalled(hashes);
const session = JSON.parse(await readFile(join(sandbox, 'native-session.json'))); assert.deepEqual(session.hashes, hashes);
const cdp = await connect(), token = randomUUID();
await directory(join(sandbox, 'evidence')); const evidence = await mkdtemp(join(sandbox, 'evidence', 'diagnostic-'));
const result = { status: 'running', scope: 'DIAGNOSTIC ONLY; not acceptance', hashes, runtime: cdp.runtime, evidence, stages: [], started: new Date().toISOString() };
const originals = new Map();
for (const relative of ['workspace.json', 'community-plugins.json', 'plugins/quiet-car/data.json']) {
  const path = join(vault, '.obsidian', relative), bytes = await stat(path) ? await readFile(path) : null;
  originals.set(relative, bytes); if (bytes) await createOnly(join(evidence, 'metadata-before', relative), bytes);
}
const act = (op, id, url) => cdp.evaluate(diagnosticAction, { op, id, url, token });
const snap = id => act('snapshot', id);
const capture = async name => createOnly(join(evidence, name + '.png'), Buffer.from(await cdp.screenshot(), 'base64'));
const body = (s, letter) => s.mode === 'reader' && s.elements.reader.textSample?.includes(`Section 1 of synthetic article ${letter}.`);
async function observe(name, id, predicate, ms = 2500) {
  const end = Date.now() + ms; let state;
  do { state = await snap(id); if (predicate(state)) break; await delay(150); } while (Date.now() < end);
  const observation = { name, matched: !!predicate(state), state }; result.stages.push(observation); return observation;
}
let fixture, initialized = false, cleaned = false;
try {
  await cdp.collectErrors(); fixture = await startFixtures(); const A = fixture.urls['article-a'], B = fixture.urls['article-b'];
  await act('init', null, fixture.origin); initialized = true;
  // First phase is genuinely unmodified native: no factory/getter/renderer/fetch instrumentation.
  await act('create', 'control', A); await observe('control Original A ready', 'control', s => s.url === A && s.nativeUrl === A);
  await act('toggle', 'control'); const first = await observe('unmodified native foreground Reader A', 'control', s => body(s, 'A'), 12000);
  assert.equal(first.matched, true); assert.equal(first.state.nativeUnmodifiedControl, true);
  await act('toggle', 'control'); await act('navigate', 'control', B);
  await observe('control foreground Original B ready', 'control', s => s.url === B && s.nativeUrl === B);
  await act('toggle', 'control'); await observe('unmodified native foreground Original->Reader B', 'control', s => body(s, 'B'), 12000);
  await capture('control-foreground-Reader-B');
  await act('toggle', 'control'); await act('toggle', 'control');
  await observe('unmodified native repeated Original->Reader B', 'control', s => body(s, 'B'), 12000);
  await act('create', 'cover', A);
  await act('select', 'control'); await act('toggle', 'control'); await act('navigate', 'control', A);
  await observe('control Original A reset', 'control', s => s.url === A && s.nativeUrl === A);
  await act('select', 'cover'); await act('navigate', 'control', B);
  await observe('control background Original B ready', 'control', s => s.url === B && s.nativeUrl === B);
  result.inactiveNativeCall = await act('native-reader-inactive', 'control'); await delay(1000);
  await observe('unmodified native diagnostic Reader entry while inactive', 'control', () => true);
  await act('select', 'control');
  await observe('unmodified native inactive-render then tab activation', 'control', s => body(s, 'B'), 12000);
  await capture('control-after-background-activation');
  result.controlGuest = await act('guest-B', 'control', B); result.controlExtraction = await act('getter-B', 'control', B);
  result.controlResizeAction = await act('renderer-resize', 'control');
  await observe('unmodified native diagnostic renderer.onResize after activation', 'control', s => body(s, 'B'), 4000);
  await capture('control-after-native-renderer-resize');
  // Natural native sticky Reader refresh, no candidate and no automatic entry hook.
  await act('navigate', 'control', A); await observe('control sticky foreground Reader A', 'control', s => body(s, 'A') && s.url === A, 12000);
  await act('select', 'cover'); await act('navigate', 'control', B); await delay(1200);
  await observe('control sticky Reader background B', 'control', () => true);
  await act('select', 'control'); await observe('control sticky Reader B after activation', 'control', s => body(s, 'B'), 12000);
  await capture('control-sticky-background-activation');
  await act('close', 'control'); await act('close', 'cover');
  // Second phase: same real methods, transparent logging before managed factory construction.
  result.instrumentation = await cdp.evaluate(diagnosticInstrument, { token }); result.candidate = await act('load');
  await act('create', 'managed', A); await observe('managed foreground Reader A', 'managed', s => body(s, 'A'), 12000);
  await act('toggle', 'managed'); await act('create', 'managed-cover', B);
  await observe('managed cover foreground Reader B', 'managed-cover', s => body(s, 'B'), 12000);
  await act('select', 'managed'); await act('navigate', 'managed', A + '#ending');
  await observe('managed manual Original anchor preserved', 'managed', s => s.mode === 'webview' && s.url === A + '#ending');
  await act('select', 'managed-cover'); await act('navigate', 'managed', B);
  await observe('managed auto Reader B entry without activation', 'managed', s => s.mode === 'reader' && s.url === B && s.nativeUrl === B);
  await delay(1000); await observe('managed inactive Reader B DOM/renderer', 'managed', () => true);
  await act('select', 'managed');
  await observe('managed Reader B after native tab activation', 'managed', s => body(s, 'B'), 12000);
  await capture('managed-background-activation');
  result.managedGuest = await act('guest-B', 'managed', B); result.managedExtraction = await act('getter-B', 'managed', B);
  result.traceBeforeResize = await act('trace');
  result.managedResizeAction = await act('renderer-resize', 'managed');
  await observe('managed diagnostic native renderer.onResize', 'managed', s => body(s, 'B'), 4000);
  await capture('managed-after-native-renderer-resize');
  result.trace = await act('trace'); result.status = 'diagnostic-completed-not-acceptance';
} catch (error) { result.status = 'diagnostic-error'; result.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try { await capture('final'); } catch (e) { result.screenshotError = String(e); }
  try { if (initialized) { result.trace = await act('trace'); result.cleanup = await act('cleanup'); assert.equal(result.cleanup.factoryRestored, true); } cleaned = true; }
  catch (error) { result.cleanupError = String(error); process.exitCode = 1; }
  result.protocolEvents = cdp.events; cdp.close();
  if (fixture) { result.http = fixture.requests; await fixture.stop(); }
  if (cleaned) {
    try {
      await verifyInstalled(hashes);
      const stopped = await promisify(execFile)(process.execPath, [join(root, 'scripts/test-stop.mjs'), '--authorized-stop'], { timeout: 15000 });
      result.shutdown = JSON.parse(stopped.stdout);
      for (const [relative, bytes] of originals) {
        const path = join(vault, '.obsidian', relative);
        if (bytes) await replaceOwned(path, bytes); else if (await stat(path)) { await safe(path); await unlink(path); }
      }
      result.metadataRestored = [...originals.keys()]; result.cdpPortFree = await freePort(19226);
    } catch (error) { result.teardownError = String(error); process.exitCode = 1; }
  }
  result.finished = new Date().toISOString(); await createOnly(join(evidence, 'runtime.json'), json(result));
  console.log(json({ status: result.status, evidence, error: result.error, cleanupError: result.cleanupError, teardownError: result.teardownError,
    stages: result.stages.map(s => ({ name: s.name, matched: s.matched, mode: s.state.mode, readerTextLength: s.state.elements.reader.textLength })), shutdown: result.shutdown, cdpPortFree: result.cdpPortFree }));
}
