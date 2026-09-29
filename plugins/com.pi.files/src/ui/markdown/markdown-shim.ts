/**
 * `window.markdownApi` — the preload API GenOffice's markdown renderer is
 * written against.
 *
 * This is the real markdown viewer: the text formats used to go through
 * `@genoffice/ui`'s Markdown component, which is the chat-bubble one (paragraphs,
 * lists, tables, code, emphasis — no images, no links, no blockquotes). That is
 * this app's renderer instead.
 *
 * The shape is the same as the other four: nothing here reimplements the
 * renderer, it only answers the handful of preload calls the renderer makes.
 * Reading is `readFile`, which for this app is UTF-8 TEXT (pdf's returns bytes);
 * everything else is either shared (`commonApi`) or inert.
 *
 * The long tail — exports, image picking, headless export, the shell's menu
 * flows — is covered by the generated stubs, which return the SHAPE each
 * declaration promises. A stub that returned `undefined` where the caller
 * expects a list would fail somewhere far from the cause.
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
} from '../shims/common';
import { markdownApiStubs } from './stubs';

/** Extensions THIS renderer owns. `/markdown` too — it is in the manifest. */
const MD_EXTS = ['md', 'markdown'];

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
  // A keepAlive panel keeps THIS renderer mounted; another format must reload so
  // the dispatcher can pick the right one. See shims/common.ts.
  if (reloadForOtherFormat(path, MD_EXTS) === 'reloading') return;
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
    // Re-baseline: `filesystem.write` is a compare-and-swap against the mtime
    // read at open, so without this every save after the first would report a
    // conflict against our own write.
    if (typeof res?.mtime === 'number') openMtimes.set(path, res.mtime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const api: Record<string, unknown> = {
  // Shape-correct stubs first — the renderer calls a scattered handful of the
  // 44 declared members during bootstrap. Everything below overrides the ones
  // that are implemented.
  ...markdownApiStubs,
  ...commonApi(),

  /** Which file this panel was opened for. */
  consumePending: async (): Promise<string | null> => takePendingPath(),

  readFile: async (path: string): Promise<string> => readText(path),

  /**
   * Save the document text back.
   *
   * `saveAs` asks the host for a path through `dialog.saveFile` — the capability
   * that exists for exactly this. A plugin panel has no shell to put up a
   * dialog of its own, so without that it could only ever write in place.
   */
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
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }).catch((): { path?: string | null } => ({ path: null }));
      if (!picked?.path) return { ok: true, canceled: true };
      path = picked.path;
    }

    const written = await writeText(path, text);
    return written.ok ? { ok: true, path } : { ok: false, error: written.error ?? '保存失败' };
  },

  // The shell owns rename / menu-save / close-prompt flows; a plugin panel has
  // no such parent, so these register nothing rather than pretending to.
  onFileRenamed: (h: (p: string) => void) => renamed.on(h),
  onSaveRequest: () => () => undefined,
  sendSaveRequestAck: () => undefined,
  onReadTextRequest: () => () => undefined,
  sendReadTextResult: () => undefined,
  onCloseSaveRequest: () => () => undefined,
  sendCloseSaveResult: () => undefined,
};

// Assigned through a cast rather than a `declare global` of our own, matching
// the other shims: the app declares its own `window.markdownApi`, and a second
// declaration that disagrees on the modifier or the type is a hard error
// (TS2687 / TS2717).
(window as unknown as { markdownApi: Record<string, unknown> }).markdownApi = api;
