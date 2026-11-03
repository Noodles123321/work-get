import { parseSalary } from '../shared/normalize';
import type { Resume } from '../shared/types';

/** 从 pdf / docx / txt 里抽纯文本。全部在本地完成，不上传。 */
export async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractPdf(file);
  if (name.endsWith('.docx')) return extractDocx(file);
  if (name.endsWith('.doc')) {
    throw new Error('旧版 .doc 无法解析，请在 Word 里另存为 .docx 或 .pdf 后重试');
  }
  return (await file.text()).trim();
}

async function extractPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const chunks: string[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    chunks.push(line);
  }
  await task.destroy();
  return chunks.join('\n').trim();
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value.replace(/\n{3,}/g, '\n\n').trim();
}

/** 常见技能词表：命中即认为会。宁缺毋滥，避免把"团队协作"当技能。 */
const SKILL_DICT = [
  'JavaScript', 'TypeScript', 'React', 'Vue', 'Angular', 'Node.js', 'Next.js', 'Nuxt',
  'HTML', 'CSS', 'Sass', 'Tailwind', 'Webpack', 'Vite', 'Rollup', 'Babel', 'ESLint',
  'Java', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'Kotlin', 'Scala', 'Go', 'Golang',
  'Python', 'Django', 'Flask', 'FastAPI', 'Pandas', 'NumPy', 'PyTorch', 'TensorFlow',
  'C', 'C++', 'C#', '.NET', 'Rust', 'PHP', 'Laravel', 'Ruby', 'Rails', 'Swift', 'Objective-C',
  'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'ClickHouse', 'Oracle', 'SQL Server',
  'Kafka', 'RabbitMQ', 'RocketMQ', 'Nginx', 'Docker', 'Kubernetes', 'K8s', 'Jenkins', 'GitLab CI',
  'Linux', 'Shell', 'Bash', 'Git', 'SVN', 'Prometheus', 'Grafana', 'SkyWalking',
  'Hadoop', 'Spark', 'Flink', 'Hive', 'HBase', 'Airflow', 'ETL', '数据仓库', '数据挖掘',
  '机器学习', '深度学习', '推荐系统', '自然语言处理', 'NLP', '计算机视觉', 'CV', '大模型', 'LLM',
  '微服务', '高并发', '分布式', '性能优化', '架构设计', '单元测试', '自动化测试', 'Selenium',
  '产品设计', '需求分析', 'Axure', 'Figma', 'Sketch', 'Photoshop', 'Illustrator', 'UI设计', 'UX',
  '项目管理', 'Scrum', '敏捷开发', 'PMP', '数据分析', 'SQL', 'Excel', 'Power BI', 'Tableau',
  'SEO', 'SEM', '信息流', '投放', '用户增长', '活动运营', '内容运营', '私域', '社群运营',
  '销售', '客户开发', '商务谈判', '渠道管理', '供应链', '采购', '物流', '仓储', '生产管理',
  '质量管控', 'QC', 'QA', 'ISO9001', '5S', '精益生产', 'PLC', 'CAD', 'SolidWorks', '机械设计',
  '电气设计', '单片机', 'STM32', '嵌入式', 'FPGA', 'PCB', '电焊', '氩弧焊', '二保焊', '电工',
  '钳工', '数控', 'CNC', '铣床', '车床', '装配', '叉车', '货运', '驾驶', 'A2驾照', 'B2驾照',
  '保安', '保洁', '家政', '厨师', '面点', '服务员', '收银', '理货', '配送', '外卖',
  '会计', '财务', '审计', '税务', '出纳', '成本核算', '人力资源管理', '招聘', '薪酬绩效',
  '法务', '合同审核', '英语', 'CET-6', '雅思', '托福', '日语', '韩语',
];

const CITY_DICT = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '重庆', '武汉', '西安',
  '长沙', '郑州', '天津', '青岛', '济南', '合肥', '福州', '厦门', '南昌', '昆明', '贵阳',
  '南宁', '海口', '太原', '石家庄', '沈阳', '大连', '长春', '哈尔滨', '兰州', '银川',
  '西宁', '乌鲁木齐', '呼和浩特', '佛山', '东莞', '珠海', '中山', '惠州', '宁波', '温州',
  '无锡', '常州', '南通', '徐州', '嘉兴', '绍兴', '金华', '泉州', '烟台', '潍坊',
];

export interface ParsedResumeFields {
  name?: string;
  years: number;
  skills: string[];
  cities: string[];
  expectedSalary?: number;
  education?: string;
}

/** 从简历纯文本里抽结构化字段。全部是启发式，抽不准的部分交给用户手改。 */
export function parseResumeText(text: string): ParsedResumeFields {
  const flat = text.replace(/\r/g, '');
  const lower = flat.toLowerCase();

  const nameMatch = flat.match(/(?:姓\s*名|Name)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z .]{1,30})/);
  const name = nameMatch?.[1]?.trim() ?? firstLineName(flat);

  const yearsMatch =
    flat.match(/(\d{1,2})\s*年(?:以上)?(?:工作|开发|从业|相关)?经验/) ??
    flat.match(/(?:工作|从业)(\d{1,2})\s*年/);
  const years = yearsMatch?.[1] ? Number(yearsMatch[1]) : 0;

  const skills = SKILL_DICT.filter((skill) => {
    if (/^[A-Za-z.#+ ]+$/.test(skill)) {
      const re = new RegExp(`(^|[^A-Za-z])${escapeRe(skill)}([^A-Za-z]|$)`, 'i');
      return re.test(flat);
    }
    return lower.includes(skill.toLowerCase());
  }).slice(0, 24);

  const cities = CITY_DICT.filter((city) => flat.includes(city)).slice(0, 6);

  const salaryPart = flat.match(
    /(\d{1,3}(?:\.\d+)?\s*[-~到]\s*\d{1,3}(?:\.\d+)?\s*[kK万]|面议|\d{1,3}\s*[kK]\s*[-~]\s*\d{1,3}\s*[kK])/,
  );
  const salary = salaryPart ? parseSalary(salaryPart[1]) : undefined;

  const eduMatch = flat.match(/(博士|硕士|本科|大专|专科|高中|中专|中技|初中)/);
  const education = eduMatch?.[1];

  return { name, years, skills, cities, expectedSalary: salary?.min, education };
}

function firstLineName(text: string): string | undefined {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!first || first.length > 24) return undefined;
  const m = first.match(/^([\u4e00-\u9fa5]{2,4})(?:\s|$|·|—|-)/);
  return m?.[1];
}

function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 组装成可入库的 Resume。 */
export function buildResume(
  fields: ParsedResumeFields,
  rawText: string,
  fileName: string,
  base?: Resume,
): Resume {
  const now = Date.now();
  return {
    id: base?.id ?? `r-${now.toString(36)}`,
    name: fields.name ?? base?.name ?? '我的简历',
    rawText,
    skills: fields.skills,
    years: fields.years,
    cities: fields.cities,
    expectedSalary: fields.expectedSalary
      ? { min: fields.expectedSalary, unit: 'month', raw: `${fields.expectedSalary}元/月` }
      : base?.expectedSalary,
    education: fields.education ?? base?.education,
    fileName,
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    version: base?.version ?? 'v1',
  };
}
