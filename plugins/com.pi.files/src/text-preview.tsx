/**
 * Text-class preview: txt / md / markdown / json / log / html.
 *
 * These used to be a separate plugin (`com.pi.preview`) that read the file and
 * dumped the raw text into a declarative card — so a markdown file arrived as
 * literal `#` and `*` on screen. This renders them in the office plugin
 * instead, and markdown goes through GenOffice's own Markdown component
 * (vendor/genoffice/packages/ui/src/Markdown.tsx), so a .md file looks like the
 * document it describes.
 *
 * A small React island rather than a rewrite of the whole viewer: the office
 * previewers (docx/pptx/pdf/xlsx) are still the original imperative code, and
 * they move to React with the docx editor work.
 */
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '@genoffice/ui/Markdown';
// Vendored stylesheet, imported as text (see build-ui.mjs) and injected below.
import markdownCss from '../vendor/genoffice/packages/ui/src/markdown.css';

export interface TextPreviewInput {
  fileName: string;
  ext: string;
  text: string;
  size: number;
  error?: string;
}

/**
 * Layout for the text preview itself. GenOffice's markdown.css styles the
 * `.ai-md-*` blocks; these wrap them and style the plain-text branches.
 * Colours come from the host's theme tokens (injected into every panel), with
 * fallbacks so the panel still reads on its own.
 *
 * The tokens are HSL COMPONENTS — the host sends `--foreground: 222.2 84% 4.9%`
 * — so each one has to be wrapped in `hsl()`. Written bare, `var(--foreground)`
 * substitutes a value that is not a colour: the declaration is dropped as
 * invalid at computed-value time, the `var()` fallback does NOT apply (it only
 * fires for an UNDEFINED variable), and the property silently inherits. That is
 * how these previews ended up with the legacy shell's colours instead of the
 * host's.
 */
const LAYOUT_CSS = `
/* GenOffice's markdown.css styles its table headers and fenced code with ITS
   OWN token names (--surface-subtle, --color-bg-subtle), which the app that
   normally provides them is not here to define — so those two backgrounds were
   resolving to nothing. Point them at the host's muted surface. */
.pi-txt-root { height: 100%; overflow: auto;
  --surface-subtle: hsl(var(--muted, 210 40% 96.1%));
  --color-bg-subtle: hsl(var(--muted, 210 40% 96.1%));
}
.pi-txt { padding: 16px 20px 40px; font: 13px/1.6 -apple-system, "PingFang SC", sans-serif; color: hsl(var(--foreground, 222.2 84% 4.9%)); }
.pi-txt-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; padding-bottom: 8px; border-bottom: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); }
.pi-txt-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi-txt-meta { color: hsl(var(--muted-foreground, 215.4 16.3% 46.9%)); font-size: 11px; flex: none; }
.pi-txt-md { max-width: 780px; }
.pi-txt-pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.55 ui-monospace, "SF Mono", Menlo, monospace; background: hsl(var(--muted, 210 40% 96.1%)); border: 1px solid hsl(var(--border, 214.3 31.8% 91.4%)); border-radius: 6px; padding: 12px 14px; overflow: auto; margin: 0; }
.pi-txt-error { color: var(--err, #f87171); padding: 12px 0; }
`;

/** GenOffice's markdown styles plus this preview's layout, injected once. */
function ensureStyles(): void {
  if (document.getElementById('pi-md-styles')) return;
  const el = document.createElement('style');
  el.id = 'pi-md-styles';
  el.textContent = `${markdownCss}\n${LAYOUT_CSS}`;
  document.head.appendChild(el);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

function Preview({ fileName, ext, text, size, error }: TextPreviewInput) {
  const header = (
    <div className="pi-txt-head">
      <span className="pi-txt-name">{fileName}</span>
      <span className="pi-txt-meta">
        {ext.toUpperCase()} · {formatSize(size)}
      </span>
    </div>
  );

  if (error) {
    return (
      <div className="pi-txt">
        {header}
        <div className="pi-txt-error">{error}</div>
      </div>
    );
  }

  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className="pi-txt">
        {header}
        <article className="pi-txt-md">
          <Markdown text={text} />
        </article>
      </div>
    );
  }

  if (ext === 'json') {
    const { text: pretty, valid } = prettyJson(text);
    return (
      <div className="pi-txt">
        <div className="pi-txt-head">
          <span className="pi-txt-name">{fileName}</span>
          <span className="pi-txt-meta">
            JSON · {formatSize(size)}
            {!valid && ' · 解析失败，显示原文'}
          </span>
        </div>
        <pre className="pi-txt-pre">{pretty}</pre>
      </div>
    );
  }

  // txt / log / html and anything else text-shaped. HTML is shown as SOURCE on
  // purpose: this panel runs on the plugin's own origin, and rendering
  // arbitrary markup here would put a file's content in the same origin as the
  // plugin's capabilities. GenOffice renders HTML in its own app for that
  // reason; a source view is the safe default.
  return (
    <div className="pi-txt">
      {header}
      <pre className="pi-txt-pre">{text}</pre>
    </div>
  );
}

let root: Root | null = null;

/** Render a text-class file into the viewer's content area. */
export function renderTextPreview(input: TextPreviewInput): void {
  ensureStyles();
  const host = document.getElementById('content');
  if (!host) return;
  // Replace the viewer's own markup (loading/empty states) with a mount point
  // that React owns end to end.
  host.innerHTML = '<div class="pi-txt-root"></div>';
  const mount = host.firstElementChild as HTMLElement;
  root?.unmount();
  root = createRoot(mount);
  root.render(<Preview {...input} />);
}
