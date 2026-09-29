/**
 * `window.htmlApi` — the preload API GenOffice's html renderer is written
 * against.
 *
 * The html app is not the markdown app with a different parser: it *edits* the
 * document and renders it in an IFRAME, pushing the instrumented source to that
 * frame as you type.
 *
 * ## The preview frame, and why it goes through a temp file
 *
 * In GenOffice the frame is served from a custom `html-preview://` scheme owned
 * by their main process. There is no such scheme here, and adding one would mean
 * changing the host's plugin protocol for one plugin's internal need.
 *
 * What the renderer actually requires is narrower than a scheme. `PreviewFrame`
 * builds its src as `${url}?v=${nonce}` — so the URL must stay PUT while its
 * CONTENT changes between reloads. The plugin already has an endpoint with
 * exactly those semantics: `pi-plugin://<id>/ws-file?path=…` streams any
 * absolute path with `no-cache`, and the path can be percent-encoded so the
 * renderer's `?v=` lands beside it rather than inside it.
 *
 * So `updatePreview` writes the buffer to a scratch file (the backend hands out
 * a stable path, `file.scratchPath`) and `getPreviewInfo` points the frame at
 * it. Every nonce bump is a new URL, which re-fetches the file, which now holds
 * the new text. Same behaviour, no new scheme, nothing outside this plugin.
 *
 * Not covered: the document's own `html-asset://` image references, which that
 * scheme would also have resolved. Images inside an html document stay broken
 * until they are mapped too.
 */

import {
  backend,
  commonApi,
  emitter,
  installThemeBridge,
  readDocument,
  readPersistedPath,
  reloadForOtherFormat,
  writeTextFile,
  wsFileUrl,
} from '../shims/common';
import { htmlApiStubs } from './stubs';

/** Extensions THIS renderer owns. */
const HTML_EXTS = ['html', 'htm'];

// ── state ───────────────────────────────────────────────────────────────
let pendingPath: string | null = null;
let appBooted = false;
let currentPath: string | null = null;
/** The renderer's `onFileRenamed` handler takes just the new path. */
const renamed = emitter<string>();

/** Baselines for the save path's conflict check, keyed by path. */
const openMtimes = new Map<string, number>();

installThemeBridge();

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string; data?: { path?: string } } | null;
  if (msg?.event !== 'ui.render') return;
  const path = msg.data?.path;
  if (typeof path !== 'string' || !path) return;

  if (!appBooted) {
    pendingPath = path;
    return;
  }
  if (reloadForOtherFormat(path, HTML_EXTS) === 'reloading') return;
  currentPath = path;
});

function takePendingPath(timeoutMs = 4000): Promise<string | null> {
  appBooted = true;
  if (pendingPath) {
    const p = pendingPath;
    pendingPath = null;
    currentPath = p;
    return Promise.resolve(p);
  }
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  if (injected) {
    currentPath = injected;
    return Promise.resolve(injected);
  }
  const persisted = readPersistedPath();
  if (persisted) {
    currentPath = persisted;
    return Promise.resolve(persisted);
  }
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
}

/** The scratch file the preview frame reads, asked for once and then reused. */
let scratchPath: Promise<string | null> | null = null;
function previewTarget(): Promise<string | null> {
  scratchPath ??= backend<{ path?: string }>('file.scratchPath')
    .then((r) => r?.path ?? null)
    .catch(() => null);
  return scratchPath;
}

/** UTF-8 text, plus the mtime baseline the write path compares against. */
async function readText(path: string): Promise<string> {
  const doc = await readDocument(path);
  if (doc.mtime !== null) openMtimes.set(path, doc.mtime);
  currentPath = path;
  return new TextDecoder().decode(doc.data);
}

