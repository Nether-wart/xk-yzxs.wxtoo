#!/usr/bin/env node
/**
 * xk.mjs — 无锡市第一中学 选修课抢课工具（纯 Node fetch，无浏览器 / 无 CDP）
 *
 * 只用 Node 内置 fetch，自己维护 Cookie；登录后把会话缓存到本地，
 * 下次运行直接复用 —— 不重复登录、不重复发 POST。
 *
 * 分校请把常量BASE改成"https://yzxs.wxtoo.cn/thxc"或者"https://yzxs.wxtoo.cn/liangxi"
 * 用法：
 *   node xk.mjs --check                        检查登录态 + 当前已选（不抢课）
 *   node xk.mjs --list                         列出全部课程（不发任何 POST）
 *   node xk.mjs --targets 16,22 --dry-run      演练：只打印本来会发什么
 *   node xk.mjs --targets 16,22 --now          立即抢
 *   node xk.mjs --targets 16,22 --at 20:00:00  定时抢（提前 10s 开冲，持续 40s）
 *   node xk.mjs --targets 16,22,30 --now --concurrency 3  3 门同时开冲（谁快谁上）
 *   node xk.mjs --logout                       清除本地会话缓存
 *
 * 参数：
 *   --targets 16,22      目标课程编号，按优先级从高到低
 *   --type class|grade   报名类型，默认 class（班级选修）
 *   --at HH:mm:ss        开放时刻；--lead 秒提前开冲（默认 10）
 *   --duration 40        开放后持续抢多少秒（默认 40，到点即停）
 *   --burst 1            抢到一门课后该 slot 连发几次再换（默认 1）
 *   --concurrency 1      最大并发：同时在飞的 add_sign 数（默认 1，可配）
 *   --node-concurrency N 改 Node 全局 fetch 的连接上限（默认跟随 --concurrency）
 *   --max-posts 300      全局 POST 次数硬上限
 *   --dry-run            演练，绝不发送 add_sign
 *   --now                立即开始
 *   --ignore-existing    已选课位冲突时也照抢（默认跳过以省 POST）
 *   --no-verify          成功后不回头核对
 *   --relogin            忽略本地会话，强制重新登录
 *
 * 接口（探测所得）：
 *   登录   POST /passport/login    name, id_number       → 303 /user + Set-Cookie
 *   列表   GET  /user/project                            → HTML
 *   抢课   POST /user/add_sign     project_id, type      → {"code":100,"msg":"选修报名成功"}
 *   响应码 100 成功 / 102 课位已被自己占用 / 含「已满」满员 / 含「等待开放」可重试
 *
 * 省 POST 的设计：
 *   1) 会话缓存到 state/session.json，重复运行不重复登录
 *   2) 等待期间只发 GET，不发 POST
 *   3) 成功 / 已满 / 已报名 / 课位冲突 → 立刻永久停掉该门，不再重试
 *   4) POST 预算先占坑再发，并发下也不超发
 *
 * 并发：
 *   没有轮次、没有发车间隔：起 --concurrency 个常驻 worker，一空闲就抢下一发，
 *   直到成功 / 已满 / 已选 / 课位冲突 / --duration 到点 / --max-posts 打满 / Ctrl+C。
 *   每个 worker 抢哪一门：
 *     1) 优先「当前没在飞、且与在飞科目课位不冲突」里优先级最高的那门；
 *     2) 都占满了，就把这一发加到优先级最高的在飞科目上 —— 同一门课并行抢同一个名额。
 *   同一门课的 --burst 是「这一门连发几次再让出 slot」。
 *   启动时还会把 Node 全局 fetch 的连接上限压到 --node-concurrency（默认 = --concurrency），
 *   抢课过程之外的登录 / 列表 / 核对这些请求也受这个全局上限管。
 *   没有间隔意味着失败重试会打得很快，--max-posts 是唯一的刹车，紧张就调小它。
 */
import { readFile, writeFile, appendFile, mkdir, rm } from 'node:fs/promises'

