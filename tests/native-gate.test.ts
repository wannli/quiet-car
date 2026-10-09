import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { nativeDeliveryGate } from "../src/native-gate.js";
import type { NativeContent } from "../src/native-types.js";

const content: NativeContent = { md: "native only", title: "test" };

test("carrier intrinsic value is undefined even when a native await bypasses own then", async () => {
  let entry = true;
  const gate = nativeDeliveryGate(Promise.resolve(content), () => entry, () => true, (fn) => fn());
  entry = false;
  assert.equal(await gate.promise, undefined);
  gate.release();
});

test("direct core helper resumes once; multiple consumers cannot receive article twice", async () => {
  const gate = nativeDeliveryGate(Promise.resolve(content), () => true, () => true, (fn) => fn());
  const received: Array<NativeContent | undefined> = [];
  const first = gate.promise.then((value) => { received.push(value); });
  const second = gate.promise.then((value) => { received.push(value); });
  await Promise.all([first, second]);
  assert.deepEqual(received, [content, undefined]);
});

test("an out-of-entry consumer poisons authorization rather than relabeling later consumption", async () => {
  let entry = false;
  const gate = nativeDeliveryGate(Promise.resolve(content), () => entry, () => true, (fn) => fn());
  const first = gate.promise.then((value) => value);
  entry = true;
  const second = gate.promise.then((value) => value);
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
});

test("guard failures deny without rejection or native continuation rendering", async () => {
  const gate = nativeDeliveryGate(Promise.resolve(content), () => true,
    () => { throw new Error("guard failed"); }, () => { throw new Error("must not commit"); });
  assert.equal(await gate.promise.then((value) => value), undefined);
});

test("release before extraction resolves prevents later native delivery", async () => {
  let resolve!: (value: NativeContent) => void;
  const source = new Promise<NativeContent>((done) => { resolve = done; });
  const gate = nativeDeliveryGate(source, () => true, () => true, (fn) => fn());
  const received = gate.promise.then((value) => value);
  gate.release(); resolve(content);
  assert.equal(await received, undefined);
});

test("raw rejection reaches native rejection callback unchanged", async () => {
  const error = new Error("native fetch failed");
  const gate = nativeDeliveryGate(Promise.reject(error), () => true, () => true, (fn) => fn());
  await assert.rejects(gate.promise.then((value) => value), (actual) => actual === error);
});

test("guard executes after deliberate carrier-fulfillment gap and before synchronous continuation", async () => {
  let authorized = true;
  const trace: string[] = [];
  const gate = nativeDeliveryGate(Promise.resolve(content), () => true,
    () => { trace.push("guard"); return authorized; }, (fn) => fn());
  // Reaction is ordered before the core's a()/generator.next() continuation.
  void Promise.prototype.then.call(gate.promise, () => { authorized = false; trace.push("off"); });
  await gate.promise.then((value) => { trace.push(value ? "render" : "no-render"); });
  assert.deepEqual(trace, ["off", "guard", "no-render"]);
});

test("native Promise realm is preserved through source.then species", async () => {
  const NativePromise = runInNewContext("Promise") as PromiseConstructor;
  const source = NativePromise.resolve(content);
  let entry = true;
  const gate = nativeDeliveryGate(source, () => entry, () => true, (fn) => fn());
  assert.equal(gate.promise instanceof NativePromise, true);
  assert.equal(gate.promise instanceof Promise, false);
  // The real helper uses core's own Promise, not the plugin's realm.
  const delivery = gate.promise.then((value) => value);
  entry = false;
  assert.equal(await delivery, content);
});

test("wrong native realm adoption invokes then outside handshake and fails closed", async () => {
  const OtherPromise = runInNewContext("Promise") as PromiseConstructor;
  let entry = true;
  const gate = nativeDeliveryGate(Promise.resolve(content), () => entry, () => true, (fn) => fn());
  const adopted = new OtherPromise<NativeContent | undefined>((resolve) => resolve(gate.promise));
  entry = false;
  assert.equal(await adopted, undefined);
});

test("nonstandard species crossing native Promise adoption cannot expose content", async () => {
  const OtherPromise = runInNewContext("Promise") as PromiseConstructor;
  class ChangedSpecies extends Promise<NativeContent | undefined> {
    static get [Symbol.species]() { return OtherPromise; }
  }
  let entry = true;
  const gate = nativeDeliveryGate(new ChangedSpecies((resolve) => resolve(content)),
    () => entry, () => true, (fn) => fn());
  const nativeAdoption = new Promise<NativeContent | undefined>((resolve) => resolve(gate.promise));
  entry = false;
  assert.equal(await nativeAdoption, undefined);
});
