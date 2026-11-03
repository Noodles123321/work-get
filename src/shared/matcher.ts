import { DEFAULT_PREFS, type Job, type Preferences, type Resume } from './types';

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

const DAY = 86_400_000;

function containsAny(haystack: string, needles: string[]): string | undefined {
  const hay = haystack.toLowerCase();
  return needles.find((n) => n && hay.includes(n.toLowerCase()));
}

/** 硬过滤：命中即直接排除，不进入打分。 */
export function hardFilter(job: Job, prefs: Preferences, resume?: Resume): FilterResult {
  const companyHit = containsAny(job.company, prefs.blockedCompanies);
  if (companyHit) return { pass: false, reason: `屏蔽公司：${companyHit}` };

  const text = `${job.title} ${job.tags.join(' ')} ${job.company}`;
  const keywordHit = containsAny(text, prefs.blockedKeywords);
  if (keywordHit) return { pass: false, reason: `屏蔽词：${keywordHit}` };

  if (prefs.cities.length > 0 && job.city !== '未知' && !prefs.cities.some((c) => job.city.includes(c))) {
    return { pass: false, reason: `城市不符：${job.city}` };
  }

  if (prefs.salaryMin && job.salary && job.salary.unit === 'month' && (job.salary.min ?? 0) > 0) {
    if ((job.salary.max ?? job.salary.min ?? 0) < prefs.salaryMin) {
      return { pass: false, reason: `薪资低于 ${prefs.salaryMin} 元/月` };
    }
  }

  if (prefs.experienceMax !== undefined && job.experienceMin !== undefined && job.experienceMin > prefs.experienceMax) {
    return { pass: false, reason: `经验要求 ${job.experienceMin} 年+ 超过你的上限` };
  }

  if (resume && prefs.experienceMax !== undefined && resume.years > prefs.experienceMax + 2) {
    // 不直接过滤，交给打分
  }

  return { pass: true };
}

export interface RuleScore {
  score: number;
  reasons: string[];
  gaps: string[];
  matchedSkills: string[];
  missingSkills: string[];
}

/** 规则分（0-100）。LLM 只在此基础上做微调，保证没有 API 也能用。 */
export function ruleScore(job: Job, resume: Resume, prefs: Preferences = DEFAULT_PREFS): RuleScore {
  const reasons: string[] = [];
  const gaps: string[] = [];
  let score = 45;

  const haystack = `${job.title} ${job.tags.join(' ')} ${job.description ?? ''}`.toLowerCase();
  const skills = resume.skills.filter(Boolean);
  const matchedSkills = skills.filter((s) => haystack.includes(s.toLowerCase()));
  const missingSkills: string[] = [];
  const skillHitRate = skills.length > 0 ? matchedSkills.length / skills.length : 0;

  if (matchedSkills.length > 0) {
    const bonus = Math.min(32, Math.round(skillHitRate * 40) + matchedSkills.length * 2);
    score += bonus;
    reasons.push(`技能命中 ${matchedSkills.slice(0, 6).join('、')}`);
  } else if (skills.length > 0) {
    score -= 8;
    gaps.push('岗位描述里没有命中你的任一技能关键词');
  }

  // 岗位要求的技能，简历里没有
  for (const skill of skills) {
    const requiredInJob = job.title.toLowerCase().includes(skill.toLowerCase());
    if (requiredInJob && !haystack.includes(skill.toLowerCase())) missingSkills.push(skill);
  }

  if (job.city !== '未知') {
    const cityHit = prefs.cities.length === 0 || prefs.cities.includes(job.city);
    if (cityHit) {
      score += 5;
      reasons.push(`城市匹配（${job.city}）`);
    } else {
      score -= 12;
      gaps.push(`城市不在意向范围（${job.city}）`);
    }
  }

  if (job.salary?.min) {
    const monthly = job.salary.unit === 'day' ? job.salary.min * 22 : job.salary.unit === 'year' ? job.salary.min / 12 : job.salary.min;
    const target = resume.expectedSalary?.min ?? prefs.salaryMin;
    if (target) {
      if (monthly >= target) {
        score += 8;
        reasons.push('薪资达到期望');
      } else if (monthly >= target * 0.85) {
        score -= 2;
        gaps.push('薪资略低于期望');
      } else {
        score -= 14;
        gaps.push('薪资明显低于期望');
      }
    }
  } else {
    gaps.push('薪资面议，需沟通确认');
  }

  if (job.experienceMin !== undefined) {
    if (job.experienceMin <= resume.years + 1 && (job.experienceMax === undefined || job.experienceMax >= resume.years - 1)) {
      score += 6;
      reasons.push('经验年限匹配');
    } else if (job.experienceMin > resume.years + 2) {
      score -= 10;
      gaps.push(`要求 ${job.experienceMin} 年以上经验`);
    }
  }

  if (job.hrActiveAt && Date.now() - job.hrActiveAt < 3 * DAY) {
    score += 7;
    reasons.push('招聘者近期活跃');
  }

  if (job.tags.length > 0) {
    const tagHit = job.tags.filter((t) => skills.some((s) => t.toLowerCase().includes(s.toLowerCase())));
    if (tagHit.length > 0) {
      score += Math.min(8, tagHit.length * 3);
      reasons.push(`标签命中：${tagHit.slice(0, 4).join('、')}`);
    }
  }

  // 求职方向：白领为主时鱼泡（蓝领工种占多数）降权，避免把体力岗推到列表顶部
  if (prefs.direction === 'white-collar' && job.platform === 'yupao') {
    score -= 8;
    gaps.push('鱼泡以蓝领岗位为主，与白领方向不符');
  } else if (prefs.direction === 'blue-collar' && job.platform !== 'yupao') {
    score -= 4;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: Array.from(new Set(reasons)).slice(0, 6),
    gaps: Array.from(new Set(gaps)).slice(0, 6),
    matchedSkills,
    missingSkills,
  };
}

/** 合并 LLM 分与规则分：LLM 权重更高，但保留规则分的可解释性。 */
export function blendScore(rule: number, llm?: number): number {
  if (llm === undefined) return rule;
  return Math.max(0, Math.min(100, Math.round(llm * 0.65 + rule * 0.35)));
}
