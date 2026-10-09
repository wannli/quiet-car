import assert from "node:assert/strict";
import test from "node:test";
import { installNativeReaderBridge, supportsCoreVersion, type NativeReaderBridge } from "../src/native-adapter.js";
import type { NativeContent, NativeNavigationEvent } from "../src/native-types.js";

const article: NativeContent = { md: "Article A", title: "A" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The inspected core y() semantics, including catching native continuation
 * errors. Deliberately NOT async/await, whose promise adoption is different. */
function nativeAwait<T>(body: () => Generator<Promise<NativeContent | undefined>, T, NativeContent | undefined>): Promise<T> {
  return new Promise((resolve, reject) => {
    const generator = body();
    function fulfilled(value: NativeContent | undefined) {
      try { step(generator.next(value)); } catch (error) { reject(error); }
    }
    function rejected(error: unknown) {
      try { step(generator.throw(error)); } catch (failure) { reject(failure); }
    }
    function step(result: IteratorResult<Promise<NativeContent | undefined>, T>) {
      if (result.done) resolve(result.value);
      else (result.value instanceof Promise ? result.value : Promise.resolve(result.value)).then(fulfilled, rejected);
    }
    step(generator.next());
  });
}
class WebView {
  loading = false;
  loadingAtDomReady = false;
  url = "about:blank";
  isLoadingMainFrame() { return this.loading; }
  getURL() { return this.url; }
  private listeners = new Map<string, Set<(event: NativeNavigationEvent) => void>>();
  addEventListener(name: string, fn: (event: NativeNavigationEvent) => void) {
    const list = this.listeners.get(name) ?? new Set();
    list.add(fn); this.listeners.set(name, list);
  }
  removeEventListener(name: string, fn: (event: NativeNavigationEvent) => void) { this.listeners.get(name)?.delete(fn); }
  emit(name: string, event: NativeNavigationEvent = {}) {
    if (name === "did-start-navigation" && event.isMainFrame && !event.isInPlace) this.loading = true;
    if (name === "did-navigate" && event.url) { this.url = event.url; this.loading = true; }
    if (name === "did-navigate-in-page" && event.isMainFrame && event.url) this.url = event.url;
    if (name === "dom-ready") this.loading = this.loadingAtDomReady;
    // Failure/stop events deliberately do NOT alter current guest state. A late
    // event from an older navigation can arrive while a newer one is loading.
    for (const fn of [...this.listeners.get(name) ?? []]) fn(event);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
class View {
  mode = "blank";
  webview?: WebView;
  renderer?: unknown;
  resizeCalls = 0;
  resizeArgs: unknown[] = [];
  resizeHook?: (...args: unknown[]) => unknown;
  boundToggle!: () => void;
  readonly boundCommit: () => void;
  source = deferred<NativeContent | undefined>();
  calls = 0;
  saves = 0;
  writes = 0;
  originals = 0;
  closed = 0;
  unloads = 0;
  navigations = 0;
  readonly displays: Promise<void>[] = [];
  readonly trace: string[] = [];
  onYield?: (promise: Promise<NativeContent | undefined>) => void;
  duringRender?: () => void;
  getterArgs: unknown[] = [];
  displayArgs: unknown[] = [];
  constructor(readonly leaf: unknown) { this.boundCommit = this.commitPageLoad.bind(this); }
  getViewType() { return "webviewer"; }
  onResize(...args: unknown[]): unknown {
    this.resizeCalls++; this.resizeArgs = args; return this.resizeHook?.(...args);
  }
  onOpen() { this.instantiateWebView(); this.boundToggle = this.toggleReaderMode.bind(this); }
  instantiateWebView() { this.webview = new WebView(); }
  getReaderModeContent(...args: unknown[]): Promise<NativeContent | undefined> {
    this.calls++; this.getterArgs = args; return this.source.promise;
  }
  displayReaderView(...args: unknown[]): Promise<void> {
    this.displayArgs = args;
    const view = this;
    const result = nativeAwait(function* () {
      const yielded = view.getReaderModeContent();
      view.onYield?.(yielded);
      const content = yield yielded;
      if (!content) return;
      view.trace.push("commit-start");
      view.duringRender?.();
      view.writes++;
      view.mode = "reader";
      view.trace.push("commit-end");
    });
    this.displays.push(result);
    return result;
  }
  displayWebView() { this.originals++; this.mode = "webview"; this.renderer = null; this.trace.push("original"); }
  toggleReaderMode() { if (this.mode === "reader") this.displayWebView(); else void this.displayReaderView(); }
  commitPageLoad() { if (this.mode === "reader") void this.displayReaderView(); }
  displayErrorView() { this.mode = "error"; }
  displayBlank() { this.mode = "blank"; }
  navigate(..._args: unknown[]) { this.navigations++; this.trace.push("navigate"); }
  close(): Promise<void> { this.closed++; this.unload(); return Promise.resolve(); }
  unload() { this.unloads++; }
  saveAsMarkdown(...args: unknown[]) { this.saves++; return this.getReaderModeContent(...args); }
}
function host(enabled = true, prepare: (view: View) => void = () => {}) {
  const creator = function (this: unknown, leaf: unknown) {
    const view = new View(leaf); prepare(view); return view;
  };
  const core = { enabled: true, views: { webviewer: creator } };
  const registry: { webviewer?: typeof creator } = { webviewer: creator };
  const app = { internalPlugins: { getPluginById(id: string) { assert.equal(id, "webviewer"); return core; } },
    viewRegistry: { viewByType: registry } };
  const existing = creator("old"); existing.onOpen();
  const bridge = installNativeReaderBridge(app, "1.14.4", enabled)!;
  assert.ok(bridge);
  function create() { const view = registry.webviewer!("leaf"); view.onOpen(); return view; }
  return { app, core, registry, creator, bridge, create, existing };
}
function visit(view: View, url = "https://test.example/a") {
  view.webview!.emit("did-start-navigation", { isMainFrame: true, isInPlace: false, url });
  view.webview!.emit("did-navigate", { url });
  if (view.mode === "blank" || view.mode === "error") view.displayWebView();
  view.webview!.emit("dom-ready");
}
async function complete(view: View, result: NativeContent | undefined = article) {
  view.source.resolve(result);
  await Promise.all(view.displays);
}
function session(bridge: NativeReaderBridge, view: View) { const value = bridge.getSession(view); assert.ok(value); return value; }

test("exact version and factory shape/identity gates leave unknown hosts untouched", () => {
  assert.equal(supportsCoreVersion("1.14.4"), true);
  for (const version of ["1.14.3", "1.14.4-beta", "1.14.40", ""]) {
    assert.equal(installNativeReaderBridge({}, version, true), null);
  }
  assert.equal(installNativeReaderBridge({}, "1.14.4", true), null);
  const h = host(); h.bridge.dispose();
  h.registry.webviewer = () => new View("different");
  const other = h.registry.webviewer;
  assert.equal(installNativeReaderBridge(h.app, "1.14.4", true), null);
  assert.equal(h.registry.webviewer, other);
});

test("factory guards precede onOpen; existing views never attach or mutate", async () => {
  const h = host();
  const original = h.existing.getReaderModeContent;
  assert.equal(h.bridge.getSession(h.existing), null);
  h.bridge.setEnabled(false); h.bridge.refreshFactories();
  assert.equal(h.existing.getReaderModeContent, original);
  const view = h.registry.webviewer!("new");
  assert.ok(h.bridge.getSession(view));
  assert.equal(view.webview, undefined);
  assert.notEqual(view.toggleReaderMode, View.prototype.toggleReaderMode);
  view.onOpen(); visit(view);
  assert.equal(view.calls, 0);
  view.boundToggle();
  await complete(view);
  assert.equal(view.mode, "reader", "manual toolbar reader works while automation OFF");
  view.toggleReaderMode();
  assert.equal(view.mode, "webview", "command and prebound toolbar share intent guards");
});

test("native extraction/display once per visit; anchors/layout/original mode do not reload", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  assert.equal(view.writes, 1); assert.equal(view.calls, 1);
  view.webview!.emit("did-navigate-in-page", { isMainFrame: true, url: "https://test.example/a#anchor" });
  session(h.bridge, view).refreshBinding();
  view.boundToggle();
  assert.equal(view.mode, "webview"); assert.equal(view.navigations, 0);
  view.webview!.emit("dom-ready");
  assert.equal(view.calls, 1);
  visit(view); await complete(view);
  assert.equal(view.writes, 2, "same-URL document reload is a fresh visit");
});

for (const action of ["manual-off", "navigation", "dispose", "close", "unload"] as const) {
  for (const gap of [false, true]) {
    test(`${action} cancels managed native refresh during ${gap ? "delivery microtask gap" : "extraction"}`, async () => {
      const h = host(); const view = h.create(); visit(view); await complete(view);
      view.source = deferred();
      visit(view, "https://test.example/next");
      const invalidate = () => {
        switch (action) {
          case "manual-off": view.boundToggle(); break;
          case "navigation": view.webview!.emit("did-start-navigation", { isMainFrame: true, isInPlace: false }); break;
          case "dispose": h.bridge.dispose(); break;
          case "close": void view.close(); break;
          case "unload": view.unload(); break;
        }
      };
      if (gap) view.onYield = (carrier) => {
        // Runs after carrier intrinsic fulfillment, BEFORE the native resume.
        void Promise.prototype.then.call(carrier, invalidate);
      };
      view.boundCommit();
      if (!gap) invalidate();
      await complete(view);
      assert.equal(view.writes, 1, "no old article committed after invalidation");
      if (action === "manual-off") assert.equal(view.mode, "webview");
    });
  }
}

test("manual Original chosen during pending navigation suppresses its committed document", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  view.source = deferred();
  view.webview!.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  view.boundToggle();
  h.bridge.setEnabled(false); h.bridge.setEnabled(false); h.bridge.setEnabled(true);
  view.webview!.emit("did-navigate", { url: "https://test.example/next" });
  view.webview!.emit("dom-ready");
  assert.equal(view.mode, "webview"); assert.equal(view.calls, 1);
  visit(view); await complete(view); assert.equal(view.writes, 2);
});

test("manual Reader during navigation is queued even OFF, and its second toggle cancels", async () => {
  for (const cancel of [false, true]) {
    const h = host(false); const view = h.create(); visit(view);
    view.webview!.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
    view.boundToggle();
    if (cancel) view.boundToggle();
    h.bridge.setEnabled(false); h.bridge.setEnabled(false); h.bridge.setEnabled(true);
    assert.equal(view.calls, 0, "never extract the old/loading document");
    view.webview!.emit("did-navigate", { url: "https://test.example/next" });
    view.webview!.emit("dom-ready");
    await complete(view);
    assert.equal(view.mode, cancel ? "webview" : "reader");
    assert.equal(view.calls, cancel ? 0 : 1);
  }
});

test("manual Reader pending toggles OFF; dedup extraction does not defeat latest intent", async () => {
  const h = host(false); const view = h.create(); visit(view);
  view.boundToggle();
  assert.equal(view.calls, 1);
  view.boundToggle();
  await complete(view);
  assert.equal(view.mode, "webview"); assert.equal(view.writes, 0);
  view.webview!.emit("dom-ready"); assert.equal(view.calls, 1);
});

test("explicit manual Reader supersedes pending auto, shares extraction, survives setting OFF", async () => {
  const h = host(); const view = h.create(); visit(view);
  h.bridge.setEnabled(false);
  view.toggleReaderMode();
  assert.equal(view.calls, 1);
  await complete(view);
  assert.equal(view.writes, 1); assert.equal(view.mode, "reader");
});

for (const enabled of [false, true]) {
  for (const gap of [false, true]) {
    test(`manual pending while ${enabled ? "ON" : "OFF"} survives repeated OFF during ${gap ? "delivery gap" : "extraction"}`, async () => {
      const h = host(false); const view = h.create(); visit(view);
      if (enabled) h.bridge.setEnabled(true); // Does not arm the current visit.
      const off = () => { h.bridge.setEnabled(false); h.bridge.setEnabled(false); };
      if (gap) view.onYield = (carrier) => { void Promise.prototype.then.call(carrier, off); };
      view.boundToggle();
      if (!gap) off();
      await complete(view);
      assert.equal(view.calls, 1); assert.equal(view.writes, 1); assert.equal(view.mode, "reader");
    });
  }
}

for (const outcome of ["readable", "unsupported", "rejection"] as const) {
  for (const gap of [false, true]) {
    test(`native refresh ${outcome} retains authority across OFF during ${gap ? "delivery gap" : "extraction"}`, async () => {
      const h = host(); const view = h.create(); visit(view); await complete(view);
      view.source = deferred(); visit(view, "https://test.example/b");
      const off = () => { h.bridge.setEnabled(false); h.bridge.setEnabled(false); };
      if (gap) view.onYield = (carrier) => { void Promise.prototype.then.call(carrier, off, off); };
      view.boundCommit();
      if (!gap) off();
      const display = view.displays.at(-1)!;
      if (outcome === "rejection") {
        view.source.reject(new Error("native refresh failed"));
        await assert.rejects(display, /native refresh failed/);
      } else {
        view.source.resolve(outcome === "readable" ? article : undefined);
        await display;
      }
      assert.equal(view.mode, outcome === "readable" ? "reader" : "webview");
      assert.equal(view.writes, outcome === "readable" ? 2 : 1);
      h.bridge.setEnabled(true);
      view.webview!.emit("dom-ready");
      assert.equal(view.calls, 2, "setting changes do not create automatic retries");
    });
  }
}

test("OFF/ON disarms current visit; setting updates undiscovered and future managed views", async () => {
  const h = host(); const view = h.create(); visit(view);
  h.bridge.setEnabled(false); h.bridge.setEnabled(true);
  await complete(view); assert.equal(view.writes, 0);
  view.webview!.emit("dom-ready"); assert.equal(view.calls, 1);
  visit(view); await complete(view); assert.equal(view.writes, 1);
  h.bridge.setEnabled(false);
  const future = h.create(); visit(future); assert.equal(future.calls, 0);
});

for (const failure of ["unsupported", "rejection"] as const) {
  test(`current native Reader refresh ${failure} falls back to new original page, without retry`, async () => {
    const h = host(); const view = h.create(); visit(view); await complete(view);
    view.source = deferred(); visit(view, "https://test.example/unsupported");
    view.boundCommit();
    const result = view.displays.at(-1)!;
    if (failure === "unsupported") view.source.resolve(undefined);
    else view.source.reject(new Error("native extraction failed"));
    if (failure === "rejection") await assert.rejects(result, /native extraction failed/);
    else await result;
    assert.equal(view.mode, "webview"); assert.equal(view.writes, 1);
    const calls = view.calls;
    view.webview!.emit("dom-ready"); session(h.bridge, view).refreshBinding();
    assert.equal(view.calls, calls, "unsupported does not retry this visit");
    visit(view); await complete(view).catch(() => {});
    assert.equal(view.calls, calls + 1, "fallback did not invent permanent manual suppression");
  });
}

test("stale unsupported native refresh cannot revert newer manual Reader", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  view.source = deferred(); visit(view, "https://test.example/b"); view.boundCommit();
  const older = view.source;
  view.boundToggle(); // Original
  // A new document, then explicit Reader: different native extraction identity.
  view.source = deferred(); visit(view, "https://test.example/c"); view.boundToggle();
  view.source.resolve(article);
  await view.displays.at(-1);
  assert.equal(view.mode, "reader");
  older.resolve(undefined);
  await Promise.all(view.displays);
  assert.equal(view.mode, "reader");
});

