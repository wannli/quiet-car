import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, unlink, readFile as rawRead } from 'node:fs/promises';
import { join } from 'node:path';
import { root, sandbox, vault, directory, stat, readFile, createOnly, safe, freePort, json } from './test-sandbox.mjs';
import { install, verifyInstalled, assertProfileStopped, replaceOwned, sha } from './test-install.mjs';
const [authorization, main, manifest, ...extra] = process.argv.slice(2);
if (authorization !== '--authorized-layout-validation' || extra.length) throw Error('Explicit new-build authorization required');
assert.equal(main, 'ddbf9d1f46b0a7226a03d2ae6dc7875256ecb2fb721d75e4e0a6e15f2fe4f4c6');
assert.equal(manifest, '1642b0b9a4d899bf625178ad60798869b1f88d784997c51b7f35af2a3e981872');
const hashes = { 'main.js': main, 'manifest.json': manifest };
assertProfileStopped(); await freePort(19226);
await directory(join(sandbox, 'evidence'));
const evidence = await mkdtemp(join(sandbox, 'evidence', 'layout-validation-'));
const result = { status: 'running', evidence, hashes, phases: {}, sourceFingerprintReportedByOwner: 'a77813897888bd4aad5b42442b6d83449f76d5303379419d0444252e9aa73df2' };
result.correctionProvenance = { prior: 'native-Zp2dzP: 18 PASS then foreground SETUP_FAILURE; unload not reached',
  change: 'Group19 explicitly clicks native one/A tab and verifies active identity/positive geometry before foreground Reader assertion',
  audit: 'Other foreground transitions originate from explicit create(active), declared tab selection, or the same still-selected view; lifecycle/targeted foreground predicates audited. No selection hidden in assertions.',
  forbiddenWorkarounds: 'No renderer.onResize/queueRender/view.onResize, forced window focus/resize, or extra Reader toggle' };
async function productionIdentity() {
  const out = {};
  async function walk(relative) {
    for (const e of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, e.name); if (e.isSymbolicLink()) throw Error('Symlink in frozen source');
      if (e.isDirectory()) await walk(name); else if (e.isFile()) out[name] = sha(await rawRead(join(root, name)));
    }
  }
  await walk('src');
  for (const name of ['main.js', 'manifest.json']) out[name] = sha(await rawRead(join(root, name)));
  return out;
}
result.productionBefore = await productionIdentity();
assert.equal((await rawRead(join(root, 'main.js'))).length, 36617);
const originals = new Map();
for (const name of ['workspace.json', 'community-plugins.json', 'plugins/auto-web-reader/data.json']) {
  const path = join(vault, '.obsidian', name), bytes = await stat(path) ? await readFile(path) : null;
  originals.set(name, bytes); if (bytes) await createOnly(join(evidence, 'metadata-before', name), bytes);
}
async function notes(path = vault, out = {}) {
  await safe(path, 'directory');
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.name === '.obsidian') continue;
    const f = join(path, e.name); if (e.isSymbolicLink()) throw Error('Unsafe vault link');
    if (e.isDirectory()) await notes(f, out); else if (e.name.endsWith('.md')) out[f] = sha(await readFile(f));
  }
  return out;
}
const beforeNotes = await notes();
async function run(name, file, args, timeout = 240000) {
  try {
    const r = await promisify(execFile)(process.execPath, [join(root, 'scripts', file), ...args], { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 });
    await createOnly(join(evidence, name + '.stdout.json'), r.stdout);
    await createOnly(join(evidence, name + '.stderr.log'), r.stderr);
    result.phases[name] = JSON.parse(r.stdout); return result.phases[name];
  } catch (e) {
    await createOnly(join(evidence, name + '.failure.stdout'), e.stdout ?? '');
    await createOnly(join(evidence, name + '.failure.stderr'), e.stderr ?? '');
    try { result.phases[name] = JSON.parse(e.stdout); } catch {}
    throw e;
  }
}
try {
  result.install = await install(hashes);
  result.launch = await run('launch', 'test-launch.mjs', ['--authorized-launch'], 45000);
  await run('baseline', 'native-smoke.mjs', ['--authorized-run', main, manifest]);
  await run('targeted', 'test-target-run.mjs', ['--authorized-targeted', main, manifest]);
  await run('restart', 'test-restart.mjs', ['--authorized-restart-case', main, manifest]);
  result.status = 'covered-cases-passed-SPA-NOT-MET';
} catch (e) { result.status = 'failed'; result.error = String(e.stack ?? e); process.exitCode = 1; }
finally {
  try {
    try { assertProfileStopped(); }
    catch { result.shutdown = await run('stop', 'test-stop.mjs', ['--authorized-stop'], 20000); }
    assertProfileStopped();
    result.metadataRestored = [];
    for (const [name, bytes] of originals) {
      const path = join(vault, '.obsidian', name);
      if (bytes) await replaceOwned(path, bytes); else if (await stat(path)) { await safe(path); await unlink(path); }
      const now = await stat(path) ? await readFile(path) : null;
      assert.ok(bytes ? now?.equals(bytes) : now === null); result.metadataRestored.push(name);
    }
    assert.deepEqual(await notes(), beforeNotes); result.notesUnchanged = true;
    await verifyInstalled(hashes); await freePort(19226); result.cdp19226Free = true;
    result.productionAfter = await productionIdentity(); assert.deepEqual(result.productionAfter, result.productionBefore);
    result.sourceAndArtifactsUnchanged = true;
  } catch (e) { result.cleanupError = String(e.stack ?? e); result.status = 'failed'; process.exitCode = 1; }
  result.finished = new Date().toISOString();
  await createOnly(join(evidence, 'receipt.json'), json(result)); console.log(json(result));
}
