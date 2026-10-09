import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async name => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
const [manifest, pkg, lock, versions] = await Promise.all(
  ['manifest.json', 'package.json', 'package-lock.json', 'versions.json'].map(read),
);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'Use a numeric major.minor.patch version');
assert.equal(manifest.id, 'quiet-car');
assert.equal(pkg.name, manifest.id);
assert.equal(pkg.version, manifest.version, 'Package and manifest versions must match');
assert.equal(lock.version, manifest.version, 'Lockfile version must match');
assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root version must match');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'versions.json must include the current minimum app version');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, manifest.version, 'Release tag must exactly match manifest.version (no v prefix)');
}
console.log(`Quiet Car ${manifest.version}: version metadata consistent`);
