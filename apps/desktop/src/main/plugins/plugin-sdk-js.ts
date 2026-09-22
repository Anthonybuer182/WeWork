/**
 * Source of the SDK script injected into plugin panels.
 *
 * Served at `pi-plugin://<pluginId>/__pi_sdk.js` with the plugin id
 * substituted into `__PI_PLUGIN_ID__`. Provides `window.piSDK`:
 *
 *   piSDK.pluginId
 *   piSDK.request(method, params) → Promise<result>   (backend round-trip)
 *   piSDK.emit(event, data)                           (fire-and-forget)
 *   piSDK.onMessage(cb)                               (backend → UI events)
 *
 * TWO CONTAINERS, ONE SDK. A panel may be hosted either as an iframe inside the
 * shell renderer (the web build, and panels on hosts without native views) or
 * as a top-level `WebContentsView`. The difference matters here:
 *
 *   - In an iframe, `window.parent` is the shell — the natural transport.
 *   - In a view, `window.parent` IS this window. Posting to it would loop the
 *     message straight back, so the transport is the preload bridge
 *     (`window.__piViewBridge`, see apps/desktop/src/preload/plugin-view.ts).
 *
 * Rather than making every plugin aware of that, this script installs a
 * `window.parent` stand-in inside a view whose `postMessage` forwards over the
 * bridge. Every first-party plugin sends with
 * `window.parent.postMessage({__piPlugin:true, direction:'ui', payload}, '*')`
 * verbatim, so they keep working with no changes at all.
 */
export const PI_SDK_FILENAME = '__pi_sdk.js';

export function buildPluginSdkJs(pluginId: string): string {
  return PLUGIN_SDK_SOURCE.replaceAll('__PI_PLUGIN_ID__', pluginId);
}

/**
 * The SDK source is a String.raw template literal. A backtick or a
 * dollar-brace sequence anywhere inside it — including inside a comment —
 * terminates the template early and fails the build with a confusing
 * "Expected ; but found ..." pointing at an innocent-looking line.
 * Describe code references in plain words down there.
 */
