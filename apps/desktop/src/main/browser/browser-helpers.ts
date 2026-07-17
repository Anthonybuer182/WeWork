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
  window.piIsVisible = piIsVisible;

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
    // Clear old refs so re-snapshotting after interactions gives fresh ref IDs
    var oldRefs = document.querySelectorAll('[data-pi-ref]');
    for (var r = 0; r < oldRefs.length; r++) {
      oldRefs[r].removeAttribute('data-pi-ref');
    }

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

    // --- Phase 1: Main page elements ---
    var mainElements = [];
    var seenElements = new Set();

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!piIsVisible(el)) continue;
      if (seenElements.has(el)) continue;
      seenElements.add(el);

      ref++;
      el.setAttribute('data-pi-ref', String(ref));
      mainElements.push(formatElement(ref, el));
    }

    // --- Phase 2: Floating layer detection (dropdowns, modals, tooltips) ---
    var floatingContainers = findFloatingContainers();

    for (var fc = 0; fc < floatingContainers.length; fc++) {
      var container = floatingContainers[fc];
      var floatingEls = container.querySelectorAll(interactiveSelectors);
      var layerElements = [];

      for (var j = 0; j < floatingEls.length; j++) {
        var fel = floatingEls[j];
        if (!piIsVisible(fel)) continue;
        if (seenElements.has(fel)) continue;
        seenElements.add(fel);

        ref++;
        fel.setAttribute('data-pi-ref', String(ref));
        layerElements.push(formatElement(ref, fel));
      }

      if (layerElements.length > 0) {
        // Add section header
        var layerName = container.className
          ? container.className.toString().split(' ').slice(0, 2).join(' ')
          : container.tagName.toLowerCase();
        if (container.getAttribute('role')) {
          layerName = container.getAttribute('role') + ' ("' + layerName.slice(0, 30) + '")';
        }
        lines.push('');
        lines.push('--- Floating Layer: ' + layerName + ' ---');
        for (var k = 0; k < layerElements.length; k++) {
          lines.push(layerElements[k]);
        }
      }
    }

    // --- Assemble output: main page elements first, then floating layers ---
    for (var m = 0; m < mainElements.length; m++) {
      lines.push(mainElements[m]);
    }

    // --- Add alerts / toasts / notifications that are visible ---
    var alerts = findAlerts();
    if (alerts.length > 0) {
      lines.push('');
      lines.push('--- Alerts & Notifications ---');
      for (var a = 0; a < alerts.length; a++) {
        lines.push(alerts[a]);
      }
    }

    var h1 = document.querySelector('h1');
    var title = document.title || '';
    var header = 'Page: ' + title;
    if (h1 && h1.textContent.trim()) header += ' | H1: ' + h1.textContent.trim().slice(0, 80);
    lines.unshift(header);
    lines.unshift('--- Interactive Elements (Main Page) ---');

    return lines.join('\\n');
  };

  // ── Find visible alerts, toasts, notifications, and validation messages ──
  function findAlerts() {
    var results = [];
    var selectors = [
      '[role="alert"]', '[role="status"]', '[role="log"]',
      '.toast', '.notification', '.snackbar', '.alert',
      '[class*="toast"]', '[class*="notification"]', '[class*="snackbar"]',
      '[data-toast]', '[data-notification]', '[data-alert]'
    ];
    var seen = new Set();
    for (var s = 0; s < selectors.length; s++) {
      try {
        var els = document.querySelectorAll(selectors[s]);
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (!piIsVisible(el)) continue;
          if (seen.has(el)) continue;
          seen.add(el);
          var text = (el.textContent || '').trim().slice(0, 200);
          if (text.length > 0) {
            var role = el.getAttribute('role') || 'notification';
            results.push('[alert-' + role + '] "' + text + '"');
          }
        }
      } catch(e) {}
    }
    // Also detect inline form validation errors
    try {
      var validationErrors = document.querySelectorAll('[aria-invalid="true"], .error, .field-error, .form-error, [class*="has-error"] .error-text, [class*="is-invalid"] ~ * [class*="invalid"]');
      for (var v = 0; v < validationErrors.length; v++) {
        var eel = validationErrors[v];
        if (!piIsVisible(eel)) continue;
        if (seen.has(eel)) continue;
        seen.add(eel);
        var vtext = (eel.textContent || '').trim().slice(0, 200);
        if (vtext.length > 0) {
          results.push('[alert-validation] "' + vtext + '"');
        }
      }
    } catch(e) {}
    return results;
  }

  // ── Format a single element line for snapshot output ──
  function formatElement(ref, el) {
    var role = piImplicitRole(el);
    var name = piAccessibleName(el);
    var tag = el.tagName.toLowerCase();
    var type = el.getAttribute('type') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    var nameAttr = el.getAttribute('name') || '';
    var id = el.getAttribute('id') || '';
    var href = el.getAttribute('href') || '';
    var value = el.getAttribute('value') || '';

    var parts = ['[' + ref + ']', role];

    if (name) {
      parts.push('"' + name.slice(0, 80) + '"');
    }

    var attrs = [];
    if (type && tag === 'input') attrs.push('type=' + type);
    if (placeholder) attrs.push('placeholder="' + placeholder + '"');
    if (nameAttr) attrs.push('name=' + nameAttr);
    if (id && !/^(r\\d|vue-|__|react-|aria-|\\d+$|^[a-f0-9]{8}-)/i.test(id)) attrs.push('#' + id);
    if (href && href !== '#' && href !== 'javascript:void(0)') attrs.push('href=' + href.slice(0, 60));
    if (value && tag === 'input' && (type === 'submit' || type === 'button')) attrs.push('value="' + value + '"');

    // State flags
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      attrs.push('disabled');
    }
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') {
      attrs.push('readonly');
    }
    if (el.checked) {
      attrs.push('checked');
    }
    if (el.getAttribute('aria-checked') === 'true') {
      attrs.push('checked');
    }
    if (el.getAttribute('aria-busy') === 'true') {
      attrs.push('loading');
    }
    // Detect loading spinners via common class names
    if (!el.disabled) {
      var cls = (el.className && typeof el.className === 'string') ? el.className : '';
      if (/(?:spinner|spinning|loader|loading|progress)/i.test(cls)) {
        attrs.push('loading');
      }
    }

    // Position hint: above or below fold
    var rect = el.getBoundingClientRect();
    var foldY = window.innerHeight * 0.9;
    if (rect.top > foldY) {
      attrs.push('below-fold');
    }

    if (attrs.length > 0) parts.push('[' + attrs.join(', ') + ']');

    return parts.join(' ');
  }

  // ── Find floating overlay containers (dropdowns, modals, tooltips, popups) ──
  function findFloatingContainers() {
    var containers = [];
    var allDivs = document.querySelectorAll('div, ul, ol, section, aside, [role="listbox"], [role="menu"], [role="dialog"], [role="tooltip"], [role="alertdialog"], [role="presentation"]');

    for (var i = 0; i < allDivs.length; i++) {
      var el = allDivs[i];
      if (!el.isConnected) continue;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      // Detect as floating layer if any of:
      var isFloating = false;

      // 1. ARIA role that indicates overlay
      var role = el.getAttribute('role') || '';
      if (role === 'listbox' || role === 'menu' || role === 'dialog' || role === 'tooltip' || role === 'alertdialog') {
        isFloating = true;
      }

      // 2. High z-index position:fixed/absolute container (> 10 means intentional overlay)
      if (!isFloating && (cs.position === 'fixed' || cs.position === 'absolute')) {
        var zIndex = parseInt(cs.zIndex, 10);
        if (zIndex > 10) isFloating = true;
      }

      // 3. Element has visible children and matches common dropdown/popup patterns
      if (!isFloating && el.children.length > 0 && el.children.length <= 50) {
        var cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
        if (/(dropdown|popup|popover|overlay|menu|suggest|select|autocomplete|tooltip|modal|drawer)/.test(cls)) {
          var zIdx = parseInt(cs.zIndex, 10);
          if (zIdx > 0 || cs.position === 'absolute' || cs.position === 'fixed') {
            isFloating = true;
          }
        }
      }

      if (isFloating) {
        // Check if it has visible interactive children
        var interactive = el.querySelector('a[href], button, input, [role="option"], [role="menuitem"], [onclick], li, span');
        if (interactive && piIsVisible(interactive)) {
          containers.push(el);
        }
      }
    }

    // Deduplicate: remove containers that are descendants of another floating container
    var deduped = [];
    for (var d = 0; d < containers.length; d++) {
      var isChild = false;
      for (var p = 0; p < containers.length; p++) {
        if (d !== p && containers[p].contains(containers[d])) {
          isChild = true;
          break;
        }
      }
      if (!isChild) deduped.push(containers[d]);
    }

    return deduped;
  }

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
