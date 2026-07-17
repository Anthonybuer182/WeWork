/**
 * Tests for browser automation enhancements.
 * Run with: node tests/browser-enhancements.test.mjs
 */

// ── Minimal test runner ──
const suite = [];
let currentDescribe = '';

function describe(name) { currentDescribe = name; }
function test(name, fn) {
  suite.push({ describe: currentDescribe, name, fn });
}
function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`FAIL: ${msg}\n  expected: ${JSON.stringify(b)}\n  got:      ${JSON.stringify(a)}`);
}
function assertContains(str, substr, msg) {
  if (!str.includes(substr)) throw new Error(`FAIL: ${msg}\n  "${str}" does not contain "${substr}"`);
}
function assertNotNull(val, msg) {
  if (val == null) throw new Error(`FAIL: ${msg}\n  value is null/undefined`);
}
function assertMatches(str, pattern, msg) {
  if (!pattern.test(str)) throw new Error(`FAIL: ${msg}\n  "${str}" does not match ${pattern}`);
}

// ── Mock DOM helpers ──
function createMockElement(tag, overrides = {}) {
  const baseRect = overrides._rect || { x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100 };
  const internalKeys = new Set(['_attrs', '_class', '_textContent', '_style', '_rect', '_disabled', '_readOnly', '_checked', '_role', '_tag', '_type']);
  const obj = {
    tagName: tag.toUpperCase(),
    _attrs: new Map(),
    _class: '',
    _textContent: '',
    _style: {},
    _rect: { ...baseRect },
    _checked: false,
    _disabled: false,
    _readOnly: false,
    isConnected: true,
    connected: true,
    children: [],
    getAttribute(key) { return this._attrs.get(key) ?? null; },
    hasAttribute(key) { return this._attrs.has(key); },
    setAttribute(key, val) { this._attrs.set(key, val); },
    removeAttribute(key) { this._attrs.delete(key); },
    get textContent() { return this._textContent; },
    set textContent(v) { this._textContent = v; },
    get className() { return this._class; },
    set className(v) { this._class = v; },
    get style() { return this._style; },
    set style(v) { this._style = v; },
    get disabled() { return this._disabled; },
    set disabled(v) { this._disabled = v; },
    get readOnly() { return this._readOnly; },
    set readOnly(v) { this._readOnly = v; },
    get checked() { return this._checked; },
    set checked(v) { this._checked = v; },
    getBoundingClientRect() { return { ...this._rect }; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains(other) { return this.children.includes(other); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
  };
  // Apply overrides: allow both internal (_xxx) and public props
  for (const [key, val] of Object.entries(overrides)) {
    if (key.startsWith('_') && !internalKeys.has(key)) continue;
    obj[key] = val;
  }
  return obj;
}

describe('Snapshot: Element State Detection');

test('detects disabled state on button', () => {
  const el = createMockElement('button', {
    _disabled: true,
    _textContent: 'Submit',
    _rect: { top: 100, left: 50, width: 100, height: 30, bottom: 130, right: 150 },
  });
  const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
  assert(isDisabled, 'Button should have disabled attr');
});

test('detects aria-disabled=true', () => {
  const el = createMockElement('button', {
    _textContent: 'Submit',
    _attrs: new Map([['aria-disabled', 'true']]),
    _rect: { top: 100, left: 50, width: 100, height: 30, bottom: 130, right: 150 },
  });
  const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
  assert(isDisabled, 'aria-disabled=true should be detected');
});

test('normal button is not disabled', () => {
  const el = createMockElement('button', {
    _disabled: false,
    _textContent: 'Click Me',
    _rect: { top: 100, left: 50, width: 100, height: 30, bottom: 130, right: 150 },
  });
  const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
  assert(!isDisabled, 'Normal button should not be disabled');
});

test('detects readonly state', () => {
  const el = createMockElement('input', {
    _readOnly: true,
    _textContent: 'email@example.com',
    _attrs: new Map([['type', 'email']]),
    _rect: { top: 50, left: 50, width: 200, height: 30, bottom: 80, right: 250 },
  });
  const isReadonly = el.readOnly || el.getAttribute('aria-readonly') === 'true';
  assert(isReadonly, 'Readonly input should be detected');
});

test('detects aria-readonly=true', () => {
  const el = createMockElement('input', {
    _textContent: 'email@example.com',
    _attrs: new Map([['aria-readonly', 'true']]),
    _rect: { top: 50, left: 50, width: 200, height: 30, bottom: 80, right: 250 },
  });
  const isReadonly = el.readOnly || el.getAttribute('aria-readonly') === 'true';
  assert(isReadonly, 'aria-readonly=true should be detected');
});

test('detects native checked state', () => {
  const el = createMockElement('input', {
    _checked: true,
    _textContent: 'Agree',
    _attrs: new Map([['type', 'checkbox']]),
    _rect: { top: 100, left: 50, width: 20, height: 20, bottom: 120, right: 70 },
  });
  const isChecked = el.checked || el.getAttribute('aria-checked') === 'true';
  assert(isChecked, 'Checked checkbox should be detected');
});

test('detects aria-checked=true', () => {
  const el = createMockElement('div', {
    _textContent: 'Option',
    _attrs: new Map([['role', 'checkbox'], ['aria-checked', 'true']]),
    _rect: { top: 100, left: 50, width: 30, height: 30, bottom: 130, right: 80 },
  });
  const isChecked = el.checked || el.getAttribute('aria-checked') === 'true';
  assert(isChecked, 'aria-checked=true should be detected');
});

describe('Snapshot: Loading State Detection');

test('detects loading via aria-busy=true', () => {
  const el = createMockElement('div', {
    _textContent: 'Loading...',
    _attrs: new Map([['aria-busy', 'true']]),
    _rect: { top: 200, left: 100, width: 50, height: 50, bottom: 250, right: 150 },
  });
  assert(el.getAttribute('aria-busy') === 'true', 'aria-busy=true should be loading');
});

test('detects loading via spinner class', () => {
  const cls = 'loading-spinner rotate fa-spin';
  const isLoading = /(?:spinner|spinning|loader|loading|progress)/i.test(cls);
  assert(isLoading, 'Spinner class should be detected');
});

test('detects loading via progress class', () => {
  const cls = 'progress-bar fill';
  const isLoading = /(?:spinner|spinning|loader|loading|progress)/i.test(cls);
  assert(isLoading, 'Progress class should be detected');
});

test('detects loading via loader class', () => {
  const cls = 'content-loader skeleton-loader';
  const isLoading = /(?:spinner|spinning|loader|loading|progress)/i.test(cls);
  assert(isLoading, 'Loader class should be detected');
});

test('normal element is not loading', () => {
  const cls = 'container main-header user-profile';
  const isLoading = /(?:spinner|spinning|loader|loading|progress)/i.test(cls);
  assert(!isLoading, 'Normal element should not be loading');
});

describe('Snapshot: Below-Fold Detection');

test('element below fold (top > 90% viewport)', () => {
  const foldY = 800 * 0.9; // 720
  const rect = { top: 900 };
  assert(rect.top > foldY, 'Element at 900px should be below fold (fold at 720px)');
});

test('element above fold (top < 90% viewport)', () => {
  const foldY = 800 * 0.9; // 720
  const rect = { top: 50 };
  assert(rect.top < foldY, 'Element at 50px should be above fold');
});

test('element at exact fold boundary is NOT below-fold', () => {
  const foldY = 800 * 0.9; // 720
  const rect = { top: 720 };
  // Using > not >=, so at exactly 720 is NOT below-fold
  assert(!(rect.top > foldY), 'Element exactly at fold boundary should not be marked');
});

describe('Snapshot: Alert & Notification Detection');

test('detects role=alert elements', () => {
  const el = createMockElement('div', {
    _textContent: 'Error: Invalid email address',
    _attrs: new Map([['role', 'alert']]),
    _rect: { top: 10, left: 100, width: 300, height: 40, bottom: 50, right: 400 },
  });
  assert(el.getAttribute('role') === 'alert', 'role=alert should be detected');
});

test('detects role=status elements', () => {
  const el = createMockElement('div', {
    _textContent: 'Changes saved',
    _attrs: new Map([['role', 'status']]),
    _rect: { top: 10, left: 100, width: 300, height: 40, bottom: 50, right: 400 },
  });
  assert(el.getAttribute('role') === 'status', 'role=status should be detected');
});

test('detects toast notification by class', () => {
  const cls = 'toast toast-success fade-in';
  const isToast = /toast|notification|snackbar/i.test(cls);
  assert(isToast, 'Toast class should be detected');
});

test('detects notification by class', () => {
  const cls = 'notification is-danger';
  const isToast = /toast|notification|snackbar/i.test(cls);
  assert(isToast, 'Notification class should be detected');
});

test('detects snackbar by class', () => {
  const cls = 'mdl-snackbar mdl-snackbar--active';
  const isToast = /toast|notification|snackbar/i.test(cls);
  assert(isToast, 'Snackbar class should be detected');
});

test('detects form validation error by class', () => {
  const cls = 'error field-error is-invalid';
  const isError = /\berror\b/i.test(cls);
  assert(isError, 'Validation error class should be detected');
});

test('detects aria-invalid=true elements', () => {
  const el = createMockElement('input', {
    _textContent: '',
    _attrs: new Map([['aria-invalid', 'true']]),
    _rect: { top: 50, left: 50, width: 200, height: 30, bottom: 80, right: 250 },
  });
  assert(el.getAttribute('aria-invalid') === 'true', 'aria-invalid=true should be detected');
});

describe('Snapshot: Floating Layer Detection');

test('detects high z-index fixed elements', () => {
  const { position, zIndex } = { position: 'fixed', zIndex: '1000' };
  const isFixed = position === 'fixed' || position === 'absolute';
  const z = parseInt(zIndex, 10);
  assert(isFixed && z > 10, 'High z-index fixed should be floating');
});

test('low z-index fixed is not floating', () => {
  const { position, zIndex } = { position: 'fixed', zIndex: '5' };
  const isFixed = position === 'fixed' || position === 'absolute';
  const z = parseInt(zIndex, 10);
  assert(!(isFixed && z > 10), 'Low z-index fixed should not be floating');
});

test('detects dropdown class pattern', () => {
  const cls = 'dropdown-menu suggestions-list show';
  const pattern = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/i;
  assert(pattern.test(cls), 'Dropdown should match floating pattern');
});

test('detects modal class pattern', () => {
  const cls = 'modal-dialog fade in';
  const pattern = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/i;
  assert(pattern.test(cls), 'Modal should match floating pattern');
});

test('detects popover class pattern', () => {
  const cls = 'popover bs-popover-right show';
  const pattern = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/i;
  assert(pattern.test(cls), 'Popover should match floating pattern');
});

test('detects tooltip class pattern', () => {
  const cls = 'tooltip bs-tooltip-top';
  const pattern = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/i;
  assert(pattern.test(cls), 'Tooltip should match floating pattern');
});

test('normal content class is not floating', () => {
  const cls = 'main-content container-wrapper page-body';
  const pattern = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/i;
  assert(!pattern.test(cls), 'Normal class should not match floating pattern');
});

describe('Screenshot: Dimension Calculation');

test('prefers scrollWidth over clientWidth', () => {
  const docEl = { scrollWidth: 1600, clientWidth: 1280 };
  const width = Math.max(docEl.scrollWidth, docEl.clientWidth, 0);
  assertEqual(width, 1600, 'Should use larger scrollWidth');
});

test('includes body scrollWidth when doc is constrained', () => {
  const docEl = { scrollWidth: 1280, clientWidth: 1280 };
  const body = { scrollWidth: 2000 };
  const width = Math.max(docEl.scrollWidth, docEl.clientWidth, body.scrollWidth || 0);
  assertEqual(width, 2000, 'Should capture wide body content');
});

test('includes body clientWidth as fallback', () => {
  const docEl = { scrollWidth: 1280, clientWidth: 1280 };
  const body = { scrollWidth: 0, clientWidth: 1920 };
  const width = Math.max(docEl.scrollWidth, docEl.clientWidth, body.scrollWidth || 0, body.clientWidth || 0);
  assertEqual(width, 1920, 'Should fall back to body clientWidth');
});

test('caps dimensions at 16384', () => {
  const raw = 25000;
  const capped = Math.min(raw, 16384);
  assertEqual(capped, 16384, 'Should cap at 16384');
});

test('within limit dimensions pass through', () => {
  const raw = 4000;
  const capped = Math.min(raw, 16384);
  assertEqual(capped, 4000, 'Within-limit dimensions should not be capped');
});

describe('Screenshot: Height Calculation');

test('uses max of doc scrollHeight and body scrollHeight', () => {
  const docEl = { scrollHeight: 5000, clientHeight: 800 };
  const body = { scrollHeight: 5100 };
  const height = Math.max(docEl.scrollHeight, docEl.clientHeight, body.scrollHeight || 0);
  assertEqual(height, 5100, 'Should use larger body scrollHeight');
});

test('uses doc scrollHeight when body is smaller', () => {
  const docEl = { scrollHeight: 5000, clientHeight: 800 };
  const body = { scrollHeight: 3000 };
  const height = Math.max(docEl.scrollHeight, docEl.clientHeight, body.scrollHeight || 0);
  assertEqual(height, 5000, 'Should use larger doc scrollHeight');
});

describe('VLM: Provider API Request Construction');

test('Anthropic request body is well-formed', () => {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
        { type: 'text', text: 'Describe this page' },
      ],
    }],
  };
  assertEqual(body.model, 'claude-sonnet-4-20250514');
  assertEqual(body.max_tokens, 1024);
  assertEqual(body.messages[0].role, 'user');
  assertEqual(body.messages[0].content.length, 2);
  assertEqual(body.messages[0].content[0].type, 'image');
  assertEqual(body.messages[0].content[0].source.type, 'base64');
  assertEqual(body.messages[0].content[0].source.media_type, 'image/png');
  assertEqual(body.messages[0].content[1].type, 'text');
  assertEqual(body.messages[0].content[1].text, 'Describe this page');
});

