import { useState } from 'react';
import { Wrench, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Skill } from '@pi/types';
import { useI18n, type MessageKey } from '@/i18n';

interface SkillSelectorProps {
  skills: Skill[];
  selectedIds: string[];
  onToggle: (skillId: string) => void;
  disabled?: boolean;
}

const categoryLabels: Record<string, MessageKey> = {
  document: '文档',
  filesystem: '文件系统',
  code: '代码',
  utility: '工具类',
  custom: '自定义',
};

export function SkillSelector({ skills, selectedIds, onToggle, disabled }: SkillSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selectedCount = selectedIds.length;
  const grouped = skills.reduce(
    (acc, skill) => {
      if (!acc[skill.category]) acc[skill.category] = [];
      acc[skill.category].push(skill);
      return acc;
    },
    {} as Record<string, Skill[]>,
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 px-2 text-xs"
          aria-label={t('技能（已选 {count} 个）', { count: selectedCount })}
        >
          <Wrench className="h-3.5 w-3.5" />
          {selectedCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {selectedCount}
            </Badge>
          )}
          <span className="hidden lg:inline">{t('技能')}</span>
          <span className="text-muted-foreground text-[10px] hidden sm:inline">({skills.length})</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('本次会话使用的技能')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {skills.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            {t('没有启用的技能，可在 设置 → 技能 中打开。')}
          </div>
        )}
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              {categoryLabels[category] ? t(categoryLabels[category]) : category}
            </div>
            {items.map((skill) => (
              <DropdownMenuCheckboxItem
                key={skill.id}
                checked={selectedIds.includes(skill.id)}
                onCheckedChange={() => onToggle(skill.id)}
                disabled={!skill.enabled}
              >
                <span className={cn(!skill.enabled && 'text-muted-foreground')}>
                  {skill.name}
                </span>
                {!skill.enabled && (
                  <span className="ml-auto text-[10px] text-muted-foreground">{t('不可用')}</span>
                )}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
