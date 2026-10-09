import { Policy } from "./policy.js";
import { nativeDeliveryGate, observeSettlement } from "./native-gate.js";
import { listenNativeNavigation, type NavigationSignal } from "./native-navigation.js";
import { NativePatches } from "./native-patches.js";
import { record, type NativeContent, type NativeMethod, type NativeReaderSession,
  type NativeView, type NativeWebView } from "./native-types.js";

const methods = ["getReaderModeContent", "displayReaderView", "displayWebView",
  "toggleReaderMode", "instantiateWebView", "displayErrorView", "displayBlank",
  "navigate", "close", "unload", "onResize"] as const;
type Method = typeof methods[number];
type Kind = "auto" | "manual" | "refresh";
interface Request {
  kind: Kind; generation: number; revision: number; element: NativeWebView;
  getterUsed: boolean; result?: unknown; release?: () => void;
}

/** Called exclusively on a synchronous factory result, BEFORE onOpen. */
export function provisionNativeSession(
  value: unknown, enabled: boolean, retired: () => void,
): ManagedNativeSession | null {
  if (!record(value) || value.mode !== "blank" || value.webview != null
    || typeof value.getViewType !== "function") return null;
  try {
    if (value.getViewType() !== "webviewer"
      || !methods.every((key) => typeof value[key] === "function"
        && NativePatches.writable(value, key))) return null;
    return new ManagedNativeSession(value as unknown as NativeView, enabled, retired);
  } catch { return null; }
}

export class ManagedNativeSession implements NativeReaderSession {
  private readonly policy: Policy;
  private readonly patches = new NativePatches();
  private readonly native: Record<Method, NativeMethod>;
  private element?: NativeWebView;
  private unlisten?: () => void;
  private ready = false;
  private destroyed = false;
  private committed = false;
  private replacement = false;
  private documentUrl?: string;
  private revision = 0;
  private probedVisit = -1;
  private renderedGeneration = -1;
  private entry?: Request;
  private pending?: Request;
  private extraction?: { generation: number; element: NativeWebView; promise: Promise<NativeContent | undefined> };
  private manualEntry = false;
  private waitingManualReader = false;
  private navigationIntent?: "original" | "reader";
  private committing = false;
  private readonly deferred: Array<() => void> = [];
  private dead = false;

  constructor(private readonly view: NativeView, enabled: boolean, private readonly retired: () => void) {
    this.policy = new Policy(enabled);
    this.native = Object.fromEntries(methods.map((key) => [key, view[key]])) as Record<Method, NativeMethod>;
    const wrap = (key: Method, action: (args: unknown[]) => unknown) => {
      const session = this;
      const original = this.native[key];
      this.patches.install(view, key, function (this: NativeView, ...args: unknown[]) {
        if (this !== view || session.dead) return original.apply(this, args);
        if (!session.patches.ownsAll()) {
          session.dispose();
          return original.apply(this, args);
        }
        return action(args);
      });
    };
    try {
      wrap("getReaderModeContent", (args) => this.getter(args));
      wrap("displayReaderView", (args) => this.serializeDisplay(args));
      wrap("onResize", (args) => this.resize(args));
      wrap("displayWebView", (args) => this.serial(() => {
        // Only toggle calls this from Reader. navigate's presentation callback
        // calls it from blank/error, and must NOT count as manual Original.
        if (!this.manualEntry && view.mode === "reader") this.manual("original");
        const result = this.native.displayWebView.apply(view, args);
        this.pump();
        return result;
      }));
      wrap("toggleReaderMode", (args) => this.serial(() => {
        const original = view.mode === "reader" || this.waitingManualReader;
        this.manual(original ? "original" : "reader");
        this.manualEntry = true;
        try {
          // A second explicit toggle cancels the pending first toggle, instead
          // of blindly asking the native toggle to start another extraction.
          return original && view.mode !== "reader"
            ? this.native.displayWebView.apply(view, [])
            : this.native.toggleReaderMode.apply(view, args);
        } finally { this.manualEntry = false; }
      }));
      wrap("instantiateWebView", (args) => this.serial(() => {
        if (this.element) this.suspend();
        const result = this.native.instantiateWebView.apply(view, args);
        this.bind();
        return result;
      }));
      for (const key of ["displayErrorView", "displayBlank"] as const) {
        wrap(key, (args) => this.serial(() => {
          this.suspend();
          return this.native[key].apply(view, args);
        }));
      }
      wrap("navigate", (args) => this.serial(() => this.native.navigate.apply(view, args)));
      for (const key of ["close", "unload"] as const) {
        wrap(key, (args) => {
          if (this.committing && key === "close") {
            return new Promise((resolve, reject) => this.deferred.push(() => {
              try { this.dispose(); resolve(this.native[key].apply(view, args)); }
              catch (error) { reject(error); }
            }));
          }
          return this.serial(() => { this.dispose(); return this.native[key].apply(view, args); });
        });
      }
    } catch (error) { this.patches.restore(); throw error; }
  }

