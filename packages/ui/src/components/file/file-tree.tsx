import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileText, Folder, Loader2, RefreshCw, Search } from 'lucide-react';
import type { FileSearchResult } from '@pi/sdk-wrapper';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { FileTreeNode } from './file-tree-node';
import { Button } from '@/components/ui/button';
import { isPreviewableInRightPanel, openWithSystemApp } from '@/lib/utils';

const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.vite', 'dist', '.next', '__pycache__', '.DS_Store']);
const DEBOUNCE_MS = 150;

export function FileTree() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);

  // Filename search over the whole workspace; while a query is active it
  // replaces the tree with a flat result list.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const activeSearchIdRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: files, isLoading, error, isFetching } = useQuery({
    queryKey: ['files', activeWorkspaceId, activeWorkspaceId],
    queryFn: () => sdk.file.list(activeWorkspaceId!),
    enabled: !!activeWorkspaceId,
    staleTime: 5_000,
  });

  const {
    data: searchResult,
    isFetching: searchFetching,
    error: searchError,
  } = useQuery<FileSearchResult | null>({
    queryKey: ['file-search', activeWorkspaceId, debounced],
    queryFn: async () => {
      if (!activeWorkspaceId || !debounced) return null;
      // Stop the previous walk before starting a new one — the transport has
      // no cancellation signal, so it is cooperative and keyed by id.
      if (activeSearchIdRef.current) {
        sdk.file.cancelSearch(activeSearchIdRef.current).catch(() => {});
      }
      const searchId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeSearchIdRef.current = searchId;
      return sdk.file.search(activeWorkspaceId, debounced, { searchId });
    },
    enabled: !!activeWorkspaceId && debounced.length > 0,
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

  const searching = searchFetching && !!debounced;
  const hasQuery = debounced.length > 0;

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

      <div className="flex items-center gap-2 px-3 py-1">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          aria-label="搜索文件"
          placeholder="搜索文件..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        {searching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      {!hasQuery && (
        <>
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
        </>
      )}

      {hasQuery ? (
        <div className="flex-1 overflow-auto min-h-0">
          {searchError && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive/80">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              搜索失败
            </div>
          )}
          {!searching && !searchError && (!searchResult || searchResult.entries.length === 0) && (
            <p className="px-3 py-2 text-xs text-muted-foreground">未找到匹配</p>
          )}
          {searchResult?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => handleFileClick(entry.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
              <span className="shrink-0 truncate text-[10px] text-muted-foreground max-w-[45%]">
                {entry.path.split('/').slice(-2, -1)[0]}
              </span>
            </button>
          ))}
          {/* The three non-empty outcomes are reported differently on purpose —
              "capped" and "partly unreadable" are not the same as "no matches". */}
          {!searching && searchResult?.truncated && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              结果已截断（已扫描 {searchResult.scanned} 个目录）
            </p>
          )}
          {!searching && !!searchResult?.errors?.length && (
            <p className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-500">
              {searchResult.errors.length} 个目录无法读取
            </p>
          )}
        </div>
      ) : (
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
      )}
    </div>
  );
}
