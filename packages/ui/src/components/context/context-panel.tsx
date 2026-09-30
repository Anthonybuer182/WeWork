'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  budgetTotal,
  formatChars,
  formatCount,
  formatTokens,
  promptFileGroups,
  promptFileStatus,
  promptStatusLabel,
  PROMPT_KIND_HINT,
  PROMPT_KIND_LABEL,
  reloadNote,
  scopeLabel,
} from '@pi/sdk-wrapper';
import type { AgentContextConfig, PromptFileInfo } from '@pi/types';
import { buildMarkdown, sectionSpecs } from './context-derive';
import { useSDK } from '@/hooks/use-sdk';
import { useUIStore } from '@/stores/ui-store';
import { usePluginStore } from '@/stores/plugin-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { ErrorState } from '@/components/common/error-state';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * The agent's standing context, as a host panel.
 *
 * A host panel rather than a plugin, deliberately. Everything it edits lives in
 * the agent config dir — `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md` — the same
 * place the model settings panel edits `models.json`. That makes it a meta
 * panel ("configure the app itself"), and routing it through the plugin trust
 * boundary would mean a capability, a permission and a bridge so that
 * first-party code could read first-party state.
 *
 * The numbers shown are estimates and are labelled as such. The only measured
 * figure the host can supply is how full the model window is, and only when a
 * model is selected.
 */

interface EditorState {
  path: string;
  content: string;
  mtimeMs: number;
  /** File does not exist yet; saving creates it. Nothing is written before that. */
  isNew: boolean;
  label: string;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  run: () => void;
}

const SECTION_DEFAULTS: Record<string, boolean> = {
  prompt: true,
  base: false,
  appended: false,
  contextFiles: true,
  skills: false,
  tools: false,
};

