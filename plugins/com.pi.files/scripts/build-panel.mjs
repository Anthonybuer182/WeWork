#!/usr/bin/env node
/**
 * Build the file-viewer panel.
 *
 * One page, dispatching by extension: `.docx` loads GenOffice's own renderer,
 * everything else still loads the previous previewers until each is ported.
 *
 * ESM with code splitting, not a single IIFE: GenOffice's renderer plus 30 font
 * files is ~6 MB, and 95% of panel opens are not a docx. A single bundle would
 * make every open pay for the parser to read it.
 *
 * Three things make this more than a bundling job:
 *
 *  1. **`./ai/AiPanel` is aliased to ours.** GenOffice's panel drives its own
 *     agent; ours sends to the host agent. Every other file of the 277 is
 *     compiled as vendored, unmodified.
 *
 *  2. **CSS is injected, not emitted.** GenOffice's entry does
 *     `import '@genoffice/ui/tokens.css'` and expects the bundler to make it
 *     real. esbuild would emit a sibling .css that nothing links, so a plugin
 *     turns each stylesheet into a module that appends a <style> on first
 *     evaluation.
 *
 *  3. **Font URLs are rewritten to root-absolute.** Inlined CSS resolves
 *     `url(...)` against the DOCUMENT, not the stylesheet's original location,
 *     so `url('./Caladea-Bold.ttf')` would 404. Rewriting to `/fonts/...` makes
 *     it independent of where the CSS ends up — `/` is the plugin origin root
 *     under pi-plugin://.
 *
 * Run from the plugin root:  node scripts/build-docx.mjs
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(ROOT, 'vendor', 'genoffice');
const DOCS = join(VENDOR, 'apps', 'docs', 'src', 'renderer');
const OUT = join(ROOT, 'ui-dist', 'panel');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/**
 * GenOffice imports that this plugin deliberately answers with its own code.
 *
 * Checked BEFORE the vendored-package resolver, so these win. Two reasons a
 * name lands here rather than in vendor/: the barrel would drag in a second
 * React copy and GenOffice's AI composer (ui), or the module is GenOffice's own
 * agent/provider, which the host replaces.
 */
const shimSwap = {
  name: 'shim-swap',
  setup(b) {
    const SHIMS = new Map([
      ['@genoffice/ai-provider', 'ai-provider.ts'],
      ['@genoffice/ai-provider/browser', 'ai-provider.ts'],
      ['@genoffice/electron-utils/headless-export', 'electron-utils.ts'],
      // Type-only everywhere it appears (the two `ai/*-skill.ts` files).
      ['@genoffice/agent-core', 'agent-core.ts'],
    ]);
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      const shim = SHIMS.get(args.path);
      if (!shim) return null;
      return { path: join(ROOT, 'src', 'ui', 'docx', 'shims', shim) };
    });
  },
};

/** Resolve @genoffice/<pkg>[/<sub>] against the vendored mirror. */
const genofficeResolver = {
  name: 'genoffice',
  setup(b) {
    b.onResolve({ filter: /^@genoffice\// }, (args) => {
      // [a-z0-9-] not [a-z-]: the i18n package has a digit in its name, and a
      // digits-free pattern silently fails to resolve it.
      const m = /^@genoffice\/([a-z0-9-]+)(?:\/(.*))?$/.exec(args.path);
      if (!m) return null;
      const [, pkg, sub] = m;
      const base = join(VENDOR, 'packages', pkg, 'src');
      if (!sub) return { path: join(base, 'index.ts') };
      // The subpath may already carry its extension (`@genoffice/ui/tokens.css`),
      // in which case appending another one produces `tokens.css.ts`.
      if (/\.[a-z0-9]+$/i.test(sub)) return { path: join(base, sub) };
      for (const ext of ['.tsx', '.ts', '.css', '.json']) {
        const p = join(base, `${sub}${ext}`);
        if (existsSync(p)) return { path: p };
      }
      return { path: join(base, `${sub}.ts`) };
    });
  },
};

/** Vite-style `?raw` imports (used by the op catalogs). */
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-text',
    }));
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({
      contents: readFileSync(args.path, 'utf-8'),
      loader: 'text',
    }));
  },
};

/** Our panel replaces GenOffice's. */
const aiPanelSwap = {
  name: 'ai-panel-swap',
  setup(b) {
    b.onResolve({ filter: /(^|\/)ai\/AiPanel$/ }, () => ({
      path: join(ROOT, 'src', 'ui', 'docx', 'AiPanel.tsx'),
    }));
  },
};

/**
 * Node builtins in a browser bundle.
 *
 * Two of them have real browser equivalents and are shimmed with ACTUAL
 * implementations — a no-op `deflateSync` or a constant `createHash` is silent
 * data corruption, which is what this replaced. Everything else is backend-only
 * and throws on use, so a genuine mistake is loud at the call site rather than
 * yielding an empty buffer somewhere downstream.
 */
