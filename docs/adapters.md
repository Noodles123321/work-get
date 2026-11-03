# 平台适配指南（选择器维护）

Work GET 把「平台长什么样」和「怎么处理数据」彻底分开：

- `src/adapters/base.ts` 是引擎，负责按规则抽字段、拼绝对链接、抠岗位 ID、找卡片
- `src/adapters/selectors/{platform}.json` 是数据，只描述选择器
- `src/adapters/registry.ts` 负责合并本地覆盖（`kv` 表里的 `selector-overrides`）

改版后**通常只需要改 JSON**，不用碰 TypeScript。

---

## 一、配置结构

```jsonc
{
  "id": "boss",                       // boss | liepin | zhaopin | yupao
  "label": "BOSS直聘",
  "hosts": ["zhipin.com"],            // 子域自动匹配：www.zhipin.com 命中
  "listUrlPattern": "/(web/geek/job|web/geek/jobs|job_detail)",  // 匹配 pathname + search
  "detailUrlPattern": "/job_detail/", // 匹配 pathname，用于判断详情页
  "listItem": ["ul.job-list-box > li"],        // 卡片选择器，按顺序取第一个有命中的
  "listContainer": ["ul.job-list-box"],        // 详情页抽取的根节点
  "fields": {                         // 列表卡片内字段
    "title": [".job-name"],
    "company": [".company-name"],
    "salary": [".salary"],
    "city": [".job-area"],
    "district": [".job-area span:last-child"],
    "experience": [".tag-list li:nth-child(1)"],
    "education": [".tag-list li:nth-child(2)"],
    "tags": { "selector": [".tag-list li"], "all": true },
    "hrName": [".info-public"],
    "hrActive": [".info-public em"],
    "description": [".job-sec-text"],
    "extra_settlement": [".salary-type"]        // extra_* 会进 job.extra
  },
  "detailFields": { /* 详情页覆盖字段，结构同上 */ },
  "link": { "selector": [".job-name"], "attr": "href" },
  "jobId": { "from": "href", "pattern": "/job_detail/([0-9A-Za-z~_]+)\\.html" },
  "apply": {
    "button": [".start-chat-btn"],   // 点开沟通入口
    "input": [".chat-input", "[contenteditable='true']"],  // 聊天输入框
    "send": [".send-message"]        // 发送按钮（autoSend=true 时才会点）
  }
}
```

### 字段规则 `FieldRule` 的三种写法

| 写法 | 含义 |
| --- | --- |
| `".job-name"` | 单个选择器，取 `textContent` |
| `[".job-name", ".job-title"]` | 候选列表，按顺序取**第一个非空**结果 |
| `{ "selector": [".a", ".b"], "attr": "data-name", "all": true }` | 读属性而非文本；`all: true` 取所有匹配（主要给 `tags` 用） |

补充约定：

- 任何非法选择器都不会抛异常，只会返回空（引擎里统一 `try/catch`）
- `link` 必须能从卡片拿到 `href`，否则无法补全 URL、也无法算稳定 ID
- `jobId.pattern` 必须带**一个捕获组**，捕获组就是 `platformJobId`
- 抽取不到 ID 时会用「标题 + 公司 + 链接」哈希生成兜底 ID，能入库但跨天可能重复
- 字段抽取为空时 `title` 缺失的卡片会被直接跳过（避免抓到广告位）

---

## 二、改完怎么验证：选择器自检

侧边栏「设置」→「选择器自检」会向当前标签页发 `WORKGET_SELFTEST`，返回：

```jsonc
{
  "ok": true,
  "platform": "boss",
  "url": "https://www.zhipin.com/web/geek/job?query=react",
  "isListPage": true,
  "isDetailPage": false,
  "loginState": "logged-in",
  "risk": null,
  "listItem": { "selector": "ul.job-list-box > li", "count": 30 },   // -1 = 选择器语法错误
  "fields": { "title": [{ "selector": ".job-name", "count": 30 }], ... },
  "apply": { "button": [{...}], "input": [{...}], "send": [{...}] },
  "sample": { "platformJobId": "abc123", "title": "前端开发工程师", ... }  // 第一条样本
}
```

