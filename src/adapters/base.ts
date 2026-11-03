import type { Platform, RawJob, RiskSignal } from '../shared/types';

/** 选择器规则：字符串 / 候选数组（按顺序取第一个命中的）/ 带属性的对象。 */
export type FieldRule =
  | string
  | string[]
  | { selector: string | string[]; attr?: string; all?: boolean; join?: string };

export interface PlatformConfig {
  id: Platform;
  label: string;
  hosts: string[];
  /** 命中视为岗位列表页 */
  listUrlPattern: string;
  /** 命中视为岗位详情页 */
  detailUrlPattern?: string;
  /** 列表卡片的重复选择器 */
  listItem: string[];
  listContainer?: string[];
  /** 卡片内字段 */
  fields: Record<string, FieldRule>;
  /** 详情页字段（优先于 fields） */
  detailFields?: Record<string, FieldRule>;
  link: FieldRule;
  /** 从链接/属性里抠出平台岗位 ID */
  jobId: { from: 'href' | 'attr'; selector?: string; attr?: string; pattern: string };
  apply: {
    /** 卡片或详情页上的"沟通/投递"按钮，按顺序尝试 */
    button: string[];
    /** 聊天输入框 */
    input: string[];
    /** 发送按钮 */
    send: string[];
  };
}

export interface ExtractOptions {
  /** 最多抽取多少条，防止超大页面卡死 */
  limit?: number;
  now?: number;
}

