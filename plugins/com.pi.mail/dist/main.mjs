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
var PANEL = "drafts";
var EMPTY_COMPOSING = { to: "", subject: "", body: "" };
var drafts = [];
var composing = { ...EMPTY_COMPOSING };
var loaded = false;
async function load(ctx) {
  const [savedDrafts, savedComposing] = await Promise.all([
    ctx.call("storage.get", { key: "drafts" }).catch(() => void 0),
    ctx.call("storage.get", { key: "composing" }).catch(() => void 0)
  ]);
  drafts = Array.isArray(savedDrafts) ? savedDrafts : [];
  composing = savedComposing && typeof savedComposing === "object" ? savedComposing : { ...EMPTY_COMPOSING };
  loaded = true;
}
__name(load, "load");
async function ensureLoaded(ctx) {
  if (!loaded) await load(ctx);
}
__name(ensureLoaded, "ensureLoaded");
async function save(ctx) {
  await Promise.all([
    ctx.call("storage.set", { key: "drafts", value: drafts }).catch(() => {
    }),
    ctx.call("storage.set", { key: "composing", value: composing }).catch(() => {
    })
  ]);
  ctx.send(PANEL, "ui.render", { composing, drafts });
}
__name(save, "save");
function createDraft(to, subject, body) {
  const draft = {
    id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    to: String(to ?? "").slice(0, 200),
    subject: String(subject ?? "(\u65E0\u4E3B\u9898)").slice(0, 300),
    body: String(body ?? "").slice(0, 2e4),
    sent: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  drafts = [...drafts, draft];
  return draft;
}
__name(createDraft, "createDraft");
function draftCard(draft) {
  return {
    component: "Card",
    props: { title: "\u90AE\u4EF6\u8349\u7A3F" },
    children: [
      {
        component: "KeyValue",
        props: {
          items: [
            ["\u6536\u4EF6\u4EBA", draft.to || "(\u672A\u586B)"],
            ["\u4E3B\u9898", draft.subject],
            ["\u72B6\u6001", draft.sent ? "\u5DF2\u53D1\u9001" : "\u8349\u7A3F"]
          ]
        }
      }
    ]
  };
}
__name(draftCard, "draftCard");
plugin({
  async onInit(ctx) {
    await ensureLoaded(ctx);
  },
  async onPanelMounted(_panelId, _params, ctx) {
    await ensureLoaded(ctx);
    ctx.send(PANEL, "ui.render", { composing, drafts });
  },
  async onTool(name, params, ctx) {
    switch (name) {
      case "mail_create_draft": {
        const draft = createDraft(params.to, params.subject, params.body);
        await save(ctx);
        return {
          content: [
            { type: "text", text: `\u5DF2\u521B\u5EFA\u8349\u7A3F\u300C${draft.subject}\u300D\u2192 ${draft.to || "(\u672A\u586B\u6536\u4EF6\u4EBA)"}` }
          ],
          card: draftCard(draft)
        };
      }
      case "mail_list_drafts": {
        if (drafts.length === 0) return "\u8349\u7A3F\u7BB1\u4E3A\u7A7A\u3002";
        const lines = drafts.map(
          (d) => `${d.sent ? "[\u5DF2\u53D1\u9001]" : "[\u8349\u7A3F]"} ${d.subject} \u2192 ${d.to}`
        );
        return `\u8349\u7A3F(${drafts.length}):
${lines.join("\n")}`;
      }
      case "mail_send_draft": {
        const subject = String(params.subject ?? "").trim();
        const draft = [...drafts].reverse().find((d) => !d.sent && (d.subject === subject || d.subject.startsWith(subject)));
        if (!draft) throw new Error(`\u672A\u627E\u5230\u5F85\u53D1\u9001\u7684\u8349\u7A3F: ${subject}`);
        draft.sent = true;
        await save(ctx);
        await ctx.call("notify.show", { title: "\u90AE\u4EF6\u5DF2\u53D1\u9001(\u6F14\u793A)", body: `${draft.subject} \u2192 ${draft.to}` }).catch(() => {
        });
        return `\u5DF2\u53D1\u9001\u8349\u7A3F\u300C${draft.subject}\u300D\u2192 ${draft.to}`;
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
  async onCommand(name, _args, ctx) {
    if (name === "/mail") {
      await ctx.openPanel(PANEL);
      return { opened: PANEL };
    }
    throw new Error(`unknown command: ${name}`);
  },
  /** One panel, so the events are named for what happened. */
  async onEvent(_panelId, event, data, ctx) {
    switch (event) {
      case "mail.to":
        composing.to = String(data ?? "");
        break;
      case "mail.subject":
        composing.subject = String(data ?? "");
        break;
      case "mail.body":
        composing.body = String(data ?? "");
        break;
      case "mail.save": {
        if (composing.subject.trim() || composing.to.trim()) {
          createDraft(composing.to, composing.subject, composing.body);
          composing = { ...EMPTY_COMPOSING };
        }
        break;
      }
      case "mail.send": {
        const draft = drafts.find((d) => d.id === String(data?.key));
        if (draft) {
          draft.sent = true;
          await ctx.call("notify.show", { title: "\u90AE\u4EF6\u5DF2\u53D1\u9001(\u6F14\u793A)", body: `${draft.subject} \u2192 ${draft.to}` }).catch(() => {
          });
        }
        break;
      }
      default:
        ctx.log.warn(`ignoring unknown panel event "${String(event)}"`);
        return;
    }
    await save(ctx);
  }
});
