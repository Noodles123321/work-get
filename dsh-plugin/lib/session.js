/**
 * dsh-workget-bridge — 把一批岗位投递到一个新会话
 *
 * 做法与 dsh-course-notes / dsh-memory-evolve 对齐（已在本机验证过）：
 *  - presets.mount 必须放进 agents.create 的 setup 回调，否则新会话缺官方工具；
 *  - attachSession 必须调用**工作区对象**（ws.attachSession），不是 workspace 服务；
 *  - followup 只保证送达，不保证新会话一定跑成功；
 *  - 挂工作区/改标题失败只记日志，不影响已投递的消息。
 *
 * 每一步都用带步骤名的错误抛出，便于 bridge.log 定位。
 */

import { randomUUID } from 'node:crypto'

const RETRY_DELAYS = [0, 300, 1200, 4000]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const errText = (error) => (error && error.message ? error.message : String(error))

function step(name, error) {
  const out = new Error('[' + name + '] ' + errText(error))
  out.cause = error
  return out
}

async function attachWorkspace(ctx, cwd, sessionId, log) {
  const workspace = ctx.get('workspace')
  if (!workspace || typeof workspace.resolveByPath !== 'function') {
    return { ok: false, error: 'workspace 服务不可用' }
  }
  let lastError = '未知错误'
  for (const delay of RETRY_DELAYS) {
    if (delay > 0) await sleep(delay)
    try {
      let ws = await workspace.resolveByPath(cwd)
      if (ws === undefined || ws === null) ws = await workspace.create(cwd)
      await ws.attachSession(sessionId)
      return { ok: true, workspaceId: ws.id ?? null, title: ws.title ?? null }
    } catch (error) {
      lastError = errText(error)
      // 目录不存在是确定性失败，不再重试
      if (/ENOENT|not exist|不存在/i.test(lastError)) break
    }
  }
  if (log) log(`挂工作区失败（${cwd}）：${lastError}`)
  return { ok: false, error: lastError }
}

/**
 * @param {object} ctx   cordis 插件上下文
 * @param {object} cfg   resolveConfig() 结果
 * @param {{title: string, message: string, jobs: object[]}} payload
 * @param {(message: string) => void} [log]
 * @returns {Promise<{sessionId: string, attach: object, titled: boolean}>}
 */
export async function deliverSession(ctx, cfg, payload, log) {
  const agents = ctx.get('agents') || ctx.agents
  if (!agents || typeof agents.create !== 'function') throw new Error('agents 服务不可用，无法创建会话')

  const sessionId = 'session-' + randomUUID()

  let preset = null
  const presets = ctx.get('agentPresets')
  if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
    try {
      const resolved = await presets.resolve(undefined)
      const presetId = String(resolved && resolved.id ? resolved.id : 'standard')
      preset = {
        id: presetId,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        },
      }
    } catch {
      preset = null
    }
  }

  let selection = null
  if (cfg.provider && cfg.model) {
    selection = { provider: cfg.provider, model: cfg.model }
  } else {
    const defaultModel = ctx.get('agentDefaultModel')
    try {
      selection = defaultModel && typeof defaultModel.currentSelection === 'function'
        ? defaultModel.currentSelection()
        : null
    } catch {
      selection = null
    }
  }

  const agentOptions = {}
  if (selection && selection.provider) agentOptions.provider = selection.provider
  if (selection && selection.model) agentOptions.model = selection.model

  const createOptions = { sessionId, meta: { cwd: cfg.workspaceDir } }
  if (Object.keys(agentOptions).length > 0) createOptions.agentOptions = agentOptions
  if (preset) {
    createOptions.setup = preset.setup
    createOptions.meta.agentPreset = preset.id
  }

  let handle
  try {
    handle = await agents.create(createOptions)
  } catch (error) {
    throw step('create', error)
  }

  const message = {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: payload.message }],
    source: { kind: 'user' },
  }

  // 先派发，保证会话有内容（否则空会话不会落盘到 sessions 目录）
  try {
    handle.agent.followup(message)
  } catch (error) {
    throw step('followup', error)
  }

  // 挂到工作区分组：必须调用工作区对象的 attachSession
  let attach = { ok: false, error: 'skipped' }
  try {
    attach = await attachWorkspace(ctx, cfg.workspaceDir, sessionId, log)
  } catch (error) {
    attach = { ok: false, error: errText(error) }
  }

  // 标题最后设置：需要 live agent；失败不影响投递
  let titled = false
  try {
    const sessionTitle = ctx.get('sessionTitle')
    if (sessionTitle && typeof sessionTitle.rename === 'function' && handle.agent && handle.agent.session) {
      await sessionTitle.rename(handle.agent.session, payload.title)
      titled = true
    }
  } catch {
    titled = false
  }

  return { sessionId, attach, titled }
}
