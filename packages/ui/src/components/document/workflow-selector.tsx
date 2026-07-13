import { useState, useEffect, useCallback } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Play, Trash2, ListVideo, Loader2 } from 'lucide-react';

export interface Workflow {
  name: string;
  steps: unknown[];
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

interface WorkflowSelectorProps {
  onReplay: (name: string, variables: Record<string, string>) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  fetchWorkflows: () => Promise<Workflow[]>;
  replayProgress?: { current: number; total: number } | null;
}

export function WorkflowSelector({
  onReplay,
  onDelete,
  fetchWorkflows,
  replayProgress,
}: WorkflowSelectorProps) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [replaying, setReplaying] = useState(false);

  const loadWorkflows = useCallback(async () => {
    try {
      const list = await fetchWorkflows();
      setWorkflows(list);
    } catch (err) {
      console.error('Failed to load workflows:', err);
    }
  }, [fetchWorkflows]);

  useEffect(() => {
    if (open) {
      loadWorkflows();
    }
  }, [open, loadWorkflows]);

  const handleSelect = (wf: Workflow) => {
    setSelected(wf);
    // Initialize variable values with empty strings
    const init: Record<string, string> = {};
    wf.variables.forEach((v) => { init[v] = ''; });
    setVariableValues(init);
  };

  const handleReplay = async () => {
    if (!selected || replaying) return;
    setReplaying(true);
    try {
      await onReplay(selected.name, variableValues);
    } catch (err) {
      console.error('Replay failed:', err);
    } finally {
      setReplaying(false);
      setOpen(false);
      setSelected(null);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await onDelete(name);
      await loadWorkflows();
      if (selected?.name === name) {
        setSelected(null);
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const progress = replaying && replayProgress
    ? `${replayProgress.current}/${replayProgress.total}`
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <ListVideo className="h-3.5 w-3.5" />
          Workflows
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div className="font-medium text-sm">Saved Workflows</div>

          {selected ? (
            // ── Variable input view ──
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{selected.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setSelected(null)}
                >
                  Back
                </Button>
              </div>

              {selected.variables.length > 0 ? (
                <div className="space-y-2">
                  <Label className="text-xs">Variables</Label>
                  {selected.variables.map((v) => (
                    <div key={v} className="space-y-1">
                      <Label className="text-xs font-mono">{`{{${v}}}`}</Label>
                      <Input
                        value={variableValues[v] ?? ''}
                        onChange={(e) =>
                          setVariableValues((prev) => ({ ...prev, [v]: e.target.value }))
                        }
                        placeholder={`Enter ${v}`}
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No variables needed.</p>
              )}

              <div className="text-xs text-muted-foreground">
                {selected.steps.length} step{selected.steps.length !== 1 ? 's' : ''}
                {progress && ` · Replaying ${progress}`}
              </div>

              <Separator />

              <div className="flex justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-destructive hover:text-destructive"
                  onClick={() => handleDelete(selected.name)}
                  disabled={replaying}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete
                </Button>
                <Button
                  size="sm"
                  className="h-8"
                  onClick={handleReplay}
                  disabled={replaying}
                >
                  {replaying ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3 mr-1" />
                  )}
                  {replaying ? 'Replaying...' : 'Replay'}
                </Button>
              </div>
            </div>
          ) : (
            // ── Workflow list view ──
            <ScrollArea className="h-[240px]">
              {workflows.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  No saved workflows yet.
                  <br />
                  Record one to get started.
                </p>
              ) : (
                <div className="space-y-1">
                  {workflows.map((wf) => (
                    <div
                      key={wf.name}
                      className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-muted/50 cursor-pointer group"
                      onClick={() => handleSelect(wf)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{wf.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {wf.steps.length} step{wf.steps.length !== 1 ? 's' : ''}
                          {wf.variables.length > 0 && ` · ${wf.variables.length} var${wf.variables.length !== 1 ? 's' : ''}`}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(wf.name);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
