/**
 * dsh-workget-bridge 运行态自检（需要 DSH 已启动并加载插件）
 *
 *   node dsh-plugin/scripts/selfcheck.mjs [http://127.0.0.1:3610] [token 文件路径]
 *
 * 只读：/health + 一次「空 jobs」探测（验证 token 被接受，不会产生会话）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const base = (process.argv[2] || 'http://127.0.0.1:3610').replace(/\/+$/, '')
const tokenFile = process.argv[3] || join(process.cwd(), '.dsh-bridge', 'token.txt')

function fail(message) {
  console.log(`FAIL ${message}`)
  process.exitCode = 1
}

let health
try {
  const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
  health = await res.json()
} catch (error) {
  fail(`${base}/health 不可达：${error?.message || error}`)
  console.log('提示：确认 DSH 已重启、插件已启用（bridge.log）、端口与设置页一致。')
  process.exit(1)
}

console.log('health:', JSON.stringify(health, null, 2))
if (health.name !== 'dsh-workget-bridge') fail(`服务名不对：${health.name}`)
else console.log('PASS /health 正常（uptime ' + Math.round((health.uptimeMs || 0) / 1000) + 's）')

let token = ''
try {
  token = readFileSync(tokenFile, 'utf8').trim()
} catch {
  fail(`读不到 token 文件：${tokenFile}`)
}

if (token) {
  console.log(`本地 token 指纹：${health.tokenFingerprint || '(未返回)'}`)
  const res = await fetch(`${base}/push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jobs: [] }),
    signal: AbortSignal.timeout(4000),
  })
  const body = await res.json()
  if (res.status === 400 && body.error === 'empty_jobs') console.log('PASS token 被接受（空 jobs 被正确拒绝，未创建会话）')
  else if (res.status === 401) fail('token 不匹配：把 token.txt 的内容填到扩展「设置 → DSH 侧」')
  else fail(`意料之外的响应：${res.status} ${JSON.stringify(body)}`)
}

if (process.exitCode) console.log('\nFAILED')
else console.log('\nOK：bridge 运行正常')
