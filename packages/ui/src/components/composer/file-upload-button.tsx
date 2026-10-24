import { useRef, useCallback } from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

interface FileUploadButtonProps {
  disabled?: boolean;
  onFilesSelected: (files: File[]) => void;
}

export function FileUploadButton({ disabled, onFilesSelected }: FileUploadButtonProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        onFilesSelected(files);
      }
      // Reset so the same file can be selected again
      if (inputRef.current) inputRef.current.value = '';
    },
    [onFilesSelected],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.css,.html"
        onChange={handleChange}
        aria-hidden="true"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        className="shrink-0"
        onClick={handleClick}
        aria-label={t('添加附件')}
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </>
  );
}
