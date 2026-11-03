import { useState } from 'react';
import { stats, type Stats } from '../../db/repo';
import { useLive } from './useLive';
import JobsView from './JobsView';
import ApplicationsView from './ApplicationsView';
import ResumeView from './ResumeView';
import SettingsView from './SettingsView';

type Tab = 'jobs' | 'apps' | 'resume' | 'settings';

const EMPTY_STATS: Stats = {
  jobs: 0,
  starred: 0,
  applied: 0,
  byPlatform: {},
  byStatus: {},
  replies: 0,
  interviews: 0,
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'jobs', label: '岗位' },
  { id: 'apps', label: '投递' },
  { id: 'resume', label: '简历' },
  { id: 'settings', label: '设置' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('jobs');
  const s = useLive<Stats>(() => stats(), [tab], EMPTY_STATS);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">WG</span>
          <div>
            <h1>Work GET</h1>
            <p className="muted small">本地优先 · 只采集你已登录的页面</p>
          </div>
        </div>
        <div className="stat-row">
          <span className="stat">
            <b>{s.jobs}</b>岗位
          </span>
          <span className="stat">
            <b>{s.applied}</b>已投
          </span>
          <span className="stat">
            <b>{s.replies}</b>回复
          </span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="app-body">
        {tab === 'jobs' && <JobsView />}
        {tab === 'apps' && <ApplicationsView />}
        {tab === 'resume' && <ResumeView />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
