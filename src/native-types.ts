/** Private, structural core-1.14.4 contract. No runtime host imports. */
export interface NativeContent { md: string; title: string }
export type NativeMethod = (this: NativeView, ...args: unknown[]) => unknown;
export interface NativeWebView {
  /** Electron's current main-frame state, not an injected page probe. */
  isLoadingMainFrame?(): boolean;
  getURL?(): string;
  addEventListener(type: string, listener: (event: NativeNavigationEvent) => void): void;
  removeEventListener(type: string, listener: (event: NativeNavigationEvent) => void): void;
}
export interface NativeNavigationEvent {
  isMainFrame?: boolean;
  isInPlace?: boolean;
  url?: string;
  errorCode?: number;
}
export interface NativeView {
  mode: string;
  webview?: NativeWebView;
  renderer?: unknown;
  getViewType(): string;
  onResize: NativeMethod;
  getReaderModeContent: NativeMethod;
  displayReaderView: NativeMethod;
  displayWebView: NativeMethod;
  toggleReaderMode: NativeMethod;
  instantiateWebView: NativeMethod;
  displayErrorView: NativeMethod;
  displayBlank: NativeMethod;
  navigate: NativeMethod;
  close: NativeMethod;
  unload: NativeMethod;
}
export interface NativeReaderSession {
  setEnabled(enabled: boolean): void;
  refreshBinding(): void;
  dispose(): void;
}
export interface NativeReaderBridge {
  getSession(view: unknown): NativeReaderSession | null;
  setEnabled(enabled: boolean): void;
  refreshFactories(): boolean;
  dispose(): void;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