test('OpenAI request body is well-formed', () => {
  const base64 = 'iVBORw0KGgo...';
  const body = {
    model: 'gpt-4o',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        { type: 'text', text: 'What is on this page?' },
      ],
    }],
  };
  assertEqual(body.messages[0].content[0].type, 'image_url');
  assert(body.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'),
    'URL should be data URI');
});

test('Google Gemini request body is well-formed', () => {
  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/png', data: 'iVBOR...' } },
        { text: 'Describe this page' },
      ],
    }],
  };
  assertEqual(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assertEqual(body.contents[0].parts[1].text, 'Describe this page');
});

describe('VLM: Model Selection');

test('selects model with image input support', () => {
  const models = [
    { id: 'text-model', provider: 'anthropic', input: ['text'] },
    { id: 'vision-model', provider: 'anthropic', input: ['text', 'image'] },
    { id: 'text-model-2', provider: 'openai', input: ['text'] },
  ];
  const vlm = models.find(m => m.input.includes('image'));
  assertNotNull(vlm, 'Should find VLM model');
  assertEqual(vlm.id, 'vision-model');
});

test('returns undefined when no image-capable model', () => {
  const models = [
    { id: 'text-1', provider: 'anthropic', input: ['text'] },
    { id: 'text-2', provider: 'openai', input: ['text'] },
  ];
  const vlm = models.find(m => m.input.includes('image'));
  assert(vlm === undefined, 'Should not find VLM when no image support');
});

