/**
 * com.pi.browser backend — agent tools over the host's embedded browser, plus
 * the panel that hosts it.
 *
 * Tools: browser_navigate / browser_get_state / browser_find / browser_click /
 * browser_fill / browser_hover / browser_select / browser_scroll /
 * browser_evaluate / browser_walk / browser_screenshot /
 * browser_history_search / browser_favorites_list /
 * browser_show / browser_clips_list.
 *
 * The panel (address-bar toolbar + omnibox dropdown) is this plugin's own page;
 * the page binds the host's engine view into its layout via piSDK.liveSlot. The
 * engine view and its persisted session stay host-owned — this plugin only
 * positions it and drives it through browser.* capability calls.
 *
 * Visits and favorites are this plugin's own data, kept in its private storage.
 * The engine owns a back/forward stack and nothing else, and there is exactly
 * one engine view with no tabs — so the omnibox is the only way back to a page
 * you have already seen. That is why both lists live here, in the plugin, and
 * not in the host.
 *
 * The selection popup lives INSIDE the web page. The engine view is a native
 * WebContentsView that occludes this plugin's DOM, so nothing the panel paints
 * can appear over the page content — and the plugin hears no page events. The
 * only page channel is `browser.evaluate` (pull), so the popup is injected
 * into the page as self-contained JS: it renders the toolbar at the selection,
 * and "reports" button clicks through a global the backend polls. Results
 * travel back the same way — the backend calls the injected renderer by name.
 * Cross-origin iframe selections are not seen (the page's own structure, out
 * of reach); the 划词 switch in the panel footer turns the whole thing off.
 */
import { plugin, type PluginContext } from '@pi/plugin-sdk';

/**
 * Loading a page waits on the outside world. The SDK's 30s default is right for
 * a storage read and too short for a slow site, so navigation gets its own.
 */
const NAVIGATE_TIMEOUT_MS = 60_000;

/**
 * The element snapshot is the agent's eyes on the page, but a busy SPA can
 * produce hundreds of elements. Truncate rather than flood the context —
 * browser_find is the precise instrument for anything cut off.
 */
const SNAPSHOT_MAX_CHARS = 8_000;

// ── Omnibox data (plugin-private storage) ────────────────────────────────

const HISTORY_KEY = 'history.entries';
const FAVORITES_KEY = 'favorites.items';
const SETTINGS_KEY = 'settings';

/**
 * Longest history we keep, newest first.
 *
 * Unbounded, this list is both a privacy liability and a write problem: the
 * host rewrites the whole storage file on every `storage.set`, so a year of
 * browsing would make each navigation more expensive than the navigation.
 */
const HISTORY_MAX = 500;

/** Rows shown for an empty query — a launcher, not the whole history. */
const OMNIBOX_RECENT = 8;

/** How many rows a search may return to the panel. */
const OMNIBOX_LIMIT = 30;

/** Strings per history row, and how many rows an agent query returns. */
const HISTORY_TOOL_LIMIT = 20;

/**
 * The engine reports the new URL at `did-navigate`, which is before the new
 * document has a title. Ask again a beat later rather than recording every
 * visit as untitled; the delay is short enough that the omnibox still feels
 * live and long enough for a local page to have parsed its <title>.
 */
const TITLE_REFRESH_MS = 1_200;

// ── Selection popup / clips ──────────────────────────────────────────────

const CLIPS_KEY = 'clips.items';

/**
 * How often the injected page is asked whether the user clicked a popup
 * button. The page cannot push to us — this plugin hears no page events — so
 * polling a single global is the whole return channel. The expression is
 * trivial (one property read) and only runs while a panel is open and the
 * 划词 switch is on.
 */
const SEL_POLL_MS = 400;

/**
 * A selection is pasted into a chat message, so it goes into the model's
 * context. Cap it rather than let a select-all of a long article arrive whole.
 */
const SELECTION_MAX_CHARS = 4_000;

/** Longest clip text we keep. Same reasoning as the selection cap. */
const CLIP_MAX_CHARS = 8_000;

/** Clips are notes, not an archive; the oldest fall off. */
const CLIPS_MAX = 200;

/**
 * How long a 翻译 / 解释 may sit unanswered before the page card stops
 * claiming to be working. Agent turns wait on the user at the permission gate,
 * so this is deliberately generous — it is a "stop pretending" timer, not a
 * timeout that cancels anything.
 */
const NOTE_TIMEOUT_MS = 120_000;

/**
 * When the popup's pending state starts telling the user WHY it is slow. The
 * first browser_show of a session waits at the permission gate in the
 * conversation — from the popup that reads as "翻译中… forever", which is
 * exactly how "点了翻译怎么没反应" happens. The hint names the gate.
 */
const PENDING_HINT_MS = 10_000;

/**
 * When to try injecting into a freshly navigated page. `did-navigate` fires
 * before the document is ready, and an evaluate against a document mid-load
 * can land in an execution context that is about to be thrown away — hence a
 * few attempts rather than one.
 */
const INJECT_ATTEMPTS_MS = [600, 2_000, 4_500];

interface HistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisitedAt: number;
}

interface Favorite {
  url: string;
  title: string;
  addedAt: number;
}

/** A piece of page text the user kept. */
interface Clip {
  id: string;
  text: string;
  url: string;
  title: string;
  at: number;
}

/** What a popup button reports back. */
interface SelAction {
  action: string;
  text: string;
  url?: string;
  title?: string;
  id?: string;
  /** The quoted selection, when the action is `chat` — the user's words ride in `text`. */
  quote?: string | null;
  at?: number;
}

/**
 * The selection popup, as it is injected into the page.
 *
 * Everything the user sees and clicks is in here, because the page is the only
 * place it can be: the engine view covers this plugin's DOM, and a cross-origin
 * page cannot be reached from the panel either. The script therefore owns its
 * own composite popup, fallback card and toast, and talks to the backend
 * through globals:
 *
 *   __piSelAction    written on a button click or Enter; polled AND cleared by
 *                    the backend — the only page→plugin channel there is
 *   __piNoteShow     the backend calls this with a pending / final / timed-out
 *                    result; it renders inline while the popup is open, and
 *                    falls back to the bottom-right card when it is not
 *   __piRenderClips  the backend calls this with the saved clips (and the id
 *                    of the one just kept) to draw the list under the input
 *   __piToast        one-line confirmation for the rare failure path
 *
 * The popup pins itself on the first interaction (focus in the input, any
 * button) — before that it follows the selection and disappears when the
 * selection collapses; pinned, only × / Esc / a new selection closes it, so a
 * half-typed question or an in-flight translation cannot be lost to a stray
 * click. The textarea is the single source of truth for what every action
 * acts on: it is pre-filled with the selection, and the user can trim it
 * before 翻译 or append a question before 发送.
 *
 * The shadow root is `closed` and every style is set through CSSOM, so site CSS
 * cannot bleed in and a site CSP cannot refuse the popup its appearance.
 * Re-running it is a no-op (`already`), which is what makes the per-navigation
 * injection and the self-heal in the poll cheap.
 */
