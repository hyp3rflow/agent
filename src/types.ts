// Core types for openagent

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageContent[];
  model?: string;
  timestamp: number;
  usage?: TokenUsage;
}

export interface ImageContent {
  type: 'base64' | 'url';
  data: string;
  mimeType: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: string; // JSON string
}

export interface ToolResult {
  callId?: string;
  content: string;
  isError?: boolean;
  metadata?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type FinishReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'canceled' | 'error';

export type AgentEventType =
  | 'thinking'
  | 'content'
  | 'toolCall'
  | 'toolResult'
  | 'message'
  | 'done'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  message?: Message;
  error?: Error;
  usage?: TokenUsage;
  finishReason?: FinishReason;
}

export interface ProviderEvent {
  type: 'thinking_delta' | 'content_delta' | 'tool_use_start' | 'tool_use_delta' | 'tool_use_stop' | 'error' | 'complete';
  content?: string;
  toolCall?: ToolCall;
  error?: Error;
  response?: {
    finishReason: FinishReason;
    toolCalls: ToolCall[];
    usage: TokenUsage;
  };
}

export interface ProviderOptions {
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  required?: string[];
}

export interface ToolContext {
  sessionId: string;
  agentName: string;
  signal: AbortSignal;
  workingDirectory?: string;
}

export interface AgentConfig {
  name: string;
  provider: Provider;
  model: string;
  systemPrompt?: string;
  tools?: Tool[];
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  workingDirectory?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
  session?: Session;
  images?: ImageContent[];
  onEvent?: (event: AgentEvent) => void;
}

export interface Provider {
  readonly name: string;
  stream(messages: Message[], options: ProviderOptions): AsyncIterable<ProviderEvent>;
  complete(messages: Message[], options: ProviderOptions): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: TokenUsage;
    finishReason: FinishReason;
  }>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly required?: string[];
  execute(input: string, context: ToolContext): Promise<ToolResult>;
}

export interface Session {
  readonly id: string;
  messages: Message[];
  metadata: Record<string, unknown>;
  addMessage(message: Message): void;
  getMessages(): Message[];
  clear(): void;
}
