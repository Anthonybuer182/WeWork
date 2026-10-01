import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2, CircleAlert, CircleCheck, Settings2, ChevronDown, Puzzle, Undo2, Search } from 'lucide-react';
import type { MarketEntry, PluginInfo, PluginSettingInfo } from '@pi/types';
import { describePermission } from '@pi/types';
import { usePluginStore } from '@/stores/plugin-store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<string, string> = { dev: '开发', user: '已安装' };
const STATE_LABEL: Record<string, string> = {
  active: '运行中', activating: '启动中', registered: '已注册', disabled: '已禁用',
  incompatible: '不兼容', error: '错误', crashed: '已崩溃',
};

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** ── Auto-generated settings form (contributes.settings) ── */
function PluginSettingsSection({ pluginId, settings }: { pluginId: string; settings: PluginSettingInfo[] }) {
  const loadPluginSettings = usePluginStore((s) => s.loadPluginSettings);
  const setPluginSetting = usePluginStore((s) => s.setPluginSetting);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || values) return;
    loadPluginSettings(pluginId).then(setValues);
  }, [open, values, pluginId, loadPluginSettings]);

  const update = (key: string, value: unknown) => {
    setValues((v) => ({ ...(v ?? {}), [key]: value }));
    setPluginSetting(pluginId, key, value);
  };

  return (
    <div className="mt-2 rounded-md border border-dashed p-2" data-plugin-settings={pluginId}>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <Settings2 className="h-3 w-3" />
        插件设置({settings.length})
        <ChevronDown className={cn('ml-auto h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2.5">
          {!values && <div className="text-xs text-muted-foreground">加载中…</div>}
          {values && settings.map((setting) => (
            <div key={setting.key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium">{setting.label ?? setting.key}</div>
                {setting.description ? <div className="text-[10px] text-muted-foreground">{setting.description}</div> : null}
              </div>
              {setting.type === 'boolean' ? (
                <Switch
                  checked={values[setting.key] === true}
                  onCheckedChange={(checked) => update(setting.key, checked)}
                  aria-label={setting.label ?? setting.key}
                  data-setting-key={setting.key}
                />
              ) : setting.type === 'enum' && setting.options?.length ? (
                <select
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                  value={String(values[setting.key] ?? '')}
                  onChange={(e) => update(setting.key, e.target.value)}
                  data-setting-key={setting.key}
                >
                  {setting.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <Input
                  className="h-7 w-44 text-xs"
                  type={setting.type === 'number' ? 'number' : 'text'}
                  value={String(values[setting.key] ?? '')}
                  onChange={(e) => update(setting.key, setting.type === 'number' ? Number(e.target.value) : e.target.value)}
                  data-setting-key={setting.key}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** ── Plugin brand icon (plugin-provided stencil, Puzzle fallback) ── */
function PluginBrandIcon({ iconUrl, name }: { iconUrl?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!iconUrl) return;
    const probe = new Image();
    probe.onerror = () => setBroken(true);
    probe.src = iconUrl;
    return () => { probe.onerror = null; };
  }, [iconUrl]);
  if (iconUrl && !broken) {
    return (
      <span
        role="img"
        aria-label={name}
        className="mt-0.5 shrink-0 bg-current text-muted-foreground"
        style={{
          width: 32,
          height: 32,
          WebkitMaskImage: `url(${iconUrl})`,
          maskImage: `url(${iconUrl})`,
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }
  return <Puzzle className="mt-0.5 h-8 w-8 shrink-0 text-muted-foreground/50" />;
}

/** ── Installed plugin row ── */
function InstalledItem({ plugin }: { plugin: PluginInfo }) {
  const setPluginEnabled = usePluginStore((s) => s.setPluginEnabled);
  const uninstallPlugin = usePluginStore((s) => s.uninstallPlugin);
  const installPlugin = usePluginStore((s) => s.installPlugin);
  const rollbackPlugin = usePluginStore((s) => s.rollbackPlugin);
  const catalog = usePluginStore((s) => s.catalog);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);

  // Only a plugin that actually lives in the user's plugin root can be
  // replaced, rolled back, or uninstalled there — a dev copy's directory is
  // the checkout's source tree, and removing it is never what "uninstall"
  // means. The trash button is ALWAYS visible (VS Code never hides the
  // affordance either); for a dev plugin the dialog explains instead of
  // deleting, and the backend refuses the call regardless.
  const manageable = plugin.source === 'user';
  const inMarket = catalog.some((e) => e.id === plugin.id);
  const broken = plugin.state === 'error' || plugin.state === 'crashed';

  const stateBadge = () => {
    if (plugin.state === 'disabled') return <Badge variant="secondary">已禁用</Badge>;
    if (plugin.state === 'incompatible' || plugin.state === 'error')
      return <Badge variant="destructive">{STATE_LABEL[plugin.state] ?? plugin.state}</Badge>;
    if (plugin.state === 'active')
      return <Badge variant="outline" className="gap-1 text-emerald-600"><CircleCheck className="h-3 w-3" />运行中</Badge>;
    return <Badge variant="outline">{STATE_LABEL[plugin.state] ?? plugin.state}</Badge>;
  };

  return (
    <div data-installed-plugin={plugin.id} className="flex items-start gap-3 rounded-lg border p-3">
      <PluginBrandIcon iconUrl={plugin.iconUrl} name={plugin.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{plugin.name}</span>
          <span className="text-xs text-muted-foreground">v{plugin.version}</span>
          <Badge variant="secondary">{SOURCE_LABEL[plugin.source] ?? plugin.source}</Badge>
          {stateBadge()}
        </div>
        {plugin.description ? <div className="mt-1 text-xs text-muted-foreground">{plugin.description}</div> : null}
        {plugin.error ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />{plugin.error}
          </div>
        ) : null}
        {plugin.permissions.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {plugin.permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">{p}</Badge>
            ))}
          </div>
        ) : null}

        {/*
          The way out of a plugin that will not run.

          `重装` re-fetches from the market — right for a corrupted copy, useless
          when the published version itself is what broke. That case needs
          `回到上一版`, which only exists after an upgrade; the label names the
          version so it is clear what the button would do.
        */}
        {manageable && (broken || plugin.previousVersion) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {broken && inMarket ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void installPlugin(plugin.id).finally(() => setBusy(false));
                }}
              >
                <RefreshCw className="mr-1 h-3 w-3" />重装
              </Button>
            ) : null}
            {plugin.previousVersion ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void rollbackPlugin(plugin.id).finally(() => setBusy(false));
                }}
              >
                <Undo2 className="mr-1 h-3 w-3" />回到 v{plugin.previousVersion}
              </Button>
            ) : null}
          </div>
        ) : null}
        {plugin.settings?.length ? <PluginSettingsSection pluginId={plugin.id} settings={plugin.settings} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={plugin.state !== 'disabled'}
          disabled={plugin.state === 'incompatible' || busy}
          onCheckedChange={(checked) => {
            setBusy(true);
            setPluginEnabled(plugin.id, checked).finally(() => setBusy(false));
          }}
          aria-label={`启用/禁用 ${plugin.name}`}
        />
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setConfirmOpen(true)} aria-label={`卸载 ${plugin.name}`}>
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>

      {/* Uninstall dialog — two variants.
        * user copy: confirm, with data retention opt-out.
        * dev copy: never deletes. The dialog explains where the plugin really
        * lives and what removal would actually mean — the affordance stays
        * visible (hiding it just made "how do I uninstall" undiscoverable),
        * but the repo source tree is not what a dialog gets to rm. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          {manageable ? (
            <>
              <DialogHeader>
                <DialogTitle>卸载「{plugin.name}」?</DialogTitle>
                <DialogDescription>
                  将删除插件代码目录。插件数据默认保留,重装后可恢复。
                </DialogDescription>
              </DialogHeader>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={keepData} onCheckedChange={setKeepData} aria-label="保留插件数据" />
                保留插件数据(plugins-data/{plugin.id})
              </label>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>取消</Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    setConfirmOpen(false);
                    setBusy(true);
                    await uninstallPlugin(plugin.id, keepData);
                    setBusy(false);
                  }}
                >
                  卸载
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>「{plugin.name}」是开发副本</DialogTitle>
                <DialogDescription>
                  它直接运行自仓库源码目录,不是安装副本,因此没有"卸载"可言。
                  要移除:从仓库 plugins/ 删除对应目录,或把它从 dev 根里拿走;
                  只想停用的话,用左侧的开关就够了。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>知道了</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** ── Catalog entry row ── */
function CatalogItem({ entry }: { entry: MarketEntry }) {
  const installed = usePluginStore((s) => s.installed);
  const installPhases = usePluginStore((s) => s.installPhases);
  const marketErrors = usePluginStore((s) => s.marketErrors);
  const installPlugin = usePluginStore((s) => s.installPlugin);

  const existing = installed.find((p) => p.id === entry.id);
  const phase = installPhases[entry.id];
  const error = marketErrors[entry.id];
  const updatable = existing && existing.version !== entry.version;

  return (
    <div data-catalog-plugin={entry.id} className="flex items-start gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{entry.name}</span>
          <span className="text-xs text-muted-foreground">v{entry.version}</span>
          {existing ? (
            <Badge variant="secondary">{updatable ? `可更新(${existing.version} → ${entry.version})` : '已安装'}</Badge>
          ) : null}
          {entry.size ? <span className="text-[10px] text-muted-foreground">{formatSize(entry.size)}</span> : null}
        </div>
        {entry.description ? <div className="mt-1 text-xs text-muted-foreground">{entry.description}</div> : null}
        {entry.permissions?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">{p}</Badge>
            ))}
          </div>
        ) : null}
        {error ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />{error}
          </div>
        ) : null}
      </div>
      <InstallButton entry={entry} phase={phase} installed={!!existing} updatable={!!updatable} onInstall={() => installPlugin(entry.id)} />
    </div>
  );
}

