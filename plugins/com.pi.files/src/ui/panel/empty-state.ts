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
    color: var(--foreground, #111);
  }
  .fi-empty svg { color: var(--muted-foreground, #9ca3af); }
  .fi-empty-title { font-size: 14px; font-weight: 600; }
  .fi-empty-hint {
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--muted-foreground, #6b7280);
    max-width: 30em;
  }
  .fi-empty-formats {
    margin-top: 6px;
    font-size: 11.5px;
    letter-spacing: 0.02em;
    color: var(--muted-foreground, #9ca3af);
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
    <div class="fi-empty-formats">docx · xlsx · pptx · pdf · txt · md · json · html</div>
  </div>
`;

/** Render the empty state into the panel's root element. */
export function mountEmptyState(): void {
  const root = document.getElementById('root');
  if (!root) return;
  const style = document.createElement('style');
  style.textContent = EMPTY_CSS;
  document.head.appendChild(style);
  root.innerHTML = EMPTY_BODY;
}
