import { beforeEach, describe, expect, it } from 'vitest';
import { createAdapter, extractJobId, type PlatformConfig } from '../src/adapters/base';

const CONFIG: PlatformConfig = {
  id: 'boss',
  label: 'BOSS直聘',
  hosts: ['zhipin.com'],
  listUrlPattern: '/web/geek/job',
  detailUrlPattern: '/job_detail/([0-9A-Za-z~_]+)\\.html',
  listItem: ['.job-card'],
  fields: {
    title: '.job-name',
    company: '.company-name',
    city: '.job-area',
    salary: '.salary',
    tags: { selector: '.tag-item', attr: 'data-name' },
    link: { selector: 'a.job-link', attr: 'href' },
  },
  link: { selector: 'a.job-link', attr: 'href' },
  jobId: { from: 'href', pattern: '/job_detail/([0-9A-Za-z~_]+)\\.html' },
  apply: {
    button: ['.btn-chat'],
    input: ['.chat-input'],
    send: ['.btn-send'],
  },
};

const adapter = createAdapter(CONFIG);

const HTML = `
  <ul class="job-list">
    <li class="job-card">
      <a class="job-link" href="/job_detail/abc123.html">岗位详情</a>
      <span class="job-name">前端开发工程师</span>
      <span class="company-name">某某科技有限公司</span>
      <span class="job-area">杭州·西湖区</span>
      <span class="salary">15-25K·14薪</span>
      <span class="tag-item" data-name="React">React</span>
      <span class="tag-item" data-name="TypeScript">TS</span>
    </li>
    <li class="job-card">
      <a class="job-link" href="/job_detail/def456.html">岗位详情</a>
      <span class="job-name">后端开发工程师</span>
      <span class="company-name">另一家公司</span>
      <span class="job-area">上海</span>
      <span class="salary">20-30K</span>
    </li>
    <li class="job-card">
      <a class="job-link" href="/job_detail/abc123.html">重复卡片</a>
      <span class="job-name">前端开发工程师</span>
    </li>
    <li class="job-card">
      <a class="job-link" href="/other-page.html">无 ID 的卡片</a>
      <span class="job-name">无 ID 的岗位</span>
    </li>
  </ul>
`;

beforeEach(() => {
  document.body.innerHTML = HTML;
});

describe('extractJobId', () => {
  it('按正则抠出岗位 ID', () => {
    expect(extractJobId('/job_detail/abc123.html', CONFIG.jobId)).toBe('abc123');
    expect(extractJobId('https://www.zhipin.com/job_detail/xyz~_1.html', CONFIG.jobId)).toBe('xyz~_1');
  });

  it('不匹配时返回 undefined', () => {
    expect(extractJobId('/other-page.html', CONFIG.jobId)).toBeUndefined();
  });

  it('非法正则不会抛错', () => {
    expect(extractJobId('anything', { from: 'href', pattern: '([unclosed' })).toBeUndefined();
  });
});

describe('平台与页面识别', () => {
  it('识别所属平台域名', () => {
    expect(adapter.matches('https://www.zhipin.com/web/geek/job?query=react')).toBe(true);
    expect(adapter.matches('https://www.liepin.com/zhaopin')).toBe(false);
    expect(adapter.matches('not-a-url')).toBe(false);
  });

  it('识别列表页与详情页', () => {
    expect(adapter.isListPage('https://www.zhipin.com/web/geek/job?query=react')).toBe(true);
    expect(adapter.isDetailPage('https://www.zhipin.com/job_detail/abc123.html')).toBe(true);
    expect(adapter.isDetailPage('https://www.zhipin.com/web/geek/job')).toBe(false);
  });
});

