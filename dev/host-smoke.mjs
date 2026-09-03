// Host-half smoke test: pure functions + apply() against a mock ctx with a
// mocked global fetch. No dsh runtime needed.
//   node dev/host-smoke.mjs
import assert from 'node:assert/strict'
import { apply, isPeakNow, parseWindows, computeCost, PRICES } from '../lib/index.js'

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}\n     ${error.message}`)
  }
}

// ── peak windows ────────────────────────────────────────────────────────────
check('parseWindows: default', () => assert.deepEqual(parseWindows(undefined), [[9, 12], [14, 18]]))
check('parseWindows: explicit', () => assert.deepEqual(parseWindows('8-10,14-18'), [[8, 10], [14, 18]]))
check('parseWindows: garbage falls back', () => assert.deepEqual(parseWindows('abc,,'), [[9, 12], [14, 18]]))
check('parseWindows: bad range dropped', () => assert.deepEqual(parseWindows('8-10,25-9'), [[8, 10]]))

// Monday 2026-01-05: Beijing = UTC+8 (no DST).
const mon0900Bjt = new Date('2026-01-05T01:00:00Z') // 09:00 Beijing
const mon1159Bjt = new Date('2026-01-05T03:59:59Z') // 11:59 Beijing
const mon1200Bjt = new Date('2026-01-05T04:00:00Z') // 12:00 Beijing
const sun0900Bjt = new Date('2026-01-11T01:00:00Z') // Sunday
check('peak: Mon 09:00 Beijing', () => assert.equal(isPeakNow(mon0900Bjt, [[9, 12], [14, 18]], 'Asia/Shanghai'), true))
check('peak: Mon 11:59 Beijing', () => assert.equal(isPeakNow(mon1159Bjt, [[9, 12], [14, 18]], 'Asia/Shanghai'), true))
check('peak: Mon 12:00 Beijing (window closed)', () => assert.equal(isPeakNow(mon1200Bjt, [[9, 12], [14, 18]], 'Asia/Shanghai'), false))
check('peak: Sunday never peak', () => assert.equal(isPeakNow(sun0900Bjt, [[9, 12], [14, 18]], 'Asia/Shanghai'), false))

// ── cost estimation ─────────────────────────────────────────────────────────
const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }
check('cost: flash peak (3 + 9 CNY/M)', () => assert.equal(computeCost(usage, 'deepseek-v4-flash', true, PRICES), 12))
check('cost: flash off-peak (1.5 + 4.5)', () => assert.equal(computeCost(usage, 'deepseek-v4-flash', false, PRICES), 6))
check('cost: pro peak (9 + 27)', () => assert.equal(computeCost(usage, 'deepseek-v4-pro', true, PRICES), 36))
check('cost: cache-hit price bucket', () => {
  const cached = { uncachedInputTokens: 0, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, outputTokens: 0 }
  assert.equal(computeCost(cached, 'deepseek-v4-flash', false, PRICES), 0.1) // 2M × 0.05
})
check('cost: unknown model uses default', () => assert.equal(computeCost(usage, 'something-else', false, PRICES), 6))
check('cost: null usage', () => assert.equal(computeCost(null, 'deepseek-v4-flash', false, PRICES), 0))

// ── apply() against a mock ctx ──────────────────────────────────────────────
const registered = []
const loggerCalls = []
let routesCount = 0
const mockCtx = {
  logger: { info: (...a) => loggerCalls.push(a.join(' ')), warn: () => {}, error: () => {} },
  effect(callback) {
    const dispose = callback()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  get(name) {
    if (name === 'settings') return { get: (ns) => ({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' }) }
    if (name === 'credentials') return { resolve: async (ref) => ({ value: 'sk-test-123' }) }
    return undefined
  },
  webServer: {
    register(route) {
      registered.push(route)
      routesCount += 1
      return () => {}
    },
  },
}

let lastFetchUrl = null
let lastFetchHeaders = null
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  lastFetchUrl = String(url)
  lastFetchHeaders = opts.headers
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '98.50', granted_balance: '0.00', topped_up_balance: '98.50' },
        ],
      }
    },
  }
}

try {
  apply(mockCtx)
  check('apply: registers two routes', () => assert.equal(routesCount, 2))
  check('apply: startup peak check logged', () => assert.ok(loggerCalls.some((l) => l.includes('startup peak-time check'))))

  const peakRoute = registered.find((r) => r.path === '/api/token-rush/peak')
  const balanceRoute = registered.find((r) => r.path === '/api/token-rush/balance')
  check('apply: peak route exists', () => assert.ok(peakRoute))

  const req = (method) => ({ method, headers: { 'sec-fetch-site': 'same-origin' } })
  const res = () => {
    const r = { status: 0, body: null, headers: null }
    r.writeHead = (status, headers) => { r.status = status; r.headers = headers }
    r.end = (body) => { r.body = JSON.parse(body) }
    return r
  }

  const peakRes = res()
  peakRoute.handler(req('GET'), peakRes)
  check('GET /peak returns ok + windows', () => {
    assert.equal(peakRes.status, 200)
    assert.equal(peakRes.body.ok, true)
    assert.deepEqual(peakRes.body.windows, [[9, 12], [14, 18]])
    assert.ok(typeof peakRes.body.peak === 'boolean')
    assert.ok(peakRes.body.startup && typeof peakRes.body.startup.peak === 'boolean')
  })

  const balanceRes = res()
  balanceRoute.handler(req('GET'), balanceRes)
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('GET /balance proxies DeepSeek with the provider key', () => {
    assert.ok(lastFetchUrl.endsWith('/user/balance'))
    assert.equal(lastFetchHeaders.authorization, 'Bearer sk-test-123')
    assert.equal(balanceRes.status, 200)
    assert.equal(balanceRes.body.ok, true)
    assert.equal(balanceRes.body.balances[0].total, '98.50')
  })

  const crossRes = res()
  balanceRoute.handler({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, crossRes)
  check('GET /balance refuses cross-site', () => assert.equal(crossRes.status, 403))

  const methodRes = res()
  balanceRoute.handler({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, methodRes)
  check('GET /balance refuses non-GET', () => assert.equal(methodRes.status, 405))
} finally {
  globalThis.fetch = originalFetch
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall host-half smoke checks passed')
