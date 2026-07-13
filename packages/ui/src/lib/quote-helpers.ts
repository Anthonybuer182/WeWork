import type { Quote, QuoteSource, QuoteMeta } from '@pi/types';

let counter = 0;
export function createQuote(
  content: string,
  filePath: string,
  source: QuoteSource,
  meta: QuoteMeta = {},
): Quote {
  const trimmed = content.trim();
  const safe = trimmed.length > 5000 ? trimmed.slice(0, 5000) + '\n[...truncated]' : trimmed;
  return {
    id: `q_${Date.now()}_${counter++}`,
    filePath,
    fileName: filePath.split(/[/\\]/).pop() ?? filePath,
    source,
    content: safe,
    meta,
    createdAt: new Date().toISOString(),
  };
}

/** 从当前 DOM 选区所在的祖先节点上读取 data-* 属性，提取元数据 */
export function extractMetaFromSelection(): QuoteMeta {
  const sel = window.getSelection();
  const node = sel?.anchorNode;
  const el = node?.nodeType === 1 ? (node as HTMLElement) : node?.parentElement;
  if (!el) return {};
  const meta: QuoteMeta = {};
  const pageEl = el.closest('[data-page-num]') as HTMLElement | null;
  if (pageEl) meta.pageNumber = Number(pageEl.dataset.pageNum);
  const slideEl = el.closest('[data-slide-idx]') as HTMLElement | null;
  if (slideEl) meta.slideNumber = Number(slideEl.dataset.slideIdx) + 1;
  const sheetEl = el.closest('[data-sheet-name]') as HTMLElement | null;
  if (sheetEl) meta.sheetName = sheetEl.dataset.sheetName;
  return meta;
}

/** 把引用列表格式化为拼接到 promptContent 的 markdown 文本 */
export function formatQuotesForPrompt(quotes: Quote[]): string {
  if (!quotes.length) return '';
  const sections = quotes.map((q) => {
    const ctx: string[] = [];
    if (q.source === 'browser') {
      // Browser quotes use the URL as filePath
      ctx.push(`URL: ${q.filePath}`);
    } else {
      ctx.push(`File: ${q.fileName}`);
    }
    if (q.meta.startLine && q.meta.endLine) ctx.push(`Lines: ${q.meta.startLine}-${q.meta.endLine}`);
    if (q.meta.pageNumber) ctx.push(`Page: ${q.meta.pageNumber}`);
    if (q.meta.slideNumber) ctx.push(`Slide: ${q.meta.slideNumber}`);
    if (q.meta.sheetName) ctx.push(`Sheet: ${q.meta.sheetName}`);
    if (q.source === 'code-editor') {
      const ext = q.filePath.split('.').pop() ?? '';
      return `${ctx.join(' | ')}\n\`\`\`${ext}\n${q.content}\n\`\`\``;
    }
    return `${ctx.join(' | ')}\n> ${q.content.split('\n').join('\n> ')}`;
  });
  return `\n\n--- Quoted Context ---\n${sections.join('\n\n')}\n--- End Quoted Context ---`;
}
