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

  // ── Page section detection ──
  // Detects common page regions for structured snapshots and meaningful search results.
  function piDetectSections() {
    var sections = {};

    // Detect header (top bar, navigation bar)
    var headerEl = document.querySelector('header, [role="banner"], .header, .navbar, .top-bar, #header, #navbar')
      || (function() {
        // Heuristic: tall element at the very top of the page
        var children = document.body ? Array.from(document.body.children) : [];
        for (var i = 0; i < children.length && i < 5; i++) {
          var c = children[i];
          var r = c.getBoundingClientRect();
          if (r.top >= 0 && r.top < 10 && r.height > 40 && r.height < 200 && r.width > document.documentElement.clientWidth * 0.8) {
            return c;
          }
        }
        return null;
      })();
    if (headerEl) sections.header = headerEl;

    // Detect left sidebar
    var sidebarEl = document.querySelector('aside, [role="complementary"], [role="navigation"], .sidebar, .side-nav, .left-nav, .nav-menu, #sidebar, #side-nav')
      || (function() {
        var children = document.body ? Array.from(document.body.children) : [];
        for (var i = 0; i < children.length && i < 10; i++) {
          var c = children[i];
          var r = c.getBoundingClientRect();
          if (r.left >= 0 && r.left < 10 && r.top > 50 && r.height > 200 && r.width > 100 && r.width < 350) {
            return c;
          }
        }
        return null;
      })();
    if (sidebarEl) sections.sidebar = sidebarEl;

    // Detect footer
    var footerEl = document.querySelector('footer, [role="contentinfo"], .footer, #footer')
      || (function() {
        var children = document.body ? Array.from(document.body.children) : [];
        for (var i = children.length - 1; i >= Math.max(0, children.length - 5); i--) {
          var c = children[i];
          var r = c.getBoundingClientRect();
          if (r.bottom >= document.documentElement.scrollHeight - 30 && r.height > 20 && r.height < 200) {
            return c;
          }
        }
        return null;
      })();
    if (footerEl) sections.footer = footerEl;

    // Detect main content area
    var mainEl = document.querySelector('main, [role="main"], .content, .main-content, #content, #main')
      || document.body;
    if (mainEl) sections.main = mainEl;

    return sections;
  }
  window.piDetectSections = piDetectSections;

  // ── Rank how well an element matches a search query ──
  // Returns a score (higher = better match), 0 = no match.
  function piMatchScore(el, query) {
    var q = query.toLowerCase().trim();
    if (!q) return 0;

    var name = piAccessibleName(el).toLowerCase();
    var role = piImplicitRole(el).toLowerCase();
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    var placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    var cls = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
    var id = (el.getAttribute('id') || '').toLowerCase();
    var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    var title = (el.getAttribute('title') || '').toLowerCase();

    var score = 0;

    // Exact text match on name is the strongest signal
    if (name === q) score += 100;
    // Name contains query
    else if (name.includes(q)) score += 50;
    // Query contains name (e.g., searching "草稿箱 management" and name is "草稿箱")
    else if (q.includes(name) && name.length > 0) score += 40;

    // aria-label match
    if (ariaLabel === q) score += 90;
    else if (ariaLabel.includes(q)) score += 45;

    // title match
    if (title === q) score += 80;
    else if (title.includes(q)) score += 40;

    // placeholder match (for inputs)
    if (placeholder === q) score += 70;
    else if (placeholder.includes(q)) score += 35;

    // Semantic intent: map common search terms to roles
    var intentMap = {
      'search': ['searchbox', 'textbox'],
      'login': ['button', 'link', 'textbox'],
      'sign in': ['button', 'link'],
      'draft': ['link', 'button', 'tab'],
      'create': ['button', 'link'],
      'new': ['button', 'link'],
      'edit': ['button', 'link'],
      'save': ['button'],
      'delete': ['button'],
      'submit': ['button', 'link'],
      'menu': ['navigation', 'list'],
      'setting': ['link', 'button'],
    };
    // Check if query matches any intent keywords
    for (var intent in intentMap) {
      if (intentMap.hasOwnProperty(intent) && q.includes(intent)) {
        var wantRoles = intentMap[intent];
        for (var wr = 0; wr < wantRoles.length; wr++) {
          if (role === wantRoles[wr]) score += 15;
        }
      }
    }

    // Position: prefer elements in sidebar/nav for navigation queries
    if (/(draft|manage|content|article|post|page|menu|nav|setting|home|dashboard|statistic|message|notice|素材|管理|内容|文章|页面|菜单|设置|首页|仪表盘|统计|消息|通知|草稿)/i.test(q)) {
      // These are typical nav/menu items - boost sidebar elements
      var inSidebar = false;
      var sections = piDetectSections();
      if (sections.sidebar && sections.sidebar.contains(el)) {
        score += 10;
        inSidebar = true;
      }
      if (sections.header && sections.header.contains(el) && !inSidebar) {
        // Header nav items are also good navigation targets
        score += 5;
      }
    }

    // Penalize non-interactive roles
    if (role === 'heading' || role === 'image' || role === 'textbox') score -= 10;

    return score;
  }

  // ── Semantic element search ──
  // Search for elements matching a natural language query.
  // Returns structured results with ref IDs, text, role, and page section.
  window.piFind = function(query) {
    if (!query || typeof query !== 'string') return [];

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
    var sections = piDetectSections();
    var scored = [];

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!piIsVisible(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

      var score = piMatchScore(el, query);
      if (score > 0) {
        // Determine which section this element belongs to
        var section = 'main';
        var secNames = Object.keys(sections);
        for (var s = 0; s < secNames.length; s++) {
          if (sections[secNames[s]] && sections[secNames[s]].contains(el)) {
            section = secNames[s];
            break;
          }
        }

        scored.push({
          el: el,
          score: score,
          section: section
        });
      }
    }

    // Sort by score descending
    scored.sort(function(a, b) { return b.score - a.score; });

    // Return top results (max 10)
    var results = [];
    for (var j = 0; j < scored.length && j < 10; j++) {
      var item = scored[j];
      var role = piImplicitRole(item.el);
      var name = piAccessibleName(item.el);
      results.push({
        score: item.score,
        role: role,
        text: name ? name.slice(0, 120) : '',
        section: item.section
      });
    }

    return results;
  };

  // ── Enrich snapshot with section grouping ──
  // Formats the snapshot output grouped by page region (sidebar, header, main, footer).
  window.piSnapshotStructured = function() {
    // Clear old refs
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
    var sections = piDetectSections();
    var seenElements = new Set();
    var sectionElements = { header: [], sidebar: [], main: [], footer: [] };
    var floatingElements = [];
    var ref = 0;

    // Phase 1: classify elements by section
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!piIsVisible(el)) continue;
      if (seenElements.has(el)) continue;
      seenElements.add(el);

      ref++;
      el.setAttribute('data-pi-ref', String(ref));
      var line = formatElement(ref, el);

      // Determine which section
      var placed = false;
      var secNames = Object.keys(sections);
      for (var s = 0; s < secNames.length; s++) {
        if (sections[secNames[s]] && sections[secNames[s]].contains(el)) {
          sectionElements[secNames[s]].push(line);
          placed = true;
          break;
        }
      }
      if (!placed) {
        sectionElements.main.push(line);
      }
    }

    // Phase 2: floating layers
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
        var layerName = container.className
          ? container.className.toString().split(' ').slice(0, 2).join(' ')
          : container.tagName.toLowerCase();
        if (container.getAttribute('role')) {
          layerName = container.getAttribute('role') + ' ("' + layerName.slice(0, 30) + '")';
        }
        floatingElements.push({
          name: layerName,
          elements: layerElements
        });
      }
    }

    // Assemble output
    var lines = [];
    var h1 = document.querySelector('h1');
    var title = document.title || '';
    var header = 'Page: ' + title;
    if (h1 && h1.textContent.trim()) header += ' | H1: ' + h1.textContent.trim().slice(0, 80);

    lines.push('=== ' + header + ' ===');
    lines.push('');

    // Sidebar section (most relevant for navigation)
    if (sectionElements.sidebar.length > 0) {
      lines.push('--- Sidebar Navigation (' + sectionElements.sidebar.length + ' items) ---');
      for (var m = 0; m < sectionElements.sidebar.length; m++) {
        lines.push(sectionElements.sidebar[m]);
      }
      lines.push('');
    }

    // Header section
    if (sectionElements.header.length > 0) {
      lines.push('--- Header (' + sectionElements.header.length + ' items) ---');
      for (var m = 0; m < sectionElements.header.length; m++) {
        lines.push(sectionElements.header[m]);
      }
      lines.push('');
    }

    // Main content
    if (sectionElements.main.length > 0) {
      lines.push('--- Main Content (' + sectionElements.main.length + ' items) ---');
      for (var m = 0; m < sectionElements.main.length; m++) {
        lines.push(sectionElements.main[m]);
      }
      lines.push('');
    }

    // Footer
    if (sectionElements.footer.length > 0) {
      lines.push('--- Footer (' + sectionElements.footer.length + ' items) ---');
      for (var m = 0; m < sectionElements.footer.length; m++) {
        lines.push(sectionElements.footer[m]);
      }
      lines.push('');
    }

    // Floating layers
    for (var fl = 0; fl < floatingElements.length; fl++) {
      lines.push('--- Floating Layer: ' + floatingElements[fl].name + ' ---');
      for (var k = 0; k < floatingElements[fl].elements.length; k++) {
        lines.push(floatingElements[fl].elements[k]);
      }
      lines.push('');
    }

    // Alerts
    var alerts = findAlerts();
    if (alerts.length > 0) {
      lines.push('--- Alerts & Notifications ---');
      for (var a = 0; a < alerts.length; a++) {
        lines.push(alerts[a]);
      }
    }

    return lines.join('\\n');
  };

  // ── Page analysis: classify page type and extract core actions ──
  // Runs after navigate() to help the LLM decide whether to auto-interact.
  // Platform-agnostic: works for WeChat, DingTalk, Xiaohongshu, any OAuth gate.
  window.piAnalyzePage = function() {
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
    var visible = [];
    for (var v = 0; v < els.length; v++) {
      if (piIsVisible(els[v])) visible.push(els[v]);
    }

    // ── Classify page state ──
    var pageState = 'content';
    if (visible.length === 0) {
      pageState = 'empty';
    } else if (visible.length <= 5) {
      // Very few interactive elements -> likely a gate (login, auth, consent)
      pageState = 'gate';
    }

    // Check for error indicators in body text and title
    var bodyText = (document.body && document.body.textContent || '').slice(0, 500).toLowerCase();
    if (/error|not found|404|500|access denied|forbidden|blocked/i.test(bodyText) ||
        /error|not found/i.test((document.title || '').toLowerCase())) {
      if (pageState !== 'empty') pageState = 'error';
    }

    // ── Extract core actions ──
    // Action-oriented buttons/links that the LLM should consider interacting with.
    // Low risk: login, auth, navigate forward. High risk: delete, pay.
    var actionWords = /login|log in|sign.?in|sign.?on|sign.?up|register|auth|authorize|agree|accept|confirm|submit|send|save|next|continue|start|get.?started|enter|go|ok\\b|okay|yes|allow|enable|approve|verify|proceed|got it|i agree|\\u767B\\u5F55|\\u6CE8\\u518C|\\u6388\\u6743|\\u786E\\u8BA4|\\u63D0\\u4EA4|\\u4E0B\\u4E00\\u6B65|\\u786E\\u5B9A|\\u77E5\\u9053\\u4E86|\\u8FDB\\u5165|\\u5F00\\u59CB|\\u63A5\\u53D7|\\u540C\\u610F|\\u5141\\u8BB8|\\u9A8C\\u8BC1|\\u6253\\u5F00|\\u7ACB\\u5373\\u4F53\\u9A8C|\\u7EE7\\u7EED|\\u626B\\u7801/i;
    var dangerWords = /delete|remove|destroy|wipe|erase|clear all|\\u5220\\u9664|\\u6E05\\u9664|\\u6E05\\u7406|\\u89E3\\u6563|\\u6CE8\\u9500/i;
    var paymentWords = /pay|payment|checkout|purchase|buy|upgrade|subscribe|billing|charge|\\u652F\\u4ED8|\\u8D2D\\u4E70|\\u4ED8\\u6B3E|\\u5347\\u7EA7|\\u8BA2\\u9605|\\u5145\\u503C/i;

    var coreActions = [];
    for (var i = 0; i < visible.length && coreActions.length < 10; i++) {
      var el = visible[i];
      var text = (el.textContent || '').trim().slice(0, 80);
      if (!text) continue;

      var role = piImplicitRole(el);
      if (role !== 'button' && role !== 'link') continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

      if (actionWords.test(text)) {
        var risk = 'low';
        if (dangerWords.test(text) || paymentWords.test(text)) {
          risk = 'high';
        }
        coreActions.push({ text: text, risk: risk });
      }
    }

    // ── Check for forms ──
    var hasForm = document.querySelectorAll(
      'form, input[type="text"], input[type="email"], input[type="password"]'
    ).length > 0;

    // ── Generate summary ──
    var summary = '';
    if (pageState === 'gate') {
      if (coreActions.length > 0) {
        var lowRiskActions = [];
        var highRiskActions = [];
        for (var a = 0; a < coreActions.length; a++) {
          if (coreActions[a].risk === 'low') lowRiskActions.push(coreActions[a].text);
          else highRiskActions.push(coreActions[a].text);
        }
        if (lowRiskActions.length > 0) {
          summary = 'Gate page with low-risk action(s): ' + lowRiskActions.map(function(t) { return '"' + t + '"'; }).join(', ') +
            '. Safe to auto-click.';
        } else {
          summary = 'Gate page with actions: ' + coreActions.map(function(a) { return '"' + a.text + '" (' + a.risk + ')'; }).join(', ');
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

    return {
      pageState: pageState,
      elementCount: visible.length,
      coreActions: coreActions,
      hasForm: hasForm,
      summary: summary
    };
  };
})();
`;
