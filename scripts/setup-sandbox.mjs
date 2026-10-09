#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sandbox, vault, profile, executable, json, markDirectory, createOnly, stat, readPlan, freePort, owned, isMain } from './test-sandbox.mjs';

function article(letter) {
  const paragraphs = Array.from({ length: 18 }, (_, i) => `<p>Section ${i + 1} of synthetic article ${letter}. The coastal research team documented how careful observation improves a shared understanding of seasonal changes. Each morning the team compared measurements, discussed uncertainty, and recorded the methods used to reach its conclusions. This deterministic paragraph is local test content, not a captured user article. Repeated observations helped distinguish temporary fluctuations from persistent patterns in the environment.</p>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture article ${letter}</title><meta name="author" content="Sandbox test harness"></head><body><nav><a href="/article-a">A</a> <a href="/article-b">B</a> <a href="/nonarticle">Nonarticle</a></nav><main><article><h1>Fixture article ${letter}</h1><p>By Sandbox test harness</p>${paragraphs}<h2 id="ending">Final observations</h2><p>End of synthetic article ${letter}.</p><a href="#ending">Anchor</a></article></main></body></html>\n`;
}
export async function setup() {
  await markDirectory(sandbox);
  await markDirectory(vault);
  await markDirectory(profile);
  const id = createHash('sha256').update(vault).digest('hex').slice(0, 16);
  await createOnly(join(profile, 'obsidian.json'), json({ vaults: { [id]: { path: vault, ts: 0, open: true } } }));
  await owned();
  const planPath = join(sandbox, 'launch-plan.json');
  if (!await stat(planPath)) {
    let port;
    try { port = await freePort(19226); }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; port = await freePort(0); }
    await createOnly(planPath, json({ executable, profile, vault, port, checkedAt: new Date().toISOString(),
      args: [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
      warning: 'Port check is not a reservation. Recheck immediately before an explicitly authorized launch.' }));
  }
  const plan = await readPlan();
  await createOnly(join(sandbox, 'fixtures', 'empty.html'), '<!doctype html><html><head></head><body></body></html>\n');
  for (const letter of ['A', 'B', 'C']) await createOnly(join(sandbox, 'fixtures', `article-${letter.toLowerCase()}.html`), article(letter));
  await createOnly(join(sandbox, 'fixtures', 'nonarticle.html'), '<!doctype html><title>Empty utility page</title><form><input aria-label="Search"><button>Search</button></form>\n');
  return { mode: 'create-only', vault, profile, port: plan.port, appLaunched: false, pluginInstalled: false };
}
if (isMain(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('No arguments accepted; fixed sandbox paths only');
  console.log(json(await setup()));
}
