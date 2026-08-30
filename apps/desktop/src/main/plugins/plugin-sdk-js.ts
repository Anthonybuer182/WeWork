/**
 * Source of the SDK script injected into plugin iframe panels.
 *
 * Served at `pi-plugin://<pluginId>/__pi_sdk.js` with the plugin id
 * substituted into `__PI_PLUGIN_ID__`. Provides `window.piSDK`:
 *
 *   piSDK.pluginId
 *   piSDK.request(method, params) → Promise<result>   (backend round-trip)
 *   piSDK.emit(event, data)                           (fire-and-forget)
 *   piSDK.onMessage(cb)                               (backend → UI events)
 */

export const PI_SDK_FILENAME = '__pi_sdk.js';

export function buildPluginSdkJs(pluginId: string): string {
  return PLUGIN_SDK_SOURCE.replaceAll('__PI_PLUGIN_ID__', pluginId);
}

const PLUGIN_SDK_SOURCE = String.raw`
(function () {
  'use strict';

  var PLUGIN_ID = '__PI_PLUGIN_ID__';
  var seq = 0;
  var pending = new Map();
  var handlers = [];

  function postToHost(payload) {
    window.parent.postMessage({
      __piPlugin: true,
      pluginId: PLUGIN_ID,
      direction: 'ui',
      payload: payload
    }, '*');
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.__piPlugin !== true) return;
    if (data.direction === 'theme' && data.payload && data.payload.tokens) {
      // Host theme tokens → match the panel to the shell.
      try {
        var tokens = data.payload.tokens;
        for (var k in tokens) {
          if (Object.prototype.hasOwnProperty.call(tokens, k)) {
            document.documentElement.style.setProperty(k, tokens[k]);
          }
        }
      } catch (e) { /* best-effort */ }
      return;
    }
    if (data.pluginId !== PLUGIN_ID || data.direction !== 'backend') return;
    var payload = data.payload;
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
  });

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

  // Selection reporting (滑词) — the host shows its selection menu with
  // the plugin's contributed actions.
  document.addEventListener('mouseup', function (event) {
    try {
      var sel = window.getSelection && window.getSelection();
      var text = sel ? String(sel) : '';
      if (!text || !text.trim()) return;
      window.parent.postMessage({
        __piPlugin: true,
        pluginId: PLUGIN_ID,
        direction: 'selection',
        payload: { pluginId: PLUGIN_ID, text: text, x: event.clientX, y: event.clientY }
      }, '*');
    } catch (e) { /* best-effort */ }
  });
})();
`;
