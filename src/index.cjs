'use strict';

const DEFAULTS = Object.freeze({
  maxCalls: 1_000,
  maxDiagnostics: 100,
  maxResultBytes: 1_048_576,
  maxMessageBytes: 4_096,
  maxIdBytes: 512,
  maxNameBytes: 512,
  maxCodeBytes: 128,
});

const VALID_STATUSES = new Set(['success', 'error', 'cancelled']);
const CLOSE_STATUSES = new Set(['error', 'cancelled']);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedString(value, name, maxBytes) {
  const text = nonEmptyString(value, name);
  if (Buffer.byteLength(text) > maxBytes) throw new RangeError(`${name} exceeds its byte limit (${maxBytes})`);
  return text;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const suffix = maxBytes >= 3 ? '...' : '';
  let end = maxBytes - Buffer.byteLength(suffix);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}${suffix}`;
}

function serializeContent(value, maxBytes) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) throw new TypeError('result content must be JSON-serializable or a string');
  if (Buffer.byteLength(text) > maxBytes) {
    throw new RangeError(`result content exceeds maxResultBytes (${maxBytes})`);
  }
  return text;
}

function freezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = freezeCopy(child);
    return Object.freeze(copy);
  }
  return value;
}

class ToolCallClosure {
  #options;
  #generation = 0;
  #run = null;
  #diagnostics = [];
  #snapshots = new WeakSet();

  constructor(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    this.#options = Object.freeze({
      maxCalls: positiveInteger(options.maxCalls ?? DEFAULTS.maxCalls, 'maxCalls'),
      maxDiagnostics: positiveInteger(options.maxDiagnostics ?? DEFAULTS.maxDiagnostics, 'maxDiagnostics'),
      maxResultBytes: positiveInteger(options.maxResultBytes ?? DEFAULTS.maxResultBytes, 'maxResultBytes'),
      maxMessageBytes: positiveInteger(options.maxMessageBytes ?? DEFAULTS.maxMessageBytes, 'maxMessageBytes'),
      maxIdBytes: positiveInteger(options.maxIdBytes ?? DEFAULTS.maxIdBytes, 'maxIdBytes'),
      maxNameBytes: positiveInteger(options.maxNameBytes ?? DEFAULTS.maxNameBytes, 'maxNameBytes'),
      maxCodeBytes: positiveInteger(options.maxCodeBytes ?? DEFAULTS.maxCodeBytes, 'maxCodeBytes'),
    });
  }

  get activeGeneration() {
    return this.#run?.generation ?? null;
  }

  begin(calls) {
    if (!Array.isArray(calls)) throw new TypeError('calls must be an array');
    if (calls.length > this.#options.maxCalls) {
      throw new RangeError(`calls exceed maxCalls (${this.#options.maxCalls})`);
    }

    const seen = new Set();
    const normalized = calls.map((call, index) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) {
        throw new TypeError(`calls[${index}] must be an object`);
      }
      const id = boundedString(call.id, `calls[${index}].id`, this.#options.maxIdBytes);
      if (seen.has(id)) throw new TypeError(`duplicate tool call id: ${id}`);
      seen.add(id);
      return {
        id,
        name: boundedString(call.name, `calls[${index}].name`, this.#options.maxNameBytes),
        state: 'pending',
        settlement: null,
      };
    });

    let superseded = null;
    if (this.#run && !this.#run.closed) {
      superseded = this.close(this.#run.handle, {
        status: 'cancelled',
        code: 'superseded',
        message: 'Tool call was superseded by a newer generation.',
        sideEffectState: 'unknown',
      });
    }

    this.#generation += 1;
    const handle = Object.freeze({ generation: this.#generation });
    this.#diagnostics = [];
    this.#run = {
      generation: this.#generation,
      handle,
      closed: false,
      closeReason: null,
      calls: normalized,
      byId: new Map(normalized.map((call) => [call.id, call])),
    };
    return Object.freeze({ generation: this.#generation, handle, superseded });
  }

  settle(handle, callId, outcome) {
    boundedString(callId, 'callId', this.#options.maxIdBytes);
    const candidateGeneration = handle?.generation;
    const generation = Number.isSafeInteger(candidateGeneration) && candidateGeneration > 0 ? candidateGeneration : null;
    const observedStatus = VALID_STATUSES.has(outcome?.status) ? outcome.status : (outcome?.status == null ? null : 'invalid');

    if (!this.#run || handle !== this.#run.handle) {
      return this.#reject('stale_generation', callId, generation, observedStatus);
    }
    if (this.#run.closed) return this.#reject('run_closed', callId, generation, observedStatus);

    const call = this.#run.byId.get(callId);
    if (!call) return this.#reject('unknown_call', callId, generation);
    if (call.state !== 'pending') return this.#reject('duplicate_settlement', callId, generation);

    const settlement = this.#normalizeOutcome(outcome);
    call.state = settlement.status;
    call.settlement = settlement;
    return freezeCopy({ accepted: true, generation, callId, settlement });
  }

  succeed(handle, callId, content) {
    return this.settle(handle, callId, { status: 'success', content });
  }

  fail(handle, callId, error, code = 'tool_error') {
    const message = error instanceof Error ? error.message : String(error);
    return this.settle(handle, callId, { status: 'error', code, message });
  }

  cancel(handle, callId, message = 'Tool call was cancelled.', code = 'cancelled') {
    return this.settle(handle, callId, { status: 'cancelled', code, message });
  }

  close(handle, reason = {}) {
    const candidateGeneration = handle?.generation;
    const generation = Number.isSafeInteger(candidateGeneration) && candidateGeneration > 0 ? candidateGeneration : null;
    if (!this.#run || handle !== this.#run.handle) {
      return this.#reject('stale_generation', null, generation, null);
    }
    if (this.#run.closed) return this.snapshot();

    const status = reason.status ?? 'cancelled';
    if (!CLOSE_STATUSES.has(status)) {
      throw new TypeError('close status must be error or cancelled');
    }
    const code = boundedString(reason.code ?? status, 'reason.code', this.#options.maxCodeBytes);
    const sideEffectState = reason.sideEffectState ?? 'unknown';
    if (sideEffectState !== 'unknown' && sideEffectState !== 'not_started') {
      throw new TypeError('reason.sideEffectState must be unknown or not_started');
    }
    const message = truncateUtf8(
      reason.message ?? (status === 'error' ? 'Tool call did not complete.' : 'Tool call was cancelled.'),
      this.#options.maxMessageBytes,
    );
    for (const call of this.#run.calls) {
      if (call.state === 'pending') {
        call.state = status;
        call.settlement = Object.freeze({ status, code, message, provenance: 'synthetic', sideEffectState });
      }
    }
    this.#run.closed = true;
    this.#run.closeReason = { status, code, message, sideEffectState };
    return this.snapshot();
  }

  seal(handle) {
    const candidateGeneration = handle?.generation;
    const generation = Number.isSafeInteger(candidateGeneration) && candidateGeneration > 0 ? candidateGeneration : null;
    if (!this.#run || handle !== this.#run.handle) {
      return this.#reject('stale_generation', null, generation, null);
    }
    if (this.#run.closed) return this.snapshot();
    if (this.#run.calls.some((call) => call.state === 'pending')) {
      return this.#reject('pending_calls', null, generation, null);
    }
    this.#run.closed = true;
    this.#run.closeReason = { status: 'complete' };
    return this.snapshot();
  }

  snapshot() {
    if (!this.#run) return null;
    const snapshot = freezeCopy({
      generation: this.#run.generation,
      closed: this.#run.closed,
      closeReason: this.#run.closeReason,
      calls: this.#run.calls.map(({ id, name, state, settlement }) => ({ id, name, state, settlement })),
      diagnostics: this.#diagnostics,
    });
    this.#snapshots.add(snapshot);
    return snapshot;
  }

  toOpenAIChatCompletions(snapshot = this.snapshot()) {
    this.#assertSnapshot(snapshot);
    return snapshot.calls.filter((call) => call.state !== 'pending').map((call) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: this.#adapterContent(call.settlement),
    }));
  }

  toOpenAIResponses(snapshot = this.snapshot()) {
    this.#assertSnapshot(snapshot);
    return snapshot.calls.filter((call) => call.state !== 'pending').map((call) => ({
      type: 'function_call_output',
      call_id: call.id,
      output: this.#adapterContent(call.settlement),
    }));
  }

  toAnthropicToolResults(snapshot = this.snapshot()) {
    this.#assertSnapshot(snapshot);
    return snapshot.calls.filter((call) => call.state !== 'pending').map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: this.#adapterContent(call.settlement),
      ...(call.state === 'success' ? {} : { is_error: true }),
    }));
  }

  #normalizeOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
      throw new TypeError('outcome must be an object');
    }
    const status = outcome.status;
    if (!VALID_STATUSES.has(status)) {
      throw new TypeError('outcome.status must be success, error, or cancelled');
    }
    if (status === 'success') {
      return Object.freeze({ status, content: serializeContent(outcome.content, this.#options.maxResultBytes), provenance: 'reported' });
    }
    return Object.freeze({
      status,
      code: boundedString(outcome.code ?? status, 'outcome.code', this.#options.maxCodeBytes),
      message: truncateUtf8(outcome.message ?? (status === 'error' ? 'Tool call failed.' : 'Tool call was cancelled.'), this.#options.maxMessageBytes),
      provenance: 'reported',
    });
  }

  #adapterContent(settlement) {
    if (settlement.status === 'success') return settlement.content;
    return JSON.stringify({ error: {
      code: settlement.code,
      message: settlement.message,
      ...(settlement.provenance === 'synthetic' ? { side_effect_state: settlement.sideEffectState } : {}),
    } });
  }

  #assertSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.calls) || !this.#snapshots.has(snapshot)) {
      throw new TypeError('snapshot must be a ToolCallClosure snapshot');
    }
    if (!snapshot.closed) throw new TypeError('snapshot must be sealed before provider export');
  }

  #reject(reason, callId, generation, observedStatus = null) {
    const diagnostic = freezeCopy({ reason, callId, generation, observedStatus });
    if (this.#diagnostics.length < this.#options.maxDiagnostics) this.#diagnostics.push(diagnostic);
    return freezeCopy({ accepted: false, reason, callId, generation, observedStatus });
  }
}

function createToolCallClosure(options) {
  return new ToolCallClosure(options);
}

module.exports = { ToolCallClosure, createToolCallClosure };
