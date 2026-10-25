import { useEffect } from 'react';
import { useToolStore } from '@/stores/tool-store';
import { groupToolCatalog } from '@/lib/tool-catalog';
import { Switch } from '@/components/ui/switch';
import { LoadingSpinner } from '@/components/common/loading-spinner';
import { useI18n, type MessageKey } from '@/i18n';

/**
 * Short, user-facing descriptions for the tools whose model-facing text is
 * verbose English. Plugin tools keep their own names; their group header
 * already says where they come from.
 */
const SHORT_HINTS: Record<string, MessageKey> = {
  read: '读取文件内容',
  bash: '执行 shell 命令',
  edit: '修改文件',
  write: '写入文件',
  asktool: '遇到拿不准的决策时向你提问',
  todotool: '多步任务的实时清单',
  context_audit: '报告当前上下文的占用',
};

/**
 * 工具 — what the agent is allowed to use.
 *
 * Global availability, not a per-conversation choice (the composer's picker
 * narrows that). Switching a tool off removes it from the model's tool list
 * and from the standing prompt; it is not a hint the model may ignore. The
 * change applies to the next request of an open conversation, not just to new
 * ones — sessions are rebuilt when the set changes.
 */
export function ToolsSettingsPage() {
  const { t } = useI18n();
  const catalog = useToolStore((s) => s.catalog);
  const disabled = useToolStore((s) => s.disabled);
  const loaded = useToolStore((s) => s.loaded);
  const sync = useToolStore((s) => s.sync);
  const setEnabled = useToolStore((s) => s.setEnabled);

  useEffect(() => {
    void sync();
  }, [sync]);

  // Not memoized: `t` has a stable identity by design (it reads the language
  // store at call time), so a memo would keep group titles in the old language
  // after a language switch. Thirty rows are cheap to rebuild.
  const groups = groupToolCatalog(catalog, t);
  const off = new Set(disabled);

  if (!loaded && catalog.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-x-hidden overflow-y-auto overscroll-contain px-6 py-2">
      <p className="pb-2 pt-2 text-[11px] leading-relaxed text-muted-foreground/70">
        {t('关闭后模型看不到这个工具，也不会在提示词里提到它。设置保存在本机，下一次发送时生效。')}
      </p>

      {groups.length === 0 && (
        <p className="py-6 text-center text-xs text-muted-foreground">{t('还没有可用的工具。')}</p>
      )}

      {groups.map((group) => (
        <div key={group.key} className="w-full pt-3">
          <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {group.title}
          </div>
          <div className="w-full divide-y">
            {group.items.map((tool) => {
              const hint = SHORT_HINTS[tool.name];
              return (
                <div
                  key={tool.name}
                  className="flex w-full items-start justify-between gap-6 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm">{tool.name}</div>
                    {hint ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {t(hint)}
                      </p>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground/70" title={tool.description}>
                        {tool.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center pt-0.5">
                    <Switch
                      checked={!off.has(tool.name)}
                      onCheckedChange={(checked) => setEnabled(tool.name, checked)}
                      aria-label={tool.name}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
