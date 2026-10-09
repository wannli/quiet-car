// Serialized into the VERIFIED renderer only. No production hooks or guest extractor.
export async function nativeAction({ op, id, url, value, token }) {
  const key = '__quietCarNativeSmoke';
  const pluginId = 'quiet-car';
  if (op === 'init') {
    if (window[key]) throw Error('Test harness already exists');
    const fixture = new URL(url);
    if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port || fixture.origin !== url) throw Error('Exact loopback fixture origin required');
    if (!app.internalPlugins.getPluginById('webviewer')?.enabled) throw Error('Manually enable core Web Viewer in this sandbox first');
    if (!app.plugins.isEnabled()) throw Error('Manually enable community plugins in this sandbox first');
    if (app.plugins.plugins[pluginId]) throw Error('Start smoke with candidate unloaded; refusing to unload an unknown test session');
    const ctx = { token, fixtureOrigin: fixture.origin, ownerVault: app.vault.adapter.getBasePath(), leaves: {}, views: {}, webviews: {}, methods: {}, windows: [], errors: [], events: [], notices: [], count: 0, held: [], blocking: false, releases: [], savePending: [], cleanup: [], originalFactory: app.viewRegistry.viewByType.webviewer };
    ctx.track = win => {
      if (ctx.windows.includes(win)) return;
      ctx.windows.push(win);
      const original = win.fetch;
      const wrapper = function (...args) {
        const address = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (address !== '/lib/readability.js') return original.apply(this, args);
        ctx.count++;
        if (!ctx.blocking) return original.apply(this, args);
        const receiver = this;
        return new Promise(resolve => ctx.held.push(() => resolve(original.apply(receiver, args))));
      };
      win.fetch = wrapper;
      const error = e => ctx.errors.push({ type: e.type, message: String(e.reason?.stack ?? e.reason ?? e.message) });
      win.addEventListener('error', error); win.addEventListener('unhandledrejection', error);
      ctx.cleanup.push(() => {
        if (win.closed) return;
        if (win.fetch === wrapper) win.fetch = original;
        else throw Error('Fetch changed ownership; not overwriting');
        win.removeEventListener('error', error); win.removeEventListener('unhandledrejection', error);
      });
    };
    const notices = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches?.('.notice') || node.querySelector?.('.notice'))) ctx.notices.push(node.textContent.slice(0, 500));
      }
    });
    notices.observe(document.body, { childList: true, subtree: true }); ctx.cleanup.push(() => notices.disconnect());
    ctx.track(window); window[key] = ctx; return true;
  }
  const c = window[key];
  if (!c || c.token !== token) throw Error('Test context ownership mismatch');
  const plugin = () => app.plugins.plugins[pluginId];
  const leaf = () => { const l = c.leaves[id]; if (!l) throw Error('Unknown owned test leaf'); return l; };
  const view = () => { leaf(); return c.views[id]; };
  const shown = el => !!el && el.ownerDocument.defaultView.getComputedStyle(el).display !== 'none';
  if (op === 'load') {
    await app.plugins.loadManifests(); await app.plugins.loadPlugin(pluginId);
    if (plugin()?.coreVersion !== '1.14.4') throw Error('Loaded host imported apiVersion corroboration failed');
    if (!plugin()?.bridge?.refreshFactories()) throw Error('Factory bridge unavailable');
    return { importedApiVersion: plugin().coreVersion, factoryChanged: app.viewRegistry.viewByType.webviewer !== c.originalFactory,
      factoriesEqual: app.viewRegistry.viewByType.webviewer === app.internalPlugins.getPluginById('webviewer').views.webviewer };
  }
  if (op === 'create') {
    if (c.leaves[id]) throw Error('Duplicate leaf id');
    const l = value === 'popout' ? app.workspace.openPopoutLeaf() : app.workspace.getLeaf('tab');
    c.leaves[id] = l;
    await l.setViewState({ type: 'webviewer', active: true, state: { url, navigate: value !== 'restored', ...(value === 'restored' ? { mode: 'reader' } : {}) } });
    c.views[id] = l.view; c.webviews[id] = l.view.webview;
    c.methods[id] = Object.fromEntries(['toggleReaderMode', 'getReaderModeContent', 'displayReaderView', 'displayWebView', 'onResize'].map(name => [name, l.view[name]]));
    c.track(l.view.containerEl.ownerDocument.defaultView);
    const w = l.view.webview;
    for (const name of ['did-start-navigation', 'did-navigate', 'dom-ready', 'did-navigate-in-page', 'did-fail-load', 'did-fail-provisional-load', 'did-stop-loading', 'destroyed']) {
      const listener = e => { if (c.events.length < 1000) c.events.push({ id, type: name, url: e.url, main: e.isMainFrame, errorCode: e.errorCode, at: Date.now() }); };
      w.addEventListener(name, listener); c.cleanup.push(() => w.removeEventListener(name, listener));
    }
    return { managed: !!plugin()?.bridge?.getSession(l.view), leaf: l.id };
  }
  if (op === 'snapshot') {
    const v = view(), session = plugin()?.bridge?.getSession(v);
    let currentUrl; try { currentUrl = v.webview?.getURL(); } catch { currentUrl = null; }
    return { leafId: leaf().id, sameView: leaf().view === v, sameWebview: v.webview === c.webviews[id],
      methodsUnchanged: Object.entries(c.methods[id]).every(([name, method]) => v[name] === method), mode: v.mode, managed: !!session, pending: !!session?.pending, extracting: !!session?.extraction, url: currentUrl, nativeUrl: v.url,
      originalShown: shown(v.webview), readerShown: shown(v.readerView), readerText: v.readerView?.textContent?.slice(0, 500),
      active: app.workspace.activeLeaf === leaf(), activeLeafId: app.workspace.activeLeaf?.id, connected: v.containerEl.isConnected,
      viewWidth: v.containerEl.offsetWidth, viewHeight: v.containerEl.offsetHeight,
      realm: v.containerEl.ownerDocument.defaultView === window ? 'main' : 'popout',
      renderer: v.renderer ? { textLength: v.renderer.text?.length, textSample: v.renderer.text?.slice(0, 120), lastTextLength: v.renderer.lastText?.length ?? null,
        sections: v.renderer.sections?.length, renderedSections: v.renderer.sections?.filter(s => s.rendered).length,
        computedSections: v.renderer.sections?.filter(s => s.computed).length, queued: !!v.renderer.queued, parsing: v.renderer.parsing,
        renderedWidth: v.renderer.renderedWidth, viewportHeight: v.renderer.viewportHeight,
        previewWidth: v.renderer.previewEl?.offsetWidth, previewHeight: v.renderer.previewEl?.offsetHeight,
        previewConnected: v.renderer.previewEl?.isConnected, previewOwned: !!v.renderer.previewEl && v.readerView.contains(v.renderer.previewEl) } : null,
      requests: c.count, held: c.held.length, errors: c.errors.slice(), events: c.events.filter(e => e.id === id).slice(-20) };
  }
  if (op === 'guest-snapshot') {
    const expected = new URL(url), v = view(), webview = v.webview;
    if (expected.origin !== c.fixtureOrigin || !['/article-a', '/article-b', '/article-c', '/empty', '/nonarticle'].includes(expected.pathname)) throw Error('Guest outside known local fixture paths');
    if (leaf().view !== v || !app.workspace.getLeavesOfType('webviewer').includes(leaf()) || webview.getURL() !== url) throw Error('Guest view/URL identity mismatch');
    // Read-only guest DOM; no mutations, navigation, extraction, or injected library.
    const guest = await webview.executeJavaScript(`(() => {
      if (location.origin !== ${JSON.stringify(c.fixtureOrigin)} || location.href !== ${JSON.stringify(url)}) throw Error('Guest fixture identity changed');
      return { href: location.href, title: document.title, bodyText: document.body?.textContent ?? null, readyState: document.readyState };
    })()`);
    if (app.vault.adapter.getBasePath() !== c.ownerVault || leaf().view !== v || v.webview !== webview || webview.getURL() !== url) throw Error('Parent/guest identity changed during read');
    return guest;
  }
  if (op === 'select-tab') {
    const header = leaf().tabHeaderEl;
    if (!header?.isConnected) throw Error('Native tab header unavailable');
    header.click(); // Core workspace-tab-header delegated click selects/focuses the leaf.
    return { active: app.workspace.activeLeaf === leaf() };
  }
  if (op === 'toggle') {
    const v = view(), button = v.readerModeToggleBtn;
    if (!button?.isConnected || !button.querySelector('svg')) throw Error('Native glasses UI missing');
    button.click(); return true;
  }
  if (op === 'navigate') { view().navigate(url, true); return true; }
  if (op === 'reload') { view().webview.reload(); return true; }
  if (op === 'replace-webview') { view().instantiateWebView(); return true; }
  if (op === 'core-disable' || op === 'core-enable') {
    if (app.workspace.getLeavesOfType('webviewer').some(l => !Object.values(c.leaves).includes(l))) throw Error('Refusing core cycle with an unowned Web Viewer leaf');
    const core = app.internalPlugins.getPluginById('webviewer');
    if (op === 'core-disable') core.disable(true); else await core.enable(true);
    return { enabled: core.enabled, hasRegisteredFactory: typeof app.viewRegistry.viewByType.webviewer === 'function' };
  }
  if (op === 'stop') { view().webview.stop(); return true; }
  if (op === 'republish-off') { await plugin().preferences.setEnabled(false); return plugin().preferences.state; }
  if (op === 'back' || op === 'forward') {
    const w = view().webview;
    if (!(op === 'back' ? w.canGoBack() : w.canGoForward())) throw Error('Native history unavailable');
    if (op === 'back') w.goBack(); else w.goForward(); return true;
  }
  if (op === 'anchor') { await view().webview.executeJavaScript('location.hash = "ending"'); return true; }
  if (op === 'spa') { await view().webview.executeJavaScript('history.pushState({}, "", "?synthetic-route=1")'); return true; }
  if (op === 'focus') { leaf().tabHeaderEl.click(); app.workspace.requestSaveLayout(); return true; }
  if (op === 'hold') { if (c.held.length) throw Error('Prior timing injection still pending'); c.blocking = true; return true; }
  if (op === 'release') { c.blocking = false; for (const release of c.held.splice(0)) release(); return true; }
  if (op === 'setting-open') {
    app.setting.open(); app.setting.openTabById(pluginId);
    if (!plugin()?.settingsTab?.containerEl?.isConnected) throw Error('Actual settings tab not open');
    return true;
  }
  if (op === 'setting' || op === 'setting-state') {
    const p = plugin(), el = p.settingsTab?.containerEl.querySelector('.checkbox-container');
    if (!el?.isConnected || !shown(el)) throw Error('Actual native Setting toggle not visible');
    if (op === 'setting' && el.classList.contains('is-enabled') !== value) el.click();
    const description = p.settingsTab.containerEl.querySelector('.setting-item-description');
    return { visibleOn: el.classList.contains('is-enabled'), ...p.preferences.state,
      description: description?.textContent, descriptionVisible: !!description?.getClientRects().length && shown(description) };
  }
  if (op === 'setting-close') { app.setting.close(); return true; }
  if (op === 'save-hold') {
    const p = plugin(), original = p.saveData;
    const wrapper = function (...args) {
      const pending = new Promise((resolve, reject) => c.releases.push(() => Promise.resolve(original.apply(this, args)).then(resolve, reject)));
      c.savePending.push(pending); return pending;
    };
    p.saveData = wrapper;
    c.restoreSave = () => { if (p.saveData === wrapper) p.saveData = original; else if (p.saveData !== original) throw Error('saveData ownership changed'); };
    c.cleanup.push(c.restoreSave);
    return true;
  }
  if (op === 'save-release') { for (const release of c.releases.splice(0)) release(); return true; }
  if (op === 'save-unhold') { c.restoreSave?.(); for (const release of c.releases.splice(0)) release(); return true; }
  if (op === 'close') { leaf().detach(); return true; }
  if (op === 'unload') {
    await app.plugins.unloadPlugin(pluginId);
    return { factoryRestored: app.viewRegistry.viewByType.webviewer === c.originalFactory };
  }
  if (op === 'summary') return { requests: c.count, errors: c.errors, events: c.events, notices: c.notices, held: c.held.length, savesHeld: c.releases.length };
  if (op === 'cleanup') {
    c.blocking = false;
    // Invalidate production requests before releasing controlled native work.
    if (plugin()) await app.plugins.unloadPlugin(pluginId);
    if (!app.internalPlugins.getPluginById('webviewer').enabled) await app.internalPlugins.getPluginById('webviewer').enable(true);
    for (const fn of c.cleanup.reverse()) { try { fn(); } catch (e) { c.errors.push({ cleanup: String(e) }); } }
    for (const release of c.held.splice(0)) release();
    for (const release of c.releases.splice(0)) release();
    await Promise.allSettled(c.savePending);
    for (const l of Object.values(c.leaves)) if (l.parent) l.detach();
    app.setting.close();
    const errors = c.errors; delete window[key]; return errors;
  }
  throw Error('Unknown test operation: ' + op);
}
