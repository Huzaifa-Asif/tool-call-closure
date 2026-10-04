# tool-call-closure

`tool-call-closure` is a small, zero-dependency state machine for one awkward part of an AI agent loop: every announced tool call needs one terminal outcome, even when the run is aborted, times out, hits a limit, or is superseded.

It records calls in source order, accepts each real result once, creates explicit **error/cancelled** outcomes for calls still pending at closure, and rejects late results from old generations. It can format a completed batch for OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages.

> Development status: locally prepared and unpublished. The API may change before `1.0.0`.

## Why this exists

Provider protocols associate each tool result with a prior tool call. Incomplete lifecycles can make a later request invalid. This is especially easy to get wrong when an `AbortSignal`, deadline, concurrency race, or request replacement intersects a batch of tools.

This package is deliberately smaller than an agent runtime. It does not choose tools, execute them, own a transcript, retry providers, or cancel side effects. It only makes terminal accounting explicit and portable.

Existing alternatives are often the better choice:

- Vercel AI SDK already models tool states and can synthesize execution-denied results during UI-message conversion. Use it when your application already uses its message/runtime abstractions.
- `omk-agent-core` is a full agent runtime with timeouts, abort handling, synthetic terminal results, late-settlement audit events, ordering, scheduling, and transcript integrity checks. Use it when you want that complete runtime.
- `conversationalist` validates tool-call/result relationships and preserves pairs while trimming transcripts. Use it for transcript validation or token-budget work.
- `ai-sdk-heal` repairs AI SDK histories with missing placeholders and deduplication. Use it when repairing stored AI SDK message history; this package rejects invalid runtime transitions rather than rewriting a history.
- Generic promise settlers such as `p-settle` settle promises, but do not track provider call IDs or emit provider payloads.

The narrow gap here is a standalone, runtime-independent primitive with no runtime dependencies. The underlying mechanism is established practice, not a novelty claim.

## Install

```sh
npm install tool-call-closure
```

Node.js 18 or newer is required. Both ESM and CommonJS are exported.

## Quick start

```js
import { createToolCallClosure } from 'tool-call-closure';

const closure = createToolCallClosure();
const { handle } = closure.begin([
  { id: 'call_weather', name: 'get_weather' },
  { id: 'call_calendar', name: 'get_calendar' },
]);

closure.succeed(handle, 'call_weather', { temperatureC: 24 });

const snapshot = closure.close(handle, {
  status: 'cancelled',
  code: 'request_aborted',
  message: 'The caller disconnected before this tool completed.',
  sideEffectState: 'unknown',
});

const input = closure.toOpenAIResponses(snapshot);
```

The calendar result is synthetic, visibly cancelled, and tagged with `provenance: "synthetic"` in the snapshot. A later real result is rejected; it never replaces the committed terminal outcome.

## API

### `createToolCallClosure(options?)`

Returns a `ToolCallClosure`. The class constructor accepts the same options.

| Option | Default | Purpose |
| --- | ---: | --- |
| `maxCalls` | `1000` | Maximum calls in one generation |
| `maxDiagnostics` | `100` | Maximum rejected-operation diagnostics retained |
| `maxResultBytes` | `1048576` | Maximum UTF-8 bytes in a reported success result |
| `maxMessageBytes` | `4096` | Maximum UTF-8 bytes in error/cancellation messages |
| `maxIdBytes` | `512` | Maximum UTF-8 bytes in a tool-call ID |
| `maxNameBytes` | `512` | Maximum UTF-8 bytes in a tool name |
| `maxCodeBytes` | `128` | Maximum UTF-8 bytes in an error/cancellation code |

All limits must be positive safe integers.

### `begin(calls)`

Validates `{ id, name }` entries, rejects duplicate IDs, and starts a generation. Starting another generation closes pending calls in the old one as `superseded` and returns that prior snapshot as `superseded`.

```js
const { generation, handle, superseded } = closure.begin(calls);
```

Invalid new input is validated before the current generation is superseded.

`handle` is an immutable, identity-checked batch handle. Keep it with the promises launched for that batch. A copied `{ generation }` object is not accepted.

Only register complete, committed, ordinary client-side function calls. Do not register streaming call fragments, approval pauses, or provider-hosted tools.

### `settle(handle, callId, outcome)`

Accepts exactly one terminal outcome:

```js
closure.settle(handle, 'call_1', { status: 'success', content: { ok: true } });
closure.settle(handle, 'call_2', { status: 'error', code: 'upstream', message: 'Unavailable' });
closure.settle(handle, 'call_3', { status: 'cancelled', code: 'abort', message: 'Stopped' });
```

`succeed`, `fail`, and `cancel` are convenience methods. Results return `{ accepted: true, ... }` or `{ accepted: false, reason, ... }`; expected races do not throw. Rejection reasons are `stale_generation`, `run_closed`, `unknown_call`, and `duplicate_settlement`.

Success objects are JSON-stringified at settlement. Circular, undefined, or oversized values throw without changing call state. `fail(Error)` retains the message only, never the stack.

