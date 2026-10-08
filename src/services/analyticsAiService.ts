export type AnalyticsAiChart = {
  type: 'bar' | 'line';
  title: string;
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
};

export type AnalyticsAiChatResponse = {
  mode?: 'chat' | 'management_brief';
  summary: string;
  bullets: string[];
  suggestedReplies: string[];
  charts: AnalyticsAiChart[];
  executive_summary?: string;
  sales_analysis?: string;
  expense_analysis?: string;
  recommendations?: string[];
  contextMeta?: {
    focus?: string;
    mode?: string;
    period?: { start: string; end: string };
    locale?: string;
    kpi?: Record<string, number>;
    comparisons?: Record<string, number>;
  };
};

export type ManagementBriefRequest = {
  start_date: string;
  end_date: string;
  locale?: string;
};

export type AnalyticsAiChatHistoryItem = {
  role: 'user' | 'assistant';
  content: string;
};

export type AnalyticsAiChatRequest = {
  message: string;
  start_date: string;
  end_date: string;
  locale?: string;
  history?: AnalyticsAiChatHistoryItem[];
};

export type AnalyticsAiStreamDelta =
  | { mode: 'chat'; summary?: string }
  | {
      mode: 'management_brief';
      executive_summary?: string;
      sales_analysis?: string;
      expense_analysis?: string;
    };

export type AnalyticsAiStreamHandlers = {
  onStatus?: (data: { phase: string }) => void;
  onMeta?: (data: { charts?: AnalyticsAiChart[]; focus?: string; mode?: string }) => void;
  onDelta?: (data: AnalyticsAiStreamDelta) => void;
  onDone?: (data: AnalyticsAiChatResponse) => void;
  onError?: (message: string) => void;
};

export type AnalyticsAiStreamDelta =
  | { mode: 'chat'; summary?: string }
  | {
      mode: 'management_brief';
      executive_summary?: string;
      sales_analysis?: string;
      expense_analysis?: string;
    };

export type AnalyticsAiStreamHandlers = {
  onStatus?: (data: { phase: string }) => void;
  onMeta?: (data: { charts?: AnalyticsAiChart[]; focus?: string; mode?: string }) => void;
  onDelta?: (data: AnalyticsAiStreamDelta) => void;
  onDone?: (data: AnalyticsAiChatResponse) => void;
  onError?: (message: string) => void;
};

export type AnalyticsAiStreamDelta =
  | { mode: 'chat'; summary?: string }
  | {
      mode: 'management_brief';
      executive_summary?: string;
      sales_analysis?: string;
      expense_analysis?: string;
    };

export type AnalyticsAiStreamHandlers = {
  onStatus?: (data: { phase: string }) => void;
  onMeta?: (data: { charts?: AnalyticsAiChart[]; focus?: string; mode?: string }) => void;
  onDelta?: (data: AnalyticsAiStreamDelta) => void;
  onDone?: (data: AnalyticsAiChatResponse) => void;
  onError?: (message: string) => void;
};

function getAuthHeaders(): Record<string, string> {
  try {
    const token = (localStorage.getItem('token') || '').trim();
    return token
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }
  catch {
    return { 'Content-Type': 'application/json' };
  }
}

export async function postAnalyticsAiChat(
  body: AnalyticsAiChatRequest,
  signal?: AbortSignal,
): Promise<AnalyticsAiChatResponse> {
  const res = await fetch('/api/analytics/ai-chat', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const msg =
      (typeof json?.error === 'string' && json.error) ||
      (typeof json?.message === 'string' && json.message) ||
      `AI request failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data as AnalyticsAiChatResponse;
}

export async function postManagementBrief(
  body: ManagementBriefRequest,
  signal?: AbortSignal,
): Promise<AnalyticsAiChatResponse> {
  const res = await fetch('/api/analytics/management-brief', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const msg =
      (typeof json?.error === 'string' && json.error) ||
      (typeof json?.message === 'string' && json.message) ||
      `Management brief failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data as AnalyticsAiChatResponse;
}

async function consumeAnalyticsAiSse(
  url: string,
  body: unknown,
  handlers: AnalyticsAiStreamHandlers,
  signal?: AbortSignal,
) {
  const { readSseResponse } = await import('../lib/sseClient');

  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok && !contentType.includes('text/event-stream')) {
    const json = await res.json().catch(() => null);
    const msg =
      (typeof json?.error === 'string' && json.error) ||
      (typeof json?.message === 'string' && json.message) ||
      `AI stream failed (${res.status})`;
    throw new Error(msg);
  }

  let streamError: string | null = null;
  let completed = false;

  await readSseResponse(
    res,
    (event, data) => {
      if (event === 'status') {
        handlers.onStatus?.(data as { phase: string });
        return;
      }
      if (event === 'meta') {
        handlers.onMeta?.(data as { charts?: AnalyticsAiChart[]; focus?: string; mode?: string });
        return;
      }
      if (event === 'delta') {
        handlers.onDelta?.(data as AnalyticsAiStreamDelta);
        return;
      }
      if (event === 'done') {
        const payload = data as { data?: AnalyticsAiChatResponse };
        if (payload?.data) {
          completed = true;
          handlers.onDone?.(payload.data);
        }
        return;
      }
      if (event === 'error') {
        const payload = data as { message?: string };
        streamError = payload?.message || 'Stream failed';
        handlers.onError?.(streamError);
      }
    },
    signal,
  );

  if (streamError) {
    throw new Error(streamError);
  }
  if (!completed && !signal?.aborted) {
    throw new Error('AI stream ended before completion');
  }
}

export async function streamAnalyticsAiChat(
  body: AnalyticsAiChatRequest,
  handlers: AnalyticsAiStreamHandlers,
  signal?: AbortSignal,
) {
  return consumeAnalyticsAiSse('/api/analytics/ai-chat/stream', body, handlers, signal);
}

export async function streamManagementBrief(
  body: ManagementBriefRequest,
  handlers: AnalyticsAiStreamHandlers,
  signal?: AbortSignal,
) {
  return consumeAnalyticsAiSse('/api/analytics/management-brief/stream', body, handlers, signal);
}
