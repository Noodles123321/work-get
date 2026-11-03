/**
 * dsh-workget-bridge — Work GET 扩展 → DSH 的岗位投递桥
 *
 *   扩展侧边栏点「推送到 DSH」 → POST http://127.0.0.1:3610/push（Bearer token）
 *   → 校验/去重 → 在本 profile 里 agents.create() 开一个新会话 → followup 首条消息。
 *
 * 只监听 127.0.0.1；状态（token/日志/快照）都在 stateDir（默认工作区 .dsh-bridge/）。
 */

import { createHash } from 'node:crypto'

import { createLogger, ensureDir, ensureToken, pathsOf, resolveConfig } from './config.js'
import { createBridgeServer } from './http.js'
import { deliverSession } from './session.js'

export const name = 'dsh-workget-bridge'
export const inject = ['tools', 'agents']

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  ensureDir(cfg.stateDir)
  const log = createLogger(pathsOf(cfg).log, cfg.logMaxBytes)

  if (!cfg.enabled) {
    log('已禁用（enabled=false）')
    return
  }

  let token
  try {
    token = ensureToken(cfg)
  } catch (error) {
    log(`初始化失败（token）：${error && error.message ? error.message : error}`)
    return
  }

  const bridge = createBridgeServer({
    cfg,
    log,
    deliver: (payload) => deliverSession(ctx, cfg, payload, log),
  })

  bridge.start().then(
    (addr) => {
      log(
        `已启动 http://${addr.host}:${addr.port} 工作区=${cfg.workspaceDir} 状态目录=${cfg.stateDir} ` +
          `token=${createHash('sha1').update(token).digest('hex').slice(0, 8)}… 上限=${cfg.maxJobs} 条`,
      )
    },
    (error) => {
      log(`监听失败（${cfg.host}:${cfg.port}）：${error && error.message ? error.message : error}`)
    },
  )

  ctx.effect(() => () => {
    log('已停止，关闭 HTTP 服务')
    bridge.stop().catch(() => {})
  })
}
