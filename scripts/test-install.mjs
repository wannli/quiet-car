#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, realpath, rename, unlink, mkdtemp } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, sandbox, vault, profile, owned, safe, stat, readFile, createOnly, directory, json, isMain } from './test-sandbox.mjs';
export const pluginId = 'auto-web-reader';
export const pluginDir = join(vault, '.obsidian/plugins', pluginId);
export const sha = data => createHash('sha256').update(data).digest('hex');
export function assertProfileStopped() {
  const processes = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  if (processes.split('\n').some(s => s.includes(`--user-data-dir=${profile}`))) throw Error('Isolated profile already running; no artifact replacement/second launch allowed');
}
async function source(name) {
  const path = join(root, name);
  if (await realpath(root) !== root || await realpath(path) !== path) throw Error('Symlinked build');
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await h.stat(); if (!s.isFile() || s.nlink !== 1) throw Error('Unsafe build'); return await h.readFile(); }
  finally { await h.close(); }
}
export async function replaceOwned(path, bytes) {
  await safe(path);
  const staging = path + '.' + randomUUID() + '.tmp';
  await createOnly(staging, bytes);
  try { await safe(path); await rename(staging, path); }
  finally { if (await stat(staging)) await unlink(staging); }
}
export async function verifyInstalled(expected) {
  await owned();
  const hashes = {};
  for (const name of ['main.js', 'manifest.json']) {
    hashes[name] = sha(await readFile(join(pluginDir, name)));
    if (hashes[name] !== expected[name]) throw Error('Installed hash mismatch: ' + name);
  }
  return hashes;
}
export async function install(expected) {
  await owned(); assertProfileStopped();
  const files = {};
  for (const name of ['main.js', 'manifest.json']) {
    if (!/^[a-f0-9]{64}$/.test(expected[name] ?? '')) throw Error('Both expected SHA256 values required');
    files[name] = await source(name);
    if (sha(files[name]) !== expected[name]) throw Error('Build hash mismatch: ' + name);
    await safe(join(pluginDir, name));
  }
  if (JSON.parse(files['manifest.json']).id !== pluginId) throw Error('Unexpected manifest id');
  await directory(join(sandbox, 'backups'));
  const backup = await mkdtemp(join(sandbox, 'backups', 'plugin-'));
  const originals = {};
  for (const name of Object.keys(files)) {
    const path = join(pluginDir, name);
    originals[name] = await stat(path) ? await readFile(path) : null;
    if (originals[name]) await createOnly(join(backup, name), originals[name]);
  }
  const changed = [];
  try {
    for (const [name, bytes] of Object.entries(files)) {
      await owned(); assertProfileStopped();
      const path = join(pluginDir, name), original = originals[name];
      if (original ? !(await readFile(path)).equals(original) : await stat(path)) throw Error('Concurrent artifact change');
      await directory(pluginDir);
      if (original) await replaceOwned(path, bytes);
      else if (!await createOnly(path, bytes)) throw Error('Concurrent artifact creation');
      changed.push(name);
    }
    await verifyInstalled(expected);
    const receipt = { installedAt: new Date().toISOString(), hashes: expected, backup, vault, files: Object.keys(files), previous: Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, bytes ? sha(bytes) : null])) };
    await replaceOwned(join(sandbox, 'installed-build.json'), json(receipt));
    return receipt;
  } catch (error) {
    for (const name of changed.reverse()) {
      const path = join(pluginDir, name);
      if (!(await readFile(path)).equals(files[name])) throw Error('Rollback refused concurrent edit; backup: ' + backup, { cause: error });
      if (originals[name]) await replaceOwned(path, originals[name]); else await unlink(path);
    }
    throw error;
  }
}
if (isMain(import.meta.url)) {
  const [authorization, main, manifest, ...extra] = process.argv.slice(2);
  if (authorization !== '--authorized-install' || extra.length) throw Error('After main approval only: --authorized-install MAIN_SHA256 MANIFEST_SHA256');
  console.log(json(await install({ 'main.js': main, 'manifest.json': manifest })));
}