// ───────────────────────────── 常量 ─────────────────────────────
const BASE = 'https://yzxs.wxtoo.cn'
const URLS = {
  login: `${BASE}/passport/login`,
  logout: `${BASE}/passport/logout`,
  home: `${BASE}/user/index`,
  project: `${BASE}/user/project`,
  addSign: `${BASE}/user/add_sign`,
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'

const STATE_DIR = 'state'
const SESSION_FILE = `${STATE_DIR}/session.json`
const CACHE_FILE = `${STATE_DIR}/catalog-cache.json`
const LOG_DIR = 'logs'
const SRC = new URL(import.meta.url)

// ───────────────────────────── 参数 ─────────────────────────────
const cfg = JSON.parse(await readFile(new URL('./config.json', SRC), 'utf8'))

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const k = a.slice(2)
    if (k.includes('=')) { const [kk, vv] = k.split('='); out[kk] = vv; continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++ } else { out[k] = true }
  }
  return out
}
const argv = parseArgs(process.argv.slice(2))
/** 取正整数，非法/缺省 → fallback */
const toCount = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback
}
const CONCURRENCY = toCount(argv.concurrency ?? argv['max-concurrency'] ?? cfg.concurrency, 1)
const OPT = {
  targets: String(argv.targets ?? '').split(/[,，\s]+/).filter(Boolean).map(Number),
  type: String(argv.type ?? 'class'),
  at: argv.at ? String(argv.at) : null,
  lead: Number(argv.lead ?? 10),
  duration: Number(argv.duration ?? 40),
  burst: toCount(argv.burst ?? 1, 1),
  concurrency: CONCURRENCY,
  nodeConcurrency: toCount(argv['node-concurrency'] ?? cfg.node_concurrency, CONCURRENCY),
  maxPosts: Number(argv['max-posts'] ?? 300),
  dryRun: !!argv['dry-run'],
  verify: !argv['no-verify'],
  now: !!argv.now,
  list: !!argv.list,
  check: !!argv.check,
  ignoreExisting: !!argv['ignore-existing'],
  relogin: !!argv.relogin,
  logout: !!argv.logout,
  help: !!argv.help,
}

// ─────────────────────────── Cookie 罐 ───────────────────────────
class CookieJar {
  constructor() { this.map = new Map() }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean)
    for (const raw of list) {
      const pair = raw.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq < 1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const dead = /expires=Thu,\s*01\s*Jan\s*1970/i.test(raw) || /max-age=0\b/i.test(raw)
      if (dead || value === '') this.map.delete(name)
      else this.map.set(name, value)
    }
    return list.length
  }

  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ') }
  get size() { return this.map.size }
  names() { return [...this.map.keys()] }
  toJSON() { return Object.fromEntries(this.map) }
  load(obj) { for (const [k, v] of Object.entries(obj ?? {})) this.map.set(k, v) }
}

// ───────────── Node 全局 fetch 并发上限（内置 undici 全局 dispatcher） ─────────────
/**
 * Node 内置 fetch 走内置 undici，其全局 dispatcher 默认 connections=null，即不设上限。
 * 启动时按配置把「同一 origin 的连接数」压到上限：全站并发都不会超过配置值 ——
 * 不只是抢课，登录 / 列表 / 事后核对这些请求也一并受控。
 *
 * 全局 dispatcher 挂在 undici 的内部 symbol 上（Node 没有公开导出，undici 也不在依赖里），
 * 所以只能借现有 dispatcher 的构造器造一个新的换上：
 *   new Headers()          触发内置 undici 懒加载（不发任何请求）
 *   globalThis[KEY]        全局 dispatcher 本体
 * 必须在任何请求发出前调用。
 */
