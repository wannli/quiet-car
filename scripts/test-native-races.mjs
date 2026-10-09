import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function raceCases(h, fixture) {
  const { act, snap, until, mode, stable, step, setting } = h;
  const A = fixture.urls['article-a'], B = fixture.urls['article-b'], E = fixture.urls.empty;
  const held = () => until('native readability fetch held', () => act('summary'), s => s.held > 0);
  await step('pending native Reader refresh -> existing glasses Original survives real extraction', async () => {
    await act('hold'); await act('navigate', 'one', { url: B }); await held();
    const pending = await snap('one'); assert.equal(pending.mode, 'reader');
    await act('toggle', 'one'); await act('release');
    return { pending, after: await stable('one', 'webview', B) };
  }, 'injected host /lib/readability.js fetch delay; actual native getter and toolbar');
  await step('stale unsupported refresh cannot revert newer manual Original', async () => {
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('hold'); await act('navigate', 'one', { url: E }); await held();
    await act('toggle', 'one'); await act('release');
    return h.emptyOriginal('one', E);
  }, 'injected host fetch delay');
  await step('old pending unsupported request superseded by newer page remains at newer URL', async () => {
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('hold'); await act('navigate', 'one', { url: E }); await held();
    const newer = E + '?newer=1'; await act('navigate', 'one', { url: newer });
    await until('newer unsupported document committed', () => snap('one'), s => s.url === newer);
    await act('release'); return h.emptyOriginal('one', newer);
  }, 'injected host fetch delay; both old/new native extraction results unsupported');
  await step('unsupported refresh -> global OFF still falls back to Original B', async () => {
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('hold'); await act('navigate', 'one', { url: E }); await held();
    await setting(false); await act('release'); const fallback = await h.emptyOriginal('one', E);
    await setting(true); return fallback;
  }, 'injected host fetch delay');
  await step('global OFF cancels pending AUTO entry, not native mode', async () => {
    await act('hold'); await act('navigate', 'one', { url: B }); await held();
    await setting(false); await act('release'); return stable('one', 'webview', B);
  }, 'injected host fetch delay');
  await step('native manual Reader pending while OFF, then OFF republish, still completes', async () => {
    await act('hold'); await act('toggle', 'one'); await held();
    await act('republish-off'); await act('release');
    return stable('one', 'reader', B);
  }, 'injected host fetch delay; direct host preference OFF republish; actual native toolbar');
  await step('SPA suspended automation does not disable explicit native Reader', async () => {
    await act('spa', 'one'); await mode('one', 'webview', B + '?synthetic-route=1');
    await act('toggle', 'one'); return mode('one', 'reader', B + '?synthetic-route=1');
  });
  await step('actual stopped navigation does not disable native Reader; record whether -3 occurs', async () => {
    await act('toggle', 'one'); await mode('one', 'webview', B + '?synthetic-route=1');
    await act('navigate', 'one', { url: fixture.origin + '/slow' });
    await until('slow HTTP request reached origin', async () => fixture.requests.some(r => r.path === '/slow'), Boolean);
    await act('stop', 'one'); fixture.releaseSlow();
    const abort = await until('native stop after slow navigation', () => snap('one'), s => {
      const start = s.events.findLast(e => e.type === 'did-start-navigation' && e.url === fixture.origin + '/slow');
      return start && s.events.some(e => e.type === 'did-stop-loading' && e.at >= start.at);
    });
    if (!abort.events.some(e => e.type === 'did-fail-load' && e.errorCode === -3)) h.gap('Exact did-fail-load -3 branch NOT RUN: native stop produced did-stop-loading, not -3. Stop-only manual Reader case is exercised without fabricated events.');
    await act('toggle', 'one'); const after = await mode('one', 'reader', abort.url);
    return { abort, after };
  }, 'controlled loopback HTTP response held; native stop and failure events');
  await step('actual Setting pending ON remains visible; OFF cancels stale ON save', async () => {
    await setting(false); await act('setting-open'); await act('save-hold');
    await act('setting', null, { value: true });
    const pending = await until('pending ON UI', () => act('setting-state'), s => s.saving && s.visibleOn && !s.enabled);
    assert.equal(pending.descriptionVisible, true);
    assert.match(pending.description, /ON applies to subsequent full-document loads\/navigation, not the current page\./);
    assert.match(pending.description, /SPA route changes are not automated; use the native Reader button\./);
    await h.capture('native-settings-pending-ON-with-full-document-SPA-copy');
    await act('setting', null, { value: false });
    const cancelled = await act('setting-state'); assert.equal(cancelled.visibleOn, false); assert.equal(cancelled.enabled, false);
    await act('save-unhold');
    const completed = await until('cancelled save settled', () => act('setting-state'), s => !s.saving);
    assert.equal(completed.visibleOn, false); assert.equal(completed.enabled, false);
    await act('setting-close'); await setting(true); return { pending, cancelled, completed };
  }, 'injected plugin saveData delay; actual native Setting DOM toggle');
  await step('native popout managed construction and manual refresh cancellation', async () => {
    const created = await act('create', 'pop', { url: A, value: 'popout' }); assert.equal(created.managed, true);
    const before = await mode('pop', 'reader', A); assert.equal(before.realm, 'popout');
    await act('hold'); await act('navigate', 'pop', { url: B }); await held();
    await act('toggle', 'pop'); await act('release'); const after = await stable('pop', 'webview', B);
    await act('close', 'pop'); return { created, before, after };
  }, 'native popout; injected host fetch delay');
  await step('close during pending native extraction invalidates session', async () => {
    await act('create', 'closing', { url: A }); await mode('closing', 'reader', A);
    await act('hold'); await act('navigate', 'closing', { url: B }); await held();
    await act('close', 'closing'); await act('release'); await delay(1100);
    const state = await snap('closing'); assert.equal(state.managed, false); assert.equal(state.connected, false); return state;
  }, 'injected host fetch delay');
  await step('unload during pending refresh leaves mode unchanged; reload survivors unmanaged', async () => {
    // Zp2dzP stopped here during SETUP: closing a temporary tab selected two/B.
    // Ordinary explicit user activation belongs here, never inside a body assertion.
    await act('select-tab', 'one');
    const foregroundSetup = await until('group19 native A-tab selected with visible geometry', () => snap('one'), s =>
      s.active && s.activeLeafId === s.leafId && s.connected && s.viewWidth > 0 && s.viewHeight > 0);
    await act('navigate', 'one', { url: A }); await mode('one', 'reader', A);
    await act('hold'); await act('navigate', 'one', { url: B }); await held();
    const before = await snap('one'); const unloaded = await act('unload'); assert.equal(unloaded.factoryRestored, true);
    await act('release'); await delay(1100); const after = await snap('one');
    assert.equal(after.mode, before.mode); assert.equal(after.readerText, before.readerText); assert.equal(after.managed, false);
    await act('load'); const survivor = await snap('one'); assert.equal(survivor.managed, false);
    await act('close', 'one'); await act('create', 'reopened', { url: A });
    const reopened = await mode('reopened', 'reader', A); assert.equal(reopened.managed, true);
    return { foregroundSetup, before, after, survivor, reopened };
  }, 'injected host fetch delay');
  await step('idle unload preserves actual native Reader and factory cleanup', async () => {
    const before = await stable('reopened', 'reader', A);
    const unloaded = await act('unload'); assert.equal(unloaded.factoryRestored, true);
    const after = await snap('reopened'); assert.equal(after.managed, false);
    assert.equal(after.mode, before.mode); assert.equal(after.readerShown, before.readerShown); assert.equal(after.readerText, before.readerText);
    return { before, after, unloaded };
  });
}