test("Save getter preserves native receiver, arguments, promise identity, and rejection", async () => {
  const h = host(false); const view = h.create(); visit(view);
  const foreign = new View("borrowed receiver");
  assert.equal(view.getReaderModeContent.call(foreign, "borrowed"), foreign.source.promise);
  assert.deepEqual(foreign.getterArgs, ["borrowed"]);
  const result = view.saveAsMarkdown("save", 7);
  assert.equal(result, view.source.promise);
  assert.deepEqual(view.getterArgs, ["save", 7]);
  view.source.reject(new Error("save failed"));
  await assert.rejects(result, /save failed/);
  assert.equal(view.saves, 1); assert.equal(view.writes, 0);
  view.source = deferred();
  const display = view.displayReaderView("native arg");
  assert.deepEqual(view.displayArgs, ["native arg"]);
  await complete(view); await display;
});

test("native continuation exception remains rejected, and is observed by adapter", async () => {
  const h = host(); const view = h.create();
  view.duringRender = () => { throw new Error("native renderer failure"); };
  visit(view); view.source.resolve(article);
  await assert.rejects(view.displays[0], /native renderer failure/);
});

test("native refresh requests deduplicate without depending on bound commit method wrapping", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  view.boundCommit();
  assert.equal(view.calls, 1, "late native commit does not repeat this document's automatic render");
  view.source = deferred();
  visit(view, "https://test.example/next");
  view.boundCommit(); view.boundCommit(); view.boundCommit();
  assert.equal(view.calls, 2);
  await complete(view); assert.equal(view.writes, 2);
});

