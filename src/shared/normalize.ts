import type { Job, RawJob, Salary } from './types';

const FULLWIDTH = /[\uFF01-\uFF5E]/g;
const CJK_SPACE = /[\u3000\s]+/g;

export function cleanText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(FULLWIDTH, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u00a0/g, ' ')
    .replace(CJK_SPACE, ' ')
    .trim();
}

const UNIT_SUFFIX: Record<string, number> = { k: 1_000, 千: 1_000, w: 10_000, '万': 10_000 };

/**
 * 解析招聘网站上的薪资文案。
 * 覆盖：`15-25K·14薪`、`1.5-2万`、`8千-1.2万`、`200-300元/天`、
 *      `6000-8000元/月`、`年薪30-50万`、`15000-20000`、`面议`。
 */
export function parseSalary(input: string | null | undefined): Salary | undefined {
  const raw = cleanText(input);
  if (!raw) return undefined;
  if (/面议|保密|薪资面谈|详见/.test(raw) && !/\d/.test(raw)) return undefined;

  const lower = raw.toLowerCase();
  let unit: Salary['unit'] = 'month';
  if (/(\/|每)\s*(天|日)|日结|按天/.test(lower)) unit = 'day';
  else if (/年薪|\/年|每年|万元\/年/.test(lower)) unit = 'year';
  else if (/(\/|每)\s*(月|月薪)/.test(lower)) unit = 'month';

  const monthsMatch = lower.match(/(\d{2})\s*薪/);
  const months = monthsMatch?.[1] ? Number(monthsMatch[1]) : undefined;

  // 收集 "数字 + 可选单位" 的 token，跳过 "14薪"/"13薪" 里的数字
  const withoutMonths = lower.replace(/\d{2}\s*薪/g, ' ');
  const tokens: Array<{ value: number; mult: number }> = [];
  const re = /(\d+(?:\.\d+)?)\s*(k|w|千|万)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutMonths)) !== null) {
    const numText = m[1];
    if (!numText) continue;
    const suffix = m[2] ?? '';
    const mult = suffix ? (UNIT_SUFFIX[suffix] ?? 1) : 1;
    const value = Number(numText);
    if (!Number.isFinite(value) || value <= 0) continue;
    tokens.push({ value, mult });
  }
  if (tokens.length === 0) return undefined;

  // 纯数字且无单位/无"万/千"：5 位以上视为元，4 位以下在"K"语境外可能是千元
  const hasWan = tokens.some((t) => t.mult === 10_000);
  const scale = (token: { value: number; mult: number }): number => {
    if (token.mult !== 1) return token.value * token.mult;
    if (token.value >= 1000) return token.value;
    if (hasWan && token.value < 1000) return token.value * 10_000;
    if (/[k千]/.test(lower)) return token.value * 1000;
    if (unit === 'year' && token.value < 100) return token.value * 10_000;
    if (token.value < 100) return token.value * 1000;
    return token.value;
  };

  const first = tokens[0]!;
  const second = tokens[1];
  const min = scale(first);
  const max = second ? scale(second) : undefined;
  const lo = Math.min(min, max ?? min);
  const hi = Math.max(min, max ?? min);

  if (lo <= 0) return undefined;
  return { min: Math.round(lo), max: Math.round(hi), unit, months, raw };
}

export function formatSalary(salary?: Salary): string {
  if (!salary) return '面议';
  const k = (v: number) => {
    if (salary.unit === 'day') return `${v}`;
    return v >= 10_000 ? `${+(v / 10_000).toFixed(1)}万` : `${+(v / 1000).toFixed(1)}K`;
  };
  const unitText = salary.unit === 'day' ? '/天' : salary.unit === 'year' ? '/年' : '/月';
  const range = salary.min === salary.max || salary.max === undefined ? k(salary.min ?? 0) : `${k(salary.min ?? 0)}-${k(salary.max)}`;
  const months = salary.months && salary.months !== 12 ? `·${salary.months}薪` : '';
  return `${range}${unitText}${months}`;
}

export function normalizeTitle(title: string): string {
  return cleanText(title)
    .toLowerCase()
    .replace(/[（(【\[][^）)】\]]{0,12}[）)】\]]/g, '')
    .replace(/[·•|,，、/\\\-_]+/g, ' ')
    .replace(/(急招|急聘|双休|五险一金|包吃住|高薪|诚聘|直招|长期|短期)/g, '')    .replace(/\s+/g, '')
    .trim();
}

const COMPANY_SUFFIX = /(有限公司|有限责任公司|股份有限公司|集团有限公司|分公司|公司|集团|工作室|研究院|事务所)$/g;

export function normalizeCompany(company: string): string {
  let out = cleanText(company).replace(/[（(][^）)]{0,20}[）)]/g, '');
  out = out.replace(/\s+/g, '');
  let prev = '';
  while (prev !== out) {
    prev = out;
    out = out.replace(COMPANY_SUFFIX, '');
  }
  return out.replace(/^(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|苏州|天津|重庆|长沙)/, '').toLowerCase();
}

export function splitCity(input: string | null | undefined): { city: string; district?: string } {
  const raw = cleanText(input);
  if (!raw) return { city: '未知' };
  const parts = raw.split(/[·\-—/|,，\s]+/).filter(Boolean);
  const city = (parts[0] ?? raw).replace(/(市|地区)$/, '');
  const district = parts[1]?.replace(/(区|县|市)$/, '');
  return district ? { city, district } : { city };
}

