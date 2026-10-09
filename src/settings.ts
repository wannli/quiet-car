import { App, PluginSettingTab, Setting, type ToggleComponent } from 'obsidian';
import type QuietCar from './main.js';

export class AutoReaderSettingsTab extends PluginSettingTab {
  private feedback?: HTMLElement;
  private integration?: HTMLElement;
  private toggle?: ToggleComponent;

  constructor(app: App, private readonly host: QuietCar) {
    super(app, host);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('Automatically use Reader Mode')
      .setDesc('For managed new/reopened Web Viewer tabs, ON applies to subsequent full-document loads/navigation, not the current page. SPA route changes are not automated; use the native Reader button. OFF stops automation without leaving Reader mode. Manual choices, native controls, and content are unchanged.')
      .addToggle(toggle => {
        this.toggle = toggle;
        toggle.setValue(this.host.preferences.state.requestedEnabled)
          .onChange(async enabled => { await this.host.preferences.setEnabled(enabled); });
      });
    this.containerEl.createEl('p', {
      text: 'Tabs already open when this plugin is enabled or reloaded remain unmanaged. Manually close and reopen those tabs after the factory guard becomes available to opt in. This plugin never automatically closes, reopens, or reloads tabs.',
    });
    this.integration = this.containerEl.createEl('p');
    this.feedback = this.containerEl.createEl('p', { attr: { 'aria-live': 'polite' } });
    this.containerEl.createEl('p', {
      text: 'Unsupported pages may show Obsidian’s native Reader notice and remain in their native page view. This plugin does not enable Web Viewer or redirect external links. Desktop only; no mobile support.',
    });
    this.refresh();
  }

  refresh(): void {
    this.integration?.setText(this.host.integrationStatus);
    this.feedback?.setText(this.host.preferenceFeedback());
    this.toggle?.setValue(this.host.preferences.state.requestedEnabled);
  }
}
