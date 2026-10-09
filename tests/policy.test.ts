import test from "node:test";
import assert from "node:assert/strict";
import { Policy, type ViewSnapshot } from "../src/policy.js";

const original: ViewSnapshot = {
  readiness: "ready", capability: "available", mode: "original",
};
function observe(policy: Policy, patch: Partial<ViewSnapshot> = {}) {
  return policy.dispatch({
    type: "observe", generation: policy.state.generation,
    snapshot: { ...original, ...patch },
  });
}
function activate(policy: Policy) {
  const ticket = observe(policy);
  assert.ok(ticket);
  assert.equal(policy.state.attempted, true);
  assert.equal(policy.isCurrent(ticket), true);
  return ticket;
}

test("duplicate readiness consumes one shot before dispatch; tickets are identity-bound", () => {
  const policy = new Policy(true);
  const ticket = activate(policy);
  for (let i = 0; i < 5; i++) assert.equal(observe(policy), undefined);
  assert.equal(policy.isCurrent(ticket), true);
  assert.equal(policy.isCurrent({ ...ticket }), false);
});

test("initial and restored reader-active pages are satisfied without toggling", () => {
  const policy = new Policy(true);
  for (let i = 0; i < 2; i++) {
    assert.equal(observe(policy, { mode: "reader" }), undefined);
    assert.equal(policy.state.satisfied, true);
    assert.equal(policy.state.attempted, false);
    assert.equal(observe(policy), undefined);
    policy.dispatch({ type: "new-visit" });
  }
});

test("two live views of the same URL are independent; no URL input exists", () => {
  const first = new Policy(true);
  const second = new Policy(true);
  const ticket = activate(first);
  assert.equal(second.isCurrent(ticket), false);
  first.dispatch({ type: "manual-intent", mode: "original" });
  activate(second);
  assert.equal(observe(first), undefined);
});

for (const mode of ["original", "reader"] as const) {
  for (const timing of ["before", "during", "after"] as const) {
    test(`manual ${mode} ${timing} activation suppresses the entire visit`, () => {
      const policy = new Policy(true);
      const ticket = timing === "before" ? undefined : activate(policy);
      if (timing === "after") observe(policy, { mode: "reader" });
      policy.dispatch({ type: "manual-intent", mode });
      assert.equal(policy.state.suppressed, true);
      if (ticket) assert.equal(policy.isCurrent(ticket), false);
      policy.dispatch({ type: "rebind" });
      assert.equal(observe(policy), undefined);
      assert.equal(policy.state.suppressed, true);
      policy.dispatch({ type: "new-visit" });
      activate(policy);
    });
  }
}

test("own mode-transition rebind loop preserves attempt and rejects stale observations", () => {
  const policy = new Policy(true);
  const ticket = activate(policy);
  const visit = policy.state.visit;
  for (let i = 0; i < 4; i++) {
    const generation = policy.state.generation;
    policy.dispatch({ type: "rebind" });
    assert.equal(policy.state.visit, visit);
    assert.equal(policy.isCurrent(ticket), false);
    assert.equal(policy.dispatch({ type: "observe", generation, snapshot: original }), undefined);
    assert.equal(observe(policy), undefined);
  }
});

test("rebind before attempt needs fresh evidence but does not create a visit", () => {
  const policy = new Policy(true);
  const generation = policy.state.generation;
  policy.dispatch({ type: "rebind" });
  assert.equal(policy.dispatch({ type: "observe", generation, snapshot: original }), undefined);
  assert.equal(policy.state.visit, 1);
  activate(policy);
});

test("stale non-affirmative observations leave fresh state and ticket untouched", () => {
  for (const patch of [
    { mode: "reader" }, { capability: "unsupported" }, { readiness: "loading" },
  ] satisfies Partial<ViewSnapshot>[]) {
    const policy = new Policy(true);
    const generation = policy.state.generation;
    policy.dispatch({ type: "rebind" });
    const ticket = activate(policy);
    const state = policy.state;
    assert.equal(policy.dispatch({
      type: "observe", generation, snapshot: { ...original, ...patch },
    }), undefined);
    assert.deepEqual(policy.state, state);
    assert.equal(policy.isCurrent(ticket), true);
  }
});

test("new visit directly invalidates an outstanding ticket and permits a fresh one", () => {
  const policy = new Policy(true);
  const oldTicket = activate(policy);
  policy.dispatch({ type: "new-visit" });
  assert.equal(policy.isCurrent(oldTicket), false);
  const freshTicket = activate(policy);
  assert.equal(freshTicket.visit, oldTicket.visit + 1);
  assert.notEqual(freshTicket, oldTicket);
  assert.equal(policy.isCurrent(oldTicket), false);
  assert.equal(policy.isCurrent(freshTicket), true);
});

test("verified same-URL reload creates a fresh visit; routine observations do not", () => {
  const policy = new Policy(true);
  const ticket = activate(policy);
  assert.equal(observe(policy), undefined);
  policy.dispatch({ type: "navigation-begin" });
  assert.equal(policy.isCurrent(ticket), false);
  assert.equal(observe(policy), undefined);
  policy.dispatch({ type: "new-visit" });
  assert.equal(policy.state.visit, ticket.visit + 1);
  activate(policy);
});

