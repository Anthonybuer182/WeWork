/**
 * The AI panel — OURS, not GenOffice's.
 *
 * GenOffice's `ai/AiPanel.tsx` (1,834 lines) drives their own agent:
 * `AgentLoop`, `streamText`, their provider config, their web/image search.
 * The plugin deliberately does not ship that. The host already has an agent,
 * and a second one inside a panel would mean two conversation surfaces, two
 * model settings, two places to be wrong.
 *
 * So this is the replacement: the panel sends what you type down the same
 * `chat.send` path the composer uses, which is the whole point — a message
 * from here behaves exactly like a message you typed yourself, tools and all.
 *
 * GenOffice's `App.tsx` passes ~20 props (edit queue, comment/header/footer/
 * notes access, page-setup hooks). They are for its own agent's document
 * mutations and are accepted-and-ignored for now: the host agent reaches the
 * document through the plugin's `office_*` tools instead.
 */

import { useCallback, useRef, useState } from 'react';

/** GenOffice stamps this on revisions its AI made; the host agent's edits are
 *  not GenOffice revisions, but App.tsx imports the constant unconditionally. */
export const AI_REVISION_AUTHOR = 'AI Assistant';

interface AiPanelProps {
  /** Tiptap editor — present so a future version can scope a message to the
   *  current selection, which is how GenOffice's own panel works. */
  editor?: unknown;
  open?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
  filePath?: string | null;
  [key: string]: unknown;
}

export function AiPanel({ open = false, onCollapse, filePath }: AiPanelProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setNote(null);
    try {
      // Ask the BACKEND to send: `chat.send` is a host capability, and only the
      // backend may call it. The backend relays it onto the same channel as the
      // composer, so the agent sees an ordinary user message.
      const res = (await window.piSDK?.request('chat.send', {
        text: filePath ? `${value}\n\n(当前文档: ${filePath})` : value,
      })) as { ok?: boolean; error?: string } | undefined;
      if (res && res.ok === false) throw new Error(res.error ?? '发送失败');
      setText('');
      setNote('已发给 agent');
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [text, sending, filePath]);

  if (!open) return null;

  return (
    <aside className="ai-panel pi-ai">
      <div className="pi-ai-head">
        <span className="pi-ai-title">AI</span>
        {onCollapse && (
          <button type="button" className="pi-ai-collapse" onClick={onCollapse} title="收起">
            ×
          </button>
        )}
      </div>
      <textarea
        ref={inputRef}
        className="pi-ai-input"
        rows={4}
        value={text}
        placeholder="让 agent 改这份文档…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button type="button" className="pi-ai-send" disabled={sending || !text.trim()} onClick={() => void send()}>
        {sending ? '发送中…' : '发给 agent'}
      </button>
      {note && <div className="pi-ai-note">{note}</div>}
    </aside>
  );
}
