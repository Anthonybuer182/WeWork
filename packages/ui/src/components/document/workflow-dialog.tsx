import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { MousePointerClick, Keyboard, Navigation, ArrowDown } from 'lucide-react';

export interface WorkflowStep {
  type: 'click' | 'fill' | 'scroll' | 'navigate';
  selector?: string;
  value?: string;
  direction?: string;
  amount?: number;
  url?: string;
  timestamp: number;
}

interface WorkflowDialogProps {
  open: boolean;
  steps: WorkflowStep[];
  onSave: (name: string, steps: WorkflowStep[]) => Promise<void>;
  onClose: () => void;
}

const stepIcons: Record<string, typeof MousePointerClick> = {
  click: MousePointerClick,
  fill: Keyboard,
  navigate: Navigation,
  scroll: ArrowDown,
};

/** Extract {{variable}} placeholders from steps. */
function extractVariables(steps: WorkflowStep[]): string[] {
  const vars = new Set<string>();
  const regex = /\{\{(\w+)\}\}/g;
  for (const step of steps) {
    const text = `${step.value ?? ''} ${step.url ?? ''}`;
    let match;
    while ((match = regex.exec(text)) !== null) {
      vars.add(match[1]);
    }
  }
  return Array.from(vars);
}

/** Format a step for display. */
function formatStep(step: WorkflowStep, index: number): string {
  switch (step.type) {
    case 'click':
      return `Click ${step.selector ?? '(no selector)'}`;
    case 'fill':
      return `Fill ${step.selector ?? '(no selector)'} → "${step.value ?? ''}"`;
    case 'navigate':
      return `Navigate to ${step.url ?? '(no url)'}`;
    case 'scroll':
      return `Scroll ${step.direction ?? 'down'} by ${step.amount ?? 500}`;
    default:
      return `Step ${index + 1}: ${step.type}`;
  }
}

export function WorkflowDialog({ open, steps, onSave, onClose }: WorkflowDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const variables = extractVariables(steps);

  useEffect(() => {
    if (open) {
      setName('');
      setSaving(false);
    }
  }, [open]);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(name.trim(), steps);
      onClose();
    } catch (err) {
      console.error('Failed to save workflow:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Save Workflow</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="workflow-name">Workflow Name</Label>
            <Input
              id="workflow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GitHub Login"
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              autoFocus
            />
          </div>

          {variables.length > 0 && (
            <div className="space-y-2">
              <Label>Detected Variables</Label>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((v) => (
                  <Badge key={v} variant="secondary" className="font-mono">
                    {`{{${v}}}`}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                These placeholders will be replaced with actual values during replay.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label>Steps ({steps.length})</Label>
            <ScrollArea className="h-[200px] rounded border p-2">
              <div className="space-y-1">
                {steps.map((step, i) => {
                  const Icon = stepIcons[step.type] ?? MousePointerClick;
                  return (
                    <div key={i} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-muted/50">
                      <Icon className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                      <span className="text-xs font-mono">{formatStep(step, i)}</span>
                    </div>
                  );
                })}
                {steps.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    No steps recorded
                  </p>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving || steps.length === 0}>
            {saving ? 'Saving...' : 'Save Workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
