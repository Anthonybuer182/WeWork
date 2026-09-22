export type AttachmentType = 'image' | 'pdf' | 'office' | 'code' | 'audio' | 'video' | 'other';

export type AttachmentStatus = 'uploading' | 'ready' | 'error';

export interface Attachment {
  id: string;
  name: string;
  type: AttachmentType;
  size: number;
  mimeType: string;
  url?: string;
  status: AttachmentStatus;
  preview?: string;
  /** base64 encoded raw data (without data: URL prefix), populated after FileReader reads the file */
  data?: string;
  createdAt: string;
}

export type QuoteSource =
  | 'markdown' | 'html' | 'pdf-canvas' | 'pdf-text'
  | 'docx' | 'xlsx' | 'pptx' | 'code-editor' | 'browser'
  | 'chat' | 'plugin';
