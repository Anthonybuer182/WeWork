/**
 * Panel styles, injected at boot.
 *
 * Injected from here rather than linked as a stylesheet because the build emits
 * a single JS bundle with no CSS loader — and rather than written into
 * `index.html`, which would put the layout a long way from the components that
 * depend on it.
 *
 * Colours are the host's own CSS variables, which the shell streams into every
 * plugin panel (see THEME_VARS in `plugin-panel.tsx`). The `:root` values below
 * are fallbacks for the moment before that arrives — without them the first
 * paint is transparent-on-transparent.
 */
export const CSS = `
:root {
  --background: #0f1115; --foreground: #e6e9ef;
  --card: #171a21; --card-foreground: #e6e9ef;
  --muted: #1e222b; --muted-foreground: #8b93a3;
  --border: #2a2f3a; --input: #2a2f3a;
  --primary: #4f8cff; --primary-foreground: #ffffff;
  --secondary: #232833; --secondary-foreground: #e6e9ef;
  --accent: #232833; --accent-foreground: #e6e9ef;
  --ring: #4f8cff;
  --radius: 8px;
  --font-sans: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; }
body {
  font: 13px/1.6 var(--font-sans);
  background: var(--background); color: var(--foreground);
  overflow: hidden;
}
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
input, textarea, select {
  font: inherit; color: var(--foreground); background: var(--background);
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px;
  outline: none; width: 100%;
}
input:focus, textarea:focus, select:focus { border-color: var(--ring); }
textarea { resize: vertical; min-height: 56px; }
select { cursor: pointer; }

.app { display: flex; flex-direction: column; height: 100%; }

/* ── header ── */
.hd {
  flex-shrink: 0; border-bottom: 1px solid var(--border);
  padding: 10px 12px 8px; display: flex; flex-direction: column; gap: 8px;
}
.hd-row { display: flex; align-items: center; gap: 6px; }
.tabs { display: flex; gap: 2px; background: var(--muted); border-radius: 7px; padding: 2px; }
.tab {
  padding: 4px 12px; border-radius: 5px; font-size: 12.5px;
  color: var(--muted-foreground);
}
.tab[data-on="true"] { background: var(--card); color: var(--foreground); }
.tab .n {
  display: inline-block; margin-left: 5px; padding: 0 5px; border-radius: 8px;
  background: var(--primary); color: var(--primary-foreground);
  font-size: 10.5px; line-height: 15px; vertical-align: 1px;
}
.grow { flex: 1; }
.btn {
  padding: 5px 12px; border-radius: 6px; font-size: 12.5px;
  border: 1px solid var(--border); color: var(--foreground);
}
.btn:hover { background: var(--accent); }
.btn.primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.tiny { padding: 2px 8px; font-size: 11.5px; }
.btn:disabled { opacity: .45; cursor: default; }

/* The one thing a user must know and would otherwise have to discover. */
.caveat {
  font-size: 11.5px; color: var(--muted-foreground);
  display: flex; align-items: baseline; gap: 6px;
}
.caveat b { font-weight: 600; color: var(--secondary-foreground); }

/* ── body ── */
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 20px; }

.group-hd {
  display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .3px;
  color: var(--muted-foreground); padding: 12px 2px 5px;
}
.group-hd[data-first="true"] { padding-top: 4px; }
.group-hd.overdue { color: #e0663f; }

.row {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 7px 8px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent;
}
.row:hover { background: var(--accent); }
.row[data-done="true"] .title { color: var(--muted-foreground); text-decoration: line-through; }
.row[data-open="true"] { background: var(--accent); border-color: var(--border); }
.tick {
  flex-shrink: 0; width: 17px; height: 17px; margin-top: 2px;
  border: 1.5px solid var(--muted-foreground); border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1; color: transparent;
}
.tick[data-done="true"] { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.tick:hover { border-color: var(--primary); }
.main { flex: 1; min-width: 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { font-size: 12px; color: var(--muted-foreground); }
.when.overdue { color: #e0663f; }
.meta {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--muted-foreground); margin-top: 1px;
}
.badge {
  padding: 0 5px; border-radius: 4px; background: var(--secondary);
  color: var(--secondary-foreground); font-size: 10.5px; line-height: 16px;
}
.note { font-size: 12px; color: var(--muted-foreground); margin-top: 2px; white-space: pre-wrap; }

.empty { text-align: center; color: var(--muted-foreground); padding: 40px 20px; font-size: 12.5px; }

/* ── month grid ── */
.month-hd { display: flex; align-items: center; gap: 8px; padding: 4px 2px 10px; }
.month-hd .label { font-size: 14px; font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.dow { text-align: center; font-size: 11px; color: var(--muted-foreground); padding: 4px 0; }
.cell {
  position: relative; aspect-ratio: 1 / 1; border-radius: 6px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 2px; font-size: 12px; border: 1px solid transparent;
}
.cell:hover { background: var(--accent); }
.cell[data-out="true"] { color: var(--muted-foreground); opacity: .45; }
.cell[data-today="true"] { border-color: var(--primary); font-weight: 600; }
.cell[data-sel="true"] { background: var(--accent); border-color: var(--border); }
.cell .dots { display: flex; gap: 2px; height: 5px; align-items: center; }
.cell .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--primary); }
.cell .dot.done { background: var(--muted-foreground); }

/* ── log ── */
.log-row {
  display: flex; gap: 9px; padding: 7px 8px; border-radius: 7px;
  border-bottom: 1px solid var(--border);
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
.log-sub { font-size: 11.5px; color: var(--muted-foreground); }

/* ── editor ── */
.editor {
  border-top: 1px solid var(--border); background: var(--card);
  padding: 12px; flex-shrink: 0; max-height: 62%; overflow-y: auto;
}
.field { margin-bottom: 9px; }
.field > label {
  display: block; font-size: 11.5px; color: var(--muted-foreground); margin-bottom: 3px;
}
.f2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip {
  padding: 3px 10px; border-radius: 14px; font-size: 12px;
  border: 1px solid var(--border); color: var(--muted-foreground);
}
.chip[data-on="true"] { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.trig {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
}
.trig .k { font-size: 11.5px; color: var(--muted-foreground); flex-shrink: 0; }
.trig select, .trig input { width: auto; flex: 1; min-width: 0; padding: 3px 7px; font-size: 12px; }
.editor-actions { display: flex; gap: 7px; align-items: center; margin-top: 4px; }
.danger { color: #e0663f; }
.err {
  font-size: 12px; color: #e0663f; background: rgba(224,102,63,.1);
  border: 1px solid rgba(224,102,63,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px; white-space: pre-wrap;
}
.hint { font-size: 11.5px; color: var(--muted-foreground); margin-top: 3px; }
.warn {
  font-size: 12px; color: #d9a441; background: rgba(217,164,65,.1);
  border: 1px solid rgba(217,164,65,.3); border-radius: 6px;
  padding: 6px 9px; margin-bottom: 9px;
}

/* ── confirm ── */
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 50;
}
.dialog {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px; max-width: 320px; width: 100%;
}
.dialog h3 { font-size: 14px; margin-bottom: 6px; }
.dialog p { font-size: 12.5px; color: var(--muted-foreground); margin-bottom: 14px; }
.dialog .acts { display: flex; gap: 8px; justify-content: flex-end; }
`;