  get disposed(): boolean { return this.dead; }

  setEnabled(enabled: boolean): void {
    this.serial(() => {
      if (this.dead) return;
      this.policy.dispatch({ type: "setting", enabled });
      // Settings authorize automation ONLY. Native/manual work and exact user
      // intent survive OFF (including repeated OFF save-settlement publications).
      if (!enabled && this.pending?.kind === "auto") {
        this.pending.release?.();
        this.pending = undefined;
      }
      // ON never pumps or rearms the current visit.
    });
  }

  refreshBinding(): void {
    this.serial(() => {
      if (this.dead) return;
      if (!this.patches.ownsAll()) { this.dispose(); return; }
      this.bind();
    });
  }

  dispose(): void {
    this.serial(() => {
      if (this.dead) return;
      this.dead = true;
      this.policy.dispatch({ type: "dispose" });
      this.invalidate();
      this.unlisten?.();
      this.unlisten = undefined;
      this.extraction = undefined;
      this.patches.restore();
      this.retired();
    });
  }

  /** Reentrant inputs linearize AFTER a synchronous native commit. Drain before
   * returning its continuation (no task, microtask, or paint between them).
   * This is not a later visible-mode restoration or an async token fiction.
   */
  private serial(action: () => unknown): unknown {
    if (!this.committing) return action();
    this.deferred.push(() => { action(); });
    return undefined;
  }

  private commit(action: () => unknown): unknown {
    this.committing = true;
    try { return action(); }
    finally {
      this.committing = false;
      while (this.deferred.length) {
        try { this.deferred.shift()!(); } catch { /* Reentrant void effects are fail-closed. */ }
      }
    }
  }

  private resize(args: unknown[]): unknown {
    // Preserve the inherited/native method's receiver, arguments, return and
    // errors, even during a reentrant commit. Only our projection work is queued.
    const result = this.native.onResize.apply(this.view, args);
    try {
      const renderer = this.view.renderer;
      const element = this.view.webview;
      this.serial(() => {
        try {
          if (this.dead || this.destroyed || !this.patches.ownsAll()
            || this.view.mode !== "reader" || this.view.renderer !== renderer
            || this.view.webview !== element || this.element !== element) return;
          if (!record(renderer) || typeof renderer.onResize !== "function") return;
          // Core 1.14.4: Lj.onRender (2007206) drops hidden work; Lj.onResize
          // (2012196) requeues on width change. WebViewer inherits a no-op resize.
          // Maintenance is native-only and independent of automation ON/OFF.
          observeSettlement(renderer.onResize.call(renderer), () => {});
        } catch { /* Unknown private renderer protocol: leave native state alone. */ }
      });
    } catch { /* A missing/inaccessible renderer cannot break the original resize. */ }
    return result;
  }

  private invalidate(): void {
    this.revision++;
    this.pending?.release?.();
    this.pending = undefined;
  }

  private manual(mode: "original" | "reader"): void {
    this.policy.dispatch({ type: "manual-intent", mode });
    this.waitingManualReader = mode === "reader";
    // An explicit choice during the current pending navigation belongs to that
    // navigation, not just the document about to be replaced. Replay that exact
    // observed intent after its commit; never derive it from a mode change.
    if (this.policy.state.navigating) this.navigationIntent = mode;
    this.invalidate();
  }

  private suspend(): void {
    this.policy.dispatch({ type: "ambiguous-replacement" });
    this.invalidate();
  }

  private bind(): void {
    const next = this.view.webview;
    if (next === this.element) return;
    this.unlisten?.();
    this.unlisten = undefined;
    const replacing = !!this.element;
    this.element = next;
    this.destroyed = false;
    this.committed = false;
    this.ready = false;
    this.documentUrl = undefined;
    this.invalidate();
    if (replacing) {
      this.policy.dispatch({ type: "rebind" });
      this.suspend();
      this.replacement = true;
    }
    if (!next || typeof next.addEventListener !== "function"
      || typeof next.removeEventListener !== "function") { this.suspend(); return; }
    this.unlisten = listenNativeNavigation(next,
      () => !this.dead && !this.destroyed && this.element === next && this.view.webview === next,
      (signal) => { this.serial(() => this.navigation(signal)); });
  }

