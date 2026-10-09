import assert from "node:assert/strict";
import test from "node:test";
import { Policy } from "../src/policy.js";

/** Feasibility characterization, NOT adapter acceptance tests.
 * Core 1.14.4 app.js: awaiter 252926; display 3000851; button binding 2994910.
 * The mock models the inspected transpiled awaiter, not native JS `await`:
 * it calls the yielded Promise's .then and resumes rendering synchronously.
 * No native renderer/extractor implementation is copied or executed here.
 */
interface Content { md: string; title: string }
const article: Content = { md: "test", title: "test" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class NativeModel {
  mode: "webview" | "reader" = "webview";
  writes = 0;
  getReaderModeContent: () => Promise<Content | undefined>;
  constructor(source: Promise<Content | undefined>) {
    this.getReaderModeContent = () => source;
  }
  displayReaderView(): Promise<void> {
    return new Promise((resolve, reject) => {
      const yielded = this.getReaderModeContent();
      const adopted = yielded instanceof Promise ? yielded : Promise.resolve(yielded);
      adopted.then((result) => {
        if (result) {
          this.writes++;
          this.mode = "reader";
        }
        resolve();
      }, reject);
    });
  }
  displayWebView(): void { this.mode = "webview"; }
  toggleReaderMode(): void {
    if (this.mode === "reader") this.displayWebView();
    else void this.displayReaderView();
  }
}

function authorization() {
  const policy = new Policy(true);
  const ticket = policy.dispatch({ type: "observe", generation: 1, snapshot: {
    readiness: "ready", capability: "available", mode: "original",
  } });
  assert.ok(ticket);
  return { policy, current: () => policy.isCurrent(ticket) };
}

const invalidations = ["manual-off", "navigation", "disable", "dispose"] as const;
type Invalidation = typeof invalidations[number];
function invalidate(policy: Policy, view: NativeModel, action: Invalidation): void {
  switch (action) {
    case "manual-off":
      policy.dispatch({ type: "manual-intent", mode: "original" });
      view.displayWebView();
      break;
    case "navigation": policy.dispatch({ type: "navigation-begin" }); break;
    case "disable": policy.dispatch({ type: "setting", enabled: false }); break;
    case "dispose": policy.dispatch({ type: "dispose" }); break;
  }
}

/** Test-only atomic-delivery prototype. Carrier's intrinsic value is undefined:
 * an await implementation bypassing own .then cannot accidentally render.
 * This does NOT solve invocations that were already pending before attachment.
 */
function deliveryGate(
  source: Promise<Content | undefined>, current: () => boolean, beforeResume: () => void,
): Promise<Content | undefined> {
  let result: Content | undefined;
  const carrier = source.then((value) => {
    result = value;
    beforeResume();
    return undefined;
  });
  const intrinsicThen = carrier.then;
  Object.defineProperty(carrier, "then", {
    value: function <T, U>(
      fulfilled?: ((value: Content | undefined) => T | PromiseLike<T>) | null,
      rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
    ) {
      return intrinsicThen.call(carrier, () => {
        // No promise boundary between this check and the native continuation.
        const permitted = current() ? result : undefined;
        result = undefined;
        return fulfilled?.(permitted);
      }, rejected);
    },
  });
  return carrier;
}

for (const action of invalidations) {
  test(`COUNTEREXAMPLE: ordinary getter guard loses ${action} in continuation gap`, async () => {
    const source = deferred<Content | undefined>();
    const view = new NativeModel(source.promise);
    const auth = authorization();
    view.getReaderModeContent = () => source.promise.then((result) => {
      const permitted = auth.current() ? result : undefined;
      // Deliberately after the guard, before native's post-await continuation.
      queueMicrotask(() => invalidate(auth.policy, view, action));
      return permitted;
    });
    const display = view.displayReaderView();
    source.resolve(article);
    await display;
    assert.equal(auth.current(), false);
    assert.equal(view.writes, 1, "stale render demonstrates unsafe getter-only guard");
  });

  for (const phase of ["extraction", "continuation gap"] as const) {
    test(`atomic delivery prototype blocks ${action} during ${phase}`, async () => {
      const source = deferred<Content | undefined>();
      const view = new NativeModel(source.promise);
      const auth = authorization();
      view.getReaderModeContent = () => deliveryGate(source.promise, auth.current, () => {
        if (phase === "continuation gap") {
          queueMicrotask(() => invalidate(auth.policy, view, action));
        }
      });
      const display = view.displayReaderView();
      if (phase === "extraction") invalidate(auth.policy, view, action);
      source.resolve(article);
      await display;
      assert.equal(view.writes, 0);
    });
  }
}

test("atomic delivery prototype permits current native continuation", async () => {
  const view = new NativeModel(Promise.resolve(article));
  view.getReaderModeContent = () => deliveryGate(Promise.resolve(article), () => true, () => {});
  await view.displayReaderView();
  assert.equal(view.writes, 1);
  assert.equal(view.mode, "reader");
});

test("BLOCKER: pre-attachment native refresh bypasses even atomic delivery guard", async () => {
  const source = deferred<Content | undefined>();
  const view = new NativeModel(source.promise);
  view.mode = "reader";
  // Core commitPageLoad can start this before workspace discovery attaches us.
  const alreadyPending = view.displayReaderView();
  const auth = authorization();
  let guardedGetterCalls = 0;
  view.getReaderModeContent = () => {
    guardedGetterCalls++;
    return deliveryGate(source.promise, auth.current, () => {});
  };
  const nativeDisplay = view.displayReaderView;
  view.displayReaderView = function () { return nativeDisplay.call(this); };
  const nativeToggle = view.toggleReaderMode;
  view.toggleReaderMode = function () {
    auth.policy.dispatch({ type: "manual-intent", mode: "original" });
    nativeToggle.call(this);
  };
  view.toggleReaderMode();
  assert.equal(view.mode, "webview");
  source.resolve(article);
  await alreadyPending;
  assert.equal(guardedGetterCalls, 0, "the old continuation never revisits the getter");
  assert.equal(view.writes, 1);
  assert.equal(view.mode, "reader", "older native refresh overrides newer manual original");
});

test("bound native toolbar toggle does not consult a later method wrapper", () => {
  const view = new NativeModel(Promise.resolve(undefined));
  view.mode = "reader";
  const toolbarClick = view.toggleReaderMode.bind(view); // native onOpen binding
  let tagged = false;
  const originalToggle = view.toggleReaderMode;
  view.toggleReaderMode = function () { tagged = true; originalToggle.call(this); };
  toolbarClick();
  assert.equal(tagged, false);
  assert.equal(view.mode, "webview");
});
