import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCallClosure, createToolCallClosure } from '../src/index.js';

test('settles calls exactly once and preserves announcement order', () => {
  const closure = createToolCallClosure();
  const { generation, handle } = closure.begin([{ id: 'a', name: 'search' }, { id: 'b', name: 'read' }]);
  assert.equal(closure.succeed(handle, 'b', { ok: true }).accepted, true);
  assert.equal(closure.fail(handle, 'a', new Error('offline'), 'network_error').accepted, true);
  const duplicate = closure.succeed(handle, 'a', 'late');
  assert.deepEqual(duplicate, { accepted: false, reason: 'duplicate_settlement', callId: 'a', generation, observedStatus: null });
  assert.deepEqual(closure.snapshot().calls.map((call) => call.id), ['a', 'b']);
});

test('close creates explicit synthetic outcomes only for pending calls', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'done', name: 'a' }, { id: 'pending', name: 'b' }]);
  closure.succeed(handle, 'done', 'real output');
  const snapshot = closure.close(handle, { status: 'cancelled', code: 'timeout', message: 'Deadline elapsed.', sideEffectState: 'unknown' });
  assert.equal(snapshot.closed, true);
  assert.deepEqual(snapshot.calls[0].settlement, { status: 'success', content: 'real output', provenance: 'reported' });
  assert.deepEqual(snapshot.calls[1].settlement, {
    status: 'cancelled', code: 'timeout', message: 'Deadline elapsed.', provenance: 'synthetic', sideEffectState: 'unknown',
  });
  const late = closure.succeed(handle, 'pending', 'late output');
  assert.equal(late.reason, 'run_closed');
  assert.equal(late.observedStatus, 'success');
});

test('begin supersedes an active generation and fences its late results', () => {
  const closure = new ToolCallClosure();
  const first = closure.begin([{ id: 'old', name: 'slow' }]);
  const second = closure.begin([{ id: 'new', name: 'fast' }]);
  assert.equal(second.superseded.calls[0].settlement.provenance, 'synthetic');
  assert.equal(second.superseded.calls[0].settlement.code, 'superseded');
  assert.equal(closure.succeed(first.handle, 'old', 'too late').reason, 'stale_generation');
  assert.equal(closure.succeed(second.handle, 'new', 'ok').accepted, true);
});

test('rejects unknown calls and bounds diagnostics', () => {
  const closure = new ToolCallClosure({ maxDiagnostics: 2 });
  const { handle } = closure.begin([]);
  closure.succeed(handle, 'missing-1', 'x');
  closure.succeed(handle, 'missing-2', 'x');
  closure.succeed(handle, 'missing-3', 'x');
  assert.equal(closure.snapshot().diagnostics.length, 2);
  assert.equal(closure.snapshot().diagnostics[0].reason, 'unknown_call');
});

test('emits distinct OpenAI and Anthropic payload schemas', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'x', name: 'lookup' }, { id: 'y', name: 'write' }]);
  closure.succeed(handle, 'x', { value: 3 });
  const snapshot = closure.close(handle, { status: 'error', code: 'limit', message: 'Limit reached.', sideEffectState: 'not_started' });
  assert.deepEqual(closure.toOpenAIChatCompletions(snapshot), [
    { role: 'tool', tool_call_id: 'x', content: '{"value":3}' },
    { role: 'tool', tool_call_id: 'y', content: '{"error":{"code":"limit","message":"Limit reached.","side_effect_state":"not_started"}}' },
  ]);
  assert.deepEqual(closure.toOpenAIResponses(snapshot), [
    { type: 'function_call_output', call_id: 'x', output: '{"value":3}' },
    { type: 'function_call_output', call_id: 'y', output: '{"error":{"code":"limit","message":"Limit reached.","side_effect_state":"not_started"}}' },
  ]);
  assert.deepEqual(closure.toAnthropicToolResults(snapshot), [
    { type: 'tool_result', tool_use_id: 'x', content: '{"value":3}' },
    { type: 'tool_result', tool_use_id: 'y', content: '{"error":{"code":"limit","message":"Limit reached.","side_effect_state":"not_started"}}', is_error: true },
  ]);
});