  private navigation(signal: NavigationSignal): void {
    if (this.dead) return;
    switch (signal.type) {
      case "begin":
        this.policy.dispatch({ type: "navigation-begin" });
        // Retain the old document's readiness for a confirmed surviving-page
        // abort. Navigating still blocks automation and cancels its old work.
        this.invalidate();
        break;
      case "commit": {
        // Recreated elements initially load the old native URL. This is NOT a
        // fresh visit/manual reset. Unknown bootstrap provenance stays suspended.
        const intent = this.navigationIntent;
        this.navigationIntent = undefined;
        this.waitingManualReader = intent === "reader"
          || (intent === undefined && this.replacement && this.waitingManualReader);
        this.policy.dispatch({ type: this.replacement ? "navigation-abort" : "new-visit" });
        if (intent) this.policy.dispatch({ type: "manual-intent", mode: intent });
        this.replacement = false;
        this.committed = true;
        this.ready = false;
        this.documentUrl = signal.url;
        this.invalidate();
        break;
      }
      case "ready":
        if (!this.committed || this.policy.state.navigating) break;
        this.ready = true;
        this.pump();
        break;
      case "route":
        // Declared boundary: hash-only events preserve the visit; path/query SPA
        // changes suspend automation until a full document commit. URLs never
        // establish a new visit or claim semantic article identity. Show the
        // native original on ambiguity rather than retain a possibly stale article.
        if (!signal.url || !this.documentUrl
          || signal.url.split("#")[0] !== this.documentUrl.split("#")[0]) {
          this.suspend();
          if (this.view.mode === "reader") {
            try { this.commit(() => this.native.displayWebView.apply(this.view, [])); }
            catch { /* A failed native fallback must not revive cancelled work. */ }
          }
        }
        if (signal.url) this.documentUrl = signal.url;
        break;
      case "abort": case "stopped":
        this.recoverSurvivingDocument();
        // A committed guest can become usable without another dom-ready (for
        // example a cancelled load). This releases ONLY an explicit user request.
        if (this.waitingManualReader && this.nativeAvailable()) this.pump();
        break;
      case "failure":
        // A delayed failure is not evidence against a newer committed page.
        // Native core itself handles non-abort error presentation.
        if (this.policy.state.navigating) this.suspend();
        break;
      case "destroy":
        this.destroyed = true;
        this.ready = false;
        this.waitingManualReader = false;
        this.navigationIntent = undefined;
        this.suspend();
        break;
    }
  }

  /** Abort/stop notifications carry no document token. They can recover ONLY
   * an outstanding navigation whose guest is now idle on the surviving document.
   * URL equality is a continuity check, never a new-visit identity/reset. Late
   * aborts after a commit, or while a newer navigation is loading, are ignored.
   */
  private recoverSurvivingDocument(): void {
    if (!this.policy.state.navigating || !this.committed || !this.documentUrl) return;
    try {
      if (this.element?.isLoadingMainFrame?.() !== false
        || this.element.getURL?.().split("#")[0] !== this.documentUrl.split("#")[0]) return;
    } catch { return; }
    this.policy.dispatch({ type: "navigation-abort" });
    this.navigationIntent = undefined;
    this.suspend(); // No new visit and no speculative automatic retry.
  }

  /** Conservative automation identity is NOT native user availability. Explicit
   * native reading may use the current idle guest even on a SPA/error document
   * for which the adapter has no automatic route-ready evidence.
   */
  private nativeAvailable(): boolean {
    if (this.destroyed || !this.element || this.view.webview !== this.element) return false;
    // A confirmed current DOM is usable even while subresources still load.
    if (this.ready && !this.policy.state.navigating) return true;
    try {
      if (this.element.isLoadingMainFrame) return this.element.isLoadingMainFrame() === false;
    } catch { return false; }
    return this.ready && !this.policy.state.navigating;
  }

  private eligible(): boolean {
    const s = this.policy.state;
    return !this.dead && this.ready && this.view.webview === this.element
      && this.view.mode === "webview" && s.enabled && s.armed && !s.attempted
      && !s.suppressed && !s.satisfied && !s.unsupported && !s.navigating && !s.suspended;
  }

  private pump(): void {
    if (this.waitingManualReader && !this.dead && this.nativeAvailable()) {
      try { this.request("manual", []); } catch { /* Explicit queued native failure is observed. */ }
      return;
    }
    if (!this.eligible() || this.probedVisit === this.policy.state.visit) return;
    this.probedVisit = this.policy.state.visit;
    try { this.request("auto", []); } catch { /* Plugin-owned native failures are fail-closed. */ }
  }