const INJECT_SOURCE = `(function () {
  if (window.__piSelInstalled) return 'already';
  try {
    var host = document.createElement('div');
    host.setAttribute('data-pi-sel-host', '');
    var root = host.attachShadow({ mode: 'closed' });

    function styled(tag, css) {
      var el = document.createElement(tag);
      el.style.cssText = css;
      return el;
    }
    function whenLabel(ts) {
      var d = new Date(ts || 0);
      if (isNaN(d.getTime())) return '';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    var BTN = 'all:unset;cursor:pointer;padding:4px 9px;border-radius:5px;color:#e8eaf0;font:12px/1 system-ui,sans-serif';

    // ── the composite popup ──
    var popup = styled('div',
      'position:fixed;z-index:2147483647;display:none;width:340px;max-width:calc(100vw - 16px);' +
      'padding:8px;border-radius:10px;background:rgba(18,20,28,.96);color:#e8eaf0;' +
      'box-shadow:0 6px 22px rgba(0,0,0,.45)');
    var pinned = false;
    var anchorRect = null;

    var row = styled('div', 'display:flex;gap:4px;align-items:center;margin-bottom:6px');
    function actionBtn(label) {
      var b = styled('button', BTN);
      b.textContent = label;
      b.addEventListener('mouseenter', function () { b.style.background = 'rgba(80,120,255,.85)'; });
      b.addEventListener('mouseleave', function () { b.style.background = 'transparent'; });
      return b;
    }
    var btnTranslate = actionBtn('翻译');
    var btnExplain = actionBtn('解释');
    var btnClip = actionBtn('收藏');
    var btnClose = styled('button',
      'all:unset;cursor:pointer;margin-left:auto;padding:4px 6px;color:#8b93a7;font:14px/1 system-ui,sans-serif');
    btnClose.textContent = '×';
    row.appendChild(btnTranslate);
    row.appendChild(btnExplain);
    row.appendChild(btnClip);
    row.appendChild(btnClose);

    var inputRow = styled('div', 'display:flex;gap:6px;align-items:flex-end');
    var inputBox = styled('div',
      'flex:1;padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,.16);' +
      'background:rgba(255,255,255,.06)');
    // The quote is a chip, not textarea text: a long selection stays one line,
    // and the question field below belongs to the user's words alone.
    var quoteRow = styled('div', 'display:none;margin-bottom:3px');
    var chip = styled('div',
      'display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 5px 3px 8px;' +
      'border-radius:5px;background:rgba(80,120,255,.22);font:11px/1.4 system-ui,sans-serif;color:#c3d2ff');
    var chipText = styled('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px');
    var chipCount = styled('span', 'flex:none;color:#8b93a7');
    var chipX = styled('button',
      'all:unset;cursor:pointer;flex:none;padding:1px 4px;border-radius:4px;color:#8b93a7;' +
      'font:11px/1 system-ui,sans-serif');
    chipX.textContent = '×';
    chip.appendChild(chipText);
    chip.appendChild(chipCount);
    chip.appendChild(chipX);
    quoteRow.appendChild(chip);
    var question = styled('textarea',
      'width:100%;min-height:30px;max-height:78px;resize:none;border:none;padding:4px 4px 0 4px;' +
      'display:block;background:transparent;color:#e8eaf0;font:12px/1.5 system-ui,sans-serif;outline:none');
    question.placeholder = '问点什么,或直接回车发送引用…';
    inputBox.appendChild(quoteRow);
    inputBox.appendChild(question);
    var btnSend = styled('button',
      'all:unset;cursor:pointer;padding:6px 10px;border-radius:6px;background:rgba(80,120,255,.9);' +
      'color:#fff;font:12px/1 system-ui,sans-serif;white-space:nowrap');
    btnSend.textContent = '发送';
    inputRow.appendChild(inputBox);
    inputRow.appendChild(btnSend);

    // The full quoted text lives here — the chip only shows a preview of it.
    var quoteText = null;
    function setQuote(text) {
      quoteText = text;
      if (quoteText) {
        chipText.textContent = '「引用」' + (quoteText.length > 40 ? quoteText.slice(0, 40) + '…' : quoteText);
        chipCount.textContent = quoteText.length > 40 ? '(' + quoteText.length + ' 字)' : '';
        quoteRow.style.display = 'block';
      } else {
        quoteRow.style.display = 'none';
      }
      syncButtons();
    }
    // 翻译/解释/收藏 act on the quote; 发送 needs the quote or a question.
    function syncButtons() {
      var hasQuote = !!quoteText;
      var hasQuestion = !!question.value.trim();
      var three = [btnTranslate, btnExplain, btnClip];
      for (var i = 0; i < three.length; i++) {
        three[i].style.opacity = hasQuote ? '1' : '0.4';
        three[i].style.cursor = hasQuote ? 'pointer' : 'default';
      }
      btnSend.style.opacity = (hasQuote || hasQuestion) ? '1' : '0.4';
      btnSend.style.cursor = (hasQuote || hasQuestion) ? 'pointer' : 'default';
    }
    question.addEventListener('input', syncButtons);
    chipX.addEventListener('click', function () { setQuote(null); });

    // ── the results area (and the clips list) ──
    var results = styled('div', 'display:none;margin-top:6px;max-height:40vh;overflow:auto');
    var resultsHead = styled('div', 'font-weight:600;margin-bottom:4px;color:#9db2ff;font:12px/1 system-ui,sans-serif');
    var resultsBody = styled('div', 'white-space:pre-wrap;word-break:break-word');
    results.appendChild(resultsHead);
    results.appendChild(resultsBody);

    popup.appendChild(row);
    popup.appendChild(inputRow);
    popup.appendChild(results);

    // ── the fallback card, for results that arrive after the popup is gone ──
    var card = styled('div',
      'position:fixed;right:12px;bottom:12px;z-index:2147483647;display:none;max-width:340px;max-height:42vh;' +
      'overflow:auto;padding:10px 30px 10px 12px;border-radius:10px;background:rgba(18,20,28,.96);' +
      'color:#e8eaf0;box-shadow:0 6px 20px rgba(0,0,0,.4);font:12.5px/1.6 system-ui,sans-serif;' +
      'white-space:pre-wrap;word-break:break-word');
    var cardTitle = styled('div', 'font-weight:600;margin-bottom:4px;color:#9db2ff;font:12.5px/1.4 system-ui,sans-serif');
    var cardBody = styled('div', '');
    var cardClose = styled('button',
      'all:unset;cursor:pointer;position:absolute;top:8px;right:9px;color:#8b93a7;font:14px/1 system-ui,sans-serif');
    cardClose.textContent = '×';
    cardClose.addEventListener('click', function () { card.style.display = 'none'; });
    card.appendChild(cardTitle);
    card.appendChild(cardBody);
    card.appendChild(cardClose);

    // ── one-line toast, for the failure paths only ──
    var toast = styled('div',
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:none;' +
      'padding:6px 14px;border-radius:16px;background:rgba(18,20,28,.92);color:#e8eaf0;' +
      'font:12px/1 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3)');
    var toastTimer = null;

    root.appendChild(popup);
    root.appendChild(card);
    root.appendChild(toast);
    document.documentElement.appendChild(host);

    // ── popup lifecycle ──
    function hidePopup() {
      popup.style.display = 'none';
      pinned = false;
    }
    function place() {
      var w = popup.offsetWidth || 340;
      var h = popup.offsetHeight || 130;
      var left = anchorRect ? Math.round(anchorRect.left) : 12;
      left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w - 8));
      var top = anchorRect ? Math.round(anchorRect.bottom + 6) : 12;
      if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 12);
      popup.style.left = Math.round(left) + 'px';
      popup.style.top = Math.round(top) + 'px';
    }
    function showPopup(text) {
      pinned = false;
      card.style.display = 'none';
      results.style.display = 'none';
      resultsBody.textContent = '';
      resultsHead.textContent = '';
      setQuote(text && text.trim() ? String(text) : null);
      question.value = '';
      // No autofocus: selecting-to-copy must keep working like on any page.
      popup.style.display = 'block';
      place();
    }
    // The popup grows when results arrive; re-clamp it inside the viewport.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        if (popup.style.display !== 'none') place();
      }).observe(popup);
    }

    function pin() { pinned = true; }
    function report(action, extra) {
      window.__piSelAction = {
        action: action,
        text: '',
        url: location.href,
        title: document.title,
        at: Date.now()
      };
      if (extra) {
        for (var k in extra) window.__piSelAction[k] = extra[k];
      }
    }
    function showResult(title, body) {
      resultsHead.textContent = title;
      resultsBody.textContent = body || '';
      results.style.display = 'block';
    }

    // ── selection tracking ──
    function onMouseUp(e) {
      // Mouseups inside our own popup are interactions, not selections.
      if (e && e.composedPath && e.composedPath().indexOf(host) >= 0) return;
      setTimeout(function () {
        var s = document.getSelection();
        var text = String(s || '').trim();
        if (!text) {
          // A plain click elsewhere: dismiss only if nothing was started here.
          if (!pinned && popup.style.display !== 'none') hidePopup();
          return;
        }
        // Fresh selection — new popup, even over a pinned one.
        anchorRect = s.rangeCount ? s.getRangeAt(0).getBoundingClientRect() : null;
        showPopup(String(s));
      }, 0);
    }
    function onSelectionChange() {
      if (pinned) return;
      if (!String(document.getSelection() || '').trim() && popup.style.display !== 'none') hidePopup();
    }
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    // The popup must stay under its text: whenever the page moves under it —
    // scroll, panel resize, fullscreen transitions, zoomFactor changes — the
    // anchor is re-derived from the live selection (which survives all of
    // those) and the popup is re-placed. Without this the popup hangs where
    // the layout used to put the text.
    function reanchor() {
      if (popup.style.display === 'none') return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) anchorRect = r;
      }
      if (anchorRect) place();
    }
    function onScroll() {
      if (popup.style.display === 'none') return;
      var s = document.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) { anchorRect = r; place(); return; }
      }
      // The text is gone (cleared selection): a pinned popup stays put — the
      // user pinned it on purpose; an unpinned one has no reason to exist.
      if (!pinned) hidePopup();
    }
    function onResize() {
      reanchor();
      // Fullscreen/maximize transitions animate; the final layout settles
      // after the resize event, so place once more when it has.
      setTimeout(reanchor, 250);
    }
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    // zoomFactor changes (auto-fit and manual zoom) relayout the page WITHOUT
    // firing a window resize — matchMedia sees the device pixel ratio move.
    var zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
    var onZoomMq = function () {
      zoomMq.removeEventListener('change', onZoomMq);
      reanchor();
      zoomMq = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)');
      zoomMq.addEventListener('change', onZoomMq);
    };
    zoomMq.addEventListener('change', onZoomMq);

    // ── actions ──
    question.addEventListener('focus', pin);
    question.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hidePopup();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    btnClose.addEventListener('click', hidePopup);

    btnTranslate.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('翻译', { text: quoteText.slice(0, 8000) });
      showResult('翻译中…', '');
    });
    btnExplain.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('解释', { text: quoteText.slice(0, 8000) });
      showResult('解释中…', '');
    });
    btnClip.addEventListener('click', function () {
      if (!quoteText) return;
      pin();
      report('收藏', { text: quoteText.slice(0, 8000) });
      showResult('收藏', '…');
    });

    function doSend() {
      var q = String(question.value || '').trim();
      if (!quoteText && !q) return;
      pin();
      // Question and quote travel separately: the backend composes the message.
      report('chat', { text: q, quote: quoteText ? quoteText.slice(0, 8000) : null });
      // The reply lands in the conversation — the popup is a launcher, not a chat.
      showResult('已发送 →', '回答在对话里,继续追问也在对话进行。');
    }
    btnSend.addEventListener('click', doSend);

    // ── the backend's handles into this UI ──
    window.__piNoteShow = function (payload) {
      if (!payload) return;
      var kind = payload.kind || '';
      var inPopup = popup.style.display !== 'none';
      var pendingText = '';
      if (payload.state === 'pending-hint') {
        pendingText = '还没回来 — 多半是第一次调用在等授权:去对话里点「总是允许」,本次会话就不再问了。';
      }
      if (payload.state === 'pending' || payload.state === 'pending-hint') {
        var head = kind === 'explain' ? '解释中…' : kind === 'chat' ? '思考中…' : '翻译中…';
        if (inPopup) { showResult(head, pendingText); }
        else { cardTitle.textContent = head; cardBody.textContent = pendingText; card.style.display = 'block'; }
        return;
      }
      if (payload.state === 'timeout') {
        var tmsg = '等得有点久了 — 去对话里看看进度。';
        if (inPopup) { showResult('还在等结果', tmsg); }
        else { cardTitle.textContent = '还在等结果'; cardBody.textContent = tmsg; card.style.display = 'block'; }
        return;
      }
      var title = payload.title || (kind === 'explain' ? '解释' : kind === 'translate' ? '译文' : kind === 'chat' ? '回答' : '结果');
      if (inPopup) { showResult(title, payload.text || ''); }
      else { cardTitle.textContent = title; cardBody.textContent = payload.text || ''; card.style.display = 'block'; }
    };
    window.__piRenderClips = function (clips, newestId) {
      resultsHead.textContent = '收藏的文字';
      resultsBody.textContent = '';
      var list = Array.isArray(clips) ? clips : [];
      for (var i = 0; i < list.length; i++) {
        (function (clip) {
          var item = styled('div',
            'position:relative;padding:6px 24px 6px 8px;border-radius:6px;margin-bottom:4px;' +
            'border-left:3px solid ' + (clip.id === newestId ? 'rgba(110,150,255,.95)' : 'rgba(255,255,255,.16)') + ';' +
            'background:rgba(255,255,255,.05)');
          var t = styled('div',
            'font:12.5px/1.5 system-ui,sans-serif;color:#e8eaf0;white-space:pre-wrap;word-break:break-word;' +
            'max-height:3.6em;overflow:hidden');
          t.textContent = clip.text && clip.text.length > 120 ? clip.text.slice(0, 120) + '…' : (clip.text || '');
          var src = styled('div', 'font:11px/1 system-ui,sans-serif;color:#8b93a7;margin-top:3px');
          src.textContent = (clip.title || clip.url || '') + (clip.at ? ' · ' + whenLabel(clip.at) : '');
          var x = styled('button',
            'all:unset;cursor:pointer;position:absolute;top:6px;right:4px;color:#8b93a7;font:11px/1 system-ui,sans-serif;padding:2px 3px');
          x.textContent = '×';
          x.addEventListener('click', function () {
            window.__piSelAction = { action: 'removeClip', id: clip.id, at: Date.now() };
          });
          item.appendChild(t);
          item.appendChild(src);
          item.appendChild(x);
          resultsBody.appendChild(item);
        })(list[i]);
      }
      if (!list.length) {
        var empty = styled('div', 'font:11px/1 system-ui,sans-serif;color:#8b93a7;padding:4px 0');
        empty.textContent = '还没有收藏的文字';
        resultsBody.appendChild(empty);
      }
      results.style.display = 'block';
    };
    window.__piToast = function (msg) {
      toast.textContent = String(msg || '');
      toast.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.style.display = 'none'; }, 1800);
    };
    window.__piSelDisable = function () {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      zoomMq.removeEventListener('change', onZoomMq);
      if (host.parentNode) host.parentNode.removeChild(host);
      window.__piSelInstalled = false;
      window.__piSelAction = null;
    };

    window.__piSelInstalled = true;
    window.__piSelAction = null;
    return 'installed';
  } catch (e) {
    return 'failed: ' + (e && e.message ? e.message : String(e));
  }
})()`;

