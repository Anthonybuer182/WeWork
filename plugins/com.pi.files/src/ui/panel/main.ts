/**
 * The file viewer panel: one page, dispatching by extension.
 *
 * The host routes every previewable extension to this plugin's FIRST panel
 * (`findPreviewHandler` returns `panels[0]`), so per-format entries have to be
 * chosen here rather than in the manifest.
 *
 * `.docx` runs GenOffice's own renderer. The other formats still run the
 * previous hand-written previewers — they get ported one at a time, and each
 * port shrinks this dispatch.
 *
 * This module also runs again after a RELOAD, which is how a format switch
 * works: a mounted renderer cannot be swapped for another app in place, so the
 * shim persists the target path and reloads, and we pick the renderer afresh.
 * See `reloadForOtherFormat` in src/ui/shims/common.ts.
 */
import { persistPendingPath, readPersistedPath } from '../shims/common';
import { mountLegacyShell } from './legacy-shell';

/** The last `ui.render` the backend pushed, kept so a late listener can replay it. */
let lastPayload: unknown = null;
const waiters: Array<(p: unknown) => void> = [];

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string } | null;
  if (msg?.event !== 'ui.render') return;
  lastPayload = payload;
  for (const w of waiters.splice(0)) w(payload);
});

function awaitRender(timeoutMs: number): Promise<unknown> {
  if (lastPayload) return Promise.resolve(lastPayload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    waiters.push((p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
}

void (async () => {
  // A reload carries no `ui.render` — the host only sends one when the panel
  // MOUNTS, and this panel never unmounted. So the path the previous load
  // recorded is the only source, and we wait only briefly for a fresh one.
  const persisted = readPersistedPath();
  const payload = (await awaitRender(persisted ? 1200 : 5000)) as { data?: { path?: string } } | null;
  const path = payload?.data?.path ?? persisted;
  if (path) persistPendingPath(path);

  const ext = path.toLowerCase().split('.').pop() ?? '';

  // Handed to whichever renderer loads, so it does not have to re-derive it
  // from a message it may have missed.
  (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__ = path || undefined;

  if (ext === 'docx') {
    await import('../docx/main');
    return;
  }

  if (ext === 'pptx') {
    await import('../slides/main');
    return;
  }

  // Everything else: the previous viewer, until each format is ported.
  // It expects the markup the old panel page provided (`#fName`/`#content`),
  // and its own stylesheet — build both before importing it.
  mountLegacyShell();
  await import('../../main');
  // It listens on `window` for backend frames, which the SDK re-dispatches.
  //
  // Replay the frame we consumed — and on the RELOAD path there is none: the
  // host only pushes `ui.render` when the panel MOUNTS, and a format switch
  // reloads without unmounting. So synthesise the same envelope from the
  // persisted path, or the viewer lands on its empty state every time.
  const envelope = payload ?? (path ? { event: 'ui.render', data: { path } } : null);
  if (envelope) {
    window.postMessage(
      { __piPlugin: true, pluginId: 'com.pi.files', direction: 'backend', payload: envelope },
      '*',
    );
  }
})();
