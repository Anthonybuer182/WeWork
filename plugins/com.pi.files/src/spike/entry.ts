/**
 * R1 spike: does ESM + dynamic import() + code splitting actually work under
 * the `pi-plugin://` scheme?
 *
 * This gates the entire build design (decision 3 in the plan). It is
 * deliberately dependency-free — if it fails, the only possible cause is the
 * scheme/module resolution, not an engine or a shim.
 *
 * A static `import` would not prove anything: it is resolved at parse time by
 * the same module graph. The point here is a *runtime* `import()` of a chunk
 * whose URL the bundler emits relative to the entry — that is the mechanism
 * the real build depends on for lazy-loading per-format chunks.
 */
const out = document.createElement('div');
out.id = 'spike-out';
out.style.cssText = 'font:13px ui-monospace,monospace;padding:16px;white-space:pre-wrap';
out.textContent = 'spike: loading chunk…';
document.body.appendChild(out);

function report(status, text) {
  out.dataset.status = status;
  out.textContent = `spike: ${status}\n${text}`;
  // Surfaced through the host's console so CDP can read it from the main target
  // without having to attach to this panel's own target.
  console.log(`[spike] ${status} ${text}`);
}

try {
  const url = new URL('./chunks/', import.meta.url);
  const mod = await import('./lazy.js');
  report('ok', `import.meta.url = ${import.meta.url}\nchunk base    = ${url.href}\nlazy.js says  = ${mod.hello()}`);
} catch (err) {
  report('fail', `import.meta.url = ${import.meta.url}\n${String(err && err.stack ? err.stack : err)}`);
}
