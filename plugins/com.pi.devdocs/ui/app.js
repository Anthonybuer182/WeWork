/*
 * com.pi.devdocs — the docs panel page.
 *
 * Deliberately the simplest panel in the repo: a static page, no backend, no
 * build step. It IS the "minimal plugin" the guide describes — manifest.json
 * plus a web page, nothing else. window.piSDK comes from the SDK the host
 * injects into <head> at serve time, which also applies the shell's theme
 * tokens; this page never calls piSDK itself.
 *
 * The markdown lives in the repo's docs/ and is copied into ui/docs/ by
 * scripts/sync-devdocs.mjs — the repo file is the single source of truth,
 * never edit ui/docs/ directly. marked is vendored into ui/lib/.
 */
'use strict';

/** The document catalogue. Adding a doc = one entry here + the synced file. */
var DOCS = [
  { id: 'plugin-dev-guide', title: '插件开发指南', file: './docs/plugin-dev-guide.md' },
];

var content = document.getElementById('content');
var toc = document.getElementById('toc');
var docTitle = document.getElementById('doc-title');
var toast = document.getElementById('toast');
var toastTimer = null;

/** Sections of the currently rendered doc, for the scroll spy. */
var spyHeadings = [];
var activeSection = '';

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1800);
}

/** Copy text anywhere: async Clipboard API first, textarea fallback for
 *  whatever context refuses clipboard-write. */
function copyText(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback);
  } else {
    fallback();
  }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      showToast('复制失败');
    }
    document.body.removeChild(ta);
  }
}

/**
 * Post-process the rendered HTML: heading ids for the TOC, copy buttons on
 * code blocks, and external links. The markdown is first-party (the repo's
 * own docs, served from the plugin's own origin), so there is no sanitizer —
 * the same trust model as the shell rendering its own UI.
 */
function postProcess() {
  var headings = [];
  var hs = content.querySelectorAll('h2');
  for (var i = 0; i < hs.length; i++) {
    hs[i].id = 'sec-' + i;
    headings.push({ id: hs[i].id, text: hs[i].textContent });
  }

  // An external link must not navigate THIS view away — the docs page would
  // be replaced and the panel with it. Copy the URL instead; this becomes an
  // openExternal the day the protocol grows that capability.
  var links = content.querySelectorAll('a[href]');
  for (var j = 0; j < links.length; j++) {
    (function (a) {
      var href = a.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) return;
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        copyText(href, function () { showToast('链接已复制:' + href); });
      });
    })(links[j]);
  }

  // Copy button on every code block. The wrapper owns positioning; the pre
  // keeps its own horizontal scroll under the button.
  var pres = content.querySelectorAll('pre');
  for (var k = 0; k < pres.length; k++) {
    (function (pre) {
      var wrap = document.createElement('div');
      wrap.className = 'codewrap';
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        copyText(pre.textContent, function () { showToast('已复制'); });
      });
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      wrap.appendChild(btn);
    })(pres[k]);
  }
  return headings;
}

function setActive(id) {
  if (activeSection === id) return;
  activeSection = id;
  var chips = toc.children;
  for (var i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('active', chips[i].getAttribute('data-target') === id);
  }
}

function buildToc(headings) {
  toc.innerHTML = '';
  for (var i = 0; i < headings.length; i++) {
    (function (h) {
      var chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.textContent = h.text;
      chip.setAttribute('data-target', h.id);
      chip.addEventListener('click', function () {
        var el = document.getElementById(h.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActive(h.id);
      });
      toc.appendChild(chip);
    })(headings[i]);
  }
}

// Scroll spy: the last section heading above the sticky bars wins. The bars
// are 35px + ~38px tall; a small slack keeps the first section highlighted
// on open.
window.addEventListener('scroll', function () {
  var line = 88;
  var active = spyHeadings.length ? spyHeadings[0].id : '';
  for (var i = 0; i < spyHeadings.length; i++) {
    var el = document.getElementById(spyHeadings[i].id);
    if (el && el.getBoundingClientRect().top <= line + 8) active = spyHeadings[i].id;
  }
  setActive(active);
}, { passive: true });

function renderError(err) {
  content.innerHTML = '';
  var box = document.createElement('div');
  box.className = 'errorbox';
  box.textContent = '文档加载失败:' + (err && err.message ? err.message : err);
  content.appendChild(box);
}

function open(doc) {
  docTitle.textContent = doc.title;
  content.innerHTML = '<p class="loading">加载中…</p>';
  toc.innerHTML = '';
  spyHeadings = [];
  fetch(doc.file)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + doc.file);
      return r.text();
    })
    .then(function (md) {
      if (typeof marked === 'undefined' || !marked.parse) {
        throw new Error('marked 未加载(ui/lib/marked.umd.js)');
      }
      content.innerHTML = marked.parse(md);
      var headings = postProcess();
      buildToc(headings);
      spyHeadings = headings;
      activeSection = '';
      window.scrollTo(0, 0);
    })
    .catch(renderError);
}

open(DOCS[0]);
