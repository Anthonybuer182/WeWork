import { useState } from 'react';
import { Hammer, ChevronDown } from 'lucide-react';
import type { ToolCatalogEntry } from '@pi/types';
import { groupToolCatalog } from '@/lib/tool-catalog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/i18n';

interface ToolSelectorProps {
  /** Tools the user may choose from (globally enabled only). */
  tools: ToolCatalogEntry[];
  selectedNames: string[];
  onToggle: (toolName: string) => void;
  /** Everything the global switches allow (clears the per-conversation override). */
  onSelectAll: () => void;
  /** Keep only tools that cannot change the world (read / ask / todo / readOnly). */
  onReadOnly: () => void;
  disabled?: boolean;
}

/**
 * Per-conversation tool selection, next to the skill picker.
 *
 * Same contract as skills: default is everything, an explicit choice narrows
 * this conversation only, and a tool switched off globally never appears here
 * (Settings → 工具 is the ceiling).
 */
export function ToolSelector({
  tools,
  selectedNames,
  onToggle,
  onSelectAll,
  onReadOnly,
  disabled,
}: ToolSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selectedCount = tools.filter((tool) => selectedNames.includes(tool.name)).length;
  const selected = new Set(selectedNames);
  const groups = groupToolCatalog(tools, t);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 px-2 text-xs"
          aria-label={t('工具（已选 {count} 个）', { count: selectedCount })}
        >
          <Hammer className="h-3.5 w-3.5" />
          {selectedCount !== tools.length && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {selectedCount}
            </Badge>
          )}
          <span className="hidden lg:inline">{t('工具')}</span>
          <span className="text-muted-foreground text-[10px] hidden sm:inline">({tools.length})</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-h-[420px] overflow-y-auto">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>{t('本次会话使用的工具')}</span>
          {!disabled && tools.length > 0 && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  onSelectAll();
                }}
                className="rounded px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t('全选')}
              </button>
              <button
                type="button"
                title={t('只保留不会改动文件的工具（read / 提问 / 清单等）')}
                onClick={(event) => {
                  event.preventDefault();
                  onReadOnly();
                }}
                className="rounded px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t('只读')}
              </button>
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tools.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t('没有可用的工具，可在 设置 → 工具 中打开。')}
          </div>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              {group.title}
            </div>
            {group.items.map((tool) => (
              <DropdownMenuCheckboxItem
                key={tool.name}
                checked={selected.has(tool.name)}
                onCheckedChange={() => onToggle(tool.name)}
                title={tool.description}
              >
                <span className="font-mono text-xs">{tool.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