test('validates limits, duplicate ids, content size, and circular values', () => {
  assert.throws(() => new ToolCallClosure({ maxCalls: 0 }), /positive safe integer/);
  const closure = new ToolCallClosure({ maxCalls: 1, maxResultBytes: 4 });
  assert.throws(() => closure.begin([{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }]), /maxCalls/);
  assert.throws(() => closure.begin([{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }]), /maxCalls/);
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  assert.throws(() => closure.succeed(handle, 'a', '12345'), /maxResultBytes/);
  const circular = {}; circular.self = circular;
  assert.throws(() => closure.succeed(handle, 'a', circular), /circular/i);
  assert.equal(closure.snapshot().calls[0].state, 'pending');
});

test('rejects duplicate ids independently of call limits', () => {
  const closure = new ToolCallClosure({ maxCalls: 2 });
  assert.throws(() => closure.begin([{ id: 'same', name: 'a' }, { id: 'same', name: 'b' }]), /duplicate/);
});

test('truncates messages without retaining Error stacks', () => {
  const closure = new ToolCallClosure({ maxMessageBytes: 12 });
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  closure.fail(handle, 'a', new Error('abcdefghijklmnop'));
  const result = closure.snapshot().calls[0].settlement;
  assert.ok(Buffer.byteLength(result.message) <= 12);
  assert.equal('stack' in result, false);
});

test('snapshots are immutable detached views', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  const before = closure.snapshot();
  assert.throws(() => { before.calls[0].state = 'success'; }, TypeError);
  closure.succeed(handle, 'a', 'ok');
  assert.equal(before.calls[0].state, 'pending');
});

test('fuzzes settlement order while preserving exactly-once invariants', () => {
  let seed = 0x12345678;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const count = 1 + Math.floor(random() * 30);
    const calls = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, name: 'tool' }));
    const closure = new ToolCallClosure();
    const { handle } = closure.begin(calls);
    for (let attempt = 0; attempt < count * 3; attempt += 1) {
      const id = `c${Math.floor(random() * count)}`;
      closure.succeed(handle, id, attempt);
    }
    const snapshot = closure.close(handle, { code: 'fuzz_end', message: 'Fuzz run ended.', sideEffectState: 'unknown' });
    assert.equal(snapshot.calls.length, count);
    assert.ok(snapshot.calls.every((call) => call.state !== 'pending' && call.settlement));
    assert.equal(closure.toOpenAIResponses(snapshot).length, count);
    assert.deepEqual(snapshot.calls.map((call) => call.id), calls.map((call) => call.id));
  }
});

test('requires a complete sealed batch before provider export', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }]);
  closure.succeed(handle, 'b', 'second finished first');
  assert.throws(() => closure.toOpenAIResponses(), /sealed/);
  assert.equal(closure.seal(handle).reason, 'pending_calls');
  closure.succeed(handle, 'a', 'first finished second');
  const sealed = closure.seal(handle);
  assert.equal(sealed.closeReason.status, 'complete');
  const firstExport = closure.toOpenAIResponses(sealed);
  const secondExport = closure.toOpenAIResponses(sealed);
  assert.deepEqual(firstExport, secondExport);
  assert.deepEqual(firstExport.map((item) => item.call_id), ['a', 'b']);
});

test('uses handle identity and permits reused call ids only in a new generation', () => {
  const closure = new ToolCallClosure();
  const first = closure.begin([{ id: 'reused', name: 'old' }]);
  const forged = Object.freeze({ generation: first.generation });
  assert.equal(closure.succeed(forged, 'reused', 'forged').reason, 'stale_generation');
  const second = closure.begin([{ id: 'reused', name: 'new' }]);
  assert.equal(closure.succeed(first.handle, 'reused', 'old late').reason, 'stale_generation');
  assert.equal(closure.succeed(second.handle, 'reused', 'new result').accepted, true);
});