test("redirects/subframes do not create attempts; failures and SPA changes fail closed", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  view.boundToggle();
  const events = view.webview!;
  events.emit("did-start-navigation", { isMainFrame: false });
  events.emit("did-fail-load", { isMainFrame: false });
  events.emit("did-navigate-in-page", { isMainFrame: true, url: "https://test.example/route?x=1" });
  events.emit("dom-ready"); assert.equal(view.calls, 1);
  events.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  events.emit("did-redirect-navigation", { isMainFrame: true });
  events.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
  events.emit("dom-ready"); assert.equal(view.calls, 1);
  visit(view); await complete(view); assert.equal(view.writes, 2);
});

test("SPA path/query ambiguity shows native original rather than stale Reader, without a new visit", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view);
  view.webview!.emit("did-navigate-in-page", { isMainFrame: true, url: "https://test.example/a#anchor" });
  assert.equal(view.mode, "reader");
  view.webview!.emit("did-navigate-in-page", { isMainFrame: true, url: "https://test.example/a?unknown=1" });
  assert.equal(view.mode, "webview");
  view.webview!.emit("dom-ready"); view.boundCommit();
  assert.equal(view.calls, 1);
  visit(view); await complete(view); assert.equal(view.calls, 2);
});

for (const enabled of [false, true]) {
  test(`SPA automation suspension leaves native toolbar/command reading usable while ${enabled ? "ON" : "OFF"}`, async () => {
    const h = host(); const view = h.create(); visit(view); await complete(view);
    h.bridge.setEnabled(enabled);
    view.source = deferred();
    view.webview!.emit("did-navigate-in-page", { isMainFrame: true, url: "https://test.example/spa?route=2" });
    assert.equal(view.mode, "webview"); assert.equal(view.calls, 1);
    // No dom-ready fiction: an in-page route does not emit document readiness.
    view.boundToggle(); await complete(view);
    assert.equal(view.mode, "reader"); assert.equal(view.calls, 2);
    view.toggleReaderMode();
    view.source = deferred(); view.toggleReaderMode(); await complete(view);
    assert.equal(view.mode, "reader"); assert.equal(view.calls, 3);
  });
}

