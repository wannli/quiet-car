import assert from 'node:assert/strict';

export async function lifecycleCases(h, fixture) {
  const { act, mode, stable, step, snap } = h;
  const A = fixture.urls['article-a'], B = fixture.urls['article-b'];
  await act('load');
  await step('native webview element replacement preserves manual Original; manual Reader still works', async () => {
    await act('create', 'binding', { url: A }); await mode('binding', 'reader', A);
    await act('toggle', 'binding'); await mode('binding', 'webview', A);
    await act('replace-webview', 'binding'); const rebound = await stable('binding', 'webview', A);
    assert.equal(rebound.sameWebview, false); assert.equal(rebound.managed, true);
    await act('toggle', 'binding'); const manual = await mode('binding', 'reader', A);
    await act('navigate', 'binding', { url: B }); const next = await mode('binding', 'reader', B);
    return { rebound, manual, next, scope: 'Invoked observed native instantiateWebView; no synthetic navigation events or guest extraction changes' };
  });
  await step('actual core Web Viewer disable/enable retires sessions; fresh native factory view managed again', async () => {
    const disabled = await act('core-disable'); assert.equal(disabled.enabled, false); assert.equal(disabled.hasRegisteredFactory, false);
    const old = await snap('binding'); assert.equal(old.managed, false);
    const enabled = await act('core-enable'); assert.equal(enabled.enabled, true); assert.equal(enabled.hasRegisteredFactory, true);
    const created = await act('create', 'core-reopened', { url: A }); assert.equal(created.managed, true);
    const fresh = await mode('core-reopened', 'reader', A);
    return { disabled, old, enabled, created, fresh, scope: 'Explicit tester core disable/enable closes only tester-owned leaves, not a production automatic reopen' };
  });
}
