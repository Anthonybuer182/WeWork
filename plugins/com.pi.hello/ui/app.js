/* Hello plugin panel logic — uses window.piSDK injected by the host. */
(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  var pingOut = document.getElementById('pingOut');
  var capOut = document.getElementById('capOut');
  var noteInput = document.getElementById('noteInput');

  function show(el, data) {
    el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  }

  function fail(err) {
    return '错误: ' + (err && err.message ? err.message : String(err));
  }

  if (!window.piSDK) {
    statusEl.textContent = 'piSDK 未注入(直接打开文件时无宿主)';
    document.getElementById('tagSdk').textContent = 'piSDK ✗';
    return;
  }

  document.getElementById('tagSdk').textContent = 'piSDK ✓';
  document.getElementById('tagOrigin').textContent = location.origin;
  statusEl.innerHTML = '已连接宿主 · 插件 <span class="ok">' + window.piSDK.pluginId + '</span>';

  // 1 · Data plane round-trip
  document.getElementById('ping').addEventListener('click', function () {
    pingOut.textContent = '请求中…';
    window.piSDK
      .request('ping')
      .then(function (result) { show(pingOut, result); })
      .catch(function (err) { pingOut.textContent = fail(err); });
  });

  // 2 · Capability demos (backend forwards to host.* APIs)
  document.getElementById('save').addEventListener('click', function () {
    var value = noteInput.value || '(空)';
    window.piSDK
      .request('remember', { value: value })
      .then(function (result) {
        capOut.textContent = '已存储: ' + value + '\n' + JSON.stringify(result);
      })
      .catch(function (err) { capOut.textContent = fail(err); });
  });

  document.getElementById('recall').addEventListener('click', function () {
    window.piSDK
      .request('recall')
      .then(function (result) { show(capOut, result); })
      .catch(function (err) { capOut.textContent = fail(err); });
  });

  document.getElementById('notify').addEventListener('click', function () {
    window.piSDK
      .request('notify', { body: '来自 hello 插件的面板通知 ' + new Date().toLocaleTimeString() })
      .then(function (result) { show(capOut, result); })
      .catch(function (err) { capOut.textContent = fail(err); });
  });

  // Backend → UI event channel demo
  window.piSDK.onMessage(function (payload) {
    if (payload && payload.kind === 'event' && payload.event === 'backend-event') {
      statusEl.textContent = 'backend 事件: ' + JSON.stringify(payload.data);
    }
  });
})();
