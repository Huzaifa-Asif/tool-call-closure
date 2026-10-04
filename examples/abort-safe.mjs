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

console.log(closure.toOpenAIResponses(snapshot));
