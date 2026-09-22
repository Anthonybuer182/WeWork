/**
 * R1 spike build: a two-module ESM bundle with code splitting.
 *
 * Run from the plugin root:  node build-spike.mjs
 * Then open the `esm-spike` panel (see manifest.json) and read the result.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('ui-dist/spike/chunks', { recursive: true, force: true });

const result = await build({
  entryPoints: { entry: 'src/spike/entry.ts' },
  outdir: 'ui-dist/spike',
  bundle: true,
  splitting: true, // ← the thing under test: unsupported under IIFE
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: false, // keep the output readable while spiking
  metafile: true,
  logLevel: 'info',
});

// Print what got emitted + the chunk reference, so a failure is diagnosable
// without attaching a debugger.
for (const [file, info] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${file}  ${info.bytes} bytes${info.entryPoint ? '  (entry)' : ''}`);
}
