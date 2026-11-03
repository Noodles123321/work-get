import type { Platform } from '../shared/types';
import { detectRiskSignal } from '../shared/guard';
import { createAdapter, type PlatformAdapter, type PlatformConfig } from './base';
import bossConfig from './selectors/boss.json';
import liepinConfig from './selectors/liepin.json';
import yupaoConfig from './selectors/yupao.json';
import zhaopinConfig from './selectors/zhaopin.json';

/**
 * 默认选择器。平台改版时优先在「设置 → 选择器自检」里改，改完存进本地覆盖配置，
 * 不需要重新构建插件。JSON 与逻辑分离就是为此。
 */
export const DEFAULT_CONFIGS: Record<Platform, PlatformConfig> = {
  boss: bossConfig as unknown as PlatformConfig,
  liepin: liepinConfig as unknown as PlatformConfig,
  zhaopin: zhaopinConfig as unknown as PlatformConfig,
  yupao: yupaoConfig as unknown as PlatformConfig,
};

export type SelectorOverrides = Partial<Record<Platform, Partial<PlatformConfig>>>;

function mergeConfig(base: PlatformConfig, override?: Partial<PlatformConfig>): PlatformConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    fields: { ...base.fields, ...(override.fields ?? {}) },
    detailFields: { ...(base.detailFields ?? {}), ...(override.detailFields ?? {}) },
    apply: { ...base.apply, ...(override.apply ?? {}) },
    jobId: { ...base.jobId, ...(override.jobId ?? {}) },
  };
}

export function resolveConfig(platform: Platform, overrides?: SelectorOverrides): PlatformConfig {
  return mergeConfig(DEFAULT_CONFIGS[platform], overrides?.[platform]);
}

export function adapterForPlatform(platform: Platform, overrides?: SelectorOverrides): PlatformAdapter {
  return createAdapter(resolveConfig(platform, overrides), { detectRisk: (text) => detectRiskSignal(text) });
}

/** 按 URL 找适配器；不认识的主机返回 null。 */
export function adapterForUrl(url: string, overrides?: SelectorOverrides): PlatformAdapter | null {
  for (const platform of Object.keys(DEFAULT_CONFIGS) as Platform[]) {
    const adapter = adapterForPlatform(platform, overrides);
    if (adapter.matches(url)) return adapter;
  }
  return null;
}

export function platformForUrl(url: string): Platform | null {
  const adapter = adapterForUrl(url);
  return adapter?.id ?? null;
}