function InstallButton({
  entry, phase, installed, updatable, onInstall,
}: {
  entry: MarketEntry;
  phase?: string;
  installed: boolean;
  updatable: boolean;
  onInstall: () => void;
}) {
  const [consentOpen, setConsentOpen] = useState(false);

  if (phase) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {phase === 'downloading' ? '下载中' : phase === 'verifying' ? '校验中' : phase === 'installing' ? '安装中' : '启动中'}
      </div>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={installed ? (updatable ? 'default' : 'secondary') : 'default'}
        onClick={() => setConsentOpen(true)}
        data-install-trigger={entry.id}
      >
        {installed ? (updatable ? '更新' : '重装') : '安装'}
      </Button>

      {/* Permission consent dialog */}
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>安装「{entry.name}」</DialogTitle>
            <DialogDescription>
              该插件声明以下权限,安装后即可使用:
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-1">
            {(entry.permissions?.length ? entry.permissions : []).map((p) => {
              const meta = describePermission(p);
              return (
                <div key={p} className="flex items-start gap-2 rounded-md border p-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{meta.label}<span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{p}</span></div>
                    <div className="text-xs text-muted-foreground">{meta.description}</div>
                  </div>
                </div>
              );
            })}
            {!entry.permissions?.length && <div className="text-xs text-muted-foreground">该插件未声明任何权限。</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConsentOpen(false)}>取消</Button>
            <Button
              size="sm"
              onClick={() => {
                setConsentOpen(false);
                onInstall();
              }}
            >
              确认安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Plugin center — VS Code-extensions-style: ONE list that flips on the search
 * box. Empty query shows the installed plugins (enable/disable/uninstall);
 * typing searches the market (install, with permission consent). No separate
 * catalog section — the market is only ever seen through search.
 */
export function PluginCenter() {
  const installed = usePluginStore((s) => s.installed);
  const catalog = usePluginStore((s) => s.catalog);
  const catalogLoading = usePluginStore((s) => s.catalogLoading);
  const catalogError = usePluginStore((s) => s.catalogError);
  const loadCatalog = usePluginStore((s) => s.loadCatalog);
  const installPhases = usePluginStore((s) => s.installPhases);
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const searching = query.trim().length > 0;

  const sortedInstalled = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );

  // Market search is a client-side filter over the fetched index — the
  // registry is a flat index.json (file path today, https later), so search
  // happens here either way. Matches name, id and description; Chinese
  // substrings work as-is.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog.filter((e) =>
      [e.name, e.id, e.description ?? ''].some((t) => t.toLowerCase().includes(q)),
    );
  }, [catalog, query]);

  return (
    <div className="h-full overflow-auto p-3" data-panel-kind="plugin-center">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {searching ? `市场结果(${results.length})` : `已安装(${installed.length})`}
        </h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadCatalog(true)} aria-label="刷新市场">
          <RefreshCw className={cn('h-3.5 w-3.5', catalogLoading && 'animate-spin')} />
        </Button>
      </div>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索市场插件…"
          className="h-8 pl-7 text-xs"
          aria-label="搜索市场插件"
          data-market-search
        />
      </div>

      {catalogError ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          市场加载失败:{catalogError}
        </div>
      ) : searching ? (
        <div className="flex flex-col gap-2">
          {catalogLoading && (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              市场加载中…
            </div>
          )}
          {!catalogLoading && results.map((entry) => (
            <CatalogItem key={entry.id} entry={entry} />
          ))}
          {!catalogLoading && results.length === 0 && (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              没有匹配「{query.trim()}」的插件
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedInstalled.map((plugin) => (
            <InstalledItem key={plugin.id} plugin={plugin} />
          ))}
          {sortedInstalled.length === 0 && (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              尚未安装插件 —— 用上方搜索框从市场安装
            </div>
          )}
        </div>
      )}

      {Object.keys(installPhases).length > 0 && (
        <div className="mt-3 text-center text-[10px] text-muted-foreground">
          安装进行中:{Object.keys(installPhases).join(', ')}
        </div>
      )}
    </div>
  );
}
