/**
 * GenOffice's AI surface, answered with nothing.
 *
 * Two vendored modules are aliased here (see `aiPanelSwap` in
 * scripts/build-panel.mjs):
 *
 *   `ai/AiPanel`     — the sidebar of docs / slides / pdf
 *   `ai/AiChatPanel` — sheets' sidebar, a *different* component
 *
 * The second one is why this file exists rather than the old 108-line panel
 * being kept: sheets renders its sidebar from `ExcelShell.tsx`, not from an
 * `AiPanel` import, so aliasing `ai/AiPanel` alone never reached it and sheets
 * shipped GenOffice's own branded chat.
 *
 * ## Why nothing instead of a slim panel of ours
 *
 * The host already has an agent: one composer, one conversation surface, one
 * tool registry. A second chat inside a document panel is the "two products
 * stacked" problem, and it costs a 360px column of every panel open. AI reaches
 * this plugin through its `office_*` tools instead — the same path the host's
 * own composer takes.
 *
 * ## Why these exact exports
 *
 * The callers are compiled as vendored and cannot be changed, so every name
 * they import has to exist here:
 *
 *   docs  `App.tsx:80`  AiPanel, AI_REVISION_AUTHOR
 *   pdf   `App.tsx:9`   AiPanel, GensparkMark
 *   slides `App.tsx:95` AiPanel
 *   sheets `App.tsx:152`, `ExcelShell.tsx:46`, `ai/retry-prune.ts:1`
 *          AiChatPanel, scopeLabel, and the type AiChatMessage
 *          (the type imports all carry the inline `type` modifier, so esbuild
 *           erases them and no runtime export is needed for them)
 */
import type { ReactNode } from 'react';

/** GenOffice stamps this on revisions its AI made. The host agent's edits are
 *  not GenOffice revisions, but docs' App.tsx imports it unconditionally. */
export const AI_REVISION_AUTHOR = 'AI Assistant';

/** docs / slides / pdf sidebar. */
export function AiPanel(_props: Record<string, unknown>): ReactNode {
  return null;
}

/** sheets sidebar. */
export function AiChatPanel(_props: Record<string, unknown>): ReactNode {
  return null;
}

/** pdf takes the brand mark from `ai/AiPanel` for its own header. There is
 *  nothing to draw here: the Genspark brand is not ours to show. */
export function GensparkMark(_props: { size?: number }): ReactNode {
  return null;
}

/**
 * Re-implemented rather than stubbed to an empty string: sheets' `App.tsx:2928`
 * calls this to label an AI-scope card, and that call site is compiled as
 * vendored. Returning "" would leave an unlabelled card; returning the same
 * string upstream does keeps that path inert instead of broken.
 */
export function scopeLabel(
  range: string,
  columns: readonly string[] | null,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (columns?.length === 1) return t('aiScopeColumn', { name: columns[0] ?? '' });
  if (columns && columns.length > 1) {
    return t('aiScopeColumns', { names: columns.join(', '), count: columns.length });
  }
  return t('aiScopeRange', { range });
}
