export function shouldShowGoLogLine(line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '');
  if (/\[GIN-debug\]/.test(clean)) return false;
  if (/level=info\s+msg="(?:Fetching|Fetched) historical bars"/.test(clean)) return false;
  if (/level=info\s+msg="(?:Reconcile: order not confirmed at broker, leaving as-is|Reconcile: startup order reconciliation complete|Startup order reconciliation complete)"/.test(clean)) return false;
  const accessLog = clean.match(
    /\[GIN\]\s+\d{4}\/\d{2}\/\d{2}\s+-\s+.*?\|\s*(\d{3})\s*\|.*?\|\s*[A-Z]+\s+"/,
  );
  return !accessLog || Number(accessLog[1]) >= 400;
}

export function createGoLogLineBuffer(onLine) {
  let remainder = '';
  const emit = line => {
    const message = line.trim();
    if (message) onLine(message);
  };
  return {
    push(chunk) {
      const lines = (remainder + chunk.toString()).split('\n');
      remainder = lines.pop() || '';
      for (const line of lines) emit(line);
    },
    flush() {
      emit(remainder);
      remainder = '';
    },
  };
}