const nodeBuiltins = {
  name: 'node-builtins',
  setup(b) {
    b.onResolve({ filter: /^node:(zlib|crypto)$/ }, (args) => ({ path: args.path, namespace: 'node-shim' }));
    b.onLoad({ filter: /^node:zlib$/, namespace: 'node-shim' }, () => ({
      resolveDir: ROOT,
      loader: 'js',
      contents:
        "import { deflateSync, inflateSync, gzipSync, gunzipSync } from 'fflate';" +
        'export { deflateSync, inflateSync, gzipSync, gunzipSync };' +
        'export const deflateRawSync = deflateSync;' +
        'export const inflateRawSync = inflateSync;' +
        'export const constants = {};',
    }));
    b.onLoad({ filter: /^node:crypto$/, namespace: 'node-shim' }, () => ({
      resolveDir: ROOT,
      loader: 'js',
      contents:
        "import { sha256 as _sha256 } from '@noble/hashes/sha2.js';" +
        "import { sha1 as _sha1 } from '@noble/hashes/legacy.js';" +
        "const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');" +
        'export function createHash(alg) {' +
        "  const h = String(alg).toLowerCase() === 'sha1' ? _sha1 : _sha256;" +
        '  let acc = new Uint8Array(0);' +
        '  return { update(d) { const b = typeof d === \'string\' ? new TextEncoder().encode(d) : new Uint8Array(d);' +
        '           const n = new Uint8Array(acc.length + b.length); n.set(acc); n.set(b, acc.length); acc = n; return this; },' +
        "           digest() { return toHex(h(acc)); } };" +
        '}' +
        'export const randomUUID = () => crypto.randomUUID();' +
        'export const getRandomValues = (a) => crypto.getRandomValues(a);',
    }));
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'node-backend' }));
    b.onLoad({ filter: /.*/, namespace: 'node-backend' }, (args) => {
      const spec = JSON.stringify(args.path);
      const names = [
        'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'existsSync', 'mkdirSync',
        'statSync', 'createWriteStream', 'createReadStream', 'promises', 'readdirSync',
        'join', 'resolve', 'dirname', 'basename', 'extname', 'relative', 'sep', 'posix',
        'homedir', 'tmpdir', 'platform', 'spawn', 'exec', 'execSync', 'createRequire',
        'require', 'cwd', 'env',
      ];
      return {
        resolveDir: ROOT,
        loader: 'js',
        contents:
          `const spec = ${spec};` +
          'function boom(name) {' +
          "  const f = function () { throw new Error('node builtin ' + spec + ' (' + name + ') is not available in the browser bundle — move this code to the plugin backend'); };" +
          "  return new Proxy(f, { get: (t, k) => (typeof k === 'symbol' || k === 'then' ? undefined : boom(name + '.' + String(k))) });" +
          '}' +
          names.map((n) => `export const ${n} = boom(${JSON.stringify(n)});`).join('\n') +
          "\nexport default boom('default');",
      };
    });
  },
};

/**
 * Turn stylesheet imports into self-injecting modules, rewriting relative font
 * URLs to root-absolute ones (see the header note).
 */
const cssInject = {
  name: 'css-inject',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, (args) => {
      let css = readFileSync(args.path, 'utf-8');
      css = css.replace(/url\(\s*(['"]?)\.\/([^'")]+)\1\s*\)/g, (_m, _q, file) => `url('/fonts/${file}')`);
      return {
        loader: 'js',
        resolveDir: dirname(args.path),
        contents:
          `const css = ${JSON.stringify(css)};\n` +
          `if (!document.querySelector('style[data-pi-css="' + ${JSON.stringify(args.path)} + '"]')) {\n` +
          `  const el = document.createElement('style');\n` +
          `  el.setAttribute('data-pi-css', ${JSON.stringify(args.path)});\n` +
          `  el.textContent = css;\n` +
          `  document.head.appendChild(el);\n` +
          `}\n` +
          `export default css;\n`,
      };
    });
  },
};

const result = await build({
  entryPoints: [join(ROOT, 'src', 'ui', 'panel', 'main.ts')],
  outdir: OUT,
  bundle: true,
  splitting: true,
  format: 'esm',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  metafile: true,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  inject: [join(ROOT, 'src', 'buffer-shim.ts')],
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.mjs': 'js',
    '.ttf': 'file',
    '.woff2': 'file',
    '.woff': 'file',
    '.otf': 'file',
    // Ribbon icons are imported as URLs. Emitted next to main.js, which is the
    // same directory the panel is served from, so the relative URL resolves.
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.gif': 'file',
    '.svg': 'file',
    '.webp': 'file',
  },
  assetNames: 'assets/[name]-[hash]',
  resolveExtensions: ['.tsx', '.ts', '.js'],
  plugins: [aiPanelSwap, shimSwap, genofficeResolver, rawText, cssInject, nodeBuiltins],
});

// Fonts: the layout-fidelity payload. Served at /fonts/* so the rewritten
// url()s resolve.
const fontsSrc = join(DOCS, 'fonts');
const fontsDst = join(OUT, 'fonts');
if (existsSync(fontsSrc)) {
  mkdirSync(fontsDst, { recursive: true });
  let n = 0;
  for (const f of readdirSync(fontsSrc)) {
    if (['.ttf', '.woff2', '.otf', '.woff'].includes(extname(f).toLowerCase())) {
      copyFileSync(join(fontsSrc, f), join(fontsDst, f));
      n++;
    }
  }
  console.log(`[panel] copied ${n} font file(s) → ui-dist/panel/fonts/`);
}

// pdf.js worker: the legacy previewer loads it same-origin at runtime. It used
// to be a hand-committed 1.4 MB file, which meant `ui-dist/` was not
// reproducible from a clean checkout. Copy it from the installed package.
const pdfWorker = join(ROOT, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
if (existsSync(pdfWorker)) {
  copyFileSync(pdfWorker, join(OUT, 'pdf.worker.min.mjs'));
  console.log('[panel] copied pdf.worker.min.mjs');
}

// The panel HTML lives in src/, not ui-dist/: this script wipes ui-dist/panel
// on every build, and a hand-written file in there lasts exactly one build.
copyFileSync(join(ROOT, 'src', 'ui', 'panel', 'index.html'), join(OUT, 'index.html'));

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[panel] bundled → ui-dist/panel/ (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
