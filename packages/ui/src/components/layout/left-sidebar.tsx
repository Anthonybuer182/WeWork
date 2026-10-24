import { ReactNode } from 'react';
import { useI18n } from '@/i18n';

interface LeftSidebarProps {
  children: ReactNode;
}

export function LeftSidebar({ children }: LeftSidebarProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col bg-sidebar" role="navigation" aria-label={t('侧栏')}>
      {children}
    </div>
  );
}
