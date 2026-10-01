import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for plugin WebContentsViews.
 *
 * Why this exists: plugin panels used to be iframes inside the shell renderer,
 * so the shell could reach them with `contentWindow.postMessage` and relay
 * their messages back over `pluginBridge`. A WebContentsView is a top-level
 * frame — `window.parent` is the page itself and the shell has no handle on it
 * at all. So the same two directions have to be re-established here:
 *
 *   page → host   window.__piViewBridge.send(payload)  → MessagePort → backend
 *   host → page   backend → MessagePort → onMessage(cb) → page's SDK
 *
 * The MessagePort is requested BY THIS PRELOAD (`pi:plugin:ensure-port`), so
 * the main process sees this view's webContents as the sender and transfers the
 * port here rather than to the shell. `PluginSystem.ensureUiPort` keys its
 * idempotence map on `${pluginId}:${sender.id}`, so a view and the shell get
 * distinct pairs with no change on the main side.
 *
 * The plugin id arrives via `additionalArguments` (the view is created per
 * panel, so the preload cannot know it statically).
 */

const PLUGIN_ID =
  process.argv.find((a) => a.startsWith('--pi-plugin-id='))?.slice('--pi-plugin-id='.length) ?? '';

interface PortLike {
  on(event: 'message', listener: (ev: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

let port: PortLike | null = null;
let messageCallback: ((payload: unknown) => void) | null = null;
let eventCallback: ((event: unknown) => void) | null = null;
/** Messages sent before the port lands are buffered and flushed on arrival. */
const outbox: unknown[] = [];
/**
 * Backend traffic held until the page can receive it.
 *
 * Two things have to be true before a payload is worth delivering: the page's
 * SDK must have registered (it runs as the first script in <head>), and the
 * plugin's own code must have run. Plugin UIs listen on `window` for backend
 * frames — they register that listener from their bundle, which executes later
 * than the SDK. A `ui.render` that lands in between is simply lost, and the
 * panel stays stuck on its empty state. So hold everything until `load`.
 */
const inbox: unknown[] = [];
let pageLoaded = document.readyState === 'complete';

/** Transport counters — see bridge.stats(). */
let sentCount = 0;
let receivedCount = 0;

/** Hand a backend payload to the page, or hold it until the page is ready. */
function deliver(payload: unknown): void {
  if (pageLoaded && messageCallback) {
    messageCallback(payload);
    return;
  }
  inbox.push(payload);
}

function flushInbox(): void {
  if (!pageLoaded || !messageCallback) return;
  while (inbox.length) {
    try {
      messageCallback(inbox.shift());
    } catch {
      break;
    }
  }
}

window.addEventListener('load', () => {
  pageLoaded = true;
  flushInbox();
}, { once: true });

ipcRenderer.on('pi:plugin:port', (event, meta: { pluginId?: string }) => {
  const incoming = (event.ports as unknown as PortLike[] | undefined)?.[0];
  if (!incoming) return;

  port?.close();
  port = incoming;

  const onPortMessage = (ev: { data: unknown }) => {
    receivedCount++;
    deliver(ev.data);
  };
  if (typeof incoming.on === 'function') {
    // Electron's MessagePortMain is EventEmitter-style and needs start().
    incoming.on('message', onPortMessage);
    incoming.start();
  } else {
    // DOM-style MessagePort: assigning onmessage starts it.
    (incoming as unknown as { onmessage: typeof onPortMessage }).onmessage = onPortMessage;
  }

  while (outbox.length) {
    try {
      incoming.postMessage(outbox.shift());
    } catch {
      break;
    }
  }
  void meta;
});

ipcRenderer.on('pi:plugin:event', (_event, evt) => eventCallback?.(evt));

/** Post to the backend, queueing while the port is still in flight. */
function toBackend(payload: unknown): void {
  sentCount++;
  if (port) {
    try {
      port.postMessage(payload);
      return;
    } catch {
      /* port closed mid-flight — fall through to the outbox */
    }
  }
  outbox.push(payload);
}

/**
 * `panel.mounted` is raised by the shell (it owns the panel's open params), but
 * the port it has to travel on lives here. So the shell asks main to route the
 * event to this view, and the preload puts it on the wire — queued if the port
 * has not landed yet. Without this the backend never renders and the panel
 * stays empty.
 */
ipcRenderer.on(
  'pi:plugin:panel-mounted',
  (_event, msg: { panelId?: string; params?: unknown }) => {
    toBackend({
      kind: 'event',
      event: 'panel.mounted',
      panelId: msg?.panelId,
      data: { panelId: msg?.panelId, params: msg?.params },
    });
  },
);

// Theme tokens are collected in the shell (it owns the CSS variables) and
// fanned out here by main. Delivered through the bridge rather than a window
// message because the page's own `window` listeners live in a different world.
let themeCallback: ((tokens: Record<string, string>) => void) | null = null;
let lastThemeTokens: Record<string, string> | null = null;
ipcRenderer.on('pi:plugin:theme', (_event, tokens: Record<string, string>) => {
  lastThemeTokens = tokens;
  themeCallback?.(tokens);
});

const bridge = {
  pluginId: PLUGIN_ID,

  /** Ask main for a MessagePort pair; the other end goes to the backend. */
  ensurePort: (pluginId?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:plugin:ensure-port', { pluginId: pluginId ?? PLUGIN_ID }),

  /**
   * Fire-and-forget event to the plugin backend. Mirrors the shell's
   * `pluginBridge.send`, including the pre-port buffer, so a panel that sends
   * on first paint does not lose that message.
   */
  send: (payload: unknown, pluginId?: string): void => {
    void pluginId;
    toBackend(payload);
  },

  /**
   * Forward a wire frame to the HOST (the shell renderer), for directions the
   * backend port does not carry — today that is just `contextmenu`: the native
   * menu can only be popped by main, and a panel in a native view cannot reach
   * the shell's DOM to ask for it.
   *
   * Main relays it to the shell.
   */
  sendHostFrame: (frame: unknown): void => {
    ipcRenderer.send('pi:plugin:view-frame', frame);
  },

  onMessage: (cb: (payload: unknown) => void): void => {
    messageCallback = cb;
    // Drain anything the backend sent while the page was still parsing.
    flushInbox();
  },

  onEvent: (cb: (event: unknown) => void): void => {
    eventCallback = cb;
  },

  /** Shell theme tokens (the shell owns the CSS variables). */
  onTheme: (cb: (tokens: Record<string, string>) => void): void => {
    themeCallback = cb;
    // Replay if the tokens landed before the page subscribed.
    if (lastThemeTokens) cb(lastThemeTokens);
  },

  /** Native context menu — an editable plugin page needs the edit roles. */
  showContextMenu: (pos: { x: number; y: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('pi:plugin:context-menu', pos),

  /**
   * Live-slot binding (piSDK.liveSlot): let a host engine view be positioned
   * inside the page's layout. The slot id is composed HERE, on the plugin-id
   * prefix — the page can only name slots inside its own plugin's namespace,
   * never another plugin's or the host's.
   */
  liveAttach: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:attach', { slotId: `${PLUGIN_ID}:${String(name)}` }),
  liveBounds: (
    name: string,
    b: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:set-bounds', {
      slotId: `${PLUGIN_ID}:${String(name)}`,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    }),
  liveDetach: (name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pi:liveview:detach', { slotId: `${PLUGIN_ID}:${String(name)}` }),

  /**
   * Transport counters, for diagnosing a panel that stays blank. Cheap enough
   * to leave in: three integers, and they turn "nothing happened" into a
   * specific broken link (no port / not sent / sent but no reply).
   */
  stats: (): Record<string, unknown> => ({
    pluginId: PLUGIN_ID,
    portArrived: port !== null,
    portStyle: port ? (typeof (port as unknown as { on?: unknown }).on === 'function' ? 'emitter' : 'dom') : 'none',
    sent: sentCount,
    received: receivedCount,
    outboxDepth: outbox.length,
    inboxDepth: inbox.length,
  }),
};

contextBridge.exposeInMainWorld('__piViewBridge', bridge);

// Ask for the UI MessagePort immediately. Main sees THIS view's webContents as
// the sender, so the port is transferred here rather than to the shell — which
// is what makes the panel the owner of its own backend channel.
void bridge.ensurePort();

export type PluginViewBridge = typeof bridge;
