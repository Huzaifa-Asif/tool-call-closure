export type ToolCall = Readonly<{ id: string; name: string }>;
export type Settlement =
  | Readonly<{ status: 'success'; content: string; provenance: 'reported' }>
  | Readonly<{ status: 'error' | 'cancelled'; code: string; message: string; provenance: 'reported' }>
  | Readonly<{ status: 'error' | 'cancelled'; code: string; message: string; provenance: 'synthetic'; sideEffectState: 'unknown' | 'not_started' }>;
export type BatchHandle = Readonly<{ generation: number }>;
export type CallSnapshot = Readonly<{
  id: string;
  name: string;
  state: 'pending' | 'success' | 'error' | 'cancelled';
  settlement: Settlement | null;
}>;
export type DiagnosticReason = 'stale_generation' | 'run_closed' | 'unknown_call' | 'duplicate_settlement' | 'pending_calls';
export type Snapshot = Readonly<{
  generation: number;
  closed: boolean;
  closeReason: null | Readonly<{ status: 'complete' }> | Readonly<{ status: 'error' | 'cancelled'; code: string; message: string; sideEffectState: 'unknown' | 'not_started' }>;
  calls: readonly CallSnapshot[];
  diagnostics: readonly Readonly<{ reason: DiagnosticReason; callId: string | null; generation: number | null; observedStatus: string | null }>[];
}>;
export type SettlementResult =
  | Readonly<{ accepted: true; generation: number; callId: string; settlement: Settlement }>
  | Readonly<{ accepted: false; reason: DiagnosticReason; callId: string | null; generation: number | null; observedStatus: string | null }>;
export interface ToolCallClosureOptions {
  maxCalls?: number;
  maxDiagnostics?: number;
  maxResultBytes?: number;
  maxMessageBytes?: number;
  maxIdBytes?: number;
  maxNameBytes?: number;
  maxCodeBytes?: number;
}
export interface Outcome {
  status: 'success' | 'error' | 'cancelled';
  content?: unknown;
  code?: string;
  message?: string;
}
export declare class ToolCallClosure {
  constructor(options?: ToolCallClosureOptions);
  get activeGeneration(): number | null;
  begin(calls: readonly ToolCall[]): Readonly<{ generation: number; handle: BatchHandle; superseded: Snapshot | null }>;
  settle(handle: BatchHandle, callId: string, outcome: Outcome): SettlementResult;
  succeed(handle: BatchHandle, callId: string, content: unknown): SettlementResult;
  fail(handle: BatchHandle, callId: string, error: unknown, code?: string): SettlementResult;
  cancel(handle: BatchHandle, callId: string, message?: string, code?: string): SettlementResult;
  close(handle: BatchHandle, reason?: { status?: 'error' | 'cancelled'; code?: string; message?: string; sideEffectState?: 'unknown' | 'not_started' }): Snapshot | SettlementResult;
  seal(handle: BatchHandle): Snapshot | SettlementResult;
  snapshot(): Snapshot | null;
  toOpenAIChatCompletions(snapshot?: Snapshot): readonly Readonly<{ role: 'tool'; tool_call_id: string; content: string }>[];
  toOpenAIResponses(snapshot?: Snapshot): readonly Readonly<{ type: 'function_call_output'; call_id: string; output: string }>[];
  toAnthropicToolResults(snapshot?: Snapshot): readonly Readonly<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }>[];
}
export declare function createToolCallClosure(options?: ToolCallClosureOptions): ToolCallClosure;
declare const api: Readonly<{ ToolCallClosure: typeof ToolCallClosure; createToolCallClosure: typeof createToolCallClosure }>;
export default api;
