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
  const panelPorts = /* @__PURE__ */ new Map();
  const portPanel = /* @__PURE__ */ new Map();
  let pluginId = "";
  let dataDir = "";
  let booted = false;
  let seq = 0;
  const pending = /* @__PURE__ */ new Map();
  const mountWarned = /* @__PURE__ */ new Set();
  let portClosed = false;
  let probeSeq = 0;
  const pendingProbes = /* @__PURE__ */ new Map();
  function routeFor(panelId) {
    if (panelId) {
      const p = panelPorts.get(panelId);
      if (p)
        return p;
    }
    return panelPort;
  }
  __name(routeFor, "routeFor");
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
      const port = routeFor(panelId);
      if (!port)
        return false;
      port.postMessage({ kind: "event", event, panelId, data });
      return true;
    },
    panelAlive(panelId, timeoutMs = PROBE_TIMEOUT_MS) {
      const port = routeFor(panelId);
      if (!port)
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
        port.postMessage({ kind: "event", event: "pi.probe", panelId, data: { id } });
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
      const result = await handlers.onTool(name, msg.params ?? {}, ctx, {
        sessionId: msg.sessionId
      });
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
  async function onPanelMessage(raw, sourcePort) {
    const msg = raw;
    if (!msg || typeof msg !== "object")
      return;
    if (msg.kind === "request") {
      const id = String(msg.id ?? "");
      const method = String(msg.method ?? "");
      const panelId = msg.panelId ?? "";
      const replyPort = sourcePort ?? routeFor(panelId);
      const reply = /* @__PURE__ */ __name((ok, error, result) => {
        replyPort?.postMessage({ kind: "response", id, ok, panelId, error, result });
      }, "reply");
      if (!panelId) {
        log("warn", `panel request "${method}" arrived with no panel id \u2014 cannot attribute it.`);
      }
      if (!handlers.onRequest) {
        reply(false, `this plugin handles no panel requests (asked for "${method}")`);
        return;
      }
      if (!booted) {
        reply(false, `request "${method}" arrived before the host sent init \u2014 no plugin id or data dir yet.`);
        return;
      }
      try {
        const result = await handlers.onRequest(panelId, method, msg.params ?? {}, ctx);
        if (result === void 0) {
          reply(false, `onRequest handled "${method}" without returning anything. Return the answer (a value, or true), or rethrow for a method you do not handle.`);
          return;
        }
        reply(true, void 0, result);
      } catch (err) {
        reply(false, describe(err));
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
          const data = msg.data ?? {};
          await handlers.onPanelMounted(panelId, data.params, ctx, { sessionId: data.sessionId });
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
      case "card-event": {
        if (!handlers.onCardEvent) {
          log("warn", `card event "${String(msg.eventId)}" on ${String(msg.toolName)} ignored \u2014 implement onCardEvent`);
          break;
        }
        try {
          handlers.onCardEvent(msg.toolName ?? "", msg.eventId ?? "", msg.kind === "submit" ? "submit" : "click", msg.payload, ctx);
        } catch (err) {
          log("error", `card event "${String(msg.eventId)}" handler threw: ${describe(err)}`);
        }
        break;
      }
      case "ui-port": {
        const port = event.ports?.[0];
        if (!port)
          break;
        panelPort = port;
        portClosed = false;
        port.on("message", (e) => {
          const pid = e.data?.panelId;
          if (pid) {
            portPanel.set(port, pid);
            panelPorts.set(pid, port);
          }
          void onPanelMessage(e.data, port);
        });
        try {
          port.on("close", () => {
            const pid = portPanel.get(port);
            if (pid && panelPorts.get(pid) === port)
              panelPorts.delete(pid);
            portPanel.delete(port);
            if (panelPort === port) {
              panelPort = panelPorts.size > 0 ? [...panelPorts.values()][panelPorts.size - 1] : null;
              if (!panelPort)
                portClosed = true;
            }
          });
        } catch {
        }
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
var HISTORY_KEY = "history.entries";
var FAVORITES_KEY = "favorites.items";
var SETTINGS_KEY = "settings";
var RECIPES_KEY = "recipes.items";
var HISTORY_MAX = 500;
var OMNIBOX_RECENT = 8;
var OMNIBOX_LIMIT = 30;
var HISTORY_TOOL_LIMIT = 20;
var TITLE_REFRESH_MS = 1200;
var CLIPS_KEY = "clips.items";
var SEL_POLL_MS = 400;
var SELECTION_MAX_CHARS = 4e3;
var CLIP_MAX_CHARS = 8e3;
var CLIPS_MAX = 200;
var NOTE_TIMEOUT_MS = 12e4;
var PENDING_HINT_MS = 1e4;
var INJECT_ATTEMPTS_MS = [600, 2e3, 4500];
var INJECT_SOURCE = `(function () {
  if (window.__piSelInstalled) return 'already';
  try {
    var host = document.createElement('div');
    host.setAttribute('data-pi-sel-host', '');
    var root = host.attachShadow({ mode: 'closed' });

    function styled(tag, css) {
      var el = document.createElement(tag);
      el.style.cssText = css;
      return el;
    }
    function whenLabel(ts) {
      var d = new Date(ts || 0);
      if (isNaN(d.getTime())) return '';
      return (d.getMonth() + 1) + '\u6708' + d.getDate() + '\u65E5';
    }

    var BTN = 'all:unset;cursor:pointer;padding:4px 9px;border-radius:5px;color:#e8eaf0;font:12px/1 system-ui,sans-serif';

    // \u2500\u2500 the composite popup \u2500\u2500
    var popup = styled('div',
      'position:fixed;z-index:2147483647;display:none;width:340px;max-width:calc(100vw - 16px);' +
      'padding:8px;border-radius:10px;background:rgba(18,20,28,.96);color:#e8eaf0;' +
      'box-shadow:0 6px 22px rgba(0,0,0,.45)');
    var pinned = false;
    var anchorRect = null;

    var row = styled('div', 'display:flex;gap:4px;align-items:center;margin-bottom:6px');
    function actionBtn(label) {
      var b = styled('button', BTN);
      b.textContent = label;
      b.addEventListener('mouseenter', function () { b.style.background = 'rgba(80,120,255,.85)'; });
      b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
      return b;
    }
    var btnTranslate = actionBtn('\u7FFB\u8BD1');
    var btnExplain = actionBtn('\u89E3\u91CA');
    var btnClip = actionBtn('\u6536\u85CF');
    var btnClose = styled('button',
      'all:unset;cursor:pointer;margin-left:auto;padding:4px 6px;color:#8b93a7;font:14px/1 system-ui,sans-serif');
    btnClose.textContent = '\xD7';
    row.appendChild(btnTranslate);
    row.appendChild(btnExplain);
    row.appendChild(btnClip);
    row.appendChild(btnClose);

    var inputRow = styled('div', 'display:flex;gap:6px;align-items:flex-end');
    var inputBox = styled('div',
      'flex:1;padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,.16);' +
      'background:rgba(255,255,255,.06)');
    // The quote is a chip, not textarea text: a long selection stays one line,
    // and the question field below belongs to the user's words alone.
    var quoteRow = styled('div', 'display:none;margin-bottom:3px');
    var chip = styled('div',
      'display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 5px 3px 8px;' +
      'border-radius:5px;background:rgba(80,120,255,.22);font:11px/1.4 system-ui,sans-serif;color:#c3d2ff');
    var chipText = styled('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px');
    var chipCount = styled('span', 'flex:none;color:#8b93a7');
    var chipX = styled('button',
      'all:unset;cursor:pointer;flex:none;padding:1px 4px;border-radius:4px;color:#8b93a7;' +
      'font:11px/1 system-ui,sans-serif');
    chipX.textContent = '\xD7';
    chip.appendChild(chipText);
    chip.appendChild(chipCount);
    chip.appendChild(chipX);
    quoteRow.appendChild(chip);
    var question = styled('textarea',
      'width:100%;min-height:30px;max-height:78px;resize:none;border:none;padding:4px 4px 0 4px;' +
      'display:block;background:transparent;color:#e8eaf0;font:12px/1.5 system-ui,sans-serif;outline:none');
    question.placeholder = '\u95EE\u70B9\u4EC0\u4E48,\u6216\u76F4\u63A5\u56DE\u8F66\u53D1\u9001\u5F15\u7528\u2026';
    inputBox.appendChild(quoteRow);
    inputBox.appendChild(question);
    var btnSend = styled('button',
      'all:unset;cursor:pointer;padding:6px 10px;border-radius:6px;background:rgba(80,120,255,.9);' +
      'color:#fff;font:12px/1 system-ui,sans-serif;white-space:nowrap');
    btnSend.textContent = '\u53D1\u9001';
    inputRow.appendChild(inputBox);
    inputRow.appendChild(btnSend);

    // The full quoted text lives here \u2014 the chip only shows a preview of it.
    var quoteText = null;
    function setQuote(text) {
      quoteText = text;
      if (quoteText) {
        chipText.textContent = '\u300C\u5F15\u7528\u300D' + (quoteText.length > 40 ? quoteText.slice(0, 40) + '\u2026' : quoteText);
        chipCount.textContent = quoteText.length > 40 ? '(' + quoteText.length + ' \u5B57)' : '';
        quoteRow.style.display = 'block';
      } else {
        quoteRow.style.display = 'none';
      }
      syncButtons();
    }
    // \u7FFB\u8BD1/\u89E3\u91CA/\u6536\u85CF act on the quote; \u53D1\u9001 needs the quote or a question.
    function syncButtons() {
      var hasQuote = !!quoteText;
      var hasQuestion = !!question.value.trim();
      var three = [btnTranslate, btnExplain, btnClip];
      for (var i = 0; i < three.length; i++) {
        three[i].style.opacity = hasQuote ? '1' : '0.4';
        three[i].style.cursor = hasQuote ? 'pointer' : 'default';
      }
      btnSend.style.opacity = (hasQuote || hasQuestion) ? '1' : '0.4';
      btnSend.style.cursor = (hasQuote || hasQuestion) ? 'pointer' : 'default';
    }
    question.addEventListener('input', syncButtons);
    chipX.addEventListener('click', function () { setQuote(null); });

    // \u2500\u2500 the results area (and the clips list) \u2500\u2500
    var results = styled('div', 'display:none;margin-top:6px;max-height:40vh;overflow:auto');
    var resultsHead = styled('div', 'font-weight:600;margin-bottom:4px;color:#9db2ff;font:12px/1 system-ui,sans-serif');
    var resultsBody = styled('div', 'white-space:pre-wrap;word-break:break-word');
    results.appendChild(resultsHead);
    results.appendChild(resultsBody);

    popup.appendChild(row);
    popup.appendChild(inputRow);
    popup.appendChild(results);

    // \u2500\u2500 the fallback card, for results that arrive after the popup is gone \u2500\u2500
    var card = styled('div',
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:none;max-width:340px;max-height:42vh;' +
      'overflow:auto;padding:10px 30px 10px 12px;border-radius:10px;background:rgba(18,20,28,.96);' +
      'color:#e8eaf0;box-shadow:0 6px 20px rgba(0,0,0,.4);font:12.5px/1.6 system-ui,sans-serif;' +
      'white-space:pre-wrap;word-break:break-word');
    var cardTitle = styled('div', 'font-weight:600;margin-bottom:4px;color:#9db2ff;font:12.5px/1.4 system-ui,sans-serif');
    var cardBody = styled('div', '');
    var cardClose = styled('button',
      'all:unset;cursor:pointer;position:absolute;top:8px;right:9px;color:#8b93a7;font:14px/1 system-ui,sans-serif');
    cardClose.textContent = '\xD7';
    cardClose.addEventListener('click', function () { card.style.display = 'none'; });
    card.appendChild(cardTitle);
    card.appendChild(cardBody);
    card.appendChild(cardClose);

    // \u2500\u2500 one-line toast, for the failure paths only \u2500\u2500
    var toast = styled('div',
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'padding:6px 14px;border-radius:16px;background:rgba(18,20,28,.92);color:#e8eaf0;' +
      'font:12px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)');
    var toastTimer = null;

    root.appendChild(popup);
    root.appendChild(card);
    root.appendChild(toast);
    document.documentElement.appendChild(host);

    // \u2500\u2500 popup lifecycle \u2500\u2500
    function hidePopup() {
      popup.style.display = 'none';
      pinned = false;
    }
    function place() {
      var w = popup.offsetWidth || 340;
      var h = popup.offsetHeight || 130;
      var left = anchorRect ? Math.round(anchorRect.left) : 12;
      left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w - 8));
      var top = anchorRect ? Math.round(anchorRect.bottom + 6) : 12;
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 12);
      popup.style.left = Math.round(left) + 'px';
      popup.style.top = Math.round(top) + 'px';
    }
    function showPopup(text) {
      pinned = false;
      card.style.display = 'none';
      results.style.display = 'none';
      resultsBody.textContent = '';
      resultsHead.textContent = '';
      setQuote(text && text.trim() ? String(text) : null);
      question.value = '';
      // No autofocus: selecting-to-copy must keep working like on any page.
      popup.style.display = 'block';
      place();
    }
    // The popup grows when results arrive; re-clamp it inside the viewport.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        if (popup.style.display !== 'none') place();
      }).observe(popup);
    }

    function pin() { pinned = true; }
    function report(action, extra) {
      window.__piSelAction = {
        action: action,
        text: '',
        url: location.href,
        title: document.title,
        at: Date.now()
      };
      if (extra) {
        for (var k in extra) window.__piSelAction[k] = extra[k];
      }
    }
    function showResult(title, body) {
      resultsHead.textContent = title;
      resultsBody.textContent = body || '';
      results.style.display = 'block';
    }

    // \u2500\u2500 selection tracking \u2500\u2500
    function onMouseUp(e) {
      // Mouseups inside our own popup are interactions, not selections.
      if (e && e.composedPath && e.composedPath().indexOf(host) >= 0) return;
      setTimeout(function () {
        var s = document.getSelection();
        var text = String(s || '').trim();
        if (!text) {
          // A plain click elsewhere: dismiss only if nothing was started here.
          if (!pinned && popup.style.display !== 'none') hidePopup();
          return;
        }
        // Fresh selection \u2014 new popup, even over a pinned one.
        anchorRect = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
        showPopup(String(s));
      }, 0);
    }
    function onSelectionChange() {
      if (pinned) return;
      if (!String(document.getSelection() || '').trim() && popup.style.display !== 'none') hidePopup();
    }
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    // The popup must stay under its text: whenever the page moves under it \u2014
    // scroll, panel resize, fullscreen transitions, zoomFactor changes \u2014 the
    // anchor is re-derived from the live selection (which survives all of
    // those) and the popup is re-placed. Without this the popup hangs where
    // the layout used to put the text.
    function reanchor() {
      if (popup.style.display === 'none') return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) anchorRect = r;
      }
      if (anchorRect) place();
    }
    function onScroll() {
      if (popup.style.display === 'none') return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) { anchorRect = r; place(); return; }
      }
      // The text is gone (cleared selection): a pinned popup stays put \u2014 the
      // user pinned it on purpose; an unpinned one has no reason to exist.
      if (!pinned) hidePopup();
    }
    function onResize() {
      reanchor();
      // Fullscreen/maximize transitions animate; the final layout settles
      // after the resize event, so place once more when it has.
      setTimeout(reanchor, 250);
    }
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    // zoomFactor changes (auto-fit and manual zoom) relayout the page WITHOUT
    // firing a window resize \u2014 matchMedia sees the device pixel ratio move.
    var zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
    var onZoomMq = function () {
      zoomMq.removeEventListener('change', onZoomMq);
      reanchor();
      zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      zoomMq.addEventListener('change', onZoomMq);
    };
    zoomMq.addEventListener('change', onZoomMq);

    // \u2500\u2500 actions \u2500\u2500
    question.addEventListener('focus', pin);
    question.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hidePopup();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    btnClose.addEventListener('click', hidePopup);

    btnTranslate.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('\u7FFB\u8BD1', { text: quoteText.slice(0, 8000) });
      showResult('\u7FFB\u8BD1\u4E2D\u2026', '');
    });
    btnExplain.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('\u89E3\u91CA', { text: quoteText.slice(0, 8000) });
      showResult('\u89E3\u91CA\u4E2D\u2026', '');
    });
    btnClip.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('\u6536\u85CF', { text: quoteText.slice(0, 8000) });
      showResult('\u6536\u85CF', '\u2026');
    });

    function doSend() {
      var q = String(question.value || '').trim();
      if (!quoteText && !q) return;
      pin();
      // Question and quote travel separately: the backend composes the message.
      report('chat', { text: q, quote: quoteText ? quoteText.slice(0, 8000) : null });
      // The reply lands in the conversation \u2014 the popup is a launcher, not a chat.
      showResult('\u5DF2\u53D1\u9001 \u2192', '\u56DE\u7B54\u5728\u5BF9\u8BDD\u91CC,\u7EE7\u7EED\u8FFD\u95EE\u4E5F\u5728\u5BF9\u8BDD\u8FDB\u884C\u3002');
    }
    btnSend.addEventListener('click', doSend);

    // \u2500\u2500 the backend's handles into this UI \u2500\u2500
    window.__piNoteShow = function (payload) {
      if (!payload) return;
      var kind = payload.kind || '';
      var inPopup = popup.style.display !== 'none';
      var pendingText = '';
      if (payload.state === 'pending-hint') {
        pendingText = '\u8FD8\u6CA1\u56DE\u6765 \u2014 \u591A\u534A\u662F\u7B2C\u4E00\u6B21\u8C03\u7528\u5728\u7B49\u6388\u6743:\u53BB\u5BF9\u8BDD\u91CC\u70B9\u300C\u603B\u662F\u5141\u8BB8\u300D,\u672C\u6B21\u4F1A\u8BDD\u5C31\u4E0D\u518D\u95EE\u4E86\u3002';
      }
      if (payload.state === 'pending' || payload.state === 'pending-hint') {
        var head = kind === 'explain' ? '\u89E3\u91CA\u4E2D\u2026' : kind === 'chat' ? '\u601D\u8003\u4E2D\u2026' : '\u7FFB\u8BD1\u4E2D\u2026';
        if (inPopup) { showResult(head, pendingText); }
        else { cardTitle.textContent = head; cardBody.textContent = pendingText; card.style.display = 'block'; }
        return;
      }
      if (payload.state === 'timeout') {
        var tmsg = '\u7B49\u5F97\u6709\u70B9\u4E45\u4E86 \u2014 \u53BB\u5BF9\u8BDD\u91CC\u770B\u770B\u8FDB\u5EA6\u3002';
        if (inPopup) { showResult('\u8FD8\u5728\u7B49\u7ED3\u679C', tmsg); }
        else { cardTitle.textContent = '\u8FD8\u5728\u7B49\u7ED3\u679C'; cardBody.textContent = tmsg; card.style.display = 'block'; }
        return;
      }
      var title = payload.title || (kind === 'explain' ? '\u89E3\u91CA' : kind === 'translate' ? '\u8BD1\u6587' : kind === 'chat' ? '\u56DE\u7B54' : '\u7ED3\u679C');
      if (inPopup) { showResult(title, payload.text || ''); }
      else { cardTitle.textContent = title; cardBody.textContent = payload.text || ''; card.style.display = 'block'; }
    };
    window.__piRenderClips = function (clips, newestId) {
      resultsHead.textContent = '\u6536\u85CF\u7684\u6587\u5B57';
      resultsBody.textContent = '';
      var list = Array.isArray(clips) ? clips : [];
      for (var i = 0; i < list.length; i++) {
        (function (clip) {
          var item = styled('div',
            'position:relative;padding:6px 24px 6px 8px;border-radius:6px;margin-bottom:4px;' +
            'border-left:3px solid ' + (clip.id === newestId ? 'rgba(110,150,255,.95)' : 'rgba(255,255,255,.16)') + ';' +
            'background:rgba(255,255,255,.05)');
          var t = styled('div',
            'font:12.5px/1.5 system-ui,sans-serif;color:#e8eaf0;white-space:pre-wrap;word-break:break-word;' +
            'max-height:3.6em;overflow:hidden');
          t.textContent = clip.text && clip.text.length > 120 ? clip.text.slice(0, 120) + '\u2026' : (clip.text || '');
          var src = styled('div', 'font:11px/1 system-ui,sans-serif;color:#8b93a7;margin-top:3px');
          src.textContent = (clip.title || clip.url || '') + (clip.at ? ' \xB7 ' + whenLabel(clip.at) : '');
          var x = styled('button',
            'all:unset;cursor:pointer;position:absolute;top:6px;right:4px;color:#8b93a7;font:11px/1 system-ui,sans-serif;padding:2px 3px');
          x.textContent = '\xD7';
          x.addEventListener('click', function () {
            window.__piSelAction = { action: 'removeClip', id: clip.id, at: Date.now() };
          });
          item.appendChild(t);
          item.appendChild(src);
          item.appendChild(x);
          resultsBody.appendChild(item);
        })(list[i]);
      }
      if (!list.length) {
        var empty = styled('div', 'font:11px/1 system-ui,sans-serif;color:#8b93a7;padding:4px 0');
        empty.textContent = '\u8FD8\u6CA1\u6709\u6536\u85CF\u7684\u6587\u5B57';
        resultsBody.appendChild(empty);
      }
      results.style.display = 'block';
    };
    window.__piToast = function (msg) {
      toast.textContent = String(msg || '');
      toast.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.style.display = 'none'; }, 1800);
    };
    window.__piSelDisable = function () {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      zoomMq.removeEventListener('change', onZoomMq);
      if (host.parentNode) host.parentNode.removeChild(host);
      window.__piSelInstalled = false;
      window.__piSelAction = null;
    };

    window.__piSelInstalled = true;
    window.__piSelAction = null;
    return 'installed';
  } catch (e) {
    return 'failed: ' + (e && e.message ? e.message : String(e));
  }
})()`;
var SEL_POLL_EXPR = `window.__piSelAction
  ? (function () { var a = JSON.stringify(window.__piSelAction); window.__piSelAction = null; return a; })()
  : (window.__piSelInstalled ? '' : 'REINSTALL')`;
var mountedPanels = /* @__PURE__ */ new Set();
var PANEL_ID = "browser";
function panelTargets() {
  return /* @__PURE__ */ new Set([...mountedPanels, PANEL_ID]);
}
__name(panelTargets, "panelTargets");
var lastUrl = "";
var tabBuckets = /* @__PURE__ */ new Map();
var panelSession = null;
function bucketKey(sessionId) {
  return sessionId ?? panelSession ?? "default";
}
__name(bucketKey, "bucketKey");
function bucketFor(key) {
  let b = tabBuckets.get(key);
  if (!b) {
    b = { tabs: [], activeTabId: null, split: null, splitRatio: 0.5 };
    tabBuckets.set(key, b);
  }
  return b;
}
__name(bucketFor, "bucketFor");
function targetTabId(sessionKey, explicit) {
  if (typeof explicit === "string" && explicit) return explicit;
  return bucketFor(bucketKey(sessionKey)).activeTabId ?? void 0;
}
__name(targetTabId, "targetTabId");
async function ensureTab(ctx, sessionKey) {
  const key = bucketKey(sessionKey);
  await syncBucketFor(ctx, key);
  const b = bucketFor(key);
  if (b.activeTabId) {
    const t = b.tabs.find((x) => x.id === b.activeTabId);
    if (t && !t.evicted) return t;
  }
  const created = await ctx.call("browser.newTab", {
    sessionId: key
  });
  const tab = { id: String(created?.tabId ?? ""), url: created?.url ?? "", title: "" };
  b.tabs.push(tab);
  b.activeTabId = tab.id;
  return tab;
}
__name(ensureTab, "ensureTab");
async function syncBucketFor(ctx, key) {
  try {
    const tabs = await ctx.call("browser.tabList", { sessionId: key });
    const b = bucketFor(key);
    b.tabs = Array.isArray(tabs) ? tabs : [];
    const focused = b.tabs.find((t) => t.focused === true);
    if (focused && !focused.evicted) b.activeTabId = focused.id;
    else if (!b.tabs.some((t) => t.id === b.activeTabId && !t.evicted)) {
      const live = b.tabs.find((t) => !t.evicted);
      b.activeTabId = live?.id ?? null;
    }
    if (b.split && (!b.tabs.some((t) => t.id === b.split[0]) || !b.tabs.some((t) => t.id === b.split[1]))) {
      b.split = null;
      void ctx.call("browser.setSplitTabs", { sessionId: key, tabId: null }).catch(() => {
      });
    }
  } catch {
  }
  pushTabs(ctx);
}
__name(syncBucketFor, "syncBucketFor");
async function syncBucket(ctx) {
  const key = bucketKey();
  await syncBucketFor(ctx, key);
  const b = bucketFor(key);
  const active = b.tabs.find((t) => t.id === b.activeTabId);
  if (active?.url) {
    lastUrl = active.url;
    pushUrl(ctx, active.url, active.title);
  } else if (b.tabs.length === 0) {
    lastUrl = "";
    for (const panelId of panelTargets()) {
      ctx.send(panelId, "ui.urlChanged", { url: "", title: "", favorited: false, private: privateMode });
    }
  }
}
__name(syncBucket, "syncBucket");
function pushTabs(ctx) {
  const b = bucketFor(bucketKey());
  const data = { tabs: b.tabs, activeTabId: b.activeTabId ?? "", split: b.split, splitRatio: b.splitRatio };
  for (const panelId of panelTargets()) ctx.send(panelId, "ui.tabs", data);
}
__name(pushTabs, "pushTabs");
var history = [];
var favorites = [];
var recipes = [];
var clips = [];
var privateMode = false;
var selPopup = true;
var pollTimer = null;
var pollTicks = 0;
var injectTimer = null;
var pendingNote = null;
var lastRecordedKey = "";
var titleTimer = null;
var loaded = Promise.resolve();
function describe2(err) {
  return err instanceof Error ? err.message : String(err);
}
__name(describe2, "describe");
function actionResult(prefix, r, extra = "") {
  if (r.error) return `${prefix}\u5931\u8D25: ${r.error}`;
  return `${prefix}\u6210\u529F${r.effect ? ` \xB7 ${r.effect}` : ""}${extra}`;
}
__name(actionResult, "actionResult");
async function runActStep(step, ctx, tid, sessionKey) {
  const tabArg = tid ? { tabId: tid } : {};
  if (typeof step.click === "string") {
    const selector = step.click;
    const dialog = step.dialog === "accept" ? { dialog: "accept" } : {};
    const r = await ctx.call("browser.click", {
      selector,
      ...dialog,
      ...sessionKey ? { sessionId: sessionKey } : {},
      ...tabArg
    });
    if (r.error || !r.clicked) throw new Error(r.error ?? `\u70B9\u51FB "${selector}" \u5931\u8D25`);
    return `\u70B9\u51FB "${selector}"${r.effect ? ` \xB7 ${r.effect}` : ""}`;
  }
  if (step.fill && typeof step.fill === "object") {
    const f = step.fill;
    const selector = String(f.selector ?? "").trim();
    if (!selector) throw new Error("fill \u7F3A\u5C11 selector");
    const r = await ctx.call("browser.fill", {
      selector,
      value: String(f.value ?? ""),
      ...tabArg
    });
    if (r.error) throw new Error(r.error);
    return `\u586B\u5199 "${selector}" = ${String(f.value ?? "")}${r.effect ? ` \xB7 ${r.effect}` : ""}`;
  }
  if (step.select && typeof step.select === "object") {
    const s = step.select;
    const selector = String(s.selector ?? "").trim();
    if (!selector) throw new Error("select \u7F3A\u5C11 selector");
    const r = await ctx.call("browser.select", {
      selector,
      value: String(s.value ?? ""),
      ...tabArg
    });
    if (r.error || !r.selected) throw new Error(r.error ?? `\u5728 "${selector}" \u9009\u4E2D\u5931\u8D25`);
    return `\u5728 "${selector}" \u9009\u4E2D "${String(s.value ?? "")}"${r.effect ? ` \xB7 ${r.effect}` : ""}`;
  }
  if (step.upload && typeof step.upload === "object") {
    const u = step.upload;
    const selector = String(u.selector ?? "").trim();
    const files = Array.isArray(u.files) ? u.files.map(String) : [];
    if (!selector || files.length === 0) throw new Error("upload \u9700\u8981 selector \u548C files");
    const r = await ctx.call(
      "browser.upload",
      { selector, files, ...tabArg }
    );
    if (!r.attached) throw new Error(r.error ?? "\u4E0A\u4F20\u5931\u8D25");
    return `\u4E0A\u4F20 ${r.files.join("\u3001")} \u5230 "${selector}"${r.effect ? ` \xB7 ${r.effect}` : ""}`;
  }
  if (typeof step.hover === "string") {
    const r = await ctx.call("browser.hover", {
      selector: step.hover,
      ...tabArg
    });
    if (r.error || !r.hovered) throw new Error(r.error ?? `\u60AC\u505C "${step.hover}" \u5931\u8D25`);
    return `\u60AC\u505C "${step.hover}"`;
  }
  if (typeof step.wait === "number") {
    const ms = Math.min(Math.max(step.wait, 0), 5e3);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `\u7B49\u5F85 ${ms}ms`;
  }
  throw new Error("\u672A\u77E5\u6B65\u9AA4\uFF1A\u652F\u6301 click / fill / select / upload / hover / wait");
}
__name(runActStep, "runActStep");
function normalizeUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("missing url");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
__name(normalizeUrl, "normalizeUrl");
function urlKey(url) {
  return String(url).split("#")[0];
}
__name(urlKey, "urlKey");
function isRecordable(url) {
  return /^https?:\/\//i.test(url);
}
__name(isRecordable, "isRecordable");
function isFavorite(url) {
  const key = urlKey(url);
  return favorites.some((f) => urlKey(f.url) === key);
}
__name(isFavorite, "isFavorite");
function originOfUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
__name(originOfUrl, "originOfUrl");
function isFavoriteOrigin(origin) {
  return !!origin && favorites.some((f) => originOfUrl(f.url) === origin);
}
__name(isFavoriteOrigin, "isFavoriteOrigin");
function recipeSignature(steps) {
  return steps.map((s) => `${s.kind}:${s.target}`).join("|");
}
__name(recipeSignature, "recipeSignature");
function liveRecipes(origin) {
  return recipes.filter((r) => r.origin === origin && r.failures < 2);
}
__name(liveRecipes, "liveRecipes");
async function stabilizeTarget(ctx, tid, selector) {
  const expr = `(function(){
    var el = window.piResolveSelector(${JSON.stringify(selector)});
    if (!el) return '';
    var tag = el.tagName.toLowerCase();
    var id = el.getAttribute('id') || '';
    if (id && !/^(r\\d|vue-|__|react-|aria-|\\d+$|^[a-f0-9]{8}-)/i.test(id)) return '#' + id;
    var name = el.getAttribute('name') || '';
    if (name) return '[name="' + name + '"]';
    var ph = el.getAttribute('placeholder') || '';
    if (ph) return 'input[placeholder="' + ph + '"]';
    var label = el.getAttribute('aria-label') || '';
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (label) return tag === 'button' ? 'role=button[name="' + label + '"]' : 'text="' + label + '"';
    if (tag === 'button' && text && text.length <= 24) return 'role=button[name="' + text + '"]';
    if (text && text.length <= 24) return 'text="' + text + '"';
    return ${JSON.stringify(selector)};
  })()`;
  try {
    const r = await ctx.call("browser.evaluate", {
      expression: expr,
      ...tid ? { tabId: tid } : {}
    });
    const value = String(r?.result ?? "");
    return value || selector;
  } catch {
    return selector;
  }
}
__name(stabilizeTarget, "stabilizeTarget");
async function recordRecipe(ctx, rawSteps, effects, url, name, title, tid) {
  const origin = originOfUrl(url ?? "");
  if (!origin || !isFavoriteOrigin(origin)) return null;
  const steps = [];
  const valueMap = [];
  let params = 0;
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i] ?? {};
    const expect = effects[i] ? effects[i].split(" \xB7 ").slice(1).join(" \xB7 ") || void 0 : void 0;
    if (typeof step.click === "string") {
      steps.push({ kind: "click", target: await stabilizeTarget(ctx, tid, step.click), expect });
    } else if (step.fill && typeof step.fill === "object") {
      params += 1;
      const typed = String(step.fill.value ?? "");
      if (typed) valueMap.push({ token: `{{${params}}}`, value: typed });
      steps.push({
        kind: "fill",
        target: await stabilizeTarget(ctx, tid, String(step.fill.selector ?? "")),
        value: `{{${params}}}`,
        expect
      });
    } else if (step.select && typeof step.select === "object") {
      params += 1;
      const picked = String(step.select.value ?? "");
      if (picked) valueMap.push({ token: `{{${params}}}`, value: picked });
      steps.push({
        kind: "select",
        target: await stabilizeTarget(ctx, tid, String(step.select.selector ?? "")),
        value: `{{${params}}}`,
        expect
      });
    } else if (step.upload && typeof step.upload === "object") {
      steps.push({
        kind: "upload",
        target: await stabilizeTarget(ctx, tid, String(step.upload.selector ?? "")),
        expect
      });
    } else if (typeof step.hover === "string") {
      steps.push({ kind: "hover", target: await stabilizeTarget(ctx, tid, step.hover), expect });
    } else if (typeof step.wait === "number") {
      steps.push({ kind: "wait", target: String(step.wait), expect });
    }
  }
  if (steps.length === 0) return null;
  for (const st of steps) {
    if (st.kind === "fill" && st.value) {
      st.expect = `\u5DF2\u5199\u5165\uFF0C\u5F53\u524D\u503C\u300C${st.value}\u300D`;
    } else if (st.kind === "select" && st.value) {
      st.expect = `\u5DF2\u9009\u4E2D\u300C${st.value}\u300D`;
    } else if (st.expect) {
      for (const v of valueMap) {
        if (v.value.length >= 2) st.expect = st.expect.split(v.value).join(v.token);
      }
    }
  }
  const signature = recipeSignature(steps);
  const existing = recipes.find((r) => recipeSignature(r.steps) === signature);
  if (existing) {
    existing.steps = steps;
    existing.uses += 1;
    existing.lastOk = Date.now();
    existing.failures = 0;
    if (name) existing.name = name;
    await save(ctx, RECIPES_KEY, recipes, "recipes");
    return existing;
  }
  const recipe = {
    id: `r${Date.now().toString(36)}`,
    origin,
    name: (name ?? "").trim() || `${(title ?? "\u6B64\u7AD9\u64CD\u4F5C").slice(0, 24)}\uFF08${steps.length} \u6B65\uFF09`,
    params,
    steps,
    uses: 1,
    lastOk: Date.now(),
    failures: 0
  };
  recipes = [recipe, ...recipes].slice(0, 60);
  await save(ctx, RECIPES_KEY, recipes, "recipes");
  return recipe;
}
__name(recordRecipe, "recordRecipe");
function formatWhen(ts) {
  const d = new Date(ts);
  const now = /* @__PURE__ */ new Date();
  const sameDay = /* @__PURE__ */ __name((a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(), "sameDay");
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay(d, now)) return `\u4ECA\u5929 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `\u6628\u5929 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5 ${hm}`;
  return `${d.getFullYear()}\u5E74${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
}
__name(formatWhen, "formatWhen");
function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
__name(clampLimit, "clampLimit");
function matchesQuery(entry, tokens) {
  if (tokens.length === 0) return true;
  const hay = `${entry.title} ${entry.url}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
__name(matchesQuery, "matchesQuery");
function tokensOf(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
__name(tokensOf, "tokensOf");
async function readKey(ctx, key) {
  try {
    return await ctx.call("storage.get", { key });
  } catch {
    return void 0;
  }
}
__name(readKey, "readKey");
async function save(ctx, key, value, what) {
  try {
    await ctx.call("storage.set", { key, value });
  } catch (err) {
    ctx.log.warn(`could not persist ${what}: ${describe2(err)}`);
  }
}
__name(save, "save");
async function loadState(ctx) {
  const [h, f, c, s, r] = await Promise.all([
    readKey(ctx, HISTORY_KEY),
    readKey(ctx, FAVORITES_KEY),
    readKey(ctx, CLIPS_KEY),
    readKey(ctx, SETTINGS_KEY),
    readKey(ctx, RECIPES_KEY)
  ]);
  if (Array.isArray(h)) history = h;
  if (Array.isArray(f)) favorites = f;
  if (Array.isArray(r)) recipes = r;
  if (Array.isArray(c)) clips = c;
  const settings = s;
  privateMode = Boolean(settings?.private);
  selPopup = settings?.selPopup !== false;
}
__name(loadState, "loadState");
function recordVisit(url, title) {
  if (privateMode || !isRecordable(url)) return null;
  const key = urlKey(url);
  const known = history.find((e) => e.url === key);
  if (key === lastRecordedKey) {
    if (known && title && known.title !== title) {
      known.title = title;
      return known;
    }
    return null;
  }
  lastRecordedKey = key;
  const now = Date.now();
  if (known) {
    known.visits += 1;
    known.lastVisitedAt = now;
    if (title) known.title = title;
    history = [known, ...history.filter((e) => e !== known)];
    return known;
  }
  const entry = { url: key, title, visits: 1, lastVisitedAt: now };
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  return entry;
}
__name(recordVisit, "recordVisit");
function pushUrl(ctx, url, title) {
  lastUrl = url;
  const data = {
    url,
    title: title ?? history.find((e) => e.url === urlKey(url))?.title ?? "",
    favorited: isFavorite(url),
    private: privateMode
  };
  for (const panelId of panelTargets()) ctx.send(panelId, "ui.urlChanged", data);
}
__name(pushUrl, "pushUrl");
function broadcast(ctx, event, data) {
  for (const panelId of panelTargets()) ctx.send(panelId, event, data);
}
__name(broadcast, "broadcast");
function scheduleTitleRefresh(ctx, tabId) {
  if (titleTimer) clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    titleTimer = null;
    void refreshTitle(ctx, tabId);
  }, TITLE_REFRESH_MS);
}
__name(scheduleTitleRefresh, "scheduleTitleRefresh");
async function refreshTitle(ctx, tabId) {
  let state;
  try {
    state = await ctx.call(
      "browser.getUrl",
      tabId ? { tabId } : {}
    );
  } catch {
    return;
  }
  const url = String(state?.url ?? "");
  const title = String(state?.title ?? "");
  if (!url || !title) return;
  for (const b of tabBuckets.values()) {
    const row = b.tabs.find((t) => t.id === tabId);
    if (row) row.title = title;
  }
  const entry = history.find((e) => e.url === urlKey(url));
  if (entry && entry.title !== title) {
    entry.title = title;
    void save(ctx, HISTORY_KEY, history, "history");
  }
  if (urlKey(url) === urlKey(lastUrl)) pushUrl(ctx, url, title);
}
__name(refreshTitle, "refreshTitle");
function searchOmnibox(query) {
  const tokens = tokensOf(query);
  const favHits = favorites.filter((f) => matchesQuery(f, tokens));
  const histHits = history.filter((e) => matchesQuery(e, tokens));
  const histLimit = tokens.length === 0 ? OMNIBOX_RECENT : OMNIBOX_LIMIT;
  return {
    favorites: favHits.slice(0, OMNIBOX_LIMIT),
    history: histHits.slice(0, histLimit)
  };
}
__name(searchOmnibox, "searchOmnibox");
async function injectOnce(ctx) {
  if (!isRecordable(lastUrl)) return false;
  try {
    const r = await ctx.call(
      "browser.evaluate",
      { expression: INJECT_SOURCE },
      { timeoutMs: 5e3 }
    );
    return r?.result === "installed" || r?.result === "already";
  } catch {
    return false;
  }
}
__name(injectOnce, "injectOnce");
function scheduleInject(ctx) {
  if (!selPopup) return;
  if (injectTimer) clearTimeout(injectTimer);
  let attempt = 0;
  const tryNext = /* @__PURE__ */ __name(() => {
    if (attempt >= INJECT_ATTEMPTS_MS.length) return;
    const delay = INJECT_ATTEMPTS_MS[attempt++];
    injectTimer = setTimeout(() => {
      injectTimer = null;
      void injectOnce(ctx).then((ok) => {
        if (!ok) tryNext();
      });
    }, delay);
  }, "tryNext");
  tryNext();
}
__name(scheduleInject, "scheduleInject");
async function callInjected(ctx, call) {
  if (!isRecordable(lastUrl)) return void 0;
  try {
    const r = await ctx.call("browser.evaluate", { expression: call }, { timeoutMs: 5e3 });
    return r?.result;
  } catch {
    return void 0;
  }
}
__name(callInjected, "callInjected");
async function showNoteInPage(ctx, payload) {
  const r = await callInjected(ctx, `window.__piNoteShow ? (window.__piNoteShow(${JSON.stringify(payload)}), true) : false`);
  return r === true;
}
__name(showNoteInPage, "showNoteInPage");
async function toastInPage(ctx, message) {
  await callInjected(ctx, `window.__piToast ? (window.__piToast(${JSON.stringify(message)}), true) : false`);
}
__name(toastInPage, "toastInPage");
async function pollTick(ctx) {
  if (!selPopup || !isRecordable(lastUrl)) return;
  let raw;
  try {
    const r = await ctx.call(
      "browser.evaluate",
      { expression: SEL_POLL_EXPR },
      { timeoutMs: 5e3 }
    );
    raw = r?.result;
  } catch {
    return;
  }
  if (raw === "REINSTALL") {
    void injectOnce(ctx);
    return;
  }
  if (raw) {
    try {
      await handleAction(ctx, JSON.parse(raw));
    } catch (err) {
      ctx.log.warn(`selection action failed: ${describe2(err)}`);
    }
  }
  if (pendingNote) {
    const age = Date.now() - pendingNote.at;
    if (age > NOTE_TIMEOUT_MS) {
      const kind = pendingNote.kind;
      pendingNote = null;
      void showNoteInPage(ctx, { state: "timeout", kind });
    } else if (age > PENDING_HINT_MS && !pendingNote.hinted) {
      pendingNote.hinted = true;
      void showNoteInPage(ctx, { state: "pending-hint", kind: pendingNote.kind });
    }
  }
}
__name(pollTick, "pollTick");
var probeFailures = 0;
function syncPoll(ctx) {
  const shouldRun = selPopup && mountedPanels.size > 0;
  if (shouldRun && !pollTimer) {
    pollTimer = setInterval(() => void pollTick(ctx), SEL_POLL_MS);
    pollTicks = 0;
  } else if (!shouldRun && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (pollTimer && ++pollTicks % Math.round(8e3 / SEL_POLL_MS) === 0) {
    void (async () => {
      for (const panelId of panelTargets()) {
        if (await ctx.panelAlive(panelId, 1e3)) {
          probeFailures = 0;
          return;
        }
      }
      probeFailures += 1;
      if (probeFailures >= 2) {
        probeFailures = 0;
        mountedPanels.clear();
        syncPoll(ctx);
      }
    })();
  }
}
__name(syncPoll, "syncPoll");
function agentTaskPrompt(kind, text, url) {
  if (kind === "\u7FFB\u8BD1") {
    return `\u628A\u4E0B\u9762\u7684\u7F51\u9875\u5185\u5BB9\u7FFB\u8BD1\u6210\u4E2D\u6587\u3002\u8BD1\u6587\u4E0D\u8981\u5199\u5728\u56DE\u590D\u91CC \u2014 \u8C03\u7528 browser_show \u5DE5\u5177\u5C55\u793A\u7ED9\u7528\u6237 (kind \u586B "translate",text \u586B\u5B8C\u6574\u8BD1\u6587,\u4E0D\u8981\u7701\u7565\u6216\u6982\u62EC)\u3002\u539F\u6587:

${text}

(\u6765\u81EA ${url})`;
  }
  return `\u5411\u7528\u6237\u89E3\u91CA\u4E0B\u9762\u7684\u7F51\u9875\u5185\u5BB9:\u5B83\u8BB2\u7684\u662F\u4EC0\u4E48\u3001\u5173\u952E\u70B9\u662F\u4EC0\u4E48\u3002\u89E3\u91CA\u4E5F\u8C03\u7528 browser_show \u5DE5\u5177\u5C55\u793A (kind \u586B "explain")\u3002\u5185\u5BB9:

${text}

(\u6765\u81EA ${url})`;
}
__name(agentTaskPrompt, "agentTaskPrompt");
var CLIPS_RENDER_MAX = 10;
async function renderClipsInPage(ctx, newestId) {
  await callInjected(
    ctx,
    `window.__piRenderClips ? (window.__piRenderClips(${JSON.stringify(clips.slice(0, CLIPS_RENDER_MAX))}, ${JSON.stringify(
      newestId
    )}), true) : false`
  );
}
__name(renderClipsInPage, "renderClipsInPage");
async function handleAction(ctx, action) {
  const text = String(action.text ?? "").trim().slice(0, SELECTION_MAX_CHARS);
  const url = String(action.url ?? lastUrl ?? "");
  switch (action.action) {
    case "\u7FFB\u8BD1":
    case "\u89E3\u91CA": {
      if (!text) return;
      const kind = action.action;
      const kindKey = kind === "\u7FFB\u8BD1" ? "translate" : "explain";
      pendingNote = { kind: kindKey, at: Date.now() };
      await showNoteInPage(ctx, { state: "pending", kind: kindKey });
      try {
        await ctx.call("chat.send", { text: agentTaskPrompt(kind, text, url) });
      } catch (err) {
        pendingNote = null;
        ctx.log.warn(`chat.send failed: ${describe2(err)}`);
        void showNoteInPage(ctx, {
          state: "done",
          kind: kindKey,
          title: "\u53D1\u9001\u5931\u8D25",
          text: `\u6CA1\u80FD\u628A\u5185\u5BB9\u53D1\u8FDB\u5BF9\u8BDD: ${describe2(err)}`
        });
      }
      return;
    }
    case "chat": {
      const question = text;
      const quote = String(action.quote ?? "").trim().slice(0, SELECTION_MAX_CHARS);
      const parts = [];
      if (question) parts.push(question);
      if (quote) parts.push(`\u300C\u5F15\u7528\u300D${quote}`);
      if (parts.length === 0) return;
      parts.push(`(\u6765\u81EA\u7F51\u9875: ${url})`);
      parts.push(
        '(\u8FD9\u6761\u6D88\u606F\u6765\u81EA\u5212\u8BCD\u5F39\u6846:\u56DE\u7B54\u65F6\u8BF7\u8C03\u7528 browser_show \u5DE5\u5177\u628A\u7B80\u660E\u56DE\u7B54\u5C55\u793A\u5230\u5F39\u6846 \u2014 kind \u586B "chat"\u3001title \u586B "\u56DE\u7B54",\u4E00\u4E24\u53E5\u8BDD\u8BF4\u6E05\u5373\u53EF\u3002\u5BF9\u8BDD\u91CC\u6B63\u5E38\u5B8C\u6574\u4F5C\u7B54,\u4E24\u8005\u5185\u5BB9\u4E0D\u8981\u4E92\u76F8\u91CD\u590D\u3002)'
      );
      try {
        await ctx.call("chat.send", { text: parts.join("\n\n") });
      } catch (err) {
        ctx.log.warn(`chat.send failed: ${describe2(err)}`);
        void toastInPage(ctx, "\u53D1\u9001\u5230\u5BF9\u8BDD\u5931\u8D25");
      }
      return;
    }
    case "\u6536\u85CF": {
      if (!text) return;
      const clip = {
        id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`,
        text: text.slice(0, CLIP_MAX_CHARS),
        url,
        title: String(action.title ?? ""),
        at: Date.now()
      };
      clips = [clip, ...clips].slice(0, CLIPS_MAX);
      await save(ctx, CLIPS_KEY, clips, "clips");
      await renderClipsInPage(ctx, clip.id);
      return;
    }
    case "removeClip": {
      const id = String(action.id ?? "");
      if (!id) return;
      clips = clips.filter((c) => c.id !== id);
      await save(ctx, CLIPS_KEY, clips, "clips");
      await renderClipsInPage(ctx, null);
      return;
    }
    default:
      ctx.log.warn(`unknown selection action: ${action.action}`);
  }
}
__name(handleAction, "handleAction");
async function setSelPopup(ctx, on) {
  selPopup = on;
  if (!on) {
    if (injectTimer) clearTimeout(injectTimer);
    await callInjected(ctx, "window.__piSelDisable ? (window.__piSelDisable(), true) : false");
  } else {
    scheduleInject(ctx);
  }
  syncPoll(ctx);
}
__name(setSelPopup, "setSelPopup");
plugin({
  async onInit(ctx) {
    loaded = loadState(ctx);
    try {
      const state = await ctx.call("browser.getUrl");
      if (state?.url) lastUrl = state.url;
    } catch {
    }
  },
  async onPanelMounted(panelId, _params, ctx, meta) {
    mountedPanels.add(panelId);
    panelSession = meta?.sessionId ?? panelSession;
    await loaded;
    syncPoll(ctx);
    await syncBucket(ctx);
    scheduleInject(ctx);
    const key = bucketKey();
    const tabId = targetTabId(key);
    if (tabId) {
      try {
        const state = await ctx.call("browser.getUrl", { tabId });
        if (state?.url) {
          pushUrl(ctx, state.url, state.title);
        } else if (lastUrl) {
          pushUrl(ctx, lastUrl);
        }
      } catch {
        if (lastUrl) pushUrl(ctx, lastUrl);
      }
    }
  },
  async onRequest(panelId, method, params, ctx) {
    await loaded;
    const key = bucketKey();
    switch (method) {
      case "nav.open": {
        const t = await ensureTab(ctx, key);
        const result = await ctx.call(
          "browser.navigate",
          { url: normalizeUrl(params.url), tabId: t.id },
          { timeoutMs: NAVIGATE_TIMEOUT_MS }
        );
        if (result?.url) lastUrl = result.url;
        const row = bucketFor(key).tabs.find((x) => x.id === t.id);
        if (row && result?.url) row.url = result.url;
        pushTabs(ctx);
        return { url: result?.url ?? "", title: result?.title ?? "" };
      }
      case "nav.back": {
        const t = targetTabId(key);
        if (t) await ctx.call("browser.back", { tabId: t });
        return { ok: true };
      }
      case "nav.forward": {
        const t = targetTabId(key);
        if (t) await ctx.call("browser.forward", { tabId: t });
        return { ok: true };
      }
      case "nav.reload": {
        const t = targetTabId(key);
        if (t) await ctx.call("browser.reload", { tabId: t });
        return { ok: true };
      }
      // ── Tab strip ──
      case "tabs.new": {
        const created = await ctx.call("browser.newTab", { sessionId: key });
        const tab = { id: String(created?.tabId ?? ""), url: "", title: "" };
        const b = bucketFor(key);
        b.tabs.push(tab);
        b.activeTabId = tab.id;
        if (params.url) {
          const result = await ctx.call(
            "browser.navigate",
            { url: normalizeUrl(params.url), tabId: tab.id },
            { timeoutMs: NAVIGATE_TIMEOUT_MS }
          );
          tab.url = result?.url ?? "";
        }
        await syncBucket(ctx);
        return { tabId: tab.id };
      }
      case "tabs.activate": {
        const tabId = String(params.tabId ?? "");
        if (!tabId) throw new Error("tabs.activate: missing tabId");
        await ctx.call("browser.activateTab", { sessionId: key, tabId });
        await syncBucket(ctx);
        return { ok: true };
      }
      case "tabs.close": {
        const tabId = String(params.tabId ?? "");
        if (!tabId) throw new Error("tabs.close: missing tabId");
        await ctx.call("browser.closeTab", { tabId });
        const b = bucketFor(key);
        b.tabs = b.tabs.filter((t) => t.id !== tabId);
        if (b.activeTabId === tabId) {
          b.activeTabId = b.tabs.find((t) => !t.evicted)?.id ?? null;
        }
        if (b.split && (b.split[0] === tabId || b.split[1] === tabId)) {
          b.split = null;
          await ctx.call("browser.setSplitTabs", { sessionId: key, tabId: null }).catch(() => {
          });
        }
        pushTabs(ctx);
        const active = b.tabs.find((t) => t.id === b.activeTabId);
        if (active?.url) {
          lastUrl = active.url;
          pushUrl(ctx, active.url, active.title);
        }
        return { ok: true };
      }
      // Pure strip-order change: no focus, no view moves. The HOST registry is
      // the truth for order — the mirror re-pulls so agent tool listings agree
      // with what the strip shows.
      case "tabs.reorder": {
        const tabId = String(params.tabId ?? "");
        if (!tabId) throw new Error("tabs.reorder: missing tabId");
        await ctx.call("browser.reorderTab", {
          sessionId: key,
          tabId,
          beforeTabId: params.beforeTabId ? String(params.beforeTabId) : null
        });
        await syncBucket(ctx);
        return { ok: true };
      }
      case "split.set": {
        const b = bucketFor(key);
        const raw = params.tabs;
        if (!Array.isArray(raw) || raw.length !== 2) {
          b.split = null;
          await ctx.call("browser.setSplitTabs", { sessionId: key, tabId: null }).catch(() => {
          });
          pushTabs(ctx);
          return { ok: true, split: null };
        }
        const left = String(raw[0] ?? "");
        const right = String(raw[1] ?? "");
        if (!left || !right || left === right) throw new Error("split.set: need two distinct tab ids");
        if (!b.tabs.some((t) => t.id === left) || !b.tabs.some((t) => t.id === right)) {
          throw new Error("split.set: unknown tab id");
        }
        b.split = [left, right];
        if (typeof params.ratio === "number" && Number.isFinite(params.ratio)) {
          b.splitRatio = Math.min(0.8, Math.max(0.2, params.ratio));
        }
        b.activeTabId = left;
        await ctx.call("browser.activateTab", { sessionId: key, tabId: left });
        await ctx.call("browser.setSplitTabs", { sessionId: key, tabId: right });
        pushTabs(ctx);
        return { ok: true, split: b.split };
      }
      // The panes' width share — the draggable gutter writes here. Pure view
      // state, but per conversation like the rest of the bucket.
      case "split.ratio": {
        const b = bucketFor(key);
        const ratio = Number(params.ratio ?? 0.5);
        b.splitRatio = Math.min(0.8, Math.max(0.2, Number.isFinite(ratio) ? ratio : 0.5));
        pushTabs(ctx);
        return { ok: true, splitRatio: b.splitRatio };
      }
      case "state.get": {
        const stateTab = targetTabId(key);
        const state = await ctx.call(
          "browser.getUrl",
          stateTab ? { tabId: stateTab } : {}
        );
        if (state?.url) lastUrl = state.url;
        const b = bucketFor(key);
        return {
          url: state?.url ?? "",
          title: state?.title ?? "",
          favorited: isFavorite(state?.url ?? ""),
          private: privateMode,
          selPopup,
          clips: clips.length,
          tabs: b.tabs,
          activeTabId: b.activeTabId ?? "",
          split: b.split,
          splitRatio: b.splitRatio
        };
      }
      // ── Omnibox ──
      case "omnibox.search": {
        const found = searchOmnibox(String(params.query ?? "").trim());
        return { favorites: found.favorites, history: found.history };
      }
      case "recipes.list": {
        return { recipes };
      }
      case "recipes.delete": {
        const id = String(params.id ?? "");
        const before = recipes.length;
        recipes = recipes.filter((r) => r.id !== id);
        if (recipes.length === before) return { ok: false };
        await save(ctx, RECIPES_KEY, recipes, "recipes");
        broadcast(ctx, "ui.recipesChanged", { recipes });
        return { ok: true };
      }
      case "favorites.toggle": {
        const url = urlKey(String(params.url ?? lastUrl ?? "").trim());
        if (!url) throw new Error("no page to favorite yet");
        const existing = favorites.find((f) => urlKey(f.url) === url);
        let favorited;
        if (existing) {
          favorites = favorites.filter((f) => f !== existing);
          favorited = false;
        } else {
          favorites.unshift({
            url,
            title: String(params.title ?? "").trim() || history.find((e) => e.url === url)?.title || "",
            addedAt: Date.now()
          });
          favorited = true;
        }
        await save(ctx, FAVORITES_KEY, favorites, "favorites");
        broadcast(ctx, "ui.favoritesChanged", { favorites });
        if (url === urlKey(lastUrl)) pushUrl(ctx, lastUrl);
        return { favorited, url };
      }
      case "favorites.remove": {
        const url = urlKey(String(params.url ?? "").trim());
        if (!url) throw new Error("missing url");
        favorites = favorites.filter((f) => urlKey(f.url) !== url);
        await save(ctx, FAVORITES_KEY, favorites, "favorites");
        broadcast(ctx, "ui.favoritesChanged", { favorites });
        if (url === urlKey(lastUrl)) pushUrl(ctx, lastUrl);
        return { ok: true };
      }
      case "history.clear":
        history = [];
        lastRecordedKey = urlKey(lastUrl);
        await save(ctx, HISTORY_KEY, history, "history");
        broadcast(ctx, "ui.historyCleared");
        return { ok: true };
      case "settings.setPrivate": {
        privateMode = params.private === true;
        await save(ctx, SETTINGS_KEY, { private: privateMode, selPopup }, "settings");
        broadcast(ctx, "ui.settingsChanged", { private: privateMode, selPopup });
        return { private: privateMode };
      }
      case "settings.setSelPopup": {
        await setSelPopup(ctx, params.on === true);
        await save(ctx, SETTINGS_KEY, { private: privateMode, selPopup }, "settings");
        broadcast(ctx, "ui.settingsChanged", { private: privateMode, selPopup });
        return { selPopup };
      }
      default:
        throw new Error(
          `unknown panel method: ${method} (known: nav.open, nav.back, nav.forward, nav.reload, state.get, omnibox.search, favorites.toggle, favorites.remove, history.clear, settings.setPrivate, settings.setSelPopup, tabs.new, tabs.activate, tabs.close, tabs.reorder, split.set)`
        );
    }
  },
  async onHostEvent(event, data, ctx) {
    const d = data ?? {};
    if (event === "session.changed") {
      panelSession = d.sessionId ?? null;
      await loaded;
      await syncBucket(ctx);
      return;
    }
    if (event === "browser.tabOpened") {
      await loaded;
      const tabId2 = String(d.tabId ?? "");
      if (!tabId2) return;
      const key = bucketKey(d.sessionId);
      const b = bucketFor(key);
      if (!b.tabs.some((t) => t.id === tabId2)) {
        b.tabs.push({ id: tabId2, url: String(d.url ?? ""), title: "" });
      }
      pushTabs(ctx);
      return;
    }
    if (event !== "browser.urlChanged") return;
    await loaded;
    const tabId = String(d.tabId ?? "");
    const url = String(d.url ?? "");
    if (!url) return;
    if (recordVisit(url, "")) void save(ctx, HISTORY_KEY, history, "history");
    for (const b of tabBuckets.values()) {
      const row = b.tabs.find((t) => t.id === tabId);
      if (row) {
        row.url = url;
        break;
      }
    }
    const visible = bucketFor(bucketKey());
    if (tabId && visible.activeTabId && tabId !== visible.activeTabId) {
      pushTabs(ctx);
      return;
    }
    lastUrl = url;
    pushUrl(ctx, url);
    scheduleTitleRefresh(ctx, tabId || void 0);
    scheduleInject(ctx);
  },
  async onTool(name, params, ctx, call) {
    const sessionKey = call?.sessionId ?? null;
    const tid = targetTabId(sessionKey, params.tab);
    const reveal = name === "browser_navigate" || name === "browser_walk" || name === "browser_screenshot" || name === "browser_show" || name === "browser_tab_open" || name === "browser_tab_switch";
    void ctx.openPanel("browser", { focus: reveal }).catch(() => {
    });
    switch (name) {
      case "browser_navigate": {
        const url = normalizeUrl(params.url);
        const tab = tid ? { id: tid } : await ensureTab(ctx, bucketKey(sessionKey));
        const result = await ctx.call("browser.navigate", { url, tabId: tab.id }, { timeoutMs: NAVIGATE_TIMEOUT_MS });
        const finalUrl = result?.url ?? url;
        const row = bucketFor(bucketKey(sessionKey)).tabs.find((t) => t.id === tab.id);
        if (row) row.url = finalUrl;
        pushTabs(ctx);
        const head = `\u5DF2\u6253\u5F00 ${finalUrl}${result?.title ? ` \u2014 ${result.title}` : ""}`;
        if (result?.page?.authKind === "captcha") {
          return `${head}

\u26A0\uFE0F \u8FD9\u4E2A\u9875\u9762\u9700\u8981\u4EBA\u5DE5\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1\u3002\u8BF7\u5728\u53F3\u4FA7\u6D4F\u89C8\u5668\u9762\u677F\u91CC\u7531\u7528\u6237\u5B8C\u6210\uFF1B\u4E0D\u8981\u5C1D\u8BD5\u70B9\u51FB\u6216\u7ED5\u8FC7\u3002\u7528\u6237\u5B8C\u6210\u540E\u518D\u7EE7\u7EED\u3002`;
        }
        if (result?.page?.authKind === "login") {
          return `${head}

\u26A0\uFE0F \u8FD9\u662F\u4E00\u4E2A\u767B\u5F55\u9875\u3002\u767B\u5F55\u5FC5\u987B\u7531\u7528\u6237\u5B8C\u6210\uFF08\u8D26\u53F7\u5BC6\u7801\u3001\u77ED\u4FE1\u9A8C\u8BC1\u7801\u3001\u626B\u7801\u90FD\u4E0D\u662F agent \u8BE5\u505A\u7684\uFF09\u3002\u8BF7\u5728\u53F3\u4FA7\u9762\u677F\u91CC\u7531\u7528\u6237\u767B\u5F55\uFF0C\u5B8C\u6210\u540E\u518D\u7EE7\u7EED\u3002`;
        }
        const site = liveRecipes(originOfUrl(finalUrl));
        if (site.length === 0) return head;
        return `${head}

\u672C\u7AD9\u6709 ${site.length} \u4E2A\u5DF2\u8BB0\u5F55\u7684\u5FEB\u6377\u64CD\u4F5C\uFF1A${site.map((r) => `${r.name}\uFF08${r.steps.length} \u6B65\uFF09`).join("\u3001")}\u3002\u7528 browser_recipes \u67E5\u770B\u6B65\u9AA4\uFF0C\u518D\u6309 browser_act \u6267\u884C\uFF1B\u67D0\u4E00\u6B65\u7684\u9884\u671F\u5BF9\u4E0D\u4E0A\u5C31\u505C\u4E0B\u81EA\u5DF1\u64CD\u4F5C\u3002`;
      }
      case "browser_tab_list": {
        const b = bucketFor(bucketKey(sessionKey));
        if (b.tabs.length === 0) return "\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u6807\u7B7E\u9875\u3002";
        return b.tabs.map((t, i) => {
          const mark = t.id === b.activeTabId ? " \u2192" : "";
          const state = t.evicted ? " (\u5DF2\u56DE\u6536,\u518D\u6B21\u6253\u5F00\u4F1A\u91CD\u65B0\u52A0\u8F7D)" : "";
          return `${i + 1}. [${t.id}]${mark} ${t.title || t.url || "(\u65B0\u6807\u7B7E\u9875)"}${state}`;
        }).join("\n");
      }
      case "browser_tab_open": {
        const url = params.url ? normalizeUrl(params.url) : void 0;
        const created = await ctx.call("browser.newTab", {
          sessionId: bucketKey(sessionKey),
          url,
          activate: params.activate !== false
        });
        const tab = {
          id: String(created?.tabId ?? ""),
          url: created?.url ?? url ?? "",
          title: ""
        };
        const b = bucketFor(bucketKey(sessionKey));
        b.tabs.push(tab);
        b.activeTabId = tab.id;
        pushTabs(ctx);
        return `\u5DF2\u65B0\u5EFA\u6807\u7B7E\u9875 [${tab.id}]${tab.url ? ` \u2014 ${tab.url}` : ""}`;
      }
      case "browser_tab_switch": {
        const tabId = String(params.tabId ?? "").trim();
        if (!tabId) throw new Error("browser_tab_switch: missing tabId");
        await ctx.call("browser.activateTab", { sessionId: bucketKey(sessionKey), tabId });
        const b = bucketFor(bucketKey(sessionKey));
        b.activeTabId = tabId;
        pushTabs(ctx);
        const row = b.tabs.find((t) => t.id === tabId);
        return `\u5DF2\u5207\u6362\u5230\u6807\u7B7E\u9875 [${tabId}]${row?.title ? ` \u2014 ${row.title}` : ""}`;
      }
      case "browser_tab_close": {
        const tabId = String(params.tabId ?? "").trim();
        if (!tabId) throw new Error("browser_tab_close: missing tabId");
        await ctx.call("browser.closeTab", { tabId });
        const b = bucketFor(bucketKey(sessionKey));
        b.tabs = b.tabs.filter((t) => t.id !== tabId);
        if (b.activeTabId === tabId) {
          b.activeTabId = b.tabs.find((t) => !t.evicted)?.id ?? null;
        }
        pushTabs(ctx);
        return `\u5DF2\u5173\u95ED\u6807\u7B7E\u9875 [${tabId}]`;
      }
      case "browser_get_state": {
        const state = await ctx.call("browser.getState", tid ? { tabId: tid } : {});
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
        const matches = await ctx.call("browser.find", { query, ...tid ? { tabId: tid } : {} });
        if (matches.length === 0) return `\u9875\u9762\u4E0A\u6CA1\u6709\u5339\u914D "${query}" \u7684\u5143\u7D20`;
        return matches.map((m) => `[${m.role}] "${m.text}" (${m.section}, \u5339\u914D\u5EA6 ${m.score})`).join("\n");
      }
      case "browser_act": {
        const rawSteps = Array.isArray(params.steps) ? params.steps : [];
        if (rawSteps.length === 0) throw new Error("steps \u4E0D\u80FD\u4E3A\u7A7A");
        const steps = rawSteps.slice(0, 12);
        const log = [];
        const effects = [];
        let failedAt = -1;
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i] && typeof steps[i] === "object" ? steps[i] : {};
          try {
            const line = await runActStep(step, ctx, tid, sessionKey);
            effects.push(line);
            log.push(`${i + 1}. ${line}`);
          } catch (err) {
            failedAt = i;
            log.push(`${i + 1}. \u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
        const state = await ctx.call(
          "browser.getState",
          tid ? { tabId: tid } : {}
        );
        const recipeName = params.recipe ? String(params.recipe).trim() : "";
        if (recipeName) {
          const currentOrigin = originOfUrl(state?.url ?? "");
          const known = recipes.find(
            (r) => r.name === recipeName && (!currentOrigin || r.origin === currentOrigin)
          );
          const kindOf = /* @__PURE__ */ __name((st) => typeof st.click === "string" ? "click" : st.fill ? "fill" : st.select ? "select" : st.upload ? "upload" : typeof st.hover === "string" ? "hover" : "wait", "kindOf");
          const sameShape = !!known && steps.length === known.steps.length && steps.every((st, i) => kindOf(st ?? {}) === known.steps[i].kind);
          if (known && sameShape) {
            if (failedAt < 0) {
              known.uses += 1;
              known.lastOk = Date.now();
              known.failures = 0;
            } else {
              known.failures += 1;
            }
            await save(ctx, RECIPES_KEY, recipes, "recipes");
          }
        }
        if (failedAt < 0) {
          await recordRecipe(
            ctx,
            steps,
            effects,
            state?.url,
            params.name ? String(params.name) : void 0,
            state?.title,
            tid
          );
        }
        const head = failedAt < 0 ? `\u5DF2\u5B8C\u6210 ${steps.length} \u6B65` : `\u7B2C ${failedAt + 1} \u6B65\u5931\u8D25\uFF0C\u4E4B\u540E ${steps.length - failedAt - 1} \u6B65\u6CA1\u6709\u6267\u884C`;
        const lines = [
          head,
          ...log,
          "",
          `\u5F53\u524D\u9875\u9762: ${state?.url ?? "(about:blank)"}${state?.title ? ` \u2014 ${state.title}` : ""}`
        ];
        if (state?.snapshot) {
          const snap = state.snapshot.length > SNAPSHOT_MAX_CHARS ? `${state.snapshot.slice(0, SNAPSHOT_MAX_CHARS)}
\u2026(\u5FEB\u7167\u5DF2\u622A\u65AD,\u8981\u627E\u5177\u4F53\u5143\u7D20\u7528 browser_find)` : state.snapshot;
          lines.push("", "\u53EF\u4EA4\u4E92\u5143\u7D20:", snap);
        }
        return lines.join("\n");
      }
      case "browser_click": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.click", {
          selector,
          ...params.dialog === "accept" ? { dialog: "accept" } : {},
          ...sessionKey ? { sessionId: sessionKey } : {},
          ...tid ? { tabId: tid } : {}
        });
        return actionResult(`\u70B9\u51FB "${selector}"`, r);
      }
      case "browser_upload": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const files = Array.isArray(params.files) ? params.files.map(String) : [];
        if (!files.length) throw new Error("missing files");
        const r = await ctx.call(
          "browser.upload",
          { selector, files, ...tid ? { tabId: tid } : {} }
        );
        if (!r.attached) throw new Error(r.error ?? "\u4E0A\u4F20\u5931\u8D25");
        return `\u5DF2\u628A ${r.files.join("\u3001")} \u4EA4\u7ED9 "${selector}"\uFF08${r.via === "input" ? "\u76F4\u63A5\u5199\u5165\u6587\u4EF6\u6846" : "\u62E6\u622A\u6587\u4EF6\u9009\u62E9\u6846"}\uFF09${r.effect ? ` \xB7 ${r.effect}` : ""}`;
      }
      case "browser_fill": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.fill", {
          selector,
          value: String(params.value ?? ""),
          ...tid ? { tabId: tid } : {}
        });
        return actionResult(`\u586B\u5199 "${selector}"`, r);
      }
      case "browser_hover": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.hover", {
          selector,
          ...tid ? { tabId: tid } : {}
        });
        return actionResult(`\u60AC\u505C "${selector}"`, r);
      }
      case "browser_select": {
        const selector = String(params.selector ?? "").trim();
        if (!selector) throw new Error("missing selector");
        const r = await ctx.call("browser.select", {
          selector,
          value: String(params.value ?? ""),
          ...tid ? { tabId: tid } : {}
        });
        return actionResult(`\u5728 "${selector}" \u9009\u4E2D "${params.value}"`, r);
      }
      case "browser_scroll": {
        const r = await ctx.call("browser.scroll", {
          direction: params.direction,
          amount: params.amount,
          ...tid ? { tabId: tid } : {}
        });
        return `\u5DF2${r.direction === "up" ? "\u5411\u4E0A" : "\u5411\u4E0B"}\u6EDA\u52A8 ${r.amount}px`;
      }
      case "browser_evaluate": {
        const expression = String(params.expression ?? "");
        if (!expression.trim()) throw new Error("missing expression");
        const r = await ctx.call("browser.evaluate", {
          expression,
          ...tid ? { tabId: tid } : {}
        });
        return typeof r.result === "string" ? r.result : JSON.stringify(r.result);
      }
      case "browser_walk": {
        const goal = String(params.goal ?? "").trim();
        if (!goal) throw new Error("missing goal");
        const r = await ctx.call(
          "browser.walk",
          { goal, maxSteps: params.maxSteps, ...tid ? { tabId: tid } : {} },
          { timeoutMs: NAVIGATE_TIMEOUT_MS }
        );
        const stepLines = r.steps.map((s, i) => `${i + 1}. \u70B9\u51FB "${s.text}"${s.ok === false ? " \u2717" : ""}`);
        const head = r.reached ? `\u5DF2\u5230\u8FBE\u76EE\u6807 "${goal}"` : `\u672A\u80FD\u5230\u8FBE\u76EE\u6807 "${goal}"`;
        return [head, `\u5F53\u524D: ${r.url ?? "?"}`, ...stepLines].join("\n");
      }
      case "browser_screenshot": {
        const shot = await ctx.call("browser.screenshot", {
          fullPage: params.fullPage === true,
          ...tid ? { tabId: tid } : {}
        });
        if (!shot?.base64) throw new Error("screenshot failed: the host returned no image data");
        const kb = Math.round(shot.base64.length * 3 / 4 / 1024);
        const mimeType = shot.mimeType ?? "image/png";
        return {
          content: [
            { type: "text", text: `\u622A\u56FE\u5B8C\u6210 (${kb} KB ${mimeType === "image/jpeg" ? "JPEG" : "PNG"})` },
            { type: "image", data: shot.base64, mimeType }
          ]
        };
      }
      // ── Where have we been, what did the user keep ──
      case "browser_history_search": {
        const query = String(params.query ?? "").trim();
        const limit = clampLimit(params.limit, HISTORY_TOOL_LIMIT, 100);
        const tokens = tokensOf(query);
        const rows = history.filter((e) => matchesQuery(e, tokens)).slice(0, limit);
        if (rows.length === 0) {
          return query ? `\u5386\u53F2\u8BB0\u5F55\u91CC\u6CA1\u6709\u5339\u914D "${query}" \u7684\u9875\u9762(\u5171 ${history.length} \u6761)` : "\u5386\u53F2\u8BB0\u5F55\u662F\u7A7A\u7684\u2014\u2014\u8FD8\u6CA1\u6709\u6253\u5F00\u8FC7\u4EFB\u4F55\u7F51\u9875\u3002";
        }
        return rows.map(
          (e, i) => `${i + 1}. ${e.title || "(\u65E0\u6807\u9898)"}
   ${e.url} \xB7 ${formatWhen(e.lastVisitedAt)} \xB7 \u8BBF\u95EE ${e.visits} \u6B21`
        ).join("\n");
      }
      case "browser_recipes": {
        const origin = params.origin ? originOfUrl(normalizeUrl(String(params.origin))) : "";
        const site = origin ? recipes.filter((r) => r.origin === origin) : recipes;
        if (site.length === 0) {
          return "\u8FD8\u6CA1\u6709\u8BB0\u5F55\u4EFB\u4F55\u5FEB\u6377\u64CD\u4F5C\u3002\u6536\u85CF\u4E00\u4E2A\u7AD9\u70B9\u5E76\u5728\u4E0A\u9762\u6210\u529F\u6267\u884C\u4E00\u6B21 browser_act \u540E\u4F1A\u81EA\u52A8\u8BB0\u5F55\u3002";
        }
        return site.map((r) => {
          const stale = r.failures >= 2 ? " [\u5DF2\u5931\u6548]" : "";
          return [
            `${r.name}\uFF08${r.origin}\uFF0C${r.steps.length} \u6B65\uFF0C\u7528\u8FC7 ${r.uses} \u6B21\uFF0C\u4E0A\u6B21\u6210\u529F ${formatWhen(r.lastOk)}\uFF09${stale}`,
            ...r.steps.map(
              (st, i) => `  ${i + 1}. ${st.kind} ${st.target}${st.value ? ` = ${st.value}` : ""}${st.expect ? ` \uFF5C\u9884\u671F\uFF1A${st.expect}` : ""}`
            )
          ].join("\n");
        }).join("\n\n") + "\n\n\u6309 browser_act \u7684\u683C\u5F0F\u6267\u884C\uFF0C\u628A {{n}} \u6362\u6210\u8FD9\u6B21\u7684\u5B9E\u9645\u503C\uFF1B\u67D0\u4E00\u6B65\u7684\u9884\u671F\u5BF9\u4E0D\u4E0A\u5C31\u7ACB\u523B\u505C\u4E0B\u3001\u81EA\u5DF1\u91CD\u65B0\u64CD\u4F5C\u3002";
      }
      case "browser_recipe_delete": {
        const name2 = String(params.name ?? "").trim();
        const id = String(params.id ?? "").trim();
        if (!name2 && !id) throw new Error("\u9700\u8981 name \u6216 id");
        const target = recipes.find((r) => id && r.id === id || name2 && r.name === name2);
        if (!target) throw new Error(`\u6CA1\u6709\u627E\u5230\u914D\u65B9\uFF1A${id || name2}`);
        recipes = recipes.filter((r) => r !== target);
        await save(ctx, RECIPES_KEY, recipes, "recipes");
        broadcast(ctx, "ui.recipesChanged", { recipes });
        return `\u5DF2\u5220\u9664\u914D\u65B9\u300C${target.name}\u300D\uFF08${target.origin}\uFF09`;
      }
      case "browser_favorites_list": {
        if (favorites.length === 0) {
          return "\u7528\u6237\u8FD8\u6CA1\u6709\u6536\u85CF\u4EFB\u4F55\u7F51\u7AD9(\u6D4F\u89C8\u5668\u9762\u677F\u5730\u5740\u680F\u5DE6\u8FB9\u7684\u661F\u6807\u6309\u94AE\u53EF\u4EE5\u6536\u85CF)\u3002";
        }
        return favorites.map((f, i) => `${i + 1}. ${f.title || "(\u65E0\u6807\u9898)"}
   ${f.url}`).join("\n");
      }
      /**
       * The only way a result reaches the user's selection popup. The user
       * asked for this to be shown there, so the popup is the primary target;
       * the conversation keeps the tool call either way.
       */
      case "browser_show": {
        const text = String(params.text ?? "").trim();
        if (!text) throw new Error("missing text");
        const title = String(params.title ?? "").trim();
        const kind = String(params.kind ?? "").trim();
        pendingNote = null;
        const shown = await showNoteInPage(ctx, { state: "done", kind, title, text });
        void ctx.setBadge("browser", shown ? null : "\u2022");
        if (shown) return "\u5DF2\u5C55\u793A\u5728\u6D4F\u89C8\u5668\u9875\u9762\u7684\u5F39\u6846\u91CC\u3002";
        return "\u5F53\u524D\u7F51\u9875\u5DF2\u79BB\u5F00,\u6CA1\u80FD\u5F39\u51FA\u6765\u2014\u2014\u5185\u5BB9\u5DF2\u4FDD\u7559\u5728\u672C\u6B21\u5DE5\u5177\u7ED3\u679C\u91CC,\u9762\u677F\u89D2\u6807\u505A\u4E86\u6807\u8BB0\u3002";
      }
      case "browser_clips_list": {
        const query = String(params.query ?? "").trim();
        const tokens = tokensOf(query);
        const rows = clips.filter((c) => matchesQuery({ url: c.url, title: `${c.title} ${c.text}` }, tokens)).slice(0, HISTORY_TOOL_LIMIT);
        if (rows.length === 0) {
          return query ? `\u6536\u85CF\u7684\u6587\u5B57\u91CC\u6CA1\u6709\u5339\u914D "${query}" \u7684\u5185\u5BB9(\u5171 ${clips.length} \u6761)` : "\u7528\u6237\u8FD8\u6CA1\u6709\u6536\u85CF\u8FC7\u7F51\u9875\u6587\u5B57(\u5728\u7F51\u9875\u91CC\u9009\u4E2D\u6587\u5B57,\u70B9\u5F39\u51FA\u7684\u300C\u6536\u85CF\u300D\u5373\u53EF)\u3002";
        }
        return rows.map((c, i) => {
          const body = c.text.length > 120 ? `${c.text.slice(0, 120)}\u2026` : c.text;
          return `${i + 1}. ${body}
   \u2014 \u6765\u81EA ${c.title || c.url}(${formatWhen(c.at)})`;
        }).join("\n\n");
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
});
