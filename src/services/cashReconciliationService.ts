type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

export type CashReconciliationRow = {
  IDNo: number;
  BRANCH_ID: number;
  BRANCH_NAME?: string | null;
  BUSINESS_DATE: string;
  AMOUNT: number | string;
  ACTIVE: number;
  ENCODED_DT?: string | null;
  ENCODED_BY?: number | null;
  EDITED_DT?: string | null;
  EDITED_BY?: number | null;
};

const API_BASE = '/data-api';

const buildUrl = (path: string, params?: Record<string, string>) => {
  const url = new URL(`${window.location.origin}${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
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

export type CashReconciliationAggregates = {
  total: number;
  byDate: Record<string, number>;
};

/** Sum and per-day amounts for merging into net sales (branch optional = all branches). */
export async function fetchCashReconciliationAggregates(params: {
  start: string;
  end: string;
  /** Omit or empty for all branches */
  branchId?: string;
}): Promise<CashReconciliationAggregates> {
  const q: Record<string, string> = {
    start_date: params.start,
    end_date: params.end,
  };
  if (params.branchId && params.branchId !== 'all') {
    q.branch_id = params.branchId;
  }
  const response = await fetch(buildUrl('/cash-reconciliation/aggregates', q), {
    credentials: 'include',
    headers: authHeaders(),
  });
  const data = await handleResponse<CashReconciliationAggregates>(response);
  return {
    total: Number(data.total) || 0,
    byDate: data.byDate && typeof data.byDate === 'object' ? data.byDate : {},
  };
}

export async function fetchCashReconciliation(
  branchId: string,
  dateRange: { start: string; end: string }
): Promise<CashReconciliationRow[]> {
  const response = await fetch(
    buildUrl('/cash-reconciliation', {
      branch_id: branchId,
      start_date: dateRange.start,
      end_date: dateRange.end,
    }),
    { credentials: 'include', headers: authHeaders() }
  );
  return handleResponse<CashReconciliationRow[]>(response);
}

export async function createCashReconciliation(payload: {
  branchId: string;
  businessDate: string;
  amount: number;
}): Promise<number> {
  const response = await fetch(buildUrl('/cash-reconciliation'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      BRANCH_ID: payload.branchId,
      BUSINESS_DATE: payload.businessDate,
      AMOUNT: payload.amount,
    }),
  });
  const json = (await response.json()) as ApiResponse<{ id: number }>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to create');
  }
  return json.data?.id ?? 0;
}

export async function updateCashReconciliation(
  id: number,
  payload: { branchId: string; businessDate: string; amount: number }
): Promise<void> {
  const response = await fetch(
    buildUrl(`/cash-reconciliation/${id}`, { branch_id: payload.branchId }),
    {
      method: 'PUT',
      credentials: 'include',
      headers: authHeaders(),
      body: JSON.stringify({
        BRANCH_ID: payload.branchId,
        BUSINESS_DATE: payload.businessDate,
        AMOUNT: payload.amount,
      }),
    }
  );
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update');
  }
}

export async function deleteCashReconciliation(id: number, branchId: string): Promise<void> {
  const response = await fetch(buildUrl(`/cash-reconciliation/${id}`, { branch_id: branchId }), {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to delete');
  }
}
