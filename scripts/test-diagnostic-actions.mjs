// Diagnostic actions only, serialized behind the parent CDP identity guard.
export async function diagnosticAction({ op, id, url, token }) {
  const key = '__quietCarDiagnostic';
  if (op === 'init') {
    if (window[key] || app.plugins.plugins['quiet-car'] || app.workspace.getLeavesOfType('webviewer').length) throw Error('Diagnostic requires clean owned native workspace');
    const origin = new URL(url);
    if (origin.origin !== url || origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw Error('Loopback fixture required');
    window[key] = { token, origin: url, leaves: {}, views: {}, trace: [], undo: [], errors: [], instrumented: false,
      originalFactory: app.viewRegistry.viewByType.webviewer, ownerVault: app.vault.adapter.getBasePath() };
    return true;
  }
  const c = window[key]; if (!c || c.token !== token) throw Error('Diagnostic ownership mismatch');
  const leaf = () => { const l = c.leaves[id]; if (!l || l.view !== c.views[id]) throw Error('Owned live view mismatch'); return l; };
  const view = () => leaf().view;
  const fixtureURL = address => {
    const u = new URL(address); if (u.origin !== c.origin || !['/article-a', '/article-b'].includes(u.pathname)) throw Error('Unknown fixture'); return address;
  };
  const shape = element => {
    if (!element) return null;
    const win = element.ownerDocument.defaultView, style = win.getComputedStyle(element), rect = element.getBoundingClientRect();
    return { tag: element.tagName, classes: element.className, connected: element.isConnected,
      style: { display: style.display, visibility: style.visibility, opacity: style.opacity, overflow: style.overflow },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, rectCount: element.getClientRects().length,
      offsetWidth: element.offsetWidth, offsetHeight: element.offsetHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight,
      offsetParent: element.offsetParent?.className ?? null, childCount: element.childElementCount,
      textLength: element.textContent?.length, innerTextLength: element.innerText?.length,
      textSample: element.textContent?.slice(0, 180), innerTextSample: element.innerText?.slice(0, 180),
      children: [...element.children].slice(0, 4).map(e => ({ tag: e.tagName, classes: e.className, textLength: e.textContent.length })) };
  };
  if (op === 'create') {
    fixtureURL(url); if (c.leaves[id]) throw Error('Duplicate owned leaf');
    const l = app.workspace.getLeaf('tab'); c.leaves[id] = l;
    await l.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } }); c.views[id] = l.view;
    return { id: l.id, managed: !!app.plugins.plugins['quiet-car']?.bridge?.getSession(l.view) };
  }
  if (op === 'snapshot') {
    const l = leaf(), v = l.view, r = v.renderer, win = v.containerEl.ownerDocument.defaultView, nativeWin = win.electronWindow;
    const fields = {};
    if (r) for (const name of ['text', 'lastText', 'sections', 'asyncSections', 'rendered', 'queued', 'parsing', 'renderedWidth', 'viewportHeight', 'lastRender']) {
      const value = r[name]; fields[name] = typeof value === 'string' ? { type: 'string', length: value.length, sample: value.slice(0, 100) }
        : Array.isArray(value) ? { type: 'array', length: value.length } : value == null || ['boolean', 'number'].includes(typeof value) ? value : { type: typeof value, keys: Object.keys(value).slice(0, 6) };
    }
    let currentUrl; try { currentUrl = v.webview.getURL(); } catch { currentUrl = null; }
    return { mode: v.mode, viewType: v.getViewType(), readerIsOwnedDOM: v.contentEl.contains(v.readerView), readerMatchesSelector: v.contentEl.querySelector('.reader-mode-content') === v.readerView,
      url: currentUrl, nativeUrl: v.url, leafId: l.id, managed: !!app.plugins.plugins['quiet-car']?.bridge?.getSession(v),
      activeLeafId: app.workspace.activeLeaf?.id, activeTabGroupMatches: app.workspace.activeTabGroup === l.parent,
      parentChildIndex: l.parent?.children?.indexOf(l), parentSelectedPrimitives: Object.fromEntries(Object.entries(l.parent ?? {}).filter(([k, value]) => /active|selected|current|index/i.test(k) && ['string', 'number', 'boolean'].includes(typeof value))),
      window: { visibility: win.document.visibilityState, hidden: win.document.hidden, focused: win.document.hasFocus(), width: win.innerWidth, height: win.innerHeight,
        nativeVisible: typeof nativeWin?.isVisible === 'function' ? nativeWin.isVisible() : 'unavailable', nativeMinimized: typeof nativeWin?.isMinimized === 'function' ? nativeWin.isMinimized() : 'unavailable' },
      elements: { leaf: shape(l.containerEl), tab: shape(l.tabHeaderEl), parent: shape(l.parent?.containerEl), view: shape(v.containerEl), content: shape(v.contentEl),
        reader: shape(v.readerView), guest: shape(v.webview), preview: shape(r?.previewEl), sizer: shape(r?.sizerEl) },
      renderer: r ? { fields, ownKeys: Object.keys(r).slice(0, 45), methods: Object.getOwnPropertyNames(Object.getPrototypeOf(r)).filter(k => typeof r[k] === 'function').slice(0, 65) } : null,
      nativeUnmodifiedControl: !c.instrumented && !app.plugins.plugins['quiet-car'] && app.viewRegistry.viewByType.webviewer === c.originalFactory &&
        ['getReaderModeContent', 'displayReaderView', 'displayWebView', 'onOpen'].every(k => !Object.hasOwn(v, k)) };
  }
  if (op === 'select') { leaf().tabHeaderEl.click(); return true; }
  if (op === 'toggle') { view().readerModeToggleBtn.click(); return true; }
  if (op === 'navigate') { view().navigate(fixtureURL(url), true); return true; }
  if (op === 'native-reader-inactive') {
    if (app.workspace.activeLeaf === leaf()) throw Error('Expected inactive native diagnostic control');
    await view().displayReaderView(); return { label: 'DIAGNOSTIC direct real native displayReaderView while inactive; not user-UI acceptance' };
  }
  if (op === 'getter-B') {
    const v = view(), expected = fixtureURL(url);
    if (new URL(url).pathname !== '/article-b' || v.webview.getURL() !== expected) throw Error('Getter diagnostic scoped to fixture B');
    const result = await v.getReaderModeContent();
    return { scope: 'Actual existing native getter, not Save to vault', mdType: typeof result?.md, mdLength: result?.md?.length,
      mdSample: result?.md?.slice(0, 120), titleType: typeof result?.title, titleLength: result?.title?.length, title: result?.title };
  }
  if (op === 'guest-B') {
    const v = view(), w = v.webview, expected = fixtureURL(url);
    if (new URL(expected).pathname !== '/article-b' || w.getURL() !== expected) throw Error('Guest diagnostic only exact local B');
    const result = await w.executeJavaScript(`(() => { if(location.href !== ${JSON.stringify(expected)} || location.origin !== ${JSON.stringify(c.origin)}) throw Error('Guest identity changed'); return {href:location.href,title:document.title,ready:document.readyState,text:document.body.textContent.slice(0,200)}; })()`);
    if (v.webview !== w || w.getURL() !== expected || app.vault.adapter.getBasePath() !== c.ownerVault) throw Error('Parent/guest changed'); return result;
  }
  if (op === 'renderer-resize') {
    // Core1.14.4 Lj.onResize source inspected: reads current width/height, queues render if width differs.
    const r = view().renderer; if (!r || typeof r.onResize !== 'function') throw Error('Inspected native renderer method unavailable');
    r.onResize(); return { label: 'DIAGNOSTIC ONLY: existing native renderer.onResize; not production workaround/acceptance' };
  }
  if (op === 'close') { leaf().detach(); delete c.leaves[id]; delete c.views[id]; return true; }
  if (op === 'load') {
    await app.plugins.loadManifests(); await app.plugins.loadPlugin('quiet-car');
    const p = app.plugins.plugins['quiet-car'];
    if (p?.coreVersion !== '1.14.4' || !p.bridge?.refreshFactories() || p.preferences.state.enabled !== true) throw Error('Candidate/version/factory/preference precondition failed');
    return { importedApiVersion: p.coreVersion };
  }
  if (op === 'unload') { await app.plugins.unloadPlugin('quiet-car'); return true; }
  if (op === 'trace') return { events: c.trace, dropped: c.traceDropped ?? 0 };
  if (op === 'cleanup') {
    await app.plugins.unloadPlugin('quiet-car');
    for (const l of Object.values(c.leaves)) l.detach();
    for (const restore of c.undo.reverse()) restore();
    const clean = { factoryRestored: app.viewRegistry.viewByType.webviewer === c.originalFactory, errors: c.errors };
    delete window[key]; return clean;
  }
  throw Error('Unknown diagnostic action');
}
