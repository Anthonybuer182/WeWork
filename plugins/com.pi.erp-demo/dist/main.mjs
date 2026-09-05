/**
 * com.pi.erp-demo backend — ERP connector demo: orders panel + agent tools
 * (erp_query_orders / erp_fetch_live).
 *
 * Orders are a local fixture; erp_fetch_live demonstrates connector egress
 * through the network.fetch capability (host-pattern gated: localhost).
 */

const state = { uiPort: null, dataDir: '' };
let seq = 0;
const pending = new Map();

const post = (msg) => process.parentPort.postMessage(msg);
const log = (level, message) => post({ type: 'log', level, message });

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = 'c' + (++seq);
    pending.set(id, { resolve, reject });
    post({ type: 'call', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`capability timeout: ${method}`));
    }, 30_000);
  });
}

const uiPost = (payload) => {
  try { state.uiPort?.postMessage(payload); } catch { /* port closed */ }
};

// ── Fixture + state ──
const STATUS_LABELS = { pending: '待付款', paid: '已付款', shipped: '已发货', done: '已完成' };
const LABEL_TO_STATUS = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, v]) => [v, k]));

const FIXTURE_ORDERS = [
  { no: 'SO-2026-1001', customer: '华辰科技', amount: 12800, status: 'paid' },
  { no: 'SO-2026-1002', customer: '岭南制造', amount: 46500, status: 'pending' },
  { no: 'SO-2026-1003', customer: '启明贸易', amount: 8900, status: 'shipped' },
  { no: 'SO-2026-1004', customer: '华辰科技', amount: 23100, status: 'done' },
  { no: 'SO-2026-1005', customer: '蓝海电商', amount: 6700, status: 'pending' },
  { no: 'SO-2026-1006', customer: '南山精密', amount: 51200, status: 'paid' },
];

let orders = FIXTURE_ORDERS;
let filter = { keyword: '', status: '' };

function filtered() {
  const kw = filter.keyword.trim().toLowerCase();
  return orders.filter((o) => {
    if (filter.status && o.status !== filter.status) return false;
    if (kw && !o.customer.toLowerCase().includes(kw) && !o.no.toLowerCase().includes(kw)) return false;
    return true;
  });
}

const render = () =>
  uiPost({
    kind: 'event',
    event: 'ui.render',
    panelId: 'orders',
    data: { orders: filtered(), filter, statusLabel: STATUS_LABELS },
  });

async function load() {
  const [savedOrders, savedFilter] = await Promise.all([
    call('storage.get', { key: 'orders' }).catch(() => undefined),
    call('storage.get', { key: 'filter' }).catch(() => undefined),
  ]);
  orders = Array.isArray(savedOrders) && savedOrders.length ? savedOrders : FIXTURE_ORDERS;
  filter = savedFilter && typeof savedFilter === 'object' ? savedFilter : { keyword: '', status: '' };
}

async function save() {
  await Promise.all([
    call('storage.set', { key: 'orders', value: orders }).catch(() => {}),
    call('storage.set', { key: 'filter', value: filter }).catch(() => {}),
  ]);
  render();
}

// ── Agent tools ──
async function onTool(msg) {
  const { id, name, params } = msg;
  const p = params ?? {};
  const text = (t) => post({ type: 'tool-result', id, content: [{ type: 'text', text: t }] });

  switch (name) {
    case 'erp_query_orders': {
      filter = { keyword: String(p.keyword ?? ''), status: String(p.status ?? '') };
      await save();
      const rows = filtered();
      if (rows.length === 0) return text('没有符合条件的订单。');
      return text(
        `订单(${rows.length}):\n${rows
          .map((o) => `· ${o.no} | ${o.customer} | ¥${o.amount} | ${STATUS_LABELS[o.status] ?? o.status}`)
          .join('\n')}`,
      );
    }
    case 'erp_fetch_live': {
      if (!p.url) throw new Error('missing url');
      const res = await call('network.fetch', { url: String(p.url), method: 'GET' });
      return text(`HTTP ${res?.status}\n${String(res?.body ?? '').slice(0, 4000)}`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── Panel events ──
async function onUiEvent(eventId, data) {
  switch (eventId) {
    case 'erp-keyword':
      filter = { ...filter, keyword: String(data ?? '') };
      break;
    case 'erp-status': {
      const status = LABEL_TO_STATUS[String(data?.label ?? '')] ?? '';
      filter = { ...filter, status };
      break;
    }
  }
  await save();
}

// ── Message pump ──
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'init':
      load()
        .then(render)
        .catch((e) => log('error', `load failed: ${e.message}`));
      break;
    case 'call-result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
      break;
    }
    case 'tool-call':
      onTool(msg).catch((e) =>
        post({ type: 'tool-result', id: msg.id, error: e instanceof Error ? e.message : String(e) }));
      break;
    case 'ui-port': {
      const port = event.ports?.[0];
      if (!port) break;
      state.uiPort = port;
      port.on('message', (ev) => {
        const p = ev.data;
        if (p?.kind !== 'event') return;
        if (p.event === 'panel.mounted' && p.panelId === 'orders') {
          render();
        } else if (p.event === 'ui.event' && p.panelId === 'orders') {
          onUiEvent(p.data?.eventId, p.data?.data).catch(() => {});
        }
      });
      if (typeof port.start === 'function') port.start();
      break;
    }
  }
});

post({ type: 'ready' });
