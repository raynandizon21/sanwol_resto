import type { AnalyticsAiChatResponse } from '../services/analyticsAiService';

export type PersistedChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  response?: AnalyticsAiChatResponse;
  error?: string;
};

const STORAGE_VERSION = 1;
const MAX_MESSAGES = 60;

export function buildAnalyticsAiSessionKey(userId: string, start: string, end: string) {
  return `resto-analytics-ai:v${STORAGE_VERSION}:${userId}:${start}:${end}`;
}

export function loadAnalyticsAiSession(key: string): PersistedChatMessage[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { messages?: PersistedChatMessage[] };
    if (!Array.isArray(parsed.messages)) return null;
    return parsed.messages.slice(-MAX_MESSAGES);
  } catch {
    return null;
  }
}

export function clearAnalyticsAiSession(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function saveAnalyticsAiSession(key: string, messages: PersistedChatMessage[]) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: STORAGE_VERSION,
        messages: messages.slice(-MAX_MESSAGES),
        savedAt: Date.now(),
      }),
    );
  } catch {
    try {
      const trimmed = messages.slice(-20);
      localStorage.setItem(
        key,
        JSON.stringify({ version: STORAGE_VERSION, messages: trimmed, savedAt: Date.now() }),
      );
    } catch {
      // ignore quota errors
    }
  }
}
