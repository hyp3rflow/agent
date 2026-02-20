type Handler<T> = (data: T) => void;

export class EventBus<T> {
  private handlers = new Map<string, Set<Handler<T>>>();

  on(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  once(event: string, handler: Handler<T>): () => void {
    const wrapper: Handler<T> = (data) => {
      this.off(event, wrapper);
      handler(data);
    };
    return this.on(event, wrapper);
  }

  emit(event: string, data: T): void {
    // Specific handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const h of handlers) h(data);
    }
    // Wildcard handlers
    if (event !== '*') {
      const wildcardHandlers = this.handlers.get('*');
      if (wildcardHandlers) {
        for (const h of wildcardHandlers) h(data);
      }
    }
  }

  off(event: string, handler: Handler<T>): void {
    this.handlers.get(event)?.delete(handler);
  }
}
