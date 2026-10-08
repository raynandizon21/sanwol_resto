type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

type IngredientApiRecord = {
  IDNo: number;
  BRANCH_ID: number;
  NAME: string;
  MASTER_CAT_ID?: number | null;
  CATEGORY_ID?: number | null;
  CATEGORY_NAME?: string | null;
  UNIT: string;
  ACTIVE?: number | boolean;
  ENCODED_BY?: number | null;
  ENCODED_DT?: string | null;
  EDITED_BY?: number | null;
  EDITED_DT?: string | null;
};

export type Ingredient = {
  id: string;
  branchId: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  unit: string;
  active: boolean;
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

const handleResponse = async <T>(response: Response): Promise<T> => {
  const json = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Request failed');
  }
  return json.data;
};

const mapIngredient = (row: IngredientApiRecord): Ingredient => ({
  id: String(row.IDNo),
  branchId: String(row.BRANCH_ID),
  name: String(row.NAME || ''),
  categoryId: (row.MASTER_CAT_ID ?? row.CATEGORY_ID) != null ? String(row.MASTER_CAT_ID ?? row.CATEGORY_ID) : null,
  categoryName: row.CATEGORY_NAME ?? null,
  unit: String(row.UNIT || 'pcs'),
  active: Boolean(row.ACTIVE),
});

export async function getIngredients(branchId?: string, categoryId?: string | null): Promise<Ingredient[]> {
  const params: Record<string, string> = {
    branch_id: branchId && branchId !== 'all' ? branchId : '',
    category_id: categoryId && categoryId !== 'all' ? categoryId : '',
  };
  const response = await fetch(buildUrl('/ingredients', params), {
    credentials: 'include',
    headers: authHeaders(),
  });
  const data = await handleResponse<IngredientApiRecord[]>(response);
  return data.map(mapIngredient);
}

export async function getIngredientById(id: string): Promise<Ingredient | null> {
  const response = await fetch(buildUrl(`/ingredients/${id}`), {
    credentials: 'include',
    headers: authHeaders(),
  });
  const data = await handleResponse<IngredientApiRecord | null>(response);
  return data ? mapIngredient(data) : null;
}

export async function createIngredient(payload: {
  branchId: string;
  name: string;
  categoryId?: string | null;
  unit?: string;
}): Promise<number> {
  const response = await fetch(buildUrl('/ingredients'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      BRANCH_ID: payload.branchId,
      NAME: payload.name,
      CATEGORY_ID: payload.categoryId || null,
      UNIT: payload.unit || 'pcs',
    }),
  });
  const json = (await response.json()) as ApiResponse<{ id: number }>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to create ingredient');
  }
  return json.data?.id ?? 0;
}

export async function updateIngredient(
  id: string,
  payload: { name?: string; categoryId?: string | null; unit?: string }
): Promise<void> {
  const response = await fetch(buildUrl(`/ingredients/${id}`), {
    method: 'PUT',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      NAME: payload.name,
      MASTER_CAT_ID: payload.categoryId ?? null,
      UNIT: payload.unit ?? 'pcs',
    }),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update ingredient');
  }
}

export async function deleteIngredient(id: string): Promise<void> {
  const response = await fetch(buildUrl(`/ingredients/${id}`), {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to delete ingredient');
  }
}

export async function syncIngredientsFromExpenses(): Promise<void> {
  const response = await fetch(buildUrl('/ingredients/sync'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to sync ingredients');
  }
}
