/** Work GET 共享领域类型。所有模块（内容脚本 / 后台 / 侧边栏）共用。 */

export type Platform = 'boss' | 'liepin' | 'zhaopin' | 'yupao';

export const PLATFORM_META: Record<Platform, { label: string; short: string; color: string }> = {
  boss: { label: 'BOSS直聘', short: 'BOSS', color: '#00A6A7' },
  liepin: { label: '猎聘', short: '猎聘', color: '#FF6B00' },
  zhaopin: { label: '智联招聘', short: '智联', color: '#2F6BFF' },
  yupao: { label: '鱼泡网', short: '鱼泡', color: '#FFC300' },
};

export const PLATFORMS = Object.keys(PLATFORM_META) as Platform[];

export type SalaryUnit = 'month' | 'day' | 'year';

export interface Salary {
  min?: number;
  max?: number;
  unit: SalaryUnit;
  /** 14 薪 → 14 */
  months?: number;
  raw: string;
}

/** 适配器抽取出的原始数据，字段尽量宽松，归一化交给 normalize()。 */
export interface RawJob {
  platform: Platform;
  platformJobId: string;
  url: string;
  title: string;
  company?: string;
  city?: string;
  district?: string;
  salaryRaw?: string;
  experienceRaw?: string;
  educationRaw?: string;
  tags?: string[];
  description?: string;
  hrName?: string;
  hrActiveRaw?: string;
  extra?: Record<string, string>;
  capturedAt?: number;
}

export type JobStatus = 'new' | 'starred' | 'ignored' | 'applied' | 'closed';

export interface Job {
  /** `${platform}:${platformJobId}` */
  id: string;
  platform: Platform;
  platformJobId: string;
  url: string;
  title: string;
  titleNorm: string;
  company: string;
  companyNorm: string;
  city: string;
  district?: string;
  salary?: Salary;
  experienceMin?: number;
  experienceMax?: number;
  education?: string;
  tags: string[];
  description?: string;
  hrName?: string;
  hrActiveAt?: number;
  extra: Record<string, string>;
  /** 同平台内判重 */
  dedupeKey: string;
  /** 跨平台折叠成"岗位族" */
  familyKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  status: JobStatus;
  /** 规则分（0-100），LLM 分另存 matches */
  ruleScore?: number;
  note?: string;
  /** 最后一次推送到 DSH 的时间 */
  dshPushedAt?: number;
}

export type ApplicationState = 'sent' | 'read' | 'replied' | 'interview' | 'rejected';

export const APPLICATION_STATE_LABEL: Record<ApplicationState, string> = {
  sent: '已投递',
  read: '已读',
  replied: '已回复',
  interview: '约面试',
  rejected: '不合适',
};

export type ApplyChannel = 'greet' | 'resume' | 'both' | 'manual';

export interface Application {
  id: string;
  jobId: string;
  platform: Platform;
  jobTitle: string;
  company: string;
  at: number;
  channel: ApplyChannel;
  message?: string;
  state: ApplicationState;
  updatedAt: number;
  note?: string;
  /** 下一次跟进提醒时间 */
  followUpAt?: number;
}

export interface Resume {
  id: string;
  name: string;
  rawText: string;
  skills: string[];
  years: number;
  cities: string[];
  expectedSalary?: Salary;
  education?: string;
  fileName?: string;
  createdAt: number;
  updatedAt: number;
  version: string;
}

export interface MatchRecord {
  /** `${resumeId}::${jobId}` */
  id: string;
  resumeId: string;
  jobId: string;
  score: number;
  reasons: string[];
  gaps: string[];
  model: string;
  hash: string;
  at: number;
}

export type JobDirection = 'white-collar' | 'blue-collar' | 'both';

export interface Preferences {
  cities: string[];
  keywords: string[];
  /** 求职方向：white-collar 时蓝领平台（鱼泡）在规则分里降权 */
  direction: JobDirection;
  /** 最小月薪（元），用于硬过滤 */
  salaryMin?: number;
  experienceMax?: number;
  education?: string;
  /** 屏蔽公司/关键词 */
  blockedCompanies: string[];
  blockedKeywords: string[];
  /** 每个平台每日主动沟通上限 */
  dailyLimits: Record<Platform, number>;
  /** 打开发送外，是否由插件自动点"发送" */
  autoSend: boolean;
  /** 两条投递之间的随机间隔（毫秒） */
  applyIntervalMs: [number, number];
  followUpDays: number;
}

export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 脱敏后发送 */
  redact: boolean;
}

/** DSH 侧桥接（dsh-workget-bridge 插件，见 docs/dsh-bridge.md） */
export interface DshBridgeSettings {
  enabled: boolean;
  /** 桩服务地址，插件默认 http://127.0.0.1:3610 */
  url: string;
  /** 与 DSH 侧 .dsh-bridge/token.txt 一致 */
  token: string;
  /** 单次最多推送条数（服务端也有同样的上限） */
  maxJobs: number;
}

export interface Settings {
  prefs: Preferences;
  llm: LlmSettings;
  dshBridge: DshBridgeSettings;
  activeResumeId?: string;
}

export const DEFAULT_PREFS: Preferences = {
  cities: [],
  keywords: [],
  direction: 'white-collar',
  salaryMin: undefined,
  experienceMax: undefined,
  education: undefined,
  blockedCompanies: [],
  blockedKeywords: ['外包', '派遣', '猎头'],
  dailyLimits: { boss: 20, liepin: 15, zhaopin: 10, yupao: 20 },
  autoSend: false,
  applyIntervalMs: [10000, 30000],
  followUpDays: 5,
};

export const DEFAULT_LLM: LlmSettings = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  redact: true,
};

export const DEFAULT_DSH_BRIDGE: DshBridgeSettings = {
  enabled: true,
  url: 'http://127.0.0.1:3610',
  token: '',
  maxJobs: 20,
};

export const DEFAULT_SETTINGS: Settings = {
  prefs: DEFAULT_PREFS,
  llm: DEFAULT_LLM,
  dshBridge: DEFAULT_DSH_BRIDGE,
};

/** 内容脚本 → 后台 */
export type CaptureMessage = { type: 'WORKGET_CAPTURE'; jobs: RawJob[] };
/** 后台 → 内容脚本 */
export type ApplyMessage = {
  type: 'WORKGET_APPLY';
  platformJobId: string;
  message: string;
  autoSend: boolean;
};
export type PingMessage = { type: 'WORKGET_PING' };

export type RuntimeMessage = CaptureMessage | ApplyMessage | PingMessage;

export interface ApplyResult {
  ok: boolean;
  /** filled=已填话术待人工点发送；sent=已发送；failed=失败；blocked=风控 */
  stage: 'filled' | 'sent' | 'failed' | 'blocked';
  reason?: string;
}

export interface RiskSignal {
  kind: 'captcha' | 'frequent' | 'login' | 'unknown';
  evidence: string;
  at: number;
}
