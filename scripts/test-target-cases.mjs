import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
export async function targetedCases(h, target, fixture, result) {
  const { act, snap, until, step } = h;
  const A = fixture.urls['article-a'], B = fixture.urls['article-b'], C = fixture.urls['article-c'];
  const trace = () => target('trace');
  const reader = (url, letter) => until('actual rendered article ' + letter, () => snap('target'), s =>
    s.active && s.viewWidth > 0 && s.viewHeight > 0 && s.renderer?.previewWidth > 0 && s.renderer?.previewHeight > 0 &&
    s.managed && s.mode === 'reader' && s.readerShown && !s.originalShown && s.url === url && s.nativeUrl === url &&
    !s.pending && !s.extracting && s.readerText.includes('Section 1 of synthetic article ' + letter + '.'));
  result.loaded = await act('load'); await h.setting(true);
  const created = await act('create', 'target', { url: A }); assert.equal(created.managed, true);
  await reader(A, 'A');
  await step('old native asset failure settles AFTER newer successful native Reader C without fallback', async () => {
    await target('hold-one-503'); await act('navigate', 'target', { url: fixture.urls.empty });
    const held = await until('one actual native asset request held', trace, t => t.some(e => e.type === 'asset-held'));
    const oldRequest = held.findLast(e => e.type === 'asset-held').request;
    await act('navigate', 'target', { url: C }); const before = await reader(C, 'C');
    const successBoundary = await target('mark-c-success');
    await h.capture('newer-native-Reader-C-before-old-failure');
    await target('release-503');
    const settled = await until('old real native getter and display completion', trace, t =>
      t.some(e => e.type === 'native-getter-settled' && e.request === oldRequest && e.content === false) &&
      t.some(e => e.type === 'native-display-settled' && e.request === oldRequest));
    const release = settled.find(e => e.type === 'asset-release-503' && e.request === oldRequest);
    assert.ok(release); assert.equal(settled.filter(e => e.seq > release.seq && e.type === 'native-reader-show').length, 0);
    await delay(700); const after = await reader(C, 'C'); assert.equal(after.readerText, before.readerText, 'Visible Reader content SAMPLE changed');
    const finalTrace = await trace();
    const presentationCalls = finalTrace.filter(e => e.seq > successBoundary.seq && ['native-original-call', 'native-reader-hide', 'native-reader-show'].includes(e.type));
    assert.deepEqual(presentationCalls, [], 'Native presentation changed after C success while stale completion settled');
    await h.capture('newer-native-Reader-C-after-old-failure');
    return { oldRequest, successBoundary, before, after, presentationCalls, trace: finalTrace,
      scope: 'Reader URL/mode/visibility and capped 500-character visible content SAMPLE unchanged; not whole-body byte equality',
      control: 'Held native readability fetch receives controlled503; native getter !ok -> Notice/undefined and display settlement observed. Delegated Original/hide/show observers exclude native fallback/re-entry calls after C success. Not a natural unsupported parse.' };
  }, 'injected one-shot delayed asset503; actual native getter and renderer');
  await step('matched native A Reader -> B refresh positive control through identical Promise hook without Original injection', async () => {
    await act('navigate', 'target', { url: A }); await reader(A, 'A');
    await target('arm-control', 'target'); await act('navigate', 'target', { url: B });
    const prepared = await until('positive-control native B preparation', trace, t => t.some(e => e.type === 'result-prepared' && e.experiment === 'control'));
    const p = prepared.findLast(e => e.type === 'result-prepared' && e.experiment === 'control');
    assert.match(p.bodyMarker, /Section 1 of synthetic article B\./);
    assert.equal(p.eligibility.accessible, true); assert.equal(p.eligibility.current, true);
    assert.equal(p.eligibility.kind, 'refresh'); assert.equal(p.eligibility.mode, 'reader');
    const after = await reader(B, 'B');
    const settled = await until('positive-control native display completion', trace, t => t.some(e => e.type === 'native-display-settled' && e.request === p.request));
    const end = settled.find(e => e.type === 'native-display-settled' && e.request === p.request);
    const shows = settled.filter(e => e.type === 'native-reader-show' && e.seq > p.seq && e.seq < end.seq);
    assert.ok(shows.length > 0, 'Same hook must allow actual native Reader B show');
    assert.equal(settled.some(e => e.request === p.request && e.type === 'manual-original'), false);
    await h.capture('matched-positive-control-native-Reader-B');
    return { request: p.request, prepared: p, shows, settled: end, after,
      control: 'Same actual native factory/getter/Promise preparation hook and AReader->B full-document refresh; only Original microtask injection disabled' };
  }, 'matched native positive control; identical delegated test-only Promise hook');
  await step('exact native result-prepared -> Original microtask -> native display settled; no Reader re-entry', async () => {
    await act('navigate', 'target', { url: A }); await reader(A, 'A');
    await target('arm-gap', 'target'); await act('navigate', 'target', { url: B });
    const prepared = await until('actual native gate preparation and UI microtask', trace, t => t.some(e => e.type === 'manual-original'));
    const manual = prepared.findLast(e => e.type === 'manual-original'), request = manual.request;
    const settled = await until('original native display promise settled', trace, t => t.some(e => e.type === 'native-display-settled' && e.request === request));
    const p = settled.find(e => e.type === 'result-prepared' && e.request === request);
    const before = settled.find(e => e.type === 'before-native-original' && e.request === request);
    const end = settled.find(e => e.type === 'native-display-settled' && e.request === request);
    assert.ok(p.seq < before.seq && before.seq < manual.seq && manual.seq < end.seq);
    assert.equal(before.mode, 'reader'); assert.equal(manual.mode, 'webview'); assert.equal(end.mode, 'webview');
    assert.match(p.bodyMarker, /Section 1 of synthetic article B\./);
    for (const observed of [p, before]) {
      assert.equal(observed.eligibility.accessible, true); assert.equal(observed.eligibility.current, true);
      assert.equal(observed.eligibility.kind, 'refresh'); assert.equal(observed.eligibility.mode, 'reader');
    }
    assert.equal(manual.eligibility.accessible, true); assert.equal(manual.eligibility.current, false);
    assert.ok(manual.eligibility.sessionRevision > manual.eligibility.requestRevision);
    await delay(700); const after = await h.mode('target', 'webview', B);
    assert.equal(after.managed, true); assert.equal(after.methodsUnchanged, true);
    const finalTrace = await trace(); assert.equal(finalTrace.filter(e => e.seq > manual.seq && e.type === 'native-reader-show').length, 0);
    await h.capture('exact-microtask-native-Original-B');
    return { request, ordering: [p, before, manual, end], after, trace: finalTrace,
      qualification: 'Actual captured session.entry passed to inspected pure current(request): true after preparation/before Original, false afterward. Intrinsic gate released/direct closure flags are NOT inspected or claimed; matched positive control separately demonstrates this hook can render.',
      control: 'Factory-decorated REAL getter nativePromise.then forwards native methods. Actual preparation callback runs before queued native UI Original; carrier settles after wrapper returns, so native continuation follows Original microtask. Native display helper and renderer unmodified; presentation observers delegate.' };
  }, 'injected exact Promise microtask scheduling; actual native getter/display/glasses UI');
  await step('bounded natural abort attempt: native stop after stalled top-level navigation', async () => {
    await act('navigate', 'target', { url: fixture.origin + '/slow' });
    await until('stalled native HTTP request', async () => fixture.requests.some(r => r.path === '/slow'), Boolean, 5000);
    await act('stop', 'target'); fixture.releaseSlow();
    const stopped = await until('natural stopped event', () => snap('target'), s => {
      const start = s.events.findLast(e => e.type === 'did-start-navigation' && e.url === fixture.origin + '/slow');
      return start && s.events.some(e => e.at >= start.at && e.type === 'did-stop-loading');
    }, 5000);
    const start = stopped.events.findLast(e => e.type === 'did-start-navigation' && e.url === fixture.origin + '/slow');
    const aborts = stopped.events.filter(e => e.at >= start.at && e.errorCode === -3);
    result.exactMinus3 = { status: aborts.some(e => e.type === 'did-fail-load') ? 'PASS' : 'NOT_RUN', actualAborts: aborts,
      note: 'No events fabricated; provisional-only abort is not did-fail-load coverage.' };
    await act('toggle', 'target'); const recovered = await reader(B, 'B');
    return { stopped, recovered, exactMinus3: result.exactMinus3 };
  }, 'held loopback HTTP response; native webview.stop; natural event trace');
}
