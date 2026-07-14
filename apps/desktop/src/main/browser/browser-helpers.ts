/**
 * Browser helpers — JavaScript code injected into the webview page context.
 *
 * Provides:
 *   - piResolveSelector(selector): Resolves Playwright-style selectors to DOM elements
 *   - piSnapshot(): Generates a concise tree of interactive elements with ref IDs
 *
 * Selector formats supported:
 *   - [N] or ref:N          → element with data-pi-ref="N" (from snapshot)
 *   - role=button[name="X"] → ARIA role-based selector
 *   - text="X" or text=X    → element matching text content
 *   - tag:has-text("X")     → CSS element with text content match
 *   - standard CSS          → passed through to querySelector
 */

/** JS code string that defines window.__piHelpers with resolveSelector and snapshot. */
export const BROWSER_HELPERS_JS = `
(function() {
  if (window.__piHelpers) return;
  window.__piHelpers = true;

  // ── Implicit role mapping ──
  function piImplicitRole(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'image';
    if (tag === 'summary') return 'button';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'dialog') return 'dialog';
    return el.getAttribute('role') || tag;
  }

  // ── Get accessible name ──
  function piAccessibleName(el) {
    return el.getAttribute('aria-label')
      || el.getAttribute('alt')
      || el.getAttribute('title')
      || (el.textContent || '').trim().slice(0, 100)
      || el.getAttribute('placeholder')
      || '';
  }

  // ── Check if element is visible ──
  function piIsVisible(el) {
    if (!el || !el.isConnected) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  // ── Selector resolver ──
  window.piResolveSelector = function(selector) {
    if (!selector || typeof selector !== 'string') return null;

    // 1. Ref-based: [N] or ref:N
    var refMatch = selector.match(/^(?:\\[(\\d+)\\]|ref:(\\d+))$/);
    if (refMatch) {
      var refNum = refMatch[1] || refMatch[2];
      return document.querySelector('[data-pi-ref="' + refNum + '"]');
    }

    // 2. role= selector: role=button or role=button[name="Submit"]
    var roleMatch = selector.match(/^role=(\\w+)(?:\\[name="(.+?)"\\])?$/);
    if (roleMatch) {
      var role = roleMatch[1];
      var wantName = roleMatch[2];
      var nativeMap = {
        button: 'button, [role="button"], summary',
        link: 'a[href], [role="link"]',
        textbox: 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [role="textbox"]',
        checkbox: 'input[type="checkbox"], [role="checkbox"]',
        radio: 'input[type="radio"], [role="radio"]',
        combobox: 'select, [role="combobox"]',
        heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
        navigation: 'nav, [role="navigation"]',
        list: 'ul, ol, [role="list"]',
        listitem: 'li, [role="listitem"]',
        image: 'img, [role="img"]',
        tab: '[role="tab"]',
        tabpanel: '[role="tabpanel"]',
        dialog: 'dialog, [role="dialog"]',
        menuitem: '[role="menuitem"]',
        option: 'option, [role="option"]',
        searchbox: 'input[type="search"], [role="searchbox"]',
        slider: 'input[type="range"], [role="slider"]',
        switch: '[role="switch"]',
      };
      var query = nativeMap[role] || '[role="' + role + '"]';
      var candidates = Array.from(document.querySelectorAll(query));
      // Filter to visible
      candidates = candidates.filter(function(el) { return piIsVisible(el); });
      if (!wantName) return candidates[0] || null;
      for (var i = 0; i < candidates.length; i++) {
        var n = piAccessibleName(candidates[i]);
        if (n && n.includes(wantName)) return candidates[i];
      }
      return null;
    }

    // 3. text= selector
    if (selector.startsWith('text=')) {
      var text = selector.slice(5).replace(/^["']|["']$/g, '');
      var interactive = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [onclick], div, span, p, li, td, h1, h2, h3, h4, h5, h6';
      var allEls = Array.from(document.querySelectorAll(interactive));
      // Exact match first
      for (var i = 0; i < allEls.length; i++) {
        if (!piIsVisible(allEls[i])) continue;
        if ((allEls[i].textContent || '').trim() === text) return allEls[i];
      }
      // Partial match
      for (var i = 0; i < allEls.length; i++) {
        if (!piIsVisible(allEls[i])) continue;
        if ((allEls[i].textContent || '').trim().includes(text)) return allEls[i];
      }
      return null;
    }

    // 4. :has-text() pseudo-selector
    var hasTextMatch = selector.match(/^(.+?):has-text\\(["'](.+?)["']\\)$/);
    if (hasTextMatch) {
      var cssPart = hasTextMatch[1];
      var textPart = hasTextMatch[2];
      try {
        var els = Array.from(document.querySelectorAll(cssPart));
        for (var i = 0; i < els.length; i++) {
          if (!piIsVisible(els[i])) continue;
          if ((els[i].textContent || '').trim().includes(textPart)) return els[i];
        }
      } catch(e) {}
      return null;
    }

    // 5. Standard CSS selector
    try {
      var el = document.querySelector(selector);
      return el;
    } catch(e) {
      return null;
    }
  };

  // ── Snapshot: list interactive elements with refs ──
  window.piSnapshot = function() {
    var interactiveSelectors = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
      'label', 'summary',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="textbox"]', '[role="combobox"]', '[role="tab"]', '[role="menuitem"]',
      '[role="option"]', '[role="switch"]', '[role="slider"]',
      '[onclick]', '[contenteditable=""]', '[contenteditable="true"]',
      'details > summary'
    ].join(', ');

    var els = document.querySelectorAll(interactiveSelectors);
    var lines = [];
    var ref = 0;

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!piIsVisible(el)) continue;

      // Skip duplicate refs (element matched by multiple selectors)
      if (el.hasAttribute('data-pi-ref')) continue;

      ref++;
      el.setAttribute('data-pi-ref', String(ref));

      var role = piImplicitRole(el);
      var name = piAccessibleName(el);
      var tag = el.tagName.toLowerCase();
      var type = el.getAttribute('type') || '';
      var placeholder = el.getAttribute('placeholder') || '';
      var nameAttr = el.getAttribute('name') || '';
      var id = el.getAttribute('id') || '';
      var href = el.getAttribute('href') || '';
      var value = el.getAttribute('value') || '';
      var checked = el.checked ? ' [checked]' : '';

      var parts = ['[' + ref + ']', role];

      if (name) {
        parts.push('"' + name.slice(0, 80) + '"');
      }

      var attrs = [];
      if (type && tag === 'input') attrs.push('type=' + type);
      if (placeholder) attrs.push('placeholder="' + placeholder + '"');
      if (nameAttr) attrs.push('name=' + nameAttr);
      if (id && !/^(r\d|vue-|__|react-|aria-|\\d+$|^[a-f0-9]{8}-)/i.test(id)) attrs.push('#' + id);
      if (href && href !== '#' && href !== 'javascript:void(0)') attrs.push('href=' + href.slice(0, 60));
      if (value && tag === 'input' && (type === 'submit' || type === 'button')) attrs.push('value="' + value + '"');
      if (checked) attrs.push(checked.trim());

      if (attrs.length > 0) parts.push('[' + attrs.join(', ') + ']');

      lines.push(parts.join(' '));
    }

    // Also show page heading for context
    var h1 = document.querySelector('h1');
    var title = document.title || '';
    var header = 'Page: ' + title;
    if (h1 && h1.textContent.trim()) header += ' | H1: ' + h1.textContent.trim().slice(0, 80);
    lines.unshift(header);
    lines.unshift('--- Interactive Elements ---');

    return lines.join('\\n');
  };

  // ── Find similar elements (for error suggestions) ──
  window.piFindSimilar = function(selector, limit) {
    limit = limit || 5;
    var interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [onclick]';
    var els = Array.from(document.querySelectorAll(interactive));
    var results = [];
    for (var i = 0; i < els.length && results.length < limit; i++) {
      if (!piIsVisible(els[i])) continue;
      var role = piImplicitRole(els[i]);
      var name = piAccessibleName(els[i]);
      results.push('[' + (results.length + 1) + '] ' + role + ' "' + (name || '').slice(0, 60) + '"');
    }
    return results;
  };
})();
`;
