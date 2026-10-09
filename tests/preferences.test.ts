import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePreferences, PreferenceStore, type Preferences } from '../src/preferences.js';

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error('disk')); });
  return { promise, resolve, reject };
}

test('only absent data defaults on; exact boolean preference is preserved', () => {
  for (const data of [undefined, null]) assert.equal(decodePreferences(data).enabled, true);
  for (const enabled of [false, true]) {
    assert.deepEqual(decodePreferences({ enabled }), { enabled, requestedEnabled: enabled, problem: null, saving: false });
  }
});

test('invalid shape fails off, including extra fields and inherited enabled', () => {
  for (const data of [{}, [], true, 1, 'true', { enabled: 'true' },
    { enabled: true, url: 'synthetic' }, Object.create({ enabled: true })]) {
    assert.deepEqual(decodePreferences(data), { enabled: false, requestedEnabled: false, problem: 'invalid', saving: false });
  }
});

test('load never writes defaults, invalid data, or unknown unreadable data', async () => {
  let writes = 0;
  for (const read of [async () => null, async () => ({}), async () => { throw Error('read'); }]) {
    const store = new PreferenceStore(read, async () => { ++writes; });
    await store.load();
  }
  assert.equal(writes, 0);
  const store = new PreferenceStore(async () => { throw Error('read'); }, async () => {});
  await store.load();
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.problem, 'load-failed');
});

test('OFF is immediate and ON waits for successful persistence', async () => {
  const gate = deferred();
  const writes: Preferences[] = [];
  const store = new PreferenceStore(async () => null, async data => { writes.push(data); await gate.promise; });
  await store.load();
  const off = store.setEnabled(false);
  assert.equal(store.state.enabled, false);
  const on = store.setEnabled(true);
  assert.equal(store.state.enabled, false);
  await Promise.resolve();
  assert.deepEqual(writes, [{ enabled: false }]);
  gate.resolve();
  await Promise.all([off, on]);
  assert.deepEqual(writes, [{ enabled: false }, { enabled: true }]);
  assert.equal(store.state.enabled, true);
});

test('rapid ON then OFF cannot transiently activate when old save resolves', async () => {
  const gates = [deferred(), deferred()];
  let index = 0;
  const seen: boolean[] = [];
  const store = new PreferenceStore(async () => ({ enabled: false }), async () => {
    await gates[index++]!.promise;
  }, state => seen.push(state.enabled));
  await store.load();
  const on = store.setEnabled(true);
  const off = store.setEnabled(false);
  gates[0]!.resolve();
  await on;
  assert.equal(store.state.enabled, false);
  gates[1]!.resolve();
  await off;
  assert.ok(seen.every(enabled => !enabled));
});

test('displayed pending ON can be clicked OFF before serialized saves complete', async () => {
  const gates = [deferred(), deferred()];
  const writes: Preferences[] = [];
  let displayed = false;
  let persisted = false;
  const store = new PreferenceStore(async () => ({ enabled: false }), async data => {
    const gate = gates[writes.length]!;
    writes.push(data);
    await gate.promise;
    persisted = data.enabled;
  }, state => { displayed = state.requestedEnabled; });
  await store.load();
  // Model the toggle callback and refresh binding, not an explicit second ON/OFF request.
  const click = () => store.setEnabled(!displayed);
  const on = click();
  assert.equal(displayed, true);
  assert.equal(store.state.enabled, false);
  await Promise.resolve();
  const off = click();
  assert.equal(displayed, false);
  assert.equal(store.state.enabled, false);
  assert.deepEqual(writes, [{ enabled: true }]);
  gates[0]!.resolve();
  await on;
  assert.equal(persisted, true);
  assert.equal(displayed, false);
  assert.equal(store.state.enabled, false);
  gates[1]!.resolve();
  await off;
  assert.deepEqual(writes, [{ enabled: true }, { enabled: false }]);
  assert.equal(persisted, false);
  assert.equal(displayed, false);
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.saving, false);
});

test('latest delayed save failure resets display to effective OFF', async () => {
  const gate = deferred();
  let displayed = false;
  const store = new PreferenceStore(async () => ({ enabled: false }), async () => gate.promise,
    state => { displayed = state.requestedEnabled; });
  await store.load();
  const save = store.setEnabled(true);
  assert.equal(displayed, true);
  await Promise.resolve();
  gate.reject();
  await save;
  assert.equal(displayed, false);
  assert.deepEqual(store.state, {
    enabled: false, requestedEnabled: false, problem: 'save-failed', saving: false,
  });
});

test('older delayed failure cannot reset newer ON intent or activate it early', async () => {
  const gates = [deferred(), deferred()];
  let index = 0;
  let displayed = true;
  const store = new PreferenceStore(async () => ({ enabled: true }), async () => {
    await gates[index++]!.promise;
  }, state => { displayed = state.requestedEnabled; });
  await store.load();
  const off = store.setEnabled(false);
  await Promise.resolve();
  const on = store.setEnabled(true);
  assert.equal(displayed, true);
  assert.equal(store.state.enabled, false);
  gates[0]!.reject();
  await off;
  assert.equal(displayed, true);
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.saving, true);
  assert.equal(store.state.problem, null);
  gates[1]!.resolve();
  await on;
  assert.equal(displayed, true);
  assert.equal(store.state.enabled, true);
});

test('failed save stays off and explicit retry can recover the queue', async () => {
  let fail = true;
  const store = new PreferenceStore(async () => ({ enabled: false }), async () => {
    if (fail) throw Error('write');
  });
  await store.load();
  await store.setEnabled(true);
  assert.deepEqual(store.state, { enabled: false, requestedEnabled: false, problem: 'save-failed', saving: false });
  fail = false;
  await store.setEnabled(true);
  assert.deepEqual(store.state, { enabled: true, requestedEnabled: true, problem: null, saving: false });
});

test('dispose skips queued saves and ignores an in-flight save result', async () => {
  const gate = deferred();
  let writes = 0;
  const store = new PreferenceStore(async () => ({ enabled: false }), async () => {
    ++writes;
    await gate.promise;
  });
  await store.load();
  const first = store.setEnabled(true);
  await Promise.resolve();
  const second = store.setEnabled(false);
  store.dispose();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(writes, 1);
  assert.equal(store.state.enabled, false);
});

test('dispose invalidates delayed load and saves without activation or queued writes', async () => {
  const gate = deferred();
  let writes = 0;
  let changes = 0;
  const store = new PreferenceStore(async () => { await gate.promise; return null; },
    async () => { ++writes; }, () => { ++changes; });
  const loading = store.load();
  store.dispose();
  gate.resolve();
  await loading;
  await store.setEnabled(true);
  assert.equal(writes, 0);
  assert.equal(changes, 0);
});
