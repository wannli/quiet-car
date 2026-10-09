import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sandbox, vault, directory, readFile, stat, createOnly, safe, json } from './test-sandbox.mjs';
import { pluginDir, verifyInstalled, replaceOwned, sha } from './test-install.mjs';
import { connect } from './test-cdp.mjs';
import { startFixtures } from './test-fixtures.mjs';
import { harness, basicCases } from './test-native-cases.mjs';
import { raceCases } from './test-native-races.mjs';
import { lifecycleCases } from './test-native-lifecycle.mjs';
import { layoutGate } from './test-layout-gate.mjs';

async function notes(path = vault, result = {}) {
  await safe(path, 'directory');
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.name === '.obsidian') continue;
    if (entry.isDirectory()) await notes(full, result);
    else if (entry.isSymbolicLink()) throw Error('Unsafe vault link');
    else if (entry.name.endsWith('.md')) result[full] = sha(await readFile(full));
  }
  return result;
}
export async function runNative(expected) {
  for (const hash of Object.values(expected)) if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw Error('Expected reviewed build SHA256 values required');
  await verifyInstalled(expected);
  const session = JSON.parse(await readFile(join(sandbox, 'native-session.json')));
  assert.deepEqual(session.hashes, expected, 'Launched artifact identity mismatch');
  const cdp = await connect();
  let fixture, h, initialized = false, evidence, before, preference;
  const data = join(pluginDir, 'data.json');
  const result = { status: 'running', hashes: expected, runtime: cdp.runtime, started: new Date().toISOString(), steps: [],
    remainingGates: [
      'AC2 automatic SPA path/query article handling NOT MET; safe Original+suspend behavior is only a limited fallback.',
      'Precise result-prepared/pre-generator-continuation microtask injection is UNCOVERED. Host fetch delays test actual pending native extraction, not that exact scheduling gap.',
      'Stale unsupported failure delivered after a newer successful Reader render is UNCOVERED; included newer-page test uses two truly empty documents.',
      'Restored-state test creates a fresh native view from state, not a whole-app restart/layout restoration.',
    ], evidenceScope: 'Native macOS core 1.14.4 using synthetic local fixtures; injected fetch/save/HTTP delays explicitly labeled. Physical iOS NOT RUN.' };
  try {
    await directory(join(sandbox, 'evidence')); evidence = await mkdtemp(join(sandbox, 'evidence', 'native-')); result.evidence = evidence;
    before = await notes(); preference = await stat(data) ? await readFile(data) : null;
    if (preference) await createOnly(join(evidence, 'data.before.json'), preference);
    await cdp.collectErrors();
    fixture = await startFixtures(); h = harness(cdp, randomUUID(), result);
    await h.act('init', null, { url: fixture.origin }); initialized = true;
    result.layoutGate = await layoutGate(h, fixture);
    await basicCases(h, fixture); await raceCases(h, fixture); await lifecycleCases(h, fixture);
    result.observed = await h.act('summary');
    assert.deepEqual(result.observed.errors, []);
    assert.equal(result.observed.held, 0); assert.equal(result.observed.savesHeld, 0);
    assert.equal(cdp.eventsTruncated, false, 'CDP evidence truncated');
    assert.equal(fixture.truncated, false, 'Fixture request evidence truncated');
    assert.equal(cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0, 'Unhandled native exception');
    result.status = 'covered-cases-passed-with-uncovered-gates';
  } catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error); process.exitCode = 1; }
  finally {
    if (evidence) {
      try { await createOnly(join(evidence, 'final.png'), Buffer.from(await cdp.screenshot(), 'base64')); }
      catch (e) { result.screenshotError = String(e); }
    }
    if (initialized) {
      try {
        result.cleanupErrors = await h.act('cleanup');
        const unloaded = await cdp.evaluate(() => !app.plugins.plugins['auto-web-reader']);
        assert.equal(unloaded, true, 'Candidate must be unloaded before preference restoration');
        // Restore ONLY this plugin preference touched by the UI tests; no other settings/notes.
        if (preference) await replaceOwned(data, preference);
        else if (await stat(data)) { await safe(data); await unlink(data); }
        assert.deepEqual(result.cleanupErrors, []);
      } catch (e) { result.status = 'failed'; result.cleanupFailure = String(e); process.exitCode = 1; }
    }
    if (fixture) { result.http = fixture.requests; await fixture.stop(); }
    try { if (before) assert.deepEqual(await notes(), before, 'Vault Markdown changed: save-to-vault is forbidden'); }
    catch (e) { result.status = 'failed'; result.noteFailure = String(e); process.exitCode = 1; }
    result.protocolEvents = cdp.events; result.finished = new Date().toISOString();
    cdp.close();
    if (evidence) await createOnly(join(evidence, 'runtime.json'), json(result));
    console.log(json({ status: result.status, evidence, hashes: expected, error: result.error, remainingGates: result.remainingGates, steps: result.steps.map(({ name, status }) => ({ name, status })) }));
  }
  return result;
}