export function ContextPanel() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useUIStore((s) => s.activeWorkspaceId);
  // The plugin index is part of the standing context, so an install/uninstall
  // makes the report stale. Folding the plugin set into the query key is what
  // refreshes it — no event plumbing needed.
  const pluginSignature = usePluginStore((s) =>
    s.plugins
      .map((p) => p.id)
      .sort()
      .join(','),
  );

  const { data: workspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => sdk.workspace.list(),
  });
  const workspacePath = workspaces?.find((w) => w.id === activeWorkspaceId)?.path ?? null;

  const contextQuery = useQuery({
    queryKey: ['agent-context', workspacePath, pluginSignature],
    queryFn: () => sdk.chat.getAgentContextConfig(workspacePath as string),
    enabled: !!workspacePath,
  });

  const [open, setOpen] = useState<Record<string, boolean>>(SECTION_DEFAULTS);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const toggleItem = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['agent-context'] });
  };

  const writeFile = useMutation({
    mutationFn: async (vars: { path: string; content: string; expectedMtime?: number }) =>
      sdk.chat.writeContextFile({ workspacePath: workspacePath as string, ...vars }),
  });

  const deleteFile = useMutation({
    mutationFn: async (vars: { path: string; expectedMtime?: number }) =>
      sdk.chat.deleteContextFile({ workspacePath: workspacePath as string, ...vars }),
  });

  /** Turn a raw host error into something a person can act on. */
  const describe = (err: unknown, action: string): string => {
    const raw = err instanceof Error ? err.message : String(err);
    if (/conflict/i.test(raw)) {
      return `${action}被拒绝：这个文件在你打开之后被外部改过，宿主拒绝写入以免覆盖别人刚做的修改。请先取消、重新打开拿到最新内容。\n（宿主的说明：${raw}）`;
    }
    return raw;
  };

  const saveEditor = async () => {
    if (!editor) return;
    setEditorError(null);
    // Clear any previous outcome: a stale "已保存" sitting next to a new failed
    // attempt reads as if that attempt succeeded.
    setNotice(null);
    try {
      const res = await writeFile.mutateAsync({
        path: editor.path,
        content: editor.content,
        expectedMtime: editor.isNew ? undefined : editor.mtimeMs,
      });
      setEditor(null);
      await refresh();
      setNotice({ kind: 'ok', text: reloadNote(res.reload) });
    } catch (err) {
      setEditorError(describe(err, '保存'));
    }
  };

  const removeFile = (path: string, mtimeMs: number) => {
    setConfirm({
      title: '删除这个文件？',
      description: `${path}\n\n删掉之后，它替换或追加的内容会立即从系统提示词里消失，恢复成没有这个文件时的样子。`,
      confirmLabel: '删除',
      destructive: true,
      run: () => {
        void (async () => {
          setNotice(null);
          try {
            const res = await deleteFile.mutateAsync({ path, expectedMtime: mtimeMs });
            if (editor?.path === path) setEditor(null);
            await refresh();
            setNotice({
              kind: 'ok',
              text: res.deleted.deleted ? `已删除。${reloadNote(res.reload)}` : '文件已不存在。',
            });
          } catch (err) {
            setNotice({ kind: 'err', text: describe(err, '删除') });
          }
        })();
      },
    });
  };

  const openEditor = (file: PromptFileInfo) =>
    setEditor({
      path: file.path,
      content: file.content ?? '',
      mtimeMs: file.mtimeMs,
      isNew: !file.exists,
      label: `${PROMPT_KIND_LABEL[file.kind]} · ${file.scope === 'global' ? '全局' : '工作区'}`,
    });

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: 'ok', text: `${label}已复制到剪贴板。` });
    } catch {
      setNotice({ kind: 'err', text: '复制失败：当前环境不允许访问剪贴板。' });
    }
  };

  if (!workspacePath) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        先选择一个工作区
      </div>
    );
  }

  if (contextQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (contextQuery.error || !contextQuery.data) {
    return (
      <ErrorState
        title="读取上下文失败"
        description={contextQuery.error instanceof Error ? contextQuery.error.message : '未知错误'}
        onRetry={() => void contextQuery.refetch()}
      />
    );
  }

  const config = contextQuery.data;
  const specs = sectionSpecs(config);
  const total = budgetTotal(config) || 1;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <Header
        config={config}
        onRefresh={() => void contextQuery.refetch()}
        refreshing={contextQuery.isFetching}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {(['prompt', 'base', 'appended', 'contextFiles', 'skills', 'tools'] as const).map((id) => (
          <Section
            key={id}
            label={specs[id].label}
            chars={specs[id].chars}
            budget={specs[id].budget}
            total={total}
            open={open[id]}
            onToggle={() => toggle(id)}
          >
            {id === 'prompt' && (
              <PromptFilesSection
                config={config}
                editor={editor}
                editorError={editorError}
                saving={writeFile.isPending}
                onEdit={openEditor}
                onCancel={() => {
                  setEditor(null);
                  setEditorError(null);
                }}
                onSave={() => void saveEditor()}
                onContentChange={(content) =>
                  setEditor((e) => (e ? { ...e, content } : e))
                }
                onDelete={removeFile}
                onConfirm={setConfirm}
              />
            )}
            {id === 'base' && (
              <BaseSection
                config={config}
                expanded={expanded}
                onToggleItem={toggleItem}
                onConfirm={setConfirm}
                onSeedSystem={() => {
                  const target = config.promptFiles.find(
                    (f) => f.kind === 'system' && f.scope === 'global',
                  );
                  const text = config.sections.base.text;
                  if (!target || text === null) return;
                  setEditorError(null);
                  setEditor({
                    path: target.path,
                    content: `${text}\n`,
                    mtimeMs: 0,
                    isNew: true,
                    label: '替换系统提示词 · 全局',
                  });
                }}
              />
            )}
            {id === 'appended' && (
              <AppendedSection config={config} expanded={expanded} onToggleItem={toggleItem} />
            )}
            {id === 'contextFiles' && (
              <ContextFilesSection
                config={config}
                editor={editor}
                editorError={editorError}
                saving={writeFile.isPending}
                expanded={expanded}
                onToggleItem={toggleItem}
                onEdit={(path, content, mtimeMs) => {
                  setEditorError(null);
                  setEditor({ path, content, mtimeMs, isNew: false, label: '上下文文件' });
                }}
                onCancel={() => {
                  setEditor(null);
                  setEditorError(null);
                }}
                onSave={() => void saveEditor()}
                onContentChange={(content) => setEditor((e) => (e ? { ...e, content } : e))}
                onCreateGlobal={() =>
                  setEditor({
                    path: `${config.agentDir.replace(/\/$/, '')}/AGENTS.md`,
                    content: '# 全局指令\n\n',
                    mtimeMs: 0,
                    isNew: true,
                    label: '全局上下文文件',
                  })
                }
              />
            )}
            {id === 'skills' && (
              <SkillsSection config={config} expanded={expanded} onToggleItem={toggleItem} />
            )}
            {id === 'tools' && <ToolsSection config={config} />}
          </Section>
        ))}

        {notice && (
          <div
            className={cn(
              'mx-3 mb-3 rounded-md border px-2.5 py-2 text-xs',
              notice.kind === 'ok'
                ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                : 'border-destructive/40 text-destructive',
            )}
          >
            {notice.text}
          </div>
        )}
      </div>

      <Footer config={config} onCopy={copy} />

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap">
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.destructive ? 'bg-destructive text-destructive-foreground' : undefined}
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              {confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── chrome ──

function Header({
  config,
  onRefresh,
  refreshing,
}: {
  config: AgentContextConfig;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { totals } = config;
  const pct = Math.round((totals.share ?? 0) * 100);
  return (
    <div className="flex-none border-b px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 text-[13px] font-semibold">上下文</div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title="重新读取"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <span className={refreshing ? 'animate-spin' : undefined}>↻</span>
        </Button>
      </div>
      <div className="mt-1 break-all text-[11px] leading-snug text-muted-foreground">
        当前工作区：{config.workspace.path}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
        <span className="text-[13px] font-semibold text-foreground">{formatCount(totals.chars)}</span>
        <span>字符 · 常驻部分</span>
        <span>· {formatTokens(totals.tokensEst)} tokens（估算）</span>
      </div>
      {totals.windowTokens ? (
        <>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full',
                pct >= 60 ? 'bg-destructive' : pct >= 30 ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${Math.max(1, Math.min(100, pct))}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            占模型窗口 {pct}% · 窗口 {formatCount(totals.windowTokens)} tokens
          </div>
        </>
      ) : null}
    </div>
  );
}

function Footer({
  config,
  onCopy,
}: {
  config: AgentContextConfig;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="flex flex-none gap-1.5 border-t px-3 py-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[11px]"
        disabled={!config.assembled}
        title={config.assembled ? undefined : '需要一次对话后才能读取完整提示词'}
        onClick={() => config.assembled && onCopy(config.assembled.text, '完整系统提示词')}
      >
        复制完整系统提示词
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[11px]"
        onClick={() => onCopy(buildMarkdown(config), 'Markdown 报告')}
      >
        复制 Markdown 报告
      </Button>
    </div>
  );
}

function Section({
  label,
  chars,
  budget,
  total,
  open,
  onToggle,
  children,
}: {
  label: string;
  chars: number;
  budget: boolean;
  total: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
      >
        <span
          className={cn(
            'w-2.5 flex-none text-[10px] text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
        {budget ? (
          <>
            <span className="h-1 w-11 flex-none overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${Math.max(2, Math.round((chars / total) * 100))}%` }}
              />
            </span>
            <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
              {chars > 0 ? `${formatChars(chars)} 字符` : '—'}
            </span>
          </>
        ) : (
          // Not a budget line: its characters are already counted in the
          // sections below (a SYSTEM.md *is* the base prompt), so showing a
          // number here would count the same text twice.
          <Badge variant="outline" className="flex-none text-[10px] font-normal">
            可编辑
          </Badge>
        )}
      </button>
      {open && <div className="px-3 pb-2.5 pl-7">{children}</div>}
    </div>
  );
}

// ── sections ──

function Editor({
  editor,
  error,
  saving,
  onSave,
  onCancel,
  onContentChange,
}: {
  editor: EditorState;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onContentChange: (content: string) => void;
}) {
  return (
    <div className="space-y-1.5 pt-1.5">
      <Textarea
        value={editor.content}
        spellCheck={false}
        onChange={(e) => onContentChange(e.target.value)}
        className="min-h-[160px] font-mono text-[11px] leading-relaxed"
      />
      {error && (
        <div className="whitespace-pre-wrap rounded-md border border-destructive/40 px-2 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" className="h-7 text-[11px]" disabled={saving} onClick={onSave}>
          {saving ? '保存中…' : editor.isNew ? '创建并生效' : '保存'}
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onCancel}>
          取消
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {editor.isNew
            ? '保存之前不会写入任何文件，取消就等于什么都没做。'
            : '保存后立即生效；正在生成回复时则于下一个新会话生效。'}
        </span>
      </div>
    </div>
  );
}

function PromptFilesSection({
  config,
  editor,
  editorError,
  saving,
  onEdit,
  onCancel,
  onSave,
  onContentChange,
  onDelete,
  onConfirm,
}: {
  config: AgentContextConfig;
  editor: EditorState | null;
  editorError: string | null;
  saving: boolean;
  onEdit: (file: PromptFileInfo) => void;
  onCancel: () => void;
  onSave: () => void;
  onContentChange: (content: string) => void;
  onDelete: (path: string, mtimeMs: number) => void;
  onConfirm: (c: ConfirmState) => void;
}) {
  if (config.promptFiles.length === 0) {
    return <div className="py-2 text-[11px] text-muted-foreground">宿主没有报告任何提示词文件。</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        这两个文件就是系统提示词本身。写入后下一条消息生效；删掉就恢复默认。
      </p>
      {promptFileGroups(config.promptFiles).map((group) => (
        <div key={group.kind} className="space-y-1.5">
          <div className="text-[11px] font-semibold">
            {PROMPT_KIND_LABEL[group.kind]} · {group.kind === 'system' ? 'SYSTEM.md' : 'APPEND_SYSTEM.md'}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {PROMPT_KIND_HINT[group.kind]}
          </p>
          {group.files.map((file) => (
            <PromptFileRow
              key={file.path}
              file={file}
              editor={editor}
              editorError={editorError}
              saving={saving}
              onEdit={onEdit}
              onCancel={onCancel}
              onSave={onSave}
              onContentChange={onContentChange}
              onDelete={onDelete}
              onConfirm={onConfirm}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function PromptFileRow({
  file,
  editor,
  ...handlers
}: {
  file: PromptFileInfo;
  editor: EditorState | null;
  editorError: string | null;
  saving: boolean;
  onEdit: (file: PromptFileInfo) => void;
  onCancel: () => void;
  onSave: () => void;
  onContentChange: (content: string) => void;
  onDelete: (path: string, mtimeMs: number) => void;
  onConfirm: (c: ConfirmState) => void;
}) {
  const status = promptFileStatus(file);
  const isEditing = editor?.path === file.path;
  // Creating a SYSTEM.md replaces the whole built-in prompt, so it asks first.
  // An APPEND_SYSTEM.md only adds, and does not.
  const destructive = file.kind === 'system';

  return (
    <div className="border-t pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            'flex-none text-[10px] font-normal',
            status === 'active' && 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
          )}
        >
          {promptStatusLabel(status)}
        </Badge>
        <Badge variant="outline" className="flex-none text-[10px] font-normal">
          {file.scope === 'global' ? '全局' : '工作区'}
        </Badge>
        <div className="flex-1" />
        <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
          {file.exists ? `${formatChars(file.chars)} 字符` : '—'}
        </span>
      </div>
      <div className="mt-1 break-all text-[11px] text-muted-foreground">{file.path}</div>
      {status === 'shadowed' && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          这个文件在磁盘上存在，但同类的另一个文件优先级更高，所以它当前不起作用。
        </p>
      )}

      {isEditing && editor ? (
        <Editor
          editor={editor}
          error={handlers.editorError}
          saving={handlers.saving}
          onSave={handlers.onSave}
          onCancel={handlers.onCancel}
          onContentChange={handlers.onContentChange}
        />
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {file.exists ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => handlers.onEdit(file)}
              >
                编辑
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => handlers.onDelete(file.path, file.mtimeMs)}
              >
                删除
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                const open = () => handlers.onEdit(file);
                if (!destructive) return open();
                handlers.onConfirm({
                  title: '开始替换系统提示词？',
                  description:
                    '接下来会打开一个空编辑器。在你点保存之前不会写入任何文件，所以现在取消等于什么都没做；一旦保存，agent 的行为就由这个文件决定。',
                  confirmLabel: '继续',
                  run: open,
                });
              }}
            >
              创建
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function BaseSection({
  config,
  expanded,
  onToggleItem,
  onConfirm,
  onSeedSystem,
}: {
  config: AgentContextConfig;
  expanded: Record<string, boolean>;
  onToggleItem: (key: string) => void;
  onConfirm: (c: ConfirmState) => void;
  onSeedSystem: () => void;
}) {
  const base = config.sections.base;
  const target = config.promptFiles.find((f) => f.kind === 'system' && f.scope === 'global');

  return (
    <div className="space-y-2">
      {base.text === null ? (
        <div className="rounded-md border px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {base.note}
        </div>
      ) : (
        <div className="border-t pt-1.5 first:border-t-0 first:pt-0">
          <ItemHead
            name="基础系统提示词"
            size={`${formatChars(base.chars ?? 0)} 字符`}
            open={expanded.base}
            onToggle={() => onToggleItem('base')}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{base.note}</p>
          {expanded.base && <Pre>{base.text}</Pre>}
        </div>
      )}

      {config.assembled && (
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onToggleItem('assembled')}
            >
              {expanded.assembled ? '收起完整提示词' : '查看完整系统提示词'}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {formatChars(config.assembled.chars)} 字符，{formatTokens(config.assembled.tokensEst)} tokens（估算）
            </span>
          </div>
          {expanded.assembled && <Pre>{config.assembled.text}</Pre>}
        </div>
      )}

      {/* Editing the built-in prompt in place is impossible — the SDK's text is
          not exported — but it can be *replaced*. Seeding SYSTEM.md with the
          current text is the closest thing to opening the built-in prompt in an
          editor: a real starting point instead of a blank file and a broken
          agent. */}
      {!base.overridden && base.text !== null && target && !target.exists && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() =>
              onConfirm({
                title: '以当前提示词为起点创建 SYSTEM.md？',
                description:
                  '会打开一个已经填好当前提示词的编辑器。在你点保存之前不会写入任何文件；保存后写入 ~/.pi/agent/SYSTEM.md，agent 的行为从那一刻起完全由它决定。',
                confirmLabel: '继续',
                run: onSeedSystem,
              })
            }
          >
            以当前提示词为起点创建 SYSTEM.md
          </Button>
        </div>
      )}
    </div>
  );
}

function AppendedSection({
  config,
  expanded,
  onToggleItem,
}: {
  config: AgentContextConfig;
  expanded: Record<string, boolean>;
  onToggleItem: (key: string) => void;
}) {
  const segments = config.sections.appended;
  if (segments.length === 0) {
    return (
      <div className="rounded-md border px-2 py-1.5 text-[11px] text-muted-foreground">
        宿主没有向系统提示词追加任何内容。
      </div>
    );
  }
  const maxPluginChars = config.pluginDocs.reduce((n, d) => Math.max(n, d.chars), 1);

  return (
    <div className="space-y-2">
      {segments.map((segment) => {
        const key = `appended:${segment.label}`;
        return (
          <div key={key} className="border-t pt-1.5 first:border-t-0 first:pt-0">
            <ItemHead
              name={segment.label}
              badge={segment.source === 'host' ? '宿主' : segment.source === 'plugin-docs' ? '插件' : '你写的'}
              size={`${formatChars(segment.chars)} 字符`}
              open={expanded[key]}
              onToggle={() => onToggleItem(key)}
            />
            {segment.source === 'plugin-docs' && config.pluginDocs.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                <div className="text-[11px] text-muted-foreground">
                  每个已装插件在这段索引里占的字符数：
                </div>
                {[...config.pluginDocs]
                  .sort((a, b) => b.chars - a.chars)
                  .map((doc) => (
                    <div key={doc.pluginId} className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px]">{doc.name}</span>
                      <span className="h-1 w-11 flex-none overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(2, Math.round((doc.chars / maxPluginChars) * 100))}%` }}
                        />
                      </span>
                      <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                        {formatChars(doc.chars)} 字符
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {expanded[key] && <Pre>{segment.text}</Pre>}
          </div>
        );
      })}
    </div>
  );
}

function ContextFilesSection({
  config,
  editor,
  expanded,
  onCreateGlobal,
  ...handlers
}: {
  config: AgentContextConfig;
  editor: EditorState | null;
  editorError: string | null;
  saving: boolean;
  expanded: Record<string, boolean>;
  onToggleItem: (key: string) => void;
  onEdit: (path: string, content: string, mtimeMs: number) => void;
  onCancel: () => void;
  onSave: () => void;
  onContentChange: (content: string) => void;
  onCreateGlobal: () => void;
}) {
  const files = config.sections.contextFiles;
  const hasGlobal = files.some((f) => f.scope === 'global');

  return (
    <div className="space-y-2">
      {files.length === 0 && (
        <div className="rounded-md border px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          没有找到 AGENTS.md / CLAUDE.md。放进这些文件的内容会成为 agent 的常驻指令。
        </div>
      )}
      {files.map((file) => {
        const isEditing = editor?.path === file.path;
        const key = `file:${file.path}`;
        return (
          <div key={file.path} className="border-t pt-1.5 first:border-t-0 first:pt-0">
            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  'flex-none text-[10px] font-normal',
                  file.scope === 'global' && 'border-primary/40 text-primary',
                )}
              >
                {scopeLabel(file.scope)}
              </Badge>
              <div className="flex-1" />
              <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                {formatChars(file.chars)} 字符
              </span>
            </div>
            <div className="mt-1 break-all text-[11px] text-muted-foreground">{file.path}</div>
            {isEditing && editor ? (
              <Editor
                editor={editor}
                error={handlers.editorError}
                saving={handlers.saving}
                onSave={handlers.onSave}
                onCancel={handlers.onCancel}
                onContentChange={handlers.onContentChange}
              />
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => handlers.onEdit(file.path, file.content, file.mtimeMs)}
                >
                  编辑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => handlers.onToggleItem(key)}
                >
                  {expanded[key] ? '收起内容' : '查看内容'}
                </Button>
              </div>
            )}
            {!isEditing && expanded[key] && <Pre>{file.content}</Pre>}
          </div>
        );
      })}
      {!hasGlobal && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onCreateGlobal}>
            创建全局 AGENTS.md
          </Button>
          <span className="text-[11px] text-muted-foreground">
            在 agent 目录下创建，对所有工作区生效。保存前不写盘。
          </span>
        </div>
      )}
    </div>
  );
}

function SkillsSection({
  config,
  expanded,
  onToggleItem,
}: {
  config: AgentContextConfig;
  expanded: Record<string, boolean>;
  onToggleItem: (key: string) => void;
}) {
  const { items, rendered } = config.sections.skills;
  if (items.length === 0) {
    return (
      <div className="rounded-md border px-2 py-1.5 text-[11px] text-muted-foreground">没有发现技能。</div>
    );
  }
  return (
    <div className="space-y-2">
      {items.map((skill) => (
        <div key={skill.name} className="border-t pt-1.5 first:border-t-0 first:pt-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px]">{skill.name}</span>
            <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
              {formatChars(skill.chars)} 字符
            </span>
          </div>
          {skill.description && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{skill.description}</p>
          )}
          {skill.path && (
            <div className="mt-0.5 break-all text-[11px] text-muted-foreground">{skill.path}</div>
          )}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-[11px]"
        onClick={() => onToggleItem('skills:rendered')}
      >
        {expanded['skills:rendered'] ? '收起提示词片段' : '查看提示词片段'}
      </Button>
      {expanded['skills:rendered'] && <Pre>{rendered}</Pre>}
    </div>
  );
}

function ToolsSection({ config }: { config: AgentContextConfig }) {
  const tools = config.sections.tools;
  if (tools.length === 0) {
    return (
      <div className="rounded-md border px-2 py-1.5 text-[11px] text-muted-foreground">没有可用的工具信息。</div>
    );
  }
  // Grouped by origin: "which plugin costs me how much schema" is the question
  // this section exists to answer. Plugin ids are mapped to display names via
  // the plugin docs, which carry both.
  const nameOf = new Map(config.pluginDocs.map((d) => [d.pluginId, d.name]));
  const groups = new Map<string, typeof tools>();
  for (const tool of tools) {
    const key = tool.source === 'builtin' ? '内置' : (nameOf.get(tool.source) ?? tool.source);
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }

  return (
    <div className="space-y-2">
      {[...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([group, list]) => (
          <div key={group}>
            <div className="text-[11px] font-semibold">
              {group} · {list.length} 个 ·{' '}
              {formatChars(list.reduce((n, t) => n + t.schemaBytes, 0))} 字符
            </div>
            {list.map((tool) => (
              <div key={tool.name} className="border-t pt-1 first:mt-1 first:border-t-0">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px]">{tool.name}</span>
                  <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                    {tool.schemaBytes > 0 ? `${formatChars(tool.schemaBytes)} 字符` : '—'}
                  </span>
                </div>
                {tool.description && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {tool.description}
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

// ── small pieces ──

function ItemHead({
  name,
  size,
  badge,
  open,
  onToggle,
}: {
  name: string;
  size: string;
  badge?: string;
  open?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
      {badge && (
        <Badge variant="outline" className="flex-none text-[10px] font-normal">
          {badge}
        </Badge>
      )}
      <span className="flex-none text-[11px] tabular-nums text-muted-foreground">{size}</span>
      <Button variant="outline" size="sm" className="h-6 flex-none px-2 text-[11px]" onClick={onToggle}>
        {open ? '收起' : '展开'}
      </Button>
    </div>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-2 font-mono text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}

