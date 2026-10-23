import { useEffect, useState } from 'react';
import { Cpu, SlidersHorizontal, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { GeneralSettingsPage } from './general-settings';
import { ModelsSettingsPage } from './models-settings';
import { SkillsSettingsPage } from './skills-settings';

type SectionId = 'general' | 'models' | 'skills';

const SECTIONS: { id: SectionId; label: string; icon: typeof Cpu }[] = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'models', label: '模型', icon: Cpu },
  { id: 'skills', label: '技能', icon: Sparkles },
];

/**
 * Settings, as a centred dialog with its own side menu.
 *
 * The left column cannot host this: at its ~300px the provider forms and a
 * skill list are cramped, and widening the sidebar to fit them would fight the
 * drag-to-collapse layout. Configuration is also a deliberate interruption —
 * it reads as a dialog, not as another view competing with the conversation.
 *
 * While open, every native panel view is hidden (LiveSlot reports degenerate
 * bounds): those views paint above the DOM and would otherwise cover this
 * dialog and swallow its clicks.
 *
 * Pages save as you change them; there is no Save/Cancel, so dismissing the
 * dialog never loses work.
 */
export function SettingsDialog() {
  const open = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [section, setSection] = useState<SectionId>('general');

  // ⌘, / Ctrl+, — the platform's settings shortcut, active while the shell
  // has focus. (A native plugin view is its own web contents, so a key pressed
  // inside it never reaches this listener; the rail button still works.)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // `repeat` matters: holding the chord would otherwise toggle the dialog
      // on every OS key-repeat and leave it in an arbitrary state.
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useUIStore.getState().setSettingsOpen(!useUIStore.getState().settingsOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <Dialog open={open} onOpenChange={setSettingsOpen}>
      <DialogContent
        data-testid="settings-dialog"
        // A click on the dimmed backdrop must not discard a half-finished
        // form. Esc and the close button remain.
        onInteractOutside={(e) => e.preventDefault()}
        className="h-[min(680px,calc(100vh-96px))] w-[min(940px,calc(100vw-96px))] max-w-none gap-0 overflow-hidden p-0 outline-none sm:rounded-xl"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        <DialogDescription className="sr-only">配置模型服务商、技能和通用选项</DialogDescription>

        <div className="flex h-full min-h-0">
          <nav
            aria-label="设置分类"
            className="flex w-[180px] shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-3"
          >
            <div className="px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              设置
            </div>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? 'true' : undefined}
                data-settings-section={id}
                onClick={() => setSection(id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  section === id
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </button>
            ))}
            <div className="mt-auto px-2.5 pt-3 text-[10px] leading-relaxed text-muted-foreground/70">
              改动即时保存，关掉不丢。
            </div>
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center border-b px-6">
              <h2 className="text-sm font-semibold">{active.label}</h2>
            </div>
            <div className="min-h-0 flex-1">
              {section === 'general' && <GeneralSettingsPage />}
              {section === 'models' && <ModelsSettingsPage />}
              {section === 'skills' && <SkillsSettingsPage />}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
