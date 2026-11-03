import type { Application, Job } from './types';
import { PLATFORM_META } from './types';
import { formatSalary } from './normalize';

export const JOB_HEADER = [
  '平台',
  '岗位',
  '公司',
  '城市',
  '区域',
  '薪资',
  '经验(年)',
  '学历',
  '标签',
  '招聘者',
  '首次发现',
  '最近出现',
  '状态',
  '链接',
] as const;

export const APPLICATION_HEADER = ['投递时间', '平台', '岗位', '公司', '渠道', '状态', '跟进时间', '备注'] as const;

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type Cell = string | number;

export function jobsToRows(jobs: Job[]): Cell[][] {
  return jobs.map((job) => [
    PLATFORM_META[job.platform].label,
    job.title,
    job.company,
    job.city,
    job.district ?? '',
    formatSalary(job.salary),
    job.experienceMin ?? '',
    job.education ?? '',
    job.tags.join(' / '),
    job.hrName ?? '',
    fmtTime(job.firstSeenAt),
    fmtTime(job.lastSeenAt),
    job.status,
    job.url,
  ]);
}

export function applicationsToRows(apps: Application[]): Cell[][] {
  const stateLabel: Record<Application['state'], string> = {
    sent: '已投递',
    read: '已读',
    replied: '已回复',
    interview: '约面试',
    rejected: '不合适',
  };
  return apps.map((a) => [
    fmtTime(a.at),
    PLATFORM_META[a.platform].label,
    a.jobTitle,
    a.company,
    a.channel,
    stateLabel[a.state],
    fmtTime(a.followUpAt),
    a.note ?? '',
  ]);
}

function escapeCsv(cell: Cell): string {
  const text = String(cell ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Excel 打开中文 CSV 需要 UTF-8 BOM，否则乱码。 */
export function toCsv(header: readonly string[], rows: Cell[][]): string {
  const lines = [header.map(escapeCsv).join(','), ...rows.map((r) => r.map(escapeCsv).join(','))];
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function toXlsx(header: readonly string[], rows: Cell[][], sheetName = 'Sheet1'): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx');
  const worksheet = XLSX.utils.aoa_to_sheet([header as string[], ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestampName(prefix: string, ext: string, now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}