/**
 * One evaluate that both reads and consumes a pending click, and reports
 * whether the popup is still installed. Self-healing: a site that re-renders
 * and drops our host node is detected here and re-injected, instead of leaving
 * the user with a feature that silently stopped working.
 */
const SEL_POLL_EXPR = `window.__piSelAction
  ? (function () { var a = JSON.stringify(window.__piSelAction); window.__piSelAction = null; return a; })()
  : (window.__piSelInstalled ? '' : 'REINSTALL')`;

/** Panels currently mounted (backend → UI pushes go to all of them). */
const mountedPanels = new Set<string>();
/** Last URL the host reported — pushed to freshly mounted panels. */
let lastUrl = '';

/** Newest first. Every change is written straight through to storage. */
let history: HistoryEntry[] = [];
let favorites: Favorite[] = [];
/** Kept page text, newest first. */
let clips: Clip[] = [];
/** On, navigations are not recorded. Favorites still work — they are explicit. */
let privateMode = false;
/** On, the selection popup is injected into pages. */
let selPopup = true;

/** The poll that carries popup clicks back. Runs only while a panel is open. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollTicks = 0;
/** Injection attempts for the current navigation, cancelled on the next one. */
let injectTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The 翻译 / 解释 we are waiting on, so the page card can stop saying "翻译中…"
 * if the answer never comes back through browser_show.
 */
