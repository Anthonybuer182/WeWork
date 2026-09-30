/**
 * Panel entry: inject styles, mount, and answer the backend's delivery probe.
 *
 * The probe answer is the reason this is not just `createRoot(...).render(...)`.
 * The backend has no way to learn whether a renderer is alive — the host never
 * closes the port or reports a destroy — so before it puts a scheduled message
 * into the conversation it asks, and waits ~1.5s for this reply. Leaving it
 * unanswered would make every agent action look undelivered.
 */
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CSS } from './styles.js';
import { App } from './app.js';
import { getSDK } from './sdk.js';

const style = document.createElement('style');
style.setAttribute('data-pi-css', 'com.pi.tasks/panel');
style.textContent = CSS;
document.head.appendChild(style);

/**
 * A render error must not leave a blank rectangle.
 *
 * Without this, one bad expression unmounts the whole tree and the panel goes
 * empty with nothing in it — indistinguishable from a plugin that failed to
 * load, and with no clue which view broke. That happened while building this
 * (a null page dereferenced on the first paint), and the only symptom was an
 * empty panel.
 */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[com.pi.tasks] panel render failed:', error);
  }

  render(): ReactNode {
    const err = this.state.error;
    if (!err) return this.props.children;
    return (
      <div style={{ padding: 16, fontFamily: 'var(--font-sans)' }}>
        <div className="err" style={{ marginBottom: 10 }}>
          面板出错了：{err.message}
        </div>
        <button className="btn" onClick={() => this.setState({ error: null })}>
          重试
        </button>
        <div className="hint" style={{ marginTop: 8 }}>
          数据没有丢——事项和记录都还在磁盘上。切到别的面板再回来通常也能恢复。
        </div>
      </div>
    );
  }
}

const root = createRoot(document.getElementById('root')!);

getSDK()
  .then((sdk) => {
    sdk.onMessage((payload) => {
      // Answer immediately and unconditionally: the probe is asking about this
      // window's existence, not about the panel's state.
      if (payload?.kind === 'event' && payload.event === 'pi.probe') {
        const id = (payload.data as { id?: string } | undefined)?.id;
        if (id) sdk.emit('pi.probe.reply', { id });
      }
    });
    root.render(
      <PanelErrorBoundary>
        <App sdk={sdk} />
      </PanelErrorBoundary>,
    );
  })
  .catch((err: unknown) => {
    // Rendered rather than thrown: a panel opened outside the host would
    // otherwise just be a blank rectangle.
    root.render(
      <div style={{ padding: 20, fontFamily: 'var(--font-sans)', color: 'var(--muted-foreground)' }}>
        {err instanceof Error ? err.message : String(err)}
      </div>,
    );
  });
