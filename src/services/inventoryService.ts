// ---- Types ----

export interface InventoryCategory {
    id: string;
    branchId: string;
    opCategoryId: string | null;
    name: string;
    categoryType: string;
    description: string | null;
    icon: string | null;
    isManualStock?: boolean;
    active: boolean;
}

// ---- API internals ----

type ApiResponse<T> = {
    success: boolean;
    data: T;
    message?: string;
    error?: string;
};

type InventoryCategoryApiRecord = {
    IDNo: number;
    BRANCH_ID: number;
    OP_CAT_ID?: number | null;
    CATEGORY_NAME: string;
    CATEGORY_TYPE: string;
    DESCRIPTION: string | null;
    ICON: string | null;
    IS_MANUAL_STOCK?: number;
    ACTIVE: number | boolean;
};

// Inventory API calls use /data-api prefix to avoid conflict with SPA routes
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
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
};

const handleResponse = async <T>(response: Response): Promise<T> => {
    const json = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !json.success) {
        throw new Error(json.error || 'Request failed');
    }
    return json.data;
};

const mapCategoryRecord = (row: InventoryCategoryApiRecord): InventoryCategory => ({
    id: String(row.IDNo),
    branchId: String(row.BRANCH_ID),
    opCategoryId: row.OP_CAT_ID !== undefined && row.OP_CAT_ID !== null ? String(row.OP_CAT_ID) : null,
    name: row.CATEGORY_NAME,
    categoryType: row.CATEGORY_TYPE || 'Inventory',
    description: row.DESCRIPTION,
    icon: row.ICON || null,
    isManualStock: Boolean(row.IS_MANUAL_STOCK),
    active: Boolean(row.ACTIVE),
});

// ---- Public API ----

export const getInventoryCategories = async (branchId?: string): Promise<InventoryCategory[]> => {
    const params: Record<string, string> = {
        branch_id: branchId && branchId !== 'all' ? branchId : '',
        category_type: 'Inventory',
    };
    const response = await fetch(buildUrl('/inventory/categories', params), {
        credentials: 'include',
        headers: authHeaders(),
    });
    const data = await handleResponse<InventoryCategoryApiRecord[]>(response);
    return data.map(mapCategoryRecord);
};

export const getAllMasterCategories = async (branchId?: string): Promise<InventoryCategory[]> => {
    const params: Record<string, string> = {
        branch_id: branchId && branchId !== 'all' ? branchId : '',
        scope: 'all',
    };
    const response = await fetch(buildUrl('/inventory/categories', params), {
        credentials: 'include',
        headers: authHeaders(),
    });
    const data = await handleResponse<InventoryCategoryApiRecord[]>(response);
    return data.map(mapCategoryRecord);
};

export type CreateInventoryCategoryPayload = {
    branchId: string;
    name: string;
    categoryType: string;
    description: string | null;
    icon: string | null;
    opCategoryId?: string | number | null;
    isManualStock?: boolean;
};

export async function createInventoryCategory(payload: CreateInventoryCategoryPayload): Promise<number> {
    const body: Record<string, unknown> = {
        BRANCH_ID: payload.branchId,
        CATEGORY_NAME: payload.name,
        CATEGORY_TYPE: payload.categoryType,
        DESCRIPTION: payload.description,
        ICON: payload.icon,
        isManualStock: Boolean(payload.isManualStock),
    };
    if (payload.opCategoryId !== undefined && payload.opCategoryId !== null && payload.opCategoryId !== '') {
        body.OP_CAT_ID = payload.opCategoryId;
    }
    const response = await fetch(buildUrl('/inventory/categories'), {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(),
        body: JSON.stringify(body),
    });
    const json = (await response.json()) as ApiResponse<{ id: number }>;
    if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to create category');
    }
    return json.data?.id ?? 0;
}

export type UpdateInventoryCategoryPayload = {
    name: string;
    categoryType: string;
    description: string | null;
    icon: string | null;
    opCategoryId?: string | number | null;
    isManualStock?: boolean;
};

export async function updateInventoryCategory(id: string, payload: UpdateInventoryCategoryPayload): Promise<void> {
    const body: Record<string, unknown> = {
        CATEGORY_NAME: payload.name,
        CATEGORY_TYPE: payload.categoryType,
        DESCRIPTION: payload.description,
        ICON: payload.icon,
        isManualStock: Boolean(payload.isManualStock),
    };
    if (payload.opCategoryId !== undefined && payload.opCategoryId !== null && payload.opCategoryId !== '') {
        body.OP_CAT_ID = payload.opCategoryId;
    }
    const response = await fetch(buildUrl(`/inventory/categories/${id}`), {
        method: 'PUT',
        credentials: 'include',
        headers: authHeaders(),
        body: JSON.stringify(body),
    });
    const json = (await response.json()) as ApiResponse<null>;
    if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to update category');
    }
}

export async function deleteInventoryCategory(id: string): Promise<void> {
    const response = await fetch(buildUrl(`/inventory/categories/${id}`), {
        method: 'DELETE',
        credentials: 'include',
        headers: authHeaders(),
    });
    const json = (await response.json()) as ApiResponse<null>;
    if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to delete category');
    }
}