test("canceled navigation preserves suppression and attempt, without replacement", () => {
  for (const prior of ["fresh", "attempted", "suppressed"] as const) {
    const policy = new Policy(true);
    const ticket = prior === "attempted" ? activate(policy) : undefined;
    if (prior === "suppressed") policy.dispatch({ type: "manual-intent", mode: "reader" });
    const before = policy.state;
    policy.dispatch({ type: "navigation-begin" });
    if (ticket) assert.equal(policy.isCurrent(ticket), false);
    assert.equal(observe(policy), undefined);
    policy.dispatch({ type: "navigation-abort" });
    assert.equal(policy.state.visit, before.visit);
    assert.equal(policy.state.attempted, before.attempted);
    assert.equal(policy.state.suppressed, before.suppressed);
    if (prior === "fresh") activate(policy);
    else assert.equal(observe(policy), undefined);
  }
});

test("ambiguous replacement stays suspended through abort, rebind and setting changes", () => {
  const policy = new Policy(true);
  const ticket = activate(policy);
  policy.dispatch({ type: "ambiguous-replacement" });
  assert.equal(policy.isCurrent(ticket), false);
  policy.dispatch({ type: "navigation-abort" });
  policy.dispatch({ type: "rebind" });
  policy.dispatch({ type: "setting", enabled: false });
  policy.dispatch({ type: "setting", enabled: true });
  assert.equal(observe(policy), undefined);
  assert.equal(policy.state.suspended, true);
  policy.dispatch({ type: "new-visit" });
  activate(policy);
});

test("global off/on cannot arm an already-open visit, including a previously armed one", () => {
  for (const initial of [false, true]) {
    const policy = new Policy(initial);
    policy.dispatch({ type: "setting", enabled: false });
    policy.dispatch({ type: "setting", enabled: true });
    assert.equal(observe(policy), undefined);
    policy.dispatch({ type: "new-visit" });
    const ticket = activate(policy);
    policy.dispatch({ type: "setting", enabled: false });
    assert.equal(policy.isCurrent(ticket), false);
    assert.equal(policy.state.attempted, true);
    policy.dispatch({ type: "new-visit" });
    policy.dispatch({ type: "setting", enabled: true });
    assert.equal(observe(policy), undefined);
  }
});

test("setting observers preserve manual suppression while off", () => {
  const policy = new Policy(false);
  policy.dispatch({ type: "manual-intent", mode: "original" });
  policy.dispatch({ type: "setting", enabled: true });
  assert.equal(policy.state.suppressed, true);
  assert.equal(observe(policy), undefined);
  policy.dispatch({ type: "new-visit" });
  activate(policy);
});

test("loading and uncertain capability/mode wait for affirmative evidence", () => {
  const policy = new Policy(true);
  for (const patch of [
    { readiness: "loading" }, { capability: "unknown" }, { mode: "unknown" },
  ] satisfies Partial<ViewSnapshot>[]) {
    assert.equal(observe(policy, patch), undefined);
    assert.equal(policy.state.attempted, false);
  }
  activate(policy);
});

test("unsupported is terminal for the visit, not a retry loop", () => {
  const policy = new Policy(true);
  assert.equal(observe(policy, { capability: "unsupported" }), undefined);
  policy.dispatch({ type: "rebind" });
  assert.equal(observe(policy), undefined);
  assert.equal(policy.state.unsupported, true);
  policy.dispatch({ type: "new-visit" });
  activate(policy);
});

test("loss of affirmative evidence invalidates a ticket without allowing retry", () => {
  for (const patch of [
    { readiness: "loading" }, { capability: "unknown" },
    { capability: "unsupported" }, { mode: "unknown" }, { mode: "reader" },
  ] satisfies Partial<ViewSnapshot>[]) {
    const policy = new Policy(true);
    const ticket = activate(policy);
    observe(policy, patch);
    assert.equal(policy.isCurrent(ticket), false);
    assert.equal(observe(policy), undefined);
  }
});

test("disposal invalidates tickets and makes every subsequent event inert", () => {
  const policy = new Policy(true);
  const ticket = activate(policy);
  policy.dispatch({ type: "dispose" });
  const state = policy.state;
  assert.equal(policy.isCurrent(ticket), false);
  policy.dispatch({ type: "new-visit" });
  policy.dispatch({ type: "setting", enabled: false });
  policy.dispatch({ type: "setting", enabled: true });
  policy.dispatch({ type: "rebind" });
  policy.dispatch({ type: "manual-intent", mode: "original" });
  policy.dispatch({ type: "manual-intent", mode: "reader" });
  policy.dispatch({ type: "navigation-begin" });
  policy.dispatch({ type: "navigation-abort" });
  policy.dispatch({ type: "ambiguous-replacement" });
  policy.dispatch({ type: "dispose" });
  assert.equal(observe(policy), undefined);
  assert.deepEqual(policy.state, state);
  assert.equal(Object.isFrozen(state), true);
});
