/**
 * The panel's empty state: what the viewer shows when it is opened with no file.
 *
 * That happens when the panel is opened from the rail. The viewer renders *a
 * file*, so a rail click has nothing to draw — which is the reason this panel
 * used to carry `hidden: true` and reach the rail not at all.
 *
 * Not the legacy shell's empty state: that one lives in `legacy-shell.ts` beside
 * the old text previewers, and it paints its own hardcoded dark palette. Here
 * the panel is the host's front door, so the colors come from the host's theme
 * tokens (`index.html` already themes the body the same way) and the sheet never
 * paints a background of its own.
 */

import { PLUGIN_ID } from '../shims/common';

const EMPTY_CSS = `
  .fi-empty {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px 24px;
    text-align: center;
    font-family: var(--font-sans, -apple-system, "PingFang SC", sans-serif);
    /* Host tokens are HSL COMPONENTS (--foreground arrives as "222.2 84% 4.9%"),
       so they need wrapping in hsl(). Bare, the value is not a colour, the
       declaration is dropped, and the var() fallback does NOT rescue it — that
       only fires for an UNDEFINED variable, not an invalid one. */
    color: hsl(var(--foreground, 222.2 84% 4.9%));
  }
  .fi-empty svg { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); }
  .fi-empty-title { font-size: 14px; font-weight: 600; }
  .fi-empty-hint {
    font-size: 12.5px;
    line-height: 1.7;
    color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%));
    max-width: 30em;
  }
  .fi-empty-formats {
    margin-top: 6px;
    font-size: 11.5px;
    letter-spacing: 0.02em;
    color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%));
    opacity: 0.85;
  }
`;

const EMPTY_BODY = `
  <div class="fi-empty">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
    <div class="fi-empty-title">未选择文件</div>
    <div class="fi-empty-hint">在左侧文件树点开一个文件，它就会在这里打开。</div>
    <div class="fi-empty-formats"></div>
  </div>
`;

/**
 * The formats this plugin handles, as its own manifest declares them.
 *
 * Read rather than restated, because `contributes.filePreview.match` is what the
 * host routes by — a copy here is a second source of truth that drifts without
 * anything failing. It had already drifted: the hardcoded line named eight
 * formats while the manifest matched twelve, leaving xls, csv, markdown and log
 * unmentioned to anyone who looked at this screen to find out what opens.
 *
 * The manifest is served from the plugin root by the same `pi-plugin://` handler
 * that serves this page (`protocol.ts`), so this is a same-origin read of a file
 * already on disk — no capability, no network.
 */
async function formatList(): Promise<string> {
  try {
    const res = await fetch(`pi-plugin://${PLUGIN_ID}/manifest.json`);
    if (!res.ok) return '';
    const manifest = (await res.json()) as {
      contributes?: { filePreview?: { match?: string[] }[] };
    };
    const exts = (manifest.contributes?.filePreview ?? []).flatMap((f) => f.match ?? []);
    return [...new Set(exts)].join(' · ');
  } catch {
    // A hint line is not worth failing the panel over.
    return '';
  }
}

/** Render the empty state into the panel's root element. */
export function mountEmptyState(): void {
  const root = document.getElementById('root');
  if (!root) return;
  const style = document.createElement('style');
  style.textContent = EMPTY_CSS;
  document.head.appendChild(style);
  root.innerHTML = EMPTY_BODY;
  // Filled in when the manifest arrives; an empty line until then, which is why
  // the formats row has no other content to collide with.
  void formatList().then((list) => {
    const slot = root.querySelector('.fi-empty-formats');
    if (slot) slot.textContent = list;
  });
}