判读方法：

1. `listItem.count > 0`，且 `sample.title` / `sample.url` 正确 → 基本可用
2. `count` 为 0 → 该选择器失效，去 DevTools 里重新找一个（优先用语义化 class，别用 nth-child 定位业务字段）
3. `count` 为 -1 → 选择器语法写错
4. `sample.salary` / `sample.city` 为空 → 只是少字段，不影响入库
5. `apply.button.count` 为 0 → 「去沟通」会失败，但不影响采集

## 三、真机校准 5 步

1. 在浏览器里登录该平台，打开一个搜索结果列表页
2. 打开侧边栏 → 设置 → 选择器自检，确认 `isListPage: true`
3. 按上表逐项对照 DevTools：`listItem` → `title` / `company` / `salary` / `link`
4. 改 `src/adapters/selectors/{platform}.json` → `npm run build` → 扩展页点「重新加载」→ 刷新平台页面
5. 看侧边栏「岗位」是否出现数据；点一个岗位的「去沟通」验证 `apply` 三组选择器

> 不想重新构建？设置页支持粘贴一份 JSON 覆盖（存进 `kv.selector-overrides`，由后台 `WORKGET_CONFIG` 下发），适合临时救火。覆盖值优先于打包内置的 JSON。

## 四、四个平台的已知难点

| 平台 | 难度 | 要点 |
| --- | --- | --- |
| BOSS直聘 | 高 | `__zp_stoken__` 等反爬参数（**不要碰**）；滑块/安全验证频发；列表虚拟滚动（滚动后 DOM 会重建，需按 `platformJobId` 去重）；每日主动沟通有硬上限；沟通按钮在卡片内，点开会右侧抽屉而非新页面 |
| 猎聘 | 中高 | 登录态校验较严；列表卡片 class 带哈希后缀，选择器尽量用 `[class*='job-card']`；详情页 `/job/{id}.shtml` |
| 智联招聘 | 中 | 列表结构相对稳定；详情页 `/jobdetail/{id}.htm`；部分城市站域名不同（`sou.zhaopin.com` 等），`hosts` 已按后缀匹配 |
| 鱼泡网 | 中低 | 蓝领工种，字段差异大（工种、结算方式、是否包吃住）；用 `extra_*` 承载；详情页 `/(?:job|jobs)/(\d+)` |

用 `[class*='xxx']` 这类模糊匹配能扛住 class 哈希变化，但容易误命中；优先挑语义明确的容器，再用 `:nth-child` 只做兜底。

## 五、风控识别词维护

风控检测独立于选择器，在 `src/shared/guard.ts` 的 `PATTERNS` 里：

- `captcha`：安全验证 / 人机验证 / 滑动验证 / 验证码 …
- `frequent`：操作频繁 / 请稍后再试 / 操作太快 …
- `login`：登录失效 / 请先登录 / 异常登录 …

页面全文（前 5 万字）命中任一正则就上报后台，后台累计 2 条（10 分钟内）即熔断该平台并弹通知。新平台出现新的提示文案时，往对应数组里加正则即可，注意不要写得太宽（会把正常页面误判成风控）。

## 六、新增一个平台

1. 在 `src/shared/types.ts` 的 `Platform` 联合类型和 `PLATFORM_META` 加一项
2. 新建 `src/adapters/selectors/{id}.json`
3. `src/adapters/registry.ts` 的 `DEFAULT_CONFIGS` 里注册
4. `wxt.config.ts` 的 `HOST_PERMISSIONS` 加域名（manifest 权限变了要重新加载扩展）
5. `src/entrypoints/content.ts` 的 `defineContentScript.matches` 加同样的域名
6. 补一条适配器测试（参考 `tests/adapter.test.ts`，用最小 HTML 片段验证抽取）
