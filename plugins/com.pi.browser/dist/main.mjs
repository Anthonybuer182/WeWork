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
var NAVIGATE_TIMEOUT_MS = 6e4;
var SNAPSHOT_MAX_CHARS = 8e3;
var mountedPanels = /* @__PURE__ */ new Set();
var lastUrl = "";
function actionResult(prefix, r, extra = "") {
  return r.error ? `${prefix}\u5931\u8D25: ${r.error}` : `${prefix}\u6210\u529F${extra}`;
}
__name(actionResult, "actionResult");
function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("missing url");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
__name(normalizeUrl, "normalizeUrl");
plugin({
  async onInit(ctx) {
    try {
      const state = await ctx.call("browser.getUrl");
      if (state?.url) lastUrl = state.url;
    } catch {
    }
  },
  async onPanelMounted(panelId, _params, ctx) {
    mountedPanels.add(panelId);
    try {
      const state = await ctx.call("browser.getUrl");
      if (state?.url) lastUrl = state.url;
    } catch {
    }
    if (lastUrl) ctx.send(panelId, "ui.urlChanged", { url: lastUrl });
  },
  async onRequest(panelId, method, params, ctx) {
    switch (method) {
      case "navigate": {
        const result = await ctx.call(
          "browser.navigate",
          { url: normalizeUrl(params.url) },
          { timeoutMs: NAVIGATE_TIMEOUT_MS }
        );
        if (result?.url) lastUrl = result.url;
        return { url: result?.url ?? "", title: result?.title ?? "" };
      }
      case "back":
        await ctx.call("browser.back");
        return { ok: true };
      case "forward":
        await ctx.call("browser.forward");
        return { ok: true };
      case "reload":
        await ctx.call("browser.reload");
        return { ok: true };
      case "state.get": {
        const state = await ctx.call("browser.getUrl");
        if (state?.url) lastUrl = state.url;
        return { url: state?.url ?? "", title: state?.title ?? "" };
      }
      default:
        throw new Error(
          `unknown panel method: ${method} (known: navigate, back, forward, reload, state.get)`
        );
    }
  },
  async onHostEvent(event, data, ctx) {
    if (event !== "browser.urlChanged") return;
    lastUrl = String(data?.url ?? "");
    for (const panelId of mountedPanels) {
      ctx.send(panelId, "ui.urlChanged", { url: lastUrl });
    }
  },
  async onTool(name, params, ctx) {
    switch (name) {
      case "browser_navigate": {
        const url = normalizeUrl(params.url);
        const result = await ctx.call(
          "browser.navigate",
          { url },
          { timeoutMs: NAVIGATE_TIMEOUT_MS }
        );
        const finalUrl = result?.url ?? url;
        return `\u5DF2\u6253\u5F00 ${finalUrl}${result?.title ? ` \u2014 ${result.title}` : ""}`;
      }
      case "browser_get_state": {
        const state = await ctx.call("browser.getState");
        const lines = [
          `\u5F53\u524D\u9875\u9762: ${state?.url ?? "(about:blank)"}${state?.title ? ` \u2014 ${state.title}` : ""}`
        ];
        if (state?.snapshot) {
          const snap = state.snapshot.length > SNAPSHOT_MAX_CHARS ? `${state.snapshot.slice(0, SNAPSHOT_MAX_CHARS)}
\u2026(\u5FEB\u7167\u5DF2\u622A\u65AD,\u8981\u627E\u5177\u4F53\u5143\u7D20\u7528 browser_find)` : state.snapshot;
          lines.push("", "\u53EF\u4EA4\u4E92\u5143\u7D20(\u5F15\u7528 ref \u53EF\u76F4\u63A5\u4F20\u7ED9 browser_click / browser_fill):", snap);
        }
        return lines.join("\n");
      }
      case "browser_find": {
        const query = String(params.query ?? "").trim();
        if (!query) throw new Error("missing query");
        const matches = await ctx.call("browser.find", { query });
        if (matches.length === 0) return `\u9875\u9762\u4E0A\u6CA1\u6709\u5339\u914D "${query}" \u7684\u5143\u7D20`;
        return matches.map((m) => `[${m.role}] "${m.text}" (${m.section}, \u5339\u914D\u5EA6 ${m.score})`).join("\n");
      }
      case "browser_click": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.click", {
          selector
        });
        return actionResult(`\u70B9\u51FB "${selector}"`, r);
      }
      case "browser_fill": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.fill", {
          selector,
          value: String(params.value ?? "")
        });
        return actionResult(`\u586B\u5199 "${selector}"`, r);
      }
      case "browser_hover": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.hover", {
          selector
        });
        return actionResult(`\u60AC\u505C "${selector}"`, r);
      }
      case "browser_select": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.select", {
          selector,
          value: String(params.value ?? "")
        });
        return actionResult(`\u5728 "${selector}" \u9009\u4E2D "${params.value}"`, r);
      }
      case "browser_scroll": {
        const r = await ctx.call("browser.scroll", {
          direction: params.direction,
          amount: params.amount
        });
        return `\u5DF2${r.direction === "up" ? "\u5411\u4E0A" : "\u5411\u4E0B"}\u6EDA\u52A8 ${r.amount}px`;
      }
      case "browser_evaluate": {
        const expression = String(params.expression ?? "");
        if (!expression.trim()) throw new Error("missing expression");
        const r = await ctx.call("browser.evaluate", { expression });
        return typeof r.result === "string" ? r.result : JSON.stringify(r.result);
      }
      case "browser_walk": {
        const goal = String(params.goal ?? "").trim();
        if (!goal) throw new Error("missing goal");
        const r = await ctx.call(
          "browser.walk",
          { goal, maxSteps: params.maxSteps },
          { timeoutMs: NAVIGATE_TIMEOUT_MS }
        );
        const stepLines = r.steps.map((s, i) => `${i + 1}. \u70B9\u51FB "${s.text}"${s.ok === false ? " \u2717" : ""}`);
        const head = r.reached ? `\u5DF2\u5230\u8FBE\u76EE\u6807 "${goal}"` : `\u672A\u80FD\u5230\u8FBE\u76EE\u6807 "${goal}"`;
        return [head, `\u5F53\u524D: ${r.url ?? "?"}`, ...stepLines].join("\n");
      }
      case "browser_screenshot": {
        const shot = await ctx.call("browser.screenshot", {
          fullPage: params.fullPage === true
        });
        if (!shot?.base64) throw new Error("screenshot failed: the host returned no image data");
        const kb = Math.round(shot.base64.length * 3 / 4 / 1024);
        return {
          content: [
            { type: "text", text: `\u622A\u56FE\u5B8C\u6210 (${kb} KB PNG)` },
            { type: "image", data: shot.base64, mimeType: "image/png" }
          ]
        };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
});
