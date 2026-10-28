/**
 * Text viewer entry — `txt` / `json` / `log`.
 *
 * The last format class that does not have a GenOffice app: GenOffice's
 * markdown renderer owns `.md`, its html app owns `.html`, and what is left is
 * plain text, which a browser renders natively — a `<pre>` and no parser.
 *
 * This used to live at `src/main.ts`, wrapped around ten times its own size of
 * dead previewers (docx/pptx/pdf/xlsx) whose `import`s dragged pdfjs, SheetJS
 * and the old engines into the bundle for every text file opened. They never
 * ran: the dispatcher routes those extensions to GenOffice's apps before this
 * module is reached. See the git history for what was removed.
 */

import {
  backend,
  extOf,
  persistPendingPath,
  readPersistedPath,
  reloadForOtherFormat,
  wsFileUrl,
} from '../shims/common';

/** Extensions this renderer owns. Anything else reloads into its own renderer. */
const TEXT_EXTS = ['txt', 'json', 'log', 'doc', 'ppt'];

/** Legacy Office (Word 97-2003 / PowerPoint 97-2003): no renderer, but GenOffice
 *  has text extractors, so the file previews as its text. */
const LEGACY_EXTS = new Set(['doc', 'ppt']);

/** Above this the view truncates and says so — silently showing the first N
 *  characters of a log reads as "the file ends here". */
const MAX_TEXT_CHARS = 200_000;

/** Long lines wrap by default — a log with 2000 characters per line reads as
 *  one endless horizontal scroll otherwise. Off is for wide tables and minified
 *  JSON, where wrapping destroys the columns. Kept across files on purpose. */
let wrap = true;

const root = document.getElementById('root');
if (root) {
  const injected = (window as unknown as { __PI_OPEN_PATH__?: string }).__PI_OPEN_PATH__;
  const initial = injected || readPersistedPath();
  if (initial) {
    persistPendingPath(initial);
    void render(initial);
  } else {
    // A keepAlive panel opened from the rail has nothing to show yet; the host
    // pushes `ui.render` when a file is picked. It listens either way, because
    // switching files inside one panel arrives the same way.
    renderMessage('未选择文件', '在左侧文件树点击文件，或让 agent 生成文件');
  }
}

window.piSDK?.onMessage((payload) => {
  const msg = payload as { event?: string; data?: { path?: string; error?: string } } | null;
  if (msg?.event !== 'ui.render') return;
  const path = msg.data?.path;
  if (typeof path === 'string' && path) {
    // Different format → reload so the panel's dispatcher mounts its renderer.
    // Same format → re-render here; there is no editor state to lose.
    if (reloadForOtherFormat(path, TEXT_EXTS) === 'reloading') return;
    persistPendingPath(path);
    void render(path);
    return;
  }
  if (msg.data?.error) renderMessage('无法预览', msg.data.error, true);
});

// ── rendering ───────────────────────────────────────────────────────────