  private serializeDisplay(args: unknown[]): unknown {
    if (this.committing) return new Promise((resolve, reject) => {
      this.deferred.push(() => {
        try { resolve(this.serializeDisplay(args)); } catch (error) { reject(error); }
      });
    });
    const kind = this.view.mode === "reader" ? "refresh" : "manual";
    if (kind === "manual" && !this.manualEntry) this.manual("reader");
    return this.request(kind, args);
  }

  private request(kind: Kind, args: unknown[]): unknown {
    if (!this.element || (kind === "auto"
      ? !this.ready || this.policy.state.navigating
      : !this.nativeAvailable())) return Promise.resolve();
    // Native's debounced commit may arrive after our activation of this exact
    // document. Do not extract/render it twice; explicit manual entry is separate.
    if (kind === "refresh" && this.renderedGeneration === this.policy.state.generation) return Promise.resolve();
    if (this.pending?.kind === kind && this.pending.revision === this.revision) return this.pending.result;
    const request: Request = { kind, element: this.element, generation: this.policy.state.generation,
      revision: this.revision, getterUsed: false };
    this.pending = request;
    this.entry = request;
    try {
      const result = this.native.displayReaderView.apply(this.view, args);
      request.result = result;
      observeSettlement(result, () => {
        request.release?.();
        if (this.pending === request) this.pending = undefined;
      }, () => this.fallback(request));
      return result;
    } catch (error) {
      try { this.fallback(request); } catch { /* Preserve the original native error. */ }
      request.release?.();
      if (this.pending === request) this.pending = undefined;
      throw error;
    } finally { this.entry = undefined; }
  }

  private current(request: Request): boolean {
    const state = this.policy.state;
    return !this.dead && this.patches.ownsAll()
      && this.view.webview === request.element && this.element === request.element
      && request.generation === state.generation && request.revision === this.revision
      && (request.kind === "auto"
        ? this.ready && !state.navigating && state.enabled && state.armed
        : this.nativeAvailable());
  }

  private fallback(request: Request): void {
    if (!this.current(request)) return;
    if (request.kind === "manual") this.waitingManualReader = false;
    this.policy.dispatch({ type: "observe", generation: request.generation,
      snapshot: { readiness: "ready", capability: "unsupported",
        mode: this.view.mode === "reader" ? "reader" : "original" } });
    if (this.view.mode === "reader") {
      // Internal, idempotent original-page fallback. Never invent manual intent,
      // reload, or restore a cancelled request over a newer choice.
      this.commit(() => this.native.displayWebView.apply(this.view, []));
    }
  }

  private getter(args: unknown[]): unknown {
    const request = this.entry;
    // Save to vault and every unrelated caller get precisely the native getter.
    if (!request || request.getterUsed) return this.native.getReaderModeContent.apply(this.view, args);
    request.getterUsed = true;
    let source = this.extraction;
    if (!source || source.generation !== request.generation || source.element !== request.element) {
      const promise = this.native.getReaderModeContent.apply(this.view, args) as Promise<NativeContent | undefined>;
      source = { generation: request.generation, element: request.element, promise };
      this.extraction = source;
      const captured = source;
      observeSettlement(promise, () => { if (this.extraction === captured) this.extraction = undefined; });
    }
    const delivery = source.promise.then(undefined, (error: unknown) => {
      // Preserve native rejection for callers while observing plugin-owned
      // failures. A current failed refresh must not leave the old article up.
      try { this.fallback(request); } catch { /* Do not replace the native error. */ }
      throw error;
    });
    const gate = nativeDeliveryGate(delivery, () => this.entry === request,
      (content) => {
        if (!this.current(request)) return false;
        if (!content) { this.fallback(request); return false; }
        if (request.kind !== "auto") return request.kind === "manual" || this.view.mode === "reader";
        if (!this.eligible()) return false;
        const ticket = this.policy.dispatch({ type: "observe", generation: request.generation,
          snapshot: { readiness: "ready", mode: "original", capability: content ? "available" : "unsupported" } });
        return !!ticket && this.policy.isCurrent(ticket);
      }, (continuation) => this.commit(() => {
        const result = continuation();
        if (this.current(request) && this.view.mode === "reader") {
          this.renderedGeneration = request.generation;
          if (request.kind === "manual") this.waitingManualReader = false;
        }
        return result;
      }));
    request.release = gate.release;
    return gate.promise;
  }
}