const PLUGIN_SDK_SOURCE = String.raw`
(function () {
  'use strict';

  var PLUGIN_ID = '__PI_PLUGIN_ID__';
  var seq = 0;
  var pending = new Map();
  var handlers = [];

  // ── Transport ──────────────────────────────────────────────────────
  // Set by the plugin-view preload when this panel is a native view.
  var VIEW = window.__piViewBridge || null;
  var IN_VIEW = !!VIEW;

  /** Backend traffic: requests and events. */
  function postToHost(payload) {
    if (IN_VIEW) { VIEW.send(payload); return; }
    window.parent.postMessage({
      __piPlugin: true,
      pluginId: PLUGIN_ID,
      direction: 'ui',
      payload: payload
    }, '*');
  }

  /** Host traffic (selection, resize). Not backend-related. */
  function postToShell(direction, payload) {
    var frame = {
      __piPlugin: true,
      pluginId: PLUGIN_ID,
      direction: direction,
      payload: payload
    };
    if (IN_VIEW) { VIEW.sendHostFrame(frame); return; }
    window.parent.postMessage(frame, '*');
  }

  function applyThemeTokens(tokens) {
    try {
      for (var k in tokens) {
        if (Object.prototype.hasOwnProperty.call(tokens, k)) {
          document.documentElement.style.setProperty(k, tokens[k]);
        }
      }
    } catch (e) { /* best-effort */ }
  }

  /** Backend → UI. Reaches here over a window message (iframe) or the port (view). */
  function handleBackendMessage(payload) {
    if (!payload) return;

    if (payload.kind === 'response') {
      var entry = pending.get(payload.id);
      if (entry) {
        pending.delete(payload.id);
        if (payload.error) entry.reject(new Error(payload.error));
        else entry.resolve(payload.result);
      }
      return;
    }

    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](payload); } catch (e) { console.error('[pi-sdk] handler error:', e); }
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__piPlugin !== true) return;
    if (data.direction === 'theme' && data.payload && data.payload.tokens) {
      applyThemeTokens(data.payload.tokens);
      return;
    }
    if (data.pluginId !== PLUGIN_ID || data.direction !== 'backend') return;
    handleBackendMessage(data.payload);
  });

  if (IN_VIEW) {
    // Re-dispatch with the envelope an iframe parent would have sent.
    //
    // Every first-party plugin listens on window for the frame
    // {__piPlugin:true, direction:'backend', payload} rather than calling
    // piSDK.onMessage — in a view nothing posts to the window, so without this
    // re-wrap their handlers never fire and panels stay empty. The SDK's own
    // window listener handles the re-dispatched frame and does not post again,
    // so this cannot loop.
    VIEW.onMessage(function (payload) {
      window.postMessage({
        __piPlugin: true,
        pluginId: PLUGIN_ID,
        direction: 'backend',
        payload: payload
      }, '*');
    });
    VIEW.onTheme(function (tokens) { applyThemeTokens(tokens); });

    // Present a window.parent that behaves like an iframe parent, so plugin
    // code that posts to it directly keeps working. The property is an own,
    // configurable accessor on Window in a top-level frame (verified), so this
    // redefine succeeds; if a future Chromium makes it non-configurable the
    // catch leaves piSDK as the only transport, which is still functional.
    try {
      var parentShim = {
        postMessage: function (frame) {
          if (!frame || frame.__piPlugin !== true) return;
          if (frame.direction === 'ui') VIEW.send(frame.payload);
          else if (frame.direction === 'contextmenu') return; // handled below
          else VIEW.sendHostFrame(frame);
        }
      };
      Object.defineProperty(window, 'parent', { configurable: true, get: function () { return parentShim; } });
    } catch (e) { /* keep piSDK as the transport */ }
  }

  // ── Public surface ─────────────────────────────────────────────────
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'ui-' + (++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      postToHost({ kind: 'request', id: id, method: method, params: params || {} });
    });
  }

  function emit(event, data) {
    postToHost({ kind: 'event', id: 'ev-' + (++seq), event: event, data: data });
  }

  window.piSDK = {
    pluginId: PLUGIN_ID,
    request: request,
    emit: emit,
    onMessage: function (cb) {
      if (handlers.indexOf(cb) < 0) handlers.push(cb);
    }
  };

  // ── Content-height reporting (autoHeight panels only) ──────────────
  // A native view fills the rectangle the host gives it, so there is nothing
  // to report: the panel cannot change its own height.
  if (!IN_VIEW) {
    (function () {
      var lastHeight = -1;
      var report = function () {
        // Viewport-independent measurement: the root element's scrollHeight is
        // pinned to the iframe viewport, so a grown panel could never shrink
        // back. Measure the root's layout box instead, plus body metrics.
        var rootBox = document.documentElement.getBoundingClientRect().height || 0;
        var h = Math.ceil(Math.max(
          document.body.scrollHeight,
          document.body.offsetHeight || 0,
          rootBox
        ));
        if (h > 0 && Math.abs(h - lastHeight) >= 2) {
          lastHeight = h;
          postToShell('resize', { height: h });
        }
      };
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function () { setTimeout(report, 30); });
        ro.observe(document.documentElement);
        ro.observe(document.body);
      }
      window.addEventListener('load', function () { setTimeout(report, 100); });
      setTimeout(report, 300);
    })();
  }

  // ── Context menu ───────────────────────────────────────────────────
  // A native view can pop main's menu directly; an iframe has to ask the shell.
  document.addEventListener('contextmenu', function (event) {
    try {
      if (IN_VIEW) {
        VIEW.showContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }
      postToShell('contextmenu', { x: event.clientX, y: event.clientY });
    } catch (e) { /* best-effort */ }
  });

  // ── Selection reporting (滑词) ──────────────────────────────────────
  // The host shows its selection menu with the plugin's contributed actions.
  document.addEventListener('mouseup', function (event) {
    try {
      var sel = window.getSelection && window.getSelection();
      var text = sel ? String(sel) : '';
      if (!text || !text.trim()) return;
      postToShell('selection', {
        pluginId: PLUGIN_ID, text: text, x: event.clientX, y: event.clientY
      });
    } catch (e) { /* best-effort */ }
  });
})();
`;
