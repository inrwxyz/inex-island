// Minimal browser-API stubs so modular TypeScript features run cleanly in Node Vitest.
const store = new Map<string, string>();
const cssProps = new Map<string, string>();
const listeners = new Map<string, Set<(ev: unknown) => void>>();

const storageMock: Storage = {
  get length() {
    return store.size;
  },
  clear() {
    store.clear();
  },
  getItem(k: string) {
    return store.has(k) ? store.get(k)! : null;
  },
  key(i: number) {
    return Array.from(store.keys())[i] ?? null;
  },
  removeItem(k: string) {
    store.delete(k);
  },
  setItem(k: string, v: string) {
    store.set(k, String(v));
  },
};

const addListener = (ev: string, fn: (e: unknown) => void): void => {
  let set = listeners.get(ev);
  if (!set) {
    set = new Set();
    listeners.set(ev, set);
  }
  set.add(fn);
};

const removeListener = (ev: string, fn: (e: unknown) => void): void => {
  listeners.get(ev)?.delete(fn);
};

const docElement = {
  dataset: {} as Record<string, string>,
  style: {
    setProperty(k: string, v: string) {
      cssProps.set(k, v);
    },
    getPropertyValue(k: string) {
      return cssProps.get(k) ?? '';
    },
  },
};

const documentMock = {
  documentElement: docElement,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    className: '',
    style: { setProperty() {} },
    append() {},
    addEventListener() {},
  }),
  addEventListener: addListener,
  removeEventListener: removeListener,
};

const windowMock = {
  Intl,
  addEventListener: addListener,
  removeEventListener: removeListener,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  open: () => null,
};

Object.defineProperty(globalThis, 'localStorage', { value: storageMock, configurable: true });
Object.defineProperty(globalThis, 'document', { value: documentMock, configurable: true });
Object.defineProperty(globalThis, 'window', { value: windowMock, configurable: true });

export { cssProps, store };
