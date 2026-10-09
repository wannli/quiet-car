import type { NativeContent } from "./native-types.js";

/** Core 1.14.4's y() helper (app.js 252926) adopts an instanceof-Promise
 * value and calls .then(a,s); a synchronously resumes the native generator.
 * ONLY that direct, single-consumer handshake is authorized. Intrinsic promise
 * fulfillment is always undefined, so native await, another realm's adoption,
 * a species conversion, or bypassing our own .then cannot leak article data.
 */
export function nativeDeliveryGate(
  source: Promise<NativeContent | undefined>,
  inNativeEntry: () => boolean,
  authorize: (content: NativeContent | undefined) => boolean,
  commit: (continuation: () => unknown) => unknown,
): { promise: Promise<NativeContent | undefined>; release(): void } {
  let content: NativeContent | undefined;
  let consumed = false;
  let released = false;
  const carrier = source.then((value) => {
    if (!released) content = value;
    return undefined;
  });
  const then = carrier.then;
  const release = () => { released = true; content = undefined; };
  Object.defineProperty(carrier, "then", {
    configurable: true,
    value: function (
      fulfilled?: ((value: NativeContent | undefined) => unknown) | null,
      rejected?: ((reason: unknown) => unknown) | null,
    ) {
      let direct = false;
      try { direct = !consumed && inNativeEntry(); } catch { /* Unknown entry denies. */ }
      consumed = true;
      return then.call(carrier, () => {
        let allowed = false;
        if (direct && !released) {
          try { allowed = authorize(content); } catch { /* Deny, never throw a guard. */ }
        }
        const value = allowed ? content : undefined;
        release();
        if (!fulfilled) return undefined;
        // The inspected core callback catches generator exceptions itself.
        return allowed ? commit(() => fulfilled(value)) : fulfilled(undefined);
      }, rejected);
    },
  });
  return { promise: carrier, release };
}

/** Observe failures without changing the original return value or rejection. */
export function observeSettlement(
  value: unknown, settled: () => void, failed: () => void = () => {},
): void {
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    void (value as PromiseLike<unknown>).then(settled, () => {
      try { failed(); } catch { /* Observers must not create unhandled rejections. */ }
      settled();
    });
  } else settled();
}
