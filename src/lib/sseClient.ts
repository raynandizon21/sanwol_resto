export type SseEventHandler = (event: string, data: unknown) => void;

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export async function readSseResponse(
  response: Response,
  onEvent: SseEventHandler,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response has no body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  const flushBlocks = () => {
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt !== -1) {
      const block = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseSseBlock(block);
      if (parsed) {
        try {
          onEvent(parsed.event, JSON.parse(parsed.data));
        } catch {
          onEvent(parsed.event, parsed.data);
        }
      }
      splitAt = buffer.indexOf('\n\n');
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flushBlocks();
    }
    flushBlocks();
  } finally {
    reader.releaseLock();
  }
}
