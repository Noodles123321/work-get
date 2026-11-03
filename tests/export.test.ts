import { describe, expect, it } from 'vitest';
import {
  APPLICATION_HEADER,
  JOB_HEADER,
  applicationsToRows,
  jobsToRows,
  timestampName,
  toCsv,
} from '../src/shared/export';
import { normalizeJob } from '../src/shared/normalize';
import type { Application, Job } from '../src/shared/types';

const NOW = new Date(2026, 10, 3, 9, 5, 0).getTime();

function job(overrides: Partial<Job> = {}): Job {
  return {
    ...normalizeJob(
      {
        platform: 'liepin',
        platformJobId: '9',
        url: 'https://www.liepin.com/job/9.shtml',
        title: '数据分析师',
        company: '某某数据有限公司',
        city: '上海·浦东',
        salaryRaw: '20-30K',
        tags: ['SQL', 'Python'],
        hrName: '李女士',
      },
      NOW,
    ),
    ...overrides,
  };
}

const APP: Application = {
  id: 'a1',
  jobId: 'liepin:9',
  platform: 'liepin',
  jobTitle: '数据分析师',
  company: '某某数据',
  at: NOW,
  channel: 'greet',
  state: 'replied',
  updatedAt: NOW,
  followUpAt: NOW + 86_400_000,
  note: '约了下周二',
};

describe('jobsToRows', () => {
  it('每行列数与表头一致', () => {
    const rows = jobsToRows([job()]);
    expect(rows[0]).toHaveLength(JOB_HEADER.length);
  });

  it('平台列用中文名', () => {
    expect(jobsToRows([job()])[0]![0]).toBe('猎聘');
  });

  it('缺失字段用空串占位', () => {
    const rows = jobsToRows([job({ district: undefined, education: undefined, hrName: undefined })]);
    expect(rows[0]![4]).toBe('');
    expect(rows[0]![7]).toBe('');
    expect(rows[0]![9]).toBe('');
  });
});

describe('applicationsToRows', () => {
  it('每行列数与表头一致', () => {
    expect(applicationsToRows([APP])[0]).toHaveLength(APPLICATION_HEADER.length);
  });

  it('状态映射成中文', () => {
    expect(applicationsToRows([APP])[0]![5]).toBe('已回复');
  });

  it('投递时间格式化到分钟', () => {
    expect(applicationsToRows([APP])[0]![0]).toBe('2026-11-03 09:05');
  });
});

describe('toCsv', () => {
  it('以 UTF-8 BOM 开头（Excel 中文不乱码）', () => {
    expect(toCsv(['a'], [['1']]).startsWith('\uFEFF')).toBe(true);
  });

  it('用 CRLF 换行', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('\uFEFFa,b\r\n1,2');
  });

  it('含逗号/引号/换行的字段被转义', () => {
    expect(toCsv(['x'], [['a,b']])).toContain('"a,b"');
    expect(toCsv(['x'], [['他说"你好"']])).toContain('"他说""你好"""');
    expect(toCsv(['x'], [['第一行\n第二行']])).toContain('"第一行\n第二行"');
  });

  it('普通值不加引号', () => {
    expect(toCsv(['x'], [['简单值']])).toBe('\uFEFFx\r\n简单值');
  });
});

describe('timestampName', () => {
  it('生成带时间戳的文件名', () => {
    expect(timestampName('workget-jobs', 'xlsx', NOW)).toBe('workget-jobs-20261103-0905.xlsx');
  });
});
