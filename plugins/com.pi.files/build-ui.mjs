/**
 * com.pi.files UI bundler — engines are vendored as TypeScript source
 * (genoffice publishes no npm builds), so the panel bundles them with esbuild.
 * Output is plain static files under ui/ served by pi-plugin://.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname as __dir } from 'node:path';
const __dirname = __dir(fileURLToPath(import.meta.url));
import { existsSync, rmSync } from 'node:fs';

rmSync('ui-dist/app.js', { force: true });  // keep index.html

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'ui-dist/app.js',
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  legalComments: 'inline',
  // Vendored GenOffice UI is React (e.g. @genoffice/ui/Markdown).
  jsx: 'automatic',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.mjs': 'js',
    // Stylesheets come in as text so the bundle can inject them itself. That
    // keeps the panel to a single <script> — no separate <link> to keep in
    // sync, and no risk of a chunk loading before its stylesheet.
    '.css': 'text',
  },
  // pdf.js worker:静态拷贝到 ui-dist(运行时同源加载)
  outbase: '.',

  inject: ['./src/buffer-shim.ts'],
  // ONE define object. This used to be declared twice — the second literal
  // silently dropped `process.env.NODE_ENV`, which is fatal the moment a
  // bundled dependency reads it (React does, immediately).
  define: {
    'process.env.NODE_ENV': '"production"',
    // jszip / engines reference Buffer and `global` in the browser.
    global: 'globalThis',
  },
  resolveExtensions: ['.tsx', '.ts', '.js'],
  plugins: [{
    name: 'genoffice-workspace',
    setup(build) {
      build.onResolve({ filter: /^@genoffice\// }, (args) => {
        const m = /^@genoffice\/([a-z0-9-]+)(?:\/(.*))?$/.exec(args.path);
        if (!m) return null;
        const [, pkg, sub] = m;
        // The vendor tree mirrors the upstream repo layout
        // (vendor/genoffice/packages/<pkg>/src/...) so that cross-package
        // relative imports inside vendored code resolve unchanged.
        const base = `${__dirname}/vendor/genoffice/packages/${pkg}/src`;
        const rel = sub ?? 'index';
        // Try .tsx before .ts: genoffice's UI package is React, and a subpath
        // like `@genoffice/ui/Markdown` has no extension to go on.
        for (const ext of ['.tsx', '.ts']) {
          const p = `${base}/${rel}${ext}`;
          if (existsSync(p)) return { path: p };
        }
        return { path: `${base}/${rel}.ts` };
      });
    },
  }, {
    name: 'node-builtin-shim',
    setup(build) {
      // The browser bundle reaches exactly two node builtins that have a real
      // browser equivalent. They are shimmed with ACTUAL implementations: the
      // previous version stubbed everything to no-ops, including deflateSync
      // returning an empty buffer and createHash returning a constant — silent
      // data corruption, not a loud failure.
      build.onResolve({ filter: /^node:(zlib|crypto)$/ }, (args) => ({
        path: args.path,
        namespace: 'node-shim',
      }));
      build.onLoad({ filter: /^node:zlib$/, namespace: 'node-shim' }, () => ({
        resolveDir: __dirname,
        contents:
          "import { deflateSync, inflateSync, gzipSync, gunzipSync } from 'fflate';" +
          "export { deflateSync, inflateSync, gzipSync, gunzipSync };" +
          "export const deflateRawSync = deflateSync;" +
          "export const inflateRawSync = inflateSync;" +
          "export const constants = {};",
        loader: 'js',
      }));
      build.onLoad({ filter: /^node:crypto$/, namespace: 'node-shim' }, () => ({
        resolveDir: __dirname,
        contents:
          "import { sha256 as _sha256 } from '@noble/hashes/sha2.js';" +
          "import { sha1 as _sha1 } from '@noble/hashes/legacy.js';" +
          "const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');" +
          "export function createHash(alg) {" +
          "  const h = String(alg).toLowerCase() === 'sha1' ? _sha1 : _sha256;" +
          "  let acc = new Uint8Array(0);" +
          "  return { update(d) { const b = typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d);" +
          "           const n = new Uint8Array(acc.length + b.length); n.set(acc); n.set(b, acc.length); acc = n; return this; }," +
          "           digest() { return toHex(h(acc)); } };" +
          "}" +
          "export const randomUUID = () => crypto.randomUUID();" +
          "export const getRandomValues = (a) => crypto.getRandomValues(a);",
        loader: 'js',
      }));

      // Everything else is backend-only. These are stubbed to THROW on use
      // rather than to fail the build, because the engines reach them from
      // lazily-called helpers that the browser never invokes (e.g.
      // pptx-engine's savePptxToFile, reachable only via the barrel). A no-op
      // stub here would be the corruption bug again; a throw is loud at the
      // exact call site, and a Proxy makes even a missed member name throw
      // instead of silently yielding undefined.
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        namespace: 'node-backend',
      }));
      build.onLoad({ filter: /.*/, namespace: 'node-backend' }, (args) => {
        const spec = JSON.stringify(args.path);
        const names = [
          'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'existsSync', 'mkdirSync',
          'statSync', 'createWriteStream', 'createReadStream', 'promises', 'readdirSync',
          'join', 'resolve', 'dirname', 'basename', 'extname', 'relative', 'sep', 'posix',
          'homedir', 'tmpdir', 'platform', 'spawn', 'exec', 'execSync', 'createRequire',
          'require', 'cwd', 'env',
        ];
        return {
          resolveDir: __dirname,
          loader: 'js',
          contents:
            `const spec = ${spec};` +
            "function boom(name) {" +
            "  const f = function () { throw new Error('node builtin ' + spec + ' (' + name + ') is not available in the browser bundle — move this code to the plugin backend'); };" +
            "  return new Proxy(f, { get: (t, k) => (typeof k === 'symbol' || k === 'then' ? undefined : boom(name + '.' + String(k))) });" +
            "}" +
            names.map((n) => `export const ${n} = boom(${JSON.stringify(n)});`).join('\n') +
            "\nexport default boom('default');",
        };
      });
    },
  }],
  logLevel: 'info',
});
console.log('bundled → ui-dist/app.js');