const DISPATCHER_KEY = Symbol.for('undici.globalDispatcher.1')
function applyGlobalConcurrency(n) {
  try {
    if (!globalThis[DISPATCHER_KEY]) new Headers()
    const prev = globalThis[DISPATCHER_KEY]
    if (typeof prev?.dispatch !== 'function' || typeof prev?.constructor !== 'function') {
      return { ok: false, why: '内置 undici 全局 dispatcher 不可达' }
    }
    const Agent = prev.constructor
    globalThis[DISPATCHER_KEY] = new Agent({ connections: n, pipelining: 1 })
    return { ok: true, agent: Agent.name }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
}

// ─────────────────────────── HTTP 层 ───────────────────────────
const jar = new CookieJar()
const requestLog = []
let journalPath = null
let postCount = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 抢名额：先占一个 POST 坑（同步执行，并发下也不会超发），没了就返回 false */
function reservePost() {
  if (postCount >= OPT.maxPosts) return false
  postCount++
  return true
}

async function request(url, { method = 'GET', body = null, ajax = false, redirect = 'follow', referer = null, timeoutMs = 15000 } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: BASE,
    Referer: referer ?? (url.includes('add_sign') ? URLS.project : url),
  }
  if (jar.size) headers.Cookie = jar.header()
  if (ajax) {
    headers['X-Requested-With'] = 'XMLHttpRequest'
    headers.Accept = 'application/json, text/javascript, */*; q=0.01'
  } else {
    headers.Accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'

  const started = Date.now()
  const entry = { method, url: url.replace(BASE, ''), body, status: null, location: null, ms: 0 }
  try {
    const res = await fetch(url, { method, headers, body, redirect, signal: AbortSignal.timeout(timeoutMs) })
    jar.absorb(res)
    const text = redirect === 'manual' ? '' : await res.text()
    entry.status = res.status
    entry.location = res.headers.get('location')
    entry.bytes = text.length
    entry.ms = Date.now() - started
    requestLog.push(entry)
    if (journalPath) await appendFile(journalPath, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'http', ...entry })}\n`)
    return { status: res.status, location: entry.location, text, ms: entry.ms }
  } catch (err) {
    entry.error = String(err?.name === 'TimeoutError' ? `超时 ${timeoutMs}ms` : (err?.cause?.code ?? err?.message ?? err))
    entry.ms = Date.now() - started
    requestLog.push(entry)
    if (journalPath) await appendFile(journalPath, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'http', ...entry })}\n`)
    return { status: 0, location: null, text: '', error: entry.error, ms: entry.ms }
  }
}

// ──────────────────────── HTML 解析 ────────────────────────
const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (NAMED[e]) return NAMED[e]
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return m
  })
}
const clean = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

function parseCatalog(html) {
  const out = { courses: [], mine: [] }
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0])
  const cellsOf = (rowHtml) => [...rowHtml.matchAll(/<(td|th)\b[\s\S]*?<\/\1>/gi)].map((c) => clean(c[0]))

  for (const table of tables) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => r[0])
    if (!rows.length) continue
    const head = cellsOf(rows[0]).join('|')

    if (head.includes('报名操作')) {
      out.courses = rows.slice(1).map((row) => {
        const td = cellsOf(row)
        if (!td[0]) return null
        const m = row.match(/sign_project\/(\d+)/)
        return { id: m ? Number(m[1]) : null, name: td[0], pos: td[1], teacher: td[2], cap: Number(td[3]), enrolled: Number(td[4]), open: !!m }
      }).filter(Boolean)
    } else if (head.includes('课程名称') && head.includes('课位') && head.includes('主讲教师')) {
      out.mine = rows.slice(1).map((row) => {
        const td = cellsOf(row)
        if (!td[0]) return null
        return { name: td[0], pos: td[1], teacher: td[2] }
      }).filter(Boolean)
    }
  }
  return out
}

// ──────────────────────── 响应语义分类 ────────────────────────
const RE_ALREADY = [/已选/, /已经选/, /已报名/, /不能重复/, /重复报名/, /无需再/, /相同课位/]
const RE_FULL = [/已满/, /名额已满/, /人数已满/, /没有名额/, /已报满/]
const RE_RETRY = [/未开放/, /等待开放/, /未到/, /时间未到/, /还没开始/, /尚未开始/, /不在选课时间/]

function classify(res) {
  if (/passport\/login|请先登录/.test(res.text ?? '')) return { kind: 'loggedout', msg: '登录失效' }
  let json = null
  try { json = JSON.parse(res.text) } catch { /* 非 JSON */ }
  if (json && json.code !== undefined) {
    const code = Number(json.code)
    const msg = String(json.msg ?? '')
    if (code === 100) return { kind: 'success', code, msg }
    if (RE_ALREADY.some((r) => r.test(msg))) return { kind: 'already', code, msg }
    if (RE_FULL.some((r) => r.test(msg))) return { kind: 'full', code, msg }
    if (RE_RETRY.some((r) => r.test(msg))) return { kind: 'retry', code, msg }
    return { kind: 'retry', code, msg }
  }
  if (/报名成功|选课成功/.test(res.text ?? '')) return { kind: 'success', code: null, msg: '文本命中成功' }
  return { kind: 'retry', code: null, msg: `非JSON HTTP=${res.status} ${String(res.text).slice(0, 60)}` }
}

