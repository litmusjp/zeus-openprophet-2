export function formatSlackNotification(text, accountLabel) {
  const label = String(accountLabel || 'OpenProphet').trim() || 'OpenProphet';
  return `[${label}] ${String(text ?? '')}`;
}
