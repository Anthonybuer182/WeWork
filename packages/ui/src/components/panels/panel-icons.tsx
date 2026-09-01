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
  MessageSquare,
  Eye,
  StickyNote,
  Users,
  CircleDollarSign,
  Clock,
  SlidersHorizontal,
  LayoutTemplate,
  type LucideIcon,
} from 'lucide-react';

/**
 * Panel icon vocabulary — plugins declare an icon NAME in their manifest
 * (`contributes.panels[].icon`), the host resolves it here. Keeping this a
 * closed set (rather than accepting plugin-supplied SVGs) keeps rail icons
 * theme-consistent and safe; unknown or missing names fall back to Puzzle.
 */
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
  chat: MessageSquare,
  eye: Eye,
  note: StickyNote,
  users: Users,
  money: CircleDollarSign,
  clock: Clock,
  sliders: SlidersHorizontal,
  layout: LayoutTemplate,
};

export function panelIcon(key: string | undefined): LucideIcon {
  return (key && ICONS[key.toLowerCase()]) || Puzzle;
}
