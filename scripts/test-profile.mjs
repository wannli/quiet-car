#!/usr/bin/env node
// Separate, explicit safety opt-in: never performed by artifact installation.
// Bundled core main.js reads obsidian.json updateDisabled before enabling updater.
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { sandbox, profile, owned, readFile, directory, createOnly, json } from './test-sandbox.mjs';
import { assertProfileStopped, replaceOwned } from './test-install.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--authorized-disable-updates') throw Error('Requires approval for sandbox profile safety setting: --authorized-disable-updates');
await owned(); assertProfileStopped();
const path = join(profile, 'obsidian.json'), before = await readFile(path), config = JSON.parse(before);
if (config.updateDisabled === true) console.log(json({ updateDisabled: true, changed: false }));
else {
  await directory(join(sandbox, 'profile-backups'));
  const backup = await mkdtemp(join(sandbox, 'profile-backups', 'updater-'));
  await createOnly(join(backup, 'obsidian.json'), before);
  await owned(); assertProfileStopped();
  if (!(await readFile(path)).equals(before)) throw Error('Profile changed concurrently');
  await replaceOwned(path, json({ ...config, updateDisabled: true }));
  console.log(json({ updateDisabled: true, backup, scope: 'Only isolated updater preference; vault registry and other settings preserved' }));
}