export interface PlatformAdapter {
  id: Platform;
  label: string;
  config: PlatformConfig;
  matches(url: string): boolean;
  isListPage(url: string): boolean;
  isDetailPage(url: string): boolean;
  detectLoginState(doc: Document): 'logged-in' | 'guest' | 'unknown';
  detectRiskSignal(doc: Document): RiskSignal | null;
  extractList(doc: Document, options?: ExtractOptions): RawJob[];
  extractDetail(doc: Document, url: string): RawJob | null;
  findCard(doc: Document, platformJobId: string): HTMLElement | null;
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function safeQuery(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function ruleSelectors(rule: FieldRule): { selectors: string[]; attr?: string; all?: boolean; join?: string } {
  if (typeof rule === 'string') return { selectors: [rule] };
  if (Array.isArray(rule)) return { selectors: rule };
  return { selectors: asArray(rule.selector), attr: rule.attr, all: rule.all, join: rule.join };
}

function readElement(el: Element, attr?: string): string {
  if (attr) {
    const value = el.getAttribute(attr) ?? (el as HTMLInputElement).value;
    return (value ?? '').trim();
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 按候选顺序找第一个非空值。 */
export function pickField(root: ParentNode, rule: FieldRule | undefined): string | undefined {
  if (!rule) return undefined;
  const { selectors, attr } = ruleSelectors(rule);
  for (const selector of selectors) {
    const el = safeQuery(root, selector);
    if (!el) continue;
    const text = readElement(el, attr);
    if (text) return text;
  }
  return undefined;
}

export function pickAllFields(root: ParentNode, rule: FieldRule | undefined): string[] {
  if (!rule) return [];
  const { selectors, attr } = ruleSelectors(rule);
  for (const selector of selectors) {
    const els = safeQueryAll(root, selector);
    if (els.length === 0) continue;
    return els.map((el) => readElement(el, attr)).filter(Boolean);
  }
  return [];
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function extractJobId(link: string, spec: PlatformConfig['jobId']): string | undefined {
  try {
    const re = new RegExp(spec.pattern);
    const m = link.match(re);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** 用标题+公司兜底生成稳定的本地 ID，保证没有 ID 的页面也能入库。 */
function fallbackId(job: { title?: string; company?: string; href?: string }, index: number): string {
  const seed = `${job.title ?? ''}|${job.company ?? ''}|${job.href ?? ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(36)}${index % 7}`;
}

export function buildRawJob(
  config: PlatformConfig,
  root: Element,
  doc: Document,
  fields: Record<string, FieldRule>,
  index: number,
  now = Date.now(),
): RawJob | null {
  const title = pickField(root, fields.title);
  if (!title) return null;
  const linkRule = fields.link ?? config.link;
  const href = pickField(root, linkRule) ?? '';
  const linkSelectors = ruleSelectors(linkRule).selectors;
  const firstLinkSelector = linkSelectors[0];
  const anchor = firstLinkSelector ? (safeQuery(root, firstLinkSelector) as HTMLAnchorElement | null) : null;
  const rawHref = href || anchor?.getAttribute('href') || '';
  const url = rawHref ? absolutize(rawHref, doc.baseURI) : doc.location?.href ?? '';

  const jobId =
    extractJobId(rawHref || url, config.jobId) ??
    (config.jobId.attr ? (safeQuery(root, config.jobId.selector ?? '')?.getAttribute(config.jobId.attr) ?? undefined) : undefined) ??
    fallbackId({ title, company: pickField(root, fields.company), href: rawHref }, index);

  const tags = pickAllFields(root, fields.tags);
  const raw: RawJob = {
    platform: config.id,
    platformJobId: String(jobId),
    url,
    title,
    company: pickField(root, fields.company),
    city: pickField(root, fields.city),
    district: pickField(root, fields.district),
    salaryRaw: pickField(root, fields.salary),
    experienceRaw: pickField(root, fields.experience),
    educationRaw: pickField(root, fields.education),
    tags: tags.length > 0 ? tags : undefined,
    description: pickField(root, fields.description),
    hrName: pickField(root, fields.hrName),
    hrActiveRaw: pickField(root, fields.hrActive),
    capturedAt: now,
  };

  const extra: Record<string, string> = {};
  for (const [key, rule] of Object.entries(fields)) {
    if (key.startsWith('extra_')) {
      const value = pickField(root, rule);
      if (value) extra[key.slice(6)] = value;
    }
  }
  if (Object.keys(extra).length > 0) raw.extra = extra;
  return raw;
}

export interface AdapterDeps {
  detectRisk?: (text: string) => RiskSignal | null;
}

/** innerText 只有真实浏览器里可靠；jsdom / 特殊场景回退到 textContent。 */
function bodyText(doc: Document, limit: number): string {
  const body = doc.body;
  if (!body) return '';
  const text = body.innerText || body.textContent || '';
  return text.slice(0, limit);
}

export function createAdapter(config: PlatformConfig, deps: AdapterDeps = {}): PlatformAdapter {
  const matches = (url: string): boolean => {
    try {
      const host = new URL(url).hostname;
      return config.hosts.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };

  const isListPage = (url: string): boolean => {
    try {
      return new RegExp(config.listUrlPattern).test(new URL(url).pathname + new URL(url).search);
    } catch {
      return false;
    }
  };

  const isDetailPage = (url: string): boolean => {
    if (!config.detailUrlPattern) return false;
    try {
      return new RegExp(config.detailUrlPattern).test(new URL(url).pathname);
    } catch {
      return false;
    }
  };

  return {
    id: config.id,
    label: config.label,
    config,
    matches,
    isListPage,
    isDetailPage,
    detectLoginState(doc: Document): 'logged-in' | 'guest' | 'unknown' {
      const text = bodyText(doc, 2000);
      if (/请先登录|登录后查看|立即登录/.test(text)) return 'guest';
      const hasUserEntry = safeQuery(doc, '.user-nav, [class*="user-info"], [class*="header-user"], .nav-figure');
      if (hasUserEntry) return 'logged-in';
      return 'unknown';
    },
    detectRiskSignal(doc: Document): RiskSignal | null {
      if (!deps.detectRisk) return null;
      return deps.detectRisk(bodyText(doc, 50_000));
    },
    extractList(doc: Document, options: ExtractOptions = {}): RawJob[] {
      const limit = options.limit ?? 120;
      const now = options.now ?? Date.now();
      const items: Element[] = [];
      for (const selector of config.listItem) {
        const found = safeQueryAll(doc, selector);
        if (found.length > 0) {
          items.push(...found);
          break;
        }
      }
      if (items.length === 0) return [];
      const out: RawJob[] = [];
      const seen = new Set<string>();
      items.slice(0, limit).forEach((el, index) => {
        const raw = buildRawJob(config, el, doc, config.fields, index, now);
        if (!raw) return;
        const key = `${raw.platformJobId}|${raw.title}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(raw);
      });
      return out;
    },
    extractDetail(doc: Document, url: string): RawJob | null {
      const fields = { ...config.fields, ...(config.detailFields ?? {}) };
      const roots = safeQueryAll(doc, config.listContainer?.[0] ?? 'body');
      const root = roots[0] ?? doc.body;
      if (!root) return null;
      const raw = buildRawJob({ ...config, fields }, root, doc, { ...fields, link: config.link }, 0);
      if (!raw) return null;
      raw.url = url;
      const idFromUrl = extractJobId(url, config.jobId);
      if (idFromUrl) raw.platformJobId = idFromUrl;
      return raw;
    },
    findCard(doc: Document, platformJobId: string): HTMLElement | null {
      const linkSelector = ruleSelectors(config.link).selectors[0];
      if (!linkSelector) return null;
      for (const selector of config.listItem) {
        const cards = safeQueryAll(doc, selector);
        for (const card of cards) {
          const anchor = safeQuery(card, linkSelector) as HTMLAnchorElement | null;
          const href = anchor?.getAttribute('href') ?? '';
          if (!href) continue;
          if (extractJobId(absolutize(href, doc.baseURI), config.jobId) === platformJobId) return card as HTMLElement;
          if (href.includes(platformJobId)) return card as HTMLElement;
        }
      }
      return null;
    },
  };
}