for (const event of ["abort", "stop-only"] as const) {
  for (const queued of [false, true]) {
    test(`${event} on surviving document permits ${queued ? "queued" : "new"} native Reader without a new visit`, async () => {
      const h = host(false); const view = h.create(); visit(view);
      const guest = view.webview!;
      guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
      if (queued) view.boundToggle();
      assert.equal(view.calls, 0);
      guest.loading = false; // Guest confirms cancellation; original document survived.
      if (event === "abort") guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
      else guest.emit("did-stop-loading");
      h.bridge.setEnabled(false); h.bridge.setEnabled(true);
      if (!queued) view.boundToggle();
      await complete(view);
      assert.equal(view.calls, 1); assert.equal(view.mode, "reader");
      view.boundToggle(); guest.emit("dom-ready");
      assert.equal(view.calls, 1, "abort does not reset manual suppression or create a visit");
    });
  }
}

for (const event of ["abort", "stop"] as const) {
  test(`old ${event} after a newer main-frame commit cannot poison its pending activation`, async () => {
    const h = host(); const view = h.create(); visit(view); await complete(view); view.boundToggle();
    view.source = deferred(); visit(view, "https://test.example/b");
    if (event === "abort") view.webview!.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
    else view.webview!.emit("did-stop-loading");
    await complete(view);
    assert.equal(view.calls, 2); assert.equal(view.writes, 2); assert.equal(view.mode, "reader");
  });
}