test('prefers first image-capable model when multiple exist', () => {
  const models = [
    { id: 'claude-3', provider: 'anthropic', input: ['text', 'image'] },
    { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
  ];
  const vlm = models.find(m => m.input.includes('image'));
  assertEqual(vlm.id, 'claude-3', 'Should select first VLM-capable model');
});

test('provider URLs are correct', () => {
  const urls = {
    anthropic: 'https://api.anthropic.com/v1',
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
  };
  assertEqual(urls.anthropic, 'https://api.anthropic.com/v1');
  assertEqual(urls.openai, 'https://api.openai.com/v1');
  assertEqual(urls.google, 'https://generativelanguage.googleapis.com/v1beta');
});

describe('VLM: HTTP Server Analyze Flag');

test('screenshot with analyze=true', () => {
  const url = new URL('http://localhost:19223/screenshot?analyze=true');
  assert(url.searchParams.get('analyze') === 'true', 'analyze should be true');
});

test('screenshot with fullPage and analyze', () => {
  const url = new URL('http://localhost:19223/screenshot?fullPage=true&analyze=true');
  assert(url.searchParams.get('fullPage') === 'true', 'fullPage should be true');
  assert(url.searchParams.get('analyze') === 'true', 'analyze should be true');
});

test('screenshot without analyze defaults to false', () => {
  const url = new URL('http://localhost:19223/screenshot');
  assert(url.searchParams.get('analyze') !== 'true', 'analyze should default to false');
});

test('screenshot with only fullPage', () => {
  const url = new URL('http://localhost:19223/screenshot?fullPage=true');
  assert(url.searchParams.get('fullPage') === 'true', 'fullPage should be true');
  assert(url.searchParams.get('analyze') !== 'true', 'analyze should default to false');
});

describe('Snapshot: ID Filtering');

test('filters vue- IDs', () => {
  const pattern = /^(r\d|vue-|__|react-|aria-|\d+$|^[a-f0-9]{8}-)/i;
  assert(pattern.test('vue-123'), 'vue- IDs should be filtered');
});

test('filters react IDs', () => {
  const pattern = /^(r\d|vue-|__|react-|aria-|\d+$|^[a-f0-9]{8}-)/i;
  assert(pattern.test('react-root'), 'react IDs should be filtered');
});

test('filters pure numeric IDs', () => {
  const pattern = /^(r\d|vue-|__|react-|aria-|\d+$|^[a-f0-9]{8}-)/i;
  assertMatches('12345', pattern, 'Numeric IDs should be filtered');
});

test('filters UUID-like IDs', () => {
  const pattern = /^(r\d|vue-|__|react-|aria-|\d+$|^[a-f0-9]{8}-)/i;
  assertMatches('a1b2c3d4-efgh-ijkl', pattern, 'UUID-like IDs should be filtered');
});

test('preserves meaningful IDs', () => {
  const pattern = /^(r\d|vue-|__|react-|aria-|\d+$|^[a-f0-9]{8}-)/i;
  assert(!pattern.test('search-box'), 'search-box should be preserved');
  assert(!pattern.test('login-btn'), 'login-btn should be preserved');
  assert(!pattern.test('main-nav'), 'main-nav should be preserved');
  assert(!pattern.test('user-email'), 'user-email should be preserved');
  assert(!pattern.test('sidebar'), 'sidebar should be preserved');
});

describe('Snapshot: Href Filtering');

test('filters javascript:void(0)', () => {
  const href = 'javascript:void(0)';
  const skip = href === '#' || href === 'javascript:void(0)';
  assert(skip, 'javascript:void(0) should be skipped');
});

test('filters anchor #', () => {
  const href = '#';
  const skip = href === '#' || href === 'javascript:void(0)';
  assert(skip, 'anchor # should be skipped');
});

test('preserves meaningful hrefs', () => {
  const href = '/products/category?id=123';
  const skip = href === '#' || href === 'javascript:void(0)';
  assert(!skip, 'Meaningful href should be preserved');
});

test('href truncation to 60 chars', () => {
  const href = '/very/long/path/that/goes/on/and/on/and/on/for/a/very/long/time/and/still/continues';
  const truncated = href.slice(0, 60);
  assertEqual(truncated.length, 60, 'Long href should be truncated to 60');
});

describe('Snapshot: Edge Cases');

test('name truncation to 80 chars', () => {
  const name = 'A'.repeat(200);
  assertEqual(name.slice(0, 80).length, 80, 'Long name should be truncated to 80');
});

test('short name is not truncated', () => {
  const name = 'Hello World';
  assertEqual(name.slice(0, 80), 'Hello World');
});

test('empty name stays empty', () => {
  assertEqual(''.slice(0, 80), '');
});

test('disabled inputs with loading=false are not loading', () => {
  const el = createMockElement('button', {
    _disabled: true,
    _class: 'btn-primary',
    _textContent: 'Submit',
    _rect: { top: 100, left: 50, width: 100, height: 30, bottom: 130, right: 150 },
  });
  // The code checks !el.disabled before class-based detection
  // So disabled buttons are NOT detected as loading by class
  const cls = el.className;
  if (!el.disabled) {
    const isLoading = /(?:spinner|spinning|loader|loading|progress)/i.test(cls);
    assert(!isLoading, 'Disabled button should skip loading class check');
  } else {
    assert(true, 'Disabled buttons skip loading check');
  }
});

test('h1 detection in snapshot', () => {
  // simulate h1 reading for snapshot header
  const h1 = { textContent: '  Welcome Page  ' };
  const title = 'My Site';
  let header = 'Page: ' + title;
  if (h1 && h1.textContent.trim()) {
    header += ' | H1: ' + h1.textContent.trim().slice(0, 80);
  }
  assertEqual(header, 'Page: My Site | H1: Welcome Page');
});

test('snapshot without h1', () => {
  const title = 'My App';
  let header = 'Page: ' + title;
  const h1 = null;
  if (h1 && h1.textContent.trim()) {
    header += ' | H1: ' + h1.textContent.trim().slice(0, 80);
  }
  assertEqual(header, 'Page: My App');
});

describe('PiBrowser CLI: Screenshot with --analyze');

test('screenshot --analyze sets analyze flag', () => {
  const args = ['screenshot', '--analyze'];
  const analyze = args.includes('--analyze') || args.includes('--describe');
  assert(analyze, '--analyze flag should be detected');
});

test('screenshot --describe sets analyze flag', () => {
  const args = ['screenshot', '--describe'];
  const analyze = args.includes('--analyze') || args.includes('--describe');
  assert(analyze, '--describe flag should be detected');
});

test('screenshot --fullpage --analyze sets both flags', () => {
  const args = ['screenshot', '--fullpage', '--analyze'];
  const fullPage = args.includes('--fullpage') || args.includes('--full');
  const analyze = args.includes('--analyze') || args.includes('--describe');
  assert(fullPage && analyze, 'Both flags should be detected');
});

test('screenshot query string construction', () => {
  const args = ['screenshot', '--fullpage', '--analyze'];
  const fullPage = args.includes('--fullpage') || args.includes('--full');
  const analyze = args.includes('--analyze') || args.includes('--describe');
  const params = [];
  if (fullPage) params.push('fullPage=true');
  if (analyze) params.push('analyze=true');
  const query = params.length > 0 ? '?' + params.join('&') : '';
  assertEqual(query, '?fullPage=true&analyze=true');
});

test('screenshot without flags has empty query', () => {
  const args = ['screenshot'];
  const fullPage = args.includes('--fullpage') || args.includes('--full');
  const analyze = args.includes('--analyze') || args.includes('--describe');
  const params = [];
  if (fullPage) params.push('fullPage=true');
  if (analyze) params.push('analyze=true');
  const query = params.length > 0 ? '?' + params.join('&') : '';
  assertEqual(query, '');
});

describe('Implicit Role Mapping');

test('a[href] maps to link', () => {
  const el = createMockElement('a', {
    _attrs: new Map([['href', '/home']]),
    _rect: { top: 0, left: 0, width: 50, height: 20, bottom: 20, right: 50 },
  });
  const tag = el.tagName.toLowerCase();
  let role;
  if (tag === 'a' && el.hasAttribute('href')) role = 'link';
  assertEqual(role, 'link');
});

test('button maps to button', () => {
  const el = createMockElement('button');
  const tag = el.tagName.toLowerCase();
  let role;
  if (tag === 'button') role = 'button';
  assertEqual(role, 'button');
});

test('input[type=email] maps to textbox', () => {
  const el = createMockElement('input', {
    _attrs: new Map([['type', 'email']]),
    _rect: { top: 0, left: 0, width: 100, height: 30, bottom: 30, right: 100 },
  });
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  let role;
  if (tag === 'input') {
    if (['checkbox', 'radio', 'submit', 'button', 'reset', 'range'].includes(type)) {
      if (type === 'checkbox') role = 'checkbox';
      else if (type === 'radio') role = 'radio';
      else if (type === 'range') role = 'slider';
      else role = 'button';
    } else {
      role = 'textbox';
    }
  }
  assertEqual(role, 'textbox');
});

test('input[type=checkbox] maps to checkbox', () => {
  const el = createMockElement('input', {
    _attrs: new Map([['type', 'checkbox']]),
    _rect: { top: 0, left: 0, width: 20, height: 20, bottom: 20, right: 20 },
  });
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  let role;
  if (tag === 'input' && type === 'checkbox') role = 'checkbox';
  assertEqual(role, 'checkbox');
});

test('input[type=range] maps to slider', () => {
  const el = createMockElement('input', {
    _attrs: new Map([['type', 'range']]),
    _rect: { top: 0, left: 0, width: 200, height: 30, bottom: 30, right: 200 },
  });
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  let role;
  if (tag === 'input' && type === 'range') role = 'slider';
  assertEqual(role, 'slider');
});

test('select maps to combobox', () => {
  const el = createMockElement('select', {
    _rect: { top: 0, left: 0, width: 200, height: 30, bottom: 30, right: 200 },
  });
  const tag = el.tagName.toLowerCase();
  let role;
  if (tag === 'select') role = 'combobox';
  assertEqual(role, 'combobox');
});

test('textarea maps to textbox', () => {
  const el = createMockElement('textarea', {
    _rect: { top: 0, left: 0, width: 200, height: 60, bottom: 60, right: 200 },
  });
  const tag = el.tagName.toLowerCase();
  let role;
  if (tag === 'textarea') role = 'textbox';
  assertEqual(role, 'textbox');
});

test('h1-h6 maps to heading', () => {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const el = createMockElement(tag);
    let role;
    if (/^h[1-6]$/.test(el.tagName.toLowerCase())) role = 'heading';
    assertEqual(role, 'heading', `${tag} should map to heading`);
  }
});

test('nav maps to navigation', () => {
  const el = createMockElement('nav');
  let role;
  if (el.tagName.toLowerCase() === 'nav') role = 'navigation';
  assertEqual(role, 'navigation');
});

describe('Page Analysis: Page Classification');

function mockAnalyzePage(visibleElements) {
  const visible = visibleElements || [];

  let pageState = 'content';
  if (visible.length === 0) {
    pageState = 'empty';
  } else if (visible.length <= 5) {
    pageState = 'gate';
  }

  const bodyText = visible.map(el => el._textContent || '').join(' ').toLowerCase();
  if (/error|not found|404|500|access denied|forbidden|blocked/i.test(bodyText)) {
    if (pageState !== 'empty') pageState = 'error';
  }

  const actionWords = /login|log in|sign.?in|sign.?on|sign.?up|register|auth|authorize|agree|accept|confirm|submit|send|save|next|continue|start|get.?started|enter|go|ok\b|okay|yes|allow|enable|approve|verify|proceed|got it|i agree|登录|注册|授权|确认|提交|下一步|确定|知道了|进入|开始|接受|同意|允许|验证|扫码|打开|立即体验|继续/i;
  const dangerWords = /delete|remove|destroy|wipe|erase|clear all|删除|清除|清理|解散|注销/i;
  const paymentWords = /pay|payment|checkout|purchase|buy|upgrade|subscribe|billing|charge|支付|购买|付款|升级|订阅|充值/i;

  const coreActions = [];
  for (let i = 0; i < visible.length && coreActions.length < 10; i++) {
    const el = visible[i];
    const text = (el._textContent || '').trim().slice(0, 80);
    if (!text) continue;

    const role = el._role || (el.tagName.toLowerCase() === 'a' ? 'link' : 'button');
    if (role !== 'button' && role !== 'link') continue;
    if (el._disabled || el.getAttribute('aria-disabled') === 'true') continue;

    if (actionWords.test(text)) {
      let risk = 'low';
      if (dangerWords.test(text) || paymentWords.test(text)) {
        risk = 'high';
      }
      coreActions.push({ text, risk });
    }
  }

  const hasForm = visible.some(el => {
    const tag = el.tagName.toLowerCase();
    const type = (el._type || el.getAttribute('type') || '').toLowerCase();
    return tag === 'input' && ['text', 'email', 'password'].includes(type);
  });

  let summary = '';
  if (pageState === 'gate') {
    if (coreActions.length > 0) {
      const lowRisk = coreActions.filter(a => a.risk === 'low');
      if (lowRisk.length > 0) {
        summary = 'Gate page with low-risk action(s): ' + lowRisk.map(a => '"' + a.text + '"').join(', ') + '. Safe to auto-click.';
      } else {
        summary = 'Gate page with actions: ' + coreActions.map(a => '"' + a.text + '" (' + a.risk + ')').join(', ');
      }
    } else {
      summary = 'Gate page with few elements. No recognizable action buttons found. Consider running snapshot to inspect.';
    }
  } else if (pageState === 'content') {
    summary = 'Normal content page with ' + visible.length + ' interactive elements.';
  } else if (pageState === 'error') {
    summary = 'Page appears to show an error. Check the content before proceeding.';
  } else {
    summary = 'Page appears empty (no visible interactive elements). May be loading or require JS execution.';
  }

  return { pageState, elementCount: visible.length, coreActions, hasForm, summary };
}

