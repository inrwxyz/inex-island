// Typed wrapper around Tauri invoke/listen, mockable for browser dev

export const hasTauri: boolean = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INVOKE__);

export async function invokeTauri<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    if (window.__TAURI__?.core?.invoke) {
      return await window.__TAURI__.core.invoke<T>(cmd, args);
    }
    if (window.__TAURI_INVOKE__) {
      return await window.__TAURI_INVOKE__<T>(cmd, args);
    }
    return null;
  } catch (err) {
    console.warn(`[Tauri] invoke "${cmd}" error:`, err);
    throw err;
  }
}

export async function tryInvoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  try {
    return await invokeTauri<T>(cmd, args);
  } catch {
    return null;
  }
}

export function listenTauri<T = unknown>(
  name: string,
  handler: (ev: TauriEvent<T>) => void
): () => void {
  const tryListen = (): void => {
    if (window.__TAURI__?.event && typeof window.__TAURI__.event.listen === 'function') {
      const r = window.__TAURI__.event.listen<T>(name, (ev) => {
        try {
          handler(ev);
        } catch (err) {
          console.warn(`[Tauri] handler error for "${name}":`, err);
        }
      });
      if (r && typeof r.catch === 'function') {
        r.catch((e: unknown) => console.warn(`[Tauri] event listen failed for "${name}":`, e));
      }
    } else {
      setTimeout(tryListen, 80);
    }
  };
  tryListen();
  return () => {};
}
