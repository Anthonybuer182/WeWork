import { SKILL_REFERENCE_MARKER } from '@pi/types';
import { t } from '@/i18n';

/**
 * Text utilities for message content.
 *
 * The quote feature (quoting a selection into the composer) has been
 * removed. What remains of it here is the *stripping* side: older sessions
 * on disk still contain the `--- Quoted Context ---` section the composer
 * used to append, and displaying it raw would be noise.
 */
/**
 * Strip context sections the composer appends to the outgoing prompt — the
 * UI renders them as cards (quote / context blocks), so showing them inline
 * in the user bubble would duplicate the same content twice.
 */
/**
 * Drop the per-message skill-reference block (`/` menu). It is an instruction
 * for the model, not text the user typed. The block is always appended last.
 */
function stripSkillReference(content: string): string {
  const index = content.lastIndexOf(SKILL_REFERENCE_MARKER);
  if (index < 0) return content;
  return content.slice(0, index).replace(/\s+$/, '');
}

export function stripAppendedContext(content: string): string {
  return stripSkillReference(content)
    .replace(/\n*--- Quoted Context ---[\s\S]*?--- End Quoted Context ---\s*/g, '')
    .replace(/\n*---\s*\n\[相关上下文\][\s\S]*?\n---\s*/g, '')
    .replace(/\s+$/, '');
}

export interface ExtractedQuote {
  fileName: string;
  filePath: string;
  source: string;
  text: string;
}

/**
 * Parse the `--- Quoted Context ---` section the composer appends to outgoing
 * user messages. The session record persists only the text (no quote blocks),
 * so the UI re-synthesizes quote cards from it — showing the quote exactly
 * once in both live and reloaded views.
 */
export function extractAppendedQuotes(content: string): { display: string; quotes: ExtractedQuote[] } {
  const quotes: ExtractedQuote[] = [];
  const withoutQuotes = content.replace(
    /\n*--- Quoted Context ---\n([\s\S]*?)--- End Quoted Context ---\s*/g,
    (_m, section: string) => {
      for (const part of section.split('\n\n')) {
        const lines = part.split('\n').filter((l) => l.trim());
        if (!lines.length) continue;
        const header = lines[0] ?? '';
        const loc = /^(?:File|URL): (.+?)(?:\s*\||\s*$)/.exec(header);
        const filePath = loc?.[1]?.trim() ?? t('引用');
        const body = lines.slice(1).join('\n').replace(/^> ?/gm, '').trim();
        if (body) {
          quotes.push({
            fileName: filePath.split(/[/\\]/).pop() ?? filePath,
            filePath,
            source: header.startsWith('URL:') ? 'browser' : 'chat',
            text: body,
          });
        }
      }
      return '';
    },
  );
  const display = stripSkillReference(withoutQuotes)
    .replace(/\n*---\n\[相关上下文\][\s\S]*?\n---\s*/g, '')
    .replace(/\s+$/, '');
  return { display, quotes };
}
