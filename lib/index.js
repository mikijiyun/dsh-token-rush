// dsh-token-rush — host half.
//
// Runs inside the dsh web process. Responsibilities:
//   - At every DSH service start, evaluate the current time against the
//     peak-hour windows (the official DeepSeek peak windows: Beijing time,
//     Mon–Fri 09:00–12:00, 14:00–18:00) and log the verdict.
//   - Serve read-only JSON under /api/token-rush/* for the browser half:
//       GET /api/token-rush/peak     -> { peak, windows, tz, prices, startup* }
//       GET /api/token-rush/balance  -> DeepSeek /user/balance via the
//                                        provider credential (cached ~60s)
//
// Plain ESM on purpose: no build step, no external imports beyond node
// builtins, so `dsh plugin --profile web add link:<this folder>` works
// without compiling anything.

const DEFAULT_WINDOWS = [
  [9, 12],
  [14, 18],
]; // [startHour, endHour) local to tz
const DEFAULT_TZ = 'Asia/Shanghai'; // DeepSeek bills in Beijing time
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const BALANCE_TTL_MS = 60_000; // balance cache freshness
const BALANCE_TIMEOUT_MS = 8_000;

export const DEFAULT_PEAK_WINDOWS = DEFAULT_WINDOWS;
export const DEFAULT_PEAK_TZ = DEFAULT_TZ;

// Official model prices (CNY per 1M tokens) from api-docs.deepseek.com
// 模型 & 价格. `peak` is the weekday Beijing-time peak window, `off` the rest.
// Legacy ids (deepseek-chat / deepseek-reasoner) alias the current catalog.
export const PRICES = {
  'deepseek-v4-flash': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
  'deepseek-v4-flash-vision-exp': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
  'deepseek-v4-pro': { inputMiss: { off: 4.5, peak: 9.0 }, inputHit: { off: 0.15, peak: 0.3 }, output: { off: 13.5, peak: 27.0 } },
  'deepseek-chat': { inputMiss: { off: 1.5, peak: 3.0 }, inputHit: { off: 0.05, peak: 0.1 }, output: { off: 4.5, peak: 9.0 } },
  'deepseek-reasoner': { inputMiss: { off: 4.5, peak: 9.0 }, inputHit: { off: 0.15, peak: 0.3 }, output: { off: 13.5, peak: 27.0 } },
};
export const DEFAULT_PRICES_KEY = 'default';
export const DEFAULT_PRICES = PRICES['deepseek-v4-flash'];

/** Parse "9-12,14-18" (or "9-12 14-18") into windows; invalid input falls back. */
export function parseWindows(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_WINDOWS;
  const out = [];
  for (const token of raw.split(/[,; ]+/)) {
    if (token === '') continue;
    const m = /^(\d{1,2})[-~](\d{1,3})$/.exec(token);
    if (m === null) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < 24 && end > start && end <= 24) {
      out.push([start, end]);
    }
  }
  return out.length > 0 ? out : DEFAULT_WINDOWS;
}

/** Hour and weekday-short in the given IANA tz; falls back to local time. */
export function localWallClock(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const weekday = parts.find((p) => p.type === 'weekday').value;
    return { hour, weekday };
  } catch {
    const d = new Date(now);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return { hour: d.getHours(), weekday: weekdays[d.getDay()] };
  }
}

/** True on Mon–Fri inside any window; windows are [startHour, endHour). */
export function isPeakNow(now, windows = DEFAULT_WINDOWS, tz = DEFAULT_TZ) {
  const { hour, weekday } = localWallClock(now, tz);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/** Price table for one model id (unknown models use the flash/default table). */
export function priceFor(modelId, prices = PRICES) {
  if (typeof modelId !== 'string' || modelId === '') return prices[DEFAULT_PRICES_KEY] ?? prices['deepseek-v4-flash'];
  if (prices[modelId]) return prices[modelId];
  for (const key of Object.keys(prices)) {
    if (modelId.startsWith(key)) return prices[key];
  }
  return prices[DEFAULT_PRICES_KEY] ?? prices['deepseek-v4-flash'];
}

/**
 * Estimate CNY spend for one token-usage projection value.
 * @param usage - { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } (any subset).
 * @param modelId - provider model id (prefix-matched against PRICES).
 * @param peak - whether the current wall clock is in a peak window (mode switch).
 * @param prices - optional price table override (PRICES by default).
 * @returns cost in CNY.
 */
export function computeCost(usage, modelId, peak, prices = PRICES) {
  if (usage == null || typeof usage !== 'object') return 0;
  const price = priceFor(modelId, prices);
  const bucket = peak ? 'peak' : 'off';
  const miss = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
  const hit = usage.cacheReadTokens || 0;
  const out = usage.outputTokens || 0;
  return (miss * price.inputMiss[bucket] + hit * price.inputHit[bucket] + out * price.output[bucket]) / 1_000_000;
}

function writeJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(json);
}