test('reports late success and late rejection without replacing synthetic timeout', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'slow', name: 'slow_tool' }]);
  const closed = closure.close(handle, {
    status: 'cancelled', code: 'timeout', message: 'Timed out.', sideEffectState: 'unknown',
  });
  assert.equal(closure.succeed(handle, 'slow', 'eventual value').observedStatus, 'success');
  assert.equal(closure.fail(handle, 'slow', new Error('eventual rejection')).observedStatus, 'error');
  assert.deepEqual(closure.snapshot().calls[0].settlement, closed.calls[0].settlement);
  assert.deepEqual(closure.close(handle), closure.snapshot());
});

test('invalid replacement input does not supersede the active generation', () => {
  const closure = new ToolCallClosure({ maxCalls: 2 });
  const active = closure.begin([{ id: 'live', name: 'tool' }]);
  assert.throws(() => closure.begin([{ id: 'x', name: 'a' }, { id: 'x', name: 'b' }]), /duplicate/);
  assert.equal(closure.succeed(active.handle, 'live', 'still accepted').accepted, true);
});

test('rejects incomplete streaming fragments as registrations', () => {
  const closure = new ToolCallClosure();
  assert.throws(() => closure.begin([{ name: 'partial_name_only' }]), /id/);
  assert.throws(() => closure.begin([{ id: 'partial_id_only' }]), /name/);
  assert.equal(closure.snapshot(), null);
});

test('rejects forged closed snapshots and snapshots from another closure', () => {
  const closure = new ToolCallClosure();
  const forged = Object.freeze({
    generation: 1,
    closed: true,
    closeReason: { status: 'complete' },
    calls: [{ id: 'done', name: 'x', state: 'success', settlement: { status: 'success', content: 'ok' } },
      { id: 'pending', name: 'y', state: 'pending', settlement: null }],
    diagnostics: [],
  });
  assert.throws(() => closure.toOpenAIResponses(forged), /ToolCallClosure snapshot/);

  const other = new ToolCallClosure();
  const { handle } = other.begin([]);
  assert.throws(() => closure.toOpenAIResponses(other.seal(handle)), /ToolCallClosure snapshot/);
});

test('bounds ids, names, codes, tiny messages, and invalid late statuses', () => {
  const closure = new ToolCallClosure({ maxIdBytes: 2, maxNameBytes: 2, maxCodeBytes: 2, maxMessageBytes: 1 });
  assert.throws(() => closure.begin([{ id: '123', name: 'x' }]), /byte limit/);
  assert.throws(() => closure.begin([{ id: 'x', name: '123' }]), /byte limit/);
  const { handle } = closure.begin([{ id: 'x', name: 'y' }]);
  assert.throws(() => closure.fail(handle, 'x', 'bad', '123'), /byte limit/);
  const closed = closure.close(handle, { code: 'zz', message: 'éé', sideEffectState: 'unknown' });
  assert.ok(Buffer.byteLength(closed.calls[0].settlement.message) <= 1);
  const invalid = closure.settle(handle, 'x', { status: 'arbitrarily-long-untrusted-status' });
  assert.equal(invalid.observedStatus, 'invalid');
});

test('does not retain oversized diagnostic ids or malformed forged generations', () => {
  const closure = new ToolCallClosure({ maxIdBytes: 2 });
  const { handle } = closure.begin([]);
  assert.throws(() => closure.succeed(handle, 'oversized', 'x'), /byte limit/);
  assert.equal(closure.snapshot().diagnostics.length, 0);

  const malformed = Object.freeze({ generation: { self: null } });
  malformed.generation.self = malformed.generation;
  const rejected = closure.close(malformed);
  assert.equal(rejected.reason, 'stale_generation');
  assert.equal(rejected.generation, null);
});

test('preserves closure when success serialization closes the batch reentrantly', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  let first;
  const result = closure.succeed(handle, 'a', { toJSON() {
    first = closure.close(handle, { code: 'timeout' });
    return 'late';
  } });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'run_closed');
  assert.deepEqual(closure.snapshot().calls, first.calls);
  assert.deepEqual(closure.toOpenAIResponses(), closure.toOpenAIResponses(first));
});

