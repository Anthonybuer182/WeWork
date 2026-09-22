/**
 * `window.slidesApi` — the preload API GenOffice's slides renderer is written against.
 *
 * GenOffice's design puts the *parsing and layout* in its main process: the
 * renderer receives plain-data `RenderSlide[]` and only paints them with Konva.
 * That is why `openPptx(fitWidthPx)` takes no path and `save()` takes no bytes —
 * main owns the file.
 *
 * Here the plugin owns it instead, which is fine because the two packages that
 * do that work are pure TypeScript and already vendored:
 *   pptx-engine  → openPptx(bytes)
 *   pptx-render  → buildRenderSlide(...)   (canvas-free by design)
 *
 * So `buildAllRenderSlides` is reimplemented below in its entirety — it is eight
 * lines upstream, and they are eight lines here.
 *
 * Deliberate simplification: GenOffice injects exact metrics by parsing system
 * font files with opentype.js on the Node side. `pptx-render` documents a
 * heuristic fallback for exactly this case, so we let it use that rather than
 * proxy font files through the backend. Text metrics will be a shade less exact;
 * everything else — shapes, fills, images, tables, charts, layout — is identical.
 */

import { openPptx as openPptxBytes, savePptx, type OpenedPptx } from '@genoffice/pptx-engine';
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render';
import {
  commonApi,
  emitter,
  installThemeBridge,
  persistPendingPath,
  readPersistedPath,
  readDocument,
  reloadForOtherFormat,
  sha256Hex,
  backend,
} from '../shims/common';
import { slidesApiStubs } from './stubs';

const SLIDES_EXTS = ['pptx', 'ppt'] as const;

interface OpenResult {
  path: string;
  slides: RenderSlide[];
  size: { cx: number; cy: number };
  defaultFont?: string;
}

// ── media ───────────────────────────────────────────────────────────────
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

/**
 * Resolve a media part to something the renderer can draw.
 *
 * `pptx-render` hands back a URL string that ends up in an `<img>` / Konva
 * image, so embedded media has to become a data URL. The upstream version also
 * re-encodes TIFF and re-tints themed SVGs; those are quality refinements, and
 * returning the raw bytes for them leaves the picture missing rather than wrong.
 */
function makeMediaResolver(opened: OpenedPptx, slidePath: string) {
  const cache = new Map<string, string | undefined>();
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef);
    let url: string | undefined;
    try {
      const bytes = opened.archive.readBytes(mediaRef);
      if (bytes) {
        const ext = (mediaRef.split('.').pop() ?? '').toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        url = `data:${mime};base64,${btoa(bin)}`;
      }
    } catch (err) {
      console.warn('[slides-shim] media failed:', mediaRef, err);
    }
    cache.set(mediaRef, url);
    void slidePath;
    return url;
  };
}

/**
 * The eight lines GenOffice keeps in its main process
 * (apps/slides/src/main/session-state.ts:376), reproduced here.
 */
function buildAllRenderSlides(opened: OpenedPptx, fitWidthPx: number): RenderSlide[] {
  return opened.deck.slides.map((s, i) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeMediaResolver(opened, s.path),
      // Omitted on purpose: pptx-render falls back to heuristic metrics, which
      // is its documented behaviour when no opentype metrics are injected.
      slideNo: i + 1,
    }),
  );
}

// ── state ───────────────────────────────────────────────────────────────
let current: { opened: OpenedPptx; path: string; fitWidthPx: number } | null = null;
let pendingPath: string | null = null;
let appBooted = false;
let currentPath: string | null = null;
const opened = emitter<OpenResult | null>();

async function loadSlides(path: string, fitWidthPx: number): Promise<OpenResult> {
  const doc = await readDocument(path);
  const parsed = await openPptxBytes(new Uint8Array(doc.data));
  current = { opened: parsed, path, fitWidthPx };
  currentPath = path;
  return {
    path,
    slides: buildAllRenderSlides(parsed, fitWidthPx),
    size: { cx: parsed.deck.size.cx, cy: parsed.deck.size.cy },
  };
}