### `close(handle, reason?)`

Commits an `error` or `cancelled` synthetic result for every still-pending call and freezes the run. Already reported outcomes are preserved.

```js
const snapshot = closure.close(handle, {
  status: 'error',
  code: 'tool_limit',
  message: 'This run reached its tool-call limit.',
  sideEffectState: 'not_started',
});
```

`sideEffectState` is required by the semantics even though it defaults conservatively to `unknown`. Use `not_started` only when the host knows execution never began. A synthetic result never proves that an operation stopped, rolled back, or is safe to retry.

Closing is idempotent. It does **not** abort tool processes, network requests, or side effects. Wire your own `AbortSignal` into executors. If a real promise later settles or rejects, call `settle`; the typed `run_closed`/`stale_generation` result records its observed status and is the audit signal. This package does not silently promote that late value into the transcript.

### `seal(handle)`

Marks an all-reported batch complete without creating synthetic outcomes. It returns `pending_calls` if any call remains pending. Provider adapters refuse an open snapshot, so partial output is never labelled provider-ready.

### `snapshot()`

Returns an immutable detached view. Calls remain in announcement order. Each settlement carries `provenance: "reported" | "synthetic"`.

### Provider adapters

```js
closure.toOpenAIChatCompletions(snapshot); // role: "tool", tool_call_id, content
closure.toOpenAIResponses(snapshot);       // type: "function_call_output", call_id, output
closure.toAnthropicToolResults(snapshot);  // type: "tool_result", tool_use_id, content, is_error
```

Adapters require a sealed/closed snapshot and preserve announcement order. Repeated export is a pure read; it does not mean the caller should append the same results twice. Adapters do not validate a whole transcript.

For Anthropic, the caller must place the returned blocks in the user message immediately after the assistant message containing the corresponding `tool_use` blocks, with tool results before other user content. A payload-only utility cannot guarantee adjacency.

For OpenAI, choose the adapter matching the API you call; Chat Completions and Responses use different shapes.

## Common patterns

### Timeout

```js
const timer = setTimeout(() => {
  controller.abort();
  closure.close(handle, {
    status: 'cancelled', code: 'timeout', message: 'Tool deadline elapsed.',
  });
}, 10_000);
```

### Replacement request

Call `begin` with the new batch. The old generation is closed as `superseded`. Keep its immutable handle next to each promise and pass it to `settle`; old promises are then rejected deterministically. The returned supersession snapshot belongs to the old branch only.

### Tool-call limit

Do not invent a success. Close pending calls with an explicit error code, pass those results to the model if your application will continue, and let the model explain the limitation.

## Limits and non-goals

- No tool execution, cancellation, retry, scheduling, persistence, or side-effect rollback.
- No complete transcript validation or repair.
- No crash durability or distributed exactly-once guarantee; state exists only in one process.
- No guarantee that a provider accepts a request; callers own surrounding message order and API-version requirements.
- Results are retained in memory until a new generation replaces them; use the byte/count limits for untrusted tools.
- JSON serialization is ordinary `JSON.stringify`, not canonical JSON.
- Only text provider payloads are emitted; multimodal tool outputs need an SDK-specific adapter.
- Synthetic outcomes describe orchestration state, not what happened inside a late or non-cooperative tool.
- The host owns assistant messages, reasoning metadata, approval state, and provider-hosted tool state.

## Research basis

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) distinguishes call IDs and function-call outputs.
- [Anthropic parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) documents result ordering and placement.
- [AI SDK missing tool results](https://ai-sdk.dev/docs/troubleshooting/missing-tool-results-error) documents the complete-result requirement.
- [LangChainJS #8570](https://github.com/langchain-ai/langchainjs/issues/8570) is a reported abort/missing-result failure mode; it was closed after maintainers could not reproduce it, so it is not presented as a verified outstanding defect.

LangChainJS #10090 was reviewed and intentionally excluded as supporting evidence: it already has a matching error result and concerns router continuation, which this package does not address.

## Troubleshooting

**`stale_generation`** — A newer `begin` replaced the run. Record the late result externally if needed; it was intentionally not committed.

**`run_closed`** — The generation already has terminal results. Do not send a second result for that ID.

**`unknown_call`** — The result ID was never announced in this generation. Check whether you used a provider item ID instead of its call ID.

**Provider reports a missing result** — Confirm every provider call was included in `begin`, close the batch, use the adapter for the correct OpenAI API, and place the payload in the required message position.

**A result exceeds `maxResultBytes`** — Store large output elsewhere and settle with a bounded summary or reference.

## Security

Treat tool output as untrusted data. This package serializes it but does not sanitize prompt injection, HTML, commands, or secrets. Synthetic error content contains only the code/message you provide. Avoid putting credentials or raw internal errors in those fields.

See [SECURITY.md](SECURITY.md) for reporting instructions.

## Development

```sh
npm test
npm run lint
npm run check
```

The test suite covers boundaries, fuzzed settlement order, generation races, immutability, exact provider shapes, limits, and content handling.

## License

MIT © Huzaifa Asif
