import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sandbox = join(root, '.sandbox');
export const vault = join(sandbox, 'Auto Web Reader Test Vault');
export const profile = join(sandbox, 'obsidian-profile');
export const executable = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
export const marker = '.auto-web-reader-test.json';
export const identity = { schema: 1, purpose: 'isolated auto-web-reader native tests', root, vault, profile };
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const isMain = url => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
export async function stat(path) {
  try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function safe(path, kind = 'file') {
  path = resolve(path);
  const rel = relative(sandbox, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/')) throw Error('Outside sandbox: ' + path);
  if (await realpath(root) !== root) throw Error('Symlinked project root');
  const parts = [];
  for (let p = path; p !== root; p = dirname(p)) parts.unshift(p);
  for (const p of parts) {
    const s = await stat(p);
    if (!s) continue;
    if (s.isSymbolicLink() || (p !== path || kind === 'directory' ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) {
      throw Error('Unsafe sandbox path: ' + p);
    }
  }
  return path;
}
export async function directory(path) {
  await safe(path, 'directory');
  await mkdir(path, { recursive: true });
  await safe(path, 'directory');
}
export async function readFile(path) {
  await safe(path);
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1) throw Error('Unsafe file: ' + path);
    return await h.readFile();
  } finally { await h.close(); }
}
export async function createOnly(path, content) {
  await safe(path); await directory(dirname(path));
  let h;
  try { h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code !== 'EEXIST') throw e; await readFile(path); return false; }
  try { await h.writeFile(content); } finally { await h.close(); }
  return true;
}
export async function markDirectory(path) {
  await safe(path, 'directory');
  if (await stat(path) && !await stat(join(path, marker)) && (await readdir(path)).length) {
    throw Error('Refusing to adopt nonempty unmarked directory: ' + path);
  }
  await directory(path);
  await createOnly(join(path, marker), json(identity));
  await checkMarker(path);
}
export async function checkMarker(path) {
  const actual = JSON.parse(await readFile(join(path, marker)));
  if (JSON.stringify(actual) !== JSON.stringify(identity)) throw Error('Sandbox marker mismatch: ' + path);
}
export async function owned() {
  for (const path of [sandbox, vault, profile]) await checkMarker(path);
  const config = JSON.parse(await readFile(join(profile, 'obsidian.json')));
  const values = Object.values(config.vaults ?? {});
  if (values.length !== 1 || values[0].path !== vault || values[0].open !== true) throw Error('Unexpected profile vault registry');
}
export async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return selected;
}
export async function readPlan() {
  await owned();
  const plan = JSON.parse(await readFile(join(sandbox, 'launch-plan.json')));
  if (!Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535 || plan.port === 19224) throw Error('Unsafe CDP port');
  if (plan.executable !== executable || plan.profile !== profile || plan.vault !== vault) throw Error('Launch plan identity mismatch');
  return plan;
}
