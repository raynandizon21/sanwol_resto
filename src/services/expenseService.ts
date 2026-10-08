// ---- Types ----

export interface ExpenseRecord {
  id: string;
  branchId: string;
  branchName: string | null;
  masterCatId: string | null;
  expCat: string;
  expName: string;
  expDesc: string | null;
  expAmount: number;
  expQty?: number | null;
  expSource: string | null;
  receiptImagePath?: string | null;
  encodedBy: string | null;
  encodedDt: string | null;
  active: boolean;
  stockQty?: number;
  inventoryId?: string | null;
  unit?: string | null;
  opCatState?: number;
}

// ---- API internals ----

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

type ExpenseApiRecord = {
  IDNo: number;
  BRANCH_ID: number;
  BRANCH_NAME?: string | null;
  MASTER_CAT_ID?: number | null;
  EXP_CAT: string;
  EXP_NAME: string;
  EXP_DESC?: string | null;
  EXP_AMOUNT: number | string;
  EXP_SOURCE?: string | null;
  RECEIPT_IMAGE_PATH?: string | null;
  ACTIVE: number | boolean;
  ENCODED_BY?: string | null;
  ENCODED_DT?: string | null;
  INVENTORY_ID?: number | null;
  STOCK_QTY?: number | string;
  EXP_QTY?: number | string | null;
  UNIT?: string;
  OP_CAT_STATE?: number;
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

const mapExpense = (row: ExpenseApiRecord): ExpenseRecord => ({
  id: String(row.IDNo),
  branchId: String(row.BRANCH_ID),
  branchName: row.BRANCH_NAME ?? null,
  masterCatId: row.MASTER_CAT_ID !== undefined && row.MASTER_CAT_ID !== null ? String(row.MASTER_CAT_ID) : null,
  expCat: row.EXP_CAT,
  expName: row.EXP_NAME,
  expDesc: row.EXP_DESC ?? null,
  expAmount: typeof row.EXP_AMOUNT === 'string' ? Number(row.EXP_AMOUNT) : Number(row.EXP_AMOUNT || 0),
  expQty: row.EXP_QTY != null && row.EXP_QTY !== '' ? (typeof row.EXP_QTY === 'string' ? Number(row.EXP_QTY) : Number(row.EXP_QTY)) : null,
  expSource: row.EXP_SOURCE ?? null,
  receiptImagePath: row.RECEIPT_IMAGE_PATH ?? null,
  encodedBy: row.ENCODED_BY ?? null,
  encodedDt: row.ENCODED_DT ?? null,
  active: Boolean(row.ACTIVE),
  stockQty: typeof row.STOCK_QTY === 'string' ? Number(row.STOCK_QTY) : Number(row.STOCK_QTY ?? 0),
  inventoryId: row.INVENTORY_ID != null ? String(row.INVENTORY_ID) : null,
  unit: row.UNIT != null && String(row.UNIT).trim() !== '' ? String(row.UNIT).trim() : null,
  opCatState: row.OP_CAT_STATE,
});

// ---- Public API ----

export const getExpenses = async (
  branchId?: string,
  options: { startDate?: string; endDate?: string } = {},
): Promise<ExpenseRecord[]> => {
  const params: Record<string, string> = {
    branch_id: branchId && branchId !== 'all' ? branchId : '',
  };
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;
  const response = await fetch(buildUrl('/expenses', params), {
    credentials: 'include',
    headers: authHeaders(),
  });
  const rows = await handleResponse<ExpenseApiRecord[]>(response);
  return rows.map(mapExpense);
};

export type CreateExpensePayload = {
  branchId: string;
  masterCatId: string;
  expDesc: string | null;
  expAmount: number;
  expQty?: number | null;
  expSource: string | null;
  unit?: string | null;
  receiptImagePath?: string | null;
  // MySQL DATETIME/TIMESTAMP format: "YYYY-MM-DD HH:mm:ss"
  encodedDt?: string | null;
};

export async function createExpense(payload: CreateExpensePayload): Promise<number> {
  const response = await fetch(buildUrl('/expenses'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      BRANCH_ID: payload.branchId,
      MASTER_CAT_ID: payload.masterCatId,
      EXP_DESC: payload.expDesc,
      EXP_AMOUNT: payload.expAmount,
      EXP_QTY: payload.expQty ?? null,
      EXP_SOURCE: payload.expSource,
      UNIT: payload.unit != null && String(payload.unit).trim() !== '' ? String(payload.unit).trim() : null,
      RECEIPT_IMAGE_PATH: payload.receiptImagePath ?? null,
      ENCODED_DT: payload.encodedDt ?? null,
    }),
  });
  const json = (await response.json()) as ApiResponse<{ id: number }>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to create expense');
  }
  return json.data?.id ?? 0;
}

export type UpdateExpensePayload = {
  masterCatId: string;
  expDesc: string | null;
  expAmount: number;
  expQty?: number | null;
  expSource: string | null;
  unit?: string | null;
  receiptImagePath?: string | null;
  encodedDt?: string | null;
};

export async function updateExpense(id: string, payload: UpdateExpensePayload): Promise<void> {
  const response = await fetch(buildUrl(`/expenses/${id}`), {
    method: 'PUT',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      MASTER_CAT_ID: payload.masterCatId,
      EXP_DESC: payload.expDesc,
      EXP_AMOUNT: payload.expAmount,
      EXP_QTY: payload.expQty ?? null,
      EXP_SOURCE: payload.expSource,
      UNIT: payload.unit != null && String(payload.unit).trim() !== '' ? String(payload.unit).trim() : null,
      ...(payload.receiptImagePath !== undefined ? { RECEIPT_IMAGE_PATH: payload.receiptImagePath } : {}),
      ...(payload.encodedDt !== undefined ? { ENCODED_DT: payload.encodedDt } : {}),
    }),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update expense');
  }
}

export async function deleteExpense(id: string): Promise<void> {
  const response = await fetch(buildUrl(`/expenses/${id}`), {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to delete expense');
  }
}

export async function updateInventoryStock(
  expenseId: string,
  stockQty: number,
  branchId?: string,
  addToExisting = false,
  unit?: string | null
): Promise<void> {
  const body: Record<string, unknown> = { stockQty, branch_id: branchId, addToExisting };
  if (unit) body.unit = unit;
  const response = await fetch(buildUrl(`/inventory/items/by-expense/${expenseId}`), {
    method: 'PATCH',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update inventory stock');
  }
}

