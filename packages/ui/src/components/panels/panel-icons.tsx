import {
  FileText,
  Globe,
  Settings,
  Puzzle,
  Mail,
  Calendar,
  CheckSquare,
  Database,
  BookOpen,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  file: FileText,
  preview: FileText,
  document: FileText,
  globe: Globe,
  browser: Globe,
  settings: Settings,
  puzzle: Puzzle,
  mail: Mail,
  calendar: Calendar,
  todo: CheckSquare,
  task: CheckSquare,
  knowledge: BookOpen,
  kb: BookOpen,
  database: Database,
  erp: LayoutGrid,
};

export function panelIcon(key: string | undefined): LucideIcon {
  return (key && ICONS[key.toLowerCase()]) || Puzzle;
}