async function writeText(path: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await writeTextFile(path, text, openMtimes.get(path)) as { mtime?: number } | undefined;
    if (typeof res?.mtime === 'number') openMtimes.set(path, res.mtime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The last preview write, so `getPreviewInfo` can wait for it.
 *
 * The renderer pushes the buffer and THEN points the frame at the URL
 * (`updatePreview(...)` then `setPreviewUrl(info.url)`), so a frame that loads
 * before the write lands would fetch a file that does not exist yet — a 404
 * rendered as "Not found" inside the preview.
 */
let inFlightWrite: Promise<unknown> = Promise.resolve();

const api: Record<string, unknown> = {
  // Shape-correct stubs first — the renderer calls a scattered handful of the
  // 51 declared members during bootstrap. Everything below overrides the ones
  // that are implemented.
  ...htmlApiStubs,
  ...commonApi(),

  consumePending: async (): Promise<string | null> => takePendingPath(),

  readFile: async (path: string): Promise<string> => readText(path),

  /**
   * Push the instrumented buffer to the frame's file.
   *
   * Fire-and-forget by design: the renderer calls this on a debounced keystroke
   * and never awaits it. The next nonce bump is what re-reads it.
   */
  updatePreview: (text: string): void => {
    inFlightWrite = previewTarget().then((path) => {
      if (!path) return;
      // No `expectedMtime`: this file is ours, it is not a user document, and a
      // conflict check on it would only ever refuse our own previous write.
      return writeTextFile(path, text).catch(() => undefined);
    });
  },

  getPreviewInfo: async (): Promise<{ url: string }> => {
    const path = await previewTarget();
    // The frame must never race the first push — see inFlightWrite.
    await inFlightWrite;
    if (!path) return { url: 'about:blank' };
    // The trailing `&v=` is load-bearing, not decoration.
    //
    // The renderer builds its src as `${url}?v=${nonce}` (PreviewFrame.tsx), so
    // the URL it actually loads ends `…ws-file?path=<encoded>?v=3`. A query value
    // runs to the next `&` or the end — a `?` inside it is a literal — so that
    // path would parse as `/…/preview.html?v=3` and `existsSync` would fail:
    // an iframe showing "Not found" with the right file sitting on disk.
    //
    // Ending our own URL with `&v=` puts the renderer's fragment on a SEPARATE
    // parameter, so `path` stays clean and the nonce still makes each reload a
    // different URL. Nothing outside this plugin needs to know.
    return { url: `${wsFileUrl(path)}&v=` };
  },

  save: async (request: {
    text?: string;
    mode?: string;
    suggestedName?: string;
  }): Promise<unknown> => {
    const text = typeof request?.text === 'string' ? request.text : null;
    if (text === null) return { ok: false, error: '没有要保存的内容' };

    let path = currentPath;
    if (request?.mode === 'saveAs' || !path) {
      const picked = await backend<{ path?: string | null }>('file.pickSavePath', {
        ...(request?.suggestedName ? { defaultName: request.suggestedName } : {}),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      }).catch((): { path?: string | null } => ({ path: null }));
      if (!picked?.path) return { ok: true, canceled: true };
      path = picked.path;
    }

    const written = await writeText(path, text);
    return written.ok ? { ok: true, path } : { ok: false, error: written.error ?? '保存失败' };
  },

  // The shell owns rename / menu-save / close-prompt / present-in-new-tab flows;
  // a plugin panel has no such parent, so these register nothing rather than
  // pretending to.
  onFileRenamed: (h: (p: string) => void) => renamed.on(h),
  onSaveRequest: () => () => undefined,
  sendSaveRequestAck: () => undefined,
  onReadTextRequest: () => () => undefined,
  sendReadTextResult: () => undefined,
  onCloseSaveRequest: () => () => undefined,
  sendCloseSaveResult: () => undefined,
  setProvisionalTitle: () => undefined,
};

// Assigned through a cast rather than a `declare global` of our own, matching
// the other shims: the app declares its own `window.htmlApi`, and a second
// declaration that disagrees on the modifier or the type is a hard error
// (TS2687 / TS2717).
(window as unknown as { htmlApi: Record<string, unknown> }).htmlApi = api;
