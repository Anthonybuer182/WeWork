import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, Loader2, RefreshCw } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { FileTreeNode } from './file-tree-node';
import { Button } from '@/components/ui/button';
import { isPreviewableInRightPanel, openWithSystemApp } from '@/lib/utils';

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.vite', 'dist', '.next', '__pycache__', '.DS_Store']);

export function FileTree() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);

  const { data: files, isLoading, error, isFetching } = useQuery({
    queryKey: ['files', activeWorkspaceId, activeWorkspaceId],
    queryFn: () => sdk.file.list(activeWorkspaceId!),
    enabled: !!activeWorkspaceId,
    staleTime: 5_000,
  });

  const handleFileClick = (path: string) => {
    if (isPreviewableInRightPanel(path)) {
      setActivePreviewFile(path);
    } else {
      openWithSystemApp(path, activeWorkspaceId!);
    }
  };

  if (!activeWorkspaceId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        Select a workspace to view files
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
        <Folder className="h-3.5 w-3.5" />
        <span className="flex-1">Files</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['files', activeWorkspaceId] })}
          disabled={isFetching}
          aria-label="Refresh files"
        >
          <RefreshCw className={isFetching ? 'animate-spin' : ''} style={{ width: 12, height: 12 }} />
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading files...
        </div>
      )}

      {error && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Failed to load files
        </div>
      )}

      {!isLoading && !error && files && files.length === 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No files found
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {files
          ?.filter((f) => (f.type === 'directory' && !HIDDEN_DIRS.has(f.name)) || f.type === 'file')
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              workspaceId={activeWorkspaceId}
              depth={0}
              onFileClick={handleFileClick}
            />
          ))}
      </div>
    </div>
  );
}
