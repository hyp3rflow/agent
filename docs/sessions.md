# Sessions

Sessions store conversation messages and metadata. Used by `Agent.run()` to maintain context across turns.

## Session Interface

```typescript
interface Session {
  readonly id: string;
  messages: Message[];
  metadata: Record<string, unknown>;
  addMessage(message: Message): void;
  getMessages(): Message[];
  clear(): void;
}
```

## InMemorySession

Default session. Messages stored in memory only.

```typescript
import { InMemorySession } from '@hrmm/agent';

const session = new InMemorySession();          // auto-generated ID
const session = new InMemorySession('my-id');   // custom ID
```

Used automatically when no session is passed to `agent.run()`.

## PersistentSession

File-backed session. Writes JSON to disk on every `addMessage()` and `clear()`.

```typescript
import { PersistentSession } from '@hrmm/agent';

// Create new
const session = new PersistentSession('session-1', './data/sessions');

// Load existing
const session = PersistentSession.load('session-1', './data/sessions');
```

Storage format: `{storagePath}/{id}.json`

```json
{
  "id": "session-1",
  "messages": [...],
  "metadata": {}
}
```

The storage directory is auto-created if it doesn't exist.

## Using Sessions

```typescript
const session = new InMemorySession('user-123');

// First conversation
for await (const event of agent.run('Hello', { session })) { ... }

// Continue with context
for await (const event of agent.run('Tell me more', { session })) { ... }

// Reset
session.clear();
```

## Custom Sessions

Implement the `Session` interface for custom storage (database, Redis, etc.):

```typescript
class RedisSession implements Session {
  readonly id: string;
  messages: Message[] = [];
  metadata: Record<string, unknown> = {};

  addMessage(message: Message) {
    this.messages.push(message);
    // persist to Redis
  }
  getMessages() { return this.messages; }
  clear() { this.messages = []; this.metadata = {}; }
}
```