test('preserves the first settlement when a toJSON callback settles the same call', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  const result = closure.succeed(handle, 'a', { toJSON() {
    assert.equal(closure.succeed(handle, 'a', 'first').accepted, true);
    return 'second';
  } });
  assert.equal(result.reason, 'duplicate_settlement');
  assert.equal(closure.snapshot().calls[0].settlement.content, 'first');
});

test('rejects a success serialized after its generation is superseded', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'old' }]);
  let next;
  const result = closure.succeed(handle, 'a', { toJSON() {
    next = closure.begin([{ id: 'a', name: 'new' }]);
    return 'old';
  } });
  assert.equal(result.reason, 'stale_generation');
  assert.equal(next.superseded.calls[0].state, 'cancelled');
  assert.equal(closure.snapshot().calls[0].state, 'pending');
});

test('outcome getters and message conversion cannot overwrite a terminal write', () => {
  for (const field of ['status', 'content', 'code', 'message']) {
    const closure = new ToolCallClosure();
    const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
    const outcome = field === 'content' ? { status: 'success' } : { status: 'error', code: 'outer', message: 'outer' };
    const value = field === 'status' ? 'error' : field === 'content' ? 'outer' : 'outer';
    Object.defineProperty(outcome, field, { get() {
      closure.succeed(handle, 'a', 'first');
      return value;
    } });
    const result = closure.settle(handle, 'a', outcome);
    assert.equal(result.reason, 'duplicate_settlement', field);
    assert.equal(closure.snapshot().calls[0].settlement.content, 'first', field);
  }
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  const result = closure.cancel(handle, 'a', { toString() {
    closure.close(handle);
    return 'outer';
  } });
  assert.equal(result.reason, 'run_closed');
  assert.equal(closure.snapshot().calls[0].settlement.provenance, 'synthetic');
});

test('failure message getters and conversion preserve nested closure', () => {
  for (const useError of [false, true]) {
    const closure = new ToolCallClosure();
    const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
    const close = () => { closure.close(handle); return 'outer'; };
    const error = useError ? Object.defineProperty(new Error(), 'message', { get: close }) : { toString: close };
    assert.equal(closure.fail(handle, 'a', error).reason, 'run_closed');
    assert.equal(closure.snapshot().calls[0].settlement.provenance, 'synthetic');
  }
});

test('nested closure wins over every getter in an outer close reason', () => {
  for (const field of ['status', 'code', 'sideEffectState', 'message']) {
    const closure = new ToolCallClosure();
    const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
    let first;
    const reason = { status: 'error', code: 'outer', sideEffectState: 'not_started', message: 'outer' };
    const value = reason[field];
    Object.defineProperty(reason, field, { get() {
      first = closure.close(handle, { code: 'first' });
      return value;
    } });
    const result = closure.close(handle, reason);
    assert.deepEqual(result.calls, first.calls, field);
    assert.equal(result.closeReason.code, 'first', field);
  }
});

test('close message conversion cannot close a newer generation', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'old' }]);
  const result = closure.close(handle, { message: { toString() {
    closure.begin([{ id: 'b', name: 'new' }]);
    return 'old';
  } } });
  assert.equal(result.reason, 'stale_generation');
  assert.equal(closure.snapshot().closed, false);
  assert.equal(closure.snapshot().calls[0].state, 'pending');
});

test('nested settlement and seal survive outer close normalization', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  const result = closure.close(handle, { get message() {
    closure.succeed(handle, 'a', 'first');
    closure.seal(handle);
    return 'outer';
  } });
  assert.equal(result.closeReason.status, 'complete');
  assert.equal(result.calls[0].settlement.content, 'first');
});

