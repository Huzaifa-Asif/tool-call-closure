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