for (const readiness of ["dom-ready-with-loading", "stop-without-dom-ready"] as const) {
  test(`${readiness} releases queued native Reader without fabricating an automatic visit`, async () => {
    const h = host(false); const view = h.create(); visit(view);
    const guest = view.webview!;
    guest.emit("did-start-navigation", { isMainFrame: true }); view.boundToggle();
    guest.emit("did-navigate", { url: "https://test.example/b" });
    assert.equal(view.calls, 0);
    if (readiness === "dom-ready-with-loading") {
      guest.loadingAtDomReady = true; guest.emit("dom-ready");
    } else {
      guest.loading = false; guest.emit("did-stop-loading");
    }
    await complete(view); assert.equal(view.calls, 1); assert.equal(view.mode, "reader");
  });
}

test("late abort/stop while a newer same-URL navigation loads cannot release its queued manual intent early", async () => {
  const h = host(false); const view = h.create(); visit(view);
  const guest = view.webview!;
  guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  guest.emit("did-start-navigation", { isMainFrame: true, isInPlace: false });
  view.boundToggle();
  guest.emit("did-fail-load", { isMainFrame: true, errorCode: -3 });
  guest.emit("did-stop-loading"); // A late notification; current guest still loading.
  assert.equal(view.calls, 0);
  guest.emit("did-navigate", { url: "https://test.example/a" }); guest.emit("dom-ready");
  await complete(view); assert.equal(view.calls, 1); assert.equal(view.mode, "reader");
});

test("known destroyed guest cannot be revived by stale readiness or manual availability probes", () => {
  const h = host(false); const view = h.create(); visit(view);
  view.webview!.emit("destroyed");
  view.boundToggle();
  view.webview!.emit("did-navigate", { url: "https://test.example/late" });
  view.webview!.emit("dom-ready"); view.webview!.emit("did-stop-loading");
  assert.equal(view.calls, 0);
});

test("native webview replacement preserves suppression; stale old-element events are ignored", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view); view.boundToggle();
  const old = view.webview!;
  view.instantiateWebView();
  assert.equal(old.listenerCount, 0);
  visit(view); await complete(view); assert.equal(view.writes, 1, "replacement bootstrap is not a new visit");
  old.emit("did-navigate", { url: "https://test.example/old" }); old.emit("dom-ready");
  assert.equal(view.calls, 1);
  visit(view); await complete(view); assert.equal(view.writes, 2, "later verified document is fresh");
});

test("reentrant manual Original is serialized before continuation returns, without a paint/task", async () => {
  const h = host(false); const view = h.create(); visit(view);
  view.duringRender = () => { view.boundToggle(); view.trace.push("intent-returned"); };
  view.boundToggle();
  await complete(view);
  assert.equal(view.mode, "webview");
  assert.deepEqual(view.trace.slice(-4), ["commit-start", "intent-returned", "commit-end", "original"]);
});

