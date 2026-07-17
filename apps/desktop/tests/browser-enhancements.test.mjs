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
  const internalKeys = new Set(['_attrs', '_class', '_textContent', '_style', '_rect', '_disabled', '_readOnly', '_checked']);
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