/** Read-only route fence: refuse cross-site fetches (plain curl is refused too). */
function sameOriginBrowser(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin.length > 0;
}

async function resolveApiKey(ctx) {
  const settings = ctx.get('settings');
  let apiKeyEnv = DEFAULT_API_KEY_ENV;
  let baseURL = DEFAULT_BASE_URL;
  try {
    const section = settings && typeof settings.get === 'function' ? settings.get('llm-deepseek') : undefined;
    if (section && typeof section === 'object') {
      if (typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0) apiKeyEnv = section.apiKeyEnv;
      if (typeof section.baseURL === 'string' && section.baseURL.length > 0) baseURL = section.baseURL;
    }
  } catch {
    /* the settings section may be unregistered or unreadable; fall back */
  }
  if (typeof process.env.DEEPSEEK_BASE_URL === 'string' && process.env.DEEPSEEK_BASE_URL.length > 0) {
    baseURL = process.env.DEEPSEEK_BASE_URL;
  }
  const credentials = ctx.get('credentials');
  let key;
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(apiKeyEnv);
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) key = hit.value;
    } catch {
      key = undefined;
    }
  }
  if (!key) {
    const ambient = process.env[apiKeyEnv];
    if (typeof ambient === 'string' && ambient.length > 0) key = ambient;
  }
  return { key: key ?? undefined, baseURL, apiKeyEnv };
}

async function fetchDeepSeekBalance(ctx) {
  const { key, baseURL, apiKeyEnv } = await resolveApiKey(ctx);
  if (!key) return { ok: false, code: 'no-api-key', apiKeyEnv };
  const url = `${baseURL.replace(/\/+$/, '')}/user/balance`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, code: 'http-error', status: res.status, apiKeyEnv };
    const body = await res.json();
    const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
    return {
      ok: true,
      isAvailable: body.is_available !== false,
      balances: infos.map((item) => ({
        currency: item.currency,
        total: item.total_balance,
        granted: item.granted_balance,
        toppedUp: item.topped_up_balance,
      })),
      fetchedAt: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'fetch-error',
      message: error && typeof error.message === 'string' ? error.message : String(error),
      apiKeyEnv,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const name = 'dsh-token-rush';
export const inject = ['webServer'];

export function apply(ctx) {
  const windows = parseWindows(process.env.DSH_HUD_PEAK_WINDOWS);
  const tz = typeof process.env.DSH_HUD_PEAK_TZ === 'string' && process.env.DSH_HUD_PEAK_TZ !== '' ? process.env.DSH_HUD_PEAK_TZ : DEFAULT_TZ;
  const priceTable = PRICES;

  // Startup peak-time check: runs once per DSH service start, as requested.
  const startupCheckedAt = Date.now();
  const startupPeak = isPeakNow(new Date(startupCheckedAt), windows, tz);
  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info(
      `dsh-token-rush: startup peak-time check -> ${startupPeak ? 'PEAK' : 'off-peak'} (${new Date(startupCheckedAt).toString()}, tz=${tz}, windows=${JSON.stringify(windows)})`,
    );
  }

  const cache = { at: 0, value: undefined };

  const balanceHandler = (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' });
    if (!sameOriginBrowser(req)) return writeJson(res, 403, { ok: false, code: 'forbidden' });
    if (cache.value !== undefined && Date.now() - cache.at < BALANCE_TTL_MS) {
      return writeJson(res, 200, cache.value);
    }
    void fetchDeepSeekBalance(ctx).then((result) => {
      if (result.ok) {
        cache.at = Date.now();
        cache.value = result;
      }
      writeJson(res, 200, result);
    });
  };

  const peakHandler = (req, res) => {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: 'method-not-allowed' });
    if (!sameOriginBrowser(req)) return writeJson(res, 403, { ok: false, code: 'forbidden' });
    const now = Date.now();
    writeJson(res, 200, {
      ok: true,
      peak: isPeakNow(new Date(now), windows, tz),
      windows,
      tz,
      prices: priceTable,
      checkedAt: now,
      startup: { checkedAt: startupCheckedAt, peak: startupPeak },
    });
  };

  ctx.effect(
    () => {
      const disposers = [
        ctx.webServer.register({ kind: 'exact', path: '/api/token-rush/peak', handler: peakHandler }),
        ctx.webServer.register({ kind: 'exact', path: '/api/token-rush/balance', handler: balanceHandler }),
      ];
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') dispose();
        }
      };
    },
    'dsh-token-rush: /api/token-rush routes',
  );
}
