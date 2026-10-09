import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { owned, readFile, readPlan, sandbox, profile, vault, executable } from './test-sandbox.mjs';

// Created by the future authorized launcher, never inferred from another session.
export async function assertProcess() {
  const plan = await readPlan();
  const session = JSON.parse(await readFile(join(sandbox, 'native-session.json')));
  if (!Number.isInteger(session.pid) || session.pid < 2 || session.port !== plan.port ||
      session.profile !== profile || session.vault !== vault || session.executable !== executable) throw Error('Invalid owned PID record');
  const ps = args => execFileSync('/bin/ps', args, { encoding: 'utf8' }).trim();
  const command = ps(['-p', String(session.pid), '-o', 'command=']);
  const started = ps(['-p', String(session.pid), '-o', 'lstart=']);
  if (started !== session.started || !command.startsWith(executable + ' ') ||
      !command.split(/\s+/).includes(`--user-data-dir=${profile}`) || !command.split(/\s+/).includes('--remote-debugging-address=127.0.0.1') ||
      !new RegExp(`--remote-debugging-port=${plan.port}(?:\\s|$)`).test(command)) throw Error('Owned process identity mismatch');
  const listeners = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${plan.port}`, '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' });
  let pid;
  const entries = [];
  for (const line of listeners.trim().split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] === 'n') entries.push({ pid, address: line.slice(1) });
  }
  if (!entries.length || entries.some(e => e.pid !== session.pid || e.address !== `127.0.0.1:${plan.port}`)) throw Error('CDP is not exclusively loopback on the recorded PID');
  return plan;
}
class Connection {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else {
        this.events.push(message);
        if (this.events.length > 5000) { this.events.shift(); this.eventsTruncated = true; }
      }
    });
    socket.addEventListener('close', () => this.fail(Error('CDP disconnected')));
    socket.addEventListener('error', () => this.fail(Error('CDP socket error')));
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  close() { this.fail(Error('CDP client closed')); this.socket.close(); }
}
export async function connect() {
  await owned();
  const plan = await assertProcess();
  const response = await fetch(`http://127.0.0.1:${plan.port}/json/list`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw Error('CDP discovery failed');
  const candidates = (await response.json()).filter(t => t.type === 'page' && t.url.startsWith('app://obsidian.md/'));
  if (candidates.length !== 1) throw Error('Expected exactly one isolated Obsidian renderer');
  const url = new URL(candidates[0].webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== plan.port) throw Error('Unexpected CDP socket origin');
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('CDP connect timeout')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('CDP connect failed')); }, { once: true });
  });
  const cdp = new Connection(socket);
  const guard = `if(location.origin !== 'app://obsidian.md' || window.app?.vault?.adapter?.getBasePath?.() !== ${JSON.stringify(vault)}) throw Error('Runtime vault identity mismatch');`;
  try {
    // The only pre-verification evaluation is this read-only identity probe.
    const runtime = await cdp.evaluate(`(() => { ${guard} return {vault: app.vault.adapter.getBasePath(), core: require('electron').ipcRenderer.sendSync('version'), platform: process.platform}; })()`);
    if (runtime.core !== '1.14.4' || runtime.platform !== 'darwin') throw Error('Unsupported runtime: ' + JSON.stringify(runtime));
    return {
      runtime,
      async evaluate(fn, arg) {
        await assertProcess();
        return cdp.evaluate(`(async () => { ${guard} if(require('electron').ipcRenderer.sendSync('version') !== '1.14.4') throw Error('Runtime core changed'); return await (${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'}); })()`);
      },
      async collectErrors() { await assertProcess(); await cdp.evaluate(`(() => { ${guard} return true; })()`); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); },
      async screenshot() { await assertProcess(); await cdp.evaluate(`(() => { ${guard} return true; })()`); return (await cdp.send('Page.captureScreenshot', { format: 'png' })).data; },
      events: cdp.events,
      get eventsTruncated() { return Boolean(cdp.eventsTruncated); },
      close: () => cdp.close(),
    };
  } catch (e) { cdp.close(); throw e; }
}
