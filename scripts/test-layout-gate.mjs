import assert from 'node:assert/strict';
// Mandatory first gate. Only normal native tab clicks/navigation/toggles/settings;
// NO view/renderer resize, queueRender, synthetic resize, or forced-focus calls.
export async function layoutGate(h, fixture) {
  const { act, snap, mode, stable, until, setting, capture } = h;
  const A = fixture.urls['article-a'], B = fixture.urls['article-b'];
  const result = { status: 'running', control: 'Native tab-header clicks only; no test-driven resize/render scheduling',
    counter: 'Host /lib/readability.js calls: core1.14.4 native getter performs one such fetch per execution' };
  result.factory = await act('load'); await setting(true);
  await act('create', 'gate-one', { url: A }); await mode('gate-one', 'reader', A);
  await act('toggle', 'gate-one'); await mode('gate-one', 'webview', A);
  await act('create', 'gate-cover', { url: B }); const cover = await stable('gate-cover', 'reader', B);
  await act('navigate', 'gate-one', { url: B });
  const background = await until('gate background Reader B committed/settled without focus change', () => snap('gate-one'), s =>
    s.mode === 'reader' && s.url === B && s.nativeUrl === B && !s.active && !s.pending && !s.extracting && s.renderer?.textSample?.includes('Section 1 of synthetic article B.'));
  assert.equal(background.activeLeafId, cover.leafId);
  await act('select-tab', 'gate-one');
  const activated = await mode('gate-one', 'reader', B);
  assert.equal(activated.active, true); assert.equal(activated.activeLeafId, background.leafId);
  assert.ok(activated.renderer?.sections > 0); assert.equal(activated.renderer.previewOwned, true);
  assert.ok(activated.renderer.previewWidth > 0); assert.equal(activated.requests, background.requests, 'Natural activation must not re-extract B');
  result.enabled = { background, activated }; await capture('layout-gate-native-Reader-B-natural-activation');
  result.offPreference = await setting(false);
  await act('select-tab', 'gate-cover'); await act('navigate', 'gate-one', { url: A });
  const offBackground = await until('OFF preserves native background Reader refresh', () => snap('gate-one'), s =>
    s.mode === 'reader' && s.url === A && s.nativeUrl === A && !s.active && !s.pending && !s.extracting && s.renderer?.textSample?.includes('Section 1 of synthetic article A.'));
  await act('select-tab', 'gate-one'); const offActivated = await mode('gate-one', 'reader', A);
  assert.equal(offActivated.active, true); assert.ok(offActivated.renderer?.sections > 0);
  assert.equal(offActivated.requests, offBackground.requests, 'OFF layout activation must not re-extract A');
  result.disabled = { background: offBackground, activated: offActivated };
  await capture('layout-gate-OFF-native-Reader-A-natural-activation');
  await act('toggle', 'gate-one'); const original = await mode('gate-one', 'webview', A);
  await act('select-tab', 'gate-cover'); await act('select-tab', 'gate-one');
  const afterFocus = await stable('gate-one', 'webview', A);
  assert.equal(afterFocus.requests, original.requests, 'Layout must not reactivate manual Original');
  result.manualOriginal = { before: original, after: afterFocus };
  await setting(true); const unloaded = await act('unload'); assert.equal(unloaded.factoryRestored, true);
  await act('close', 'gate-one'); await act('close', 'gate-cover');
  result.status = 'passed'; return result;
}
