#!/usr/bin/env node
/**
 * xk.mjs — 无锡市第一中学 选修课抢课工具（纯 Node fetch，无浏览器 / 无 CDP）
 *
 * 只用 Node 内置 fetch，自己维护 Cookie；登录后把会话缓存到本地，
 * 下次运行直接复用 —— 不重复登录、不重复发 POST。
 *
 * 用法：
 *   node xk.mjs --check                        检查登录态 + 当前已选（不抢课）
 *   node xk.mjs --list                         列出全部课程（不发任何 POST）
 *   node xk.mjs --targets 16,22 --dry-run      演练：只打印本来会发什么
 *   node xk.mjs --targets 16,22 --now          立即抢
 *   node xk.mjs --targets 16,22 --at 20:00:00  定时抢（提前 10s 开冲，持续 40s）
 *   node xk.mjs --logout                       清除本地会话缓存
 *
 * 参数：
 *   --targets 16,22      目标课程编号，按优先级从高到低
 *   --type class|grade   报名类型，默认 class（班级选修）
 *   --at HH:mm:ss        开放时刻；--lead 秒提前开冲（默认 10）
 *   --duration 40        开放后持续抢多少秒（默认 40）
 *   --interval 1000      每轮间隔 ms（默认 1000，±20% 抖动）
 *   --burst 1            每门每轮发几次（默认 1，建议保持）
 *   --max-posts 300      全局 POST 次数硬上限
 *   --min-gap 400        两次 POST 之间的最小间隔 ms
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
 *   3) 每门每轮只发 1 次；成功后立即停止该门及所有课位冲突目标
 *   4) 已满 / 已报名 / 课位冲突 → 永久停止，不做无意义重试
 *   5) --min-gap 与 --max-posts 双重硬限制
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
const OPT = {
  targets: String(argv.targets ?? '').split(/[,，\s]+/).filter(Boolean).map(Number),
  type: String(argv.type ?? 'class'),
  at: argv.at ? String(argv.at) : null,
  lead: Number(argv.lead ?? 10),
  duration: Number(argv.duration ?? 40),
  interval: Number(argv.interval ?? 1000),
  burst: Math.max(1, Number(argv.burst ?? 1)),
  maxPosts: Number(argv['max-posts'] ?? 300),
  minGap: Number(argv['min-gap'] ?? 400),
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

// ─────────────────────────── HTTP 层 ───────────────────────────
const jar = new CookieJar()
const requestLog = []
let journalPath = null
let postCount = 0
let lastPostAt = 0

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

// ──────────────────────── 课位互斥 ────────────────────────
const slotsOf = (pos) => new Set(String(pos ?? '').split(/[,，、/\s]+/).map((s) => s.trim()).filter(Boolean))
function conflicts(a, b) { for (const s of a) if (b.has(s)) return true; return false }

// ──────────────────────── 账号动作 ────────────────────────
const cfg = JSON.parse(await readFile(new URL('./config.json', SRC), 'utf8'))

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
  postCount++
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
  if (postCount >= OPT.maxPosts) return { kind: 'aborted', msg: 'POST 预算已用尽' }
  const gap = Date.now() - lastPostAt
  if (lastPostAt && gap < OPT.minGap) await new Promise((r) => setTimeout(r, OPT.minGap - gap))
  const res = await request(URLS.addSign, { method: 'POST', body: `project_id=${projectId}&type=${type}`, ajax: true })
  postCount++
  lastPostAt = Date.now()
  const cls = classify(res)
  if (journalPath) await appendFile(journalPath, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'sign', id: projectId, type, httpStatus: res.status, ...cls })}\n`)
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
  banner('无锡一中选修课抢课工具 · 纯 fetch 版')
  console.log(`  账号：${cfg.name} / ${cfg.id_number}`)
  console.log(`  日志：${journalPath}`)

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
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(100, startAt - Date.now()))))
    }
    process.stdout.write('\n')
  }
  if (hardEnd == null) hardEnd = Date.now() + OPT.duration * 1000

  const startedAt = Date.now()
  let round = 0
  let stop = false
  process.on('SIGINT', () => { stop = true; console.log('\n收到中断，正在收尾…') })

  console.log(`\n开始抢课：type=${OPT.type}  interval=${OPT.interval}ms  burst=${OPT.burst}  max-posts=${OPT.maxPosts}${OPT.dryRun ? '  [DRY-RUN 不发 POST]' : ''}`)
  console.log('Ctrl+C 可随时停止\n')

  while (pending.size && Date.now() < hardEnd && !stop) {
    round++
    let won = false

    for (const t of [...pending.values()]) {
      if (stop || Date.now() >= hardEnd) break
      if (!pending.has(t.id)) continue

      for (let b = 0; b < OPT.burst; b++) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        const res = OPT.dryRun
          ? { kind: 'retry', msg: `DRY-RUN 本应 POST ${URLS.addSign}  body=project_id=${t.id}&type=${OPT.type}` }
          : await addSign(t.id, OPT.type)

        if (res.kind === 'success') {
          console.log(`  [${elapsed}s] ✓ 成功  #${t.id} 课位${t.pos} ${t.name} —— ${res.msg}`)
          done.set(t.id, res); pending.delete(t.id); won = true
          for (const o of [...pending.values()]) {
            if (conflicts(t.slots, o.slots)) {
              console.log(`            ⛔ 停止 #${o.id}（课位${o.pos} 与 #${t.id} 冲突）`)
              done.set(o.id, { kind: 'conflict', msg: `与已成功的 #${t.id} 课位冲突` })
              pending.delete(o.id)
            }
          }
          break
        }
        if (res.kind === 'already') { console.log(`  [${elapsed}s] ○ #${t.id} ${t.name} —— ${res.msg}（视为已有，停止）`); done.set(t.id, res); pending.delete(t.id); break }
        if (res.kind === 'full') { console.log(`  [${elapsed}s] ✗ #${t.id} ${t.name} —— ${res.msg}（已满，停止重试）`); done.set(t.id, res); pending.delete(t.id); break }
        if (res.kind === 'loggedout') {
          console.log(`  [${elapsed}s] ! 登录失效，自动重新登录…`)
          await rm(SESSION_FILE, { force: true })
          if (!(await ensureLogin())) { stop = true; break }
          continue
        }
        if (res.kind === 'aborted') { stop = true; break }
        if (b === OPT.burst - 1) {
          process.stdout.write(`\r  第${round}轮 待抢${pending.size} POST累计${postCount}  #${t.id}: ${String(res.msg).slice(0, 30)}          `)
        }
      }
      if (won) break
    }

    if (stop || pending.size === 0) break
    await new Promise((r) => setTimeout(r, OPT.interval * (0.8 + Math.random() * 0.4)))
  }

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

  console.log(`\nPOST 总数：${postCount}（上限 ${OPT.maxPosts}）   轮次：${round}   耗时：${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
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
