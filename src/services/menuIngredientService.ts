type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
};

export type MenuIngredientRecord = {
  id: string;
  menuId: string;
  ingredientId: string;
  ingredientName: string;
  ingredientCategory: string | null;
  qtyPerServe: number;
  unit: string;
};

type MenuIngredientApiRecord = {
  IDNo: number;
  MENU_ID: number;
  INGREDIENT_ID: number;
  INGREDIENT_NAME: string;
  INGREDIENT_CATEGORY?: string | null;
  QTY_PER_SERVE: number | string;
  UNIT: string;
};

const API_BASE = '/data-api';

const buildUrl = (path: string) => {
  const url = new URL(`${window.location.origin}${API_BASE}${path}`);
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

const mapRecord = (row: MenuIngredientApiRecord): MenuIngredientRecord => ({
  id: String(row.IDNo),
  menuId: String(row.MENU_ID),
  ingredientId: String(row.INGREDIENT_ID),
  ingredientName: String(row.INGREDIENT_NAME || ''),
  ingredientCategory: row.INGREDIENT_CATEGORY ?? null,
  qtyPerServe: typeof row.QTY_PER_SERVE === 'string' ? Number(row.QTY_PER_SERVE) : Number(row.QTY_PER_SERVE ?? 0),
  unit: String(row.UNIT || 'pcs'),
});

export async function getMenuIngredients(menuId: string): Promise<MenuIngredientRecord[]> {
  const response = await fetch(buildUrl(`/menu/${menuId}/ingredients`), {
    credentials: 'include',
    headers: authHeaders(),
  });
  const data = await handleResponse<MenuIngredientApiRecord[]>(response);
  return data.map(mapRecord);
}

export async function createMenuIngredient(payload: {
  menuId: string;
  ingredientId: string;
  qtyPerServe?: number;
  unit?: string;
}): Promise<number> {
  const response = await fetch(buildUrl('/menu-ingredients'), {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      MENU_ID: payload.menuId,
      INGREDIENT_ID: payload.ingredientId,
      QTY_PER_SERVE: payload.qtyPerServe ?? 1,
      UNIT: payload.unit ?? 'pcs',
    }),
  });
  const json = (await response.json()) as ApiResponse<{ id: number }>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to add ingredient');
  }
  return json.data?.id ?? 0;
}

export async function updateMenuIngredient(
  id: string,
  payload: { qtyPerServe?: number; unit?: string }
): Promise<void> {
  const response = await fetch(buildUrl(`/menu-ingredients/${id}`), {
    method: 'PUT',
    credentials: 'include',
    headers: authHeaders(),
    body: JSON.stringify({
      QTY_PER_SERVE: payload.qtyPerServe ?? 1,
      UNIT: payload.unit ?? 'pcs',
    }),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to update ingredient');
  }
}

export async function deleteMenuIngredient(id: string): Promise<void> {
  const response = await fetch(buildUrl(`/menu-ingredients/${id}`), {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });
  const json = (await response.json()) as ApiResponse<null>;
  if (!response.ok || !json.success) {
    throw new Error(json.error || 'Failed to remove ingredient');
  }
}
