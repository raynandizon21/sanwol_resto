const API_BASE = '/data-api';

type ApiResponse<T> = {
    success: boolean;
    data: T;
    message?: string;
    error?: string;
};

const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
};

const buildUrl = (path: string, params?: Record<string, string>) => {
    const url = new URL(`${window.location.origin}${API_BASE}${path}`);
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== '') url.searchParams.set(key, value);
        });
    }
    return url.toString();
};

export type ReceiptScanHistoryListRow = {
    IDNo: number;
    BRANCH_ID: number;
    BRANCH_NAME?: string | null;
    ENCODED_DT: string;
    ENCODED_BY?: number | null;
    ENCODED_BY_FIRSTNAME?: string | null;
    ENCODED_BY_LASTNAME?: string | null;
    SOURCE: string;
    ORDER_ID?: number | null;
    ORDER_NO?: string | null; // from join (optional)
    ORDER_SUBTOTAL?: number | null;
    ORDER_SERVICE_CHARGE?: number | null;
    ORDER_GRAND_TOTAL?: number | null;
    RECEIPT_GRAND_TOTAL?: number | null;
};

export type ReceiptScanHistoryDetail = ReceiptScanHistoryListRow & {
    receipt_image_data_url: string | null;
    orders?: Array<{
        ORDER_ID: number;
        ORDER_NO?: string | null;
        ORDER_TYPE?: string | null;
        TABLE_ID?: number | null;
        TABLE_NUMBER?: string | number | null;
        SUBTOTAL?: number | null;
        SERVICE_CHARGE?: number | null;
        GRAND_TOTAL?: number | null;
        ENCODED_DT?: string | null;
        items?: Array<{
            ORDER_ID: number;
            ORDER_ITEM_ID: number;
            MENU_ID?: number | null;
            MENU_NAME?: string | null;
            QTY?: number | null;
            UNIT_PRICE?: number | null;
            LINE_TOTAL?: number | null;
            REMARKS?: string | null;
            STATUS?: string | null;
        }>;
    }>;
};

export async function fetchReceiptScanHistoryList(
    branchId: string,
    limit = 100,
    options?: { sources?: string[] }
): Promise<ReceiptScanHistoryListRow[]> {
    const params: Record<string, string> = { limit: String(limit) };
    if (branchId && branchId !== 'all') params.branch_id = branchId;
    if (options?.sources?.length) params.sources = options.sources.join(',');
    const res = await fetch(buildUrl('/receipt-scan-history', params), {
        credentials: 'include',
        headers: authHeaders(),
    });
    const json = (await res.json()) as ApiResponse<ReceiptScanHistoryListRow[]>;
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load receipt history');
    }
    return Array.isArray(json.data) ? json.data : [];
}

export async function fetchReceiptScanHistoryById(id: number | string): Promise<ReceiptScanHistoryDetail> {
    const res = await fetch(buildUrl(`/receipt-scan-history/${id}`), {
        credentials: 'include',
        headers: authHeaders(),
    });
    const json = (await res.json()) as ApiResponse<ReceiptScanHistoryDetail>;
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load receipt record');
    }
    if (!json.data) throw new Error('Empty response');
    return json.data;
}

export type SaveReceiptScanHistoryPayload = {
    branch_id: string;
    source?: string;
    order_id?: number | null;
    encoded_dt?: string | null;
    receipt_grand_total?: number | null;
    receipt_image_path?: string | null;
    receipt_image_data_url?: string | null;
};

export async function saveReceiptScanHistory(payload: SaveReceiptScanHistoryPayload): Promise<{ id: number; receipt_image_path?: string | null }> {
    const res = await fetch(buildUrl('/receipt-scan-history'), {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
        },
        body: JSON.stringify({
            branch_id: payload.branch_id,
            source: payload.source ?? 'resto_admin',
            order_id: payload.order_id ?? null,
            encoded_dt: payload.encoded_dt ?? null,
            receipt_grand_total: payload.receipt_grand_total ?? null,
            receipt_image_path: payload.receipt_image_path ?? null,
            receipt_image_data_url: payload.receipt_image_data_url ?? null,
        }),
    });
    const json = (await res.json()) as ApiResponse<{ id: number; receipt_image_path?: string | null }>;
    if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to save receipt history');
    }
    if (!json.data?.id) throw new Error('Save failed');
    return json.data;
}
