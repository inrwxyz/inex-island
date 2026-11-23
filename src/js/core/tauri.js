// Typed wrapper around Tauri invoke/listen, mockable for browser dev

export const hasTauri = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INVOKE__);

export async function invokeTauri(cmd, args = {}) {
  try {
    if (window.__TAURI__?.core?.invoke) {
      return await window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI_INVOKE__) {
      return await window.__TAURI_INVOKE__(cmd, args);
    }
    return null;
  } catch (err) {
    console.warn(`[Tauri] invoke "${cmd}" error:`, err);
    throw err;
  }
}

export async function tryInvoke(cmd, args = {}) {
  try {
    return await invokeTauri(cmd, args);
  } catch {
    return null;
  }
}

export function listenTauri(name, handler) {
  const tryListen = () => {
    if (window.__TAURI__?.event && typeof window.__TAURI__.event.listen === 'function') {
      const r = window.__TAURI__.event.listen(name, (ev) => {
        try {
          handler(ev);
        } catch (err) {
          console.warn(`[Tauri] handler error for "${name}":`, err);
        }
      });
      if (r && r.catch) r.catch((e) => console.warn(`[Tauri] event listen failed for "${name}":`, e));
    } else {
      setTimeout(tryListen, 80);
    }
  };
  tryListen();
  return () => {};
}

export async function emitTauri(event, payload) {
  try {
    if (window.__TAURI__?.event?.emit) {
      return await window.__TAURI__.event.emit(event, payload);
    }
  } catch (err) {
    console.warn(`[Tauri] emit "${event}" error:`, err);
  }
}
