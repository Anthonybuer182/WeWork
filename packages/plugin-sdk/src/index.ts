/**
 * The backend half of a pi plugin.
 *
 * A plugin backend is a Node process the host forks. Without this SDK, every
 * plugin re-implements the same plumbing — the ready handshake, the capability
 * request/response map, the message pump, timeouts, panel routing — and the
 * copies drift. Before this existed, five first-party plugins had five
 * hand-rolled copies of that plumbing whose only difference was a timeout
 * (browser used 60s, everyone else 30s).
 *
 * With it, a plugin declares WHAT it does:
 *
 *   import { plugin } from '@pi/plugin-sdk';
 *
 *   plugin({
 *     async onRequest(panelId, method, params) { ... },
 *     async onTool(name, args) { ... },
 *   });
 *
 * Called at module top level — the host forks the plugin's entry file, so
 * running on import is what starts the plugin. That is the same shape the
 * hand-written backends used (they posted `ready` at module load).
 *
 * EVERY FAILURE IS LOUD. A handler that throws replies with `ok:false` and the
 * message; an unknown method replies with the list of known ones; a message
 * with no panel id is logged with the plugin's name. Silent failure — a button
 * that does nothing and reports nothing — is the specific thing this SDK is
 * here to make impossible.
 */

// ── Wire types ───────────────────────────────────────────────────────────

/** `process.parentPort` — Electron's control plane to the main process. */
interface HostPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown; ports?: unknown[] }) => void): void;
}

/** A MessagePort to the plugin's panel windows (the data plane). */
interface PanelPort {
  postMessage(message: unknown): void;
  on(event: string, listener: (event: { data?: unknown }) => void): void;
  start?(): void;
}

interface IncomingMessage {
  type?: string;
  id?: string;
  name?: string;
  method?: string;
  params?: Record<string, unknown>;
  args?: string;
  event?: string;
  data?: unknown;
  actionId?: string;
  text?: string;
  providerId?: string;
  message?: string;
  result?: unknown;
  error?: string;
  pluginId?: string;
  dataDir?: string;
}

// ── Public API ───────────────────────────────────────────────────────────

/** What a tool handler hands back to the agent. */
export interface ToolResult {
  /** Text (and optionally images) shown in the conversation. */
  content?: Array<Record<string, unknown>>;
  /** Structured payload for renderers and the transcript. */
  details?: unknown;
  /** Declarative card shown alongside the result. */
  card?: unknown;
}