test("close invalidates synchronously; teardown restores only owned methods and factory slots", async () => {
  const h = host(); const view = h.create(); visit(view);
  const captured = view.toggleReaderMode;
  const later = () => { view.mode = "external"; };
  view.toggleReaderMode = later;
  session(h.bridge, view).refreshBinding();
  assert.equal(h.bridge.getSession(view), null);
  assert.equal(view.toggleReaderMode, later);
  await complete(view); assert.equal(view.writes, 0);
  captured.call(view); // Captured wrappers become native pass-through after dispose.
  await Promise.all(view.displays);
  assert.equal(view.mode, "reader");
  const wrapper = h.registry.webviewer!;
  const foreign = () => new View("foreign"); h.registry.webviewer = foreign;
  assert.equal(h.bridge.refreshFactories(), false);
  assert.equal(h.registry.webviewer, foreign);
  assert.equal(h.core.views.webviewer, h.creator);
  const unmanaged = wrapper("captured");
  assert.equal(unmanaged.toggleReaderMode, View.prototype.toggleReaderMode);
});

for (const kind of ["auto", "manual"] as const) {
  for (const action of ["manual-off", "disable", "navigation", "dispose"] as const) {
    test(`${kind} entry ${kind === "manual" && action === "disable" ? "survives" : "is cancelled by"} ${action} in the native delivery gap`, async () => {
      const h = host(kind === "auto"); const view = h.create();
      view.onYield = (carrier) => {
        void Promise.prototype.then.call(carrier, () => {
          view.onYield = undefined;
          switch (action) {
            case "manual-off":
              if (kind === "auto") view.boundToggle(); // Explicit Reader intent first.
              view.boundToggle(); // Cancel that pending explicit intent.
              break;
            case "disable": h.bridge.setEnabled(false); break;
            case "navigation": view.webview!.emit("did-start-navigation", { isMainFrame: true }); break;
            case "dispose": h.bridge.dispose(); break;
          }
        });
      };
      visit(view);
      if (kind === "manual") view.boundToggle();
      await complete(view);
      await Promise.all(view.displays);
      assert.equal(view.writes, kind === "manual" && action === "disable" ? 1 : 0);
    });
  }
}

test("reentrant navigation, setting, and close drain synchronously after native commit", async () => {
  const h = host(false); const view = h.create(); visit(view);
  let closing: Promise<void> | undefined;
  view.duringRender = () => {
    view.navigate("https://test.example/next");
    h.bridge.setEnabled(false);
    closing = view.close();
    assert.equal(view.navigations, 0);
    assert.equal(view.closed, 0);
  };
  view.boundToggle();
  await complete(view); await closing;
  assert.equal(view.navigations, 1);
  assert.equal(view.closed, 1);
  assert.equal(h.bridge.getSession(view), null);
  assert.deepEqual(view.trace.slice(-2), ["commit-end", "navigate"]);
});

test("factory preserves receiver/arguments/errors and declines non-pristine results", () => {
  const context = { sentinel: true };
  const expected = new Error("factory failure");
  const creator = function (this: unknown, ...args: unknown[]) {
    assert.equal(this, context);
    assert.deepEqual(args, ["leaf", 42]);
    throw expected;
  };
  const core = { enabled: true, views: { webviewer: creator } };
  const app = { internalPlugins: { getPluginById: () => core }, viewRegistry: { viewByType: { webviewer: creator } } };
  const bridge = installNativeReaderBridge(app, "1.14.4", true)!;
  assert.throws(() => app.viewRegistry.viewByType.webviewer.call(context, "leaf", 42), (error) => error === expected);
  bridge.dispose();
  const h = host(); h.bridge.dispose();
  const existing = h.existing;
  h.core.views.webviewer = h.registry.webviewer = () => existing;
  const freshBridge = installNativeReaderBridge(h.app, "1.14.4", true)!;
  assert.equal(h.registry.webviewer!("leaf"), existing);
  assert.equal(freshBridge.getSession(existing), null);
});

/** Resize tests are deterministic lifecycle MODELS, not native/runtime evidence. */
test("resize preserves original receiver/arguments/return and delegates with renderer receiver only", () => {
  const h = host(false); const view = h.create(); visit(view);
  const returned = { native: true }; const argument = { width: 400 };
  view.resizeHook = (...args) => { assert.deepEqual(args, [argument, 7]); return returned; };
  const renderer = { calls: 0, onResize(this: { calls: number }, ...args: unknown[]) {
    assert.equal(this, renderer); assert.deepEqual(args, []); this.calls++;
  } };
  view.renderer = renderer; view.mode = "reader";
  assert.equal(view.onResize(argument, 7), returned);
  assert.equal(view.resizeCalls, 1); assert.deepEqual(view.resizeArgs, [argument, 7]);
  assert.equal(renderer.calls, 1); assert.equal(view.calls, 0);
  assert.equal(view.mode, "reader"); assert.equal(view.navigations, 0); assert.equal(view.originals, 1);
});

