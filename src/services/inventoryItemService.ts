type ApiResponse<T> = {
	success: boolean;
	data: T;
	message?: string;
	error?: string;
};

type InventoryItemApiRecord = {
	IDNo: number;
	INGREDIENT_ID?: number;
	BRANCH_ID: number;
	IS_MANUAL_STOCK?: number;
	ITEM_CODE?: string;
	ITEM_NAME?: string;
	item_name?: string;
	MASTER_CAT_ID?: number | null;
	CATEGORY_ID?: number | null;
	CATEGORY_NAME?: string | null;
	category_name?: string | null;
	STOCK_QTY?: number | string;
	UNIT?: string;
	UNIT_COST?: number | string;
	REORDER_LEVEL?: number | string;
	STATUS_FLAG?: string;
	ACTIVE?: number | boolean;
	[key: string]: unknown;
};

export type InventoryItem = {
	id: string;
	ingredientId?: string;
	isManualStock?: boolean;
	branchId: string;
	itemCode: string;
	itemName: string;
	categoryId: string | null;
	categoryName: string | null;
	stockQty: number;
	unit: string;
	unitCost: number;
	reorderLevel: number;
	statusFlag: string;
	active: boolean;
};

export type SaveInventoryItemPayload = {
	branchId?: string;
	itemName: string;
	categoryId?: string | null;
	categoryName?: string | null;
	stockQty: number;
	unit: string;
	unitCost: number;
	reorderLevel: number;
	statusFlag: string;
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

const toNumber = (value: number | string | null | undefined) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

const mapItemRecord = (row: InventoryItemApiRecord): InventoryItem => ({
	id: String(row.IDNo),
	ingredientId: row.INGREDIENT_ID != null ? String(row.INGREDIENT_ID) : undefined,
	isManualStock: Boolean(row.IS_MANUAL_STOCK),
	branchId: String(row.BRANCH_ID),
	itemCode: row.ITEM_CODE ?? '',
	itemName: (row.ITEM_NAME ?? row.item_name ?? '').toString(),
	categoryId: (row.MASTER_CAT_ID ?? row.CATEGORY_ID) != null ? String(row.MASTER_CAT_ID ?? row.CATEGORY_ID) : null,
	categoryName: (row.CATEGORY_NAME ?? row.category_name) ?? null,
	stockQty: toNumber(row.STOCK_QTY),
	unit: (row.UNIT ?? 'pcs').toString(),
	unitCost: toNumber(row.UNIT_COST),
	reorderLevel: toNumber(row.REORDER_LEVEL),
	statusFlag: (row.STATUS_FLAG ?? 'In Stock').toString(),
	active: Boolean(row.ACTIVE),
});

const handleResponse = async <T>(response: Response): Promise<T> => {
	const json = (await response.json()) as ApiResponse<T>;
	if (!response.ok || !json.success) {
		throw new Error(json.error || 'Request failed');
	}
	return json.data;
};

export async function getInventoryItems(branchId?: string, categoryId?: string | null): Promise<InventoryItem[]> {
	const params: Record<string, string> = {
		branch_id: branchId && branchId !== 'all' ? branchId : '',
		category_id: categoryId && categoryId !== 'all' ? categoryId : '',
	};
	const response = await fetch(buildUrl('/inventory/items', params), {
		credentials: 'include',
		headers: authHeaders(),
	});
	const data = await handleResponse<InventoryItemApiRecord[]>(response);
	return data.map(mapItemRecord);
}

export type InventoryCategoryMetric = {
	categoryId: string;
	itemCount: number;
	totalValue: number;
	needsAttention: number;
};

export type InventoryCategoryMetricsResponse = {
	byCategory: InventoryCategoryMetric[];
	totals: {
		totalItems: number;
		totalValue: number;
		needsAttention: number;
	};
};

export async function getInventoryCategoryMetrics(
	branchId?: string,
): Promise<InventoryCategoryMetricsResponse> {
	const params: Record<string, string> = {
		branch_id: branchId && branchId !== 'all' ? branchId : '',
	};
	const response = await fetch(buildUrl('/inventory/category-metrics', params), {
		credentials: 'include',
		headers: authHeaders(),
	});
	return handleResponse<InventoryCategoryMetricsResponse>(response);
}

export async function createInventoryItem(payload: SaveInventoryItemPayload): Promise<number> {
	const response = await fetch(buildUrl('/inventory/items'), {
		method: 'POST',
		credentials: 'include',
		headers: authHeaders(),
		body: JSON.stringify({
			BRANCH_ID: payload.branchId,
			ITEM_NAME: payload.itemName,
			MASTER_CAT_ID: payload.categoryId,
			CATEGORY_NAME: payload.categoryName,
			STOCK_QTY: payload.stockQty,
			UNIT: payload.unit,
			UNIT_COST: payload.unitCost,
			REORDER_LEVEL: payload.reorderLevel,
			STATUS_FLAG: payload.statusFlag,
		}),
	});
	const json = (await response.json()) as ApiResponse<{ id: number }>;
	if (!response.ok || !json.success) {
		throw new Error(json.error || 'Failed to create inventory item');
	}
	return json.data?.id ?? 0;
}

export async function updateInventoryItem(id: string, payload: SaveInventoryItemPayload): Promise<void> {
	const response = await fetch(buildUrl(`/inventory/items/${id}`), {
		method: 'PUT',
		credentials: 'include',
		headers: authHeaders(),
		body: JSON.stringify({
			ITEM_NAME: payload.itemName,
			MASTER_CAT_ID: payload.categoryId,
			CATEGORY_NAME: payload.categoryName,
			STOCK_QTY: payload.stockQty,
			UNIT: payload.unit,
			UNIT_COST: payload.unitCost,
			REORDER_LEVEL: payload.reorderLevel,
			STATUS_FLAG: payload.statusFlag,
		}),
	});
	const json = (await response.json()) as ApiResponse<null>;
	if (!response.ok || !json.success) {
		throw new Error(json.error || 'Failed to update inventory item');
	}
}

export async function deleteInventoryItem(id: string): Promise<void> {
	const response = await fetch(buildUrl(`/inventory/items/${id}`), {
		method: 'DELETE',
		credentials: 'include',
		headers: authHeaders(),
	});
	const json = (await response.json()) as ApiResponse<null>;
	if (!response.ok || !json.success) {
		throw new Error(json.error || 'Failed to delete inventory item');
	}
}

export type AdjustStockType = 'add' | 'deduct';

export async function adjustStock(
	ingredientId: string,
	branchId: string,
	qty: number,
	type: AdjustStockType
): Promise<void> {
	const response = await fetch(buildUrl('/inventory/items/adjust'), {
		method: 'POST',
		credentials: 'include',
		headers: authHeaders(),
		body: JSON.stringify({
			ingredientId,
			branchId,
			qty,
			type,
		}),
	});
	const json = (await response.json()) as ApiResponse<null>;
	if (!response.ok || !json.success) {
		throw new Error(json.error || 'Failed to adjust stock');
	}
}
