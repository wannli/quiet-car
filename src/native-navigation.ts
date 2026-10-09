import type { NativeNavigationEvent, NativeWebView } from "./native-types.js";

export type NavigationSignal =
  | { type: "begin" | "commit" | "ready" | "failure" | "abort" | "stopped" | "destroy"; url?: string }
  | { type: "route"; url?: string };

/** Electron webview events, scoped to one concrete element. did-navigate is a
 * main-frame document commit, including same-URL reload/back/forward. dom-ready
 * alone is not a visit. In-page navigation is never treated as a new document.
 */
export function listenNativeNavigation(
  element: NativeWebView,
  current: () => boolean,
  receive: (signal: NavigationSignal) => void,
): () => void {
  const listeners: Array<[string, (event: NativeNavigationEvent) => void]> = [];
  const on = (name: string, fn: (event: NativeNavigationEvent) => void) => {
    const listener = (event: NativeNavigationEvent) => { if (current()) fn(event); };
    element.addEventListener(name, listener);
    listeners.push([name, listener]);
  };
  try {
    on("did-start-navigation", (e) => {
      if (e.isMainFrame === true && e.isInPlace !== true) receive({ type: "begin" });
    });
    on("did-navigate", (e) => receive({ type: "commit", url: e.url }));
    on("dom-ready", () => receive({ type: "ready" }));
    on("did-fail-load", (e) => {
      if (e.isMainFrame === true) receive({ type: e.errorCode === -3 ? "abort" : "failure" });
    });
    on("did-stop-loading", () => receive({ type: "stopped" }));
    on("did-navigate-in-page", (e) => {
      if (e.isMainFrame === true) receive({ type: "route", url: e.url });
    });
    on("destroyed", () => receive({ type: "destroy" }));
  } catch (error) {
    for (const [name, listener] of listeners) element.removeEventListener(name, listener);
    throw error;
  }
  return () => {
    for (const [name, listener] of listeners) element.removeEventListener(name, listener);
  };
}
