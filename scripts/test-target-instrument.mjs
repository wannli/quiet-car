// Test-only native factory decoration BEFORE candidate load. Every native function delegates.
export function targetedAction({ op, id, token }) {
  const key = '__awrTargetedNative', base = window.__autoWebReaderNativeSmoke;
  if (!base || base.token !== token) throw Error('Verified base harness required');
  if (op === 'install') {
    if (window[key] || app.plugins.plugins['auto-web-reader']) throw Error('Must install before candidate');
    const core = app.internalPlugins.getPluginById('webviewer'), registry = app.viewRegistry.viewByType;
    const original = core.views.webviewer;
    if (registry.webviewer !== original) throw Error('Native factories differ');
    const c = { token, trace: [], views: [], restore: [], serial: 0, holdNext: false, held: null, gapView: null, gapMode: null };
    const mark = (type, details = {}) => c.trace.push({ seq: c.trace.length, type, ...details });
    function patch(object, name, value) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      Object.defineProperty(object, name, { configurable: true, writable: true, value });
      c.restore.push(() => {
        if (object[name] !== value) throw Error('Test override lost ownership: ' + name);
        if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name];
      });
    }
    const factory = function (...args) {
      const view = original.apply(this, args); c.views.push(view);
      const nativeGetter = view.getReaderModeContent, nativeDisplay = view.displayReaderView, nativeOriginal = view.displayWebView, nativeOpen = view.onOpen;
      let currentDisplay;
      patch(view, 'getReaderModeContent', function (...args) {
        // Actual existing session.entry is set by request() before this native getter entry.
        // current(request) was inspected: ownership/generation/readiness reads only; no dispatch or mutation.
        const session = c.gapView === view ? app.plugins.plugins['auto-web-reader']?.bridge?.getSession(view) : null;
        const actualRequest = session?.entry, experiment = c.gapView === view ? c.gapMode : null;
        const currentRead = () => {
          if (!session || !actualRequest || typeof session.current !== 'function') return { accessible: false };
          try { return { accessible: true, current: session.current(actualRequest), kind: actualRequest.kind,
            requestRevision: actualRequest.revision, sessionRevision: session.revision, mode: view.mode }; }
          catch (error) { return { accessible: false, error: String(error) }; }
        };
        const request = currentDisplay, raw = nativeGetter.apply(this, args);
        mark('native-getter-start', { request, experiment });
        const rawThen = raw.then;
        // Observe settlement via the intrinsic method, not the decorated delivery chain.
        rawThen.call(raw, content => mark('native-getter-settled', { request, content: !!content }),
          error => mark('native-getter-rejected', { request, error: String(error) }));
        if (c.gapView === view) {
          patch(raw, 'then', function (fulfilled, rejected) {
            const child = rawThen.call(this, fulfilled, rejected);
            // Actual native-session getter creates delivery with then(undefined, onReject).
            if (fulfilled === undefined && typeof rejected === 'function') {
              const childThen = child.then;
              patch(child, 'then', function (prepare, reject) {
                if (typeof prepare !== 'function' || reject !== undefined) return childThen.call(this, prepare, reject);
                return childThen.call(this, function (content) {
                  const result = prepare(content); // Actual native-gate raw-result preparation.
                  if (c.gapView === view && content?.md && result === undefined) {
                    c.gapView = null; c.gapMode = null;
                    mark('result-prepared', { request, experiment, bodyMarker: content.md.slice(0, 100), eligibility: currentRead() });
                    // Matched positive control has the identical Promise/factory hooks but no Original injection.
                    if (experiment === 'original') queueMicrotask(() => {
                      mark('before-native-original', { request, mode: view.mode, eligibility: currentRead() });
                      view.readerModeToggleBtn.click(); // Existing native UI, through guarded callback.
                      mark('manual-original', { request, mode: view.mode, eligibility: currentRead() });
                    });
                  } else mark('unproven-preparation', { request, content: !!content, resultUndefined: result === undefined });
                  return result;
                }, reject);
              });
            }
            return child;
          });
        }
        return raw; // Preserve actual native Promise and its realm.
      });
      patch(view, 'displayReaderView', function (...args) {
        const request = ++c.serial; currentDisplay = request;
        mark('native-display-start', { request });
        let result;
        try { result = nativeDisplay.apply(this, args); } finally { currentDisplay = undefined; }
        result.then(() => mark('native-display-settled', { request, mode: view.mode }),
          error => mark('native-display-rejected', { request, error: String(error) }));
        return result;
      });
      patch(view, 'displayWebView', function (...args) {
        mark('native-original-call', { mode: view.mode }); return nativeOriginal.apply(this, args);
      });
      patch(view, 'onOpen', function (...args) {
        const result = nativeOpen.apply(this, args);
        if (!view.readerView) throw Error('Native onOpen did not synchronously construct Reader element');
        const show = view.readerView.show, hide = view.readerView.hide;
        patch(view.readerView, 'hide', function (...args) {
          mark('native-reader-hide', { mode: view.mode }); return hide.apply(this, args);
        });
        patch(view.readerView, 'show', function (...args) {
          mark('native-reader-show', { mode: view.mode }); return show.apply(this, args);
        });
        return result;
      });
      return view;
    };
    patch(core.views, 'webviewer', factory); patch(registry, 'webviewer', factory);
    const originalFetch = window.fetch;
    patch(window, 'fetch', function (...args) {
      const address = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (c.holdNext && address === '/lib/readability.js') {
        c.holdNext = false;
        const request = c.serial;
        mark('asset-held', { request });
        return new Promise(resolve => { c.held = () => {
          mark('asset-release-503', { request });
          resolve(new Response('', { status: 503, statusText: 'Injected test-only asset failure' }));
        }; });
      }
      return originalFetch.apply(this, args);
    });
    window[key] = c; return { installed: true, factoryDelegatesNativeConstructor: true };
  }
  const c = window[key];
  if (!c || c.token !== token) throw Error('Target instrumentation ownership mismatch');
  if (op === 'hold-one-503') { if (c.held || c.holdNext) throw Error('Prior asset hold exists'); c.holdNext = true; return true; }
  if (op === 'release-503') { if (!c.held) throw Error('No held native request'); c.held(); c.held = null; return true; }
  if (op === 'arm-gap' || op === 'arm-control') {
    c.gapView = base.views[id]; if (!c.gapView) throw Error('Unknown view');
    c.gapMode = op === 'arm-control' ? 'control' : 'original'; return true;
  }
  if (op === 'mark-c-success') {
    const entry = { seq: c.trace.length, type: 'reader-c-success' }; c.trace.push(entry); return entry;
  }
  if (op === 'trace') return c.trace;
  if (op === 'restore') {
    if (app.plugins.plugins['auto-web-reader']) throw Error('Unload candidate before test override restoration');
    c.gapView = null; c.gapMode = null; c.holdNext = false;
    if (c.held) { c.held(); c.held = null; }
    for (const restore of c.restore.reverse()) restore();
    delete window[key]; return true;
  }
  throw Error('Unknown targeted operation');
}
