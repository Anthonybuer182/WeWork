import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Eye, EyeOff, AlertCircle, Loader2, EyeIcon, FileText } from 'lucide-react';
import { useSDK } from '@/hooks/use-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ErrorState } from '@/components/common/error-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ProviderEntry, ModelEntry } from '@pi/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

const DEFAULT_PROVIDER: ProviderEntry = {
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions',
  apiKey: '',
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: [],
};

const DEFAULT_MODEL: ModelEntry = {
  id: '',
  name: '',
  input: ['text'],
};

/** Determine model input type: text-only language model or multimodal vision model */
function getModelInputType(model: ModelEntry): 'text' | 'multimodal' {
  const input = model.input ?? [];
  if (input.includes('image')) return 'multimodal';
  return 'text';
}

/**
 * 模型 — model providers and their models (`~/.pi/agent/models.json`).
 *
 * Rendered as a page inside the settings dialog, so it owns its own toolbar
 * and scrolling but no outer page title (the dialog supplies that).
 */
export function ModelsSettingsPage() {
  const sdk = useSDK();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  // Delete confirmation
  const [deleteProvider, setDeleteProvider] = useState<string | null>(null);
  const [deleteModel, setDeleteModel] = useState<{ provider: string; modelId: string } | null>(null);

  // Add/Edit provider dialog
  const [providerDialog, setProviderDialog] = useState<{
    open: boolean;
    editMode: boolean;
    name: string;
    data: ProviderEntry;
  }>({ open: false, editMode: false, name: '', data: { ...DEFAULT_PROVIDER } });

  // Add/Edit model dialog
  const [modelDialog, setModelDialog] = useState<{
    open: boolean;
    providerName: string;
    editMode: boolean;
    originalId: string;
    data: ModelEntry;
  }>({ open: false, providerName: '', editMode: false, originalId: '', data: { ...DEFAULT_MODEL } });

  const {
    data: config,
    isLoading,
    error: loadError,
    refetch,
  } = useQuery({
    queryKey: ['modelsConfig'],
    queryFn: () => sdk.config.getModelsConfig(),
  });

  const providers = config?.providers ?? {};

  const toggleKeyVisibility = useCallback((name: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // --- Provider operations ---

  const handleAddProvider = useCallback(() => {
    setProviderDialog({ open: true, editMode: false, name: '', data: { ...DEFAULT_PROVIDER } });
  }, []);

  const handleEditProvider = useCallback((name: string) => {
    const p = providers[name];
    if (!p) return;
    setProviderDialog({
      open: true,
      editMode: true,
      name,
      data: { ...p, models: [...p.models], compat: { ...p.compat } },
    });
  }, [providers]);

  const handleSaveProvider = useCallback(async () => {
    try {
      setError(null);
      const { name, data } = providerDialog;
      if (!name.trim() || !data.baseUrl.trim() || !data.apiKey.trim()) {
        setError('请填写名称、Base URL 和 API Key');
        return;
      }
      await sdk.config.upsertProvider(name.trim(), data);
      setProviderDialog({ open: false, editMode: false, name: '', data: { ...DEFAULT_PROVIDER } });
      queryClient.invalidateQueries({ queryKey: ['modelsConfig'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }, [providerDialog, sdk, queryClient]);

  const handleConfirmDeleteProvider = useCallback(async () => {
    if (!deleteProvider) return;
    try {
      await sdk.config.deleteProvider(deleteProvider);
      setDeleteProvider(null);
      queryClient.invalidateQueries({ queryKey: ['modelsConfig'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }, [deleteProvider, sdk, queryClient]);

  // --- Model operations ---

  const handleAddModel = useCallback((providerName: string) => {
    setModelDialog({
      open: true,
      providerName,
      editMode: false,
      originalId: '',
      data: { ...DEFAULT_MODEL },
    });
  }, []);

  const handleEditModel = useCallback((providerName: string, model: ModelEntry) => {
    setModelDialog({
      open: true,
      providerName,
      editMode: true,
      originalId: model.id,
      data: { ...model },
    });
  }, []);

  const handleSaveModel = useCallback(async () => {
    try {
      setError(null);
      const { providerName, editMode, originalId, data } = modelDialog;
      if (!data.id.trim() || !data.name.trim()) {
        setError('请填写模型 ID 和名称');
        return;
      }
      if (editMode) {
        await sdk.config.updateModel(providerName, originalId, data);
      } else {
        await sdk.config.addModel(providerName, data);
      }
      setModelDialog({ open: false, providerName: '', editMode: false, originalId: '', data: { ...DEFAULT_MODEL } });
      queryClient.invalidateQueries({ queryKey: ['modelsConfig'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }, [modelDialog, sdk, queryClient]);

  const handleConfirmDeleteModel = useCallback(async () => {
    if (!deleteModel) return;
    try {
      await sdk.config.deleteModel(deleteModel.provider, deleteModel.modelId);
      setDeleteModel(null);
      queryClient.invalidateQueries({ queryKey: ['modelsConfig'] });
      queryClient.invalidateQueries({ queryKey: ['models'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }, [deleteModel, sdk, queryClient]);

  const maskApiKey = (key: string) => {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center">
        <ErrorState
          title="读取模型配置失败"
          description={loadError instanceof Error ? loadError.message : '未知错误'}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar. The page title lives in the dialog's own header; this row
          carries the file being edited and the page's one action. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-3">
        <p
          className="min-w-0 truncate text-xs text-muted-foreground"
          title="~/.pi/agent/models.json"
        >
          服务商与模型 · ~/.pi/agent/models.json
        </p>
        <Button size="sm" className="shrink-0" onClick={handleAddProvider}>
          <Plus className="mr-1 h-4 w-4" />
          添加服务商
        </Button>
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 shrink-0" onClick={() => setError(null)}>
            &times;
          </Button>
        </div>
      )}

      {/* Constrains Radix's max-content table wrapper — otherwise a long
          provider URL or API key widens the page instead of wrapping.
          `!important` is required: Radix sets `display: table` as an inline
          style, which a plain class rule cannot override. */}
      <ScrollArea
        className="flex-1 px-6 py-5"
        viewportClassName="[&>div]:!block [&>div]:!min-w-0"
      >
        <div className="space-y-4">
          {Object.keys(providers).length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm">还没有配置服务商</p>
              <p className="mt-1 text-xs">点右上角「添加服务商」开始配置</p>
            </div>
          )}
          {Object.entries(providers).map(([name, provider]) => (
            <Card key={name} className="overflow-hidden">
              <CardHeader className="p-3 pb-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <CardTitle className="text-sm truncate">{name}</CardTitle>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEditProvider(name)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => setDeleteProvider(name)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {/* The API badge sits on its own line rather than beside the
                    title: the API type plus two action buttons crowds the
                    name, and the badge is reference information, not identity. */}
                {/* A plain div, not CardDescription: that renders a <p>, and
                    this block holds block-level children (badges, buttons,
                    rows) which are invalid inside a paragraph — the browser
                    closes the <p> early and React's DOM stops matching. */}
                <div className="text-xs text-muted-foreground space-y-0.5 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Badge variant="secondary" className="text-[10px] shrink-0">{provider.api}</Badge>
                  </div>
                  <div className="break-all" title={provider.baseUrl}>
                    URL: {provider.baseUrl}
                  </div>
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="shrink-0">Key:</span>
                    <code className="text-[10px] bg-muted px-1 rounded break-all" title={provider.apiKey}>
                      {visibleKeys.has(name) ? provider.apiKey : maskApiKey(provider.apiKey)}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={() => toggleKeyVisibility(name)}
                    >
                      {visibleKeys.has(name) ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0">
                <Separator className="mb-2" />
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-medium text-muted-foreground truncate">
                    模型（{provider.models.length}）
                  </span>
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => handleAddModel(name)}>
                    <Plus className="h-3 w-3 mr-1" />添加模型
                  </Button>
                </div>
                {provider.models.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">还没有模型</p>
                ) : (
                  <div className="space-y-1">
                    {provider.models.map((model) => {
                      const inputType = getModelInputType(model);
                      return (
                      <div
                        key={model.id}
                        className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
                        // The API model id is shown on hover rather than inline:
                        // at sidebar width it crowds out the display name, and
                        // it is visible/editable in the edit dialog anyway.
                        title={model.id}
                      >
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className="font-medium truncate">{model.name}</span>
                          {inputType === 'multimodal' ? (
                            <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 shrink-0">
                              <EyeIcon className="h-2.5 w-2.5 mr-0.5" />
                              视觉
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 text-muted-foreground shrink-0">
                              <FileText className="h-2.5 w-2.5 mr-0.5" />
                              文本
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleEditModel(name, model)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => setDeleteModel({ provider: name, modelId: model.id })}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>

      {/* Provider dialog */}
      <Dialog open={providerDialog.open} onOpenChange={(open) => !open && setProviderDialog({ open: false, editMode: false, name: '', data: { ...DEFAULT_PROVIDER } })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{providerDialog.editMode ? '编辑服务商' : '添加服务商'}</DialogTitle>
            <DialogDescription>
              {providerDialog.editMode ? `修改 ${providerDialog.name} 的配置` : '添加一个新的模型服务商'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {!providerDialog.editMode && (
              <div>
                <Label htmlFor="providerName">名称 *</Label>
                <Input
                  id="providerName"
                  placeholder="e.g. minimax, openai, dashscope"
                  value={providerDialog.name}
                  onChange={(e) => setProviderDialog((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
            )}
            <div>
              <Label htmlFor="providerBaseUrl">Base URL *</Label>
              <Input
                id="providerBaseUrl"
                placeholder="https://api.example.com/v1"
                value={providerDialog.data.baseUrl}
                onChange={(e) => setProviderDialog((d) => ({ ...d, data: { ...d.data, baseUrl: e.target.value } }))}
              />
            </div>
            <div>
              <Label htmlFor="providerApi">接口类型 *</Label>
              <Input
                id="providerApi"
                placeholder="openai-completions"
                value={providerDialog.data.api}
                onChange={(e) => setProviderDialog((d) => ({ ...d, data: { ...d.data, api: e.target.value } }))}
              />
            </div>
            <div>
              <Label htmlFor="providerApiKey">API Key *</Label>
              <Input
                id="providerApiKey"
                type="password"
                placeholder="sk-..."
                value={providerDialog.data.apiKey}
                onChange={(e) => setProviderDialog((d) => ({ ...d, data: { ...d.data, apiKey: e.target.value } }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProviderDialog({ open: false, editMode: false, name: '', data: { ...DEFAULT_PROVIDER } })}>
              取消
            </Button>
            <Button onClick={handleSaveProvider}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Model dialog */}
      <Dialog open={modelDialog.open} onOpenChange={(open) => !open && setModelDialog({ open: false, providerName: '', editMode: false, originalId: '', data: { ...DEFAULT_MODEL } })}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{modelDialog.editMode ? '编辑模型' : '添加模型'}</DialogTitle>
            <DialogDescription>
              服务商：{modelDialog.providerName}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="modelId">模型 ID *</Label>
              <Input
                id="modelId"
                placeholder="MiniMax-M2.7-highspeed"
                value={modelDialog.data.id}
                onChange={(e) => setModelDialog((d) => ({ ...d, data: { ...d.data, id: e.target.value } }))}
              />
              {modelDialog.editMode && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  改 ID 等于重命名模型：默认模型的选择会跟着改，历史会话保留当时使用的 ID。
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="modelName">模型名称 *</Label>
              <Input
                id="modelName"
                placeholder="MiniMax-M2.7-highspeed"
                value={modelDialog.data.name}
                onChange={(e) => setModelDialog((d) => ({ ...d, data: { ...d.data, name: e.target.value } }))}
              />
            </div>
            <div>
              <Label htmlFor="modelInput">模型类型</Label>
              <Select
                value={getModelInputType(modelDialog.data) === 'multimodal' ? 'multimodal' : 'text'}
                onValueChange={(value: string) =>
                  setModelDialog((d) => ({
                    ...d,
                    data: { ...d.data, input: value === 'multimodal' ? ['text', 'image'] : ['text'] },
                  }))
                }
              >
                <SelectTrigger id="modelInput">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5" />
                      <span>纯文本语言模型</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="multimodal">
                    <div className="flex items-center gap-2">
                      <EyeIcon className="h-3.5 w-3.5" />
                      <span>多模态视觉模型</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground mt-1">
                视觉模型可以接收图片；语言模型只接收文本
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModelDialog({ open: false, providerName: '', editMode: false, originalId: '', data: { ...DEFAULT_MODEL } })}>
              取消
            </Button>
            <Button onClick={handleSaveModel}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete provider confirmation */}
      <AlertDialog open={!!deleteProvider} onOpenChange={(open: boolean) => !open && setDeleteProvider(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除服务商？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除服务商「{deleteProvider}」吗？它下面的所有模型配置也会一起删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteProvider} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete model confirmation */}
      <AlertDialog open={!!deleteModel} onOpenChange={(open: boolean) => !open && setDeleteModel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除模型「{deleteModel?.modelId}」吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteModel} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