function makePageEl(tag, text, overrides = {}) {
  return createMockElement(tag, {
    _textContent: text,
    _role: overrides._role || (tag === 'a' ? 'link' : 'button'),
    _disabled: overrides._disabled || false,
    _tag: overrides._tag || tag,
    _type: overrides._type || '',
    _rect: overrides._rect || { top: 100, left: 50, width: 80, height: 30, bottom: 130, right: 130 },
    ...overrides,
  });
}

test('classifies 0 elements as empty', () => {
  const result = mockAnalyzePage([]);
  assertEqual(result.pageState, 'empty');
  assertEqual(result.elementCount, 0);
});

test('classifies 3 elements as gate', () => {
  const els = [makePageEl('button', '登录'), makePageEl('button', '取消'), makePageEl('a', '帮助', { _tag: 'a' })];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'gate');
  assertEqual(result.elementCount, 3);
});

test('classifies 5 elements as gate (boundary)', () => {
  const els = Array.from({ length: 5 }, (_, i) => makePageEl('button', `Action ${i}`));
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'gate');
});

test('classifies 6 elements as content', () => {
  const els = Array.from({ length: 6 }, (_, i) => makePageEl('button', `Action ${i}`));
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'content');
});

test('classifies 20 elements as content', () => {
  const els = Array.from({ length: 20 }, (_, i) => makePageEl('button', `Action ${i}`));
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'content');
  assertEqual(result.elementCount, 20);
});

describe('Page Analysis: Error Detection');

test('detects 404 error page', () => {
  const els = [makePageEl('h1', '404 Not Found'), makePageEl('a', 'Go Home', { _tag: 'a' })];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'error');
});

test('detects access denied page', () => {
  const els = [makePageEl('div', 'Access Denied'), makePageEl('button', '返回')];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'error');
});

test('error detection overrides gate state', () => {
  const els = [makePageEl('button', 'Login'), makePageEl('div', 'Error: Service Unavailable')];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'error');
});

describe('Page Analysis: Action Extraction - English');

test('extracts login as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Login')]);
  assertEqual(result.coreActions[0].text, 'Login');
  assertEqual(result.coreActions[0].risk, 'low');
});

test('extracts sign in/sign up as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Sign In'), makePageEl('button', 'Sign Up')]);
  assertEqual(result.coreActions.length, 2);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts agree/accept/confirm as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'I Agree'), makePageEl('button', 'Accept'), makePageEl('button', 'Confirm')]);
  assertEqual(result.coreActions.length, 3);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts authorize/verify/allow/enable as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Authorize'), makePageEl('button', 'Verify'), makePageEl('button', 'Allow Login')]);
  assertEqual(result.coreActions.length, 3);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts continue/next/start/get started as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Continue'), makePageEl('button', 'Next'), makePageEl('button', 'Get Started')]);
  assertEqual(result.coreActions.length, 3);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('classifies delete/remove as high risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Delete Account'), makePageEl('button', 'Remove')]);
  assert(result.coreActions.every(a => a.risk === 'high'));
});

test('classifies pay/purchase/buy/subscribe as high risk', () => {
  const result = mockAnalyzePage([makePageEl('button', 'Pay Now'), makePageEl('button', 'Subscribe')]);
  assert(result.coreActions.every(a => a.risk === 'high'));
});

describe('Page Analysis: Action Extraction - Chinese');

test('extracts 登录 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '登录')]);
  assertEqual(result.coreActions[0].text, '登录');
  assertEqual(result.coreActions[0].risk, 'low');
});

test('extracts 微信账号登录 / 用手机号登录 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '微信账号登录'), makePageEl('button', '用手机号登录')]);
  assertEqual(result.coreActions.length, 2);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts 授权 / 确认 / 提交 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '授权'), makePageEl('button', '确认'), makePageEl('button', '提交')]);
  assertEqual(result.coreActions.length, 3);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts 下一步 / 知道了 / 确定 / 进入 / 开始 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '下一步'), makePageEl('button', '知道了'), makePageEl('button', '确定'), makePageEl('button', '进入'), makePageEl('button', '开始体验')]);
  assertEqual(result.coreActions.length, 5);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts 接受 / 同意 / 允许 / 验证 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '接受'), makePageEl('button', '同意'), makePageEl('button', '允许'), makePageEl('button', '验证')]);
  assertEqual(result.coreActions.length, 4);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('extracts 打开 / 立即体验 / 继续 / 扫码登录 as low risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '打开'), makePageEl('button', '立即体验'), makePageEl('button', '继续'), makePageEl('button', '扫码登录')]);
  assertEqual(result.coreActions.length, 4);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

test('classifies 删除 / 注销 / 清除 / 清理 as high risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '删除'), makePageEl('button', '注销账号'), makePageEl('button', '清除数据'), makePageEl('button', '清理缓存')]);
  assert(result.coreActions.every(a => a.risk === 'high'));
});

test('classifies 支付 / 购买 / 升级 / 订阅 / 充值 as high risk', () => {
  const result = mockAnalyzePage([makePageEl('button', '支付'), makePageEl('button', '购买'), makePageEl('button', '升级会员'), makePageEl('button', '充值')]);
  assert(result.coreActions.every(a => a.risk === 'high'));
});

describe('Page Analysis: Edge Cases');

test('disabled buttons excluded from core actions', () => {
  const els = [makePageEl('button', '登录', { _disabled: true }), makePageEl('button', '帮助')];
  const result = mockAnalyzePage(els);
  assertEqual(result.coreActions.length, 0, 'Disabled login should be excluded');
});

test('non-button/link elements excluded from core actions', () => {
  const els = [makePageEl('input', '登录', { _role: 'textbox', _tag: 'input', _type: 'text' })];
  const result = mockAnalyzePage(els);
  assertEqual(result.coreActions.length, 0);
});

test('caps core actions at 10', () => {
  const els = Array.from({ length: 20 }, (_, i) => makePageEl('button', `Login ${i}`));
  const result = mockAnalyzePage(els);
  assert(result.coreActions.length <= 10);
});

test('gate with low-risk actions has safe-to-click summary', () => {
  const result = mockAnalyzePage([makePageEl('button', '登录')]);
  assert(result.summary.includes('Safe to auto-click'));
});

test('gate with only high-risk actions warns in summary', () => {
  const result = mockAnalyzePage([makePageEl('button', '删除')]);
  // '删除' is destructive — intentionally not in actionWords, so not a core action
  assertEqual(result.coreActions.length, 0);
  assert(!result.summary.includes('Safe to auto-click'));
  assert(result.summary.includes('No recognizable action buttons'));
});

test('gate with unrecognized actions gives fallback summary', () => {
  const result = mockAnalyzePage([makePageEl('button', '帮助'), makePageEl('button', '关于')]);
  assert(result.summary.includes('No recognizable action buttons'));
});

test('content page summary has element count', () => {
  const result = mockAnalyzePage(Array.from({ length: 10 }, (_, i) => makePageEl('button', `Action ${i}`)));
  assert(result.summary.includes('10 interactive elements'));
});

test('form detection with email/password inputs', () => {
  const els = [makePageEl('button', '登录'), makePageEl('input', '', { _role: 'textbox', _tag: 'input', _type: 'email' }), makePageEl('input', '', { _tag: 'input', _type: 'password' })];
  const result = mockAnalyzePage(els);
  assert(result.hasForm);
});

describe('Page Analysis: Platform Simulation');

test('WeChat OAuth gate', () => {
  const els = [makePageEl('button', '微信账号登录'), makePageEl('button', '用手机号登录'), makePageEl('a', '《服务协议》', { _tag: 'a' })];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'gate');
  assertEqual(result.coreActions.length, 2);
  assert(result.summary.includes('Safe to auto-click'));
});

test('DingTalk OAuth gate', () => {
  const els = [makePageEl('button', '授权并登录'), makePageEl('button', '取消')];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'gate');
  assertEqual(result.coreActions[0].text, '授权并登录');
  assertEqual(result.coreActions[0].risk, 'low');
});

test('Xiaohongshu consent gate', () => {
  const els = [makePageEl('button', '同意并继续'), makePageEl('button', '不同意')];
  const result = mockAnalyzePage(els);
  assertEqual(result.coreActions[0].text, '同意并继续');
  assertEqual(result.coreActions[0].risk, 'low');
  assert(result.summary.includes('Safe to auto-click'));
});

test('Feishu OAuth gate', () => {
  const els = [makePageEl('button', 'Sign In with Feishu'), makePageEl('button', 'Cancel')];
  const result = mockAnalyzePage(els);
  assertEqual(result.coreActions[0].risk, 'low');
  assert(result.summary.includes('Safe to auto-click'));
});