// ──────────────────── 同一门课多发并发的结果归并 ────────────────────
/**
 * 同一门课被多个 worker 并发抢时，落在 done 里的结果取最好的一发：
 * 成功 > 已选 > 可重试 > 已满 > 预算耗尽 > 课位冲突
 * 同一门课被多发并发抢时，一门课只认**先落地的那一发**：后到的如果更差（已满、已选重复）
 * 就直接丢掉、不再上报；「已满」排这么后，是为了「一发说满、另一发抢成了」时以成功为准。
 */
const RANK = { success: 0, already: 1, retry: 2, loggedout: 2, full: 3, aborted: 4, conflict: 5 }

// ──────────────────────── 课位互斥 ────────────────────────
const slotsOf = (pos) => new Set(String(pos ?? '').split(/[,，、/\s]+/).map((s) => s.trim()).filter(Boolean))
function conflicts(a, b) { for (const s of a) if (b.has(s)) return true; return false }

// ──────────────────────── 账号动作 ────────────────────────
async function loadSession() {
  if (OPT.relogin) return false
  try {
    const saved = JSON.parse(await readFile(SESSION_FILE, 'utf8'))
    jar.load(saved.cookies)
    return jar.size > 0
  } catch { return false }
}

async function saveSession() {
  await mkdir(STATE_DIR, { recursive: true })
  await writeFile(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), user: cfg.name, cookies: jar.toJSON() }, null, 2))
}

async function login() {
  const body = new URLSearchParams({ name: cfg.name, id_number: cfg.id_number }).toString()
  const res = await request(URLS.login, { method: 'POST', body, redirect: 'manual', referer: URLS.login })
  reservePost()
  console.log(`  [登录] POST /passport/login -> ${res.status}${res.location ? ` → ${res.location.replace(BASE, '')}` : ''}  (cookie: ${jar.names().join(', ') || '无'})`)
  return res
}

async function fetchProject() {
  const res = await request(URLS.project, { referer: URLS.home })
  const ok = /退出登录/.test(res.text) && /你好/.test(res.text)
  return { ok, res, ...parseCatalog(res.text) }
}

/** 确保已登录：优先复用本地会话，失效才重新登录 */
async function ensureLogin() {
  if (await loadSession()) {
    const p = await fetchProject()
    if (p.ok) { console.log(`  [会话] 复用本地缓存，已登录：${cfg.name}`); return p }
    console.log('  [会话] 本地缓存已失效')
  }
  console.log('  [会话] 自动登录中…')
  await login()
  const p = await fetchProject()
  if (!p.ok) { console.error('  ✗ 自动登录失败：请核对 config.json 里的 name / id_number'); return null }
  await saveSession()
  console.log(`  ✓ 自动登录成功：${cfg.name}`)
  return p
}

