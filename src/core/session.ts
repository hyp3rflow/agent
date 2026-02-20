import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Message, Session } from './types.js';

export class InMemorySession implements Session {
  readonly id: string;
  messages: Message[] = [];
  metadata: Record<string, unknown> = {};

  constructor(id?: string) {
    this.id = id ?? nanoid();
  }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): Message[] {
    return this.messages;
  }

  clear(): void {
    this.messages = [];
    this.metadata = {};
  }
}

export class PersistentSession extends InMemorySession {
  private storagePath: string;

  constructor(id: string, storagePath: string) {
    super(id);
    this.storagePath = storagePath;
    mkdirSync(storagePath, { recursive: true });
  }

  addMessage(message: Message): void {
    super.addMessage(message);
    this.persist();
  }

  clear(): void {
    super.clear();
    this.persist();
  }

  private persist(): void {
    const filePath = join(this.storagePath, `${this.id}.json`);
    writeFileSync(filePath, JSON.stringify({
      id: this.id,
      messages: this.messages,
      metadata: this.metadata,
    }, null, 2));
  }

  static load(id: string, storagePath: string): PersistentSession {
    const session = new PersistentSession(id, storagePath);
    const filePath = join(storagePath, `${id}.json`);
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      session.messages = data.messages ?? [];
      session.metadata = data.metadata ?? {};
    }
    return session;
  }
}