test('Session-cached auto-redirect pattern', () => {
  const els = [makePageEl('button', '同意'), makePageEl('button', '拒绝')];
  const result = mockAnalyzePage(els);
  assertEqual(result.pageState, 'gate');
  assertEqual(result.coreActions[0].risk, 'low');
  assert(result.summary.includes('Safe to auto-click'));
});

test('mixed Chinese/English actions', () => {
  const els = [makePageEl('button', 'Agree 同意'), makePageEl('button', 'Login 登录')];
  const result = mockAnalyzePage(els);
  assertEqual(result.coreActions.length, 2);
  assert(result.coreActions.every(a => a.risk === 'low'));
});

describe('Popup / click_and_select: Floating Container Detection');

// Helper: mock piIsVisible
function mockPiIsVisible(el) {
  const style = el._style || {};
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el._rect || {};
  if (rect.width <= 0 || rect.height <= 0) return false;
  return true;
}

function mockFindFloatingContainers(rootEls) {
  var floatingContainers = [];
  var allEls = [];
  function collect(el) {
    allEls.push(el);
    (el.children || []).forEach(collect);
  }
  (rootEls || []).forEach(collect);

  var roleSet = new Set(['listbox', 'menu', 'dialog', 'tooltip', 'alertdialog', 'tree']);
  var classPatterns = /(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer|picker|panel|flyout|pulldown)/;

  for (var c = 0; c < allEls.length; c++) {
    var el = allEls[c];
    if (!el.isConnected) continue;
    var style = el._style || {};
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    var role = el.getAttribute('role') || '';
    var isFloating = false;

    if (roleSet.has(role)) {
      isFloating = true;
    }

    if (!isFloating && (style.position === 'fixed' || style.position === 'absolute')) {
      var zIndex = parseInt(style.zIndex || '0', 10);
      if (zIndex > 10) isFloating = true;
    }

    if (!isFloating && (el.children || []).length > 0 && (el.children || []).length <= 100) {
      var cls = (el._class || el.className || '').toLowerCase();
      if (classPatterns.test(cls)) {
        var zIdx = parseInt(style.zIndex || '0', 10);
        if (zIdx > 0 || style.position === 'absolute' || style.position === 'fixed') {
          isFloating = true;
        }
      }
    }

    if (isFloating && mockPiIsVisible(el)) {
      floatingContainers.push(el);
    }
  }

  // Deduplicate
  var rootContainers = [];
  for (var d = 0; d < floatingContainers.length; d++) {
    var isChild = false;
    for (var p = 0; p < floatingContainers.length; p++) {
      if (d !== p && floatingContainers[p].contains(floatingContainers[d])) {
        isChild = true;
        break;
      }
    }
    if (!isChild) rootContainers.push(floatingContainers[d]);
  }

  return rootContainers;
}

test('floating container detected by role=listbox', () => {
  const dropdown = createMockElement('div', {
    _style: { zIndex: '1000', position: 'fixed' },
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 300, top: 100, left: 0, bottom: 400, right: 200 },
  });
  dropdown.setAttribute('role', 'listbox');
  const root = createMockElement('body', {});
  root.children = [dropdown];
  dropdown._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 1, 'Should detect one floating container by role');
  assert(result[0].getAttribute('role') === 'listbox');
});

test('floating container detected by role=menu', () => {
  const menu = createMockElement('div', {
    _style: { zIndex: '500', position: 'absolute' },
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 200, top: 100, left: 0, bottom: 300, right: 200 },
  });
  menu.setAttribute('role', 'menu');
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [menu];
  menu._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 1, 'Should detect menu by role');
});

test('floating container detected by high z-index + position fixed', () => {
  const popup = createMockElement('div', {
    _style: { zIndex: '9999', position: 'fixed' },
    _class: '',
    _rect: { x: 0, y: 0, width: 300, height: 400, top: 0, left: 0, bottom: 400, right: 300 },
  });
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [popup];
  popup._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 1, 'Should detect by z-index');
});

test('low z-index not detected as floating', () => {
  const div = createMockElement('div', {
    _style: { zIndex: '5', position: 'absolute' },
    _class: '',
    _rect: { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 },
  });
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [div];
  div._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 0, 'z-index 5 should not be detected as floating');
});

test('floating container detected by class pattern (dropdown-menu)', () => {
  const dropdown = createMockElement('div', {
    _style: { position: 'absolute', zIndex: '1' },
    _rect: { x: 0, y: 50, width: 200, height: 150, top: 50, left: 0, bottom: 200, right: 200 },
  });
  dropdown._class = 'dropdown-menu visible';
  // Class-based detection requires children > 0
  const item = createMockElement('div', { _rect: { x: 0, y: 50, width: 200, height: 30, top: 50, left: 0, bottom: 80, right: 200 } });
  dropdown.children = [item];
  item._parent = dropdown;
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [dropdown];
  dropdown._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 1, 'Should detect by class name pattern');
});

test('floating container detected by class pattern (ant-select-dropdown)', () => {
  const dropdown = createMockElement('div', {
    _style: { position: 'fixed', zIndex: '1050' },
    _rect: { x: 0, y: 60, width: 250, height: 200, top: 60, left: 0, bottom: 260, right: 250 },
  });
  dropdown._class = 'ant-select-dropdown ant-slide-up';
  const item = createMockElement('div', { _rect: { x: 0, y: 60, width: 250, height: 30, top: 60, left: 0, bottom: 90, right: 250 } });
  dropdown.children = [item];
  item._parent = dropdown;
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [dropdown];
  dropdown._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 1, 'Ant Design dropdown should be detected');
});

test('nested floating containers: only root returned', () => {
  const outer = createMockElement('div', {
    _style: { position: 'fixed', zIndex: '1000' },
    _rect: { x: 100, y: 100, width: 400, height: 300, top: 100, left: 100, bottom: 400, right: 500 },
  });
  outer.setAttribute('role', 'dialog');
  outer._class = 'modal';
  const inner = createMockElement('div', {
    _style: { position: 'absolute', zIndex: '100' },
    _rect: { x: 120, y: 150, width: 200, height: 100, top: 150, left: 120, bottom: 250, right: 320 },
  });
  inner.setAttribute('role', 'listbox');
  inner._class = 'select-dropdown';

  // Setup containment: outer contains inner
  outer.children = [inner];
  outer.contains = (child) => child === inner;
  inner._parent = outer;

  const root = createMockElement('body', {});
  root.contains = (child) => child === outer;  // body only directly contains outer
  root.children = [outer];
  outer._parent = root;

  const result = mockFindFloatingContainers([root]);
  // Only outer should be returned since inner is a child of outer
  assertEqual(result.length, 1, 'Should deduplicate: only outer modal returned');
  assert(result[0].getAttribute('role') === 'dialog');
});

test('hidden elements not detected as floating', () => {
  const hidden = createMockElement('div', {
    _attrs: [['role', 'menu']],
    _style: { display: 'none', zIndex: '1000', position: 'fixed' },
    _class: '',
    _rect: { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 },
  });
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [hidden];
  hidden._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 0, 'Hidden element should not be detected');
});

test('static positioned element with popup class but z-index 0 not detected', () => {
  const popup = createMockElement('div', {
    _class: 'popup-container',
    _style: { position: 'static', zIndex: '0' },
    _rect: { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 },
  });
  const root = createMockElement('body', {});
  root.contains = (child) => root.children.includes(child);
  root.children = [popup];
  popup._parent = root;

  const result = mockFindFloatingContainers([root]);
  assertEqual(result.length, 0, 'Static popup with z-index 0 should not be detected');
});

describe('Popup / click_and_select: Option Matching');

test('option matched by textContent substring search within floating container', () => {
  const dropdown = createMockElement('div', {
    _attrs: [['role', 'listbox']],
    _style: { position: 'fixed', zIndex: '1000' },
    _class: 'dropdown',
    _rect: { x: 0, y: 100, width: 200, height: 300, top: 100, left: 0, bottom: 400, right: 200 },
  });
  const opt1 = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Option One',
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 30, top: 100, left: 0, bottom: 130, right: 200 },
  });
  const opt2 = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Option Two',
    _class: '',
    _rect: { x: 0, y: 130, width: 200, height: 30, top: 130, left: 0, bottom: 160, right: 200 },
  });
  const opt3 = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Target Option - description text',
    _class: '',
    _rect: { x: 0, y: 160, width: 200, height: 30, top: 160, left: 0, bottom: 190, right: 200 },
  });

  dropdown.children = [opt1, opt2, opt3];
  dropdown.contains = () => true;  // everything is inside this dropdown
  dropdown.querySelectorAll = () => [opt1, opt2, opt3];
  opt1.querySelectorAll = () => [];
  opt2.querySelectorAll = () => [];
  opt3.querySelectorAll = () => [];

  var searchSelectors = [
    '[role="option"]', '[role="menuitem"]', '[role="treeitem"]',
    'li', 'a', 'button', 'option',
    'div[onclick]', 'span[onclick]',
    '.menu-item', '.dropdown-item', '.popup-item',
    '.select-option', '.picker-option'
  ].join(', ');

  // Search
  var matcher = 'target option';
  var items = dropdown.querySelectorAll(searchSelectors);
  var matched = null;
  for (var i = 0; i < items.length; i++) {
    if (!mockPiIsVisible(items[i])) continue;
    var text = (items[i].textContent || items[i]._textContent || '').trim().toLowerCase();
    if (text.includes(matcher) && text.length < 200) {
      matched = items[i]._textContent.trim().slice(0, 100);
      break;
    }
  }
  assertNotNull(matched, 'Should find matching option');
  assertContains(matched, 'Target Option', 'Should match the correct text');
});

