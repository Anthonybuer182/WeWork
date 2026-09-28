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
// Removes GenOffice's AI surface (sidebar, ribbon group, canvas bar, ask
// popover) from every renderer this page loads. Must be part of the entry chunk:
// the renderers arrive via dynamic import, and this has to be in <head> by then.
import '../ai/strip-genoffice-ai.css';

import { persistPendingPath, readPersistedPath } from '../shims/common';
import { mountEmptyState } from './empty-state';
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
  // A reload already knows which file it is for: `reloadForOtherFormat` wrote
  // the path before navigating (see shims/common.ts). So it dispatches at once
  // instead of waiting for a fresh `ui.render` — the host does not re-raise
  // `panel.mounted` when the open params are unchanged, so that wait always ran
  // to its full timeout and cost a flat 1.2s on every file switch, for a
  // message that never came. If a newer render does arrive, the loaded
  // renderer handles it exactly as it handles any other switch.
  const payload = persisted
    ? null
    : ((await awaitRender(5000)) as { data?: { path?: string } } | null);
  const path = payload?.data?.path ?? persisted;
  if (path) persistPendingPath(path);

  // No file to show — the normal case when the panel is opened from the rail
  // rather than by clicking a file. This is its own state rather than a fall
  // through to the legacy previewer below: that one draws its empty state from
  // `legacy-shell.ts`, whose palette is hardcoded dark, and it would drag the
  // whole legacy bundle in to draw a screen with nothing on it.
  if (!path) {
    mountEmptyState();
    // The empty state has to keep listening. This dispatcher runs once — the
    // long-lived `ui.render` listeners are the loaded renderers, which is how
    // switching files inside one panel works (see reloadForOtherFormat in
    // shims/common). With no renderer loaded nothing else is listening, so
    // without this a file opened after the panel had already shown its empty
    // state would arrive with no one to receive it.
    window.piSDK?.onMessage((payload) => {
      const msg = payload as { event?: string; data?: { path?: string } } | null;
      if (msg?.event !== 'ui.render') return;
      const next = msg.data?.path;
      // No path means "nothing open" — reloading on that would loop.
      if (!next) return;
      persistPendingPath(next);
      location.reload();
    });
    return;
  }

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

  if (ext === 'pdf') {
    await import('../pdf/main');
    return;
  }

  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'csv' || ext === 'ods') {
    await import('../sheets/main');
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
