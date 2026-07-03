/**
 * SettingsStore — the session's {@link SettingsPort}.
 *
 * Appearance and harness settings live in `workspace.getConfiguration('fowlplay')`
 * (so they participate in VS Code's settings UI / sync). Providers (WITHOUT keys)
 * and the default model live in a JSON blob under `context.globalStorageUri`,
 * because provider lists are structured data that does not belong in settings.json.
 * Loading is schema-tolerant.
 */

import * as vscode from 'vscode';
import type {
  AppearanceSettings,
  FowlPlaySettings,
  HarnessSettings,
  ModelRef,
  ProviderConfig,
  ThemeName,
} from '../shared/types';
import type { SettingsPort } from './session';

interface ProvidersBlob {
  providers: ProviderConfig[];
  defaultModel: ModelRef | null;
}

const THEMES: ThemeName[] = ['inherit', 'fowlplay-dark', 'fowlplay-light', 'fowlplay-midnight'];

export class SettingsStore implements SettingsPort {
  private readonly blobUri: vscode.Uri;

  constructor(globalStorage: vscode.Uri) {
    this.blobUri = vscode.Uri.joinPath(globalStorage, 'providers.json');
  }

  async load(): Promise<FowlPlaySettings> {
    const cfg = vscode.workspace.getConfiguration('fowlplay');
    const appearance: AppearanceSettings = {
      fontFamily: cfg.get<string>('appearance.fontFamily', 'JetBrains Mono'),
      fontScale: cfg.get<number>('appearance.fontScale', 1),
      theme: normalizeTheme(cfg.get<string>('appearance.theme', 'inherit')),
    };
    const harness: HarnessSettings = {
      defaultMode: cfg.get<string>('harness.defaultMode', 'coop') === 'solo' ? 'solo' : 'coop',
      qasRetryBudget: cfg.get<number>('harness.qasRetryBudget', 2),
    };
    const blob = await this.readBlob();
    return { appearance, harness, providers: blob.providers, defaultModel: blob.defaultModel };
  }

  async saveAppearance(a: AppearanceSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fowlplay');
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update('appearance.fontFamily', a.fontFamily, target);
    await cfg.update('appearance.fontScale', a.fontScale, target);
    await cfg.update('appearance.theme', a.theme, target);
  }

  async saveHarness(h: HarnessSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('fowlplay');
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update('harness.defaultMode', h.defaultMode, target);
    await cfg.update('harness.qasRetryBudget', h.qasRetryBudget, target);
  }

  async saveProviders(providers: ProviderConfig[]): Promise<void> {
    const blob = await this.readBlob();
    await this.writeBlob({ ...blob, providers });
  }

  async saveDefaultModel(model: ModelRef | null): Promise<void> {
    const blob = await this.readBlob();
    await this.writeBlob({ ...blob, defaultModel: model });
  }

  /** Wipe providers + default model (keys are cleared separately by the caller). */
  async clearProviders(): Promise<void> {
    await this.writeBlob({ providers: [], defaultModel: null });
  }

  private async readBlob(): Promise<ProvidersBlob> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.blobUri);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProvidersBlob>;
      return {
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        defaultModel: parsed.defaultModel ?? null,
      };
    } catch {
      return { providers: [], defaultModel: null };
    }
  }

  private async writeBlob(blob: ProvidersBlob): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.blobUri, '..'));
    } catch {
      /* exists */
    }
    await vscode.workspace.fs.writeFile(this.blobUri, new TextEncoder().encode(JSON.stringify(blob, null, 2)));
  }
}

function normalizeTheme(value: string): ThemeName {
  return (THEMES as string[]).includes(value) ? (value as ThemeName) : 'inherit';
}