describe('extractList', () => {
  it('抽取所有带标题的卡片（重复项折叠）', () => {
    const jobs = adapter.extractList(document);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      platform: 'boss',
      platformJobId: 'abc123',
      title: '前端开发工程师',
      company: '某某科技有限公司',
    });
  });

  it('链接被补成绝对地址', () => {
    const jobs = adapter.extractList(document);
    expect(jobs[0]!.url).toContain('/job_detail/abc123.html');
    expect(jobs[0]!.url.startsWith('http')).toBe(true);
  });

  it('读取属性型字段（标签）', () => {
    const jobs = adapter.extractList(document);
    expect(jobs[0]!.tags).toEqual(['React', 'TypeScript']);
  });

  it('同一 ID 的重复卡片只保留一条', () => {
    const jobs = adapter.extractList(document);
    expect(new Set(jobs.map((j) => j.platformJobId)).size).toBe(jobs.length);
  });

  it('无 ID 的卡片用标题+公司兜底生成稳定 ID', () => {
    const ids = adapter.extractList(document).map((j) => j.platformJobId);
    expect(ids.some((id) => id.startsWith('h'))).toBe(true);
  });

  it('空页面返回空数组', () => {
    document.body.innerHTML = '<div></div>';
    expect(adapter.extractList(document)).toEqual([]);
  });

  it('limit 生效', () => {
    expect(adapter.extractList(document, { limit: 1 })).toHaveLength(1);
  });
});

describe('findCard', () => {
  it('按岗位 ID 找到对应卡片', () => {
    const card = adapter.findCard(document, 'def456');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.job-name')?.textContent).toBe('后端开发工程师');
  });

  it('找不到返回 null', () => {
    expect(adapter.findCard(document, 'not-exist')).toBeNull();
  });
});

describe('detectLoginState / detectRiskSignal', () => {
  it('出现"请先登录"判定为未登录', () => {
    document.body.innerHTML = '<div>请先登录后查看</div>';
    expect(adapter.detectLoginState(document)).toBe('guest');
  });

  it('有用户入口判定为已登录', () => {
    document.body.innerHTML = '<div class="user-info">张三</div>';
    expect(adapter.detectLoginState(document)).toBe('logged-in');
  });

  it('没有注入风控检测时不报错', () => {
    expect(adapter.detectRiskSignal(document)).toBeNull();
  });

  it('注入风控检测后可用', () => {
    const guarded = createAdapter(CONFIG, {
      detectRisk: (text) => (text.includes('验证') ? { kind: 'captcha', evidence: '验证', at: 1 } : null),
    });
    document.body.innerHTML = '<div>请完成安全验证</div>';
    expect(guarded.detectRiskSignal(document)?.kind).toBe('captcha');
  });
});

describe('容错', () => {
  it('非法选择器不会抛异常', () => {
    const broken = createAdapter({ ...CONFIG, listItem: ['[[bad'], fields: { title: '[[bad' } });
    expect(broken.extractList(document)).toEqual([]);
  });
});

describe('真实站点结构（BUG 回归）', () => {
  it('岗位 ID 里的连字符能正确抠出', () => {
    const spec = { from: 'href' as const, pattern: '/job_detail/([0-9A-Za-z~_-]+)\\.html' };
    expect(extractJobId('https://www.zhipin.com/job_detail/39906bd550b85e9b0nJz2d-5FVFQ.html', spec)).toBe(
      '39906bd550b85e9b0nJz2d-5FVFQ',
    );
  });

  it('嵌套的同名卡片容器只解析一次', () => {
    document.body.innerHTML = `
      <ul>
        <li class="job-card-box">
          <div class="job-card-body">
            <div class="job-card-left">
              <a class="job-link" href="/job_detail/a-1.html"><span class="job-name">岗位A</span></a>
            </div>
          </div>
        </li>
      </ul>`;
    const nested = createAdapter({
      ...CONFIG,
      listItem: ['[class*="job-card"]'],
      jobId: { from: 'href', pattern: '/job_detail/([0-9A-Za-z~_-]+)\\.html' },
    });
    const jobs = nested.extractList(document);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.platformJobId).toBe('a-1');
    expect(jobs[0]!.title).toBe('岗位A');
  });

  it('同一链接的兜底 ID 与位置无关', () => {
    document.body.innerHTML = `
      <ul>
        <li class="job-card"><a class="job-link" href="/other-1.html"><span class="job-name">甲</span></a></li>
        <li class="job-card"><a class="job-link" href="/other-2.html"><span class="job-name">乙</span></a></li>
      </ul>`;
    const first = adapter.extractList(document)[0]!.platformJobId;
    document.body.innerHTML = `
      <ul>
        <li class="job-card"><a class="job-link" href="/other-3.html"><span class="job-name">丙</span></a></li>
        <li class="job-card"><a class="job-link" href="/other-1.html"><span class="job-name">甲</span></a></li>
      </ul>`;
    const second = adapter.extractList(document)[1]!.platformJobId;
    expect(first).toBe(second);
  });
});

