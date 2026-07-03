/**
 * Typed postMessage client. Uses the VS Code webview API when running inside
 * the extension host, otherwise falls back to a mock bridge on
 * `window.__fowlplayBridge` (provided by the e2e harness).
 */
import type { WebviewBridge, WebviewToHost, HostToWebview } from '../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    __fowlplayBridge?: WebviewBridge;
  }
}

/** Bridge backed by acquireVsCodeApi() + window 'message' events. */
class VsCodeBridge implements WebviewBridge {
  private readonly api: VsCodeApi;
  constructor(api: VsCodeApi) {
    this.api = api;
  }
  post(msg: WebviewToHost): void {
    this.api.postMessage(msg);
  }
  onMessage(handler: (msg: HostToWebview) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data as HostToWebview);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }
}

let cached: WebviewBridge | null = null;

export function getBridge(): WebviewBridge {
  if (cached) return cached;
  if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
    cached = new VsCodeBridge(window.acquireVsCodeApi());
  } else if (typeof window !== 'undefined' && window.__fowlplayBridge) {
    cached = window.__fowlplayBridge;
  } else {
    // Inert fallback so the bundle never crashes if loaded bare.
    cached = {
      post: () => {},
      onMessage: () => () => {},
    };
  }
  return cached;
}
