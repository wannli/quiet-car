#!/usr/bin/env node
// Restore only the two plugin artifacts from the last install receipt, app stopped.
import { join, relative } from 'node:path';
import { unlink } from 'node:fs/promises';
import { sandbox, vault, owned, readFile, safe, json } from './test-sandbox.mjs';
import { assertProfileStopped, pluginDir, verifyInstalled, replaceOwned, sha } from './test-install.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--authorized-restore') throw Error('After main approval and isolated app exit: --authorized-restore');
await owned(); assertProfileStopped();
const receipt = JSON.parse(await readFile(join(sandbox, 'installed-build.json')));
if (receipt.vault !== vault || typeof receipt.backup !== 'string') throw Error('Invalid receipt');
const rel = relative(join(sandbox, 'backups'), receipt.backup);
if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw Error('Backup outside owned directory');
await verifyInstalled(receipt.hashes);
const files = {};
for (const name of ['main.js', 'manifest.json']) {
  const expected = receipt.previous?.[name];
  if (expected === null) files[name] = null;
  else {
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw Error('Missing original artifact hash');
    files[name] = await readFile(join(receipt.backup, name));
    if (sha(files[name]) !== expected) throw Error('Backup hash mismatch');
  }
}
const changed = [];
try {
  for (const [name, bytes] of Object.entries(files)) {
    await owned(); assertProfileStopped();
    const target = join(pluginDir, name);
    if (sha(await readFile(target)) !== receipt.hashes[name]) throw Error('Concurrent artifact modification');
    if (bytes) await replaceOwned(target, bytes); else { await safe(target); await unlink(target); }
    changed.push(name);
  }
} catch (error) { throw Error('Partial restoration; untouched backups retained. Restored: ' + changed.join(', '), { cause: error }); }
console.log(json({ restored: changed, backup: receipt.backup, notesAndSettings: 'untouched' }));
