import { useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2, CircleAlert, CircleCheck, Settings2, ChevronDown, Puzzle } from 'lucide-react';
import type { MarketEntry, PluginInfo, PluginSettingInfo } from '@pi/types';
import { describePermission } from '@pi/types';
import { usePluginStore } from '@/stores/plugin-store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<string, string> = { dev: '开发', user: '已安装', builtin: '内置' };
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [busy, setBusy] = useState(false);

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

      {/* Uninstall confirm — data retention opt-out */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
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
  const isNote = entry.id === 'com.pi.notes'; // test hooks

  return (
    <div data-catalog-plugin={entry.id} data-testid-note={isNote ? 'true' : undefined} className="flex items-start gap-3 rounded-lg border p-3">
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
 * Plugin center — host-contributed panel: installed plugin management
 * (enable/disable/uninstall) + marketplace catalog with permission consent.
 */
export function PluginCenter() {
  const installed = usePluginStore((s) => s.installed);
  const catalog = usePluginStore((s) => s.catalog);
  const catalogLoading = usePluginStore((s) => s.catalogLoading);
  const catalogError = usePluginStore((s) => s.catalogError);
  const loadCatalog = usePluginStore((s) => s.loadCatalog);
  const installPhases = usePluginStore((s) => s.installPhases);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const sortedInstalled = useMemo(
    () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    [installed],
  );

  return (
    <div className="h-full overflow-auto p-3" data-panel-kind="plugin-center">
      {/* ── Installed ── */}
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">已安装({installed.length})</h3>
      </div>
      <div className="flex flex-col gap-2">
        {sortedInstalled.length === 0 && (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            尚未安装任何插件
          </div>
        )}
        {sortedInstalled.map((plugin) => (
          <InstalledItem key={plugin.id} plugin={plugin} />
        ))}
      </div>

      <Separator className="my-4" />

      {/* ── Catalog ── */}
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">在线目录({catalog.length})</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadCatalog(true)} aria-label="刷新目录">
          <RefreshCw className={cn('h-3.5 w-3.5', catalogLoading && 'animate-spin')} />
        </Button>
      </div>

      {catalogError ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
          目录加载失败:{catalogError}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {catalog.map((entry) => (
          <CatalogItem key={entry.id} entry={entry} />
        ))}
        {!catalogError && catalog.length === 0 && !catalogLoading && (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            目录为空
          </div>
        )}
      </div>

      {Object.keys(installPhases).length > 0 && (
        <div className="mt-3 text-center text-[10px] text-muted-foreground">
          安装进行中:{Object.keys(installPhases).join(', ')}
        </div>
      )}
    </div>
  );
}
