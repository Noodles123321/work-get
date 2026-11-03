import { useState } from 'react';
import { listApplications, updateApplication } from '../../db/repo';
import {
  APPLICATION_HEADER,
  applicationsToRows,
  downloadBlob,
  timestampName,
  toCsv,
  toXlsx,
} from '../../shared/export';
import { APPLICATION_STATE_LABEL, PLATFORM_META, type ApplicationState, type Application } from '../../shared/types';
import { useLive } from './useLive';

const STATES = Object.keys(APPLICATION_STATE_LABEL) as ApplicationState[];

const DAY = 86_400_000;

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ApplicationsView() {
  const apps = useLive<Application[]>(() => listApplications(), [], []);
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const now = Date.now();
  const due = apps.filter((a) => a.followUpAt !== undefined && a.followUpAt <= now && a.state === 'sent');
  const counts = STATES.map((s) => ({ state: s, n: apps.filter((a) => a.state === s).length }));

  const exportApps = async (kind: 'csv' | 'xlsx') => {
    const rows = applicationsToRows(apps);
    if (kind === 'csv') {
      downloadBlob(
        timestampName('workget-applications', 'csv'),
        new Blob([toCsv(APPLICATION_HEADER, rows)], { type: 'text/csv' }),
      );
    } else {
      const buffer = await toXlsx(APPLICATION_HEADER, rows, '投递');
      downloadBlob(
        timestampName('workget-applications', 'xlsx'),
        new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      );
    }
  };

  return (
    <div className="view">
      <div className="summary">
        {counts.map((c) => (
          <span key={c.state} className="summary-item">
            <b>{c.n}</b>
            {APPLICATION_STATE_LABEL[c.state]}
          </span>
        ))}
      </div>

      {due.length > 0 && (
        <div className="banner warn">有 {due.length} 条投递超过 {''}跟进周期还没消息，建议去问问进度。</div>
      )}

      <div className="list-head">
        <span className="muted small">{apps.length} 条投递记录</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={() => void exportApps('csv')}>
          导出 CSV
        </button>
        <button type="button" className="link" onClick={() => void exportApps('xlsx')}>
          导出 Excel
        </button>
      </div>

      {apps.length === 0 ? (
        <p className="empty">还没有投递记录。在「岗位」里打招呼并确认发出后会自动记一笔。</p>
      ) : (
        <ul className="app-list">
          {apps.map((app) => (
            <li key={app.id} className="app-card">
              <div className="job-top">
                <span className="job-title plain">{app.jobTitle}</span>
                <span className="plat" style={{ color: PLATFORM_META[app.platform].color }}>
                  {PLATFORM_META[app.platform].short}
                </span>
              </div>
              <div className="job-meta">
                <span>{app.company}</span>
                <span className="dot">·</span>
                <span>{fmtDate(app.at)}</span>
                {app.followUpAt && (
                  <>
                    <span className="dot">·</span>
                    <span className={app.followUpAt <= now && app.state === 'sent' ? 'due' : ''}>
                      跟进 {new Date(app.followUpAt).toLocaleDateString('zh-CN')}
                    </span>
                  </>
                )}
              </div>
              {app.note && <p className="app-note">{app.note}</p>}
              <div className="job-actions">
                <select
                  className="input narrow"
                  value={app.state}
                  onChange={(e) => void updateApplication(app.id, { state: e.target.value as ApplicationState })}
                >
                  {STATES.map((s) => (
                    <option key={s} value={s}>
                      {APPLICATION_STATE_LABEL[s]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditing(app.id);
                    setNote(app.note ?? '');
                  }}
                >
                  备注
                </button>
                {app.state === 'sent' && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void updateApplication(app.id, { followUpAt: Math.round((app.followUpAt ?? now) + 3 * DAY) })
                    }
                  >
                    推迟 3 天
                  </button>
                )}
              </div>
              {editing === app.id && (
                <div className="note-edit">
                  <input
                    className="input"
                    value={note}
                    placeholder="HR 回复了什么 / 下一步做什么"
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      void updateApplication(app.id, { note });
                      setEditing(null);
                    }}
                  >
                    保存
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
