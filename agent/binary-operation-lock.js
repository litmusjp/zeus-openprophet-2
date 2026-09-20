let prophetBotBinaryOperationTail = Promise.resolve();

// Serialize every process-local operation that can inspect, build, or replace
// the shared prophet_bot binary. Failed operations do not poison the queue.
export function enqueueProphetBotBinaryOperation(operation) {
  const run = prophetBotBinaryOperationTail.then(operation);
  prophetBotBinaryOperationTail = run.catch(() => {});
  return run;
}
