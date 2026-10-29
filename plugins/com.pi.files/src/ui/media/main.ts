/**
 * Media viewer entry — images, video, audio.
 *
 * No parser and no vendored app: these are the formats the panel's own engine
 * already decodes, so the whole renderer is a tag plus the interactions the tag
 * does not come with (fit / 1:1 / wheel zoom / drag pan for images; a failure
 * state with a way out for media whose codec this engine cannot play).
 *
 * The host protocol serves workspace files at `pi-plugin://…/ws-file` with
 * Range support, which is what lets `<video>` seek instead of buffering the
 * whole file — see serveWorkspaceFile in apps/desktop/src/main/plugins/
 * protocol.ts.
 */

import {
  backend,
  extOf,
  persistPendingPath,
  readPersistedPath,
  reloadForOtherFormat,
  wsFileUrl,
} from '../shims/common';
import { AUDIO_EXTS, IMAGE_EXTS, MEDIA_EXTS, VIDEO_EXTS } from './exts';

const root = document.getElementById('root');

/** Releases whatever the last render holds (a playing video, a big <img>). */
let teardown: (() => void) | null = null;

/**
 * The header is composed from parts that arrive at different times: the type is
 * known at once, the size comes back from `file.stat`, and a picture's
 * dimensions only exist after it decodes. Each writer updates its own part and
 * recomposes. A single `setMeta` written from both sides raced — the stat reply
 * is slower, so it used to overwrite the dimensions that had just arrived.
 */
let extLabel = '';
let dimsLabel = '';
let sizeLabel = '';

function refreshMeta(): void {
  setMeta([extLabel, dimsLabel, sizeLabel].filter(Boolean).join(' · '));
}

boot();

function boot(): void {
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  const initial = injected || readPersistedPath();
  if (initial) {
    persistPendingPath(initial);
    void render(initial);
  } else {
    renderMessage('未选择文件', '在左侧文件树点击文件，或让 agent 生成文件');
  }

  window.piSDK?.onMessage((payload) => {
    const msg = payload as { event?: string; data?: { path?: string; error?: string } } | null;
    if (msg?.event !== 'ui.render') return;
    const path = msg.data?.path;
    if (typeof path === 'string' && path) {
      // Another format → reload so the dispatcher mounts that renderer. Same
      // format → also reload (media has no editor state worth keeping), which
      // reloadForOtherFormat does when the path changed.
      if (reloadForOtherFormat(path, MEDIA_EXTS) === 'reloading') return;
      persistPendingPath(path);
      void render(path);
      return;
    }
    if (msg.data?.error) renderMessage('无法预览', msg.data.error, true);
  });
}

// ── dispatch ────────────────────────────────────────────────────────────

async function render(path: string): Promise<void> {
  ensureStyles();
  drop();
  const ext = extOf(path);
  const name = path.split('/').pop() ?? path;
  extLabel = ext.toUpperCase();
  dimsLabel = '';
  sizeLabel = '';
  shell(name, extLabel);
  const body = mountBody();

  // Size arrives asynchronously; the picture's own dimensions arrive later
  // still, with the decode. Both go through refreshMeta.
  backend<{ size?: number }>('file.stat', { path })
    .then((s) => {
      if (typeof s?.size === 'number') {
        sizeLabel = formatSize(s.size);
        refreshMeta();
      }
    })
    .catch(() => undefined);

  if (IMAGE_EXTS.includes(ext)) return renderImage(body, path);
  if (VIDEO_EXTS.includes(ext)) return renderVideo(body, path);
  if (AUDIO_EXTS.includes(ext)) return renderAudio(body, path, name);
  renderMessage('无法预览', `不支持的媒体格式：.${ext}`, true);
}

/** Unload the previous element so a video cannot keep playing behind the next file. */
function drop(): void {
  teardown?.();
  teardown = null;
}

// ── image ───────────────────────────────────────────────────────────────

