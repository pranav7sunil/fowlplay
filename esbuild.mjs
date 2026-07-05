import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** Extension host bundle (Node / CommonJS). */
const extensionCtx = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/** Webview bundle (browser / IIFE) + css. */
const webviewCtx = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'css' },
  sourcemap: true,
  logLevel: 'info',
};

/**
 * Live e2e harness bundle (browser / IIFE). Runs the REAL SessionCore against
 * in-memory ports + a scripted dual-model adapter, installed on window before the
 * webview bundle loads. Built only for the `e2e:coop` journey — not part of the
 * shipped extension.
 */
const liveHostCtx = {
  entryPoints: ['e2e/liveHost.ts'],
  bundle: true,
  outfile: 'dist/liveHost.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(extensionCtx), esbuild.context(webviewCtx)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log('watching…');
} else {
  await Promise.all([
    esbuild.build(extensionCtx),
    esbuild.build(webviewCtx),
    esbuild.build(liveHostCtx),
  ]);
}