let pendingNote: { kind: string; at: number; hinted?: boolean } | null = null;

/**
 * The page key the last visit was recorded for.
 *
 * `did-navigate-in-page` fires for same-page anchors too, so without this every
 * jump to a `#section` would land in the history as its own visit.
 */
let lastRecordedKey = '';
let titleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Resolves once storage has been read. Every mutation awaits it: a navigation
 * arriving while the initial read is still in flight would otherwise be folded
 * into an empty list and then wiped by the load finishing behind it.
 */
let loaded: Promise<void> = Promise.resolve();

// ── Small helpers ────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The engine reports failures as `{ error }` instead of throwing; surface them. */
function actionResult(prefix: string, r: { error?: string }, extra = ''): string {
  return r.error ? `${prefix}失败: ${r.error}` : `${prefix}成功${extra}`;
}

function normalizeUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('missing url');
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

/**
 * History is keyed on the URL without its hash: `#top` is the same page, and
 * the engine reports hash changes as navigations of their own.
 */
function urlKey(url: string): string {
  return String(url).split('#')[0];
}

/** Only real web pages are recorded — about:blank and in-app pages are not "somewhere". */
function isRecordable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isFavorite(url: string): boolean {
  const key = urlKey(url);
  return favorites.some((f) => urlKey(f.url) === key);
}

/** `今天 14:23` — relative while it is still "recent", absolute once it is not. */
function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, now)) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Query matching for the omnibox and the agent tool alike: every whitespace
 * separated token must appear somewhere in the title or the URL. "github react"
 * means both words, in either field, in any order.
 */
