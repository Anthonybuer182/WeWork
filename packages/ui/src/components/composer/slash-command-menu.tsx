import { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { SlashCommand } from '@pi/types';
import { useI18n } from '@/i18n';
import { commandDescription, COMMAND_CATEGORY_LABELS } from '@/stores/command-store';

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  query: string;
  highlightedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashCommandMenu({ commands, query, highlightedIndex, onSelect }: SlashCommandMenuProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  // Automatically scroll the highlighted item into view
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-index="${highlightedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  const filtered = query
    ? commands.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    : commands;

  if (filtered.length === 0) return null;

  const grouped = filtered.reduce(
    (acc, cmd) => {
      const cat = cmd.category || 'other';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(cmd);
      return acc;
    },
    {} as Record<string, SlashCommand[]>,
  );

  let globalIndex = 0;
  const flatItems: { cmd: SlashCommand; index: number }[] = [];
  for (const cmds of Object.values(grouped)) {
    for (const cmd of cmds) {
      flatItems.push({ cmd, index: globalIndex++ });
    }
  }

  return (
    <div className="absolute bottom-full left-0 mb-2 w-72 rounded-lg border bg-popover shadow-md z-50">
      <div ref={containerRef} className="max-h-64 overflow-y-auto p-1">
        {Object.entries(grouped).map(([category, cmds]) => (
          <div key={category}>
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
              {COMMAND_CATEGORY_LABELS[category] ? t(COMMAND_CATEGORY_LABELS[category]) : category}
            </div>
            {cmds.map((cmd) => {
              const idx = flatItems.find((f) => f.cmd.id === cmd.id)!.index;
              return (
                <div
                  key={cmd.id}
                  data-index={idx}
                  className={cn(
                    'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm cursor-pointer',
                    idx === highlightedIndex && 'bg-accent text-accent-foreground',
                  )}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
                >
                  <span className="font-medium">{cmd.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground truncate max-w-[160px]">
                    {commandDescription(cmd, t)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