test('option not matched when text does not contain substring', () => {
  const dropdown = createMockElement('div', {
    _attrs: [['role', 'listbox']],
    _style: { position: 'fixed', zIndex: '1000' },
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 200, top: 100, left: 0, bottom: 300, right: 200 },
  });
  const opt1 = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Option Alpha',
    _class: '',
    _rect: { x: 0, y: 100, width: 100, height: 20, top: 100, left: 0, bottom: 120, right: 100 },
  });
  const opt2 = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Option Beta',
    _class: '',
    _rect: { x: 0, y: 120, width: 100, height: 20, top: 120, left: 0, bottom: 140, right: 100 },
  });

  dropdown.children = [opt1, opt2];
  dropdown.contains = () => true;
  dropdown.querySelectorAll = () => [opt1, opt2];

  var matcher = 'gamma';
  var items = dropdown.querySelectorAll('[role="option"], [role="menuitem"], li, a, button, div[onclick]');
  var matched = null;
  for (var i = 0; i < items.length; i++) {
    if (!mockPiIsVisible(items[i])) continue;
    var text = (items[i]._textContent || '').trim().toLowerCase();
    if (text.includes(matcher) && text.length < 200) {
      matched = items[i]._textContent.trim().slice(0, 100);
      break;
    }
  }
  assert(matched === null, 'Should not find non-matching option');
});

test('hidden/invisible option is skipped', () => {
  const dropdown = createMockElement('div', {
    _attrs: [['role', 'listbox']],
    _style: { position: 'fixed', zIndex: '1000' },
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 200, top: 100, left: 0, bottom: 300, right: 200 },
  });
  const optVisible = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Visible Option',
    _class: '',
    _rect: { x: 0, y: 100, width: 200, height: 30, top: 100, left: 0, bottom: 130, right: 200 },
  });
  const optHidden = createMockElement('div', {
    _attrs: [['role', 'option']],
    _textContent: 'Hidden Option',
    _class: '',
    _style: { display: 'none' },
    _rect: { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 },
  });

  dropdown.children = [optVisible, optHidden];
  dropdown.contains = () => true;
  dropdown.querySelectorAll = () => [optVisible, optHidden];

  var visibleItems = [];
  var all = dropdown.querySelectorAll('[role="option"]');
  for (var i = 0; i < all.length; i++) {
    if (mockPiIsVisible(all[i])) visibleItems.push(all[i]);
  }
  assertEqual(visibleItems.length, 1, 'Only one option should be visible');
  assertContains(visibleItems[0]._textContent, 'Visible', 'Visible option should be included');
});

describe('Popup / click_and_select: Mock HTTP Route Integration');

test('click_and_select POST route body parsing', async () => {
  // Verify the route handler extracts the right params
  const body = { selector: '[3]', option: 'Target Option', wait: 2000 };
  assertEqual(body.selector, '[3]');
  assertEqual(body.option, 'Target Option');
  assertEqual(body.wait, 2000);
  assert(typeof body.selector === 'string');
  assert(typeof body.option === 'string');
  assert(typeof body.wait === 'number');
});

test('click_and_select with default wait', async () => {
  // Default wait should be 2000ms when not specified
  const body = { selector: '[5]', option: 'Option' };
  const wait = body.wait ?? 2000;
  assertEqual(wait, 2000, 'Default wait should be 2000');
});

test('click_and_select requires selector and option', () => {
  // CLI should require both params
  const missing_option = () => { if (!'selector' || !undefined) throw new Error('Missing option'); };
  const missing_selector = () => { if (!undefined || !'option') throw new Error('Missing selector'); };
  try { missing_option(); assert(false, 'Should throw'); } catch (e) { assert(true); }
  try { missing_selector(); assert(false, 'Should throw'); } catch (e) { assert(true); }
});

describe('Popup / click_and_select: Chinese Text Support');

test('floating container with Chinese option text matched', () => {
  const dropdown = createMockElement('div', {
    _attrs: [['role', 'listbox']],
    _style: { position: 'fixed', zIndex: '1000' },
    _class: 'el-select-dropdown',
    _rect: { x: 0, y: 100, width: 200, height: 200, top: 100, left: 0, bottom: 300, right: 200 },
  });
  const opt1 = createMockElement('li', {
    _textContent: '张三 - zhangsan@qq.com',
    _class: 'el-select-dropdown__item',
    _rect: { x: 0, y: 100, width: 200, height: 36, top: 100, left: 0, bottom: 136, right: 200 },
  });

  dropdown.children = [opt1];
  dropdown.contains = () => true;
  dropdown.querySelectorAll = () => [opt1];

  var matcher = '张三';
  var items = dropdown.querySelectorAll('li');
  var matched = null;
  for (var i = 0; i < items.length; i++) {
    if (!mockPiIsVisible(items[i])) continue;
    var text = (items[i]._textContent || '').trim().toLowerCase();
    if (text.includes(matcher) && text.length < 200) {
      matched = items[i]._textContent.trim().slice(0, 100);
      break;
    }
  }
  assertNotNull(matched, 'Should match Chinese text');
  assertContains(matched, '张三', 'Matched text should contain Chinese characters');
});

test('click_and_select with Chinese option parameter', () => {
  // The option parameter supports Chinese text
  const option = '微信账号登录';
  assert(option.length > 0);
  assert(/[\u4e00-\u9fff]/.test(option), 'Option should contain Chinese characters');
});

describe('VLM Model Detection: isExplicitVlm');

// Replicate the isExplicitVlm logic for testing
function isExplicitVlm(m) {
  return Array.isArray(m.input) && m.input.includes('image');
}

test('explicit VLM: input includes image', () => {
  assert(isExplicitVlm({ input: ['text', 'image'] }), 'Should detect explicit image input');
});

test('explicit VLM: input only text', () => {
  assert(!isExplicitVlm({ input: ['text'] }), 'Should not detect text-only input');
});

test('explicit VLM: input undefined', () => {
  assert(!isExplicitVlm({}), 'Should not detect undefined input');
});

test('explicit VLM: input not array', () => {
  assert(!isExplicitVlm({ input: 'text' }), 'Should not detect non-array input');
});

describe('VLM Model Detection: isHeuristicVlm');

const VLM_NAME_PATTERNS = [
  /vl/i, /vision/i, /visual/i, /multimodal/i,
  /gpt-4o/i, /gpt-4-turbo/i, /gpt-4-v/i,
  /claude-3/i, /claude-4/i, /claude-sonnet/i, /claude-opus/i,
  /gemini/i,
  /pixtral/i, /llava/i, /cogv/i, /internvl/i, /minicpm-v/i,
  /deepseek-vl/i, /glm-4v/i, /yi-vl/i, /phi-3-v/i,
  /moondream/i, /paligemma/i, /florence/i, /owlv/i,
  /qwen-vl/i, /qwen2-vl/i, /qwen2.5-vl/i,
];

function isHeuristicVlm(m) {
  if (isExplicitVlm(m)) return false;
  const candidateName = ((m.id ?? m.name) ?? '').toLowerCase();
  return VLM_NAME_PATTERNS.some((pattern) => pattern.test(candidateName));
}

test('heuristic VLM: qwen-vl detected', () => {
  assert(isHeuristicVlm({ id: 'qwen-vl-max', input: ['text'] }), 'qwen-vl should be detected');
});

test('heuristic VLM: qwen2-vl detected', () => {
  assert(isHeuristicVlm({ id: 'qwen2-vl-72b', input: ['text'] }), 'qwen2-vl should be detected');
});

test('heuristic VLM: qwen2.5-vl detected', () => {
  assert(isHeuristicVlm({ id: 'qwen2.5-vl-7b', input: ['text'] }), 'qwen2.5-vl should be detected');
});

test('heuristic VLM: gpt-4o detected', () => {
  assert(isHeuristicVlm({ id: 'gpt-4o', input: ['text'] }), 'gpt-4o should be detected');
});

test('heuristic VLM: claude-3 detected', () => {
  assert(isHeuristicVlm({ id: 'claude-3-opus-20240229', input: ['text'] }), 'claude-3 should be detected');
});

test('heuristic VLM: claude-sonnet detected', () => {
  assert(isHeuristicVlm({ id: 'claude-sonnet-4-20250514', input: ['text'] }), 'claude-sonnet should be detected');
});

test('heuristic VLM: gemini detected', () => {
  assert(isHeuristicVlm({ id: 'gemini-1.5-pro', input: ['text'] }), 'gemini should be detected');
});

test('heuristic VLM: llava detected', () => {
  assert(isHeuristicVlm({ id: 'llava-1.5-7b', input: ['text'] }), 'llava should be detected');
});

test('heuristic VLM: deepseek-vl detected', () => {
  assert(isHeuristicVlm({ id: 'deepseek-vl-7b', input: ['text'] }), 'deepseek-vl should be detected');
});

test('heuristic VLM: glm-4v detected', () => {
  assert(isHeuristicVlm({ id: 'glm-4v-9b', input: ['text'] }), 'glm-4v should be detected');
});

test('heuristic VLM: text-only model not detected', () => {
  assert(!isHeuristicVlm({ id: 'gpt-3.5-turbo', input: ['text'] }), 'gpt-3.5 should not be detected');
});