function matchesQuery(entry: { url: string; title: string }, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = `${entry.title} ${entry.url}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function tokensOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// ── Storage ──────────────────────────────────────────────────────────────

async function readKey(ctx: PluginContext, key: string): Promise<unknown> {
  try {
    return await ctx.call('storage.get', { key });
  } catch {
    // Storage is unavailable (the smoke host has none, and a first run has no
    // file yet). An empty list is the right answer either way.
    return undefined;
  }
}

async function save(ctx: PluginContext, key: string, value: unknown, what: string): Promise<void> {
  try {
    await ctx.call('storage.set', { key, value });
  } catch (err) {
    // Worth a line in the app log: the user's next session silently loses what
    // they just did, and nothing else would ever say why.
    ctx.log.warn(`could not persist ${what}: ${describe(err)}`);
  }
}

async function loadState(ctx: PluginContext): Promise<void> {
  const [h, f, c, s] = await Promise.all([
    readKey(ctx, HISTORY_KEY),
    readKey(ctx, FAVORITES_KEY),
    readKey(ctx, CLIPS_KEY),
    readKey(ctx, SETTINGS_KEY),
  ]);
  if (Array.isArray(h)) history = h as HistoryEntry[];
  if (Array.isArray(f)) favorites = f as Favorite[];
  if (Array.isArray(c)) clips = c as Clip[];
  const settings = s as { private?: boolean; selPopup?: boolean } | undefined;
  privateMode = Boolean(settings?.private);
  // On unless the user turned it off — an absent key is a first run, not a "no".
  selPopup = settings?.selPopup !== false;
}

// ── History recording ────────────────────────────────────────────────────

/**
 * Fold one navigation into the history. Returns the entry when something
 * changed, or null when the visit is not worth a row (private mode, a non-http
 * page, or an anchor jump on the page we are already on).
 */
function recordVisit(url: string, title: string): HistoryEntry | null {
  if (privateMode || !isRecordable(url)) return null;
  const key = urlKey(url);
  const known = history.find((e) => e.url === key);

  if (key === lastRecordedKey) {
    // Same page. Learn the title if we just did, but do not count a visit.
    if (known && title && known.title !== title) {
      known.title = title;
      return known;
    }
    return null;
  }
  lastRecordedKey = key;

  const now = Date.now();
  if (known) {
    known.visits += 1;
    known.lastVisitedAt = now;
    if (title) known.title = title;
    // Re-visiting hoists the entry: the list is ordered by recency.
    history = [known, ...history.filter((e) => e !== known)];
    return known;
  }

  const entry: HistoryEntry = { url: key, title, visits: 1, lastVisitedAt: now };
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  return entry;
}

/**
 * Push the current page to every mounted panel, with the state the toolbar
 * needs to draw itself: the star's fill and the private-mode badge.
 */
function pushUrl(ctx: PluginContext, url: string, title?: string): void {
  lastUrl = url;
  const data = {
    url,
    title: title ?? history.find((e) => e.url === urlKey(url))?.title ?? '',
    favorited: isFavorite(url),
    private: privateMode,
  };
  for (const panelId of mountedPanels) ctx.send(panelId, 'ui.urlChanged', data);
}

function broadcast(ctx: PluginContext, event: string, data?: unknown): void {
  for (const panelId of mountedPanels) ctx.send(panelId, event, data);
}

/**
 * After a navigation, ask the engine for the title the page has settled on and
 * fill it into the history entry we just wrote. Debounced: a redirect chain
 * fires several urlChanged events and only the last one's title matters.
 */
function scheduleTitleRefresh(ctx: PluginContext): void {
  if (titleTimer) clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    titleTimer = null;
    void refreshTitle(ctx);
  }, TITLE_REFRESH_MS);
}

async function refreshTitle(ctx: PluginContext): Promise<void> {
  let state: { url?: string; title?: string } | undefined;
  try {
    state = await ctx.call<{ url?: string; title?: string }>('browser.getUrl');
  } catch {
    return; // engine gone; the entry keeps whatever title it has
  }
  const url = String(state?.url ?? '');
  const title = String(state?.title ?? '');
  if (!url || !title) return;

  const entry = history.find((e) => e.url === urlKey(url));
  if (entry && entry.title !== title) {
    entry.title = title;
    void save(ctx, HISTORY_KEY, history, 'history');
  }
  // The panel drew itself at did-navigate, when there was no title yet.
  if (urlKey(url) === urlKey(lastUrl)) pushUrl(ctx, url, title);
}

// ── Omnibox queries ──────────────────────────────────────────────────────

function searchOmnibox(query: string): { favorites: Favorite[]; history: HistoryEntry[] } {
  const tokens = tokensOf(query);
  const favHits = favorites.filter((f) => matchesQuery(f, tokens));
  const histHits = history.filter((e) => matchesQuery(e, tokens));
  // Empty query = the launcher: every favorite (they are curated, so few and
  // all of them are wanted) plus the most recent visits.
  const histLimit = tokens.length === 0 ? OMNIBOX_RECENT : OMNIBOX_LIMIT;
  return {
    favorites: favHits.slice(0, OMNIBOX_LIMIT),
    history: histHits.slice(0, histLimit),
  };
}

// ── Selection popup: inject, poll, act ───────────────────────────────────

/** Run the injection once; idempotent inside the page itself. */
async function injectOnce(ctx: PluginContext): Promise<boolean> {
  if (!isRecordable(lastUrl)) return false;
  try {
    const r = await ctx.call<{ result?: string }>(
      'browser.evaluate',
      { expression: INJECT_SOURCE },
      { timeoutMs: 5_000 },
    );
    return r?.result === 'installed' || r?.result === 'already';
  } catch {
    // Mid-load navigation: the execution context is gone. The next attempt
    // (or the poll's self-heal) will catch it.
    return false;
  }
}

/**
 * Install the popup into the page that just loaded. Several attempts because
 * `did-navigate` precedes document readiness; each one is cheap, and the
 * page-side guard makes repeats free.
 */
function scheduleInject(ctx: PluginContext): void {
  if (!selPopup) return;
  if (injectTimer) clearTimeout(injectTimer);
  let attempt = 0;
  const tryNext = (): void => {
    if (attempt >= INJECT_ATTEMPTS_MS.length) return;
    const delay = INJECT_ATTEMPTS_MS[attempt++];
    injectTimer = setTimeout(() => {
      injectTimer = null;
      void injectOnce(ctx).then((ok) => {
        if (!ok) tryNext();
      });
    }, delay);
  };
  tryNext();
}

/** Call something the injected script defined, if it is still there. */
async function callInjected<T>(ctx: PluginContext, call: string): Promise<T | undefined> {
  if (!isRecordable(lastUrl)) return undefined;
  try {
    const r = await ctx.call<{ result?: T }>('browser.evaluate', { expression: call }, { timeoutMs: 5_000 });
    return r?.result;
  } catch {
    return undefined;
  }
}

/** Show a state of the note card in the page. Returns false when the page lost the injection. */
async function showNoteInPage(
  ctx: PluginContext,
  payload: { state: string; kind?: string; title?: string; text?: string },
): Promise<boolean> {
  const r = await callInjected<unknown>(ctx, `window.__piNoteShow ? (window.__piNoteShow(${JSON.stringify(payload)}), true) : false`);
  return r === true;
}

async function toastInPage(ctx: PluginContext, message: string): Promise<void> {
  await callInjected(ctx, `window.__piToast ? (window.__piToast(${JSON.stringify(message)}), true) : false`);
}

/**
 * One poll tick. Reads (and consumes) a pending click, re-installs a popup a
 * re-rendering page dropped, and retires a note that never came back.
 */
async function pollTick(ctx: PluginContext): Promise<void> {
  if (!selPopup || !isRecordable(lastUrl)) return;

  let raw: string | undefined;
  try {
    const r = await ctx.call<{ result?: string }>(
      'browser.evaluate',
      { expression: SEL_POLL_EXPR },
      { timeoutMs: 5_000 },
    );
    raw = r?.result;
  } catch {
    return; // engine busy or mid-navigation; the next tick will try again
  }

  if (raw === 'REINSTALL') {
    void injectOnce(ctx);
    return;
  }
  if (raw) {
    try {
      await handleAction(ctx, JSON.parse(raw) as SelAction);
    } catch (err) {
      ctx.log.warn(`selection action failed: ${describe(err)}`);
    }
  }

  if (pendingNote) {
    const age = Date.now() - pendingNote.at;
    if (age > NOTE_TIMEOUT_MS) {
      const kind = pendingNote.kind;
      pendingNote = null;
      void showNoteInPage(ctx, { state: 'timeout', kind });
    } else if (age > PENDING_HINT_MS && !pendingNote.hinted) {
      // Still nothing — name the likely reason: the permission gate.
      pendingNote.hinted = true;
      void showNoteInPage(ctx, { state: 'pending-hint', kind: pendingNote.kind });
    }
  }
}

/**
 * Start/stop the poll. Runs only while at least one panel has ever mounted;
 * every ~8s it probes whether any of them is still alive, because the host
 * reports no unmount — without the probe the poll would outlive the panel
 * forever, quietly evaluating in the page twice a second.
 */
let probeFailures = 0;

function syncPoll(ctx: PluginContext): void {
  const shouldRun = selPopup && mountedPanels.size > 0;
  if (shouldRun && !pollTimer) {
    pollTimer = setInterval(() => void pollTick(ctx), SEL_POLL_MS);
    pollTicks = 0;
  } else if (!shouldRun && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // The liveness probe rides on the tick counter, off the critical path.
  if (pollTimer && ++pollTicks % Math.round(8_000 / SEL_POLL_MS) === 0) {
    void (async () => {
      for (const panelId of mountedPanels) {
        if (await ctx.panelAlive(panelId, 1_000)) {
          probeFailures = 0;
          return; // someone is listening
        }
      }
      // One missed pong can be a busy page (a long agent task blocking the
      // panel's JS); two in a row means the panel is really gone. A real
      // remount re-adds itself and restarts the poll.
      probeFailures += 1;
      if (probeFailures >= 2) {
        probeFailures = 0;
        mountedPanels.clear();
        syncPoll(ctx);
      }
    })();
  }
}

/** What the agent is asked, per action. 翻译/解释 demand browser_show; the chip quote rides along in the prompt. */
function agentTaskPrompt(kind: '翻译' | '解释', text: string, url: string): string {
  if (kind === '翻译') {
    return (
      `把下面的网页内容翻译成中文。译文不要写在回复里 — 调用 browser_show 工具展示给用户 ` +
      `(kind 填 "translate",text 填完整译文,不要省略或概括)。原文:\n\n${text}\n\n(来自 ${url})`
    );
  }
  return (
    `向用户解释下面的网页内容:它讲的是什么、关键点是什么。解释也调用 browser_show 工具展示 ` +
    `(kind 填 "explain")。内容:\n\n${text}\n\n(来自 ${url})`
  );
}

/** Rows of clips the popup's 收藏 list shows. */
const CLIPS_RENDER_MAX = 10;

/** Draw (redraw) the clips list in the page, with one entry highlighted as newest. */
async function renderClipsInPage(ctx: PluginContext, newestId: string | null): Promise<void> {
  await callInjected(
    ctx,
    `window.__piRenderClips ? (window.__piRenderClips(${JSON.stringify(clips.slice(0, CLIPS_RENDER_MAX))}, ${JSON.stringify(
      newestId,
    )}), true) : false`,
  );
}

/** Dispatch one reported popup click. */
async function handleAction(ctx: PluginContext, action: SelAction): Promise<void> {
  const text = String(action.text ?? '').trim().slice(0, SELECTION_MAX_CHARS);
  const url = String(action.url ?? lastUrl ?? '');

  switch (action.action) {
    case '翻译':
    case '解释': {
      if (!text) return;
      const kind = action.action as '翻译' | '解释';
      // The page labels its card from the short key; the agent gets the
      // instruction in its own words below.
      const kindKey = kind === '翻译' ? 'translate' : 'explain';
      pendingNote = { kind: kindKey, at: Date.now() };
      // The textarea is the source of truth: what the user (possibly) trimmed
      // is what gets translated, not the raw selection.
      await showNoteInPage(ctx, { state: 'pending', kind: kindKey });
      try {
        await ctx.call('chat.send', { text: agentTaskPrompt(kind, text, url) });
      } catch (err) {
        pendingNote = null;
        ctx.log.warn(`chat.send failed: ${describe(err)}`);
        void showNoteInPage(ctx, {
          state: 'done',
          kind: kindKey,
          title: '发送失败',
          text: `没能把内容发进对话: ${describe(err)}`,
        });
      }
      return;
    }
    case 'chat': {
      // The popup sends the question (textarea) and the quote (chip) as two
      // fields; here they become one message — either alone is sendable.
      const question = text;
      const quote = String(action.quote ?? '').trim().slice(0, SELECTION_MAX_CHARS);
      const parts: string[] = [];
      if (question) parts.push(question);
      if (quote) parts.push(`「引用」${quote}`);
      if (parts.length === 0) return;
      parts.push(`(来自网页: ${url})`);
      // The user is looking at the popup, not the conversation — the answer
      // must come back through browser_show or it lands where they aren't.
      // The conversation keeps the full reply; the popup gets the short form.
      parts.push(
        '(这条消息来自划词弹框:回答时请调用 browser_show 工具把简明回答展示到弹框 — kind 填 "chat"、' +
          'title 填 "回答",一两句话说清即可。对话里正常完整作答,两者内容不要互相重复。)',
      );
      try {
        await ctx.call('chat.send', { text: parts.join('\n\n') });
      } catch (err) {
        ctx.log.warn(`chat.send failed: ${describe(err)}`);
        void toastInPage(ctx, '发送到对话失败');
      }
      return;
    }
    case '收藏': {
      if (!text) return;
      const clip: Clip = {
        id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        text: text.slice(0, CLIP_MAX_CHARS),
        url,
        title: String(action.title ?? ''),
        at: Date.now(),
      };
      clips = [clip, ...clips].slice(0, CLIPS_MAX);
      await save(ctx, CLIPS_KEY, clips, 'clips');
      // The list IS the confirmation — and the only place a clip can be
      // deleted from, which is why the popup gets it right away.
      await renderClipsInPage(ctx, clip.id);
      return;
    }
    case 'removeClip': {
      const id = String(action.id ?? '');
      if (!id) return;
      clips = clips.filter((c) => c.id !== id);
      await save(ctx, CLIPS_KEY, clips, 'clips');
      await renderClipsInPage(ctx, null);
      return;
    }
    default:
      ctx.log.warn(`unknown selection action: ${action.action}`);
  }
}

/** Turn the popup on or off: install/remove in the live page + start/stop the poll. */
async function setSelPopup(ctx: PluginContext, on: boolean): Promise<void> {
  selPopup = on;
  if (!on) {
    if (injectTimer) clearTimeout(injectTimer);
    await callInjected(ctx, 'window.__piSelDisable ? (window.__piSelDisable(), true) : false');
  } else {
    scheduleInject(ctx);
  }
  syncPoll(ctx);
}

// ── Plugin ───────────────────────────────────────────────────────────────

plugin({
  async onInit(ctx) {
    loaded = loadState(ctx);
    // Seed from the engine so a panel mounted before the first host event
    // still shows the right address.
    try {
      const state = await ctx.call<{ url?: string }>('browser.getUrl');
      if (state?.url) lastUrl = state.url;
    } catch {
      /* engine not connected yet — the host event will fill it in */
    }
  },

  async onPanelMounted(panelId, _params, ctx) {
    mountedPanels.add(panelId);
    await loaded;
    // The popup only matters while someone can see the page — and the poll
    // that carries its clicks back is what "someone is looking" buys.
    syncPoll(ctx);
    scheduleInject(ctx);
    // Ask the engine rather than trusting the cached URL — the panel may have
    // been closed while agent tools navigated elsewhere.
    try {
      const state = await ctx.call<{ url?: string; title?: string }>('browser.getUrl');
      if (state?.url) {
        pushUrl(ctx, state.url, state.title);
      } else if (lastUrl) {
        pushUrl(ctx, lastUrl);
      }
    } catch {
      /* engine unreachable — fall back to whatever we last heard */
      if (lastUrl) pushUrl(ctx, lastUrl);
    }
  },

  async onRequest(panelId, method, params, ctx) {
    void panelId;
    await loaded;
    // Panel methods follow the `domain.verb` convention the other plugins use;
    // `state.get` is the shared boot pull.
    switch (method) {
      case 'nav.open': {
        const result = await ctx.call<{ url?: string; title?: string }>(
          'browser.navigate',
          { url: normalizeUrl(params.url) },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        if (result?.url) lastUrl = result.url;
        return { url: result?.url ?? '', title: result?.title ?? '' };
      }
      case 'nav.back':
        await ctx.call('browser.back');
        return { ok: true };
      case 'nav.forward':
        await ctx.call('browser.forward');
        return { ok: true };
      case 'nav.reload':
        await ctx.call('browser.reload');
        return { ok: true };
      case 'state.get': {
        const state = await ctx.call<{ url?: string; title?: string }>('browser.getUrl');
        if (state?.url) lastUrl = state.url;
        return {
          url: state?.url ?? '',
          title: state?.title ?? '',
          favorited: isFavorite(state?.url ?? ''),
          private: privateMode,
          selPopup,
          clips: clips.length,
        };
      }

      // ── Omnibox ──
      case 'omnibox.search': {
        const found = searchOmnibox(String(params.query ?? '').trim());
        return { favorites: found.favorites, history: found.history };
      }
      case 'favorites.toggle': {
        // No url = the star in the toolbar, which means "the page I am on".
        const url = urlKey(String(params.url ?? lastUrl ?? '').trim());
        if (!url) throw new Error('no page to favorite yet');
        const existing = favorites.find((f) => urlKey(f.url) === url);
        let favorited: boolean;
        if (existing) {
          favorites = favorites.filter((f) => f !== existing);
          favorited = false;
        } else {
          favorites.unshift({
            url,
            title: String(params.title ?? '').trim() || history.find((e) => e.url === url)?.title || '',
            addedAt: Date.now(),
          });
          favorited = true;
        }
        await save(ctx, FAVORITES_KEY, favorites, 'favorites');
        // Two panels can be open on the same engine; both stars follow.
        broadcast(ctx, 'ui.favoritesChanged', { favorites });
        if (url === urlKey(lastUrl)) pushUrl(ctx, lastUrl);
        return { favorited, url };
      }
      case 'favorites.remove': {
        const url = urlKey(String(params.url ?? '').trim());
        if (!url) throw new Error('missing url');
        favorites = favorites.filter((f) => urlKey(f.url) !== url);
        await save(ctx, FAVORITES_KEY, favorites, 'favorites');
        broadcast(ctx, 'ui.favoritesChanged', { favorites });
        if (url === urlKey(lastUrl)) pushUrl(ctx, lastUrl);
        return { ok: true };
      }
      case 'history.clear':
        history = [];
        lastRecordedKey = urlKey(lastUrl);
        await save(ctx, HISTORY_KEY, history, 'history');
        broadcast(ctx, 'ui.historyCleared');
        return { ok: true };

      case 'settings.setPrivate': {
        privateMode = params.private === true;
        await save(ctx, SETTINGS_KEY, { private: privateMode, selPopup }, 'settings');
        broadcast(ctx, 'ui.settingsChanged', { private: privateMode, selPopup });
        return { private: privateMode };
      }
      case 'settings.setSelPopup': {
        await setSelPopup(ctx, params.on === true);
        await save(ctx, SETTINGS_KEY, { private: privateMode, selPopup }, 'settings');
        broadcast(ctx, 'ui.settingsChanged', { private: privateMode, selPopup });
        return { selPopup };
      }

      default:
        throw new Error(
          `unknown panel method: ${method} (known: nav.open, nav.back, nav.forward, nav.reload, ` +
            `state.get, omnibox.search, favorites.toggle, favorites.remove, history.clear, ` +
            `settings.setPrivate, settings.setSelPopup)`,
        );
    }
  },

  async onHostEvent(event, data, ctx) {
    if (event !== 'browser.urlChanged') return;
    await loaded;
    const url = String((data as { url?: string })?.url ?? '');
    if (!url) return;
    // The engine keeps no history of its own — this event is the only record
    // that a navigation happened.
    if (recordVisit(url, '')) void save(ctx, HISTORY_KEY, history, 'history');
    pushUrl(ctx, url);
    scheduleTitleRefresh(ctx);
    // A new document: the popup (if the user wants it) must be installed in it.
    scheduleInject(ctx);
  },

  async onTool(name, params, ctx) {
    // The agent is driving the shared engine — surface the panel, so the user
    // watches the page the agent works on instead of a silent background
    // browser. Page-changing tools reveal the column (focus=true); in-page
    // operations only badge a hidden panel (no-focus-steal: the page is either
    // already on screen or a rail dot says enough).
    //
    // browser_show is the exception that proves it: its whole job is putting
    // something in front of the user, and that something renders inside the
    // page — a hidden column would swallow it.
    const reveal =
      name === 'browser_navigate' ||
      name === 'browser_walk' ||
      name === 'browser_screenshot' ||
      name === 'browser_show';
    void ctx.openPanel('browser', { focus: reveal }).catch(() => {});
    switch (name) {
      case 'browser_navigate': {
        const url = normalizeUrl(params.url);
        const result = await ctx.call<{ url?: string; title?: string }>(
          'browser.navigate',
          { url },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        const finalUrl = result?.url ?? url;
        return `已打开 ${finalUrl}${result?.title ? ` — ${result.title}` : ''}`;
      }

      case 'browser_get_state': {
        const state = await ctx.call<{
          url?: string;
          title?: string;
          snapshot?: string;
        }>('browser.getState');
        const lines = [
          `当前页面: ${state?.url ?? '(about:blank)'}${state?.title ? ` — ${state.title}` : ''}`,
        ];
        if (state?.snapshot) {
          const snap =
            state.snapshot.length > SNAPSHOT_MAX_CHARS
              ? `${state.snapshot.slice(0, SNAPSHOT_MAX_CHARS)}\n…(快照已截断,要找具体元素用 browser_find)`
              : state.snapshot;
          lines.push('', '可交互元素(引用 ref 可直接传给 browser_click / browser_fill):', snap);
        }
        return lines.join('\n');
      }

      case 'browser_find': {
        const query = String(params.query ?? '').trim();
        if (!query) throw new Error('missing query');
        const matches = await ctx.call<
          Array<{ score: number; role: string; text: string; section: string }>
        >('browser.find', { query });
        if (matches.length === 0) return `页面上没有匹配 "${query}" 的元素`;
        return matches
          .map((m) => `[${m.role}] "${m.text}" (${m.section}, 匹配度 ${m.score})`)
          .join('\n');
      }

      case 'browser_click': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ clicked: boolean; error?: string }>('browser.click', {
          selector,
        });
        return actionResult(`点击 "${selector}"`, r);
      }

      case 'browser_fill': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ error?: string }>('browser.fill', {
          selector,
          value: String(params.value ?? ''),
        });
        return actionResult(`填写 "${selector}"`, r);
      }

      case 'browser_hover': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ hovered: boolean; error?: string }>('browser.hover', {
          selector,
        });
        return actionResult(`悬停 "${selector}"`, r);
      }

      case 'browser_select': {
        const selector = String(params.selector ?? '').trim();
        if (!selector) throw new Error('missing selector');
        const r = await ctx.call<{ selected: boolean; error?: string }>('browser.select', {
          selector,
          value: String(params.value ?? ''),
        });
        return actionResult(`在 "${selector}" 选中 "${params.value}"`, r);
      }

      case 'browser_scroll': {
        const r = await ctx.call<{ direction: string; amount: number }>('browser.scroll', {
          direction: params.direction,
          amount: params.amount,
        });
        return `已${r.direction === 'up' ? '向上' : '向下'}滚动 ${r.amount}px`;
      }

      case 'browser_evaluate': {
        const expression = String(params.expression ?? '');
        if (!expression.trim()) throw new Error('missing expression');
        const r = await ctx.call<{ result: unknown }>('browser.evaluate', { expression });
        return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      }

      case 'browser_walk': {
        const goal = String(params.goal ?? '').trim();
        if (!goal) throw new Error('missing goal');
        const r = await ctx.call<{
          goal: string;
          url?: string;
          title?: string;
          reached: boolean;
          steps: Array<{ text: string; ok?: boolean }>;
        }>(
          'browser.walk',
          { goal, maxSteps: params.maxSteps },
          { timeoutMs: NAVIGATE_TIMEOUT_MS },
        );
        const stepLines = r.steps.map((s, i) => `${i + 1}. 点击 "${s.text}"${s.ok === false ? ' ✗' : ''}`);
        const head = r.reached ? `已到达目标 "${goal}"` : `未能到达目标 "${goal}"`;
        return [head, `当前: ${r.url ?? '?'}`, ...stepLines].join('\n');
      }

      case 'browser_screenshot': {
        const shot = await ctx.call<{ base64?: string }>('browser.screenshot', {
          fullPage: params.fullPage === true,
        });
        if (!shot?.base64) throw new Error('screenshot failed: the host returned no image data');
        const kb = Math.round((shot.base64.length * 3) / 4 / 1024);
        return {
          content: [
            { type: 'text', text: `截图完成 (${kb} KB PNG)` },
            { type: 'image', data: shot.base64, mimeType: 'image/png' },
          ],
        };
      }

      // ── Where have we been, what did the user keep ──
      case 'browser_history_search': {
        const query = String(params.query ?? '').trim();
        const limit = clampLimit(params.limit, HISTORY_TOOL_LIMIT, 100);
        const tokens = tokensOf(query);
        const rows = history.filter((e) => matchesQuery(e, tokens)).slice(0, limit);
        if (rows.length === 0) {
          return query
            ? `历史记录里没有匹配 "${query}" 的页面(共 ${history.length} 条)`
            : '历史记录是空的——还没有打开过任何网页。';
        }
        return rows
          .map(
            (e, i) =>
              `${i + 1}. ${e.title || '(无标题)'}\n   ${e.url} · ${formatWhen(e.lastVisitedAt)} · 访问 ${e.visits} 次`,
          )
          .join('\n');
      }

      case 'browser_favorites_list': {
        if (favorites.length === 0) {
          return '用户还没有收藏任何网站(浏览器面板地址栏左边的星标按钮可以收藏)。';
        }
        return favorites
          .map((f, i) => `${i + 1}. ${f.title || '(无标题)'}\n   ${f.url}`)
          .join('\n');
      }

      /**
       * The only way a result reaches the user's selection popup. The user
       * asked for this to be shown there, so the popup is the primary target;
       * the conversation keeps the tool call either way.
       */
      case 'browser_show': {
        const text = String(params.text ?? '').trim();
        if (!text) throw new Error('missing text');
        const title = String(params.title ?? '').trim();
        const kind = String(params.kind ?? '').trim();
        pendingNote = null;
        const shown = await showNoteInPage(ctx, { state: 'done', kind, title, text });
        // The user may be looking at another panel. A badge is the only signal
        // the rail can carry, and it costs nothing when the panel is open.
        void ctx.setBadge('browser', shown ? null : '•');
        if (shown) return '已展示在浏览器页面的弹框里。';
        return '当前网页已离开,没能弹出来——内容已保留在本次工具结果里,面板角标做了标记。';
      }

      case 'browser_clips_list': {
        const query = String(params.query ?? '').trim();
        const tokens = tokensOf(query);
        const rows = clips
          .filter((c) => matchesQuery({ url: c.url, title: `${c.title} ${c.text}` }, tokens))
          .slice(0, HISTORY_TOOL_LIMIT);
        if (rows.length === 0) {
          return query
            ? `收藏的文字里没有匹配 "${query}" 的内容(共 ${clips.length} 条)`
            : '用户还没有收藏过网页文字(在网页里选中文字,点弹出的「收藏」即可)。';
        }
        return rows
          .map((c, i) => {
            const body = c.text.length > 120 ? `${c.text.slice(0, 120)}…` : c.text;
            return `${i + 1}. ${body}\n   — 来自 ${c.title || c.url}(${formatWhen(c.at)})`;
          })
          .join('\n\n');
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
});
