import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';

/** Dexie 的 liveQuery → React state。DB 变了自动重渲染，不用手工刷新。 */
export function useLive<T>(querier: () => Promise<T>, deps: unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: (v) => setValue(v),
      error: (e) => console.error('[Work GET] liveQuery error', e),
    });
    return () => sub.unsubscribe();
    // 依赖由调用方显式给出，避免每次渲染都重建订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
