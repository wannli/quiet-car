import { createServer } from 'node:http';
import { join } from 'node:path';
import { sandbox, owned, readFile, isMain, json } from './test-sandbox.mjs';

export async function startFixtures() {
  await owned();
  const pages = new Map();
  for (const name of ['article-a', 'article-b', 'article-c', 'nonarticle', 'empty']) pages.set('/' + name, await readFile(join(sandbox, 'fixtures', name + '.html')));
  const requests = [], slow = [];
  const releaseSlow = () => { for (const res of slow.splice(0)) if (!res.destroyed) { res.writeHead(200); res.end(pages.get('/article-a')); } };
  let truncated = false;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (requests.length < 5000) requests.push({ method: req.method, path: url.pathname, query: url.search, at: Date.now() });
      else truncated = true;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      if (url.pathname === '/slow') { slow.push(res); return; }
      const body = pages.get(url.pathname);
      res.writeHead(body ? 200 : 404);
      res.end(req.method === 'HEAD' ? undefined : body ?? 'Not found');
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, releaseSlow, get truncated() { return truncated; },
    urls: Object.fromEntries([...pages.keys()].map(path => [path.slice(1), origin + path])),
    async stop() {
      releaseSlow(); server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    } };
}
if (isMain(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--serve') throw Error('Use --serve for loopback fixtures only; never launches Obsidian');
  const fixture = await startFixtures();
  console.log(json({ pid: process.pid, ...fixture.urls }));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    await fixture.stop();
  });
}
