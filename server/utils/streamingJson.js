function extractPartialJsonStringField(raw, field) {
  const haystack = String(raw || '');
  const key = `"${field}"`;
  const keyIdx = haystack.indexOf(key);
  if (keyIdx === -1) return '';

  let i = keyIdx + key.length;
  while (i < haystack.length && /[\s:]/.test(haystack[i])) i += 1;
  if (haystack[i] !== '"') return '';
  i += 1;

  let result = '';
  while (i < haystack.length) {
    const ch = haystack[i];
    if (ch === '\\') {
      if (i + 1 >= haystack.length) break;
      const esc = haystack[i + 1];
      if (esc === 'n') result += '\n';
      else if (esc === 't') result += '\t';
      else if (esc === 'r') result += '\r';
      else if (esc === '"') result += '"';
      else if (esc === '\\') result += '\\';
      else result += esc;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    result += ch;
    i += 1;
  }
  return result;
}

function extractChatStreamDelta(accumulated) {
  return {
    mode: 'chat',
    summary: extractPartialJsonStringField(accumulated, 'summary'),
  };
}

function extractBriefStreamDelta(accumulated) {
  return {
    mode: 'management_brief',
    executive_summary: extractPartialJsonStringField(accumulated, 'executive_summary'),
    sales_analysis: extractPartialJsonStringField(accumulated, 'sales_analysis'),
    expense_analysis: extractPartialJsonStringField(accumulated, 'expense_analysis'),
  };
}

function sendStreamDeltaIfChanged(send, mode, accumulated, lastDeltaRef) {
  const delta = mode === 'management_brief'
    ? extractBriefStreamDelta(accumulated)
    : extractChatStreamDelta(accumulated);
  const key = JSON.stringify(delta);
  if (key === lastDeltaRef.value) return;
  lastDeltaRef.value = key;
  send('delta', delta);
}

module.exports = {
  extractPartialJsonStringField,
  extractChatStreamDelta,
  extractBriefStreamDelta,
  sendStreamDeltaIfChanged,
};