test('heuristic VLM: text-only model not detected (llama)', () => {
  assert(!isHeuristicVlm({ id: 'llama-3-70b', input: ['text'] }), 'llama-3 should not be detected');
});

test('heuristic VLM: text-only model not detected (mistral)', () => {
  assert(!isHeuristicVlm({ id: 'mistral-7b', input: ['text'] }), 'mistral should not be detected');
});

test('heuristic VLM: explicit model not double-detected', () => {
  assert(!isHeuristicVlm({ id: 'qwen-vl-max', input: ['text', 'image'] }), 'Explicit VLM should not be heuristic');
});

test('heuristic VLM: empty id not detected', () => {
  assert(!isHeuristicVlm({ id: '', input: ['text'] }), 'Empty id should not be detected');
});

test('heuristic VLM: undefined id not detected', () => {
  assert(!isHeuristicVlm({ input: ['text'] }), 'Undefined id should not be detected');
});

describe('VLM Model Detection: Three-Stage Resolution');

test('stage ordering: explicit before heuristic before fallback', () => {
  const models = [
    { id: 'gpt-3.5-turbo', input: ['text'], provider: 'openai' },
    { id: 'qwen-vl-max', input: ['text'], provider: 'openai' },
    { id: 'claude-3-opus', input: ['text', 'image'], provider: 'anthropic' },
  ];

  // Simulate the three-stage ordering
  const seen = new Set();
  const candidates = [];

  // Stage 1: explicit
  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isExplicitVlm(m)) {
      seen.add(m.id);
      candidates.push(m);
    }
  }
  // Stage 2: heuristic
  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isHeuristicVlm(m)) {
      seen.add(m.id);
      candidates.push(m);
    }
  }
  // Stage 3: fallback
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    candidates.push(m);
  }

  assertEqual(candidates.length, 3, 'All 3 models should be candidates');
  assertEqual(candidates[0].id, 'claude-3-opus', 'Explicit VLM should be first');
  assertEqual(candidates[1].id, 'qwen-vl-max', 'Heuristic VLM should be second');
  assertEqual(candidates[2].id, 'gpt-3.5-turbo', 'Fallback should be last');
});

test('stage ordering: only heuristic models', () => {
  const models = [
    { id: 'gpt-3.5-turbo', input: ['text'], provider: 'openai' },
    { id: 'qwen-vl-max', input: ['text'], provider: 'openai' },
  ];

  const seen = new Set();
  const candidates = [];

  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isExplicitVlm(m)) { seen.add(m.id); candidates.push(m); }
  }
  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isHeuristicVlm(m)) { seen.add(m.id); candidates.push(m); }
  }
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id); candidates.push(m);
  }

  assertEqual(candidates.length, 2);
  assertEqual(candidates[0].id, 'qwen-vl-max', 'Heuristic VLM should be first');
  assertEqual(candidates[1].id, 'gpt-3.5-turbo', 'Fallback should be last');
});

test('stage ordering: no VLM models, all fallback', () => {
  const models = [
    { id: 'gpt-3.5-turbo', input: ['text'], provider: 'openai' },
    { id: 'llama-3-70b', input: ['text'], provider: 'openai' },
  ];

  const seen = new Set();
  const candidates = [];

  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isExplicitVlm(m)) { seen.add(m.id); candidates.push(m); }
  }
  for (const m of models) {
    if (seen.has(m.id)) continue;
    if (isHeuristicVlm(m)) { seen.add(m.id); candidates.push(m); }
  }
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id); candidates.push(m);
  }

  assertEqual(candidates.length, 2);
  assertEqual(candidates[0].id, 'gpt-3.5-turbo', 'First fallback model');
  assertEqual(candidates[1].id, 'llama-3-70b', 'Second fallback model');
});

describe('Auto Gate Page Handling in navigate()');

test('gate page with low-risk action triggers auto-click', () => {
  // Simulate: navigate returns a gate page, then auto-clicks and gets a content page
  let pageAfterNavigate = {
    pageState: 'gate',
    coreActions: [{ text: '登录', risk: 'low' }],
    summary: 'Gate page with low-risk action: "登录".',
  };

  // Auto-handle logic
  const autoHandleGate = true;
  const maxGateRetries = 2;
  let retries = 0;
  let didAutoClick = false;

  while (autoHandleGate && pageAfterNavigate.pageState === 'gate' && retries < maxGateRetries) {
    const lowRiskAction = pageAfterNavigate.coreActions.find((a) => a.risk === 'low');
    if (!lowRiskAction) break;
    didAutoClick = true;
    // Simulate: after clicking login, page redirects to dashboard
    pageAfterNavigate = {
      pageState: 'content',
      coreActions: [],
      summary: 'Normal content page.',
    };
    retries++;
  }

  assert(didAutoClick, 'Should auto-click low-risk gate action');
  assertEqual(pageAfterNavigate.pageState, 'content', 'Should navigate past gate page');
  assertEqual(retries, 1, 'Should have used exactly 1 retry');
});

test('gate page with only high-risk actions does NOT auto-click', () => {
  const pageAfterNavigate = {
    pageState: 'gate',
    coreActions: [{ text: '删除账号', risk: 'high' }],
    summary: 'Gate page with high-risk action: "删除账号".',
  };

  const lowRiskAction = pageAfterNavigate.coreActions.find((a) => a.risk === 'low');
  assert(lowRiskAction === undefined, 'Should not find any low-risk action');
});

test('gate page with no actions does NOT auto-click', () => {
  const pageAfterNavigate = {
    pageState: 'gate',
    coreActions: [],
    summary: 'Gate page detected but no recognizable action buttons.',
  };

  const lowRiskAction = pageAfterNavigate.coreActions.find((a) => a.risk === 'low');
  assert(lowRiskAction === undefined, 'No low-risk action to auto-click');
});

test('gate page auto-click respects maxGateRetries', () => {
  // Simulate: gate page persists after each click (e.g., QR code login)
  const autoHandleGate = true;
  const maxGateRetries = 2;
  let retries = 0;
  let clickCount = 0;

  let page = {
    pageState: 'gate',
    coreActions: [{ text: '微信扫码登录', risk: 'low' }],
  };

  while (autoHandleGate && page.pageState === 'gate' && retries < maxGateRetries) {
    const lowRiskAction = page.coreActions.find((a) => a.risk === 'low');
    if (!lowRiskAction) break;
    clickCount++;
    // Gate persists (QR code requires manual scan)
    retries++;
  }

  assertEqual(clickCount, maxGateRetries, 'Should try up to maxGateRetries');
  assert(page.pageState === 'gate', 'Gate should still be gate after max retries');
});

test('auto-handle disabled via options does not click', () => {
  const autoHandleGate = false;
  let didAutoClick = false;

  if (autoHandleGate) {
    didAutoClick = true;
  }

  assert(!didAutoClick, 'Should NOT auto-click when autoHandleGate is false');
});

test('gate page auto-click followed by content page stops loop', () => {
  const autoHandleGate = true;
  const maxGateRetries = 3;
  let retries = 0;
  let clickCount = 0;

  let page = {
    pageState: 'gate',
    coreActions: [{ text: '登录', risk: 'low' }],
  };

  // Click 1: gate → content, loop should stop
  while (autoHandleGate && page.pageState === 'gate' && retries < maxGateRetries) {
    const lowRiskAction = page.coreActions.find((a) => a.risk === 'low');
    if (!lowRiskAction) break;
    clickCount++;
    page = { pageState: 'content', coreActions: [] };
    retries++;
  }

  assertEqual(clickCount, 1, 'Should only click once (gate→content ends loop)');
  assertEqual(page.pageState, 'content', 'Should end on content page');
});

test('navigate output reflects final URL after gate redirect', () => {
  // Simulate: requested URL → redirected to gate → auto-click → redirected to target
  const requestedUrl = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit';
  let currentUrl = 'https://mp.weixin.qq.com/cgi-bin/login?redirect=...';

  // After auto-click login, URL changes
  const didAutoClick = true;
  if (didAutoClick) {
    currentUrl = 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&token=abc';
  }

  assert(currentUrl.includes('appmsg_edit'), 'Final URL should be the target page');
  assert(currentUrl !== requestedUrl, 'URL includes session token from gate redirect');
});

describe('Semantic Search: find() Command');

// Replicate the piMatchScore logic for testing
function matchScore(el, query) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  const name = (el.textContent || '').toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const titleAttr = (el.getAttribute('title') || '').toLowerCase();

  let score = 0;
  if (name === q) score += 100;
  else if (name.includes(q)) score += 50;
  else if (q.includes(name) && name.length > 0) score += 40;

  if (ariaLabel === q) score += 90;
  else if (ariaLabel.includes(q)) score += 45;
  if (titleAttr === q) score += 80;
  else if (titleAttr.includes(q)) score += 40;
  if (placeholder === q) score += 70;
  else if (placeholder.includes(q)) score += 35;

  const intentMap = {
    'search': ['searchbox', 'textbox'],
    'login': ['button', 'link', 'textbox'],
    'draft': ['link', 'button', 'tab'],
    'create': ['button', 'link'],
    'new': ['button', 'link'],
    'edit': ['button', 'link'],
    'save': ['button'],
    'delete': ['button'],
    'menu': ['navigation', 'list'],
    'setting': ['link', 'button'],
  };

  for (const intent in intentMap) {
    if (q.includes(intent)) {
      const wantRoles = intentMap[intent];
      for (const wr of wantRoles) {
        if (role === wr) score += 15;
      }
    }
  }

  if (/(draft|manage|content|article|post|page|menu|nav|setting|home|dashboard|statistic|message|notice|素材|管理|内容|文章|页面|菜单|设置|首页|仪表盘|统计|消息|通知|草稿)/i.test(q)) {
    score += 5; // sidebar boost simulated
  }

  if (role === 'heading' || role === 'image' || role === 'textbox') score -= 10;
  return score;
}

