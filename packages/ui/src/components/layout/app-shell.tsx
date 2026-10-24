import { cn } from '@/lib/utils';
import { useLanguageSync } from '@/i18n';

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ children, className }: AppShellProps) {
  // One call site keeps `<html lang>` correct for both the desktop and web
  // shells; the dialog itself renders inside this tree.
  useLanguageSync();

  return (
    <div className={cn('flex h-screen flex-col overflow-hidden bg-background', className)}>
      {children}
    </div>
  );
}
