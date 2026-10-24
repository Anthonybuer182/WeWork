import { X, File, Image as ImageIcon, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import type { Attachment } from '@pi/types';

interface AttachmentPreviewBarProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  onPreview?: (attachment: Attachment) => void;
}

export function AttachmentPreviewBar({ attachments, onRemove, onPreview }: AttachmentPreviewBarProps) {
  const { t } = useI18n();
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="group relative flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1 text-xs cursor-pointer hover:bg-muted"
          onClick={() => onPreview?.(att)}
          title={onPreview ? 'Click to preview' : att.name}
        >
          {att.type === 'image' ? (
            <ImageIcon className="h-3 w-3 shrink-0" />
          ) : (
            <File className="h-3 w-3 shrink-0" />
          )}
          <span className="max-w-[140px] truncate">{att.name}</span>
          {onPreview && (
            <Eye className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(att.id);
                }}
                aria-label={`Remove ${att.name}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('移除附件')}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
