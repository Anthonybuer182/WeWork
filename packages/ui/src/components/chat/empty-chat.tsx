import { MessageSquare } from 'lucide-react';

export function EmptyChat() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <MessageSquare className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} />
      <div className="text-center">
        <h3 className="text-lg font-medium">No active session</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Select a session from the sidebar or create a new one to start coding.
        </p>
      </div>
    </div>
  );
}