test("model: dropped hidden render resumes through visible native resize without re-extraction", async () => {
  const h = host(false); const view = h.create(); visit(view);
  class RendererModel {
    visible = false; renderedWidth = 0; text = ""; body = ""; queued = false;
    onResize() {
      const width = this.visible ? 400 : 0;
      if (width !== this.renderedWidth) { this.renderedWidth = width; this.queued = true; }
    }
    flush() {
      if (!this.queued) return;
      this.queued = false;
      if (this.visible) this.body = this.text;
    }
  }
  const renderer = new RendererModel();
  view.duringRender = () => { view.renderer = renderer; renderer.text = "Article B"; renderer.queued = true; };
  view.boundToggle(); await complete(view);
  renderer.flush(); // Model of native onRender discarding hidden work.
  assert.equal(renderer.body, ""); assert.equal(renderer.queued, false);
  const before = { calls: view.calls, writes: view.writes, mode: view.mode, navigations: view.navigations };
  renderer.visible = true; view.onResize(); renderer.flush();
  assert.equal(renderer.body, "Article B");
  assert.deepEqual({ calls: view.calls, writes: view.writes, mode: view.mode, navigations: view.navigations }, before);
});

test("native Reader projection maintenance survives repeated global OFF", async () => {
  const h = host(false); const view = h.create(); visit(view); view.boundToggle(); await complete(view);
  let resized = 0; view.renderer = { onResize() { resized++; } };
  h.bridge.setEnabled(false); h.bridge.setEnabled(false); view.onResize();
  assert.equal(resized, 1); assert.equal(view.mode, "reader"); assert.equal(view.calls, 1);
});

test("Original resize does not touch a leftover renderer, extraction, mode, or manual suppression", async () => {
  const h = host(); const view = h.create(); visit(view); await complete(view); view.boundToggle();
  let resized = 0; view.renderer = { onResize() { resized++; } }; // Deliberately stale fixture field.
  view.onResize(); view.webview!.emit("dom-ready");
  assert.equal(resized, 0); assert.equal(view.resizeCalls, 1);
  assert.equal(view.mode, "webview"); assert.equal(view.calls, 1); assert.equal(view.navigations, 0);
});

test("borrowed resize delegates original receiver unchanged without forwarding either renderer", () => {
  const h = host(false); const view = h.create(); const other = new View("foreign");
  let resized = 0; view.renderer = other.renderer = { onResize() { resized++; } };
  view.mode = other.mode = "reader"; const returned = {};
  other.resizeHook = () => returned;
  assert.equal(view.onResize.call(other, "borrowed"), returned);
  assert.deepEqual(other.resizeArgs, ["borrowed"]); assert.equal(other.resizeCalls, 1);
  assert.equal(view.resizeCalls, 0); assert.equal(resized, 0);
});

test("resize looks up current renderer after original resize, never retains an earlier renderer", () => {
  const h = host(false); const view = h.create(); visit(view); view.mode = "reader";
  let oldCalls = 0; let newCalls = 0;
  view.renderer = { onResize() { oldCalls++; } };
  const replacement = { onResize() { newCalls++; } };
  view.resizeHook = () => { view.renderer = replacement; };
  view.onResize(); view.onResize();
  assert.equal(oldCalls, 0); assert.equal(newCalls, 2);
});

test("original resize synchronous errors and asynchronous return identity remain unchanged", async () => {
  const h = host(false); const view = h.create(); visit(view); view.mode = "reader";
  let resized = 0; view.renderer = { onResize() { resized++; } };
  const failure = new Error("prior resize failed");
  view.resizeHook = () => { throw failure; };
  assert.throws(() => view.onResize(), (error) => error === failure); assert.equal(resized, 0);
  const promise = Promise.reject(failure); view.resizeHook = () => promise;
  const result = view.onResize(); assert.equal(result, promise);
  await assert.rejects(result as Promise<unknown>, (error) => error === failure);
});

test("missing or inaccessible private renderer protocol gracefully preserves original resize", () => {
  const h = host(false); const view = h.create(); visit(view); view.mode = "reader";
  const returned = {}; view.resizeHook = () => returned;
  for (const renderer of [undefined, null, {}, { onResize: 7 }, {
    get onResize() { throw new Error("inaccessible protocol"); },
  }]) {
    view.renderer = renderer; assert.equal(view.onResize(), returned);
  }
  Object.defineProperty(view, "renderer", { configurable: true, get() { throw new Error("inaccessible renderer"); } });
  assert.equal(view.onResize(), returned);
  assert.ok(h.bridge.getSession(view)); assert.equal(view.calls, 0); assert.equal(view.mode, "reader");
});

