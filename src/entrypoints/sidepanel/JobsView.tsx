import { useState } from 'react';
import { deleteJob, getSettings, queryJobs, setJobStatus } from '../../db/repo';
import { JOB_HEADER, jobsToRows, toCsv, toXlsx, downloadBlob, timestampName } from '../../shared/export';
import { formatSalary } from '../../shared/normalize';
import { PLATFORM_META, PLATFORMS, type Job, type JobStatus, type Platform } from '../../shared/types';
import { draftGreeting, prepareApply, recordApplication } from '../../ui/apply-flow';
import { buildPushPayload, describePushError, pushJobs } from '../../ui/dsh-bridge';
import { useLive } from './useLive';

type SortKey = 'lastSeenAt' | 'ruleScore';

const STATUS_LABEL: Record<JobStatus, string> = {
  new: '新岗位',
  starred: '已收藏',
  ignored: '已忽略',
  applied: '已投递',
  closed: '已关闭',
};

export default function JobsView() {
  const [keyword, setKeyword] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [statuses, setStatuses] = useState<JobStatus[]>(['new', 'starred', 'applied']);
  const [sort, setSort] = useState<SortKey>('lastSeenAt');
  const [minScore, setMinScore] = useState(0);

  const jobs = useLive<Job[]>(
    () => queryJobs({ keyword, platforms, statuses, orderBy: sort, minScore: minScore || undefined, limit: 300 }),
    [keyword, platforms.join(), statuses.join(), sort, minScore],
    [],
  );

  const [target, setTarget] = useState<Job | null>(null);
  const [greeting, setGreeting] = useState('');
  const [greetingSource, setGreetingSource] = useState<'llm' | 'template'>('template');
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [sentPending, setSentPending] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [confirmPush, setConfirmPush] = useState<{ count: number; max: number; skipped: number } | null>(null);

  const togglePlatform = (p: Platform) =>
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  const toggleStatus = (s: JobStatus) =>
    setStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const openApply = async (job: Job) => {
    setTarget(job);
    setSentPending(false);
    setBanner(null);
    setGreeting('');
    setDrafting(true);
    try {
      const draft = await draftGreeting(job);
      setGreeting(draft.text);
      setGreetingSource(draft.source);
    } catch {
      setGreeting('');
    } finally {
      setDrafting(false);
    }
  };

  const runApply = async (autoSend: boolean) => {
    if (!target) return;
    setBusy(true);
    setBanner(null);
    try {
      const outcome = await prepareApply(target, greeting, autoSend);
      if (outcome.stage === 'sent') {
        await recordApplication(target, greeting);
        setBanner({ tone: 'ok', text: outcome.message });
        setTarget(null);
      } else if (outcome.stage === 'filled') {
        setSentPending(true);
        setBanner({ tone: 'ok', text: outcome.message });
      } else {
        setBanner({ tone: outcome.stage === 'blocked' ? 'warn' : 'err', text: outcome.message });
      }
    } catch (error) {
      setBanner({ tone: 'err', text: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const confirmSent = async () => {
    if (!target) return;
    await recordApplication(target, greeting);
    setSentPending(false);
    setTarget(null);
    setBanner({ tone: 'ok', text: '已记录一笔投递，5 天后会提醒你跟进' });
  };

  const exportList = async (kind: 'csv' | 'xlsx') => {
    const rows = jobsToRows(jobs);
    if (kind === 'csv') {
      downloadBlob(timestampName('workget-jobs', 'csv'), new Blob([toCsv(JOB_HEADER, rows)], { type: 'text/csv' }));
    } else {
      const buffer = await toXlsx(JOB_HEADER, rows, '岗位');
      downloadBlob(
        timestampName('workget-jobs', 'xlsx'),
        new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      );
    }
  };

  /** 只推还没投递的岗位，按当前列表顺序取前 maxJobs 条 */
  const pushCandidates = () => jobs.filter((job) => job.status !== 'applied');

  const openPushConfirm = async () => {
    const settings = await getSettings();
    const cfg = settings.dshBridge;
    if (!cfg.enabled) {
      setBanner({ tone: 'warn', text: describePushError('disabled') });
      return;
    }
    const candidates = pushCandidates();
    const { jobs: payload } = buildPushPayload(candidates, cfg.maxJobs);
    if (payload.length === 0) {
      setBanner({ tone: 'warn', text: '当前列表没有可推送的岗位（已投递的不会重复推送）' });
      return;
    }
    setConfirmPush({
      count: payload.length,
      max: cfg.maxJobs,
      skipped: Math.max(0, candidates.length - payload.length),
    });
  };

  const runPush = async () => {
    setConfirmPush(null);
    setPushing(true);
    setBanner(null);
    try {
      const settings = await getSettings();
      const attempt = await pushJobs(pushCandidates(), settings.dshBridge);
      const { response } = attempt;
      if (response.ok) {
        const tail = attempt.skipped > 0 ? `（另有 ${attempt.skipped} 条超出单次上限，未推送）` : '';
        setBanner({
          tone: 'ok',
          text: response.duplicate
            ? `这批岗位刚推过，已复用上次的 DSH 会话：${response.sessionId}`
            : `已推送 ${attempt.count} 条到 DSH，切到 DSH 窗口查看新会话：${response.sessionId}${tail}`,
        });
      } else {
        setBanner({ tone: 'err', text: describePushError(response.error, response.message) });
      }
    } catch (error) {
      setBanner({ tone: 'err', text: String(error) });
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="view">
      {banner && <div className={`banner ${banner.tone}`}>{banner.text}</div>}

      <div className="toolbar">
        <input
          className="input"
          placeholder="搜岗位 / 公司 / 标签"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <select className="input narrow" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="lastSeenAt">最新</option>
          <option value="ruleScore">匹配分</option>
        </select>
        <select className="input narrow" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>
          <option value={0}>不限分</option>
          <option value={60}>60+</option>
          <option value={75}>75+</option>
          <option value={85}>85+</option>
        </select>
      </div>

      <div className="chips">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            type="button"
            className={platforms.includes(p) ? 'chip on' : 'chip'}
            style={platforms.includes(p) ? { borderColor: PLATFORM_META[p].color, color: PLATFORM_META[p].color } : undefined}
            onClick={() => togglePlatform(p)}
          >
            {PLATFORM_META[p].short}
          </button>
        ))}
        <span className="divider" />
        {(Object.keys(STATUS_LABEL) as JobStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            className={statuses.includes(s) ? 'chip on' : 'chip'}
            onClick={() => toggleStatus(s)}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="list-head">
        <span className="muted small">{jobs.length} 条</span>
        <span className="spacer" />
        <button type="button" className="link" disabled={pushing} onClick={() => void openPushConfirm()}>
          {pushing ? '推送中…' : '推送到 DSH'}
        </button>
        <button type="button" className="link" onClick={() => void exportList('csv')}>
          导出 CSV
        </button>
        <button type="button" className="link" onClick={() => void exportList('xlsx')}>
          导出 Excel
        </button>
      </div>

      {confirmPush && (
        <div className="banner warn push-confirm">
          <span>
            把这 {confirmPush.count} 个岗位推送到 DSH 新会话？
            {confirmPush.skipped > 0 ? `（超出单次上限 ${confirmPush.max} 条的 ${confirmPush.skipped} 个不会推送）` : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={() => void runPush()}>
            确认推送
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirmPush(null)}>
            取消
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <p className="empty">
          还没有岗位。打开 BOSS / 猎聘 / 智联 / 鱼泡 的搜索结果页并登录，插件会自动采集列表里的岗位。
        </p>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.id} className="job-card">
              <div className="job-top">
                <a className="job-title" href={job.url} target="_blank" rel="noreferrer">
                  {job.title}
                </a>
                {job.ruleScore !== undefined && (
                  <span className={job.ruleScore >= 75 ? 'score high' : 'score'}>{job.ruleScore}</span>
                )}
              </div>
              <div className="job-meta">
                <span>{job.company || '未知公司'}</span>
                <span className="dot">·</span>
                <span>{job.city}</span>
                <span className="dot">·</span>
                <span>{formatSalary(job.salary)}</span>
                {job.experienceMin !== undefined && (
                  <>
                    <span className="dot">·</span>
                    <span>{job.experienceMin}年+</span>
                  </>
                )}
                {job.education && (
                  <>
                    <span className="dot">·</span>
                    <span>{job.education}</span>
                  </>
                )}
                {job.dshPushedAt !== undefined && (
                  <>
                    <span className="dot">·</span>
                    <span className="dsh-flag">已推送 DSH</span>
                  </>
                )}
              </div>
              {job.tags.length > 0 && (
                <div className="tags">
                  {job.tags.slice(0, 6).map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="job-actions">
                <span className="plat" style={{ color: PLATFORM_META[job.platform].color }}>
                  {PLATFORM_META[job.platform].short}
                </span>
                <button type="button" className="btn primary" onClick={() => void openApply(job)}>
                  打招呼
                </button>
                <button type="button" className="btn" onClick={() => void chrome.tabs.create({ url: job.url })}>
                  打开
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void setJobStatus(job.id, job.status === 'starred' ? 'new' : 'starred')}
                >
                  {job.status === 'starred' ? '取消收藏' : '收藏'}
                </button>
                <button type="button" className="btn ghost" onClick={() => void setJobStatus(job.id, 'ignored')}>
                  忽略
                </button>
                <button type="button" className="btn ghost" onClick={() => void deleteJob(job.id)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {target && (
        <div className="modal-mask" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>打招呼 · {target.title}</h3>
            <p className="muted small">
              {target.company} · {target.city} · 话术来源：{greetingSource === 'llm' ? 'AI 生成' : '本地模板'}
            </p>
            {drafting ? (
              <p className="muted">正在生成话术…</p>
            ) : (
              <textarea
                className="input textarea"
                rows={5}
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
              />
            )}
            <label className="check">
              <input type="checkbox" checked={sentPending} disabled onChange={() => undefined} />
              已填进页面输入框（请到标签页手动点发送）
            </label>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setTarget(null)}>
                关闭
              </button>
              {sentPending ? (
                <button type="button" className="btn primary" onClick={() => void confirmSent()}>
                  我已手动发送，记录一笔
                </button>
              ) : (
                <>
                  <button type="button" className="btn" disabled={busy || !greeting} onClick={() => void runApply(false)}>
                    {busy ? '处理中…' : '填进输入框'}
                  </button>
                  <button type="button" className="btn primary" disabled={busy || !greeting} onClick={() => void runApply(true)}>
                    填并自动发送
                  </button>
                </>
              )}
            </div>
            <p className="hint">
              自动发送会立即点出平台上的发送按钮，频率过高容易被判定为营销号；建议先用「填进输入框」。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
