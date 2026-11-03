import { useEffect, useState } from 'react';
import {
  clearAll,
  clearRiskSignals,
  getQuota,
  getRiskSignals,
  getSettings,
  saveDshBridge,
  saveLlm,
  savePreferences,
} from '../../db/repo';
import { db } from '../../db/schema';
import { RISK_LABEL } from '../../shared/guard';
import { localDateKey } from '../../shared/quota';
import { PLATFORMS, PLATFORM_META, type Platform, type Preferences, type RiskSignal, type Settings } from '../../shared/types';
import { selfCheckActiveTab } from '../../ui/apply-flow';
import { bridgeHealth, normalizeBaseUrl } from '../../ui/dsh-bridge';
import { useLive } from './useLive';

const OVERRIDES_KEY = 'selector-overrides';

export default function SettingsView() {
  const settings = useLive<Settings | null>(() => getSettings(), [], null);
  const quotas = useLive<Record<string, number>>(async () => {
    const out: Record<string, number> = {};
    for (const p of PLATFORMS) out[p] = (await getQuota(p)).count;
    return out;
  }, [], {});
  const risks = useLive<Record<string, RiskSignal[]>>(async () => {
    const out: Record<string, RiskSignal[]> = {};
    for (const p of PLATFORMS) out[p] = await getRiskSignals(p);
    return out;
  }, [], {});

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [llm, setLlm] = useState<Settings['llm'] | null>(null);
  const [dsh, setDsh] = useState<Settings['dshBridge'] | null>(null);
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [keywordsText, setKeywordsText] = useState('');
  const [citiesText, setCitiesText] = useState('');
  const [blockedText, setBlockedText] = useState('');
  const [blockedKwText, setBlockedKwText] = useState('');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [overridesText, setOverridesText] = useState('{}');
  const [checkResult, setCheckResult] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setPrefs(settings.prefs);
    setLlm(settings.llm);
    setDsh(settings.dshBridge);
    setKeywordsText(settings.prefs.keywords.join('、'));
    setCitiesText(settings.prefs.cities.join('、'));
    setBlockedText(settings.prefs.blockedCompanies.join('、'));
    setBlockedKwText(settings.prefs.blockedKeywords.join('、'));
  }, [settings]);

  useEffect(() => {
    void (async () => {
      const record = await db.kv.get(OVERRIDES_KEY);
      if (record?.value) setOverridesText(JSON.stringify(record.value, null, 2));
    })();
  }, []);

  if (!settings || !prefs || !llm || !dsh) return <div className="view muted">加载中…</div>;

  const flash = (text: string) => {
    setSavedMsg(text);
    setTimeout(() => setSavedMsg(null), 2500);
  };

  const savePrefs = async () => {
    await savePreferences({
      ...prefs,
      keywords: splitList(keywordsText),
      cities: splitList(citiesText),
      blockedCompanies: splitList(blockedText),
      blockedKeywords: splitList(blockedKwText),
    });
    flash('偏好已保存');
  };

  const saveLlmSettings = async () => {
    await saveLlm(llm);
    flash('AI 设置已保存');
  };

  const saveDshSettings = async () => {
    const next = await saveDshBridge({ ...dsh, url: normalizeBaseUrl(dsh.url) });
    setDsh(next);
    flash('DSH 侧设置已保存');
  };

  const testBridge = async () => {
    setTesting(true);
    setBridgeMsg(null);
    try {
      const result = await bridgeHealth(dsh);
      setBridgeMsg(
        result.ok
          ? `连接正常：${String(result.info?.name || '')} v${String(result.info?.version || '?')}，已成功推送 ${String(result.info?.pushes ?? 0)} 批`
          : `连接失败：${result.message || '未知错误'}（确认 DSH 已重启、插件已启用）`,
      );
    } finally {
      setTesting(false);
    }
  };

  const saveOverrides = async () => {
    try {
      const parsed = JSON.parse(overridesText) as unknown;
      await db.kv.put({ key: OVERRIDES_KEY, value: parsed, updatedAt: Date.now() });
      flash('选择器覆盖已保存，刷新目标页面后生效');
    } catch (e) {
      setSavedMsg(`JSON 格式错误：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const runSelfCheck = async () => {
    const result = await selfCheckActiveTab();
    setCheckResult(JSON.stringify(result, null, 2));
  };

  return (
    <div className="view">
      {savedMsg && <div className="banner ok">{savedMsg}</div>}

      <section className="card">
        <h3>每日沟通配额 · {localDateKey()}</h3>
        <ul className="quota-list">
          {PLATFORMS.map((p) => (
            <li key={p}>
              <span style={{ color: PLATFORM_META[p].color }}>{PLATFORM_META[p].short}</span>
              <span className="spacer" />
              <b>{quotas[p] ?? 0}</b>
              <span className="muted"> / {prefs.dailyLimits[p]}</span>
              <input
                className="input tiny"
                type="number"
                min={0}
                max={100}
                value={prefs.dailyLimits[p]}
                onChange={(e) =>
                  setPrefs({ ...prefs, dailyLimits: { ...prefs.dailyLimits, [p]: Number(e.target.value) } })
                }
              />
            </li>
          ))}
        </ul>
        <p className="hint">
          平台本身还有更硬的每日上限（BOSS 约 50–80 次沟通/天，猎聘更低）。配额调高只是允许插件操作，
          真正约束在平台侧；建议保持保守，被限流就停一天。
        </p>
        <button type="button" className="btn" onClick={() => void savePrefs()}>
          保存配额
        </button>
      </section>

      <section className="card">
        <h3>求职偏好</h3>
        <div className="grid2">
          <label className="field">
            <span>求职方向</span>
            <select
              className="input"
              value={prefs.direction}
              onChange={(e) => setPrefs({ ...prefs, direction: e.target.value as Preferences['direction'] })}
            >
              <option value="white-collar">白领（互联网 / 技术 / 职能）</option>
              <option value="blue-collar">蓝领（工地 / 工厂 / 配送）</option>
              <option value="both">不限（都看）</option>
            </select>
          </label>
          <label className="field">
            <span>岗位关键词</span>
            <input className="input" value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} />
          </label>
          <label className="field">
            <span>意向城市</span>
            <input className="input" value={citiesText} onChange={(e) => setCitiesText(e.target.value)} />
          </label>
          <label className="field">
            <span>最低月薪（元）</span>
            <input
              className="input"
              type="number"
              step={1000}
              value={prefs.salaryMin ?? ''}
              onChange={(e) => setPrefs({ ...prefs, salaryMin: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
          <label className="field">
            <span>经验上限（年）</span>
            <input
              className="input"
              type="number"
              min={0}
              value={prefs.experienceMax ?? ''}
              onChange={(e) =>
                setPrefs({ ...prefs, experienceMax: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label className="field">
            <span>屏蔽公司</span>
            <input className="input" value={blockedText} onChange={(e) => setBlockedText(e.target.value)} />
          </label>
          <label className="field">
            <span>屏蔽关键词</span>
            <input className="input" value={blockedKwText} onChange={(e) => setBlockedKwText(e.target.value)} />
          </label>
          <label className="field">
            <span>投递间隔（秒，最小）</span>
            <input
              className="input"
              type="number"
              min={5}
              value={Math.round(prefs.applyIntervalMs[0] / 1000)}
              onChange={(e) =>
                setPrefs({ ...prefs, applyIntervalMs: [Number(e.target.value) * 1000, prefs.applyIntervalMs[1]] })
              }
            />
          </label>
          <label className="field">
            <span>跟进提醒（天）</span>
            <input
              className="input"
              type="number"
              min={1}
              value={prefs.followUpDays}
              onChange={(e) => setPrefs({ ...prefs, followUpDays: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.autoSend}
            onChange={(e) => setPrefs({ ...prefs, autoSend: e.target.checked })}
          />
          允许插件自动点"发送"（默认关；开启后更容易被平台判定为机器操作）
        </label>
        <button type="button" className="btn primary" onClick={() => void savePrefs()}>
          保存偏好
        </button>
      </section>

      <section className="card">
        <h3>AI 增强（可选）</h3>
        <p className="muted small">
          填了才会用。走 OpenAI 兼容接口，请求从浏览器直接发出，不经过第三方；开启脱敏后会把手机号/邮箱/身份证换成占位符。
        </p>
        <label className="check">
          <input type="checkbox" checked={llm.enabled} onChange={(e) => setLlm({ ...llm, enabled: e.target.checked })} />
          启用 AI 打分与话术生成
        </label>
        <div className="grid2">
          <label className="field">
            <span>Base URL</span>
            <input className="input" value={llm.baseUrl} onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>模型</span>
            <input className="input" value={llm.model} onChange={(e) => setLlm({ ...llm, model: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>API Key（只存在本机 IndexedDB）</span>
          <input
            className="input"
            type="password"
            value={llm.apiKey}
            onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={llm.redact} onChange={(e) => setLlm({ ...llm, redact: e.target.checked })} />
          发送前脱敏
        </label>
        <button type="button" className="btn primary" onClick={() => void saveLlmSettings()}>
          保存 AI 设置
        </button>
      </section>

      <section className="card">
        <h3>DSH 侧（推送到新会话）</h3>
        <p className="muted small">
          需要本机 DSH 装好 dsh-workget-bridge 插件：装完重启 DSH，本机 127.0.0.1:3610 就会接收推送并在 DSH 里开一个新会话。
          安装步骤见 docs/dsh-bridge.md。
        </p>
        <label className="check">
          <input type="checkbox" checked={dsh.enabled} onChange={(e) => setDsh({ ...dsh, enabled: e.target.checked })} />
          启用岗位列表里的「推送到 DSH」
        </label>
        <div className="grid2">
          <label className="field">
            <span>桥地址</span>
            <input className="input" value={dsh.url} onChange={(e) => setDsh({ ...dsh, url: e.target.value })} />
          </label>
          <label className="field">
            <span>单次最多推送（条）</span>
            <input
              className="input"
              type="number"
              min={1}
              max={50}
              value={dsh.maxJobs}
              onChange={(e) => setDsh({ ...dsh, maxJobs: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="field">
          <span>Token（= 工作区 .dsh-bridge/token.txt 的内容）</span>
          <input
            className="input"
            type="password"
            value={dsh.token}
            placeholder="首次推送前必须填"
            onChange={(e) => setDsh({ ...dsh, token: e.target.value })}
          />
        </label>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={() => void saveDshSettings()}>
            保存 DSH 设置
          </button>
          <button type="button" className="btn" disabled={testing} onClick={() => void testBridge()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {bridgeMsg && (
          <p className={bridgeMsg.startsWith('连接正常') ? 'ok-text small' : 'warn-text small'}>{bridgeMsg}</p>
        )}
        <p className="hint">
          同一批岗位 10 分钟内点两次不会重复开新会话；推送内容只在本机浏览器 ↔ 本机 DSH 之间流动，不经过任何第三方。
        </p>
      </section>

      <section className="card">
        <h3>平台状态</h3>
        <ul className="quota-list">
          {PLATFORMS.map((p) => {
            const list = risks[p] ?? [];
            const latest = list[list.length - 1];
            return (
              <li key={p}>
                <span style={{ color: PLATFORM_META[p].color }}>{PLATFORM_META[p].short}</span>
                <span className="spacer" />
                {latest ? (
                  <>
                    <span className="warn-text">{RISK_LABEL[latest.kind]} · {new Date(latest.at).toLocaleString('zh-CN')}</span>
                    <button type="button" className="link" onClick={() => void clearRiskSignals(p)}>
                      解除
                    </button>
                  </>
                ) : (
                  <span className="muted small">正常</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h3>选择器自检（平台改版时用）</h3>
        <p className="muted small">
          在当前标签页（必须是招聘平台页面）跑一遍抓取规则，看每个字段能匹配到几个元素。为 0 说明该平台改版了，
          把下面的 JSON 改好保存即可，不用重新安装插件。
        </p>
        <button type="button" className="btn" onClick={() => void runSelfCheck()}>
          检测当前页面
        </button>
        {checkResult && <pre className="raw-text">{checkResult}</pre>}
        <label className="field">
          <span>覆盖配置（JSON，键为平台 id：boss / liepin / zhaopin / yupao）</span>
          <textarea
            className="input textarea mono"
            rows={10}
            value={overridesText}
            onChange={(e) => setOverridesText(e.target.value)}
          />
        </label>
        <button type="button" className="btn primary" onClick={() => void saveOverrides()}>
          保存覆盖配置
        </button>
      </section>

      <section className="card danger">
        <h3>数据</h3>
        <p className="muted small">所有数据都在本机 IndexedDB 里，卸载扩展即清空。换电脑前先导出。</p>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            if (confirm('确定清空所有岗位、投递记录、简历和设置？无法撤销。')) void clearAll();
          }}
        >
          清空全部数据
        </button>
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

export type { Platform };