test("private renderer failure is contained/observed without changing original resize return", async () => {
  const h = host(false); const view = h.create(); visit(view); view.mode = "reader";
  const returned = {}; view.resizeHook = () => returned;
  view.renderer = { onResize() { throw new Error("private sync failure"); } };
  assert.equal(view.onResize(), returned);
  view.renderer = { onResize() { return Promise.reject(new Error("private async failure")); } };
  assert.equal(view.onResize(), returned);
  await Promise.resolve();
  assert.equal(view.mode, "reader"); assert.equal(view.calls, 0);
});

test("resize teardown restores own descriptor; captured callbacks become original-only pass-through", () => {
  const returned = {}; let originalCalls = 0; let rendererCalls = 0;
  const original = function (this: View, ...args: unknown[]) {
    assert.equal(this.mode, "reader"); assert.deepEqual(args, ["resize"]); originalCalls++; return returned;
  };
  const descriptor = { value: original, writable: true, configurable: true, enumerable: false };
  const h = host(false, (view) => { Object.defineProperty(view, "onResize", descriptor); });
  const view = h.create(); visit(view); view.mode = "reader";
  view.renderer = { onResize() { rendererCalls++; } };
  const captured = view.onResize;
  assert.equal(captured.call(view, "resize"), returned); assert.equal(rendererCalls, 1);
  session(h.bridge, view).dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(view, "onResize"), descriptor);
  assert.equal(captured.call(view, "resize"), returned);
  assert.equal(originalCalls, 2); assert.equal(rendererCalls, 1);
});

test("later resize ownership is retained, and captured old wrapper does not project after conflict", () => {
  const h = host(false); const view = h.create(); visit(view); view.mode = "reader";
  let resized = 0; view.renderer = { onResize() { resized++; } };
  const captured = view.onResize; const later = () => "later";
  view.onResize = later;
  captured.call(view);
  assert.equal(h.bridge.getSession(view), null); assert.equal(view.onResize, later);
  assert.equal(resized, 0); assert.equal(view.resizeCalls, 1);
});

test("reentrant resize preserves original synchronous return but forwards only after native commit", async () => {
  const h = host(false); const view = h.create(); visit(view);
  let resized = 0; const returned = {};
  view.renderer = { onResize() { resized++; view.trace.push("renderer-resize"); } };
  view.resizeHook = () => { view.trace.push("original-resize"); return returned; };
  view.duringRender = () => { assert.equal(view.onResize("commit"), returned); assert.equal(resized, 0); };
  view.boundToggle(); await complete(view);
  assert.deepEqual(view.trace.slice(-4), ["commit-start", "original-resize", "commit-end", "renderer-resize"]);
  assert.equal(resized, 1);
});

for (const change of ["original", "renderer", "webview", "close", "dispose"] as const) {
  test(`queued projection never forwards old renderer after reentrant ${change}`, async () => {
    const h = host(false); const view = h.create(); visit(view);
    let oldCalls = 0; let newCalls = 0;
    view.renderer = { onResize() { oldCalls++; } };
    view.duringRender = () => {
      if (change === "original") view.boundToggle();
      if (change === "webview") view.instantiateWebView();
      if (change === "close") void view.close();
      if (change === "dispose") session(h.bridge, view).dispose();
      view.onResize();
      if (change === "renderer") view.renderer = { onResize() { newCalls++; } };
    };
    view.boundToggle(); await complete(view);
    assert.equal(view.resizeCalls, 1); assert.equal(oldCalls, 0); assert.equal(newCalls, 0);
    if (change === "renderer") { view.onResize(); assert.equal(newCalls, 1); }
  });
}

test("missing public resize protocol declines management before opening", () => {
  const h = host(false, (view) => { Object.defineProperty(view, "onResize", { value: undefined }); });
  const view = h.create(); assert.equal(h.bridge.getSession(view), null);
});

test("core disable/enable copies only the owned factory; managed views retire, never late-attach", () => {
  const h = host(); const view = h.create();
  h.core.enabled = false; delete h.registry.webviewer;
  assert.equal(h.bridge.refreshFactories(), false);
  assert.equal(h.bridge.getSession(view), null);
  h.core.enabled = true; h.registry.webviewer = h.core.views.webviewer;
  assert.equal(h.bridge.refreshFactories(), true);
  assert.ok(h.bridge.getSession(h.create()));
  assert.equal(h.bridge.getSession(view), null);
  h.bridge.dispose(); h.bridge.dispose();
  assert.equal(h.core.views.webviewer, h.creator);
  assert.equal(h.registry.webviewer, h.creator);
});
