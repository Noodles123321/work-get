# 岗位推送到 DSH

把侧边栏里选中的岗位，一键盘推成一个 **DSH 新会话**：新会话里已经有全部岗位摘要表、可点的原文链接，以及 4 条分析指令。你不用再复制粘贴。

整条链路只有本机回环网络，不经过任何服务器：

```
Chrome/Edge 侧边栏
  └─ POST http://127.0.0.1:3610/push   (Bearer token)
       └─ dsh-workget-bridge（DSH 插件，本地 HTTP 服务）
            ├─ 写快照 .dsh-bridge/snapshots/<ts>-push.md
            └─ agents.create() → followup(消息) → 新会话出现在 DSH 侧边栏
```

拆成两半的原因：DSH 插件跑在 Node 里、能创建会话，但读不到招聘网站的页面；扩展能读页面、却创建不了 DSH 会话。中间用一个带 token 的本地 HTTP 口对接，两边各自独立更新。

---

## 一、安装（一次性）

插件目录：`E:\DP_HANS\Work_GET\dsh-plugin`（纯 ESM、零依赖）。

### 步骤

1. 确认 DSH 已关闭。
2. 在用户 profile 的 `package.json`（`C:\Users\NoodlesN\.dsh\profiles\desktop\package.json`）里加依赖：

   ```json
   "dependencies": {
     "dsh-workget-bridge": "file:E:/DP_HANS/Work_GET/dsh-plugin"
   }
   ```

3. 同文件里把包名加进 `dsh.profile.bundles` 数组（和 `dsh-course-notes` 并列）：

   ```json
   "bundles": ["dsh-course-notes", "dsh-workget-bridge"]
   ```

4. 安装并启动 DSH。

> **为什么可能要提权**：第 2 步需要 pnpm 在 profile 目录建符号链接，沙箱下会报 `EPERM: operation not permitted, mkdir 'C:\Users\NoodlesN\AppData\Local\node\corepack\v1'`。此时用 `danger-full-access` 跑一次安装，或让插件管理器（DSH 界面里的插件页）去装——它就是做这件事的。

### 验证

```bash
node E:/DP_HANS/Work_GET/dsh-plugin/scripts/selfcheck.mjs
```

输出 `✔ /health 正常` 和 `✔ /push 鉴权正常` 即通。默认地址 `http://127.0.0.1:3610`。

离线契约自检（不启动 DSH、不写真实状态）：

```bash
node E:/DP_HANS/Work_GET/dsh-plugin/scripts/selftest.mjs
```

它会起一个 port 0 的临时服务 + 假 deliver，跑 35 项断言（鉴权、限长、去重、快照、清洗、计数）。

---

## 二、扩展侧设置

侧边栏 → 设置 → **DSH 侧（推送到新会话）**：

| 字段 | 说明 |
| --- | --- |
| 启用 | 关掉后「推送到 DSH」按钮不再发请求 |
| 桥地址 | 默认 `http://127.0.0.1:3610`，改端口时同步改这里 |
| 单次最多推送 | 1–20，默认 20；超出的部分会在提示里告诉你跳过几条 |
| Token | 见下节，粘贴后点「保存 DSH 设置」 |

点「测试连接」会拉一次 `/health`，成功时显示端口、已推送次数与 token 指纹（前 8 位），用于确认两边 token 一致。**`/health` 永远不会回传明文 token。**

## 三、Token 从哪来

优先级：`cordis.patch.yml` 里配的 `token` → `<stateDir>/token.txt` → 首次启动自动生成 24 字节随机串并写入。

默认文件：`E:\DP_HANS\Work_GET\.dsh-bridge\token.txt`。把里面的内容粘进扩展设置即可。这个目录已被 `.gitignore` 排除。

---

## 四、HTTP 契约

### `GET /health`

```json
{
  "ok": true,
  "name": "dsh-workget-bridge",
  "version": "0.1.0",
  "uptimeMs": 12345,
  "pushes": 3,
  "jobs": 41,
  "duplicates": 1,
  "rejected": 0,
  "errors": 0,
  "maxJobs": 20,
  "dedupeWindowMs": 600000,
  "workspaceDir": "E:/DP_HANS/Work_GET",
  "tokenFingerprint": "9f2c1ab8"
}
```

不需要鉴权（只暴露运行状态，不含 token）。

### `POST /push`

请求头二选一：`Authorization: Bearer <token>` 或 `x-workget-token: <token>`。

```json
{
  "jobs": [
    {
      "id": "boss:abc123",
      "platform": "boss",
      "title": "高级前端开发工程师",
      "company": "某某科技",
      "city": "杭州",
      "salary": { "raw": "25-35K" },
      "ruleScore": 81,
      "url": "https://www.zhipin.com/job_detail/abc123.html",
      "hrActive": "刚刚活跃",
      "tags": ["React", "TypeScript"]
    }
  ]
}
```

