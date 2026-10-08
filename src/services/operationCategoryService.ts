// ---- Types ----

export interface OperationCategory {
  id: string;
  branchId: string | null;
  name: string;
  description: string | null;
  state: number; // 1=inventory, 0=expense
  active: boolean;
}

// ---- API internals ----

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

type OperationCategoryApiRecord = {
  IDNo: number;
  BRANCH_ID: number | null;
  NAME: string;
  DESCRIPTION: string | null;
  STATE: number | null;
  ACTIVE: number | boolean;
};

const API_BASE = '/data-api';

const buildUrl = (path: string, params?: Record<string, string>) => {
  const url = new URL(`${window.location.origin}${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
  }
  return url.toString();
};

const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const handleResponse = async <T,>(response: Response): Promise<T> => {
  const json = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
};

const mapOperationCategory = (row: OperationCategoryApiRecord): OperationCategory => ({
  id: String(row.IDNo),
  branchId: row.BRANCH_ID != null ? String(row.BRANCH_ID) : null,
  name: row.NAME,
  description: row.DESCRIPTION,
  state: row.STATE === 1 ? 1 : 0,
  active: Boolean(row.ACTIVE),
});

// ---- Public API ----

export const getOperationCategories = async (branchId?: string | null): Promise<OperationCategory[]> => {
  const params: Record<string, string> = {
    branch_id: branchId && branchId !== 'all' ? String(branchId) : '',
  };

  const response = await fetch(buildUrl('/operation-category', params), {
    credentials: 'include',
    headers: authHeaders(),
  });

  const rows = await handleResponse<OperationCategoryApiRecord[]>(response);
  return rows.map(mapOperationCategory);
};

export type CreateOperationCategoryPayload = {
  branchId?: string | null;
  name: string;
  description?: string | null;
  state?: number; // 1=inventory, 0=expense
  active?: boolean;
};

export const createOperationCategory = async (
  payload: CreateOperationCategoryPayload,
): Promise<number> => {
  const response = await fetch(buildUrl('/operation-category'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      BRANCH_ID: payload.branchId ?? null,
      NAME: payload.name,
      DESCRIPTION: payload.description ?? null,
      STATE: payload.state === 1 ? 1 : 0,
      ACTIVE: payload.active ?? true,
    }),
  });

  const json = (await response.json()) as ApiResponse<{ id: number }>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to create operation category');
  }

  return json.data?.id ?? 0;
};

export type UpdateOperationCategoryPayload = {
  name: string;
  description?: string | null;
  state?: number; // 1=inventory, 0=expense
};

export const updateOperationCategory = async (
  id: string,
  payload: UpdateOperationCategoryPayload,
): Promise<void> => {
  const response = await fetch(buildUrl(`/operation-category/${id}`), {
    method: 'PUT',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      NAME: payload.name,
      DESCRIPTION: payload.description ?? null,
      STATE: payload.state === 1 ? 1 : 0,
    }),
  });

  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update operation category');
  }
};

export const deleteOperationCategory = async (id: string): Promise<void> => {
  const response = await fetch(buildUrl(`/operation-category/${id}`), {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });

  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to delete operation category');
  }
};

