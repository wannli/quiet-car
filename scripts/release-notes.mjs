import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
const path = `releases/${version}.md`;
const source = await readFile(new URL(path, root), 'utf8');
const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
assert.ok(body.includes(`## Quiet Car ${version}`), `${path}: missing version heading`);
for (const section of ['Features', 'Installation', 'Limitations', 'Verification']) {
  const content = body.split(`### ${section}\n`)[1]?.split(/\n#{1,3} /)[0]?.trim();
  assert.ok(content && content.length >= 20, `${path}: missing or empty ${section} section`);
}
if (process.argv[2]) await writeFile(process.argv[2], body + '\n');
console.log(`Validated release notes: ${path}`);
