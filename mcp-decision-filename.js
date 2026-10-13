export function safeDecisionFilenameComponent(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}
