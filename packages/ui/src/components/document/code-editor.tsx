import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { Button } from '@/components/ui/button';
import { FileCode, Save, Check, Loader2, Quote as QuoteIcon } from 'lucide-react';
import Editor, { loader } from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { useComposerStore } from '@/stores/composer-store';
import { createQuote } from '@/lib/quote-helpers';

// Point Monaco to local node_modules CDN
loader.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

export function CodeEditor({ headerActions }: { headerActions?: ReactNode }) {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const activePreviewFilePath = useUIStore((s) => s.activePreviewFilePath);

  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [quoteBtnPos, setQuoteBtnPos] = useState<{ top: number; left: number } | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const originalContentRef = useRef<string>('');

  const { data: file, isLoading } = useQuery({
    queryKey: ['file', activeWorkspaceId, activePreviewFilePath],
    queryFn: () => sdk.file.read(activeWorkspaceId!, activePreviewFilePath!),
    enabled: !!activeWorkspaceId && !!activePreviewFilePath,
  });

  // Sync editor content when file loads
  useEffect(() => {
    if (file?.content) {
      setEditorContent(file.content);
      originalContentRef.current = file.content;
      setIsDirty(false);
    }
  }, [file?.content]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!activeWorkspaceId || !activePreviewFilePath || editorContent === null) return;
      await sdk.file.write(activeWorkspaceId, activePreviewFilePath, editorContent);
    },
    onSuccess: () => {
      originalContentRef.current = editorContent ?? '';
      setIsDirty(false);
      // Invalidate file list to refresh size/date info
      queryClient.invalidateQueries({ queryKey: ['files', activeWorkspaceId] });
    },
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation]);

  const addQuote = useComposerStore((s) => s.addQuote);

  const handleQuoteSelection = useCallback(() => {
    if (!editorRef.current || !activePreviewFilePath) return;
    const selection = editorRef.current.getSelection();
    if (!selection || selection.isEmpty()) return;
    const text = editorRef.current.getModel()?.getValueInRange(selection) ?? '';
    if (text.trim()) {
      addQuote(createQuote(text, activePreviewFilePath, 'code-editor', {
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
      }));
    }
  }, [activePreviewFilePath, addQuote]);

  const handleEditorChange = useCallback((value: string | undefined) => {
    const newContent = value ?? '';
    setEditorContent(newContent);
    setIsDirty(newContent !== originalContentRef.current);
  }, []);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    // Ctrl+S / Cmd+S to save
    editor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [2048 | 49], // CtrlCmd + S
      run: () => handleSave(),
    });
    // Ctrl+Shift+Q / Cmd+Shift+Q to quote selection to chat
    editor.addAction({
      id: 'quote-to-chat',
      label: 'Quote Selection to Chat',
      keybindings: [2048 | 1024 | 45], // CtrlCmd | Shift | Q
      run: () => handleQuoteSelection(),
    });

    // Floating Quote button on text selection
    const updateFloatingQuote = () => {
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) {
        setQuoteBtnPos(null);
        return;
      }
      const visiblePos = editor.getScrolledVisiblePosition(sel.getStartPosition());
      if (!visiblePos) {
        setQuoteBtnPos(null);
        return;
      }
      setQuoteBtnPos({
        top: visiblePos.top - 36,
        left: visiblePos.left,
      });
    };
    const editorDom = editor.getDomNode();
    if (editorDom) {
      editorDom.addEventListener('mouseup', () => {
        setTimeout(updateFloatingQuote, 10);
      });
    }
    editor.onDidChangeCursorSelection((e) => {
      if (e.selection.isEmpty()) setQuoteBtnPos(null);
    });
    editor.onDidScrollChange(() => {
      setQuoteBtnPos(null);
    });
  }, [handleSave, handleQuoteSelection]);

  if (!activePreviewFilePath) return null;
  if (isLoading) return <LoadingSpinner message="Loading file..." />;
  if (!file) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <FileCode className="h-3.5 w-3.5" />
        <span className="truncate flex-1">{file.path}</span>
        {file.language && <span className="tabular-nums opacity-60">{file.language}</span>}
        {isDirty && (
          <span className="h-1.5 w-1.5 rounded-full bg-orange-400" title="Unsaved changes" />
        )}
        {headerActions}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || saveMutation.isPending}
          className="h-6 gap-1 text-xs"
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : saveMutation.isSuccess && !isDirty ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
      {/* Editor */}
      <div className="flex-1 relative">
        <Editor
          value={editorContent ?? file.content}
          language={file.language ?? 'plaintext'}
          theme="vs-dark"
          options={{
            readOnly: false,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            automaticLayout: true,
          }}
          onChange={handleEditorChange}
          onMount={handleEditorMount}
          loading={<LoadingSpinner message="Loading editor..." />}
        />
        {quoteBtnPos && (
          <div
            className="absolute z-50"
            style={{ top: quoteBtnPos.top, left: quoteBtnPos.left, transform: 'translateX(-50%)' }}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                handleQuoteSelection();
                setQuoteBtnPos(null);
              }}
              className="h-7 gap-1.5 shadow-md"
              title="Quote to chat (Cmd+Shift+Q)"
            >
              <QuoteIcon className="h-3 w-3" />
              Quote
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
