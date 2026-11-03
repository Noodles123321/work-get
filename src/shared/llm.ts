import type { Job, LlmSettings, Resume } from './types';
import { formatSalary } from './normalize';

/** FNV-1a 32bit，用于给"简历版本 + JD"做缓存键（不需要抗碰撞，只要稳定）。 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 出网前脱敏：手机号、邮箱、身份证、银行卡。 */
export function redact(text: string): string {
  return text
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]')
    .replace(/\b\d{17}[\dXx]\b/g, '[身份证]')
    .replace(/\b\d{16,19}\b/g, '[卡号]');
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LlmError';
  }
}

/** OpenAI 兼容 /chat/completions。用户自填 baseUrl + key，不经过任何中转。 */
export async function chat(settings: LlmSettings, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (!settings.enabled || !settings.apiKey) throw new LlmError('未配置模型 API Key');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.model, messages, temperature: 0.3 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`模型接口返回 ${res.status}：${body.slice(0, 200)}`, res.status);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new LlmError('模型返回为空');
    return content;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function stripFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1] ?? text;
  return body.trim();
}

export function parseJsonLoose<T>(text: string): T | null {
  const body = stripFence(text);
  try {
    return JSON.parse(body) as T;
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function jobDigest(job: Job, maxDesc = 1200): string {
  const desc = (job.description ?? '').slice(0, maxDesc);
  return [
    `岗位：${job.title}`,
    `公司：${job.company}`,
    `城市：${job.city}${job.district ? `·${job.district}` : ''}`,
    `薪资：${formatSalary(job.salary)}`,
    `经验：${job.experienceMin ?? '不限'}${job.experienceMax ? `-${job.experienceMax}` : ''}年`,
    `学历：${job.education ?? '不限'}`,
    `标签：${job.tags.join('、') || '无'}`,
    `描述：${desc || '无'}`,
  ].join('\n');
}

export function resumeDigest(resume: Resume, maxLen = 2500): string {
  return [
    `年限：${resume.years} 年`,
    `技能：${resume.skills.join('、') || '未识别'}`,
    `期望薪资：${formatSalary(resume.expectedSalary)}`,
    `期望城市：${resume.cities.join('、') || '不限'}`,
    `原文摘要：${resume.rawText.replace(/\s+/g, ' ').slice(0, maxLen)}`,
  ].join('\n');
}

export function buildMatchMessages(job: Job, resume: Resume, redactOn: boolean): ChatMessage[] {
  const jobText = jobDigest(job);
  const resumeText = resumeDigest(resume);
  return [
    {
      role: 'system',
      content:
        '你是资深猎头顾问。评估候选人与岗位的匹配度。只输出 JSON，不要任何解释或 Markdown：' +
        '{"score":0-100整数,"reasons":["3条以内命中理由"],"gaps":["3条以内缺失项"]}',
    },
    {
      role: 'user',
      content: `【岗位】\n${jobText}\n\n【候选人简历】\n${redactOn ? redact(resumeText) : resumeText}`,
    },
  ];
}

export interface LlmMatch {
  score: number;
  reasons: string[];
  gaps: string[];
}

export async function llmMatch(
  settings: LlmSettings,
  job: Job,
  resume: Resume,
  options?: ChatOptions,
): Promise<LlmMatch | null> {
  const raw = await chat(settings, buildMatchMessages(job, resume, settings.redact), options);
  const parsed = parseJsonLoose<{ score?: number; reasons?: string[]; gaps?: string[] }>(raw);
  if (!parsed || typeof parsed.score !== 'number') return null;
  return {
    score: Math.max(0, Math.min(100, Math.round(parsed.score))),
    reasons: (parsed.reasons ?? []).filter(Boolean).slice(0, 4),
    gaps: (parsed.gaps ?? []).filter(Boolean).slice(0, 4),
  };
}

/** 无 LLM 也能用的模板话术，保证产品在离线状态下完整可用。 */
export function templateGreeting(job: Job, resume: Resume): string {
  const skill = resume.skills[0] ?? '相关技术';
  const second = resume.skills[1];
  const skillText = second ? `${skill}、${second}` : skill;
  const yearText = resume.years > 0 ? `${resume.years}年` : '';
  const parts = [
    `您好，我有${yearText}${skillText}相关经验`,
    `${job.title}这个岗位我很感兴趣`,
    job.tags[0] ? `尤其是${job.tags[0]}方向` : '',
    '方便的话想聊聊具体职责，谢谢！',
  ].filter(Boolean);
  return parts.join('，').replace(/，，/g, '，').slice(0, 110);
}

export function buildGreetingMessages(job: Job, resume: Resume, redactOn: boolean): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你在帮求职者写 BOSS直聘/猎聘 的打招呼开场白。要求：中文，80-110 字，自然口语，' +
        '包含 1 个与岗位高度相关的具体经验亮点和 1 个提问；不要用"贵司""您好我是"这类套话开头；' +
        '不要编造简历里没有的经历；只输出话术正文，不要引号。',
    },
    {
      role: 'user',
      content: `【岗位】${job.title}｜${job.company}｜${job.city}｜${job.tags.join('、')}\n${(job.description ?? '').slice(0, 600)}\n\n【简历】\n${
        redactOn ? redact(resumeDigest(resume, 1500)) : resumeDigest(resume, 1500)
      }`,
    },
  ];
}

export async function llmGreeting(
  settings: LlmSettings,
  job: Job,
  resume: Resume,
  options?: ChatOptions,
): Promise<string | null> {
  const raw = await chat(settings, buildGreetingMessages(job, resume, settings.redact), options);
  const text = raw.replace(/^["“']|["”']$/g, '').trim();
  if (!text) return null;
  return text.slice(0, 200);
}
