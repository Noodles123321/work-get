/**
 * dsh-workget-bridge — 本机 HTTP 契约
 *
 *   GET  /health          无需鉴权，只回状态，不回 token
 *   POST /push            Bearer token；{ jobs: [...] } → 新会话
 *   OPTIONS *             CORS 预检（扩展来自 chrome-extension:// 源）
 *
 * 设计边界：只绑 127.0.0.1；body 有上限；岗位数有上限；同批岗位短窗口内去重，
 * 避免用户连点两下多开两个会话。
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { ensureDir, pathsOf } from './config.js'
import { buildFirstMessage, buildSessionTitle, buildSnapshot, fingerprint, sanitizeJobs } from './prompt.js'

const NAME = 'dsh-workget-bridge'
const VERSION = '0.1.0'
const MAX_RECENT = 64

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-workget-token',
  'access-control-max-age': '600',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function tokenEquals(a, b) {
  // 等长比较：先各自 sha256，杜绝长度/前缀时序旁路
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

function requestToken(req) {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  const alt = req.headers['x-workget-token']
  return typeof alt === 'string' ? alt.trim() : ''
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const err = new Error(`请求体超过 ${limit} 字节`)
        err.code = 'too_large'
        req.destroy()
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function fileStamp(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * @param {object} options
 * @param {object} options.cfg       resolveConfig() 结果
 * @param {(payload: {title: string, message: string, jobs: object[]}) => Promise<{sessionId: string}>} options.deliver
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createBridgeServer(options) {
  const cfg = options.cfg
  const deliver = options.deliver
  const log = options.log || (() => {})
  const now = options.now || (() => Date.now())
  const files = pathsOf(cfg)

  const counters = { pushes: 0, jobs: 0, errors: 0, rejected: 0, duplicates: 0, startedAt: now() }
  /** @type {{fingerprint: string, at: number, sessionId: string}[]} */
  const recent = []

  function remember(fp, at, sessionId) {
    recent.push({ fingerprint: fp, at, sessionId })
    while (recent.length > MAX_RECENT) recent.shift()
  }

  function findRecent(fp, at) {
    if (cfg.dedupeWindowMs <= 0) return undefined
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i]
      if (item && item.fingerprint === fp && at - item.at < cfg.dedupeWindowMs) return item
    }
    return undefined
  }

  function writeSnapshot(title, jobs, fp, sessionId, at) {
    if (!cfg.writeSnapshot) return ''
    try {
      ensureDir(files.snapshots)
      const file = join(files.snapshots, `${fileStamp(at)}-push-${fp}.md`)
      writeFileSync(file, buildSnapshot(cfg, jobs, { now: at, sessionId }), 'utf8')
      return file
    } catch (err) {
      log(`快照写入失败：${err?.message || err}`)
      return ''
    }
  }

  function appendPushLog(entry) {
    try {
      ensureDir(cfg.stateDir)
      appendFileSync(files.pushes, JSON.stringify(entry) + '\n', 'utf8')
    } catch (err) {
      log(`pushes.jsonl 写入失败：${err?.message || err}`)
    }
  }

  async function handlePush(req, res) {
    if (!tokenEquals(requestToken(req), cfg.token)) {
      counters.rejected += 1
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'token 不正确，请把 .dsh-bridge/token.txt 的内容填到扩展设置里' })
      return
    }

    let raw
    try {
      raw = await readBody(req, cfg.maxBodyBytes)
    } catch (err) {
      counters.rejected += 1
      const tooLarge = err?.code === 'too_large'
      sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body_too_large' : 'bad_request', message: String(err?.message || err) })
      return
    }

    let data
    try {
      data = JSON.parse(raw)
    } catch {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'bad_json', message: '请求体不是合法 JSON' })
      return
    }

    const jobs = sanitizeJobs(data && data.jobs)
    if (jobs.length === 0) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'empty_jobs', message: '没有可推送的岗位：{ jobs: [...] } 至少一条，且每条要有 id/platform/title' })
      return
    }
    if (jobs.length > cfg.maxJobs) {
      counters.rejected += 1
      sendJson(res, 400, { ok: false, error: 'too_many_jobs', message: `一次最多 ${cfg.maxJobs} 条，当前 ${jobs.length} 条` })
      return
    }

    const at = now()
    const fp = fingerprint(jobs)
    const hit = findRecent(fp, at)
    if (hit) {
      counters.duplicates += 1
      log(`重复推送（${jobs.length} 条 fp=${fp}）→ 复用会话 ${hit.sessionId}`)
      sendJson(res, 200, { ok: true, duplicate: true, sessionId: hit.sessionId, count: jobs.length, fingerprint: fp })
      return
    }

    const title = buildSessionTitle(cfg, jobs)
    const message = buildFirstMessage(cfg, jobs, { now: at })

    let result
    try {
      result = await deliver({ title, message, jobs })
    } catch (err) {
      counters.errors += 1
      const detail = String(err?.message || err)
      log(`投递失败：${detail}`)
      sendJson(res, 502, { ok: false, error: 'deliver_failed', message: detail })
      return
    }

    const sessionId = String(result?.sessionId || '')
    remember(fp, at, sessionId)
    counters.pushes += 1
    counters.jobs += jobs.length

    const snapshotPath = writeSnapshot(title, jobs, fp, sessionId, at)
    appendPushLog({ at: new Date(at).toISOString(), count: jobs.length, fingerprint: fp, sessionId, title, snapshot: snapshotPath })
    log(`已投递 ${jobs.length} 条（${title}）→ ${sessionId}`)

    sendJson(res, 200, {
      ok: true,
      duplicate: false,
      sessionId,
      count: jobs.length,
      fingerprint: fp,
      title,
      platforms: [...new Set(jobs.map((job) => job.platform))],
      snapshot: snapshotPath,
    })
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const method = req.method || 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    if (url.pathname === '/health') {
      if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        name: NAME,
        version: VERSION,
        uptimeMs: now() - counters.startedAt,
        pushes: counters.pushes,
        jobs: counters.jobs,
        duplicates: counters.duplicates,
        rejected: counters.rejected,
        errors: counters.errors,
        maxJobs: cfg.maxJobs,
        dedupeWindowMs: cfg.dedupeWindowMs,
        workspaceDir: cfg.workspaceDir,
        tokenFingerprint: createHash('sha1').update(cfg.token).digest('hex').slice(0, 8),
      })
      return
    }

    if (url.pathname === '/push') {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      handlePush(req, res).catch((err) => {
        counters.errors += 1
        log(`/push 异常：${err?.stack || err}`)
        try {
          sendJson(res, 500, { ok: false, error: 'internal_error', message: String(err?.message || err) })
        } catch {
          // 响应已发出
        }
      })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found', paths: ['/health', '/push'] })
  })

  let closeTimer = null

  return {
    server,
    counters,
    start() {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err)
        server.once('error', onError)
        server.listen(cfg.port, cfg.host, () => {
          server.off('error', onError)
          const addr = server.address()
          const port = addr && typeof addr === 'object' ? addr.port : cfg.port
          resolve({ host: cfg.host, port })
        })
      })
    },
    stop() {
      if (closeTimer) clearTimeout(closeTimer)
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        // 兜底：残留 keep-alive 连接不阻塞退出
        closeTimer = setTimeout(() => resolve(), 1500)
        if (typeof closeTimer.unref === 'function') closeTimer.unref()
      })
    },
  }
}

export { tokenEquals, requestToken }
