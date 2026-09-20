import { useState, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MermaidDiagram } from './mermaid-diagram';
import { renderTokenizedText } from '@/lib/token-parser';
import './chat-animations.css';

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
}

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = extractText(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [children]);

  const language = className?.replace('language-', '') || '';

  return (
    <div className="group relative">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border border-border rounded-t-md border-b-0">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-500" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

/** Recursively extract text content from React children */
function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (!children) return '';
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (typeof children === 'object' && 'props' in children) {
    return extractText((children as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return '';
}

function MarkdownContentImpl({ content, isStreaming }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        !isStreaming && 'animate-streaming-in',
        'prose-pre:my-2 prose-pre:bg-muted/80 prose-pre:border prose-pre:border-border',
        'prose-code:bg-muted/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none',
        'prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold',
        'prose-p:my-1 prose-p:leading-relaxed',
        'prose-ul:my-1 prose-ol:my-1 prose-li:my-0',
        'prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1',
        'prose-blockquote:border-l-2 prose-blockquote:border-emerald-500 prose-blockquote:bg-emerald-50/30 prose-blockquote:py-1 prose-blockquote:pl-3 prose-blockquote:not-italic',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node: _node, ...props }) => {
            const match = /language-/.exec(className || '');
            const isInline = !match;
            const codeContent = children as React.ReactNode;

            if (isInline) {
              return (
                <code className={className} {...props}>
                  {codeContent}
                </code>
              );
            }

            const langMatch = /language-(\w+)/.exec(className || '');
            const language = langMatch ? langMatch[1] : '';
            const source = extractText(codeContent);

            if (language === 'mermaid') {
              return (
                <MermaidDiagram
                  source={source}
                  isStreaming={isStreaming}
                />
              );
            }

            return (
              <CodeBlock className={className}>
                {codeContent}
              </CodeBlock>
            );
          },
          p: ({ children, node: _node, ...props }) => {
            const text = extractText(children);
            const hasToken = /(?:^|\s)(?:\/[a-zA-Z][\w-]*|@[\w][\w-]*)/.test(text);
            if (hasToken) {
              return <p {...props}>{renderTokenizedText(text)}</p>;
            }
            return <p {...props}>{children}</p>;
          },
          a: ({ children, href, node: _node, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Memoized: ReactMarkdown + rehypeHighlight re-parse the WHOLE document on
 * every render, so an unmemoized instance costs O(document) per keystroke of
 * the stream. During streaming the parent re-renders once per chunk, which
 * re-parsed every message in the conversation each time and dropped ~38% of
 * frames. Props are a string and a boolean, so the comparison is exact.
 */
export const MarkdownContent = memo(MarkdownContentImpl);
