const SECRET_KEY_RE = /(secret|token|password|passwd|webhook|credential|privatekey|api[_-]?key|publickey)/i;

export function redactSecrets(value, maskAlphaDeskApiKey = false) {
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, maskAlphaDeskApiKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const isAlphaDesk = maskAlphaDeskApiKey || key.toLowerCase() === 'alphadesk';
      if (typeof item === 'string' && item && SECRET_KEY_RE.test(key)) {
        out[key] = isAlphaDesk && key.toLowerCase() === 'apikey'
          ? '****'
          : item.length > 4 ? '****' + item.slice(-4) : '****';
      } else {
        out[key] = redactSecrets(item, isAlphaDesk);
      }
    }
    return out;
  }
  return value;
}
