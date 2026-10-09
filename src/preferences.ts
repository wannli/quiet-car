export interface Preferences { enabled: boolean }
export type PreferenceProblem = 'invalid' | 'load-failed' | 'save-failed' | null;
export interface PreferenceState {
  /** Effective automation state; ON waits for the latest successful save. */
  enabled: boolean;
  /** Toggle display: latest intent while saving, effective state after failure. */
  requestedEnabled: boolean;
  problem: PreferenceProblem;
  saving: boolean;
}

export function decodePreferences(data: unknown): PreferenceState {
  if (data === null || data === undefined) {
    return { enabled: true, requestedEnabled: true, problem: null, saving: false };
  }
  if (typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).length === 1 && Object.hasOwn(data, 'enabled')
    && typeof (data as Preferences).enabled === 'boolean') {
    return { enabled: (data as Preferences).enabled, requestedEnabled: (data as Preferences).enabled, problem: null, saving: false };
  }
  return { enabled: false, requestedEnabled: false, problem: 'invalid', saving: false };
}

/** No automatic writes on load, including malformed or unreadable storage. */
export class PreferenceStore {
  state: PreferenceState = { enabled: false, requestedEnabled: false, problem: null, saving: false };
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (data: Preferences) => Promise<void>,
    private readonly changed: (state: Readonly<PreferenceState>) => void = () => {},
  ) {}

  async load(): Promise<void> {
    let state: PreferenceState;
    try { state = decodePreferences(await this.read()); }
    catch { state = { enabled: false, requestedEnabled: false, problem: 'load-failed', saving: false }; }
    if (!this.disposed) this.publish(state);
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const revision = ++this.revision;
    // OFF is immediate; ON is effective only after its latest save succeeds.
    this.publish({ ...this.state, enabled: enabled && this.state.enabled, requestedEnabled: enabled, saving: true });
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await this.write({ enabled });
        if (!this.disposed && revision === this.revision) {
          this.publish({ enabled, requestedEnabled: enabled, problem: null, saving: false });
        }
      } catch {
        if (!this.disposed && revision === this.revision) {
          this.publish({ enabled: false, requestedEnabled: false, problem: 'save-failed', saving: false });
        }
      }
    });
    return this.queue;
  }

  dispose(): void { this.disposed = true; ++this.revision; }

  private publish(state: PreferenceState): void {
    this.state = state;
    this.changed(state);
  }
}