async function render(path: string): Promise<void> {
  ensureStyles();
  const name = path.split('/').pop() ?? path;
  const ext = extOf(path);
  shell(name, ext.toUpperCase());
  const body = mountBody();
  body.innerHTML = '<div class="tx-state"><div class="tx-spin"></div><div>加载中…</div></div>';

  try {
    if (LEGACY_EXTS.has(ext)) {
      await renderLegacyOffice(body, path, ext);
      return;
    }

    const res = await fetch(wsFileUrl(path));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const raw = await res.text();
    const total = Number(res.headers.get('content-length')) || raw.length;
    const text = raw.slice(0, MAX_TEXT_CHARS);

    setMeta(`${ext.toUpperCase()} · ${formatSize(total)}`);

    if (ext === 'json') {
      const pretty = prettyJson(text);
      body.innerHTML = '';
      if (!pretty.valid) body.appendChild(note('JSON 解析失败，显示原文'));
      body.appendChild(codeBlock(pretty.text));
    } else {
      body.innerHTML = '';
      body.appendChild(codeBlock(text));
    }

    if (total > MAX_TEXT_CHARS) {
      body.insertBefore(truncatedNote(total), body.firstChild);
    }
  } catch (err) {
    renderMessage('无法预览', err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * `.doc` / `.ppt`: the text comes from GenOffice's extractors in the backend —
 * they parse the OLE2 container that a `<pre>` cannot. Layout, images, tables
 * and styling are not reproduced, and the viewer says so rather than letting
 * the text read as the whole document.
 */
async function renderLegacyOffice(body: HTMLElement, path: string, ext: string): Promise<void> {
  const stat = await backend<{ size?: number }>('file.stat', { path }).catch(() => ({ size: undefined }));
  const size = typeof stat?.size === 'number' ? formatSize(stat.size) : '';
  setMeta(`${ext.toUpperCase()} · 仅文字${size ? ` · ${size}` : ''}`);

  const out = await backend<{ text: string; total: number; truncated: boolean }>('file.extractText', {
    path,
    maxChars: MAX_TEXT_CHARS,
  });

  body.innerHTML = '';
  body.appendChild(note(`旧格式（.${ext}）：只提取了文字，排版、图片和表格不还原。`));
  if (out.truncated) body.appendChild(truncatedNote(out.total));
  body.appendChild(codeBlock(out.text || '（没有提取到文字）'));
}

function truncatedNote(total: number): HTMLElement {
  return note(
    `已截断：只显示前 ${MAX_TEXT_CHARS.toLocaleString()} 字符（共 ${formatSize(total)}），完整内容请用编辑器打开`,
  );
}

function setMeta(text: string): void {
  const el = root?.querySelector('.tx-meta');
  if (el) el.textContent = text;
}

function shell(name: string, meta: string): void {
  if (!root) return;
  root.innerHTML = `
    <div class="tx">
      <header class="tx-head">
        <span class="tx-name"></span>
        <span class="tx-meta"></span>
        <button type="button" class="tx-wrap-btn"></button>
      </header>
      <div class="tx-body"></div>
    </div>`;
  root.querySelector('.tx-name')!.textContent = name;
  root.querySelector('.tx-meta')!.textContent = meta;

  const btn = root.querySelector<HTMLButtonElement>('.tx-wrap-btn')!;
  btn.addEventListener('click', () => {
    wrap = !wrap;
    applyWrap();
  });
  applyWrap();
}

/** Long lines wrap by default — a log with 2000 characters per line reads as
 *  one endless horizontal scroll otherwise. Off is for wide tables and minified
 *  JSON, where wrapping destroys the columns. See the module-level `wrap`. */
function applyWrap(): void {
  if (!root) return;
  const body = root.querySelector('.tx-body');
  body?.classList.toggle('tx-nowrap', !wrap);
  const btn = root.querySelector<HTMLButtonElement>('.tx-wrap-btn');
  if (btn) {
    btn.textContent = wrap ? '折行：开' : '折行：关';
    btn.title = wrap ? '关闭折行（长行横向滚动）' : '开启折行';
  }
}

function mountBody(): HTMLElement {
  return root!.querySelector('.tx-body') as HTMLElement;
}

/**
 * One row per line, with a sticky line-number gutter.
 *
 * A plain `<pre>` cannot carry line numbers, and logs are exactly where they
 * matter. Rows are built into a fragment first — a truncated log is ~3k rows,
 * and building them detached is the difference between one layout pass and
 * thousands.
 */
function codeBlock(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tx-code';
  const lines = text.split('\n');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'tx-line';
    const num = document.createElement('span');
    num.className = 'tx-ln';
    num.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'tx-lc';
    // A blank line still needs a row height; textContent alone collapses it.
    code.textContent = lines[i] || '​';
    row.append(num, code);
    frag.appendChild(row);
  }
  box.appendChild(frag);
  return box;
}

function note(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tx-note';
  el.textContent = text;
  return el;
}

function renderMessage(title: string, detail: string, isError = false): void {
  if (!root) return;
  ensureStyles();
  root.innerHTML = `
    <div class="tx">
      <div class="tx-state ${isError ? 'tx-error' : ''}">
        <div class="tx-state-title"></div>
        <div class="tx-state-detail"></div>
      </div>
    </div>`;
  root.querySelector('.tx-state-title')!.textContent = title;
  root.querySelector('.tx-state-detail')!.textContent = detail;
}

/** Pretty-print JSON when it parses; keep the raw text when it does not, so a
 *  half-written file still previews instead of exploding. */
function prettyJson(text: string): { text: string; valid: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), valid: true };
  } catch {
    return { text, valid: false };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── styles ──────────────────────────────────────────────────────────────

/**
 * Host theme tokens are HSL COMPONENTS (`--foreground: 222.2 84% 4.9%`), so
 * each has to be wrapped in `hsl()`; written bare, `var(--foreground)`
 * substitutes a value that is not a colour and the declaration silently drops.
 */
function ensureStyles(): void {
  if (document.getElementById('tx-css')) return;
  const el = document.createElement('style');
  el.id = 'tx-css';
  el.textContent = `
.tx { height: 100%; display: flex; flex-direction: column; background: hsl(var(--background, 0 0% 100%)); color: hsl(var(--foreground, 222.2 84% 4.9%)); font: 13px/1.6 -apple-system, "PingFang SC", sans-serif; }
.tx-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 16px; border-bottom: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); }
.tx-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tx-meta { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); font-size: 11px; flex: none; }
.tx-wrap-btn { margin-left: auto; flex: none; font: inherit; font-size: 11px; color: hsl(var(--foreground, 222.2 84% 4.9%)); background: hsl(var(--background, 0 0% 100%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.tx-wrap-btn:hover { background: hsl(var(--muted, 210 40% 96.1%)); }
.tx-body { flex: 1; min-height: 0; overflow: auto; }
.tx-code { font: 12px/19px ui-monospace, "SF Mono", Menlo, monospace; padding: 8px 0 40px; }
.tx-line { display: flex; }
.tx-ln { position: sticky; left: 0; flex: none; width: 52px; padding-right: 12px; text-align: right; color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); background: hsl(var(--background, 0 0% 100%)); font-size: 11px; user-select: none; }
.tx-lc { flex: 1; min-width: 0; padding-right: 16px; white-space: pre-wrap; word-break: break-word; tab-size: 4; }
.tx-nowrap .tx-code { width: max-content; min-width: 100%; }
.tx-nowrap .tx-lc { white-space: pre; word-break: normal; }
.tx-note { font-size: 12px; color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); background: hsl(var(--muted, 210 40% 96.1%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 6px; padding: 8px 12px; margin: 12px 16px; }
.tx-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 60px 20px; color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }
.tx-state-title { font-size: 15px; color: hsl(var(--foreground, 222.2 84% 4.9%)); }
.tx-state-detail { font-size: 12px; max-width: 90%; text-align: center; word-break: break-word; }
.tx-error .tx-state-detail { color: var(--err, #f87171); }
.tx-spin { width: 22px; height: 22px; border: 2px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-top-color: hsl(var(--primary, 222.2 47.4% 11.2%)); border-radius: 50%; animation: tx-spin .8s linear infinite; }
@keyframes tx-spin { to { transform: rotate(360deg); } }
/* selection → chat box: the plugin's own UI; the host only provides chat.send */
.sel-box { position: fixed; z-index: 50; display: flex; gap: 6px; min-width: 320px; background: hsl(var(--card, 0 0% 100%)); color: hsl(var(--card-foreground, 222.2 84% 4.9%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 8px; padding: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.sel-box .sel-input { flex: 1; min-width: 0; margin: 0; font: inherit; color: inherit; background: hsl(var(--background, 0 0% 100%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 6px; padding: 4px 8px; }
.sel-box .sel-input:focus { outline: none; border-color: hsl(var(--ring, 222.2 84% 4.9%)); }
.sel-box .sel-go { flex: none; font: inherit; color: hsl(var(--primary-foreground, 210 40% 98%)); background: hsl(var(--primary, 222.2 47.4% 11.2%)); border: 0; border-radius: 6px; padding: 4px 12px; cursor: pointer; }
`;
  document.head.appendChild(el);
}

// ── 选中内容 → 悬浮输入框 → 交给 agent ─────────────────────────────────
//
// 在查看器里选中任意文字，选中位置下方浮出输入框，并把选中的内容带入其中；
// 写下要 agent 做什么，回车即发送。输入框是插件自己的 UI，宿主只提供
// "能调用对话"这一个能力（chat.send）。

let selBox: HTMLElement | null = null;

function closeSelBox(): void {
  if (selBox) {
    selBox.remove();
    selBox = null;
  }
}

function openSelBox(rect: DOMRect, selected: string): void {
  closeSelBox();
  const box = document.createElement('div');
  box.className = 'sel-box';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sel-input';
  input.value = selected.replace(/\s+/g, ' ').trim();

  const go = document.createElement('button');
  go.className = 'sel-go';
  go.textContent = '发给 agent';

  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    window.piSDK?.emit('files.chat', { text });
    closeSelBox();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSelBox();
    }
  });
  // mousedown + preventDefault so clicking the button does not clear the
  // selection before the handler runs.
  go.addEventListener('mousedown', (e) => {
    e.preventDefault();
    submit();
  });

  box.append(input, go);
  document.body.appendChild(box);

  // iframe 不能溢出自身边界，所以放不下时向上翻转。
  const w = box.offsetWidth || 360;
  const h = box.offsetHeight || 40;
  const above = rect.bottom + h + 12 > window.innerHeight;
  box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 8))}px`;
  box.style.top = `${above ? Math.max(8, rect.top - h - 8) : rect.bottom + 8}px`;

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

document.addEventListener('mouseup', (e) => {
  if (selBox && selBox.contains(e.target as Node)) return;
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!text || sel!.rangeCount === 0) {
    closeSelBox();
    return;
  }
  openSelBox(sel!.getRangeAt(0).getBoundingClientRect(), text);
});

// 滚动或窗口变化时收起，避免浮框停在旧位置。
document.addEventListener('scroll', closeSelBox, true);
window.addEventListener('resize', closeSelBox);