test('reentrant begin preserves the newer generation created by an input getter', () => {
  for (const field of ['id', 'name']) {
    const closure = new ToolCallClosure();
    closure.begin([{ id: 'old', name: 'old' }]);
    const call = { id: 'outer', name: 'outer' };
    Object.defineProperty(call, field, { get() {
      closure.begin([{ id: 'new', name: 'new' }]);
      return 'outer';
    } });
    assert.throws(() => closure.begin([call]), /generation changed/);
    assert.equal(closure.snapshot().calls[0].id, 'new');
    assert.equal(closure.snapshot().calls[0].state, 'pending');
  }
});

test('validates sparse arrays before superseding the active generation', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  assert.throws(() => closure.begin(new Array(1)), /must be an object/);
  assert.equal(closure.activeGeneration, handle.generation);
  assert.equal(closure.snapshot().closed, false);
  assert.equal(closure.succeed(handle, 'a', 'still active').accepted, true);
});

test('fixed default codes remain usable below maxCodeBytes', () => {
  const closure = new ToolCallClosure({ maxCodeBytes: 1 });
  const first = closure.begin([{ id: 'a', name: 'x' }]);
  const next = closure.begin([{ id: 'b', name: 'x' }, { id: 'c', name: 'x' }, { id: 'd', name: 'x' }, { id: 'e', name: 'x' }]);
  assert.equal(next.superseded.calls[0].settlement.code, 'superseded');
  assert.equal(closure.succeed(first.handle, 'a', 'old').reason, 'stale_generation');
  assert.equal(closure.fail(next.handle, 'b', 'failure').settlement.code, 'tool_error');
  assert.equal(closure.cancel(next.handle, 'c').settlement.code, 'cancelled');
  assert.equal(closure.settle(next.handle, 'd', { status: 'error' }).settlement.code, 'error');
  assert.equal(closure.close(next.handle).calls[3].settlement.code, 'cancelled');
});

test('explicit codes including built-in strings still honor maxCodeBytes', () => {
  const closure = new ToolCallClosure({ maxCodeBytes: 1 });
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  assert.throws(() => closure.fail(handle, 'a', 'failure', 'tool_error'), /byte limit/);
  assert.throws(() => closure.cancel(handle, 'a', 'cancel', 'cancelled'), /byte limit/);
  assert.throws(() => closure.settle(handle, 'a', { status: 'error', code: 'error' }), /byte limit/);
  assert.throws(() => closure.close(handle, { code: 'superseded' }), /byte limit/);
  assert.equal(closure.snapshot().calls[0].state, 'pending');
  assert.equal(closure.fail(handle, 'a', 'failure', 'x').settlement.code, 'x');
});

test('rejects forged snapshot objects without invoking their getters', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  let reads = 0;
  const forged = { get calls() { reads += 1; closure.close(handle); return []; } };
  assert.throws(() => closure.toOpenAIResponses(forged), /ToolCallClosure snapshot/);
  assert.equal(reads, 0);
  assert.equal(closure.snapshot().closed, false);
});

test('reentrant array access cannot replace a newer generation', () => {
  for (const property of ['length', '0']) {
    const closure = new ToolCallClosure();
    closure.begin([{ id: 'old', name: 'old' }]);
    let invoked = false;
    const calls = new Proxy([{ id: 'outer', name: 'outer' }], { get(target, key) {
      if (key === property && !invoked) {
        invoked = true;
        closure.begin([{ id: 'new', name: 'new' }]);
      }
      return Reflect.get(target, key);
    } });
    assert.throws(() => closure.begin(calls), /generation changed/);
    assert.equal(closure.snapshot().calls[0].id, 'new');
  }
});

test('a throwing serializer cannot undo its nested terminal write', () => {
  const closure = new ToolCallClosure();
  const { handle } = closure.begin([{ id: 'a', name: 'x' }]);
  assert.throws(() => closure.succeed(handle, 'a', { toJSON() {
    closure.close(handle, { code: 'first' });
    throw new Error('serialization failed');
  } }), /serialization failed/);
  assert.equal(closure.snapshot().calls[0].settlement.code, 'first');
  assert.equal(closure.snapshot().closed, true);
});
