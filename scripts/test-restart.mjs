#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, sandbox, vault, directory, stat, readFile, createOnly, safe, json } from './test-sandbox.mjs';
import { verifyInstalled, replaceOwned } from './test-install.mjs';
import { connect, assertProcess } from './test-cdp.mjs';
import { startFixtures } from './test-fixtures.mjs';
const [authorization, main, manifest, ...extra] = process.argv.slice(2);
if (authorization !== '--authorized-restart-case' || extra.length) throw Error('Explicit bounded restart-case authorization required');
const expected = { 'main.js': main, 'manifest.json': manifest };
await verifyInstalled(expected);
await directory(join(sandbox, 'evidence'));
const evidence = await mkdtemp(join(sandbox, 'evidence', 'restart-'));
const result = { status: 'running', evidence, hashes: expected, started: new Date().toISOString() };
const paths = ['workspace.json', 'community-plugins.json', 'plugins/auto-web-reader/data.json'];
const originals = new Map();
let cdp = await connect(), fixture, stopped = false, setupStarted = false;
async function until(label, read, predicate, ms = 12000) {
  let value; const end = Date.now() + ms;
  while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await delay(150); }
  throw Error(label + ': ' + JSON.stringify(value));
}
const snapshot = () => cdp.evaluate(() => {
  const p = app.plugins.plugins['auto-web-reader'];
  return { layoutReady: app.workspace.layoutReady, importedApiVersion: p?.coreVersion,
    notes: app.vault.getMarkdownFiles().map(f => f.path).sort(),
    views: app.workspace.getLeavesOfType('webviewer').map(l => {
      const v = l.view, shown = el => !!el && el.ownerDocument.defaultView.getComputedStyle(el).display !== 'none';
      let url; try { url = v.webview?.getURL(); } catch { url = null; }
      return { id: l.id, url, mode: v.mode, managed: !!p?.bridge?.getSession(v),
        readerShown: shown(v.readerView), originalShown: shown(v.webview), text: v.readerView?.textContent.slice(0, 500) };
    }) };
});
async function stopOwned(allowedOrigin) {
  await cdp.evaluate(origin => {
    if (window.__autoWebReaderNativeSmoke || window.__awrTargetedNative) throw Error('Instrumentation still present');
    if (app.workspace.getLeavesOfType('webviewer').some(l => !l.view.webview.getURL().startsWith(origin + '/'))) throw Error('Unowned restored leaf');
    return true;
  }, allowedOrigin);
  const record = JSON.parse(await readFile(join(sandbox, 'native-session.json')));
  await verifyInstalled(expected); await assertProcess();
  cdp.close(); cdp = null; process.kill(record.pid, 'SIGTERM');
  await until('owned process exit', async () => {
    try { return execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() !== record.started; }
    catch { return true; }
  }, Boolean, 6000);
  stopped = true; return { pid: record.pid, started: record.started, stopped: true };
}
try {
  const initial = await snapshot(); result.initial = initial;
  assert.equal(initial.views.length, 0, 'Restart case begins with no unknown native views');
  assert.equal(initial.importedApiVersion, undefined, 'Candidate initially unloaded');
  for (const relative of paths) {
    const path = join(vault, '.obsidian', relative), bytes = await stat(path) ? await readFile(path) : null;
    originals.set(relative, bytes);
    if (bytes) await createOnly(join(evidence, 'metadata-before', relative), bytes);
  }
  fixture = await startFixtures(); result.fixtureOrigin = fixture.origin;
  setupStarted = true;
  const id = await cdp.evaluate(async url => {
    await app.plugins.loadManifests();
    if (!await app.plugins.enablePluginAndSave('auto-web-reader')) throw Error('Candidate enable failed');
    const p = app.plugins.plugins['auto-web-reader'];
    if (p.coreVersion !== '1.14.4') throw Error('Imported apiVersion mismatch');
    await p.preferences.setEnabled(true);
    const l = app.workspace.getLeaf('tab');
    await l.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } }); return l.id;
  }, fixture.urls['article-a']);
  const visibleReader = s => s.views.length === 1 && s.views[0].url === fixture.urls['article-a'] && s.views[0].managed && s.views[0].mode === 'reader' &&
    s.views[0].readerShown && !s.views[0].originalShown && s.views[0].text.includes('Section 1 of synthetic article A.');
  result.beforeRestart = await until('native Reader before restart', snapshot, visibleReader);
  assert.equal(result.beforeRestart.views[0].id, id, 'Saved runtime leaf identity changed');
  result.savedLeafId = id;
  await createOnly(join(evidence, 'before-restart-native-Reader.png'), Buffer.from(await cdp.screenshot(), 'base64'));
  await cdp.evaluate(() => {
    app.workspace.requestSaveLayout(); app.workspace.requestSaveLayout.run(); app.plugins.requestSaveConfig.run(); return true;
  });
  const persisted = await until('owned workspace and plugin list persisted', async () => {
    try { return { workspace: String(await readFile(join(vault, '.obsidian/workspace.json'))),
      plugins: JSON.parse(await readFile(join(vault, '.obsidian/community-plugins.json'))) }; } catch { return null; }
  }, v => v && v.workspace.includes(id) && v.workspace.includes(fixture.urls['article-a']) && v.plugins.includes('auto-web-reader'));
  const persistedLeaves = [];
  function inspectSaved(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'leaf' && value.state?.type === 'webviewer') persistedLeaves.push(value);
    for (const child of Object.values(value)) inspectSaved(child);
  }
  inspectSaved(JSON.parse(persisted.workspace));
  assert.equal(persistedLeaves.length, 1, 'Expected exactly the owned fixture leaf in saved workspace');
  assert.equal(persistedLeaves[0].id, id); assert.equal(persistedLeaves[0].state.state.url, fixture.urls['article-a']);
  result.firstShutdown = await stopOwned(fixture.origin);
  stopped = false; // A failed launch may still have created our recorded process; never restore metadata assuming it stayed stopped.
  const launched = await promisify(execFile)(process.execPath, [join(root, 'scripts/test-launch.mjs'), '--authorized-launch'], { timeout: 45000 });
  stopped = false; result.launch = JSON.parse(launched.stdout);
  cdp = await connect(); await cdp.collectErrors(); await verifyInstalled(expected);
  const restored = await until('restored native workspace and imported API', snapshot, s => s.layoutReady && s.importedApiVersion === '1.14.4' &&
    s.views.length === 1 && s.views[0].url === fixture.urls['article-a']);
  result.restored = restored;
  assert.equal(restored.views[0].id, result.savedLeafId, 'Restored leaf ID must equal the actual saved workspace leaf ID');
  if (restored.views[0].managed) {
    result.restoredReader = await until('managed restored Reader content', snapshot, visibleReader);
    result.restoration = 'PASS: restored view factory-managed and actual Reader visible without tester reopen';
  } else {
    result.restoration = 'LIMITED: restored view was constructed before guard and remains unmanaged; approved manual-reopen requirement applies';
    await cdp.evaluate(async ({ id, url }) => {
      const old = app.workspace.getLeavesOfType('webviewer').find(l => l.id === id);
      if (!old || old.view.webview.getURL() !== url) throw Error('Restored leaf identity mismatch');
      old.detach(); const fresh = app.workspace.getLeaf('tab');
      await fresh.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } });
    }, { id: restored.views[0].id, url: fixture.urls['article-a'] });
    result.manuallyReopened = await until('explicit reopened restored Reader', snapshot, visibleReader);
  }
  await createOnly(join(evidence, 'after-restart-native-Reader.png'), Buffer.from(await cdp.screenshot(), 'base64'));
  assert.deepEqual((await snapshot()).notes, initial.notes);
  result.protocolEvents = cdp.events;
  assert.equal(cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0);
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  try {
    if (!cdp && !stopped) cdp = await connect();
    if (cdp && setupStarted) {
      await cdp.evaluate(async origin => {
        const leaves = app.workspace.getLeavesOfType('webviewer');
        if (leaves.some(l => !l.view.webview.getURL().startsWith(origin + '/'))) throw Error('Unknown native view during cleanup');
        await app.plugins.unloadPlugin('auto-web-reader');
        for (const l of leaves) l.detach(); return true;
      }, fixture.origin);
      result.finalShutdown = await stopOwned(fixture.origin);
    }
    if (setupStarted && stopped) {
      for (const [relative, bytes] of originals) {
        const path = join(vault, '.obsidian', relative);
        if (bytes) await replaceOwned(path, bytes); else if (await stat(path)) { await safe(path); await unlink(path); }
      }
      result.metadataRestored = paths;
    }
  } catch (error) { result.cleanupError = String(error); result.status = 'failed'; process.exitCode = 1; }
  if (cdp) cdp.close();
  if (fixture) { result.requests = fixture.requests; await fixture.stop(); }
  result.finished = new Date().toISOString(); await createOnly(join(evidence, 'runtime.json'), json(result));
  console.log(json({ status: result.status, evidence, restoration: result.restoration, hashes: expected, error: result.error, cleanupError: result.cleanupError, metadataRestored: result.metadataRestored, finalShutdown: result.finalShutdown }));
}
