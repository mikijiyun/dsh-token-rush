// dsh-token-rush — browser half.
//
// This is the built-artifact form the module system expects: a classic script
// that registers a factory with window.__ModuleLoader__.load({ id, factory }).
// Hand-written plain JS (no build step): the factory body is the plugin bundle
// and requires `react` through the module table's platform seed.
//
// The plugin registers one additive entry into the frame-wide `shell.overlay`
// seat: a small floating HUD window.
//   - Default position: workspace top-left (12, 56); draggable anywhere.
//   - Opacity 0 and pointer-events none before a conversation starts; it
//     fades to semi-transparent once the current session is engaging/active.
//   - Wall-clock peak check (official Beijing-time windows) turns it orange-red;
//     otherwise it follows the DSH theme tokens.
//   - Live stats: current-session total tokens (tokenUsage projection),
//     estimated spend (official per-model prices), and account balance
//     (host /api/token-rush/balance).

window.__ModuleLoader__.load({
  id: 'dsh-token-rush',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var inject = ['slots', 'sessions'];

    var STORAGE_KEY = 'dsh-token-rush/pos';
    var DEFAULT_POS = { x: 12, y: 56 };
    var DEFAULT_WINDOWS = [[9, 12], [14, 18]];
    var DEFAULT_TZ = 'Asia/Shanghai';
    var HUD_POLL_MS = 60000;

    // Fallback price table (CNY per 1M tokens); the host /peak response
    // overrides it when reachable.
    var DEFAULT_PRICES = {
      'deepseek-v4-flash': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
      'deepseek-v4-flash-vision-exp': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
      'deepseek-v4-pro': { inputMiss: { off: 4.5, peak: 9.0 }, inputHit: { off: 0.15, peak: 0.3 }, output: { off: 13.5, peak: 27.0 } },
      'deepseek-chat': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
      'deepseek-reasoner': { inputMiss: { off: 4.5, peak: 9.0 }, inputHit: { off: 0.15, peak: 0.3 }, output: { off: 13.5, peak: 27.0 } },
    };

    function priceFor(modelId, prices) {
      if (typeof modelId === 'string' && prices[modelId]) return prices[modelId];
      if (typeof modelId === 'string') {
        for (var key of Object.keys(prices)) {
          if (modelId.indexOf(key) === 0) return prices[key];
        }
      }
      return prices['deepseek-v4-flash'] || DEFAULT_PRICES['deepseek-v4-flash'];
    }

    function isPeakNowLocal(now, windows, tz) {
      var hour;
      var weekday;
      var weekdaysList = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      try {
        var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
        hour = Number(parts.find(function (p) { return p.type === 'hour'; }).value);
        weekday = parts.find(function (p) { return p.type === 'weekday'; }).value;
      } catch (err) {
        hour = now.getHours();
        weekday = weekdaysList[now.getDay()];
      }
      if (weekday === 'Sat' || weekday === 'Sun') return false;
      var list = windows && windows.length > 0 ? windows : DEFAULT_WINDOWS;
      for (var i = 0; i < list.length; i += 1) {
        if (hour >= list[i][0] && hour < list[i][1]) return true;
      }
      return false;
    }

    function fmtTokens(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(Math.round(n));
    }

    function fmtMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '\u2014';
      return '\u00a5' + n.toFixed(2);
    }

    function fmtNum(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '0';
      return n.toFixed(2);
    }

    function clamp(v, min, max) {
      if (max < min) return min;
      return Math.min(Math.max(v, min), max);
    }

    function loadSavedPos() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
        }
      } catch (err) {
        /* storage may be unavailable; keep the default */
      }
      return DEFAULT_POS;
    }

    function savePos(pos) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
      } catch (err) {
        /* non-fatal */
      }
    }

    function apply(ctx) {
      // Mirrors the host-side peak definition so the HUD stays honest even if
      // the /peak route is unreachable before the plugin row mounts.
      ctx.effect(
        function () {
          return ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register(
              { name: 'shell.overlay', id: 'token-rush', order: 100 },
              function TokenRushWindow(props) {
                var useSessions = props.useSessions;
                var current = typeof useSessions === 'function'
                  ? useSessions(function (s) { return s ? s.current : undefined; })
                  : undefined;

                var conversationState = React.useState({ started: false, model: null });
                var conversation = conversationState[0];
                var setConversation = conversationState[1];
                var usageState = React.useState(null);
                var usage = usageState[0];
                var setUsage = usageState[1];
                var peakState = React.useState({ peak: false, windows: DEFAULT_WINDOWS, tz: DEFAULT_TZ, prices: DEFAULT_PRICES });
                var peak = peakState[0];
                var setPeak = peakState[1];
                var balanceState = React.useState(undefined);
                var balance = balanceState[0];
                var setBalance = balanceState[1];
                var posState = React.useState(loadSavedPos);
                var pos = posState[0];
                var setPos = posState[1];

                // ── live session data: conversation phase + tokenUsage projection ──
                React.useEffect(function () {
                  var binding;
                  try {
                    binding = ctx.sessions && typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(current) : undefined;
                  } catch (err) {
                    binding = undefined;
                  }
                  if (!binding || !binding.session || !binding.session.projections) {
                    setConversation({ started: false, model: null });
                    setUsage(null);
                    return;
                  }
                  var session = binding.session;
                  var usageFace = session.projections.faceOf('tokenUsage');
                  var read = function () {
                    var snap = session.getSnapshot();
                    var phase = snap ? snap.composerPhase : undefined;
                    var nodes = snap && (snap.nodes || (snap.chat && snap.chat.legacy && snap.chat.legacy.nodes));
                    var started = phase === 'engaging' || phase === 'active' || Boolean(nodes && nodes.length > 0);
                    var model = null;
                    if (nodes && nodes.length) {
                      for (var i = nodes.length - 1; i >= 0; i -= 1) {
                        var node = nodes[i];
                        var m = node && ((node.provenance && node.provenance.model) || (node.requestConfig && node.requestConfig.model));
                        if (typeof m === 'string' && m !== '') { model = m; break; }
                      }
                    }
                    var u = usageFace.getSnapshot();
                    setConversation({ started: started, model: model });
                    setUsage(u && typeof u === 'object' ? u : null);
                  };
                  var unsubSession = session.subscribe(read);
                  var unsubUsage = usageFace.subscribe(read);
                  read();
                  return function () {
                    unsubSession();
                    unsubUsage();
                  };
                }, [current]);

                // ── peak check + balance poll (host answers; local fallback) ──
                var peakRef = React.useRef({ windows: DEFAULT_WINDOWS, tz: DEFAULT_TZ, prices: DEFAULT_PRICES });
                React.useEffect(function () {
                  var load = function () {
                    fetch('/api/token-rush/peak', { cache: 'no-store' })
                      .then(function (r) { return r.json(); })
                      .then(function (j) {
                        if (j && j.ok) {
                          var next = {
                            peak: Boolean(j.peak),
                            windows: j.windows && j.windows.length > 0 ? j.windows : peakRef.current.windows,
                            tz: j.tz || peakRef.current.tz,
                            prices: j.prices || peakRef.current.prices,
                          };
                          peakRef.current = next;
                          setPeak(next);
                        } else {
                          setPeak({
                            peak: isPeakNowLocal(new Date(), peakRef.current.windows, peakRef.current.tz),
                            windows: peakRef.current.windows,
                            tz: peakRef.current.tz,
                            prices: peakRef.current.prices,
                          });
                        }
                      })
                      .catch(function () {
                        setPeak({
                          peak: isPeakNowLocal(new Date(), peakRef.current.windows, peakRef.current.tz),
                          windows: peakRef.current.windows,
                          tz: peakRef.current.tz,
                          prices: peakRef.current.prices,
                        });
                      });
                    fetch('/api/token-rush/balance', { cache: 'no-store' })
                      .then(function (r) { return r.json(); })
                      .then(function (j) { setBalance(j); })
                      .catch(function () { setBalance({ ok: false, code: 'fetch-error' }); });
                  };
                  load();
                  var timer = window.setInterval(load, HUD_POLL_MS);
                  return function () { window.clearInterval(timer); };
                }, []);

                // ── keep the window inside the viewport on resize ──
                React.useEffect(function () {
                  var onResize = function () {
                    setPos(function (prev) {
                      var el = window.document.getElementById('dsh-token-rush-window');
                      var w = el ? el.offsetWidth : 216;
                      var h = el ? el.offsetHeight : 84;
                      return {
                        x: clamp(prev.x, 4, Math.max(4, window.innerWidth - w - 4)),
                        y: clamp(prev.y, 4, Math.max(4, window.innerHeight - h - 4)),
                      };
                    });
                  };
                  window.addEventListener('resize', onResize);
                  return function () { window.removeEventListener('resize', onResize); };
                }, []);

                // ── derived numbers ──
                var totals = null;
                if (usage && typeof usage === 'object') {
                  var missIn = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
                  var hitIn = usage.cacheReadTokens || 0;
                  var outTok = usage.outputTokens || 0;
                  totals = { input: missIn + hitIn, output: outTok };
                }
                var totalTokens = totals ? totals.input + totals.output : 0;
                var prices = peak.prices || DEFAULT_PRICES;
                var price = priceFor(conversation.model, prices);
                var bucket = peak.peak ? 'peak' : 'off';
                var cost = 0;
                if (usage && typeof usage === 'object') {
                  cost = ((usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0)) * price.inputMiss[bucket]
                    + (usage.cacheReadTokens || 0) * price.inputHit[bucket]
                    + (usage.outputTokens || 0) * price.output[bucket];
                  cost = cost / 1000000;
                }

                var balanceLine = '\u67e5\u8be2\u4e2d\u2026';
                var balanceTip = '';
                if (balance) {
                  if (balance.ok) {
                    var entry = null;
                    var list = balance.balances || [];
                    for (var i = 0; i < list.length; i += 1) {
                      if (String(list[i].currency).toUpperCase() === 'CNY') { entry = list[i]; break; }
                    }
                    if (!entry && list.length > 0) entry = list[0];
                    if (entry) {
                      var cur = String(entry.currency || '').toUpperCase();
                      balanceLine = cur === 'CNY' ? fmtMoney(Number(entry.total)) : (cur + ' ' + fmtMoney(Number(entry.total)));
                      balanceTip = '\u5145\u503c ' + fmtMoney(Number(entry.toppedUp)) + ' \u00b7 \u8d60\u9001 ' + fmtMoney(Number(entry.granted));
                    } else {
                      balanceLine = '\u2014';
                      balanceTip = '\u8d26\u6237\u65e0\u4f59\u989d\u4fe1\u606f';
                    }
                  } else if (balance.code === 'no-api-key') {
                    balanceLine = '\u672a\u914d\u7f6e Key';
                    balanceTip = '\u5728 \u8bbe\u7f6e \u2192 \u6a21\u578b \u4e2d\u914d\u7f6e DeepSeek API Key\uff08' + (balance.apiKeyEnv || 'DEEPSEEK_API_KEY') + '\uff09';
                  } else {
                    balanceLine = '\u4f59\u989d\u4e0d\u53ef\u7528';
                    balanceTip = balance.message || balance.code || '\u67e5\u8be2\u5931\u8d25';
                  }
                }

                // ── drag ──
                var dragging = React.useRef(null);
                var onPointerDown = function (e) {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  var el = window.document.getElementById('dsh-token-rush-window');
                  var rect = el ? el.getBoundingClientRect() : { left: pos.x, top: pos.y, width: 216, height: 84 };
                  var offX = e.clientX - rect.left;
                  var offY = e.clientY - rect.top;
                  var last = { x: pos.x, y: pos.y };
                  dragging.current = { moved: false };
                  var move = function (ev) {
                    if (!dragging.current) return;
                    dragging.current.moved = true;
                    last = {
                      x: clamp(ev.clientX - offX, 4, Math.max(4, window.innerWidth - rect.width - 4)),
                      y: clamp(ev.clientY - offY, 4, Math.max(4, window.innerHeight - rect.height - 4)),
                    };
                    setPos(last);
                  };
                  var up = function () {
                    if (typeof window.document.removeEventListener === 'function') {
                      window.document.removeEventListener('pointermove', move);
                      window.document.removeEventListener('pointerup', up);
                    }
                    if (dragging.current && dragging.current.moved) savePos(last);
                    dragging.current = null;
                  };
                  if (typeof window.document.addEventListener === 'function') {
                    window.document.addEventListener('pointermove', move);
                    window.document.addEventListener('pointerup', up);
                  }
                };
                var onDoubleClick = function () {
                  setPos(DEFAULT_POS);
                  savePos(DEFAULT_POS);
                };

                var started = conversation.started;
                var windowStyle = Object.assign({
                  position: 'fixed',
                  left: pos.x,
                  top: pos.y,
                  zIndex: 2147483000,
                  width: 216,
                  padding: '8px 10px 9px',
                  borderRadius: 10,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: 'inherit',
                  userSelect: 'none',
                  cursor: 'default',
                  transition: 'opacity 0.8s ease',
                  opacity: started ? 0.86 : 0,
                  pointerEvents: started ? 'auto' : 'none',
                  backdropFilter: 'blur(6px)',
                }, peak.peak ? {
                  background: 'rgba(255, 69, 0, 0.34)',
                  border: '1px solid rgba(255, 99, 26, 0.95)',
                  color: '#ffffff',
                  boxShadow: '0 0 16px rgba(255, 69, 0, 0.45)',
                } : {
                  background: 'var(--dsw-alias-bg-overlay, rgba(24, 24, 28, 0.9))',
                  border: '1px solid var(--dsw-alias-border-l1, rgba(150, 150, 170, 0.28))',
                  color: 'var(--dsw-alias-label-primary, #e9e9ef)',
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
                });

                var dotStyle = {
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  marginRight: 6,
                  verticalAlign: 'middle',
                  background: peak.peak ? '#ff3d00' : 'var(--dsw-alias-state-success-primary, #4ade80)',
                  boxShadow: peak.peak ? '0 0 6px rgba(255, 61, 0, 0.9)' : 'none',
                };

                return React.createElement(
                  'div',
                  {
                    id: 'dsh-token-rush-window',
                    style: windowStyle,
                    onPointerDown: onPointerDown,
                    onDoubleClick: onDoubleClick,
                    title: '\u53cc\u51fb\u590d\u4f4d\u4f4d\u7f6e',
                  },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 600, cursor: 'move', marginBottom: 3 } },
                    React.createElement(
                      'span',
                      null,
                      React.createElement('span', { style: dotStyle }),
                      '\u4f1a\u8bdd\u4eea\u8868'
                    ),
                    React.createElement(
                      'span',
                      { style: { fontSize: 11, opacity: 0.85 } },
                      peak.peak ? '\u9ad8\u5cf0\u65f6\u6bb5' : '\u7a7a\u95f2\u65f6\u6bb5'
                    )
                  ),
                  React.createElement(
                    'div',
                    null,
                    '\u603bToken ' + fmtTokens(totalTokens) + (totals ? '\uff08\u8fdb ' + fmtTokens(totals.input) + ' / \u51fa ' + fmtTokens(totals.output) + '\uff09' : '')
                  ),
                  React.createElement(
                    'div',
                    null,
                    '\u6d88\u8017 \u2248 ' + fmtMoney(cost) + (conversation.model ? ' \u00b7 ' + conversation.model.replace(/^deepseek-/, '') : '')
                  ),
                  React.createElement(
                    'div',
                    { title: balanceTip },
                    '\u4f59\u989d ' + balanceLine
                  )
                );
              }
            );
          });
        },
        'dsh-token-rush: shell.overlay entry'
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

//# sourceURL=dsh-token-rush/client.js
