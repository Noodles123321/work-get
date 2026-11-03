/**
 * dsh-workget-bridge — 配置解析与状态目录
 *
 * 目标：扩展侧边栏「推送到 DSH」→ 本机 127.0.0.1:3610 → 在这里校验 → 开一个 DSH 会话。
 * 所有路径/端口/token 都在这里收敛，别处不要硬编码。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 3610,
  /** 空 = 首次启动自动生成，写到 <stateDir>/token.txt */
  token: '',
  stateDir: 'E:/DP_HANS/Work_GET/.dsh-bridge',
  /** 新会话的工作区（会话 header 的 cwd） */
  workspaceDir: 'E:/DP_HANS/Work_GET',
  /** 空 = <stateDir>/snapshots */
  snapshotDir: '',
  maxJobs: 20,
  maxBodyBytes: 512 * 1024,
  /** 单条 prompt 上限，超出截断岗位描述 */
  maxPromptChars: 12000,
  sessionTitlePrefix: '岗位推送',
  writeSnapshot: true,
  /** 同批岗位在这个窗口内重复推送 → 直接返回上次 sessionId */
  dedupeWindowMs: 10 * 60 * 1000,
  logMaxBytes: 512 * 1024,
}

function pickInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function pickStr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text === '' ? fallback : text
}

export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const stateDir = pickStr(input.stateDir, DEFAULTS.stateDir).replace(/\\/g, '/')
  const cfg = {
    enabled: input.enabled === undefined ? DEFAULTS.enabled : Boolean(input.enabled),
    host: pickStr(input.host, DEFAULTS.host),
    // 0 = 由系统分配空闲端口（仅供自检使用）
    port: pickInt(input.port, DEFAULTS.port, 0, 65535),
    token: pickStr(input.token, ''),
    stateDir,
    workspaceDir: pickStr(input.workspaceDir, DEFAULTS.workspaceDir).replace(/\\/g, '/'),
    snapshotDir: pickStr(input.snapshotDir, ''),
    maxJobs: pickInt(input.maxJobs, DEFAULTS.maxJobs, 1, 200),
    maxBodyBytes: pickInt(input.maxBodyBytes, DEFAULTS.maxBodyBytes, 8 * 1024, 8 * 1024 * 1024),
    maxPromptChars: pickInt(input.maxPromptChars, DEFAULTS.maxPromptChars, 1000, 200_000),
    sessionTitlePrefix: pickStr(input.sessionTitlePrefix, DEFAULTS.sessionTitlePrefix),
    writeSnapshot: input.writeSnapshot === undefined ? DEFAULTS.writeSnapshot : Boolean(input.writeSnapshot),
    dedupeWindowMs: pickInt(input.dedupeWindowMs, DEFAULTS.dedupeWindowMs, 0, 24 * 3600 * 1000),
    logMaxBytes: pickInt(input.logMaxBytes, DEFAULTS.logMaxBytes, 16 * 1024, 64 * 1024 * 1024),
  }
  if (!cfg.snapshotDir) cfg.snapshotDir = join(cfg.stateDir, 'snapshots').replace(/\\/g, '/')
  return cfg
}

export function pathsOf(cfg) {
  return {
    log: join(cfg.stateDir, 'bridge.log'),
    token: join(cfg.stateDir, 'token.txt'),
    pushes: join(cfg.stateDir, 'pushes.jsonl'),
    snapshots: cfg.snapshotDir,
  }
}

export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 已存在或无权限：交给后续写入报错
  }
}

/**
 * token 解析顺序：显式配置 > 已有 token.txt > 新生成。
 * 只在绑 127.0.0.1 的前提下，token 是本机唯一的门闩。
 */
export function ensureToken(cfg) {
  if (cfg.token) return cfg.token
  const file = pathsOf(cfg).token
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text) {
      cfg.token = text
      return text
    }
  } catch {
    // 文件不存在，生成新的
  }
  const token = randomBytes(24).toString('hex')
  ensureDir(cfg.stateDir)
  writeFileSync(file, token + '\n', 'utf8')
  cfg.token = token
  return token
}

/** 轻量日志：超过上限就清空重写，失败静默（日志不能影响主流程）。 */
export function createLogger(file, maxBytes = DEFAULTS.logMaxBytes) {
  return function log(message) {
    const line = '[' + new Date().toISOString() + '] ' + message + '\n'
    try {
      ensureDir(join(file, '..'))
      try {
        if (existsSync(file) && readFileSync(file, 'utf8').length > maxBytes) writeFileSync(file, '', 'utf8')
      } catch {
        // 读不到就当空文件
      }
      writeFileSync(file, line, { encoding: 'utf8', flag: 'a' })
    } catch {
      // 日志失败忽略
    }
  }
}
