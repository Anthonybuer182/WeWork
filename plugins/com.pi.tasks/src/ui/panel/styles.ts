/**
 * Panel styles, injected at boot.
 *
 * Injected from here rather than linked as a stylesheet because the build emits
 * a single JS bundle with no CSS loader — and rather than written into
 * `index.html`, which would put the layout a long way from the components that
 * depend on it.
 *
 * Colours are the host's own theme tokens, which the shell streams into every
 * plugin panel as Tailwind-style HSL components (see THEME_VARS in
 * `panel-relay.tsx`, applied inline on <html> by the injected SDK). Components
 * are not colours, so every colour usage must wrap them in hsl() — a bare
 * `var(--x)` goes invalid once the tokens arrive. The `:root` values below are
 * component fallbacks for the moment before that arrives — without them the
 * first paint is transparent-on-transparent.
 */
export const CSS = `
:root {
  --background: 222 19% 7%; --foreground: 220 21% 92%;
  --card: 222 15% 11%; --card-foreground: 220 21% 92%;
  --muted: 222 16% 14%; --muted-foreground: 217 9% 59%;
  --border: 218 14% 20%; --input: 218 14% 20%;
  --primary: 218 100% 65%; --primary-foreground: 0 0% 100%;
  --secondary: 221 19% 17%; --secondary-foreground: 220 21% 92%;
  --accent: 221 19% 17%; --accent-foreground: 220 21% 92%;
  --ring: 218 100% 65%;
  --radius: 8px;
  --font-sans: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font: 13px/1.6 var(--font-sans);
  background: hsl(var(--background, 222 19% 7%)); color: hsl(var(--foreground, 220 21% 92%));
  overflow: hidden;
}
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
input, textarea, select {
  font: inherit; color: hsl(var(--foreground, 220 21% 92%)); background: hsl(var(--background, 222 19% 7%));
  border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: 6px; padding: 5px 9px;
  outline: none; width: 100%;
}
input:focus, textarea:focus, select:focus { border-color: hsl(var(--ring, 218 100% 65%)); }
textarea { resize: vertical; min-height: 56px; }
select { cursor: pointer; }

.app { display: flex; flex-direction: column; height: 100%; }

/* ── header ── */
.hd {
  flex-shrink: 0; border-bottom: 1px solid hsl(var(--border, 218 14% 20%));
  padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 8px;
}
.hd-row { display: flex; align-items: center; gap: 6px; }
.tabs { display: flex; gap: 2px; background: hsl(var(--muted, 222 16% 14%)); border-radius: 7px; padding: 2px; }
.tab {
  padding: 4px 12px; border-radius: 5px; font-size: 12.5px;
  color: hsl(var(--muted-foreground, 217 9% 59%));
}
.tab[data-on="true"] { background: hsl(var(--card, 222 15% 11%)); color: hsl(var(--foreground, 220 21% 92%)); }
.tab .n {
  display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 8px;
  background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%));
  font-size: 10.5px; line-height: 15px; vertical-align: 1px;
}
.grow { flex: 1; }
.btn {
  padding: 5px 12px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid hsl(var(--border, 218 14% 20%)); color: hsl(var(--foreground, 220 21% 92%));
}
.btn:hover { background: hsl(var(--accent, 221 19% 17%)); }
.btn.primary { background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); border-color: transparent; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.tiny { padding: 2px 8px; font-size: 11.5px; }
.btn:disabled { opacity: .45; cursor: default; }

/* The one thing a user must know and would otherwise have to discover. */
.caveat {
  font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%));
  display: flex; align-items: baseline; gap: 6px;
}
.caveat b { font-weight: 600; color: hsl(var(--secondary-foreground, 220 21% 92%)); }

/* ── body ── */
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 20px; }

.group-hd {
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .3px;
  color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 12px 2px 5px;
}
.group-hd[data-first="true"] { padding-top: 4px; }
.group-hd.overdue { color: #e0663f; }

.row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent;
}
.row:hover { background: hsl(var(--accent, 221 19% 17%)); }
.row[data-done="true"] .title { color: hsl(var(--muted-foreground, 217 9% 59%)); text-decoration: line-through; }
.row[data-open="true"] { background: hsl(var(--accent, 221 19% 17%)); border-color: hsl(var(--border, 218 14% 20%)); }
.tick {
  flex-shrink: 0; width: 17px; height: 17px; margin-top: 2px;
  border: 1.5px solid hsl(var(--muted-foreground, 217 9% 59%)); border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: transparent;
}
.tick[data-done="true"] { background: hsl(var(--primary, 218 100% 65%)); border-color: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); }
.tick:hover { border-color: hsl(var(--primary, 218 100% 65%)); }
.main { flex: 1; min-width: 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { font-size: 12px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.when.overdue { color: #e0663f; }
.meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 1px;
}
.badge {
  padding: 0 5px; border-radius: 4px; background: hsl(var(--secondary, 221 19% 17%));
  color: hsl(var(--secondary-foreground, 220 21% 92%)); font-size: 10.5px; line-height: 16px;
}
.note { font-size: 12px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 2px; white-space: pre-wrap; }

.empty { text-align: center; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 40px 20px; font-size: 12.5px; }

/* ── month grid ── */
.month-hd { display: flex; align-items: center; gap: 8px; padding: 4px 2px 10px; }
.month-hd .label { font-size: 14px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.dow { text-align: center; font-size: 11px; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 4px 0; }
.cell {
  position: relative; aspect-ratio: 1 / 1; border-radius: 6px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; font-size: 12px; border: 1px solid transparent;
}
.cell:hover { background: hsl(var(--accent, 221 19% 17%)); }
.cell[data-out="true"] { color: hsl(var(--muted-foreground, 217 9% 59%)); opacity: .45; }
.cell[data-today="true"] { border-color: hsl(var(--primary, 218 100% 65%)); font-weight: 600; }
.cell[data-sel="true"] { background: hsl(var(--accent, 221 19% 17%)); border-color: hsl(var(--border, 218 14% 20%)); }
.cell .dots { display: flex; gap: 2px; height: 5px; align-items: center; }
.cell .dot { width: 4px; height: 4px; border-radius: 50%; background: hsl(var(--primary, 218 100% 65%)); }
.cell .dot.done { background: hsl(var(--muted-foreground, 217 9% 59%)); }
/* A day you wrote about is worth finding again even if nothing was planned. */
.cell[data-note="true"]::after {
  content: ''; position: absolute; bottom: 3px;
  width: 13px; height: 1.5px; border-radius: 1px; background: hsl(var(--muted-foreground, 217 9% 59%));
}

/* ── log ── */
.log-row {
  display: flex; gap: 9px; padding: 7px 8px; border-radius: 7px;
  border-bottom: 1px solid hsl(var(--border, 218 14% 20%));
}
.log-row:last-child { border-bottom: 0; }
.st { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; }
.st.ok { background: #3fa663; }
.st.missed { background: #d9a441; }
.st.undelivered { background: #d9a441; }
.st.failed { background: #e0663f; }
.log-main { flex: 1; min-width: 0; }
.log-title { display: flex; align-items: baseline; gap: 7px; }
.log-title .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-sub { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); }

/* ── editor ── */
.editor {
  border-top: 1px solid hsl(var(--border, 218 14% 20%)); background: hsl(var(--card, 222 15% 11%));
  padding: 12px; flex-shrink: 0; max-height: 62%; overflow-y: auto;
}
.field { margin-bottom: 9px; }
.field > label {
  display: block; font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-bottom: 3px;
}
.f2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip {
  padding: 3px 10px; border-radius: 14px; font-size: 12px;
  border: 1px solid hsl(var(--border, 218 14% 20%)); color: hsl(var(--muted-foreground, 217 9% 59%));
}
.chip[data-on="true"] { background: hsl(var(--primary, 218 100% 65%)); color: hsl(var(--primary-foreground, 0 0% 100%)); border-color: transparent; }
.trig {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  padding: 6px 8px; border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: 6px;
}
.trig .k { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); flex-shrink: 0; }
.trig select, .trig input { width: auto; flex: 1; min-width: 0; padding: 3px 7px; font-size: 12px; }
.editor-actions { display: flex; gap: 7px; align-items: center; margin-top: 4px; }
.danger { color: #e0663f; }
.err {
  font-size: 12px; color: #e0663f; background: rgba(224,102,63,.1);
  border: 1px solid rgba(224,102,63,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px; white-space: pre-wrap;
}
.hint { font-size: 11.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-top: 3px; }
.warn {
  font-size: 12px; color: #d9a441; background: rgba(217,164,65,.1);
  border: 1px solid rgba(217,164,65,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px;
}

/* ── 回顾: one page per day ── */
.day-col { margin-bottom: 14px; }
.day-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .3px;
  color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 6px 2px;
}
.day-empty { font-size: 12.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); padding: 2px 2px 8px; }
.day-section { margin-bottom: 8px; }
.day-sec-hd { font-size: 11.5px; padding: 3px 2px; color: hsl(var(--muted-foreground, 217 9% 59%)); }
.day-sec-hd.done { color: #3fa663; }
.day-sec-hd.miss { color: #d9a441; }
.row .mark { width: 16px; text-align: center; color: #3fa663; flex-shrink: 0; margin-top: 2px; }
.day-note { min-height: 150px; line-height: 1.7; }
.save-tag { font-size: 11px; font-weight: 400; color: hsl(var(--muted-foreground, 217 9% 59%)); }

/* ── confirm ── */
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50;
}
.dialog {
  background: hsl(var(--card, 222 15% 11%)); border: 1px solid hsl(var(--border, 218 14% 20%)); border-radius: var(--radius, 8px);
  padding: 16px; max-width: 320px; width: 100%;
}
.dialog h3 { font-size: 14px; margin-bottom: 6px; }
.dialog p { font-size: 12.5px; color: hsl(var(--muted-foreground, 217 9% 59%)); margin-bottom: 14px; }
.dialog .acts { display: flex; gap: 8px; justify-content: flex-end; }
`;
