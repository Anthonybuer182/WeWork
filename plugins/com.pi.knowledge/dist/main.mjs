var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../packages/plugin-sdk/dist/index.js
var CALL_TIMEOUT_MS = 3e4;
var PROBE_TIMEOUT_MS = 1500;
function hostPort() {
  const globals = globalThis;
  return globals.process?.parentPort ?? null;
}
__name(hostPort, "hostPort");
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
__name(describe, "describe");
function plugin(handlers) {
  const host = hostPort();
  if (!host) {
    throw new Error("pi plugin SDK: no host port. A plugin backend must be started by the host (it is forked as a child process); running it directly cannot work.");
  }
  let panelPort = null;
  let pluginId = "";
  let dataDir = "";
  let booted = false;
  let seq = 0;
  const pending = /* @__PURE__ */ new Map();
  const mountWarned = /* @__PURE__ */ new Set();
  let portClosed = false;
  let probeSeq = 0;
  const pendingProbes = /* @__PURE__ */ new Map();
  const post = /* @__PURE__ */ __name((message) => host.postMessage(message), "post");
  const log = /* @__PURE__ */ __name((level, message) => post({ type: "log", level, message }), "log");
  const ctx = {
    get pluginId() {
      return pluginId;
    },
    get dataDir() {
      return dataDir;
    },
    call(method, params = {}, options) {
      return new Promise((resolve, reject) => {
        const id = "c" + ++seq;
        pending.set(id, { resolve, reject });
        post({ type: "call", id, method, params });
        setTimeout(() => {
          if (pending.delete(id))
            reject(new Error(`capability timeout: ${method}`));
        }, options?.timeoutMs ?? CALL_TIMEOUT_MS);
      });
    },
    send(panelId, event, data) {
      if (!panelPort || portClosed)
        return false;
      panelPort.postMessage({ kind: "event", event, panelId, data });
      return true;
    },
    panelAlive(panelId, timeoutMs = PROBE_TIMEOUT_MS) {
      if (!panelPort || portClosed)
        return Promise.resolve(false);
      const id = "probe-" + ++probeSeq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingProbes.delete(id);
          resolve(false);
        }, timeoutMs);
        pendingProbes.set(id, () => {
          clearTimeout(timer);
          resolve(true);
        });
        panelPort.postMessage({ kind: "event", event: "pi.probe", panelId, data: { id } });
      });
    },
    async openPanel(panelId, options) {
      return ctx.call("panel.open", { panelId, focus: options?.focus !== false });
    },
    async setBadge(panelId, badge) {
      await ctx.call("panel.setStatus", { panelId, badge: badge ?? "" }).catch(() => {
      });
    },
    log: {
      info: /* @__PURE__ */ __name((m) => log("info", m), "info"),
      warn: /* @__PURE__ */ __name((m) => log("warn", m), "warn"),
      error: /* @__PURE__ */ __name((m) => log("error", m), "error")
    }
  };
  async function runTool(msg) {
    const id = msg.id ?? "";
    const name = msg.name ?? "";
    if (!booted) {
      post({
        type: "tool-result",
        id,
        error: `tool "${name}" arrived before the host sent init \u2014 no plugin id or data dir yet. If you are testing the backend directly, send { type: 'init', pluginId, dataDir } first.`
      });
      return;
    }
    if (!handlers.onTool) {
      post({ type: "tool-result", id, error: `this plugin contributes no tools (asked for "${name}")` });
      return;
    }
    try {
      const result = await handlers.onTool(name, msg.params ?? {}, ctx);
      if (result === void 0 || result === null) {
        post({
          type: "tool-result",
          id,
          error: `tool "${name}" returned nothing. Return a string, or an object with content/details/card.`
        });
        return;
      }
      if (typeof result === "string") {
        post({ type: "tool-result", id, content: [{ type: "text", text: result }] });
        return;
      }
      post({ type: "tool-result", id, ...result });
    } catch (err) {
      post({ type: "tool-result", id, error: describe(err) });
    }
  }
  __name(runTool, "runTool");
  async function onPanelMessage(raw) {
    const msg = raw;
    if (!msg || typeof msg !== "object")
      return;
    if (msg.kind === "request") {
      const id = String(msg.id ?? "");
      const method = String(msg.method ?? "");
      const panelId = msg.panelId ?? "";
      if (!panelId) {
        log("warn", `panel request "${method}" arrived with no panel id \u2014 cannot attribute it.`);
      }
      if (!handlers.onRequest) {
        panelPort?.postMessage({
          kind: "response",
          id,
          ok: false,
          panelId,
          error: `this plugin handles no panel requests (asked for "${method}")`
        });
        return;
      }
      if (!booted) {
        panelPort?.postMessage({
          kind: "response",
          id,
          ok: false,
          panelId,
          error: `request "${method}" arrived before the host sent init \u2014 no plugin id or data dir yet.`
        });
        return;
      }
      try {
        const result = await handlers.onRequest(panelId, method, msg.params ?? {}, ctx);
        if (result === void 0) {
          panelPort?.postMessage({
            kind: "response",
            id,
            ok: false,
            panelId,
            error: `onRequest handled "${method}" without returning anything. Return the answer (a value, or true), or rethrow for a method you do not handle.`
          });
          return;
        }
        panelPort?.postMessage({ kind: "response", id, ok: true, panelId, result });
      } catch (err) {
        panelPort?.postMessage({ kind: "response", id, ok: false, panelId, error: describe(err) });
      }
      return;
    }
    if (msg.kind === "event") {
      const event = String(msg.event ?? "");
      const panelId = msg.panelId ?? "";
      if (event === "pi.probe.reply") {
        const probeId = String(msg.data?.id ?? "");
        const resolve = pendingProbes.get(probeId);
        if (resolve) {
          pendingProbes.delete(probeId);
          resolve();
        }
        return;
      }
      if (!panelId)
        log("warn", `panel event "${event}" arrived with no panel id.`);
      if (event === "panel.mounted") {
        if (!handlers.onPanelMounted) {
          if (!mountWarned.has(panelId)) {
            mountWarned.add(panelId);
            log("warn", `panel "${panelId}" mounted but nothing was drawn: this plugin has no onPanelMounted handler. Add one and push the panel's first state from there.`);
          }
          return;
        }
        try {
          await handlers.onPanelMounted(panelId, msg.data?.params, ctx);
        } catch (err) {
          log("error", `onPanelMounted for "${panelId}" threw: ${describe(err)}`);
        }
        return;
      }
      if (!handlers.onEvent) {
        log("warn", `panel event "${event}" ignored: this plugin handles no events.`);
        return;
      }
      try {
        await handlers.onEvent(panelId, event, msg.data, ctx);
      } catch (err) {
        log("error", `panel event "${event}" handler threw: ${describe(err)}`);
      }
      return;
    }
    log("warn", `unrecognised panel message (kind=${String(msg.kind)}) \u2014 ignored`);
  }
  __name(onPanelMessage, "onPanelMessage");
  host.on("message", (event) => {
    const msg = event.data ?? {};
    switch (msg.type) {
      case "init":
        pluginId = msg.pluginId ?? "";
        dataDir = msg.dataDir ?? "";
        booted = true;
        Promise.resolve(handlers.onInit?.(ctx)).catch((err) => log("error", `onInit threw: ${describe(err)}`));
        break;
      case "call-result": {
        const entry = pending.get(msg.id ?? "");
        if (entry) {
          pending.delete(msg.id ?? "");
          if (msg.error)
            entry.reject(new Error(msg.error));
          else
            entry.resolve(msg.result);
        }
        break;
      }
      case "tool-call":
        void runTool(msg);
        break;
      case "command":
        if (!handlers.onCommand) {
          post({ type: "command-result", id: msg.id, error: `this plugin contributes no commands` });
          break;
        }
        Promise.resolve(handlers.onCommand(msg.name ?? "", msg.args, ctx)).then((result) => post({ type: "command-result", id: msg.id, result })).catch((err) => post({ type: "command-result", id: msg.id, error: describe(err) }));
        break;
      case "context-request":
        if (!handlers.onContextRequest) {
          post({ type: "context-result", id: msg.id, error: `this plugin contributes no context providers` });
          break;
        }
        Promise.resolve(handlers.onContextRequest(msg.providerId ?? "", msg.message ?? "", ctx)).then((text) => post({ type: "context-result", id: msg.id, text: text ?? "" })).catch((err) => post({ type: "context-result", id: msg.id, error: describe(err) }));
        break;
      case "host-event":
        try {
          handlers.onHostEvent?.(msg.event ?? "", msg.data, ctx);
        } catch (err) {
          log("error", `host event "${String(msg.event)}" handler threw: ${describe(err)}`);
        }
        break;
      case "ui-port": {
        const port = event.ports?.[0];
        if (!port)
          break;
        panelPort = port;
        portClosed = false;
        try {
          port.on("close", () => {
            portClosed = true;
          });
        } catch {
        }
        port.on("message", (e) => void onPanelMessage(e.data));
        port.start?.();
        break;
      }
      default:
        break;
    }
  });
  post({ type: "ready" });
}
__name(plugin, "plugin");

