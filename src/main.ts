import { apiVersion, Notice, Platform, Plugin } from 'obsidian';
import {
  installNativeReaderBridge, supportsCoreVersion, SUPPORTED_CORE_VERSION,
  type NativeReaderBridge, type NativeReaderSession,
} from './native-adapter.js';
import { PreferenceStore, type PreferenceProblem } from './preferences.js';
import { AutoReaderSettingsTab } from './settings.js';

export default class QuietCar extends Plugin {
  preferences!: PreferenceStore;
  integrationStatus = 'Native integration has not started.';
  private bridge: NativeReaderBridge | null = null;
  // Only sessions observed in public workspace leaves, never pre-open sessions.
  private sessions = new Map<object, NativeReaderSession>();
  private active = false;
  private queued = false;
  private generation = 0;
  private coreVersion = '';
  private settingsTab?: AutoReaderSettingsTab;
  private lastProblem: PreferenceProblem = null;
  private integrationFault = false;

  async onload(): Promise<void> {
    this.active = true;
    const generation = ++this.generation;
    this.preferences = new PreferenceStore(
      () => this.loadData(),
      data => this.saveData(data),
      state => {
        // The bridge also updates factory-created sessions not yet in workspace leaves.
        try { this.bridge?.setEnabled(state.enabled); }
        catch { this.disposeBridge(); this.reportIntegrationFault(); }
        if (state.problem && state.problem !== this.lastProblem) {
          new Notice(`Quiet Car: ${this.preferenceFeedback()}`);
        }
        this.lastProblem = state.problem;
        this.settingsTab?.refresh();
      },
    );
    await this.preferences.load();
    if (!this.active || generation !== this.generation) return;
    this.coreVersion = apiVersion;
    const available = Platform.isDesktopApp && supportsCoreVersion(this.coreVersion);
    if (available) {
      // Hook factories before layout-ready: never late-attach an existing view.
      this.refreshBridge();
      new Notice('Quiet Car: tabs already open when this plugin is enabled or reloaded remain unmanaged. Manually close and reopen those tabs to opt in; no tabs are automatically reopened.');
    } else {
      this.integrationStatus = `Automatic Reader is unavailable on this platform/core version. Only desktop core ${SUPPORTED_CORE_VERSION} is an inspected candidate. Native controls are untouched.`;
    }
    this.settingsTab = new AutoReaderSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    if (!available) return;
    const workspace = this.app.workspace;
    this.registerEvent(workspace.on('layout-change', () => this.scheduleScan()));
    this.registerEvent(workspace.on('active-leaf-change', () => this.scheduleScan()));
    workspace.onLayoutReady(() => {
      if (this.active && generation === this.generation) this.scheduleScan();
    });
  }

  preferenceFeedback(): string {
    switch (this.preferences.state.problem) {
      case 'load-failed': return 'Could not read the saved preference. Automation is OFF; stored data was not overwritten. Changing the toggle explicitly replaces the preference.';
      case 'invalid': return 'Unrecognized saved preference: automation is OFF. Only an exact {enabled: boolean} value is accepted. Stored data is unchanged until you change the toggle.';
      case 'save-failed': return 'Preference could not be saved. Automation is OFF for this session; the previous stored value may return after reload. Toggle again to retry.';
      default: return this.preferences.state.saving ? 'Saving preference…' : '';
    }
  }

  private refreshBridge(): void {
    try {
      // Null (e.g. core Web Viewer unavailable) may retry on public workspace events only.
      this.bridge ??= installNativeReaderBridge(this.app, this.coreVersion, this.preferences.state.enabled);
      const ready = this.bridge?.refreshFactories() ?? false;
      this.integrationStatus = ready
        ? `Desktop core ${SUPPORTED_CORE_VERSION} prototype: factory guard available for new/reopened views only. Native safety validation is pending.`
        : 'Automatic Reader is unavailable for new views: a safe native Web Viewer factory hook is not available. Existing tabs remain unmanaged; native controls are untouched.';
      if (this.integrationFault) this.integrationStatus += ' An integration error occurred; affected views may remain unmanaged.';
    } catch {
      this.disposeBridge();
      this.reportIntegrationFault();
    }
    this.settingsTab?.refresh();
  }

  private scheduleScan(): void {
    if (!this.active || this.queued) return;
    this.queued = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (!this.active || generation !== this.generation) return;
      this.queued = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    this.refreshBridge();
    const live = new Set<object>();
    for (const leaf of this.app.workspace.getLeavesOfType('webviewer')) {
      const view = leaf.view;
      if (view.getViewType() === 'webviewer') live.add(view);
    }
    for (const view of this.sessions.keys()) {
      if (!live.has(view)) this.removeSession(view);
    }
    for (const view of live) {
      try {
        // Lookup only: unmanaged views are not modified or reported as errors.
        const session = this.bridge?.getSession(view);
        if (session) {
          this.sessions.set(view, session);
          session.refreshBinding();
        }
      } catch {
        this.removeSession(view);
        this.reportIntegrationFault();
      }
    }
  }

  private removeSession(view: object): void {
    const session = this.sessions.get(view);
    this.sessions.delete(view);
    try { session?.dispose(); }
    catch { this.reportIntegrationFault(); }
  }

  private reportIntegrationFault(): void {
    if (!this.active) return;
    this.integrationStatus = 'Native integration could not bind or update a Web Viewer. Automation is unavailable for affected views; native controls are not replaced.';
    if (!this.integrationFault) {
      this.integrationFault = true;
      new Notice('Quiet Car: native integration unavailable for an affected view. See plugin settings.');
    }
    this.settingsTab?.refresh();
  }

  private disposeBridge(): void {
    const bridge = this.bridge;
    this.bridge = null;
    this.sessions.clear();
    try { bridge?.dispose(); }
    catch { this.reportIntegrationFault(); }
  }

  onunload(): void {
    this.active = false;
    ++this.generation;
    this.queued = false;
    this.preferences?.dispose();
    // Bridge owns factory restoration and ALL sessions, including pre-open views.
    this.disposeBridge();
    // Registered workspace events are disposed by Plugin; never change native mode.
  }
}