function renderImage(body: HTMLElement, path: string): void {
  const stage = document.createElement('div');
  stage.className = 'mv-stage mv-image';

  const img = new Image();
  img.className = 'mv-img';
  img.draggable = false;
  img.alt = path.split('/').pop() ?? path;
  stage.appendChild(img);
  body.appendChild(stage);

  const controls = mountImageControls(body);
  const disposeBase = (): void => {
    controls.dispose();
    img.removeAttribute('src');
  };

  /** `null` = fit to the stage; a number = absolute scale. */
  let scale: number | null = null;
  /** Pan, in screen pixels, applied before the scale. */
  let tx = 0;
  let ty = 0;
  let fit = 1;

  const current = (): number => scale ?? fit;

  const apply = (): void => {
    const s = current();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    controls.setZoom(s);
    stage.classList.toggle('mv-pannable', scale !== null && s > fit * 1.001);
  };

  const computeFit = (): void => {
    const pad = 32;
    const w = Math.max(stage.clientWidth - pad, 40);
    const h = Math.max(stage.clientHeight - pad, 40);
    // `|| 1` guards a zero-sized stage (the panel can mount before layout).
    fit = Math.min(w / (img.naturalWidth || 1), h / (img.naturalHeight || 1));
  };

  const clampScale = (s: number): number => Math.min(Math.max(s, 0.02), 32);

  const toFit = (): void => {
    scale = null;
    tx = 0;
    ty = 0;
    computeFit();
    apply();
  };

  const toActual = (): void => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };

  /** Zoom around the pointer: the point under the cursor stays put. */
  const zoomAt = (cx: number, cy: number, factor: number): void => {
    const s0 = current();
    const s1 = clampScale(s0 * factor);
    if (s1 === s0) return;
    const r = stage.getBoundingClientRect();
    const px = (cx - (r.left + r.width / 2) - tx) / s0;
    const py = (cy - (r.top + r.height / 2) - ty) / s0;
    tx -= px * (s1 - s0);
    ty -= py * (s1 - s0);
    scale = s1;
    apply();
  };

  controls.onFit(toFit);
  controls.onActual(toActual);
  controls.onZoomFactor((f) => {
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
  });

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // Drag to pan, only once the picture is bigger than the stage.
  stage.addEventListener('pointerdown', (e) => {
    if (!stage.classList.contains('mv-pannable') || e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('mv-dragging');
    const startX = e.clientX - tx;
    const startY = e.clientY - ty;
    const move = (ev: PointerEvent): void => {
      tx = ev.clientX - startX;
      ty = ev.clientY - startY;
      apply();
    };
    const up = (): void => {
      stage.classList.remove('mv-dragging');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });

  stage.addEventListener('dblclick', () => {
    // fit ⇄ 1:1, which is the two states people actually want.
    if (scale === null) toActual();
    else toFit();
  });

  const observer = new ResizeObserver(() => {
    if (scale === null) {
      computeFit();
      apply();
    }
  });
  observer.observe(stage);

  teardown = () => {
    observer.disconnect();
    disposeBase();
  };

  img.addEventListener('load', () => {
    dimsLabel = `${img.naturalWidth}×${img.naturalHeight}`;
    refreshMeta();
    computeFit();
    apply();
    img.classList.add('mv-ready');
  });
  img.addEventListener('error', () => {
    renderMessage('无法显示这个文件', `图片解码失败：${path}`, true);
  });
  img.src = wsFileUrl(path);
}

interface ImageControls {
  setZoom(s: number): void;
  onFit(cb: () => void): void;
  onActual(cb: () => void): void;
  onZoomFactor(cb: (factor: number) => void): void;
  dispose(): void;
}

/** 适应 / 1:1 / − / + / percent — the four things a viewer of pictures needs. */
function mountImageControls(body: HTMLElement): ImageControls {
  const bar = document.createElement('div');
  bar.className = 'mv-controls';

  const btn = (label: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-btn';
    b.textContent = label;
    b.title = title;
    bar.appendChild(b);
    return b;
  };

  const fitBtn = btn('适应', '适应窗口（双击图片也可以）');
  const actualBtn = btn('1:1', '原始大小');
  const outBtn = btn('−', '缩小');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'mv-zoom';
  bar.appendChild(zoomLabel);
  const inBtn = btn('+', '放大');

  body.appendChild(bar);

  let onFitCb: () => void = () => undefined;
  let onActualCb: () => void = () => undefined;
  let onFactorCb: (f: number) => void = () => undefined;

  fitBtn.addEventListener('click', () => onFitCb());
  actualBtn.addEventListener('click', () => onActualCb());
  outBtn.addEventListener('click', () => onFactorCb(1 / 1.25));
  inBtn.addEventListener('click', () => onFactorCb(1.25));

  return {
    setZoom: (s) => {
      zoomLabel.textContent = `${Math.round(s * 100)}%`;
    },
    onFit: (cb) => {
      onFitCb = cb;
    },
    onActual: (cb) => {
      onActualCb = cb;
    },
    onZoomFactor: (cb) => {
      onFactorCb = cb;
    },
    dispose: () => bar.remove(),
  };
}

// ── video / audio ───────────────────────────────────────────────────────

function renderVideo(body: HTMLElement, path: string): void {
  const stage = document.createElement('div');
  stage.className = 'mv-stage mv-video';

  const video = document.createElement('video');
  video.className = 'mv-video-el';
  video.controls = true;
  video.preload = 'metadata';
  video.src = wsFileUrl(path);
  stage.appendChild(video);
  body.appendChild(stage);

  teardown = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  video.addEventListener('loadedmetadata', () => {
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) {
      dimsLabel = formatTime(d);
      refreshMeta();
    }
  });
  video.addEventListener('error', () => {
    renderMessage(
      '无法播放这个文件',
      `可能是内核不支持的编码（例如 HEVC / H.265）。请用系统播放器打开：${path}`,
      true,
    );
  });
}

