// Typed lightweight event bus for decoupled feature communication
class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit(event, data) {
    const set = this._listeners.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[EventBus] Error in handler for event "${event}":`, err);
        }
      }
    }
  }

  once(event, handler) {
    const unsub = this.on(event, (data) => {
      unsub();
      handler(data);
    });
    return unsub;
  }
}

export const bus = new EventBus();
