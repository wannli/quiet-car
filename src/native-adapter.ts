import { NativePatches } from "./native-patches.js";
import { provisionNativeSession, type ManagedNativeSession } from "./native-session.js";
import { record, type NativeReaderBridge, type NativeReaderSession } from "./native-types.js";

export type { NativeReaderBridge, NativeReaderSession } from "./native-types.js";
export const SUPPORTED_CORE_VERSION = "1.14.4";
export function supportsCoreVersion(version: string): boolean {
  return version === SUPPORTED_CORE_VERSION;
}

type Creator = (this: unknown, ...args: unknown[]) => unknown;
interface Slots {
  core: Record<string, unknown>;
  stored: Record<string, unknown>;
  registry: Record<string, unknown>;
}
function slots(app: unknown): Slots | null {
  if (!record(app) || !record(app.internalPlugins) || !record(app.viewRegistry)) return null;
  const manager = app.internalPlugins;
  if (typeof manager.getPluginById !== "function") return null;
  const core: unknown = manager.getPluginById("webviewer");
  if (!record(core) || typeof core.enabled !== "boolean" || !record(core.views)
    || !record(app.viewRegistry.viewByType)) return null;
  return { core, stored: core.views, registry: app.viewRegistry.viewByType };
}

/** Desktop gating belongs to the host. Existing views are deliberately unmanaged.
 * Only the two inspected WebViewer factory data slots are changed. No registry
 * API is invoked: register/unregister would reopen existing tabs in this core.
 */
export function installNativeReaderBridge(
  app: unknown, coreVersion: string, enabled: boolean,
): NativeReaderBridge | null {
  if (!supportsCoreVersion(coreVersion)) return null;
  try {
    const found = slots(app);
    if (!found || !found.core.enabled || typeof found.stored.webviewer !== "function"
      || found.registry.webviewer !== found.stored.webviewer
      || Object.getOwnPropertyDescriptor(found.stored, "webviewer")?.value !== found.stored.webviewer
      || Object.getOwnPropertyDescriptor(found.registry, "webviewer")?.value !== found.registry.webviewer
      || !NativePatches.writable(found.stored, "webviewer")
      || !NativePatches.writable(found.registry, "webviewer")) return null;
    return new Bridge(app, found, found.stored.webviewer as Creator, enabled);
  } catch { return null; }
}

class Bridge implements NativeReaderBridge {
  private readonly patches = new NativePatches();
  private readonly sessions = new Map<unknown, ManagedNativeSession>();
  private dead = false;
  private readonly creator: Creator;

  constructor(private readonly app: unknown, private readonly captured: Slots,
    original: Creator, private enabled: boolean) {
    const bridge = this;
    this.creator = function (this: unknown, ...args: unknown[]) {
      // Preserve native factory receiver, arguments, return value, and errors.
      const view = original.apply(this, args);
      if (!bridge.dead && bridge.refreshFactories()) {
        const session = provisionNativeSession(view, bridge.enabled, () => bridge.sessions.delete(view));
        if (session) bridge.sessions.set(view, session);
      }
      return view;
    };
    try {
      this.patches.install(captured.stored, "webviewer", this.creator);
      this.patches.install(captured.registry, "webviewer", this.creator);
    } catch (error) { this.patches.restore(); throw error; }
  }

  getSession(view: unknown): NativeReaderSession | null {
    const session = this.sessions.get(view);
    return !this.dead && session && !session.disposed ? session : null;
  }

  setEnabled(enabled: boolean): void {
    if (this.dead) return;
    this.enabled = enabled;
    for (const session of this.sessions.values()) session.setEnabled(enabled);
  }

  refreshFactories(): boolean {
    if (this.dead) return false;
    try {
      const now = slots(this.app);
      if (!now || now.core !== this.captured.core || now.stored !== this.captured.stored
        || now.registry !== this.captured.registry || now.stored.webviewer !== this.creator) {
        this.dispose();
        return false;
      }
      // Core disable deletes only the registry slot; enable copies stored to it.
      // Do not rewrite absent slots or accept arbitrary replacement factories.
      if (now.registry.webviewer !== undefined && now.registry.webviewer !== this.creator) {
        this.dispose();
        return false;
      }
      if (now.registry.webviewer === undefined || now.core.enabled === false) {
        for (const session of [...this.sessions.values()]) session.dispose();
        return false;
      }
      return now.core.enabled === true;
    } catch { this.dispose(); return false; }
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    for (const session of [...this.sessions.values()]) session.dispose();
    this.sessions.clear();
    // If core copied our creator back after re-enable, its identity is the same
    // and this restores native. Missing or later-owned slots are left untouched.
    this.patches.restore();
  }
}