async function addSign(projectId, type) {
  if (!reservePost()) return { kind: 'aborted', msg: 'POST 预算已用尽' }
  const res = await request(URLS.addSign, { method: 'POST', body: `project_id=${projectId}&type=${type}`, ajax: true })
  const cls = classify(res)
  if (journalPath) await appendFile(journalPath, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'sign', id: projectId, type, httpStatus: res.status, verdict: cls.kind, msg: cls.msg, code: cls.code ?? null })}\n`)
  return cls
}

// ──────────────────────── 目录缓存（名称→编号） ────────────────────────
async function syncCache(catalog) {
  let cache = {}
  try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')) } catch { /* 首次运行 */ }
  let filled = 0
  for (const c of catalog.courses) {
    if (c.id == null && cache[c.name] != null) { c.id = cache[c.name]; filled++ }
  }
  if (catalog.courses.some((c) => c.id != null)) {
    for (const c of catalog.courses) if (c.id != null) cache[c.name] = c.id
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2))
  }
  return filled
}

const banner = (t) => console.log(`${'═'.repeat(74)}\n  ${t}\n${'═'.repeat(74)}`)

// ══════════════════════════════ 主流程 ══════════════════════════════
async function main() {
  // 帮助 / 无参数
  if (OPT.help || (!OPT.targets.length && !OPT.list && !OPT.check && !OPT.logout)) {
    const usage = (await readFile(SRC, 'utf8'))
      .split('*/')[0]
      .replace(/^#![^\n]*\n/, '')
      .replace(/^\/\*\*\n?/, '')
      .replace(/^ \* ?/gm, '')
      .trim()
    console.log(usage)
    return OPT.help ? 0 : 1
  }

  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })

  if (OPT.logout) {
    await rm(SESSION_FILE, { force: true })
    console.log('已清除本地会话缓存 state/session.json')
    return 0
  }

  journalPath = `${LOG_DIR}/xk-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  const nodeLimit = applyGlobalConcurrency(OPT.nodeConcurrency)
  banner('无锡一中选修课抢课工具 · 纯 fetch 版')
  console.log(`  账号：${cfg.name} / ${cfg.id_number}`)
  console.log(`  日志：${journalPath}`)
  if (nodeLimit.ok) console.log(`  Node 全局 fetch：同一服务器最多 ${OPT.nodeConcurrency} 个并发连接（内置 undici 全局 dispatcher）`)
  else console.log(`  ! Node 全局 fetch 并发上限未生效：${nodeLimit.why} —— 仍由本工具按 concurrency=${OPT.concurrency} 限流`)

  // ─────── --check / --list ───────
  if (OPT.check || OPT.list) {
    const p = await ensureLogin()
    if (!p) return 1
    const filled = await syncCache(p)

    if (p.mine.length) {
      console.log('\n⚠ 当前已选（有过选课后列表页不再提供任何选课入口，且全站无退选接口）：')
      for (const m of p.mine) console.log(`  · 课位 ${m.pos.padEnd(6)} ${m.name}  (${m.teacher})`)
    } else {
      console.log('\n当前已选：无')
    }
    if (filled) console.log(`  （${filled} 门课编号来自本地缓存 state/catalog-cache.json）`)

    if (OPT.list) {
      console.log(`\n课程列表（${p.courses.length} 门）：`)
      for (const c of p.courses) {
        const flag = c.id == null ? '?   ' : c.open ? '可选 ' : '无入口'
        console.log(`  #${String(c.id ?? '?').padStart(3)}  ${flag}  ${String(c.enrolled).padStart(3)}/${String(c.cap).padEnd(3)}  课位${String(c.pos).padEnd(5)}  ${c.name}  — ${c.teacher}`)
      }
    }
    console.log(`\nPOST 次数：${postCount}   HTTP 请求：${requestLog.length}`)
    return 0
  }

  // ─────── 抢课 ───────
  const p = await ensureLogin()
  if (!p) return 1

  const filled = await syncCache(p)
  if (p.mine.length) {
    console.log('\n注意：账号当前已有选课 ——')
    for (const m of p.mine) console.log(`  · 课位 ${m.pos.padEnd(6)} ${m.name}`)
  }
  if (filled) console.log(`（${filled} 门课编号来自本地缓存）`)

  const byId = new Map(p.courses.filter((c) => c.id != null).map((c) => [c.id, c]))
  console.log('\n目标（按优先级）：')
  const targets = []
  for (const id of OPT.targets) {
    const c = byId.get(id)
    if (!c) { console.log(`  ✗ #${id} 不在当前课程列表中，跳过`); continue }
    const s = slotsOf(c.pos)
    const blocked = OPT.ignoreExisting ? null : p.mine.find((m) => conflicts(slotsOf(m.pos), s))
    if (blocked) {
      console.log(`  ⛔ #${id} 课位${c.pos} ${c.name} —— 与已选「${blocked.name}」冲突，跳过（省一次 POST）`)
      continue
    }
    console.log(`  · #${id}  课位${c.pos}  ${c.name}  — ${c.teacher}`)
    targets.push({ ...c, slots: s })
  }
  if (!targets.length) { console.log('\n没有可抢的目标。'); return 0 }

  const pending = new Map(targets.map((t) => [t.id, t]))
  const done = new Map()
  let hardEnd = null

  // ─────── 定时 ───────
  if (OPT.at && !OPT.now) {
    const [h, m, s] = OPT.at.split(':').map(Number)
    let when = new Date(); when.setHours(h, m, s ?? 0, 0)
    if (when.getTime() < Date.now()) when = new Date(when.getTime() + 86400000)
    const startAt = when.getTime() - OPT.lead * 1000
    hardEnd = when.getTime() + OPT.duration * 1000
    console.log(`\n开放时刻：${when.toLocaleString('zh-CN')}`)
    console.log(`开冲时刻：${new Date(startAt).toLocaleTimeString('zh-CN')}（提前 ${OPT.lead}s）`)
    console.log(`停止时刻：${new Date(hardEnd).toLocaleTimeString('zh-CN')}（开放后 ${OPT.duration}s）`)
    console.log('\n等待中（此期间不发任何 POST）…')
    while (Date.now() < startAt) {
      const left = Math.ceil((startAt - Date.now()) / 1000)
      process.stdout.write(`\r  倒计时 ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}   `)
      await sleep(Math.min(1000, Math.max(100, startAt - Date.now())))
    }
    process.stdout.write('\n')
  }
  if (hardEnd == null) hardEnd = Date.now() + OPT.duration * 1000

  const startedAt = Date.now()
  let stop = false
  process.on('SIGINT', () => { stop = true; console.log('\n收到中断，正在收尾…') })

  console.log(`\n开始抢课：type=${OPT.type}  burst=${OPT.burst}  concurrency=${OPT.concurrency}  max-posts=${OPT.maxPosts}${OPT.dryRun ? '  [DRY-RUN 不发 POST]' : ''}`)
  console.log('无轮次、无间隔：一空闲就抢下一发，直到成功 / 已满 / 到点 / 预算打满。Ctrl+C 可随时停止\n')

  // 当前有请求在飞的科目：id → { slots, refs }，refs = 占着它的 worker 数
  const busy = new Map()

  /**
   * 给一个空闲 slot 选目标：
   *   1) 「当前没在飞、且与在飞科目课位不冲突」里优先级最高的那门；
   *   2) 都占满了 → 把这一发加到优先级最高的在飞科目上（同一门课并行抢同一个名额）。
   * 这样任意时刻在飞的科目两两不冲突，同时允许同一门课多发并行。
   */
  function takeTarget() {
    const held = [...busy.values()].map((b) => b.slots)
    for (const t of pending.values()) {
      if (busy.has(t.id)) continue
      if (held.some((s) => conflicts(s, t.slots))) continue
      return t
    }
    for (const t of pending.values()) if (busy.has(t.id)) return t
    return null
  }

  function progress(t, res) {
    process.stdout.write(`\r  待抢${pending.size} 已定${targets.length - pending.size} POST累计${postCount}  #${t.id}: ${String(res.msg).slice(0, 30)}          `)
  }

  /** 结算一发：成功 / 已选 / 已满 立刻终止该门；同一门多发并发时只认最好的一发 */
  async function settle(t, res, at) {
    if (res.kind === 'loggedout') { await reloginOnce(at); return }
    if (res.kind === 'aborted') { stop = true; return }
    if (res.kind === 'retry') {
      if (!done.has(t.id)) progress(t, res) // 已被并发的兄弟发判死，就不再刷这门的进度
      return
    }
    const prev = done.get(t.id)
    if (prev && RANK[prev.kind] <= RANK[res.kind]) return // 已有更好（或同样好）的一发
    done.set(t.id, res)
    pending.delete(t.id)
    const stops = [] // 课位冲突要停的门，跟报成功那一行一起打，别拆开
    if (res.kind === 'success') {
      for (const o of [...pending.values()]) {
        if (conflicts(t.slots, o.slots)) {
          stops.push(`            ⛔ 停止 #${o.id}（课位${o.pos} 与 #${t.id} 冲突）`)
          done.set(o.id, { kind: 'conflict', msg: `与已成功的 #${t.id} 课位冲突` })
          pending.delete(o.id)
        }
      }
    }
    if ((busy.get(t.id)?.refs ?? 0) > 1) return // 同一门正被多发并发抢，结果交给末尾汇总行
    const elapsed = ((at - startedAt) / 1000).toFixed(1)
    if (res.kind === 'success') console.log(`  [${elapsed}s] ✓ 成功  #${t.id} 课位${t.pos} ${t.name} —— ${res.msg}`)
    else if (res.kind === 'already') console.log(`  [${elapsed}s] ○ #${t.id} ${t.name} —— ${res.msg}（视为已有，停止）`)
    else console.log(`  [${elapsed}s] ✗ #${t.id} ${t.name} —— ${res.msg}（已满，停止重试）`)
    for (const line of stops) console.log(line)
  }

  function release(t) {
    const b = busy.get(t.id)
    if (b && --b.refs <= 0) busy.delete(t.id)
  }

  function hold(t) {
    const b = busy.get(t.id)
    if (b) b.refs++
    else busy.set(t.id, { slots: t.slots, refs: 1 })
  }

  // 同一门课被多发并发抢：先到的一发定结果，后面更差的一发不再重复上报；
  // 并发中的一门课只留末尾汇总行，避免先报「已满」又报「成功」这种自相矛盾的话。

  // 登录失效：并发下多发可能同时报失效，重登只做一次，其余等着同一个任务
  let reloginTask = null
  function reloginOnce(at) {
    if (!reloginTask) {
      console.log(`  [${((at - startedAt) / 1000).toFixed(1)}s] ! 登录失效，自动重新登录…`)
      reloginTask = (async () => {
        await rm(SESSION_FILE, { force: true })
        if (!(await ensureLogin())) stop = true
      })().finally(() => { reloginTask = null })
    }
    return reloginTask
  }

  /** 一个常驻 slot：抢到一门课后连发 burst 次，然后立刻去抢下一门 */
  async function worker() {
    while (!stop && Date.now() < hardEnd) {
      const t = takeTarget()
      if (!t) return
      hold(t)
      try {
        for (let b = 0; b < OPT.burst; b++) {
          if (stop || Date.now() >= hardEnd) break
          const at = Date.now()
          const res = OPT.dryRun
            ? { kind: 'retry', msg: `DRY-RUN 本应 POST ${URLS.addSign}  body=project_id=${t.id}&type=${OPT.type}` }
            : await addSign(t.id, OPT.type)
          await settle(t, res, at)
          if (res.kind !== 'retry') break
        }
      } finally {
        release(t)
      }
    }
  }

  await Promise.all(Array.from({ length: OPT.concurrency }, () => worker()))

  // ─────── 收尾 ───────
  console.log(`\n${'═'.repeat(74)}\n  抢课结束\n${'═'.repeat(74)}`)

  if (OPT.verify && !OPT.dryRun) {
    const after = await fetchProject()
    console.log('\n服务器端「我的选修」：')
    if (after.mine.length) for (const m of after.mine) console.log(`  · 课位 ${m.pos.padEnd(6)} ${m.name}  (${m.teacher})`)
    else console.log('  （空）')
  }

  console.log('\n本次结果：')
  for (const t of targets) {
    const d = done.get(t.id)
    const icon = d?.kind === 'success' ? '✓' : d?.kind === 'already' ? '○' : d?.kind === 'conflict' ? '⛔' : '✗'
    console.log(`  ${icon} #${t.id} 课位${String(t.pos).padEnd(5)} ${t.name} —— ${d ? d.msg : '未获结果（时间到/被中断）'}`)
  }

  console.log(`\nPOST 总数：${postCount}（上限 ${OPT.maxPosts}）   并发：${OPT.concurrency}   耗时：${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  console.log(`\n全部 HTTP 请求（${requestLog.length} 条）：`)
  for (const r of requestLog) {
    console.log(`  ${r.method.padEnd(4)} ${String(r.status).padStart(3)}  ${String(r.url).padEnd(22)} ${String(r.ms).padStart(5)}ms${r.body ? `  body=${r.body}` : ''}${r.error ? `  error=${r.error}` : ''}`)
  }
  console.log(`\n详细日志：${journalPath}`)
  console.log('请打开学校网站核对最终已选课程。\n')
  return 0
}

// 绝不调用 process.exit()：Node 24/Windows 上 fetch + process.exit 会崩
process.exitCode = await main().catch((err) => {
  console.error('\n运行出错：')
  console.error(err?.stack ?? err)
  return 1
})
