/**
 * Panel entry: inject styles, mount, and answer the backend's delivery probe.
 *
 * The probe answer is the reason this is not just `createRoot(...).render(...)`.
 * The backend has no way to learn whether a renderer is alive — the host never
 * closes the port or reports a destroy — so before it puts a scheduled message
 * into the conversation it asks, and waits ~1.5s for this reply. Leaving it
 * unanswered would make every agent action look undelivered.
 */
import { createRoot } from 'react-dom/client';
import { CSS } from './styles.js';
import { App } from './app.js';
import { getSDK } from './sdk.js';

const style = document.createElement('style');
style.setAttribute('data-pi-css', 'com.pi.tasks/panel');
style.textContent = CSS;
document.head.appendChild(style);

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
    root.render(<App sdk={sdk} />);
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
