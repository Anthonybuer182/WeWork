/**
 * com.pi.files UI bundler — engines are vendored as TypeScript source
 * (genoffice publishes no npm builds), so the panel bundles them with esbuild.
 * Output is plain static files under ui/ served by pi-plugin://.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname as __dir } from 'node:path';
const __dirname = __dir(fileURLToPath(import.meta.url));
import { rmSync } from 'node:fs';

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
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.ts': 'ts',
    '.mjs': 'js',
  },
  // pdf.js worker:静态拷贝到 ui-dist(运行时同源加载)
  outbase: '.',

  inject: ['./src/buffer-shim.ts'],
  define: {
    // jszip / engines reference Buffer in the browser; alias it to Uint8Array-based shim
    'global': 'globalThis',
  },
  resolveExtensions: ['.ts', '.js'],
  plugins: [{
    name: 'genoffice-workspace',
    setup(build) {
      build.onResolve({ filter: /^@genoffice\// }, (args) => {
        const m = /^@genoffice\/([a-z-]+)(?:\/(.*))?$/.exec(args.path);
        if (!m) return null;
        const [, pkg, sub] = m;
        const rel = sub ? `${sub}.ts` : 'index.ts';
        return { path: `${__dirname}/vendor/${pkg}/src/${rel}` };
      });
    },
  }, {
    name: 'node-builtin-stub',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        namespace: 'node-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
        contents: "export default undefined;" +
          "export const createHash = () => ({ update: () => ({ digest: () => '' }) });" +
          "export const randomUUID = () => crypto.randomUUID();" +
          "export const deflateSync = () => new Uint8Array(0);" +
          "export const inflateSync = () => new Uint8Array(0);" +
          "export function createWriteStream() { return { on() {}, end() {} }; }" +
          "export const readFileSync = () => Buffer.alloc(0);" +
          "export const existsSync = () => false;",
        loader: 'js',
      }));
    },
  }],
  logLevel: 'info',
});
console.log('bundled → ui-dist/app.js');
