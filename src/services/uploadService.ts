type ApiResponse<T> = {
  success?: boolean;
  data?: T;
  message?: string;
  error?: string;
};

type UploadResult = {
  url: string;
  filename: string;
  size?: number;
  mimetype?: string;
  original_filename?: string;
};

const API_BASE = '/data-api';

const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

function toPathname(urlOrPath: string): string {
  const raw = String(urlOrPath || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;
  try {
    const u = new URL(raw);
    return u.pathname || raw;
  } catch {
    return raw;
  }
}

export async function uploadExpenseReceipt(file: File): Promise<{ url: string; path: string; filename: string }> {
  const form = new FormData();
  form.append('file', file);

  const url = new URL(`${window.location.origin}${API_BASE}/upload`);
  url.searchParams.set('subdir', 'expense-receipts');
  url.searchParams.set('webp', 'true');

  const res = await fetch(url.toString(), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as ApiResponse<UploadResult>;
  if (!res.ok || !json.success || !json.data?.url) {
    throw new Error(json.error || 'Failed to upload receipt');
  }

  const fullUrl = String(json.data.url);
  const path = toPathname(fullUrl);
  return { url: fullUrl, path, filename: String(json.data.filename || '') };
}

