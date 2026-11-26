// Typed lightweight event bus for decoupled feature communication
export type EventHandler<T = unknown> = (data: T) => void;

class EventBus {
  private readonly _listeners = new Map<string, Set<EventHandler<unknown>>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler as EventHandler<unknown>);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit<T = unknown>(event: string, data?: T): void {
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

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const unsub = this.on<T>(event, (data) => {
      unsub();
      handler(data);
    });
    return unsub;
  }
}

export const bus = new EventBus();
