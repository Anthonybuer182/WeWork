#!/usr/bin/env node
/**
 * Build the docx editor panel — GenOffice's docs renderer, in our plugin.
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
const OUT = join(ROOT, 'ui-dist', 'docx');

rmSync(join(OUT, 'main.js'), { force: true });
rmSync(join(OUT, 'fonts'), { recursive: true, force: true });

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
      ['@genoffice/ui', 'ui-lite.ts'],
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
  entryPoints: [join(ROOT, 'src', 'ui', 'docx', 'main.tsx')],
  outfile: join(OUT, 'main.js'),
  bundle: true,
  format: 'iife',
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
  plugins: [aiPanelSwap, shimSwap, genofficeResolver, rawText, cssInject],
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
  console.log(`[docx] copied ${n} font file(s) → ui-dist/docx/fonts/`);
}

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[docx] bundled → ui-dist/docx/main.js (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
