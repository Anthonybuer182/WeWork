import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Settings, Globe } from 'lucide-react';

interface RightPanelTabsProps {
  activeTab?: string;
  onTabChange?: (tab: string) => void;
}

export function RightPanelTabs({ activeTab = 'preview', onTabChange }: RightPanelTabsProps) {
  return (
    <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
      <div className="border-b px-2 py-1">
        <TabsList className="w-full">
          <TabsTrigger value="preview" className="flex-1">Preview</TabsTrigger>
          <TabsTrigger value="browser" className="flex-1">
            <Globe className="h-3 w-3 mr-1" />
            Browser
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex-1">
            <Settings className="h-3 w-3 mr-1" />
            Settings
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
