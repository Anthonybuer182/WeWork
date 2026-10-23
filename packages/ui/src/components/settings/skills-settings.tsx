import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, FolderPlus, Loader2, Sparkles, X } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/loading-spinner';

/**
 * 技能 — what the agent can be told it knows how to do.
 *
 * This page can list discovered skills and manage extra search directories
 * (written to `settings.skills`). It deliberately offers no per-skill switch:
 * the SDK has no global enable/disable for skills — selection is per
 * conversation (the composer's skill picker). A switch here would be a control
 * nothing reads.
 */
export function SkillsSettingsPage() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const {
    data: skills,
    isLoading,
    error: skillsError,
    refetch: refetchSkills,
  } = useQuery({
    queryKey: ['skills'],
    queryFn: () => sdk.config.listSkills(),
  });

  const {
    data: extraPaths,
    isLoading: pathsLoading,
    error: pathsError,
    refetch: refetchPaths,
  } = useQuery({
    queryKey: ['skillPaths'],
    queryFn: () => sdk.config.getSkillPaths(),
  });

  const savePaths = useMutation({
    mutationFn: (paths: string[]) => sdk.config.setSkillPaths(paths),
    onSuccess: (_result, paths) => {
      setError(null);
      // Write the result straight into the cache: the refetch below is async,
      // and a second add/remove landing before it would otherwise read the
      // previous list and drop the change just made.
      queryClient.setQueryData(['skillPaths'], paths);
      void queryClient.invalidateQueries({ queryKey: ['skillPaths'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-context'] });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const addDirectory = async () => {
    setError(null);
    try {
      const picked = (await sdk.transport.request('system.selectDirectory')) as string | null;
      if (!picked) return;
      // Read at resolve time, not from the render that opened the picker: the
      // query may have arrived while the folder chooser was up, and the
      // closure's list would be stale (saving it would drop the new entries).
      const current = queryClient.getQueryData<string[]>(['skillPaths']);
      if (!current) {
        setError('技能目录还没读取完成，请稍后再试');
        return;
      }
      if (current.includes(picked)) return;
      savePaths.mutate([...current, picked]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeDirectory = (path: string) => {
    const current = queryClient.getQueryData<string[]>(['skillPaths']);
    if (!current) return;
    savePaths.mutate(current.filter((p) => p !== path));
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-6 py-5">
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">已发现的技能</h3>
          {!isLoading && !skillsError && (
            <span className="text-xs text-muted-foreground">{skills?.length ?? 0} 个</span>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          技能的索引会随每次对话提供给模型；具体用哪些，可以在输入框的技能菜单里按会话选择。
        </p>

        <div className="mt-3">
          {skillsError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                读取技能失败：{skillsError instanceof Error ? skillsError.message : String(skillsError)}
              </span>
              <button
                type="button"
                onClick={() => void refetchSkills()}
                className="shrink-0 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                重试
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoadingSpinner />
            </div>
          ) : skills && skills.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {skills.map((skill) => (
                <li key={skill.id} className="flex items-start gap-3 px-3 py-2.5">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm">{skill.name}</div>
                    {skill.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {skill.description}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
              还没有发现技能。技能是带 SKILL.md 的目录，放进下面任一位置即可。
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">额外技能目录</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void addDirectory()}
            disabled={savePaths.isPending || pathsLoading || !!pathsError}
          >
            {savePaths.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="mr-1 h-3.5 w-3.5" />
            )}
            添加目录
          </Button>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          这些目录写入全局设置，对所有工作区生效（工作区的 .pi/settings.json
          若配置了技能目录会整体覆盖这里）。扫描顺序是 ~/.agents/skills、额外目录、
          ~/.pi/agent/skills、工作区，同名技能以靠前的为准。
        </p>

        <div className="mt-3 space-y-3">
          <div className="rounded-md border bg-muted/20 px-3 py-2.5">
            <div className="text-[11px] font-medium text-muted-foreground">内置位置</div>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
              <li>~/.agents/skills</li>
              <li>~/.pi/agent/skills</li>
              <li>&lt;工作区&gt;/.pi/skills</li>
            </ul>
          </div>

          {pathsError ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                读取额外目录失败：{pathsError instanceof Error ? pathsError.message : String(pathsError)}
              </span>
              <button
                type="button"
                onClick={() => void refetchPaths()}
                className="shrink-0 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                重试
              </button>
            </div>
          ) : pathsLoading ? (
            <p className="text-xs text-muted-foreground">读取中…</p>
          ) : extraPaths && extraPaths.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {extraPaths.map((path) => (
                <li key={path} className="flex items-center gap-2 px-3 py-2">
                  <code className="min-w-0 flex-1 break-all text-[11px]">{path}</code>
                  <button
                    type="button"
                    aria-label={`移除 ${path}`}
                    onClick={() => removeDirectory(path)}
                    disabled={savePaths.isPending}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">没有额外目录。</p>
          )}
        </div>
      </section>
    </div>
  );
}
