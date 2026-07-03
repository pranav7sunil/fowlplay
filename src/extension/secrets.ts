/**
 * Secrets — thin wrapper over VS Code SecretStorage for provider API keys.
 * Keys are stored under `fowlplay.apiKey.${providerId}` and never leave the machine.
 */

import * as vscode from 'vscode';
import type { SecretsPort } from './session';

const PREFIX = 'fowlplay.apiKey.';

export class SecretsStore implements SecretsPort {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(providerId: string): string {
    return `${PREFIX}${providerId}`;
  }

  get(providerId: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(this.key(providerId)));
  }

  set(providerId: string, key: string): Promise<void> {
    return Promise.resolve(this.secrets.store(this.key(providerId), key));
  }

  delete(providerId: string): Promise<void> {
    return Promise.resolve(this.secrets.delete(this.key(providerId)));
  }
}
