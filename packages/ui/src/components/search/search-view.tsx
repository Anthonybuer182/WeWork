import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FileText, Loader2, MessageSquare, Search } from 'lucide-react';
import type { FileEntry, FileSearchResult } from '@pi/sdk-wrapper';
import type { Session } from '@pi/types';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { usePanelActivation } from '@/stores/panel-store';
import { cn } from '@/lib/utils';

const MAX_SESSION_HITS = 10;
const DEBOUNCE_MS = 150;

type Hit =
  | { kind: 'session'; id: string; title: string; session: Session }
  | { kind: 'file'; id: string; title: string; entry: FileEntry };

export function SearchView() {
  const sdk = useSDK();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  const setActivePreviewFile = useUIStore((s) => s.setActivePreviewFile);
  const setActiveSession = useUIStore((s) => s.setActiveSession);

  // Views stay mounted while hidden, so "focus on mount" only fires once —
  // focus has to be driven by the activation counter instead.
  const activationNonce = usePanelActivation('host:search');

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSearchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (activationNonce > 0) inputRef.current?.focus();
  }, [activationNonce]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Same query key the session list uses, so the two share one cache entry
  // (and its polling) instead of double-fetching.
  const { data: sessions } = useQuery({
    queryKey: ['sessions', activeWorkspaceId],
    queryFn: () => (activeWorkspaceId ? sdk.session.list(activeWorkspaceId) : []),
    enabled: !!activeWorkspaceId,
  });

  const {
    data: fileResult,
    isFetching,
    error,
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

  const sessionHits = useMemo(() => {
    if (!debounced || !sessions) return [];
    const needle = debounced.toLowerCase();
    return sessions
      .filter((s) => (s.title ?? '').toLowerCase().includes(needle))
      .slice(0, MAX_SESSION_HITS);
  }, [sessions, debounced]);

  const hits: Hit[] = useMemo(
    () => [
      ...sessionHits.map<Hit>((s) => ({
        kind: 'session',
        id: `s:${s.id}`,
        title: s.title ?? 'Untitled',
        session: s,
      })),
      ...(fileResult?.entries ?? []).map<Hit>((entry) => ({
        kind: 'file',
        id: `f:${entry.path}`,
        title: entry.name,
        entry,
      })),
    ],
    [sessionHits, fileResult],
  );

  // Keep the highlight in range as results stream in.
  useEffect(() => {
    setSelectedIndex((i) => (i < hits.length ? i : 0));
  }, [hits.length]);

  const activate = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return;
      if (hit.kind === 'session') {
        setActiveSession(hit.session.id);
      } else {
        // Route through the preview chain (opens in the right-hand panel) —
        // never render a preview inside the sidebar.
        setActivePreviewFile(hit.entry.path);
      }
    },
    [setActiveSession, setActivePreviewFile],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(hits[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
    }
  };

  if (!activeWorkspaceId) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        Select a workspace to search
      </div>
    );
  }

  const searching = isFetching && !!debounced;
  const hasQuery = debounced.length > 0;
  const noResults = hasQuery && !searching && !error && hits.length === 0;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          aria-label="搜索文件和会话"
          placeholder="搜索文件和会话..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      </div>

      <div className="flex-1 overflow-auto min-h-0" role="listbox" aria-label="搜索结果">
        {!hasQuery && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            输入以搜索当前工作空间的文件名，以及会话标题。
          </p>
        )}

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive/80">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            搜索失败
          </div>
        )}

        {noResults && <p className="px-3 py-2 text-xs text-muted-foreground">未找到匹配</p>}

        {hits.map((hit, index) => (
          <button
            key={hit.id}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => activate(hit)}
            data-search-hit={hit.kind}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
              index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
          >
            {hit.kind === 'session' ? (
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs">{hit.title}</span>
            {hit.kind === 'file' && (
              <span className="shrink-0 truncate text-[10px] text-muted-foreground max-w-[45%]">
                {hit.entry.path.split('/').slice(-2, -1)[0]}
              </span>
            )}
          </button>
        ))}

        {/* The three non-empty outcomes are reported differently on purpose —
            "capped" and "partly unreadable" are not the same as "no matches". */}
        {hasQuery && !searching && fileResult?.truncated && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            结果已截断（已扫描 {fileResult.scanned} 个目录）
          </p>
        )}
        {hasQuery && !searching && !!fileResult?.errors?.length && (
          <p className="px-3 py-2 text-[11px] text-amber-600 dark:text-amber-500">
            {fileResult.errors.length} 个目录无法读取
          </p>
        )}
      </div>
    </div>
  );
}