function renderAudio(body: HTMLElement, path: string, name: string): void {
  const box = document.createElement('div');
  box.className = 'mv-audio';

  const icon = document.createElement('div');
  icon.className = 'mv-audio-icon';
  icon.textContent = '♪';

  const label = document.createElement('div');
  label.className = 'mv-audio-name';
  label.textContent = name;

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = wsFileUrl(path);
  box.append(icon, label, audio);
  body.appendChild(box);

  teardown = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };

  audio.addEventListener('error', () => {
    renderMessage('无法播放这个文件', `可能是内核不支持的编码。请用系统播放器打开：${path}`, true);
  });
}

// ── chrome ──────────────────────────────────────────────────────────────

function shell(name: string, meta: string): void {
  if (!root) return;
  root.innerHTML = `
    <div class="mv">
      <header class="mv-head">
        <span class="mv-name"></span>
        <span class="mv-meta"></span>
      </header>
      <div class="mv-body"></div>
    </div>`;
  root.querySelector('.mv-name')!.textContent = name;
  root.querySelector('.mv-meta')!.textContent = meta;
}

function mountBody(): HTMLElement {
  return root!.querySelector('.mv-body') as HTMLElement;
}

function setMeta(text: string): void {
  const el = root?.querySelector('.mv-meta');
  if (el) el.textContent = text;
}

function renderMessage(title: string, detail: string, isError = false): void {
  if (!root) return;
  ensureStyles();
  drop();
  root.innerHTML = `
    <div class="mv">
      <div class="mv-state ${isError ? 'mv-error' : ''}">
        <div class="mv-state-title"></div>
        <div class="mv-state-detail"></div>
      </div>
    </div>`;
  root.querySelector('.mv-state-title')!.textContent = title;
  root.querySelector('.mv-state-detail')!.textContent = detail;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

// ── styles ──────────────────────────────────────────────────────────────

/**
 * Host theme tokens are HSL COMPONENTS (`--foreground: 222.2 84% 4.9%`), so
 * each has to be wrapped in `hsl()`; written bare, `var(--foreground)`
 * substitutes a value that is not a colour and the declaration silently drops.
 */
function ensureStyles(): void {
  if (document.getElementById('mv-css')) return;
  const el = document.createElement('style');
  el.id = 'mv-css';
  el.textContent = `
.mv { height: 100%; display: flex; flex-direction: column; background: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%)); font: 13px/1.6 -apple-system, "PingFang SC", sans-serif; }
.mv-head { display: flex; align-items: baseline; gap: 10px; padding: 10px 16px; border-bottom: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); }
.mv-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-meta { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); font-size: 11px; flex: none; }
.mv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* the picture */

.mv-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
/* Transparent pixels need something behind them that is obviously "not the
   image" — the same checkerboard every image editor uses. */
.mv-image { background: repeating-conic-gradient(hsl(var(--muted, 210 40% 96.1%)) 0% 25%, hsl(var(--background, 0 0% 100%)) 0% 50%) 50% / 20px 20px; }
.mv-img { display: block; max-width: none; max-height: none; opacity: 0; transition: opacity .12s ease; will-change: transform; user-select: none; }
.mv-img.mv-ready { opacity: 1; }
.mv-pannable { cursor: grab; }
.mv-dragging { cursor: grabbing; }
.mv-controls { flex: none; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; border-top: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); background: hsl(var(--card, 0 0% 100%)); }
.mv-btn { font: inherit; font-size: 12px; color: hsl(var(--foreground, 222.2 84% 4.9%)); background: hsl(var(--background, 0 0% 100%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.mv-btn:hover { background: hsl(var(--muted, 210 40% 96.1%)); }
.mv-zoom { min-width: 52px; text-align: center; font-size: 11px; color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }

/* video / audio */

.mv-video { background: #0b0b0c; }
.mv-video-el { max-width: 100%; max-height: 100%; outline: none; }
.mv-audio { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 32px; }
.mv-audio-icon { width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 32px; color: hsl(var(--primary-foreground, 210 40% 98%)); background: hsl(var(--primary, 222.2 47.4% 11.2%)); }
.mv-audio-name { font-weight: 600; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-audio audio { width: min(420px, 80%); }

/* states */

.mv-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 60px 24px; text-align: center; color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }
.mv-state-title { font-size: 15px; color: hsl(var(--foreground, 222.2 84% 4.9%)); }
.mv-state-detail { font-size: 12px; max-width: 90%; word-break: break-word; }
.mv-error .mv-state-detail { color: var(--err, #f87171); }
`;
  document.head.appendChild(el);
}