// src/backend/index.ts
var PANEL = "kb";
var entries = [];
var search = "";
var loaded = false;
function matches(entry, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.title.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q);
}
__name(matches, "matches");
async function load(ctx) {
  const saved = await ctx.call("storage.get", { key: "entries" }).catch(() => void 0);
  entries = Array.isArray(saved) ? saved : [];
  loaded = true;
}
__name(load, "load");
async function ensureLoaded(ctx) {
  if (!loaded) await load(ctx);
}
__name(ensureLoaded, "ensureLoaded");
async function persist(ctx) {
  await ctx.call("storage.set", { key: "entries", value: entries }).catch(() => {
  });
  render(ctx);
}
__name(persist, "persist");
function render(ctx) {
  const query = search;
  ctx.send(PANEL, "ui.render", {
    total: entries.length,
    search,
    shown: entries.filter((e) => matches(e, query))
  });
}
__name(render, "render");
function addEntry(title, content) {
  const entry = {
    id: "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: String(title).slice(0, 200),
    content: String(content ?? "").slice(0, 5e4),
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  entries = [...entries, entry];
  return entry;
}
__name(addEntry, "addEntry");
function retrieve(message, limit = 5) {
  const terms = String(message).toLowerCase().split(/[\s,，。.;；:：?？!！()（）"'「」[\]]+/).filter((t) => t.length >= 2).slice(0, 30);
  if (terms.length === 0) return [];
  return entries.map((entry) => {
    const haystack = `${entry.title}
${entry.content}`.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
    return { entry, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.entry);
}
__name(retrieve, "retrieve");
plugin({
  async onInit(ctx) {
    await ensureLoaded(ctx);
  },
  /** The panel draws from here — onInit runs before anyone has opened it. */
  async onPanelMounted(_panelId, _params, ctx) {
    await ensureLoaded(ctx);
    render(ctx);
  },
  async onTool(name, params, ctx) {
    switch (name) {
      case "kb_save": {
        const title = String(params.title ?? "");
        if (!title) throw new Error("missing title");
        const entry = addEntry(title, String(params.content ?? ""));
        await persist(ctx);
        return `\u5DF2\u4FDD\u5B58\u77E5\u8BC6\u300C${entry.title}\u300D(${entry.content.length} \u5B57\u7B26)`;
      }
      case "kb_search": {
        const query = String(params.query ?? "");
        const hits = entries.filter((e) => matches(e, query));
        if (hits.length === 0) return `\u6CA1\u6709\u5339\u914D\u300C${query}\u300D\u7684\u77E5\u8BC6\u6761\u76EE\u3002`;
        return hits.map((e) => `\u3010${e.title}\u3011
${e.content.slice(0, 500)}`).join("\n\n");
      }
      case "kb_list": {
        if (entries.length === 0) return "\u77E5\u8BC6\u5E93\u4E3A\u7A7A\u3002";
        return `\u77E5\u8BC6\u5E93(${entries.length} \u6761):
${entries.map((e) => `\xB7 ${e.title}`).join("\n")}`;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
  async onContextRequest(providerId, message, ctx) {
    if (providerId !== "kb.auto") throw new Error(`unknown provider: ${providerId}`);
    const setting = await ctx.call("storage.get", { key: "settings.autoContext" }).catch(() => void 0);
    if (setting === false) return "";
    const hits = retrieve(message);
    if (hits.length === 0) return "";
    return hits.map((e) => `\u3010${e.title}\u3011
${e.content.slice(0, 800)}`).join("\n\n");
  },
  /**
   * Panel events. This plugin has one panel, so the events are named for what
   * happened rather than routed through the host's `ui.event` envelope — the
   * SDK stamps the panel id either way, but a name that says what it is reads
   * better and needs no unwrapping.
   */
  async onEvent(_panelId, event, data, ctx) {
    switch (event) {
      case "kb.add": {
        const title = String(data ?? "").trim();
        if (title) {
          addEntry(title, "");
          await persist(ctx);
        }
        break;
      }
      case "kb.search":
        search = String(data ?? "");
        render(ctx);
        break;
      case "kb.delete":
        entries = entries.filter((e) => e.id !== String(data?.key));
        await persist(ctx);
        break;
      default:
        ctx.log.warn(`ignoring unknown panel event "${String(event)}"`);
    }
  }
});