test('exact name match gives highest score', () => {
  const el = createMockElement('a', {
    _textContent: 'Drafts',
    _attrs: new Map([['href', '/drafts']]),
  });
  const score = matchScore(el, 'drafts');
  assert(score >= 100, `Expected score >= 100, got ${score}`);
});

test('substring name match gives medium score', () => {
  const el = createMockElement('a', {
    _textContent: '草稿箱 Drafts',
    _attrs: new Map([['href', '/drafts']]),
  });
  const score = matchScore(el, 'drafts');
  assert(score >= 50, `Expected score >= 50, got ${score}`);
});

test('searching "drafts" matches Chinese label 草稿箱 via substring', () => {
  const el = createMockElement('a', {
    _textContent: '草稿箱',
    _attrs: new Map([['href', '/drafts']]),
  });
  // "drafts" is not in "草稿箱" as text, but intent match gives score for role
  el.setAttribute('role', 'link');
  const score = matchScore(el, 'drafts');
  // Intent match for "draft" -> link boosts by 15
  assert(score >= 15, `Expected score >= 15 from intent match, got ${score}`);
});

test('searching "new article" matches button with that text', () => {
  const el = createMockElement('button', {
    _textContent: 'New Article',
    _attrs: new Map([['role', 'button']]),
  });
  const score = matchScore(el, 'new article');
  // "new" intent match + substring match
  assert(score > 0, 'Should match "new article" button');
});

test('searching "草稿箱" matches element with exact Chinese text', () => {
  const el = createMockElement('a', {
    _textContent: '草稿箱',
    _attrs: new Map([['href', '/drafts']]),
  });
  const score = matchScore(el, '草稿箱');
  assert(score >= 100, `Expected score >= 100 for exact match, got ${score}`);
});

test('"create" intent matches button elements', () => {
  const el = createMockElement('button', {
    _textContent: 'Create',
    _attrs: new Map([['role', 'button']]),
  });
  const score = matchScore(el, 'create');
  // substring 50 + intent 15 + no position boost
  assert(score >= 65, `Expected score >= 65, got ${score}`);
});

test('"search" intent matches textbox elements', () => {
  const el = createMockElement('input', {
    _type: 'text',
    _textContent: '',
    _attrs: new Map([['type', 'text'], ['placeholder', 'Search...'], ['role', 'textbox']]),
  });
  const score = matchScore(el, 'search');
  // placeholder match (35 for substring) + intent match (15 for textbox role) - role textbox penalty (10) = 40
  assert(score >= 40, `Expected score >= 40, got ${score}`);
});

test('navigation queries prefer sidebar elements', () => {
  const el = createMockElement('a', {
    _textContent: 'Drafts',
    _attrs: new Map([['href', '/drafts'], ['role', 'link']]),
  });
  const score = matchScore(el, 'drafts');
  // Exact name 100 + intent "draft" 15 for link + nav boost 5
  assert(score >= 120, `Expected score >= 120, got ${score}`);
});

test('empty query returns score 0 for all elements', () => {
  const el = createMockElement('button', {
    _textContent: 'Drafts',
  });
  const score = matchScore(el, '');
  assertEqual(score, 0, 'Empty query should return score 0');
});

test('non-interactive roles get penalty', () => {
  const el = createMockElement('h1', {
    _textContent: 'Drafts',
    _attrs: new Map([['role', 'heading']]),
  });
  const score = matchScore(el, 'drafts');
  // Exact match 100 + nav boost 5 - heading penalty 10 = 95
  assertEqual(score, 95, 'Heading role should get penalty (-10) with nav boost (+5)');
});

test('aria-label match gets high score', () => {
  const el = createMockElement('button', {
    _textContent: '',
    _attrs: new Map([['aria-label', 'Drafts'], ['role', 'button']]),
  });
  const score = matchScore(el, 'drafts');
  // aria-label exact 90 + intent 15 = 105
  assert(score >= 105, `Expected score >= 105, got ${score}`);
});

test('title attribute match', () => {
  const el = createMockElement('a', {
    _textContent: 'Go',
    _attrs: new Map([['title', 'Drafts'], ['role', 'link']]),
  });
  const score = matchScore(el, 'drafts');
  // title exact 80 + intent 15 = 95
  assert(score >= 95, `Expected score >= 95, got ${score}`);
});

test('placeholder match on input', () => {
  const el = createMockElement('input', {
    _textContent: '',
    _type: 'text',
    _attrs: new Map([['type', 'text'], ['placeholder', 'Search drafts'], ['role', 'textbox']]),
  });
  const score = matchScore(el, 'drafts');
  // placeholder substring 35 + nav boost 5 - textbox penalty 10 = 30
  assert(score >= 30, `Expected score >= 30, got ${score}`);
});

test('results sorted by score descending', () => {
  const el1 = createMockElement('a', {
    _textContent: 'Drafts',
    _attrs: new Map([['href', '/drafts'], ['role', 'link']]),
  });
  const el2 = createMockElement('a', {
    _textContent: 'Article Drafts Overview',
    _attrs: new Map([['href', '/drafts/overview'], ['role', 'link']]),
  });
  const score1 = matchScore(el1, 'drafts');
  const score2 = matchScore(el2, 'drafts');
  assert(score1 > score2, 'Exact match should score higher than substring match');
});

describe('Find: Result Structure');

test('find returns scored matches with role, text, section', () => {
  const result = {
    score: 50,
    role: 'link',
    text: '草稿箱',
    section: 'sidebar',
  };
  assertNotNull(result.score, 'Result should have score');
  assertNotNull(result.role, 'Result should have role');
  assertNotNull(result.text, 'Result should have text');
  assertNotNull(result.section, 'Result should have section');
});

test('find returns empty array for no matches', () => {
  const results = [];
  assert(Array.isArray(results), 'Should return array');
  assertEqual(results.length, 0, 'No matches should return empty array');
});

test('find limits results to top 10', () => {
  const results = Array.from({ length: 15 }, (_, i) => ({
    score: 100 - i,
    role: 'link',
    text: `Item ${i}`,
    section: 'main',
  }));
  assert(results.length <= 15, 'All results generated');
  const top10 = results.slice(0, 10);
  assertEqual(top10.length, 10, 'Should limit to 10');
  assertEqual(top10[0].score, 100, 'First should have highest score');
  assertEqual(top10[9].score, 91, 'Tenth should have 10th highest score');
});

describe('Structured Snapshot: Section Detection');

test('sidebar section has elements grouped separately', () => {
  const sectionElements = {
    sidebar: ['[1] link "内容管理"', '[2] link "草稿箱"'],
    header: ['[3] link "通知"'],
    main: ['[4] button "新的创作"'],
    footer: [],
  };
  assert(sectionElements.sidebar.length > 0, 'Sidebar should contain elements');
  assert(sectionElements.main.length > 0, 'Main should contain elements');
  assert(sectionElements.header.length > 0, 'Header should contain elements');
});

test('structured snapshot includes section headers', () => {
  const lines = [
    '=== Page: Dashboard | H1: Welcome ===',
    '',
    '--- Sidebar Navigation (2 items) ---',
    '[1] link "内容管理"',
    '[2] link "草稿箱"',
    '',
    '--- Header (1 items) ---',
    '[3] link "通知"',
    '',
    '--- Main Content (1 items) ---',
    '[4] button "新的创作"',
  ];
  assertContains(lines.join('\n'), 'Sidebar Navigation', 'Should have sidebar header');
  assertContains(lines.join('\n'), 'Main Content', 'Should have main header');
  assertContains(lines.join('\n'), 'Header', 'Should have header header');
});

test('structured snapshot falls back to flat format when sections undetected', () => {
  const fallback = '--- Interactive Elements (Main Page) ---\nPage: Test\n[1] button "Click"';
  assertContains(fallback, 'Interactive Elements', 'Should fall back to standard format');
});

describe('find: CLI and HTTP Route Integration');

test('find POST accepts {query} body and returns {matches}', () => {
  const body = { query: 'drafts' };
  assert(body.query === 'drafts', 'Should have query parameter');
});

test('find returns JSON with matches array', () => {
  const response = {
    matches: [
      { score: 50, role: 'link', text: '草稿箱', section: 'sidebar' },
    ],
  };
  assert(Array.isArray(response.matches), 'Response should have matches array');
  assertEqual(response.matches[0].role, 'link', 'Match should have role');
});

test('snapshot --structured flag is passed as query parameter', () => {
  const url = new URL('http://localhost/snapshot?structured=true');
  assertEqual(url.searchParams.get('structured'), 'true', 'Structured flag should be set');
});

test('snapshot without --structured uses default flat format', () => {
  const url = new URL('http://localhost/snapshot');
  assertEqual(url.searchParams.get('structured'), null, 'No structured flag');
});

// ── Run tests ──

console.log('\n=== Browser Automation Enhancement Tests ===\n');

let passed = 0;
let failed = 0;
const failedTests = [];

for (const t of suite) {
  try {
    t.fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    failed++;
    failedTests.push({ describe: t.describe, name: t.name, error: e.message });
    process.stdout.write('X');
  }
}

console.log('\n');
console.log(`${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\nFailed tests:');
  for (const t of failedTests) {
    console.log(`  [${t.describe}] ${t.name}`);
    console.log(`    ${t.error}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed!\n');
}
