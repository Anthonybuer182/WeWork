import { useUIStore } from '@/stores/ui-store';
import { CodeEditor } from './code-editor';
import { MarkdownPreview } from './markdown-preview';
import { HTMLPreview } from './html-preview';
import { DocxPreview } from './docx-preview';
import { XlsxPreview } from './xlsx-preview';
import { PptxPreview } from './pptx-preview';
import { PDFPreview } from './pdf-preview';
import { ImagePreview } from './image-preview';
import { VideoPreview } from './video-preview';
import { EmptyPreview } from './empty-preview';
import { MemoryFilePreview } from './memory-file-preview';
import { QuoteToChatWrapper } from './quote-to-chat-wrapper';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', 'avi', '3gp'];

function getExt(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function DocumentPreview() {
  const filePath = useUIStore((s) => s.activePreviewFilePath);

  if (!filePath) return <EmptyPreview />;

  if (filePath.startsWith('__memory__/')) return <MemoryFilePreview />;
  if (filePath.endsWith('.md')) return <QuoteToChatWrapper source="markdown"><MarkdownPreview /></QuoteToChatWrapper>;
  if (filePath.endsWith('.html')) return <QuoteToChatWrapper source="html"><HTMLPreview /></QuoteToChatWrapper>;
  if (filePath.endsWith('.docx')) return <QuoteToChatWrapper source="docx"><DocxPreview /></QuoteToChatWrapper>;
  if (filePath.endsWith('.xlsx')) return <QuoteToChatWrapper source="xlsx"><XlsxPreview /></QuoteToChatWrapper>;
  if (filePath.endsWith('.pptx')) return <QuoteToChatWrapper source="pptx"><PptxPreview /></QuoteToChatWrapper>;
  if (filePath.endsWith('.pdf')) return <QuoteToChatWrapper source="pdf-text"><PDFPreview /></QuoteToChatWrapper>;

  const ext = getExt(filePath);
  if (IMAGE_EXTS.includes(ext)) return <ImagePreview />;
  if (VIDEO_EXTS.includes(ext)) return <VideoPreview />;

  return <CodeEditor />;
}
