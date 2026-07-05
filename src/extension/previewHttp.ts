/**
 * Preview HTTP request logic — pure, no `vscode` / `node:http` (unit-tested).
 *
 * The overlay server serves workspace files over a loopback port. Two concerns
 * live here so they can be tested without a server:
 *  - {@link sanitizePreviewPath}: turn a raw request URL into a safe,
 *    workspace-relative path (or reject it), enforcing the per-server token and
 *    blocking traversal.
 *  - {@link mimeFor}: pick a Content-Type from a path's extension.
 */

/**
 * Strip query/hash, decode, require the `/<token>/` prefix, reject `..`/NUL/
 * backslash; '' resolves to `entryPath`. Returns the workspace-relative path or
 * null (→ 404). The token prefix is the server's only auth, so an absent or wrong
 * token must fail before anything else is considered.
 */
export function sanitizePreviewPath(urlPath: string, token: string, entryPath: string): string | null {
  // Drop query string / fragment.
  let raw = urlPath.split('?')[0].split('#')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }

  const prefix = `/${token}/`;
  if (!decoded.startsWith(prefix)) return null;
  let rel = decoded.slice(prefix.length);

  // Empty (the entry URL itself, e.g. `/<token>/`) serves the entry point.
  if (rel === '') rel = entryPath;

  // Reject traversal, NUL, and backslash outright — the containment check
  // downstream is a backstop, but these never belong in a legitimate request.
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.split('/').some((seg) => seg === '..')) return null;

  // Normalize leading slashes / empty segments to a clean relative path.
  const clean = rel.split('/').filter(Boolean).join('/');
  return clean === '' ? null : clean;
}

/** Content-Type by extension; text types get `; charset=utf-8`. */
export function mimeFor(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const type = MIME[ext];
  if (!type) return 'application/octet-stream';
  return TEXT_TYPES.has(ext) ? `${type}; charset=utf-8` : type;
}

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  md: 'text/plain',
  txt: 'text/plain',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

/** Extensions whose Content-Type should carry a utf-8 charset. */
const TEXT_TYPES = new Set(['html', 'htm', 'svg', 'css', 'js', 'mjs', 'json', 'md', 'txt', 'xml']);