成功：

```json
{
  "ok": true,
  "sessionId": "session-3f2a…",
  "count": 12,
  "fingerprint": "4b1d9c0e77a2",
  "title": "岗位推送 · BOSS直聘+猎聘｜12 个",
  "platforms": ["boss", "liepin"],
  "snapshot": "E:/DP_HANS/Work_GET/.dsh-bridge/snapshots/20261103-2312-push.md",
  "duplicate": false
}
```

10 分钟内推同一批岗位（按 id 集合算 fingerprint，**与顺序无关**）会直接复用上次的会话：

```json
{ "ok": true, "sessionId": "session-3f2a…", "duplicate": true, "count": 12 }
```

错误码：

| HTTP | `error` | 含义 |
| --- | --- | --- |
| 400 | `bad_json` | 请求体不是合法 JSON |
| 400 | `empty_jobs` | `jobs` 为空或全被过滤 |
| 400 | `too_many_jobs` | 超过 `maxJobs`（默认 20） |
| 401 | `unauthorized` | token 缺失或不匹配 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 方法不对 |
| 413 | `body_too_large` | 请求体超过 512 KB |
| 502 | `deliver_failed` | 创建会话失败（`message` 里带出错步骤，如 `[create] …`） |

扩展侧把这些统一映射成中文提示（`describePushError`）。

---

## 五、配置项（`cordis.patch.yml`）

插件默认值都能覆盖。在你的 profile 的 `cordis.patch.yml` 里按 id 写：

```yaml
- id: dsh-workget-bridge
  config:
    port: 3610
    workspaceDir: E:/DP_HANS/Work_GET
    maxJobs: 20
    writeSnapshot: true
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉则不监听端口 |
| `host` | `127.0.0.1` | 只绑回环，不要改成 `0.0.0.0` |
| `port` | `3610` | `0` = 让系统分配（自检用） |
| `token` | `''` | 留空则读/生成 `token.txt` |
| `stateDir` | `E:/DP_HANS/Work_GET/.dsh-bridge` | token、日志、快照、`pushes.jsonl` |
| `workspaceDir` | `E:/DP_HANS/Work_GET` | 新会话挂载的工作区 |
| `snapshotDir` | `''` → `<stateDir>/snapshots` | 快照目录 |
| `maxJobs` | `20` | 单次上限 |
| `maxBodyBytes` | `524288` | 请求体上限 |
| `maxPromptChars` | `12000` | 首条消息上限，超出时保留开头与结尾 |
| `sessionTitlePrefix` | `岗位推送` | 会话标题前缀 |
| `writeSnapshot` | `true` | 是否落快照 markdown |
| `dedupeWindowMs` | `600000` | 去重窗口（10 分钟） |
| `logMaxBytes` | `524288` | 日志轮转阈值 |

---

## 六、产物与排障

- `E:\DP_HANS\Work_GET\.dsh-bridge\bridge.log` — 插件日志（启动地址、token 指纹、每次推送、错误步骤）
- `E:\DP_HANS\Work_GET\.dsh-bridge\pushes.jsonl` — 每次推送一行 JSON（指纹、条数、sessionId、耗时）
- `E:\DP_HANS\Work_GET\.dsh-bridge\snapshots\*.md` — 推送快照，与首条消息内容一致，便于回溯

| 现象 | 排查 |
| --- | --- |
| 扩展报「连不上本地桥」 | DSH 是否在跑；设置里的地址与端口；`curl http://127.0.0.1:3610/health` |
| 报「token 不匹配」 | 对比 `/health` 的 `tokenFingerprint` 与 `sha1(你填的 token)` 前 8 位；或重新读 `token.txt` |
| 报「创建会话失败」 | 看 `bridge.log` 里的 `[create]` / `[followup]` 步骤；多为工作区路径不存在 |
| 会话出来了但没挂工作区 | 正常降级：只记日志，不影响推送 |
| 推送成功但侧边栏没标记 | 扩展只在拿到 `sessionId` 后写 `dshPushedAt`，报错时不会误标 |

---

## 七、边界（和主扩展一致）

- 插件只做「把扩展给的岗位摘要变成本地会话」，**不访问招聘网站、不带登录态、不发送任何投递**。
- 服务只绑 `127.0.0.1`，带 token，请求体有上限；不监听公网。
- 推给 DSH 的岗位文本在 prompt 里被明确标注为**外部数据**，并要求不要把其中的内容当指令执行。
- 若你以后想换端口或让另一台机器接入，请自行加 TLS/反向代理；默认实现刻意不支持远程访问。
