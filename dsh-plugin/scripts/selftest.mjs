/**
 * dsh-workget-bridge 自检（离线契约测试，不需要 DSH 运行时）
 *
 *   node dsh-plugin/scripts/selftest.mjs
 *
 * 用真实的 http.js + prompt.js + 临时状态目录跑一遍 HTTP 契约，
 * deliver 用假的（不创建 DSH 会话）。退出码 0 = 全绿。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createLogger, resolveConfig } from '../lib/config.js'
import { createBridgeServer } from '../lib/http.js'

const stateDir = join(process.cwd(), '.dsh-bridge', 'selftest')
const TOKEN = 'selftest-token'
const MAX_JOBS = 5

let failures = 0
function check(name, condition, extra) {
  if (condition) {
    console.log(`  PASS ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
}

function job(id, overrides = {}) {
  return {
    id: `boss:${id}`,
    platform: 'boss',
    platformJobId: id,
    title: `前端工程师 ${id}`,
    company: '示例科技',
    city: '成都',
    salary: { min: 20000, max: 30000, unit: 'month', raw: '20-30K·14薪' },
    experienceMin: 3,
    experienceMax: 5,
    education: '本科',
    tags: ['React', 'TypeScript'],
    url: `https://www.zhipin.com/job_detail/${id}.html`,
    ruleScore: 78,
    ...overrides,
  }
}

function makePayload(jobs) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jobs }),
  }
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true })

  const cfg = resolveConfig({ stateDir, port: 0, token: TOKEN, maxJobs: MAX_JOBS })
  const log = createLogger(join(stateDir, 'bridge.log'), 64 * 1024)

  const delivered = []
  const bridge = createBridgeServer({
    cfg,
    log,
    deliver: async (payload) => {
      delivered.push(payload)
      return { sessionId: `session-selftest-${delivered.length}` }
    },
  })

  const { host, port } = await bridge.start()
  const base = `http://${host}:${port}`

  try {
    console.log('健康检查')
    const health = await fetch(`${base}/health`)
    const healthBody = await health.json()
    check('GET /health 200', health.status === 200, health.status)
    check('name 正确', healthBody.name === 'dsh-workget-bridge', healthBody.name)
    check('不回传明文 token', !JSON.stringify(healthBody).includes(TOKEN), healthBody)

    console.log('CORS')
    const preflight = await fetch(`${base}/push`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://abc' } })
    check('OPTIONS 204', preflight.status === 204, preflight.status)
    check('allow-origin', preflight.headers.get('access-control-allow-origin') === '*', preflight.headers.get('access-control-allow-origin'))

    console.log('鉴权')
    const noToken = await fetch(`${base}/push`, { method: 'POST', body: '{}' })
    check('无 token → 401', noToken.status === 401, noToken.status)
    const badToken = await fetch(`${base}/push`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: '{}',
    })
    check('错 token → 401', badToken.status === 401, badToken.status)

    console.log('入参校验')
    const badJson = await fetch(`${base}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    check('坏 JSON → 400 bad_json', badJson.status === 400 && (await badJson.json()).error === 'bad_json', badJson.status)

    const empty = await fetch(`${base}/push`, makePayload([]))
    const emptyBody = await empty.json()
    check('空 jobs → 400 empty_jobs', empty.status === 400 && emptyBody.error === 'empty_jobs', emptyBody)

    const tooMany = await fetch(`${base}/push`, makePayload(Array.from({ length: MAX_JOBS + 1 }, (_, i) => job(String(i + 1)))))
    const tooManyBody = await tooMany.json()
    check('超条数 → 400 too_many_jobs', tooMany.status === 400 && tooManyBody.error === 'too_many_jobs', tooManyBody)

    console.log('正常推送')
    const batch = [job('1001'), job('1002', { title: '高级前端\u202e工程师\n急招' })]
    const first = await fetch(`${base}/push`, makePayload(batch))
    const firstBody = await first.json()
    check('推送 200', first.status === 200, firstBody)
    check('返回 sessionId', typeof firstBody.sessionId === 'string' && firstBody.sessionId.startsWith('session-'), firstBody.sessionId)
    check('count=2', firstBody.count === 2, firstBody.count)
    check('duplicate=false', firstBody.duplicate === false, firstBody.duplicate)
    check('deliver 被调用一次', delivered.length === 1, delivered.length)

    const message = delivered[0]?.message || ''
    check('prompt 含外部数据警示', message.includes('外部数据'), message.slice(0, 80))
    check('prompt 含平台名', message.includes('BOSS直聘'), false)
    check('prompt 含表格行', message.includes('前端工程师 1001'), false)
    check('prompt 末尾有指令块', message.includes('不要复述表格'), false)

    const sentTitle = delivered[0]?.jobs?.[1]?.title || ''
    check('清洗控制字符（RTL 覆盖）', !/[\u202a-\u202e]/.test(sentTitle), JSON.stringify(sentTitle))
    check('清洗换行', !/\n/.test(sentTitle), JSON.stringify(sentTitle))

    const snapshot = firstBody.snapshot
    check('快照文件已写', Boolean(snapshot) && existsSync(snapshot), snapshot)
    if (snapshot && existsSync(snapshot)) {
      const text = readFileSync(snapshot, 'utf8')
      check('快照含 fingerprint', text.includes(firstBody.fingerprint), firstBody.fingerprint)
      check('快照含 sessionId', text.includes(firstBody.sessionId), firstBody.sessionId)
    }

    console.log('去重')
    const again = await fetch(`${base}/push`, makePayload(batch))
    const againBody = await again.json()
    check('二次推送 200', again.status === 200, again.status)
    check('duplicate=true', againBody.duplicate === true, againBody.duplicate)
    check('复用同一 sessionId', againBody.sessionId === firstBody.sessionId, againBody.sessionId)
    check('没有再调 deliver', delivered.length === 1, delivered.length)

    const reordered = await fetch(`${base}/push`, makePayload([...batch].reverse()))
    const reorderedBody = await reordered.json()
    check('顺序无关去重', reorderedBody.duplicate === true, reorderedBody.duplicate)

    const different = await fetch(`${base}/push`, makePayload([job('1003')]))
    const differentBody = await different.json()
    check('不同批次不误判', differentBody.duplicate === false, differentBody.duplicate)
    check('新会话 id', differentBody.sessionId !== firstBody.sessionId, differentBody.sessionId)

    console.log('路由')
    const notFound = await fetch(`${base}/nope`)
    check('未知路径 404', notFound.status === 404, notFound.status)
    const wrongMethod = await fetch(`${base}/push`, { method: 'GET' })
    check('/push GET 405', wrongMethod.status === 405, wrongMethod.status)
  } finally {
    await bridge.stop()
  }

  const counters = bridge.counters
  check('计数器：2 次成功投递', counters.pushes === 2, counters.pushes)
  check('计数器：重复计数', counters.duplicates === 2, counters.duplicates)

  console.log('')
  if (failures > 0) {
    console.log(`FAILED：${failures} 项未通过`)
    process.exitCode = 1
    return
  }
  console.log('OK：dsh-workget-bridge 契约自检全部通过')
}

main().catch((error) => {
  console.error('自检崩溃：', error)
  process.exitCode = 1
})
