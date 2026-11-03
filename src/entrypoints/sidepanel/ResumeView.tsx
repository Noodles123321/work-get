import { useState } from 'react';
import { deleteResume, getSettings, listResumes, saveResume, saveSettings } from '../../db/repo';
import type { Resume, Settings } from '../../shared/types';
import { buildResume, extractTextFromFile, parseResumeText } from '../../ui/resume-parse';
import { useLive } from './useLive';

export default function ResumeView() {
  const resumes = useLive<Resume[]>(() => listResumes(), [], []);
  const settings = useLive<Settings | null>(() => getSettings(), [], null);
  const [draft, setDraft] = useState<Resume | null>(null);
  const [skillsText, setSkillsText] = useState('');
  const [citiesText, setCitiesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const activeId = settings?.activeResumeId ?? resumes[0]?.id;

  const loadDraft = (resume: Resume) => {
    setDraft(resume);
    setSkillsText(resume.skills.join('、'));
    setCitiesText(resume.cities.join('、'));
    setSaved(false);
    setError(null);
  };

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const text = await extractTextFromFile(file);
      if (!text.trim()) {
        setError('这个文件里没读出文字（可能是扫描版 PDF），请换一份或直接粘贴文本');
        return;
      }
      const parsed = parseResumeText(text);
      loadDraft(buildResume(parsed, text, file.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const persist = async (makeActive: boolean) => {
    if (!draft) return;
    const skills = splitList(skillsText);
    const cities = splitList(citiesText);
    const next: Resume = { ...draft, skills, cities, updatedAt: Date.now() };
    await saveResume(next);
    if (makeActive) await saveSettings({ activeResumeId: next.id });
    setDraft(next);
    setSaved(true);
  };

  return (
    <div className="view">
      <section className="card">
        <h3>导入简历</h3>
        <p className="muted small">支持 PDF / DOCX / TXT，解析全部在本地完成，不会上传到任何服务器。</p>
        <label className="file-drop">
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = '';
            }}
          />
          <span>{busy ? '解析中…' : '选择文件，或把简历拖进来'}</span>
        </label>
        {error && <div className="banner err">{error}</div>}
        <details className="paste">
          <summary>没有文件？直接粘贴简历文本</summary>
          <textarea
            className="input textarea"
            rows={6}
            placeholder="把简历全文粘到这里，点下面的按钮解析"
            onChange={(e) => {
              const text = e.target.value;
              if (text.trim().length < 40) return;
              const parsed = parseResumeText(text);
              loadDraft(buildResume(parsed, text, '手动粘贴'));
            }}
          />
        </details>
      </section>

      {draft && (
        <section className="card">
          <h3>确认信息 · {draft.fileName}</h3>
          <div className="grid2">
            <label className="field">
              <span>姓名</span>
              <input
                className="input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>工作年限</span>
              <input
                className="input"
                type="number"
                min={0}
                value={draft.years}
                onChange={(e) => setDraft({ ...draft, years: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="field">
            <span>技能（用、或逗号分隔，顺序即重要度）</span>
            <textarea
              className="input textarea"
              rows={3}
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
            />
          </label>
          <label className="field">
            <span>意向城市</span>
            <input className="input" value={citiesText} onChange={(e) => setCitiesText(e.target.value)} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>期望月薪（元）</span>
              <input
                className="input"
                type="number"
                step={1000}
                value={draft.expectedSalary?.min ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraft({
                    ...draft,
                    expectedSalary: e.target.value ? { min: v, unit: 'month', raw: `${v}元/月` } : undefined,
                  });
                }}
              />
            </label>
            <label className="field">
              <span>学历</span>
              <input
                className="input"
                value={draft.education ?? ''}
                onChange={(e) => setDraft({ ...draft, education: e.target.value })}
              />
            </label>
          </div>
          <details className="paste">
            <summary>查看解析出的全文</summary>
            <pre className="raw-text">{draft.rawText.slice(0, 6000)}</pre>
          </details>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setDraft(null)}>
              取消
            </button>
            <button type="button" className="btn" onClick={() => void persist(false)}>
              保存
            </button>
            <button type="button" className="btn primary" onClick={() => void persist(true)}>
              保存并设为当前简历
            </button>
          </div>
          {saved && <div className="banner ok">已保存。匹配分和话术会基于这份简历生成。</div>}
        </section>
      )}

      <section className="card">
        <h3>我的简历（{resumes.length}）</h3>
        {resumes.length === 0 ? (
          <p className="muted small">还没有简历。没有简历也能采集岗位，但算不出匹配分、也生成不了贴合的话术。</p>
        ) : (
          <ul className="resume-list">
            {resumes.map((r) => (
              <li key={r.id} className={r.id === activeId ? 'resume-item active' : 'resume-item'}>
                <div>
                  <b>{r.name}</b>
                  {r.id === activeId && <span className="badge">当前</span>}
                  <div className="muted small">
                    {r.years} 年 · {r.skills.length} 项技能 · 更新于{' '}
                    {new Date(r.updatedAt).toLocaleDateString('zh-CN')}
                  </div>
                </div>
                <div className="job-actions">
                  <button type="button" className="btn" onClick={() => loadDraft(r)}>
                    编辑
                  </button>
                  {r.id !== activeId && (
                    <button type="button" className="btn" onClick={() => void saveSettings({ activeResumeId: r.id })}>
                      设为当前
                    </button>
                  )}
                  <button type="button" className="btn ghost" onClick={() => void deleteResume(r.id)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function splitList(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[、,，;；/\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}
