import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeAction } from './test-native-actions.mjs';
import { createOnly } from './test-sandbox.mjs';
import { join } from 'node:path';

export function harness(cdp, token, result) {
  const act = (op, id, extra = {}) => cdp.evaluate(nativeAction, { op, id, token, ...extra });
  const snap = id => act('snapshot', id);
  const capture = async name => createOnly(join(result.evidence, name + '.png'), Buffer.from(await cdp.screenshot(), 'base64'));
  async function until(label, fn, predicate, timeout = 12000) {
    let actual;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { actual = await fn(); if (predicate(actual)) return actual; await delay(100); }
    throw Error(label + ' timed out: ' + JSON.stringify(actual));
  }
  async function mode(id, expected, url, { backgroundModeOnly = false } = {}) {
    const article = new URL(url).pathname.match(/^\/article-([abc])$/)?.[1]?.toUpperCase();
    if (expected === 'reader' && !article) throw Error('Reader assertion requires an explicit known article body marker');
    if (backgroundModeOnly && expected !== 'reader') throw Error('Background phase is Reader mode-entry only');
    const marker = `Section 1 of synthetic article ${article}.`;
    const state = await until(`${id} ${expected} ${url}`, () => snap(id), s => s.mode === expected && s.url === url &&
      (expected === 'reader' ? s.readerShown && !s.originalShown &&
        (backgroundModeOnly ? s.active === false : s.active && s.viewWidth > 0 && s.viewHeight > 0 &&
          s.renderer?.previewWidth > 0 && s.renderer?.previewHeight > 0 && s.readerText?.includes(marker)) : s.originalShown && !s.readerShown));
    assert.deepEqual(state.errors, []);
    return { ...state, readerBodyAssertion: expected === 'reader' ? (backgroundModeOnly ? 'DEFERRED: background mode-entry phase only' : `PASS: native Reader body contains ${marker}`) : undefined };
  }
  async function emptyOriginal(id, url, milliseconds = 1800) {
    assert.equal(new URL(url).pathname, '/empty', 'This assertion is exclusively for the truly empty fixture');
    const original = await stable(id, 'webview', url, milliseconds);
    const guest = await until('actual empty fixture guest document complete', () => act('guest-snapshot', id, { url }), g => g.readyState === 'complete');
    assert.equal(guest.href, url); assert.equal(guest.title, '');
    assert.equal(typeof guest.bodyText, 'string'); assert.equal(guest.bodyText.trim(), '', 'Empty fixture must contain no guest body content (parser whitespace permitted)');
    const after = await mode(id, 'webview', url); assert.equal(after.readerShown, false);
    return { ...after, guest, originalBeforeGuestRead: original,
      guestAssertion: 'PASS: actual verified local guest URL, empty title/body, complete document; previous Reader content may remain HIDDEN normally' };
  }
  async function stable(id, expected, url, milliseconds = 1100) {
    await until('native work settled', () => snap(id), s => !s.pending && !s.extracting);
    const before = await mode(id, expected, url); await delay(milliseconds);
    const after = await mode(id, expected, url);
    assert.equal(after.requests, before.requests, 'Unexpected repeated native extraction'); return after;
  }
  async function step(name, fn, classification = 'native') {
    const entry = { name, classification, status: 'running' }; result.steps.push(entry);
    try { entry.evidence = await fn(); entry.status = 'passed'; await capture('step-' + result.steps.length); }
    catch (error) { entry.status = 'failed'; entry.error = String(error.stack ?? error); throw error; }
  }
  async function setting(value) {
    await act('setting-open'); await act('setting', null, { value });
    const state = await until('preference persisted', () => act('setting-state'), s => !s.saving && s.enabled === value && s.visibleOn === value);
    await act('setting-close'); return state;
  }
  return { act, snap, until, mode, stable, emptyOriginal, step, setting, capture, gap: message => result.remainingGates.push(message) };
}
export async function basicCases(h, fixture) {
  const { act, snap, mode, stable, step, setting } = h;
  const A = fixture.urls['article-a'], B = fixture.urls['article-b'], E = fixture.urls.empty;
  await step('preexisting unmanaged; explicit tester close and guarded recreation', async () => {
    await act('create', 'old', { url: A }); const before = await mode('old', 'webview', A);
    const factory = await act('load'); assert.equal(factory.factoryChanged, true); assert.equal(factory.factoriesEqual, true);
    await act('focus', 'old'); const after = await stable('old', 'webview', A);
    assert.equal(after.managed, false); assert.equal(after.requests, before.requests);
    assert.equal(after.leafId, before.leafId); assert.equal(after.sameView, true); assert.equal(after.sameWebview, true); assert.equal(after.methodsUnchanged, true);
    await act('close', 'old');
    await setting(true);
    const created = await act('create', 'one', { url: A }); assert.equal(created.managed, true);
    const reader = await mode('one', 'reader', A); assert.match(reader.readerText, /Section 1 of synthetic article A\./);
    return { factory, before, after, created, reader };
  });
  await step('restored-state fresh native construction is managed', async () => {
    const created = await act('create', 'restored', { url: A, value: 'restored' }); assert.equal(created.managed, true);
    const state = await mode('restored', 'reader', A); await act('close', 'restored'); return state;
  });
  await step('native glasses Original persists focus/layout/hash; independent fresh view', async () => {
    await act('toggle', 'one'); await mode('one', 'webview', A); await h.capture('manual-original-A');
    await act('create', 'two', { url: B }); await mode('two', 'reader', B);
    await act('focus', 'one'); await act('anchor', 'one');
    const original = await stable('one', 'webview', A + '#ending');
    await act('focus', 'two'); const second = await stable('two', 'reader', B);
    return { original, second };
  });
  await step('true background navigation B, sameURL reload, back/forward; already-on stays Reader', async () => {
    const foreground = await snap('two'); assert.equal(foreground.active, true);
    await act('navigate', 'one', { url: B });
    // Predeclared two-phase assertion: native Reader can lazily render inactive tabs.
    const background = await mode('one', 'reader', B, { backgroundModeOnly: true });
    assert.equal(background.active, false); assert.equal(background.activeLeafId, foreground.leafId);
    const backgroundBodyPresent = !!background.readerText?.trim();
    if (backgroundBodyPresent) assert.match(background.readerText, /Section 1 of synthetic article B\./);
    await act('select-tab', 'one'); // Actual native tab-header UI; no Reader toggle here.
    const activated = await mode('one', 'reader', B); assert.equal(activated.active, true);
    assert.ok(activated.renderer?.sections > 0); assert.equal(activated.requests, background.requests, 'Tab activation must not re-extract');
    await h.capture('activated-native-Reader-B-after-background-entry');
    await act('toggle', 'one'); await mode('one', 'webview', B);
    await act('reload', 'one'); const reload = await mode('one', 'reader', B);
    await act('back', 'one'); const back = await mode('one', 'reader', A + '#ending');
    await act('forward', 'one'); const forward = await stable('one', 'reader', B);
    assert.ok(forward.events.some(e => e.type === 'did-navigate'), 'No real native commit evidence');
    return { background, backgroundBodyPresent,
      backgroundClaim: backgroundBodyPresent ? 'Correct B Reader DOM body present while inactive; not a foreground-visibility claim' : 'Background Reader mode entry only; content verified after native tab activation',
      activated, activationControl: 'Native tab-header click only; B body verified BEFORE any Reader toggle', reload, back, forward };
  });
  await step('Reader A to unsupported B shows Original B, not stale Reader A; no retry loop', async () => {
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('navigate', 'one', { url: E }); return h.emptyOriginal('one', E);
  });
  await step('ambiguous SPA route is LIMITED: Original and suspended until full commit', async () => {
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('spa', 'one'); const suspended = await stable('one', 'webview', A + '?synthetic-route=1');
    await act('reload', 'one'); const recovered = await mode('one', 'reader', A + '?synthetic-route=1');
    return { limitation: 'No universal SPA new-article automation claim', suspended, recovered };
  });
  await step('OFF retains Reader; native manual Reader works OFF; ON only next visit', async () => {
    const current = await snap('one'); await setting(false); await stable('one', 'reader', current.url);
    // OFF preserves native Reader, including native navigation refresh. Explicitly
    // choose Original before asserting that OFF prevents future AUTO entry.
    await act('toggle', 'one'); await mode('one', 'webview', current.url);
    await act('navigate', 'one', { url: B }); await mode('one', 'webview', B);
    await act('toggle', 'one'); await mode('one', 'reader', B);
    await act('toggle', 'one'); await mode('one', 'webview', B);
    await setting(true); const sameVisit = await stable('one', 'webview', B);
    await act('navigate', 'one', { url: A }); const next = await mode('one', 'reader', A);
    return { sameVisit, next };
  });
}