const EXPERIENCE_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => { min?: number; max?: number }]> = [
  [/经验不限|不限经验|无需经验/, () => ({})],
  [/应届|在校|实习/, () => ({ min: 0, max: 0 })],
  [/(\d+)\s*[-~到]\s*(\d+)\s*年/, (m) => ({ min: Number(m[1]), max: Number(m[2]) })],
  [/(\d+)\s*年以内/, (m) => ({ min: 0, max: Number(m[1]) })],
  [/(\d+)\s*年以上/, (m) => ({ min: Number(m[1]) })],
  [/(\d+)\s*年/, (m) => ({ min: Number(m[1]), max: Number(m[1]) })],
];

export function parseExperience(input: string | null | undefined): { min?: number; max?: number } {
  const raw = cleanText(input);
  if (!raw) return {};
  for (const [re, map] of EXPERIENCE_PATTERNS) {
    const m = raw.match(re);
    if (m) return map(m);
  }
  return {};
}

export function parseActiveAt(input: string | null | undefined, now = Date.now()): number | undefined {
  const raw = cleanText(input);
  if (!raw) return undefined;
  if (/刚刚|在线|今日活跃|当前活跃/.test(raw)) return now;
  const m = raw.match(/(\d+)\s*(分钟|小时|天|日)/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const star = m[2];
  const factor = star === '分钟' ? 60_000 : star === '小时' ? 3_600_000 : 86_400_000;
  return now - n * factor;
}

const EDUCATION_ORDER = ['不限', '初中', '中专', '高中', '大专', '本科', '硕士', '博士'];

export function parseEducation(input: string | null | undefined): string | undefined {
  const raw = cleanText(input);
  if (!raw) return undefined;
  for (const level of EDUCATION_ORDER) {
    if (raw.includes(level)) return level === '不限' ? '不限' : level;
  }
  if (/学历不限/.test(raw)) return '不限';
  return undefined;
}

export function cityBucket(city: string): string {
  return city.replace(/(市|地区)$/, '');
}

export function salaryBucket(salary?: Salary): string {
  if (!salary?.min) return 'none';
  const k = salary.unit === 'day' ? salary.min / 100 : salary.min / 1000;
  const step = salary.unit === 'day' ? 1 : 2;
  return String(Math.round(k / step) * step);
}

export function buildDedupeKey(parts: {
  city: string;
  companyNorm: string;
  titleNorm: string;
  salary?: Salary;
}): string {
  return [cityBucket(parts.city), parts.companyNorm, parts.titleNorm, salaryBucket(parts.salary)].join('|');
}

export function buildFamilyKey(parts: { city: string; companyNorm: string; titleNorm: string }): string {
  return [cityBucket(parts.city), parts.companyNorm, parts.titleNorm].join('|');
}

/** RawJob → Job。缺失字段一律兜底，保证下游永远拿到完整对象。 */
export function normalizeJob(raw: RawJob, now = Date.now()): Job {
  const title = cleanText(raw.title) || '未命名岗位';
  const company = cleanText(raw.company) || '未知公司';
  const citySource = [raw.city, raw.district].filter(Boolean).join('·') || '未知';
  const { city, district } = splitCity(citySource);
  const salary = parseSalary(raw.salaryRaw);
  const exp = parseExperience(raw.experienceRaw);
  const titleNorm = normalizeTitle(title);
  const companyNorm = normalizeCompany(company);
  const platformJobId = cleanText(String(raw.platformJobId));
  return {
    id: `${raw.platform}:${platformJobId}`,
    platform: raw.platform,
    platformJobId,
    url: raw.url,
    title,
    titleNorm,
    company,
    companyNorm,
    city,
    district: district ?? raw.district,
    salary,
    experienceMin: exp.min,
    experienceMax: exp.max,
    education: parseEducation(raw.educationRaw),
    tags: (raw.tags ?? []).map(cleanText).filter(Boolean).slice(0, 24),
    description: raw.description?.trim() || undefined,
    hrName: raw.hrName?.trim() || undefined,
    hrActiveAt: parseActiveAt(raw.hrActiveRaw, now),
    extra: raw.extra ?? {},
    dedupeKey: buildDedupeKey({ city, companyNorm, titleNorm, salary }),
    familyKey: buildFamilyKey({ city, companyNorm, titleNorm }),
    firstSeenAt: raw.capturedAt ?? now,
    lastSeenAt: now,
    status: 'new',
  };
}

/** 合并重复岗位时保留最早 firstSeenAt 与最新 lastSeenAt，并补齐缺失字段。 */
export function mergeJob(existing: Job, incoming: Job): Job {
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(incoming).filter(([, v]) => v !== undefined && v !== '')),
    firstSeenAt: Math.min(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
    id: existing.id,
    status: existing.status === 'new' ? incoming.status : existing.status,
    note: existing.note ?? incoming.note,
    ruleScore: existing.ruleScore ?? incoming.ruleScore,
    tags: Array.from(new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])).slice(0, 24),
    extra: { ...existing.extra, ...incoming.extra },
  } as Job;
}