// ── install ─────────────────────────────────────────────────────────────
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
  // A keepAlive panel keeps THIS renderer mounted; another format must reload
  // so the dispatcher can pick the right one. See shims/common.ts.
  if (reloadForOtherFormat(path, SLIDES_EXTS) === 'reloading') return;
  if (path === currentPath) return;
  void loadSlides(path, current?.fitWidthPx ?? 960)
    .then((r) => opened.fire(r))
    .catch((err) => console.error('[slides-shim] switch failed:', err));
});

function takePendingPath(timeoutMs = 4000): Promise<string | null> {
  appBooted = true;
  if (pendingPath) {
    const p = pendingPath;
    pendingPath = null;
    return Promise.resolve(p);
  }
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  if (injected) return Promise.resolve(injected);
  const persisted = readPersistedPath();
  if (persisted) return Promise.resolve(persisted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void timer;
    void ((p: string | null) => {
      pendingPath = p;
    });
  });
}

const api: Record<string, unknown> = {
  // Shape-correct stubs first: the renderer calls a scattered handful of the
  // 180 declared members during bootstrap, and a missing one throws deep inside
  // its effects. Everything below overrides what is actually implemented.
  ...slidesApiStubs,
  ...commonApi(),

  consumePendingOpen: async (fitWidthPx: number): Promise<OpenResult | null> => {
    const path = await takePendingPath();
    if (!path) return null;
    try {
      return await loadSlides(path, fitWidthPx || 960);
    } catch (err) {
      console.error('[slides-shim] open failed:', err);
      throw err;
    }
  },

  /** GenOffice names this separately for the "open another file" path. */
  openPptxPath: async (path: string, fitWidthPx = 960): Promise<OpenResult | null> => {
    persistPendingPath(path);
    return loadSlides(path, fitWidthPx);
  },
  openPptx: async (fitWidthPx: number): Promise<OpenResult | null> => {
    const path = currentPath ?? (await takePendingPath());
    if (!path) return null;
    return loadSlides(path, fitWidthPx || 960);
  },
  onOpened: (h: (r: OpenResult | null) => void) => opened.on(h),

  // ── save ────────────────────────────────────────────────────────────
  // GenOffice's main process owns the edit journal; here the renderer sends
  // edit intents and we apply them to our copy. Until that layer is ported,
  // save reports honestly rather than writing a file that lost the edits.
  save: async () => {
    if (!current) return { ok: false, error: '没有打开的演示文稿' };
    try {
      const bytes = await savePptx(current.opened);
      const b64 = (() => {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      })();
      await backend('file.write', { path: current.path, base64: b64 });
      const r = { ok: true, path: current.path };
      void sha256Hex(new Uint8Array(bytes).buffer as ArrayBuffer);
      return r;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  saveAs: async (defaultName: string) => ({
    ok: false,
    error: `另存为需要宿主的保存对话框能力，尚未接入（${defaultName}）`,
  }),
  isDirty: async () => false,
  setDirty: () => undefined,

  // ── print / export: the host owns dialogs ───────────────────────────
  exportPdf: async () => ({ ok: false, error: 'PDF 导出尚未接入宿主' }),
  printSlides: async () => ({ ok: false, error: '打印尚未接入宿主' }),
  pickExportDir: async () => null,
  pickExportPdfPath: async () => null,
  exportImages: async () => ({ ok: false, error: '导出图片尚未接入宿主' }),
  consumeHeadlessExport: async () => null,
  headlessExportDone: () => undefined,

  // ── lifecycle ───────────────────────────────────────────────────────
  onCloseSaveRequest: () => () => undefined,
  reportCloseSaveResult: () => undefined,
  onOpenedFile: () => () => undefined,
  masterOpen: async () => undefined,
  masterClose: async () => undefined,
  audienceReady: () => undefined,
  saveStyleSidecar: async () => ({ ok: false }),
  saveStyleTemplate: async () => ({ ok: false }),
};

// `window.slidesApi` is what GenOffice's slides renderer reads.
declare global {
  interface Window {
    slidesApi?: Record<string, unknown>;
  }
}
window.slidesApi = api;