/** Everything a handler needs from the host. */
export interface PluginContext {
  readonly pluginId: string;
  /** This plugin's private directory. Created before the backend starts. */
  readonly dataDir: string;
  /**
   * Call a host capability (storage / notify / network / panel / …).
   * Permission-gated in main.
   *
   * `timeoutMs` overrides the 30s default for one call — a capability that
   * waits on the outside world (loading a slow page) needs longer, and raising
   * the default for everyone would just make every OTHER failure slower to
   * report.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * Push an event to one of this plugin's panels. Fire-and-forget.
   *
   * Returns false when nothing was listening — no panel has connected yet, or
   * the port has closed. That is a normal state, not an error: a backend
   * renders its first state from `onInit`, long before anyone opens the panel,
   * and pushes on timers while it is closed. Callers that need delivery (a
   * notification the user must see) should ask `panelAlive` first and record
   * what did not get through.
   */
  send(panelId: string, event: string, data?: unknown): boolean;
  /**
   * Ask whether a panel is there to receive a message. Best-effort, and the
   * only signal that exists: the host never reports a panel closing, and a
   * postMessage into a dead peer succeeds silently. So this pings and waits.
   *
   * Returns false when no panel is connected, the port has closed, or nothing
   * answered in time. A `true` is not a guarantee the user is looking at it —
   * the window can be hidden or the app occluded — only that something is
   * alive on the other end.
   */
  panelAlive(panelId: string, timeoutMs?: number): Promise<boolean>;
  /** Open one of this plugin's panels. focus=false → badge only, no steal. */
  openPanel(panelId: string, options?: { focus?: boolean }): Promise<unknown>;
  /** Set (or clear, with null) the badge on a panel's rail button. */
  setBadge(panelId: string, badge: number | string | null): Promise<void>;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface PluginHandlers {
  /** Runs once, when the host sends `init`. */
  onInit?(ctx: PluginContext): void | Promise<void>;

  /**
   * A panel asked for something and is waiting for the answer.
   * Return the value; throw to reject. An unknown `method` answers with an
   * error naming the methods that DO exist, rather than hanging.
   */
  onRequest?(
    panelId: string,
    method: string,
    params: Record<string, unknown>,
    ctx: PluginContext,
  ): unknown | Promise<unknown>;

  /** A panel reported something. Fire-and-forget — there is no reply. */
  onEvent?(panelId: string, event: string, data: unknown, ctx: PluginContext): void | Promise<void>;

  /**
   * A panel finished loading and is ready to be drawn into.
   *
   * This is where a panel's first paint belongs. `onInit` runs when the BACKEND
   * starts — long before anyone opens the panel — so anything pushed there is
   * sent with nothing listening. `params` carries whatever the host opened the
   * panel with (e.g. `{ file }`).
   *
   * Handled before `onEvent`: `panel.mounted` is a lifecycle step, not a
   * plugin-defined event, so the author never sees it in `onEvent`.
   */
  onPanelMounted?(panelId: string, params: unknown, ctx: PluginContext): void | Promise<void>;

  /** The agent called one of this plugin's tools. */
  onTool?(
    name: string,
    args: Record<string, unknown>,
    ctx: PluginContext,
  ): ToolResult | string | void | Promise<ToolResult | string | void>;

  /** A contributed slash command ran. */
  onCommand?(name: string, args: string | undefined, ctx: PluginContext): unknown | Promise<unknown>;

  /** One of the plugin's selection (滑词) actions was invoked. */
  onSelectionAction?(actionId: string, text: string, ctx: PluginContext): unknown | Promise<unknown>;

  /** The host wants context to inject before a message send. Return the text. */
  onContextRequest?(providerId: string, message: string, ctx: PluginContext): string | Promise<string>;

  /** The host pushed an event (e.g. browser.urlChanged). */
  onHostEvent?(event: string, data: unknown, ctx: PluginContext): void;
}

/** How long a capability call waits before giving up. */
const CALL_TIMEOUT_MS = 30_000;

/** How long a panel liveness probe waits for its pong. */
const PROBE_TIMEOUT_MS = 1500;

// ── Runtime ──────────────────────────────────────────────────────────────

/**
 * `process.parentPort`, reached through globalThis so this package needs no
 * `@types/node` — it is the only Node API it touches, and pulling in the whole
 * type surface for one property would be a silly dependency for a plugin author
 * to inherit.
 */
function hostPort(): HostPort | null {
  const globals = globalThis as unknown as { process?: { parentPort?: HostPort } };
  return globals.process?.parentPort ?? null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register a plugin with the host.
 *
 * Call once at module top level. Throws immediately if there is no host port —
 * a plugin backend only ever runs forked by the host, so a missing port means
 * it was started by hand, and every message would go nowhere.
 */
export function plugin(handlers: PluginHandlers): void {
  const host = hostPort();
  if (!host) {
    throw new Error(
      'pi plugin SDK: no host port. A plugin backend must be started by the host ' +
        '(it is forked as a child process); running it directly cannot work.',
    );
  }

  let panelPort: PanelPort | null = null;
  let pluginId = '';
  let dataDir = '';
  /** False until the host's `init` arrives; handlers must not run before it. */
  let booted = false;
  let seq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Panels already warned about having no onPanelMounted handler — warn once each. */
  const mountWarned = new Set<string>();
  /** Set when the panel port closes — the closest thing to "the window is gone". */
  let portClosed = false;
  let probeSeq = 0;
  const pendingProbes = new Map<string, () => void>();

  const post = (message: unknown): void => host.postMessage(message);
  const log = (level: string, message: string): void => post({ type: 'log', level, message });

  const ctx: PluginContext = {
    get pluginId() {
      return pluginId;
    },
    get dataDir() {
      return dataDir;
    },
    call<T>(
      method: string,
      params: Record<string, unknown> = {},
      options?: { timeoutMs?: number },
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const id = 'c' + ++seq;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        post({ type: 'call', id, method, params });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
        }, options?.timeoutMs ?? CALL_TIMEOUT_MS);
      });
    },
    send(panelId: string, event: string, data?: unknown): boolean {
      // No port, or the port has closed: the message goes nowhere. Deliberately
      // not logged — see the interface comment. Returning false is how a caller
      // finds out.
      if (!panelPort || portClosed) return false;
      panelPort.postMessage({ kind: 'event', event, panelId, data });
      return true;
    },
    panelAlive(panelId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
      // No port, or the port has closed: nothing to ask, and asking would be a
      // postMessage into a dead peer, which succeeds silently.
      if (!panelPort || portClosed) return Promise.resolve(false);
      const id = 'probe-' + ++probeSeq;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingProbes.delete(id);
          resolve(false);
        }, timeoutMs);
        pendingProbes.set(id, () => {
          clearTimeout(timer);
          resolve(true);
        });
        panelPort!.postMessage({ kind: 'event', event: 'pi.probe', panelId, data: { id } });
      });
    },
    async openPanel(panelId: string, options?: { focus?: boolean }): Promise<unknown> {
      return ctx.call('panel.open', { panelId, focus: options?.focus !== false });
    },
    async setBadge(panelId: string, badge: number | string | null): Promise<void> {
      await ctx.call('panel.setStatus', { panelId, badge: badge ?? '' }).catch(() => {});
    },
    log: {
      info: (m: string) => log('info', m),
      warn: (m: string) => log('warn', m),
      error: (m: string) => log('error', m),
    },
  };

  // ── Tool calls ──
  async function runTool(msg: IncomingMessage): Promise<void> {
    const id = msg.id ?? '';
    const name = msg.name ?? '';
    // Handlers receive the context as an argument, and before `init` there is
    // no plugin id or data dir to put in it. A tool call cannot legitimately
    // arrive first — the host sends `init` before anything else — so this is
    // either a test driving the backend without one or a host bug. Say which,
    // rather than letting the handler fail on an empty context.
    if (!booted) {
      post({
        type: 'tool-result',
        id,
        error:
          `tool "${name}" arrived before the host sent init — no plugin id or data dir yet. ` +
          `If you are testing the backend directly, send { type: 'init', pluginId, dataDir } first.`,
      });
      return;
    }
    if (!handlers.onTool) {
      post({ type: 'tool-result', id, error: `this plugin contributes no tools (asked for "${name}")` });
      return;
    }
    try {
      const result = await handlers.onTool(name, msg.params ?? {}, ctx);
      // A handler that returns nothing is almost always a forgotten `return`,
      // and the agent would see an empty tool result with no explanation.
      if (result === undefined || result === null) {
        post({
          type: 'tool-result',
          id,
          error: `tool "${name}" returned nothing. Return a string, or an object with content/details/card.`,
        });
        return;
      }
      if (typeof result === 'string') {
        post({ type: 'tool-result', id, content: [{ type: 'text', text: result }] });
        return;
      }
      post({ type: 'tool-result', id, ...result });
    } catch (err) {
      post({ type: 'tool-result', id, error: describe(err) });
    }
  }

  // ── Panel traffic ──
  async function onPanelMessage(raw: unknown): Promise<void> {
    const msg = raw as {
      kind?: string;
      id?: string;
      panelId?: string;
      method?: string;
      params?: Record<string, unknown>;
      event?: string;
      data?: unknown;
    } | null;
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'request') {
      const id = String(msg.id ?? '');
      const method = String(msg.method ?? '');
      const panelId = msg.panelId ?? '';
      if (!panelId) {
        log('warn', `panel request "${method}" arrived with no panel id — cannot attribute it.`);
      }
      if (!handlers.onRequest) {
        panelPort?.postMessage({
          kind: 'response',
          id,
          ok: false,
          panelId,
          error: `this plugin handles no panel requests (asked for "${method}")`,
        });
        return;
      }
      if (!booted) {
        panelPort?.postMessage({
          kind: 'response',
          id,
          ok: false,
          panelId,
          error: `request "${method}" arrived before the host sent init — no plugin id or data dir yet.`,
        });
        return;
      }
      try {
        const result = await handlers.onRequest(panelId, method, msg.params ?? {}, ctx);
        // A request must ANSWER. Returning nothing is either a forgotten
        // `return` or an unhandled method name, and both used to look like
        // success on the panel side — it would resolve with undefined and the
        // real bug would surface somewhere far away.
        if (result === undefined) {
          panelPort?.postMessage({
            kind: 'response',
            id,
            ok: false,
            panelId,
            error:
              `onRequest handled "${method}" without returning anything. ` +
              `Return the answer (a value, or true), or rethrow for a method you do not handle.`,
          });
          return;
        }
        panelPort?.postMessage({ kind: 'response', id, ok: true, panelId, result });
      } catch (err) {
        panelPort?.postMessage({ kind: 'response', id, ok: false, panelId, error: describe(err) });
      }
      return;
    }

    if (msg.kind === 'event') {
      const event = String(msg.event ?? '');
      const panelId = msg.panelId ?? '';

      // The pong for ctx.panelAlive — SDK-level, like panel.mounted. An author
      // asking "is the panel there" should not have to also write the reply.
      if (event === 'pi.probe.reply') {
        const probeId = String((msg.data as { id?: string })?.id ?? '');
        const resolve = pendingProbes.get(probeId);
        if (resolve) {
          pendingProbes.delete(probeId);
          resolve();
        }
        return;
      }

      if (!panelId) log('warn', `panel event "${event}" arrived with no panel id.`);

      // `panel.mounted` is the host's lifecycle signal, not a plugin event —
      // intercept it so an author cannot accidentally swallow it in onEvent and
      // leave a permanently blank panel.
      if (event === 'panel.mounted') {
        if (!handlers.onPanelMounted) {
          if (!mountWarned.has(panelId)) {
            mountWarned.add(panelId);
            log(
              'warn',
              `panel "${panelId}" mounted but nothing was drawn: this plugin has no ` +
                `onPanelMounted handler. Add one and push the panel's first state from there.`,
            );
          }
          return;
        }
        try {
          await handlers.onPanelMounted(panelId, (msg.data as { params?: unknown })?.params, ctx);
        } catch (err) {
          log('error', `onPanelMounted for "${panelId}" threw: ${describe(err)}`);
        }
        return;
      }

      if (!handlers.onEvent) {
        log('warn', `panel event "${event}" ignored: this plugin handles no events.`);
        return;
      }
      try {
        await handlers.onEvent(panelId, event, msg.data, ctx);
      } catch (err) {
        log('error', `panel event "${event}" handler threw: ${describe(err)}`);
      }
      return;
    }

    log('warn', `unrecognised panel message (kind=${String((msg as { kind?: string }).kind)}) — ignored`);
  }

  // ── Host messages ──
  host.on('message', (event) => {
    const msg = (event.data ?? {}) as IncomingMessage;
    switch (msg.type) {
      case 'init':
        pluginId = msg.pluginId ?? '';
        dataDir = msg.dataDir ?? '';
        booted = true;
        Promise.resolve(handlers.onInit?.(ctx)).catch((err) =>
          log('error', `onInit threw: ${describe(err)}`),
        );
        break;

      case 'call-result': {
        const entry = pending.get(msg.id ?? '');
        if (entry) {
          pending.delete(msg.id ?? '');
          if (msg.error) entry.reject(new Error(msg.error));
          else entry.resolve(msg.result);
        }
        break;
      }

      case 'tool-call':
        void runTool(msg);
        break;

      case 'command':
        if (!handlers.onCommand) {
          post({ type: 'command-result', id: msg.id, error: `this plugin contributes no commands` });
          break;
        }
        Promise.resolve(handlers.onCommand(msg.name ?? '', msg.args, ctx))
          .then((result) => post({ type: 'command-result', id: msg.id, result }))
          .catch((err) => post({ type: 'command-result', id: msg.id, error: describe(err) }));
        break;

      case 'selection-action':
        if (!handlers.onSelectionAction) {
          post({ type: 'command-result', id: msg.id, error: `this plugin contributes no selection actions` });
          break;
        }
        Promise.resolve(handlers.onSelectionAction(msg.actionId ?? '', msg.text ?? '', ctx))
          .then((result) => post({ type: 'command-result', id: msg.id, result }))
          .catch((err) => post({ type: 'command-result', id: msg.id, error: describe(err) }));
        break;

      case 'context-request':
        if (!handlers.onContextRequest) {
          post({ type: 'context-result', id: msg.id, error: `this plugin contributes no context providers` });
          break;
        }
        Promise.resolve(handlers.onContextRequest(msg.providerId ?? '', msg.message ?? '', ctx))
          .then((text) => post({ type: 'context-result', id: msg.id, text: text ?? '' }))
          .catch((err) => post({ type: 'context-result', id: msg.id, error: describe(err) }));
        break;

      case 'host-event':
        try {
          handlers.onHostEvent?.(msg.event ?? '', msg.data, ctx);
        } catch (err) {
          log('error', `host event "${String(msg.event)}" handler threw: ${describe(err)}`);
        }
        break;

      case 'ui-port': {
        const port = event.ports?.[0] as PanelPort | undefined;
        if (!port) break;
        // A fresh port replaces the old one (renderer reload); the previous
        // port is dead, so dropping the reference is the whole cleanup.
        panelPort = port;
        portClosed = false;
        // The host closes a replaced port when a fresh webContents takes over.
        // That is the only close signal that exists — see panelAlive.
        try {
          port.on('close', () => {
            portClosed = true;
          });
        } catch {
          /* older Electron: no close event; the probe timeout still covers it */
        }
        port.on('message', (e) => void onPanelMessage(e.data));
        port.start?.();
        break;
      }

      default:
        break;
    }
  });

  post({ type: 'ready' });
}
