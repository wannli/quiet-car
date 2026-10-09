// Transparent instance-only observers, installed via native constructor delegation before candidate.
export function diagnosticInstrument({ token }) {
  const c = window.__quietCarDiagnostic;
  if (!c || c.token !== token || c.instrumented || app.plugins.plugins['quiet-car']) throw Error('Diagnostic hook ownership/preload guard');
  const core = app.internalPlugins.getPluginById('webviewer'), slots = app.viewRegistry.viewByType, nativeFactory = c.originalFactory;
  if (core.views.webviewer !== nativeFactory || slots.webviewer !== nativeFactory) throw Error('Unexpected native factories');
  const mark = (type, data = {}) => { if (c.trace.length < 1200) c.trace.push({ seq: c.trace.length, at: performance.now(), type, ...data }); else c.traceDropped = (c.traceDropped ?? 0) + 1; };
  const patch = (object, name, wrapper) => {
    const previous = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, { value: wrapper, configurable: true, writable: true });
    c.undo.push(() => { if (object[name] !== wrapper) throw Error('Diagnostic override lost ownership: ' + name);
      if (previous) Object.defineProperty(object, name, previous); else delete object[name]; });
  };
  let viewSerial = 0, rendererSerial = 0, requestSerial = 0;
  const factory = function (...args) {
    const v = nativeFactory.apply(this, args), viewId = ++viewSerial;
    const state = r => ({ textLength: r.text?.length, lastTextLength: r.lastText?.length ?? null, sections: r.sections?.length,
      queued: !!r.queued, parsing: r.parsing, renderedWidth: r.renderedWidth, offsetWidth: r.previewEl?.offsetWidth,
      offsetParent: !!r.previewEl?.offsetParent, readerTextLength: v.readerView?.textContent.length });
    const seen = new WeakSet();
    const observeRenderer = r => {
      if (!r || seen.has(r)) return; seen.add(r); const rendererId = ++rendererSerial;
      for (const name of ['clear', 'set', 'queueRender', 'onRender', 'parseSync', 'parseAsync', 'onResize']) {
        const original = r[name]; if (typeof original !== 'function') throw Error('Inspected renderer method missing: ' + name);
        patch(r, name, function (...args) {
          mark('renderer-' + name + '-enter', { viewId, rendererId, inputTextLength: name === 'set' ? args[0]?.length : undefined, ...state(r) });
          const result = original.apply(this, args);
          mark('renderer-' + name + '-exit', { viewId, rendererId, ...state(r) }); return result;
        });
      }
    };
    // Observe actual native assignments to this INSTANCE field; never substitute a renderer/value.
    const descriptor = Object.getOwnPropertyDescriptor(v, 'renderer');
    if (descriptor && (!('value' in descriptor) || !descriptor.configurable)) throw Error('Unknown renderer property shape');
    let renderer = v.renderer, assigned = !!descriptor;
    const get = () => renderer, set = value => { renderer = value; assigned = true; mark('native-renderer-assigned', { viewId, present: !!value }); observeRenderer(value); };
    Object.defineProperty(v, 'renderer', { configurable: true, enumerable: descriptor?.enumerable ?? true, get, set });
    c.undo.push(() => {
      const now = Object.getOwnPropertyDescriptor(v, 'renderer'); if (now?.get !== get || now?.set !== set) throw Error('Renderer observation lost ownership');
      if (assigned) Object.defineProperty(v, 'renderer', { ...(descriptor ?? { configurable: true, enumerable: true, writable: true }), value: renderer });
      else delete v.renderer;
    });
    let currentRequest;
    const getter = v.getReaderModeContent;
    patch(v, 'getReaderModeContent', function (...args) {
      const request = currentRequest, url = v.webview?.getURL(), p = getter.apply(this, args);
      mark('native-getter-start', { viewId, request, url });
      p.then(content => {
        const isB = typeof url === 'string' && new URL(url).origin === c.origin && new URL(url).pathname === '/article-b';
        mark('native-getter-settled', { viewId, request, url, content: !!content, ...(isB ? {
          mdType: typeof content?.md, mdLength: content?.md?.length, mdSample: content?.md?.slice(0, 100),
          titleType: typeof content?.title, titleLength: content?.title?.length } : {}) });
      }, error => mark('native-getter-error', { viewId, request, error: String(error) }));
      return p;
    });
    const display = v.displayReaderView;
    patch(v, 'displayReaderView', function (...args) {
      const request = ++requestSerial; currentRequest = request;
      mark('native-display-start', { viewId, request, mode: v.mode, active: app.workspace.activeLeaf === v.leaf });
      let p; try { p = display.apply(this, args); } finally { currentRequest = undefined; }
      p.then(() => mark('native-display-settled', { viewId, request, mode: v.mode }), error => mark('native-display-error', { viewId, request, error: String(error) }));
      return p;
    });
    const original = v.displayWebView;
    patch(v, 'displayWebView', function (...args) { mark('native-original', { viewId, mode: v.mode }); return original.apply(this, args); });
    const onOpen = v.onOpen;
    patch(v, 'onOpen', function (...args) {
      const result = onOpen.apply(this, args);
      for (const name of ['show', 'hide']) {
        const fn = v.readerView[name];
        patch(v.readerView, name, function (...args) { mark('native-reader-' + name, { viewId, mode: v.mode }); return fn.apply(this, args); });
      }
      return result;
    });
    return v;
  };
  patch(core.views, 'webviewer', factory); patch(slots, 'webviewer', factory);
  c.instrumented = true; return { mode: 'Transparent diagnostic native factory/getter/render assignment/instance observers; not acceptance', nativeConstructorDelegated: true };
}
