import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Search,
    Filter,
    Plus,
    Receipt,
    Eye,
    CheckCircle2,
    XCircle,
    X,
    AlertTriangle,
    AlertCircle,
    Loader2,
    Trash2,
    Clock,
    Pencil,
    Check,
    ChevronLeft,
    ChevronRight,
    ScanLine,
    Upload,
    RefreshCw,
    History,
    Calendar,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
    MANILA_TIMEZONE,
    formatEncodedDt,
    isEncodedDtWithinDateRange,
    parseEncodedDtToUtcMs,
} from '../../utils/manilaDateTime';
import { isFloorEnabledBranch, type TableFloor } from '../../utils/floorScope';
import { hasDineInServiceCharge, tenPercentServiceCharge } from '../../utils/branchFeatures';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { Select2 } from '../ui/Select2';
import { SkeletonPageHeader, SkeletonStatCards, SkeletonTable } from '../ui/Skeleton';
import { toast } from 'sonner';
import {
    getOrders,
    getOrdersWithMeta,
    getOrderItems,
    getOrderById,
    createOrder,
    createManualSettledOrder,
    updateOrderStatus,
    updateOrderEncodedDt,
    softDeleteOrder,
    deleteOrderItem,
    updateOrderItemQuantity,
    addItemsToOrder,
    InventoryInsufficientError,
    ORDER_STATUS,
    type OrderRecord,
    type OrderItemRecord,
    type OrderListStats,
    type CreateOrderItemPayload,
} from '../../services/orderService';
import { getMenus, type MenuRecord } from '../../services/menuService';
import { toUserFriendlyError } from '../../utils/userFriendlyErrors';
import { compressReceiptImage, fetchReceiptScannerGeminiKey } from '../../services/receiptScannerService';
import { extractOrderLinesFromReceiptImage, type ReceiptOrderExtractionResult } from '../../services/receiptOrderExtraction';
import { ReceiptOrderBlockCard } from './ReceiptOrderBlockCard';
import { isReceiptLineMappedToMenu, matchReceiptLineToMenu } from '../../services/receiptOrderMenuMatch';
import { type Branch } from '../partials/Header';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import { useUser } from '../../context/UserContext';
import {
    fetchReceiptScanHistoryList,
    fetchReceiptScanHistoryById,
    saveReceiptScanHistory,
    type ReceiptScanHistoryListRow,
    type ReceiptScanHistoryDetail,
} from '../../services/receiptScanHistoryService';

// ---- Props & types ----
interface OrdersProps {
    selectedBranch: Branch | null;
    dateRange: {
        start: string;
        end: string;
    };
}

type SwalState = {
    type: 'question' | 'success' | 'error' | 'warning';
    title: string;
    text: string;
    showCancel?: boolean;
    confirmText?: string;
    onConfirm?: () => void | Promise<void>;
    onCancel?: () => void;
} | null;

type NewOrderItem = {
    menuId: string;
    name: string;
    unitPrice: number;
    qty: number;
};

/** Upload receipt in admin → resto_admin; ReceiptLens app → receiptlens. Exclude other SOURCE values (e.g. expenses). */
function normalizeReceiptScanHistorySource(raw: string | null | undefined): string {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
}

function isOrdersReceiptScanHistorySource(raw: string | null | undefined): boolean {
    const s = normalizeReceiptScanHistorySource(raw);
    return s === 'resto_admin' || s === 'receiptlens';
}

function receiptScanHistoryRowSource(row: ReceiptScanHistoryListRow): string {
    const r = row as unknown as Record<string, string | undefined>;
    return String(r.SOURCE ?? r.source ?? '');
}

function formatReceiptScanHistorySourceLabel(raw: string): string {
    const s = normalizeReceiptScanHistorySource(raw);
    if (s === 'receiptlens') return 'ReceiptLens';
    if (s === 'resto_admin') return 'resto_admin';
    return raw?.trim() || '—';
}

/** Usernames allowed to edit an order's encoded date / soft-delete it, regardless of branch or role. */
const ORDER_META_EDITOR_USERNAMES = ['3coredev', 'bmoon'];

function isOrderMetaEditorUsername(username: string | null | undefined): boolean {
    return ORDER_META_EDITOR_USERNAMES.includes(String(username ?? '').trim().toLowerCase());
}

const ENCODED_DT_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

function encodedDtToDatetimeLocalValue(encoded: string | null | undefined): string {
    const utcMs = parseEncodedDtToUtcMs(String(encoded ?? ''));
    if (utcMs != null) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: MANILA_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(new Date(utcMs));
        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
        const hour = get('hour') === '24' ? '00' : get('hour');
        return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
    }
    const m = String(encoded ?? '').trim().match(ENCODED_DT_LOCAL_RE);
    if (!m) return '';
    return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}`;
}

function datetimeLocalValueToEncodedDt(value: string): string | null {
    const m = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? '00'}`;
}

function formatPesoUpToTwoDecimals(amount: number): string {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '0';
    const roundedCents = Math.round(n * 100);
    const hasFractionalPeso = roundedCents % 100 !== 0;
    return (roundedCents / 100).toLocaleString(undefined, {
        minimumFractionDigits: hasFractionalPeso ? 2 : 0,
        maximumFractionDigits: hasFractionalPeso ? 2 : 0,
    });
}

function isDineInOrderType(orderType: string | null | undefined): boolean {
    const t = String(orderType ?? '').trim().toUpperCase();
    if (!t) return true; // default
    return t === 'DINE_IN' || t === 'DINE IN';
}

function looksLikeReceiptServiceChargeLine(text: string): boolean {
    const s = String(text ?? '').trim().toLowerCase();
    if (!s) return false;
    if (s.includes('service charge')) return true;
    if (s.includes('svc charge')) return true;
    if (s.includes('svc chg')) return true;
    if (s.includes('s/c')) return true;
    // Keep "sc" detection strict to avoid false positives like "scan".
    if (/\bsc\b/.test(s)) return true;
    return false;
}

export const Orders: React.FC<OrdersProps> = ({ selectedBranch, dateRange }) => {
    const { t } = useTranslation();
    const { user } = useUser();
    const isAdmin = user?.permissions === 1;
    const canEditOrderMeta = isOrderMetaEditorUsername(user?.username);

    // Prefer URL branchId to stay consistent with Header behavior (opens new tab with ?branchId=...).
    // Fallback to selectedBranch, then 'all'.
    const branchIdFromUrl = new URLSearchParams(window.location.search).get('branchId');
    const branchId = selectedBranch ? String(selectedBranch.id) : (branchIdFromUrl ? String(branchIdFromUrl) : 'all');

    // Only admin can operate in "all branches" mode; non-admins should never see branch chooser here.
    const isAllBranches = isAdmin && branchId === 'all';

    // ----- Data -----
    const [orders, setOrders] = useState<OrderRecord[]>([]);
    const [serverStats, setServerStats] = useState<OrderListStats | null>(null);
    const loadOrdersReqIdRef = useRef(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // ----- Filters -----
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('all');

    // ----- Detail modal -----
    const [detailOrder, setDetailOrder] = useState<OrderRecord | null>(null);
    const [detailItems, setDetailItems] = useState<OrderItemRecord[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailRoomChargeUnit, setDetailRoomChargeUnit] = useState<number>(0);

    // ----- Status update & item actions -----
    const [statusSubmitting, setStatusSubmitting] = useState(false);
    const [itemRemoving, setItemRemoving] = useState(false);
    const [itemUpdating, setItemUpdating] = useState(false);
    const [editingItemId, setEditingItemId] = useState<number | null>(null);
    const [editingQty, setEditingQty] = useState<number>(1);
    const [swal, setSwal] = useState<SwalState>(null);

    const [encodedDtOrder, setEncodedDtOrder] = useState<OrderRecord | null>(null);
    const [encodedDtValue, setEncodedDtValue] = useState('');
    const [encodedDtSubmitting, setEncodedDtSubmitting] = useState(false);

    // ----- New order modal -----
    const [newOrderOpen, setNewOrderOpen] = useState(false);
    const [newOrderSubmitting, setNewOrderSubmitting] = useState(false);
    const [newOrderMenus, setNewOrderMenus] = useState<MenuRecord[]>([]);
    const [newOrderLoadingRefs, setNewOrderLoadingRefs] = useState(false);
    const [newOrderNo, setNewOrderNo] = useState('');
    const [newOrderType, setNewOrderType] = useState<'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'>('DINE_IN');
    const [newOrderTableId, setNewOrderTableId] = useState<string>('');
    const [branchTables, setBranchTables] = useState<{ value: string; label: string; floor: TableFloor | null }[]>([]);
    const [branchTablesRoomChargeById, setBranchTablesRoomChargeById] = useState<Record<string, number>>({});
    const [newOrderItems, setNewOrderItems] = useState<NewOrderItem[]>([]);
    const [newOrderSelectedMenuId, setNewOrderSelectedMenuId] = useState<string>('');
    const [newOrderQty, setNewOrderQty] = useState<number>(1);

    // ----- Manual order modal (settled immediately) -----
    const [manualOrderOpen, setManualOrderOpen] = useState(false);
    const [manualOrderSubmitting, setManualOrderSubmitting] = useState(false);
    const [manualOrderMenus, setManualOrderMenus] = useState<MenuRecord[]>([]);
    const [manualOrderLoadingRefs, setManualOrderLoadingRefs] = useState(false);
    const [manualOrderNo, setManualOrderNo] = useState('');
    const [manualOrderBranchId, setManualOrderBranchId] = useState<string>('');
    const [manualBranchOptions, setManualBranchOptions] = useState<{ value: string; label: string }[]>([]);
    const [manualOrderType, setManualOrderType] = useState<'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'>('DINE_IN');
    const [manualOrderTableId, setManualOrderTableId] = useState<string>('');
    const [manualBranchTables, setManualBranchTables] = useState<{ value: string; label: string; floor: TableFloor | null }[]>([]);
    const [manualBranchTablesRoomChargeById, setManualBranchTablesRoomChargeById] = useState<Record<string, number>>({});
    const [manualRoomChargeQty, setManualRoomChargeQty] = useState<number>(1);
    const [manualOrderItems, setManualOrderItems] = useState<NewOrderItem[]>([]);
    const [manualMenuQuery, setManualMenuQuery] = useState('');
    const [manualRowFlash, setManualRowFlash] = useState<{ menuId: string; nonce: number } | null>(null);
    const [manualPaymentMethod, setManualPaymentMethod] = useState<'CASH' | 'CARD' | 'GCASH' | 'BANK'>('CASH');
    const [manualPaymentRef, setManualPaymentRef] = useState<string>('');
    const [manualDiscountAmount, setManualDiscountAmount] = useState<string>('0');
    const [manualMenuPage, setManualMenuPage] = useState(1);
    const [manualOrderDate, setManualOrderDate] = useState<string>('');

    // ----- Receipt scan → new order -----
    const [receiptOrderOpen, setReceiptOrderOpen] = useState(false);
    const [receiptOrderNo, setReceiptOrderNo] = useState('');
    const [receiptOrderType, setReceiptOrderType] = useState<'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'>('DINE_IN');
    const [receiptOrderTableId, setReceiptOrderTableId] = useState('');
    const [receiptOrderBranchId, setReceiptOrderBranchId] = useState('');
    const [receiptOrderDate, setReceiptOrderDate] = useState<string>('');
    const [receiptOrderMenus, setReceiptOrderMenus] = useState<MenuRecord[]>([]);
    const [receiptOrderMenusLoading, setReceiptOrderMenusLoading] = useState(false);
    const [receiptBranchTables, setReceiptBranchTables] = useState<{ value: string; label: string; floor: TableFloor | null }[]>([]);
    const [receiptImage, setReceiptImage] = useState<string | null>(null);
    const [receiptExtracting, setReceiptExtracting] = useState(false);
    const [receiptError, setReceiptError] = useState<string | null>(null);
    const [receiptExtractResult, setReceiptExtractResult] = useState<ReceiptOrderExtractionResult | null>(null);
    const [receiptMetaById, setReceiptMetaById] = useState<Record<number, { orderNo: string; orderType: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'; tableNo?: string; tableId?: string }>>({});
    const [receiptMapOpenByOrderId, setReceiptMapOpenByOrderId] = useState<Record<number, boolean>>({});
    const [receiptRows, setReceiptRows] = useState<
        {
            id: string;
            extractedName: string;
            menuSelection: string;
            qty: number;
            receiptLineTotal: number;
            menuId: string | null;
            orderId: number;
        }[]
    >([]);
    const [receiptSubmitting, setReceiptSubmitting] = useState(false);
    const receiptFileInputRef = useRef<HTMLInputElement>(null);
    const [receiptSegments, setReceiptSegments] = useState<string[]>([]);
    const [receiptStitching, setReceiptStitching] = useState(false);
    const RECEIPT_MAX_PAGES = 8;
    const RECEIPT_DRAFT_KEY = 'orders_receipt_scan_draft_v1';
    const receiptDraftHydratedRef = useRef(false);
    const ORDERS_DEBUG_RUNTIME_KEY = 'orders_debug_last_runtime_id_v1';

    const [receiptHistoryOpen, setReceiptHistoryOpen] = useState(false);
    const [receiptHistoryRows, setReceiptHistoryRows] = useState<ReceiptScanHistoryListRow[]>([]);
    const [receiptHistoryLoading, setReceiptHistoryLoading] = useState(false);
    const [receiptHistoryDetailOpen, setReceiptHistoryDetailOpen] = useState(false);
    const [receiptHistoryDetail, setReceiptHistoryDetail] = useState<ReceiptScanHistoryDetail | null>(null);
    const [receiptHistoryDetailLoading, setReceiptHistoryDetailLoading] = useState(false);

    // ----- Add items to existing order (detail modal) -----
    const [detailMenus, setDetailMenus] = useState<MenuRecord[]>([]);
    const [detailMenusLoading, setDetailMenusLoading] = useState(false);
    const [detailSelectedMenuId, setDetailSelectedMenuId] = useState<string>('');
    const [detailAddQty, setDetailAddQty] = useState<number>(1);
    const [detailAdding, setDetailAdding] = useState(false);

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();

    useEffect(() => {
        if (!(import.meta as any)?.env?.DEV) return;
        const w = window as unknown as {
            __ordersDebugRuntimeId?: string;
            __ordersDebugMountCount?: number;
        };
        const previousRuntimeId = (() => {
            try {
                return sessionStorage.getItem(ORDERS_DEBUG_RUNTIME_KEY) || '';
            } catch {
                return '';
            }
        })();
        const existingRuntimeId = String(w.__ordersDebugRuntimeId || '').trim();
        const isSamePageRemount = !!existingRuntimeId;
        const runtimeId =
            existingRuntimeId ||
            `orders-runtime-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
        w.__ordersDebugRuntimeId = runtimeId;
        w.__ordersDebugMountCount = Number(w.__ordersDebugMountCount || 0) + 1;
        const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const navType = navEntry?.type || 'unknown';
        const likelyFullReload = !isSamePageRemount && !!previousRuntimeId && previousRuntimeId !== runtimeId;
        const marker = {
            runtimeId,
            mountCountInRuntime: w.__ordersDebugMountCount,
            navType,
            likelyFullReload,
            branchId,
            path: window.location.pathname + window.location.search,
            at: new Date().toISOString(),
        };
        try {
            sessionStorage.setItem(ORDERS_DEBUG_RUNTIME_KEY, runtimeId);
        } catch {
            // ignore
        }
        console.info('[Orders Debug Marker]', marker);
        if (likelyFullReload) {
            toast.message('Orders debug: detected likely full reload (check console).');
        }
    }, [branchId]);

    // ==================== Helper ====================
    const orderTypeLabel = (v: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY') => {
        if (v === 'TAKE_OUT') return t('orders.take_out');
        if (v === 'DELIVERY') return t('orders.delivery');
        return t('orders.dine_in');
    };

    const getStatusLabel = (status: number) => {
        switch (Number(status)) {
            case ORDER_STATUS.PENDING: return t('orders.pending');
            case ORDER_STATUS.CONFIRMED: return t('orders.confirmed');
            case ORDER_STATUS.SETTLED: return t('orders.settled');
            case ORDER_STATUS.CANCELLED: return t('orders.cancelled');
            default: return t('orders.unknown');
        }
    };

    // ==================== Data fetching ====================
    const loadOrders = useCallback(async () => {
        const reqId = ++loadOrdersReqIdRef.current;
        setLoading(true);
        setError(null);
        try {
            const { orders: data, stats: nextStats } = await getOrdersWithMeta(branchId, {
                startDate: dateRange.start || undefined,
                endDate: dateRange.end || undefined,
                limit: 500,
                includeStats: true,
            });
            if (reqId !== loadOrdersReqIdRef.current) return;
            const raw = Array.isArray(data) ? data : [];
            // Defensive: backend list must be 1 row per order ID. If billing JOIN ever duplicates again,
            // dedupe by IDNo so React keys stay unique and detail rows stay sane.
            const seen = new Map<number, OrderRecord>();
            for (const o of raw) {
                const id = Number(o.IDNo);
                if (!Number.isFinite(id)) continue;
                if (!seen.has(id)) seen.set(id, o);
            }
            setOrders([...seen.values()]);
            setServerStats(nextStats);
        } catch (e) {
            if (reqId !== loadOrdersReqIdRef.current) return;
            setError(e instanceof Error ? e.message : t('orders.failed_to_load'));
            setOrders([]);
            setServerStats(null);
        } finally {
            if (reqId === loadOrdersReqIdRef.current) setLoading(false);
        }
    }, [branchId, dateRange.start, dateRange.end, t]);

    useEffect(() => {
        loadOrders();
        setSearchTerm('');
        setStatusFilter('all');
    }, [loadOrders]);

    // ==================== Tables for this branch (for new order) ====================
    useEffect(() => {
        let cancelled = false;
        const fetchTablesForBranch = async () => {
            try {
                const params = new URLSearchParams();
                if (branchId && branchId !== 'all') {
                    params.set('branch_id', branchId);
                }
                const qs = params.toString();
                const res = await fetch(`/data-api/restaurant_tables${qs ? `?${qs}` : ''}`, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
                const json = await res.json();
                if (!res.ok) {
                    throw new Error(json.error || json.message || 'Failed to load tables');
                }
                const raw = json.data ?? json;
                const mapped: { value: string; label: string; floor: TableFloor | null }[] = (Array.isArray(raw) ? raw : [])
                    .filter((t: any) => t.STATUS === 1) // available only
                    .map((t: any) => ({
                        value: String(t.IDNo),
                        label: `Table ${t.TABLE_NUMBER}`,
                        floor: t.FLOOR === 'gf' || t.FLOOR === '2f' ? (t.FLOOR as TableFloor) : null,
                    }));
                const roomChargeById: Record<string, number> = {};
                for (const t of (Array.isArray(raw) ? raw : [])) {
                    if (t?.STATUS !== 1) continue;
                    const id = String(t?.IDNo);
                    if (!id) continue;
                    const rcRaw = t?.ROOM_CHARGE;
                    const rc =
                        rcRaw != null && rcRaw !== '' && !Number.isNaN(Number(rcRaw)) ? Number(rcRaw) : 0;
                    roomChargeById[id] = rc;
                }
                if (!cancelled) {
                    setBranchTables(mapped);
                    setBranchTablesRoomChargeById(roomChargeById);
                }
            } catch (e) {
                if (!cancelled) {
                    console.error('Failed to load tables for new order', e);
                    setBranchTables([]);
                    setBranchTablesRoomChargeById({});
                }
            }
        };
        fetchTablesForBranch();
        return () => {
            cancelled = true;
        };
    }, [branchId]);

    // ==================== Filtering ====================
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const getManilaTodayYmd = () => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: MANILA_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour12: false,
        }).formatToParts(new Date());
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
        return `${get('year')}-${pad2(get('month'))}-${pad2(get('day'))}`;
    };
    const getManilaNowHms = () => {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: MANILA_TIMEZONE,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(new Date());
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
        return { hour: get('hour'), minute: get('minute'), second: get('second') };
    };
    /** Picker supplies the calendar date; time is current wall clock in Asia/Manila (PH timestamp). */
    const encodedDtPickerDateManilaNow = (pickerYmd: string | null | undefined) => {
        const today = getManilaTodayYmd();
        const ymd = pickerYmd && String(pickerYmd).trim() ? String(pickerYmd).trim() : today;
        const [yy, mm, dd] = ymd.split('-').map((x) => Number(x));
        const { hour, minute, second } = getManilaNowHms();
        return `${yy}-${pad2(mm)}-${pad2(dd)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
    };

    const isWithinDateRange = useCallback(
        (encoded: string | null | undefined, rowBranchId?: number | string | null) =>
            isEncodedDtWithinDateRange(encoded, dateRange, rowBranchId ?? branchId),
        [dateRange.start, dateRange.end, branchId],
    );

    const filteredOrders = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();

        const parseOrderNoToMs = (orderNo: string | null | undefined): number | null => {
            // Expected: ORD-YYYYMMDD-HHMMSS (example: ORD-20260330-155527)
            const m = String(orderNo ?? '').match(/^ORD-(\d{8})-(\d{6})/);
            if (!m) return null;

            const ymd = m[1];
            const hhmmss = m[2];
            const year = Number(ymd.slice(0, 4));
            const month = Number(ymd.slice(4, 6)) - 1;
            const day = Number(ymd.slice(6, 8));

            const hour = Number(hhmmss.slice(0, 2));
            const minute = Number(hhmmss.slice(2, 4));
            const second = Number(hhmmss.slice(4, 6));

            // Use Date.UTC so any timezone assumption becomes a constant offset for ordering.
            return Date.UTC(year, month, day, hour, minute, second);
        };

        const filtered = orders.filter((order) => {
            const matchStatus = statusFilter === 'all' || String(order.STATUS) === statusFilter;
            const matchSearch = !term || order.ORDER_NO.toLowerCase().includes(term) || (order.TABLE_NUMBER && order.TABLE_NUMBER.toString().includes(term));
            const matchDate = isWithinDateRange(order.ENCODED_DT, order.BRANCH_ID);
            return matchStatus && matchSearch && matchDate;
        });

        // Precompute sort keys once (avoids recomputation inside sort comparator).
        const keyed = filtered.map((order) => {
            const orderNoMs = parseOrderNoToMs(order.ORDER_NO);
            const encodedMs = order.ENCODED_DT ? parseEncodedDtToUtcMs(order.ENCODED_DT) : null;
            return {
                order,
                primaryMs: orderNoMs ?? encodedMs,
                encodedMs,
                dbId: Number(order.IDNo),
            };
        });

        keyed.sort((a, b) => {
            const aPrimary = a.primaryMs ?? Number.NEGATIVE_INFINITY;
            const bPrimary = b.primaryMs ?? Number.NEGATIVE_INFINITY;
            if (bPrimary !== aPrimary) return bPrimary - aPrimary;

            // Tie-break by encoded timestamp only when both parse successfully.
            if (a.encodedMs != null && b.encodedMs != null && b.encodedMs !== a.encodedMs) {
                return b.encodedMs - a.encodedMs;
            }

            return b.dbId - a.dbId;
        });

        return keyed.map((k) => k.order);
    }, [orders, searchTerm, statusFilter, isWithinDateRange]);

    // ==================== Stats ====================
    const stats = useMemo(() => {
        if (serverStats) return serverStats;
        const scoped = orders.filter((o) => isWithinDateRange(o.ENCODED_DT, o.BRANCH_ID));
        const pending = scoped.filter((o) => o.STATUS === ORDER_STATUS.PENDING).length;
        const confirmed = scoped.filter((o) => o.STATUS === ORDER_STATUS.CONFIRMED).length;
        const settled = scoped.filter((o) => o.STATUS === ORDER_STATUS.SETTLED).length;
        const cancelled = scoped.filter((o) => o.STATUS === ORDER_STATUS.CANCELLED).length;
        const totalRevenue = scoped
            .filter((o) => o.STATUS === ORDER_STATUS.SETTLED)
            .reduce((s, o) => s + Number(o.GRAND_TOTAL || 0), 0);
        return { total: scoped.length, pending, confirmed, settled, cancelled, totalRevenue };
    }, [orders, isWithinDateRange, serverStats]);

    // ==================== Detail ====================
    const openDetail = async (order: OrderRecord) => {
        setDetailOrder(order);
        setDetailLoading(true);
        setDetailItems([]);
        try {
            const items = await getOrderItems(String(order.IDNo));
            setDetailItems(items);
        } catch {
            setDetailItems([]);
        } finally {
            setDetailLoading(false);
        }
    };

    const closeDetail = () => { setDetailOrder(null); setDetailItems([]); };

    // Load ROOM_CHARGE for the selected table so we can render "Room charge"
    // row (derived from SERVICE_CHARGE) with correct qty/unit/line_total.
    useEffect(() => {
        if (!detailOrder) {
            setDetailRoomChargeUnit(0);
            return;
        }

        const status = Number(detailOrder.STATUS);
        const isSettledLike = status === ORDER_STATUS.SETTLED || status === ORDER_STATUS.CANCELLED;
        if (!isSettledLike) {
            setDetailRoomChargeUnit(0);
            return;
        }

        const tableId = detailOrder.TABLE_ID != null ? Number(detailOrder.TABLE_ID) : NaN;
        if (!Number.isFinite(tableId) || tableId <= 0) {
            setDetailRoomChargeUnit(0);
            return;
        }

        let cancelled = false;
        const fetchRoomCharge = async () => {
            try {
                const branchId = detailOrder.BRANCH_ID != null ? String(detailOrder.BRANCH_ID) : '';
                const qs = branchId ? `?branch_id=${encodeURIComponent(branchId)}` : '';

                const res = await fetch(`/data-api/restaurant_tables${qs}`, {
                    headers: { 'Content-Type': 'application/json' },
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json?.error || json?.message || 'Failed to load tables');

                const raw = json.data ?? json;
                const tables = Array.isArray(raw) ? raw : [];
                const table = tables.find((t: any) => Number(t?.IDNo) === tableId);
                const rcRaw = table?.ROOM_CHARGE;
                const rc = rcRaw != null && rcRaw !== '' ? Number(rcRaw) : 0;
                if (!cancelled) setDetailRoomChargeUnit(Number.isFinite(rc) ? rc : 0);
            } catch (e) {
                if (!cancelled) setDetailRoomChargeUnit(0);
            }
        };

        fetchRoomCharge();
        return () => {
            cancelled = true;
        };
    }, [detailOrder?.IDNo, detailOrder?.TABLE_ID, detailOrder?.BRANCH_ID, detailOrder?.STATUS]);

    const detailServiceCharge = detailOrder ? Number(detailOrder.SERVICE_CHARGE ?? 0) : 0;
    const detailIsRoomCharge = detailRoomChargeUnit > 0;
    const detailRoomChargeUnitForRow = detailRoomChargeUnit > 0 ? detailRoomChargeUnit : detailServiceCharge;
    const detailRoomChargeQtyForRow =
        detailRoomChargeUnitForRow > 0 ? Math.max(0.5, Math.round((detailServiceCharge / detailRoomChargeUnitForRow) * 2) / 2) : 0.5;

    // ==================== Remove order item ====================
    const confirmRemoveItem = (item: OrderItemRecord) => {
        if (!detailOrder) return;
        if (itemUpdating) return;
        setSwal({
            type: 'question',
            title: t('orders.swal.remove_item_title'),
            text: t('orders.swal.remove_item_text', { itemName: item.MENU_NAME ?? `Item #${item.MENU_ID}` }),
            showCancel: true,
            confirmText: t('orders.swal.remove_item_confirm'),
            onConfirm: async () => {
                setSwal(null);
                setItemRemoving(true);
                try {
                    await deleteOrderItem(String(item.IDNo));
                    const [refreshed, updatedOrder] = await Promise.all([
                        getOrderItems(String(detailOrder.IDNo)),
                        getOrderById(String(detailOrder.IDNo)),
                    ]);
                    setDetailItems(refreshed);
                    if (updatedOrder) setDetailOrder(updatedOrder);
                    await loadOrders();
                    toast.success(t('orders.swal.remove_item_success'));
                } catch (e) {
                    toast.error(e instanceof Error ? e.message : t('orders.swal.remove_item_failed'));
                } finally {
                    setItemRemoving(false);
                }
            },
            onCancel: () => setSwal(null),
        });
    };

    const startEditItem = (item: OrderItemRecord) => {
        if (itemRemoving || itemUpdating) return;
        setEditingItemId(item.IDNo);
        setEditingQty(Number(item.QTY) || 1);
    };

    const cancelEditItem = () => {
        if (itemUpdating) return;
        setEditingItemId(null);
    };

    const submitEditItem = async (item: OrderItemRecord) => {
        if (!detailOrder) return;
        const qty = Number(editingQty);
        if (!Number.isFinite(qty) || qty <= 0) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.invalid_qty_title'),
                text: t('orders.swal.invalid_qty_text'),
                onConfirm: () => setSwal(null),
            });
            return;
        }
        setItemUpdating(true);
        try {
            await updateOrderItemQuantity(String(item.IDNo), qty);
            const [refreshed, updatedOrder] = await Promise.all([
                getOrderItems(String(detailOrder.IDNo)),
                getOrderById(String(detailOrder.IDNo)),
            ]);
            setDetailItems(refreshed);
            if (updatedOrder) setDetailOrder(updatedOrder);
            await loadOrders();
            toast.success(t('orders.updated_item_qty_success', { itemName: item.MENU_NAME ?? `Item #${item.MENU_ID}` }));
            setEditingItemId(null);
        } catch (e) {
            if (e instanceof InventoryInsufficientError && e.insufficient?.length) {
                const list = e.insufficient.map((i) => t('orders.swal.insufficient_inventory_item', {
                    name: i.ingredientName,
                    required: i.required,
                    available: i.available,
                    unit: i.unit,
                })).join('\n');
                setSwal({
                    type: 'warning',
                    title: t('orders.swal.insufficient_inventory_title'),
                    text: `${t('orders.swal.insufficient_inventory_text')}\n\n${list}`,
                    onConfirm: () => setSwal(null),
                });
            } else {
                toast.error(e instanceof Error ? e.message : t('orders.swal.update_failed'));
            }
        } finally {
            setItemUpdating(false);
        }
    };

    // ==================== Status update ====================
    const confirmUpdateStatus = (order: OrderRecord, newStatus: number) => {
        const label = getStatusLabel(newStatus);
        setSwal({
            type: 'question',
            title: t('orders.swal.update_status_title'),
            text: t('orders.swal.update_status_text', { orderNo: order.ORDER_NO, status: label }),
            showCancel: true,
            confirmText: t('orders.swal.confirm_update'),
            onConfirm: async () => {
                setSwal(null);
                setStatusSubmitting(true);
                try {
                    await updateOrderStatus(String(order.IDNo), newStatus);
                    await loadOrders();
                    if (detailOrder?.IDNo === order.IDNo) setDetailOrder({ ...order, STATUS: newStatus });
                    toast.success(t('orders.swal.updated_text', { orderNo: order.ORDER_NO, status: label }));
                } catch (e) {
                    toast.error(e instanceof Error ? e.message : t('orders.swal.update_failed'));
                } finally {
                    setStatusSubmitting(false);
                }
            },
            onCancel: () => setSwal(null),
        });
    };

    const openEncodedDtModal = (order: OrderRecord) => {
        setEncodedDtOrder(order);
        setEncodedDtValue(encodedDtToDatetimeLocalValue(order.ENCODED_DT));
    };

    const closeEncodedDtModal = () => {
        if (encodedDtSubmitting) return;
        setEncodedDtOrder(null);
        setEncodedDtValue('');
    };

    const saveEncodedDt = async () => {
        if (!encodedDtOrder) return;
        const encodedDt = datetimeLocalValueToEncodedDt(encodedDtValue);
        if (!encodedDt) {
            toast.error(t('orders.swal.encoded_dt_invalid'));
            return;
        }
        setEncodedDtSubmitting(true);
        try {
            const result = await updateOrderEncodedDt(String(encodedDtOrder.IDNo), encodedDt);
            const newOrderNo = result?.order_no || encodedDtOrder.ORDER_NO;
            toast.success(t('orders.swal.encoded_dt_updated', { orderNo: newOrderNo }));
            setEncodedDtOrder(null);
            setEncodedDtValue('');
            if (detailOrder?.IDNo === encodedDtOrder.IDNo) {
                setDetailOrder({ ...detailOrder, ENCODED_DT: encodedDt, ORDER_NO: newOrderNo });
            }
            await loadOrders();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('orders.swal.encoded_dt_failed'));
        } finally {
            setEncodedDtSubmitting(false);
        }
    };

    const confirmSoftDelete = (order: OrderRecord) => {
        setSwal({
            type: 'warning',
            title: t('orders.swal.soft_delete_title'),
            text: t('orders.swal.soft_delete_text', { orderNo: order.ORDER_NO }),
            showCancel: true,
            confirmText: t('orders.swal.soft_delete_confirm'),
            onConfirm: async () => {
                setSwal(null);
                setStatusSubmitting(true);
                try {
                    await softDeleteOrder(String(order.IDNo));
                    if (detailOrder?.IDNo === order.IDNo) closeDetail();
                    await loadOrders();
                    toast.success(t('orders.swal.soft_delete_success', { orderNo: order.ORDER_NO }));
                } catch (e) {
                    toast.error(e instanceof Error ? e.message : t('orders.swal.soft_delete_failed'));
                } finally {
                    setStatusSubmitting(false);
                }
            },
            onCancel: () => setSwal(null),
        });
    };

    // ==================== New order ====================
    const generateOrderNo = () => {
        const pad2 = (n: number) => String(n).padStart(2, '0');
        const d = new Date();
        return `ORD-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    };

    const openNewOrder = () => {
        setNewOrderNo(generateOrderNo());
        setNewOrderType('DINE_IN');
        setNewOrderItems([]);
        setNewOrderSelectedMenuId('');
        setNewOrderQty(1);
        setNewOrderTableId('');
        setNewOrderOpen(true);
    };

    const closeNewOrder = () => { if (newOrderSubmitting) return; setNewOrderOpen(false); };

    const openManualOrder = () => {
        setManualOrderNo(generateOrderNo());
        setManualOrderType('DINE_IN');
        setManualOrderItems([]);
        setManualMenuQuery('');
        setManualOrderTableId('');
        setManualRoomChargeQty(1);
        setManualPaymentMethod('CASH');
        setManualPaymentRef('');
        // Default: present date only (YYYY-MM-DD), time will be current timestamp.
        // Preserve user's previously selected date across multiple manual orders.
        if (!manualOrderDate) {
            // Use Asia/Manila for consistency with ENCODED_DT generation and filtering.
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Manila',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).formatToParts(now);
            const get = (type: string) => String(parts.find((p) => p.type === type)?.value ?? '0');
            const y = get('year');
            const m = get('month');
            const d = get('day');
            setManualOrderDate(`${y}-${m}-${d}`);
        }
        setManualDiscountAmount('0');
        setManualOrderBranchId('');
        setManualBranchTables([]);
        setManualOrderOpen(true);
    };

    const closeManualOrder = () => { if (manualOrderSubmitting) return; setManualOrderOpen(false); };

    // Branch options for manual order + receipt order (only when viewing ALL branches)
    useEffect(() => {
        if (!manualOrderOpen && !receiptOrderOpen) return;
        if (!isAllBranches) return;
        let cancelled = false;
        const fetchBranches = async () => {
            try {
                const res = await fetch('/branch/', {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(localStorage.getItem('token') ? { Authorization: `Bearer ${localStorage.getItem('token')}` } : {}),
                    },
                });
                const json = await res.json();
                if (!res.ok || json?.success === false) {
                    throw new Error(json?.error || json?.message || 'Failed to load branches');
                }
                const raw = json.data ?? json;
                const mapped = (Array.isArray(raw) ? raw : [])
                    .filter((b: any) => (b.ACTIVE ?? b.active ?? 1) === 1)
                    .map((b: any) => ({
                        value: String(b.IDNo ?? b.id),
                        label: String(b.BRANCH_LABEL ?? b.BRANCH_NAME ?? b.name ?? `Branch ${b.IDNo ?? ''}`),
                    }));
                if (!cancelled) setManualBranchOptions(mapped);
            } catch (e) {
                if (!cancelled) setManualBranchOptions([]);
                console.error('Failed to load branches for manual order', e);
            }
        };
        fetchBranches();
        return () => { cancelled = true; };
    }, [manualOrderOpen, receiptOrderOpen, isAllBranches]);

    const effectiveManualBranchId = isAllBranches ? manualOrderBranchId : branchId;
    const effectiveReceiptBranchId = isAllBranches ? receiptOrderBranchId : branchId;

    // Tables for selected branch (manual order)
    useEffect(() => {
        if (!manualOrderOpen) return;
        if (!effectiveManualBranchId) {
            setManualBranchTables([]);
            setManualBranchTablesRoomChargeById({});
            return;
        }
        let cancelled = false;
        const fetchTablesForManualBranch = async () => {
            try {
                const params = new URLSearchParams();
                if (effectiveManualBranchId && effectiveManualBranchId !== 'all') {
                    params.set('branch_id', effectiveManualBranchId);
                }
                const qs = params.toString();
                const res = await fetch(`/data-api/restaurant_tables${qs ? `?${qs}` : ''}`, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
                const json = await res.json();
                if (!res.ok) {
                    throw new Error(json.error || json.message || 'Failed to load tables');
                }
                const raw = json.data ?? json;
                const mapped: { value: string; label: string; floor: TableFloor | null }[] = (Array.isArray(raw) ? raw : [])
                    .filter((t: any) => t.STATUS === 1) // available only
                    .map((t: any) => ({
                        value: String(t.IDNo),
                        label: `Table ${t.TABLE_NUMBER}`,
                        floor: t.FLOOR === 'gf' || t.FLOOR === '2f' ? (t.FLOOR as TableFloor) : null,
                    }));
                const roomChargeById: Record<string, number> = {};
                for (const t of (Array.isArray(raw) ? raw : [])) {
                    if (t?.STATUS !== 1) continue;
                    const id = String(t?.IDNo);
                    if (!id) continue;
                    const rcRaw = t?.ROOM_CHARGE;
                    const rc =
                        rcRaw != null && rcRaw !== '' && !Number.isNaN(Number(rcRaw))
                            ? Number(rcRaw)
                            : 0;
                    roomChargeById[id] = rc;
                }

                if (!cancelled) {
                    setManualBranchTables(mapped);
                    setManualBranchTablesRoomChargeById(roomChargeById);
                }
            } catch (e) {
                if (!cancelled) setManualBranchTables([]);
                if (!cancelled) setManualBranchTablesRoomChargeById({});
                console.error('Failed to load tables for manual order', e);
            }
        };
        fetchTablesForManualBranch();
        return () => { cancelled = true; };
    }, [manualOrderOpen, effectiveManualBranchId]);

    // Menus for receipt → order (selected branch)
    useEffect(() => {
        if (!receiptOrderOpen) return;
        if (isAllBranches && !receiptOrderBranchId) {
            setReceiptOrderMenus([]);
            return;
        }
        let cancelled = false;
        setReceiptOrderMenusLoading(true);
        const bid = isAllBranches ? receiptOrderBranchId : branchId;
        getMenus(bid)
            .then((menus) => {
                if (cancelled) return;
                setReceiptOrderMenus((Array.isArray(menus) ? menus : []).filter((m) => m.active && (m.effectiveAvailable ?? m.isAvailable)));
            })
            .catch(() => { if (!cancelled) setReceiptOrderMenus([]); })
            .finally(() => { if (!cancelled) setReceiptOrderMenusLoading(false); });
        return () => { cancelled = true; };
    }, [receiptOrderOpen, isAllBranches, receiptOrderBranchId, branchId]);

    // Re-run automapping when menus load or multi-order extraction finishes (fixes wrong first-pass matches)
    useEffect(() => {
        if (!receiptOrderMenus.length || !receiptRows.length) return;
        setReceiptRows((prev) => {
            let changed = false;
            const next = prev.map((row) => {
                const qty = Number(row.qty) || 1;
                const match = matchReceiptLineToMenu(
                    row.extractedName,
                    Number(row.receiptLineTotal) || 0,
                    qty,
                    receiptOrderMenus
                );
                const nextId = match ? match.id : null;
                if (String(row.menuId ?? '') !== String(nextId ?? '')) {
                    changed = true;
                    return { ...row, menuId: nextId };
                }
                return row;
            });
            return changed ? next : prev;
        });
    }, [receiptOrderMenus, receiptExtractResult]);

    // Tables for receipt order modal
    useEffect(() => {
        if (!receiptOrderOpen) return;
        if (!effectiveReceiptBranchId || effectiveReceiptBranchId === 'all') {
            setReceiptBranchTables([]);
            return;
        }
        let cancelled = false;
        const fetchTables = async () => {
            try {
                const params = new URLSearchParams();
                params.set('branch_id', effectiveReceiptBranchId);
                const res = await fetch(`/data-api/restaurant_tables?${params}`, {
                    headers: { 'Content-Type': 'application/json' },
                });
                const json = await res.json();
                if (!res.ok) throw new Error(json.error || json.message || 'Failed to load tables');
                const raw = json.data ?? json;
                const mapped: { value: string; label: string; floor: TableFloor | null }[] = (Array.isArray(raw) ? raw : [])
                    .filter((t: any) => t.STATUS === 1)
                    .map((t: any) => ({
                        value: String(t.IDNo),
                        label: `Table ${t.TABLE_NUMBER}`,
                        floor: t.FLOOR === 'gf' || t.FLOOR === '2f' ? (t.FLOOR as TableFloor) : null,
                    }));
                if (!cancelled) setReceiptBranchTables(mapped);
            } catch (e) {
                if (!cancelled) setReceiptBranchTables([]);
                console.error('Failed to load tables for receipt order', e);
            }
        };
        fetchTables();
        return () => { cancelled = true; };
    }, [receiptOrderOpen, effectiveReceiptBranchId]);

    // Default room charge qty is always 1 when user selects a table.
    useEffect(() => {
        if (!manualOrderOpen) return;
        setManualRoomChargeQty(1);
    }, [manualOrderTableId, manualOrderOpen]);

    useEffect(() => {
        if (!newOrderOpen) return;
        let cancelled = false;
        setNewOrderLoadingRefs(true);
        getMenus(branchId)
            .then((menus) => {
                if (cancelled) return;
                setNewOrderMenus((Array.isArray(menus) ? menus : []).filter((m) => m.active && (m.effectiveAvailable ?? m.isAvailable)));
            })
            .catch(() => { if (!cancelled) setNewOrderMenus([]); })
            .finally(() => { if (!cancelled) setNewOrderLoadingRefs(false); });
        return () => { cancelled = true; };
    }, [newOrderOpen, branchId]);

    // Floor is a pure UI filter over branchTables (only meaningful for the
    // multi-floor branches) — it isn't sent with the order itself.
    const newOrderTableOptions = branchTables;
    const newOrderIsDineIn = isDineInOrderType(newOrderType);
    const newOrderFloor: TableFloor | '' =
        branchTables.find((t) => t.value === newOrderTableId)?.floor ?? '';

    const newOrderSubtotal = newOrderItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
    const newOrderTableRoomCharge =
        !!newOrderTableId && Object.prototype.hasOwnProperty.call(branchTablesRoomChargeById, newOrderTableId)
            ? Number(branchTablesRoomChargeById[newOrderTableId])
            : 0;
    const newOrderServiceCharge = hasDineInServiceCharge(branchId) && isDineInOrderType(newOrderType)
        ? tenPercentServiceCharge(newOrderSubtotal)
        : 0;
    const newOrderEstimatedGrandTotal = Number(
        (newOrderSubtotal + newOrderServiceCharge + (Number.isFinite(newOrderTableRoomCharge) ? newOrderTableRoomCharge : 0)).toFixed(2)
    );

    const addNewOrderItem = () => {
        if (!newOrderSelectedMenuId) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.select_item_title'),
                text: t('orders.swal.select_item_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        const qty = Number(newOrderQty);
        if (!Number.isFinite(qty) || qty <= 0) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.invalid_qty_title'),
                text: t('orders.swal.invalid_qty_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        const menu = newOrderMenus.find((m) => m.id === newOrderSelectedMenuId);
        if (!menu) return;
        setNewOrderItems((prev) => {
            const idx = prev.findIndex((p) => p.menuId === newOrderSelectedMenuId);
            if (idx >= 0) { const copy = [...prev]; copy[idx] = { ...copy[idx], qty: copy[idx].qty + qty }; return copy; }
            return [...prev, { menuId: newOrderSelectedMenuId, name: menu.name, unitPrice: Number(menu.price || 0), qty }];
        });
        setNewOrderSelectedMenuId(''); setNewOrderQty(1);
    };

    const removeNewOrderItem = (menuId: string) => setNewOrderItems((prev) => prev.filter((p) => p.menuId !== menuId));

    const submitNewOrder = async () => {
        if (!newOrderNo.trim()) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.order_no_required_title'),
                text: t('orders.swal.order_no_required_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        if (newOrderIsDineIn && !newOrderTableId) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.table_required_title'),
                text: t('orders.swal.table_required_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        if (newOrderItems.length === 0) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.add_items_title'),
                text: t('orders.swal.add_items_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        setNewOrderSubmitting(true);
        try {
            const items = newOrderItems.map((it) => ({ menu_id: Number(it.menuId), qty: Number(it.qty), unit_price: Number(it.unitPrice), line_total: Number(it.qty) * Number(it.unitPrice), status: ORDER_STATUS.PENDING }));
            await createOrder({
                ORDER_NO: newOrderNo.trim(), order_no: newOrderNo.trim(),
                BRANCH_ID: branchId, branch_id: branchId,
                TABLE_ID: newOrderIsDineIn && newOrderTableId ? Number(newOrderTableId) : null,
                ORDER_TYPE: newOrderType, order_type: newOrderType,
                STATUS: ORDER_STATUS.PENDING, SUBTOTAL: newOrderSubtotal,
                TAX_AMOUNT: 0,
                SERVICE_CHARGE: newOrderServiceCharge,
                DISCOUNT_AMOUNT: 0,
                GRAND_TOTAL: Number((newOrderSubtotal + newOrderServiceCharge).toFixed(2)),
                ORDER_ITEMS: items, items,
            });
            setNewOrderOpen(false);
            setNewOrderTableId('');
            await loadOrders();
            toast.success(t('orders.swal.created_text', { orderNo: newOrderNo.trim() }));
        } catch (e) {
            if (e instanceof InventoryInsufficientError && e.insufficient?.length) {
                const list = e.insufficient.map((i) => t('orders.swal.insufficient_inventory_item', {
                    name: i.ingredientName,
                    required: i.required,
                    available: i.available,
                    unit: i.unit,
                })).join('\n');
                setSwal({
                    type: 'warning',
                    title: t('orders.swal.insufficient_inventory_title'),
                    text: `${t('orders.swal.insufficient_inventory_text')}\n\n${list}`,
                    onConfirm: () => setSwal(null),
                });
            } else {
                toast.error(e instanceof Error ? e.message : t('orders.swal.create_failed'));
            }
        } finally {
            setNewOrderSubmitting(false);
        }
    };

    const receiptOrderDateTodayManila = () => {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(now);
        const get = (type: string) => String(parts.find((p) => p.type === type)?.value ?? '0');
        return `${get('year')}-${get('month')}-${get('day')}`;
    };

    const resetReceiptOrderForm = useCallback(() => {
        setReceiptOrderNo(generateOrderNo());
        setReceiptOrderType('DINE_IN');
        setReceiptOrderTableId('');
        setReceiptOrderBranchId('');
        setReceiptOrderDate(receiptOrderDateTodayManila());
        setReceiptImage(null);
        setReceiptSegments([]);
        setReceiptStitching(false);
        setReceiptExtracting(false);
        setReceiptError(null);
        setReceiptRows([]);
        setReceiptExtractResult(null);
        setReceiptMetaById({});
        setReceiptMapOpenByOrderId({});
        if (receiptFileInputRef.current) {
            receiptFileInputRef.current.value = '';
        }
        try {
            sessionStorage.removeItem(RECEIPT_DRAFT_KEY);
        } catch {
            // ignore
        }
    }, []);

    const openReceiptOrder = () => {
        resetReceiptOrderForm();
        setReceiptOrderOpen(true);
    };

    const closeReceiptOrder = () => {
        if (receiptSubmitting || receiptExtracting) return;
        resetReceiptOrderForm();
        setReceiptOrderOpen(false);
    };

    const runReceiptExtractionOnImage = async (compressedDataUrl: string) => {
        if (isAllBranches && !receiptOrderBranchId) {
            toast.error(t('orders.receipt_select_branch_first'));
            return;
        }
        setReceiptExtracting(true);
        setReceiptError(null);
        try {
            const result = await extractOrderLinesFromReceiptImage(compressedDataUrl, undefined, {
                orderDateYmd: receiptOrderDate?.trim() || undefined,
            });
            setReceiptExtractResult(result);
            const metaMap: Record<number, { orderNo: string; orderType: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'; tableNo?: string; tableId?: string }> = {};
            (result.orders || []).forEach((o) => {
                if (!o?.order_id) return;
                metaMap[o.order_id] = {
                    orderNo: String((o as any).order_no ?? '').trim() || generateOrderNo(),
                    orderType: ((o as any).order_type as any) || 'DINE_IN',
                    tableNo: String((o as any).table_no ?? '').trim() || '',
                };
            });
            setReceiptMetaById(metaMap);
            setReceiptMapOpenByOrderId({});
            const bid = isAllBranches ? receiptOrderBranchId : branchId;
            const menus =
                receiptOrderMenus.length > 0
                    ? receiptOrderMenus
                    : await getMenus(bid).then((m) =>
                          (Array.isArray(m) ? m : []).filter((x) => x.active && (x.effectiveAvailable ?? x.isAvailable))
                      );
            const rows = result.items
                .filter((item) => !looksLikeReceiptServiceChargeLine(item.item_name))
                .map((item, i) => {
                const qty = Number(item.quantity);
                const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
                const lineTotal = Number(item.line_price) || 0;
                const match = matchReceiptLineToMenu(item.item_name, lineTotal, q, menus);
                return {
                    id: `rec-${Date.now()}-${i}`,
                    extractedName: item.item_name,
                    menuSelection: item.menu_selection || '',
                    qty: q,
                    receiptLineTotal: lineTotal,
                    menuId: match ? match.id : null,
                    orderId: Number(item.order_id) > 0 ? Math.floor(Number(item.order_id)) : 1,
                };
            });
            setReceiptRows(rows);
        } catch (e) {
            setReceiptError(toUserFriendlyError(e));
            setReceiptRows([]);
            setReceiptExtractResult(null);
        } finally {
            setReceiptExtracting(false);
        }
    };

    const fileToDataUrl = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });

    const compressReceiptFileToJpegDataUrl = async (file: File): Promise<string> => {
        // Keep memory usage low on tablet camera captures to avoid browser tab reload/crash.
        try {
            const bmp: ImageBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            try {
                const w = bmp.width;
                const h = bmp.height;
                const MAX_W = 1600;
                const MAX_H = 12000;
                let scale = 1;
                if (w > MAX_W) scale = Math.min(scale, MAX_W / w);
                if (h > MAX_H) scale = Math.min(scale, MAX_H / h);
                const dw = Math.max(1, Math.round(w * scale));
                const dh = Math.max(1, Math.round(h * scale));
                const canvas = document.createElement('canvas');
                canvas.width = dw;
                canvas.height = dh;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    const dataUrl = await fileToDataUrl(file);
                    return await compressReceiptImage(dataUrl);
                }
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(bmp, 0, 0, dw, dh);
                try {
                    return canvas.toDataURL('image/jpeg', 0.92);
                } catch {
                    const dataUrl = await fileToDataUrl(file);
                    return await compressReceiptImage(dataUrl);
                }
            } finally {
                bmp.close();
            }
        } catch {
            const dataUrl = await fileToDataUrl(file);
            return await compressReceiptImage(dataUrl);
        }
    };

    const stitchImagesVertically = async (dataUrls: string[]): Promise<string> => {
        if (!dataUrls.length) throw new Error('No images to combine');
        if (dataUrls.length === 1) return dataUrls[0];
        const load = (url: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = url;
            });
        const images = await Promise.all(dataUrls.map((u) => load(u)));
        const targetW = Math.max(...images.map((i) => i.naturalWidth));
        const rowHeights = images.map((img) => Math.max(1, Math.round((img.naturalHeight * targetW) / img.naturalWidth)));
        const totalH = rowHeights.reduce((a, b) => a + b, 0);
        const MAX_CANVAS_PIXELS = 16_000_000;
        if (targetW * totalH > MAX_CANVAS_PIXELS) {
            throw new Error('Receipt image is too large to process on this device. Please capture shorter pages.');
        }
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = totalH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not create canvas');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, totalH);
        let y = 0;
        images.forEach((img, idx) => {
            const h = rowHeights[idx];
            ctx.drawImage(img, 0, y, targetW, h);
            y += h;
        });
        try {
            return canvas.toDataURL('image/jpeg', 0.92);
        } catch {
            return canvas.toDataURL('image/png');
        }
    };

    const stitchReceiptImagesViaApi = async (images: string[]): Promise<string> => {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/receiptscanner/stitch', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
                images,
                maxWidth: 1400,
                maxHeight: 8192,
                quality: 90,
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.success === false || !json?.data?.image) {
            throw new Error(json?.error || json?.message || 'Failed to stitch images');
        }
        return String(json.data.image);
    };

    const appendReceiptSegmentsFromFiles = async (files: File[]) => {
        if (isAllBranches && !receiptOrderBranchId) {
            toast.error(t('orders.receipt_select_branch_first'));
            return;
        }
        const candidates = (Array.isArray(files) ? files : []).filter((f) => f && f.type && f.type.startsWith('image/'));
        if (!candidates.length) {
            toast.error(t('orders.receipt_invalid_image'));
            return;
        }
        const room = Math.max(0, RECEIPT_MAX_PAGES - receiptSegments.length);
        const toProcess = candidates.slice(0, room);
        if (!toProcess.length) return;
        setReceiptError(null);
        setReceiptRows([]);
        setReceiptExtractResult(null);
        setReceiptImage(null);
        try {
            const newSegs: string[] = [];
            for (const file of toProcess) {
                // Process one image at a time to avoid peak memory spikes on low-RAM tablets.
                const seg = await compressReceiptFileToJpegDataUrl(file);
                newSegs.push(seg);
            }
            setReceiptSegments((prev) => [...prev, ...newSegs]);
        } catch (e) {
            toast.error(toUserFriendlyError(e));
        }
    };

    const removeReceiptSegment = (index: number) => {
        setReceiptSegments((prev) => prev.filter((_, i) => i !== index));
    };

    const finishReceiptScan = async () => {
        if (receiptSegments.length === 0) return;
        if (isAllBranches && !receiptOrderBranchId) {
            toast.error(t('orders.receipt_select_branch_first'));
            return;
        }
        setReceiptStitching(true);
        setReceiptExtracting(true);
        setReceiptError(null);
        try {
            let stitched = receiptSegments.length === 1 ? receiptSegments[0] : null;
            if (!stitched) {
                try {
                    stitched = await stitchReceiptImagesViaApi(receiptSegments);
                } catch {
                    stitched = await stitchImagesVertically(receiptSegments);
                }
            }
            // Segments are already compressed during capture; avoid extra recompress pass
            // to reduce memory spikes on low-RAM tablets.
            const compressed = stitched;
            setReceiptSegments([]);
            setReceiptImage(compressed);
            await runReceiptExtractionOnImage(compressed);
        } catch (e) {
            setReceiptError(toUserFriendlyError(e));
            setReceiptRows([]);
            setReceiptExtractResult(null);
        } finally {
            setReceiptStitching(false);
            setReceiptExtracting(false);
        }
    };

    const updateReceiptRowMenu = (rowId: string, menuId: string | null) => {
        setReceiptRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, menuId } : r)));
    };

    const updateReceiptRowQty = (rowId: string, qty: number) => {
        setReceiptRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, qty } : r)));
    };

    const receiptTableSelectOptions = isAllBranches ? receiptBranchTables : branchTables;

    const updateReceiptMeta = (
        orderId: number,
        patch: Partial<{ orderNo: string; orderType: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY'; tableNo?: string; tableId?: string }>
    ) =>
        setReceiptMetaById((prev) => ({
            ...prev,
            [orderId]: { ...(prev[orderId] ?? { orderNo: generateOrderNo(), orderType: 'DINE_IN', tableNo: '' }), ...patch },
        }));

    // Pre-select the table when the scanned table text matches a branch table
    // (e.g. "M8" ↔ "Table M 8"). Only runs once per order (tableId undefined).
    useEffect(() => {
        if (receiptTableSelectOptions.length === 0) return;
        const norm = (v: string) => v.toUpperCase().replace(/^TABLE\s*/, '').replace(/[^A-Z0-9]/g, '');
        let changed = false;
        const next = { ...receiptMetaById };
        for (const [key, meta] of Object.entries(receiptMetaById)) {
            if (meta.tableId !== undefined) continue;
            const scanned = norm(String(meta.tableNo ?? ''));
            const hit = scanned ? receiptTableSelectOptions.find((t) => norm(String(t.label)) === scanned) : undefined;
            next[Number(key)] = { ...meta, tableId: hit ? String(hit.value) : '' };
            changed = true;
        }
        if (changed) setReceiptMetaById(next);
    }, [receiptMetaById, receiptTableSelectOptions]);

    const receiptDetectedHasServiceCharge = useMemo(() => {
        const extractedItems = receiptExtractResult?.items;
        if (Array.isArray(extractedItems) && extractedItems.length) {
            for (const it of extractedItems) {
                if (looksLikeReceiptServiceChargeLine((it as any)?.item_name)) return true;
            }
        }
        for (const r of receiptRows) {
            if (looksLikeReceiptServiceChargeLine(r.extractedName)) return true;
        }
        return false;
    }, [receiptExtractResult?.items, receiptRows]);

    const receiptPreviewSubtotal = useMemo(() => {
        return receiptRows.reduce((sum, row) => {
            if (!row.menuId) return sum;
            const menu = receiptOrderMenus.find((m) => m.id === row.menuId);
            if (!menu) return sum;
            return sum + Number(row.qty) * Number(menu.price || 0);
        }, 0);
    }, [receiptRows, receiptOrderMenus]);

    const receiptRowsByOrder = useMemo(() => {
        const grouped = new Map<number, typeof receiptRows>();
        for (const row of receiptRows) {
            const key = Number.isFinite(row.orderId) && row.orderId > 0 ? Math.floor(row.orderId) : 1;
            const bucket = grouped.get(key);
            if (bucket) bucket.push(row);
            else grouped.set(key, [row]);
        }
        return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
    }, [receiptRows]);

    const receiptMenuIdSet = useMemo(
        () => new Set(receiptOrderMenus.map((m) => String(m.id))),
        [receiptOrderMenus]
    );

    const receiptUnmappedRows = useMemo(
        () =>
            receiptRows.filter((row) => {
                if (!row.menuId || !receiptMenuIdSet.has(String(row.menuId))) return true;
                return !isReceiptLineMappedToMenu(
                    row.extractedName,
                    Number(row.receiptLineTotal) || 0,
                    Number(row.qty) || 1,
                    row.menuId,
                    receiptOrderMenus
                );
            }),
        [receiptRows, receiptMenuIdSet, receiptOrderMenus]
    );

    const receiptPreviewServiceCharge = useMemo(() => {
        if (!hasDineInServiceCharge(effectiveReceiptBranchId)) return 0;
        if (receiptDetectedHasServiceCharge) return 0;
        return Number(
            receiptRowsByOrder
                .reduce((sum, [orderId, blockRows]) => {
                    const ot = receiptMetaById[orderId]?.orderType ?? receiptOrderType;
                    if (!isDineInOrderType(ot)) return sum;
                    const blockSubtotal = blockRows.reduce((s, row) => {
                        if (!row.menuId) return s;
                        const menu = receiptOrderMenus.find((m) => m.id === row.menuId);
                        if (!menu) return s;
                        return s + Number(row.qty) * Number(menu.price || 0);
                    }, 0);
                    return sum + tenPercentServiceCharge(blockSubtotal);
                }, 0)
                .toFixed(2)
        );
    }, [effectiveReceiptBranchId, receiptDetectedHasServiceCharge, receiptMetaById, receiptOrderMenus, receiptOrderType, receiptRowsByOrder]);

    const receiptPreviewTotalDue = useMemo(() => {
        return Number((receiptPreviewSubtotal + receiptPreviewServiceCharge).toFixed(2));
    }, [receiptPreviewSubtotal, receiptPreviewServiceCharge]);

    // Receipt-based totals (same as tablet UI): computed from extracted receipt line totals.
    const receiptPreviewReceiptTotal = useMemo(() => {
        if (receiptExtractResult?.orders?.length) {
            return receiptExtractResult.orders.reduce((sum, o) => sum + Number(o.order_total_amount || 0), 0);
        }
        return receiptRowsByOrder.reduce((sum, [, blockRows]) => sum + blockRows.reduce((s, r) => s + Number(r.receiptLineTotal || 0), 0), 0);
    }, [receiptExtractResult?.orders, receiptRowsByOrder]);

    const receiptPreviewServiceChargeReceipt = useMemo(() => {
        if (!hasDineInServiceCharge(effectiveReceiptBranchId)) return 0;
        if (receiptDetectedHasServiceCharge) return 0;
        if (receiptExtractResult?.orders?.length) {
            return Number(
                receiptExtractResult.orders
                    .reduce((sum, o) => {
                        const ot = receiptMetaById[o.order_id]?.orderType ?? receiptOrderType;
                        if (!isDineInOrderType(ot)) return sum;
                        return sum + tenPercentServiceCharge(Number(o.order_total_amount || 0));
                    }, 0)
                    .toFixed(2)
            );
        }
        return Number(
            receiptRowsByOrder
                .reduce((sum, [orderId, blockRows]) => {
                    const ot = receiptMetaById[orderId]?.orderType ?? receiptOrderType;
                    if (!isDineInOrderType(ot)) return sum;
                    const blockTotal = blockRows.reduce((s, r) => s + Number(r.receiptLineTotal || 0), 0);
                    return sum + tenPercentServiceCharge(blockTotal);
                }, 0)
                .toFixed(2)
        );
    }, [effectiveReceiptBranchId, receiptDetectedHasServiceCharge, receiptExtractResult?.orders, receiptMetaById, receiptOrderType, receiptRowsByOrder]);

    const receiptPreviewTotalDueReceipt = useMemo(() => {
        return Number((receiptPreviewReceiptTotal + receiptPreviewServiceChargeReceipt).toFixed(2));
    }, [receiptPreviewReceiptTotal, receiptPreviewServiceChargeReceipt]);

    const loadReceiptHistory = useCallback(async () => {
        setReceiptHistoryLoading(true);
        try {
            const bid = isAllBranches ? 'all' : branchId;
            const rows = await fetchReceiptScanHistoryList(bid, 500, {
                sources: ['resto_admin', 'receiptlens'],
            });
            setReceiptHistoryRows(Array.isArray(rows) ? rows : []);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('orders.failed_to_load'));
            setReceiptHistoryRows([]);
        } finally {
            setReceiptHistoryLoading(false);
        }
    }, [branchId, isAllBranches, t]);

    useEffect(() => {
        if (receiptDraftHydratedRef.current) return;
        receiptDraftHydratedRef.current = true;
        try {
            const raw = sessionStorage.getItem(RECEIPT_DRAFT_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as {
                savedAt?: number;
                receiptOrderOpen?: boolean;
                receiptOrderNo?: string;
                receiptOrderType?: 'DINE_IN' | 'TAKE_OUT' | 'DELIVERY';
                receiptOrderTableId?: string;
                receiptOrderBranchId?: string;
                receiptOrderDate?: string;
                receiptImage?: string | null;
                receiptSegments?: string[];
                receiptRows?: typeof receiptRows;
                receiptExtractResult?: ReceiptOrderExtractionResult | null;
                receiptMetaById?: typeof receiptMetaById;
                receiptMapOpenByOrderId?: typeof receiptMapOpenByOrderId;
            };
            const ageMs = Date.now() - Number(parsed.savedAt || 0);
            if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 45 * 60 * 1000) {
                sessionStorage.removeItem(RECEIPT_DRAFT_KEY);
                return;
            }
            if (!parsed.receiptOrderOpen) return;
            setReceiptOrderNo(String(parsed.receiptOrderNo || generateOrderNo()));
            setReceiptOrderType(parsed.receiptOrderType || 'DINE_IN');
            setReceiptOrderTableId(String(parsed.receiptOrderTableId || ''));
            setReceiptOrderBranchId(String(parsed.receiptOrderBranchId || ''));
            setReceiptOrderDate(String(parsed.receiptOrderDate || ''));
            setReceiptImage(parsed.receiptImage ?? null);
            setReceiptSegments(Array.isArray(parsed.receiptSegments) ? parsed.receiptSegments : []);
            setReceiptRows(Array.isArray(parsed.receiptRows) ? parsed.receiptRows : []);
            setReceiptExtractResult(parsed.receiptExtractResult ?? null);
            setReceiptMetaById(parsed.receiptMetaById && typeof parsed.receiptMetaById === 'object' ? parsed.receiptMetaById : {});
            setReceiptMapOpenByOrderId(
                parsed.receiptMapOpenByOrderId && typeof parsed.receiptMapOpenByOrderId === 'object'
                    ? parsed.receiptMapOpenByOrderId
                    : {}
            );
            setReceiptOrderOpen(true);
            toast.message('Restored previous receipt scan draft.');
        } catch {
            // ignore draft restore errors
        }
    }, []);

    useEffect(() => {
        if (!receiptOrderOpen) return;
        if (receiptSubmitting) return;
        const hasDraftWork = receiptSegments.length > 0 || !!receiptImage || receiptRows.length > 0;
        if (!hasDraftWork) {
            try {
                sessionStorage.removeItem(RECEIPT_DRAFT_KEY);
            } catch {
                // ignore
            }
            return;
        }
        const payload = {
            savedAt: Date.now(),
            receiptOrderOpen,
            receiptOrderNo,
            receiptOrderType,
            receiptOrderTableId,
            receiptOrderBranchId,
            receiptOrderDate,
            receiptImage,
            receiptSegments,
            receiptRows,
            receiptExtractResult,
            receiptMetaById,
            receiptMapOpenByOrderId,
        };
        try {
            sessionStorage.setItem(RECEIPT_DRAFT_KEY, JSON.stringify(payload));
        } catch {
            // If storage is full or unavailable, skip draft save.
        }
    }, [
        receiptOrderOpen,
        receiptSubmitting,
        receiptOrderNo,
        receiptOrderType,
        receiptOrderTableId,
        receiptOrderBranchId,
        receiptOrderDate,
        receiptImage,
        receiptSegments,
        receiptRows,
        receiptExtractResult,
        receiptMetaById,
        receiptMapOpenByOrderId,
    ]);

    const openReceiptHistoryPanel = () => {
        setReceiptHistoryOpen(true);
        void loadReceiptHistory();
    };

    const openReceiptHistoryDetail = async (id: number) => {
        setReceiptHistoryDetailOpen(true);
        setReceiptHistoryDetailLoading(true);
        setReceiptHistoryDetail(null);
        try {
            const row = await fetchReceiptScanHistoryById(id);
            setReceiptHistoryDetail(row);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('orders.failed_to_load'));
            setReceiptHistoryDetailOpen(false);
        } finally {
            setReceiptHistoryDetailLoading(false);
        }
    };

    // Same calendar range as the orders table (header date picker) so May/June rows do not appear when July is selected.
    const filteredReceiptHistory = useMemo(() => {
        return receiptHistoryRows.filter((r) => {
            if (!isOrdersReceiptScanHistorySource(receiptScanHistoryRowSource(r))) return false;
            // Only scans that were sent to Orders (linked order); skip abandoned preview-only rows.
            if (r.ORDER_ID == null) return false;
            return isWithinDateRange(r.ENCODED_DT, r.BRANCH_ID);
        });
    }, [receiptHistoryRows, isWithinDateRange]);

    const submitReceiptOrder = async () => {
        if (isAllBranches && !receiptOrderBranchId) {
            toast.error(t('orders.receipt_select_branch_first'));
            return;
        }
        if (receiptUnmappedRows.length > 0) {
            const itemList = receiptUnmappedRows
                .map((r) => `• ${r.extractedName || t('orders.receipt_unmapped_unknown_item')}`)
                .join('\n');
            setReceiptMapOpenByOrderId((prev) => {
                const next = { ...prev };
                for (const row of receiptUnmappedRows) {
                    const oid = Number.isFinite(row.orderId) && row.orderId > 0 ? Math.floor(row.orderId) : 1;
                    next[oid] = true;
                }
                return next;
            });
            setSwal({
                type: 'warning',
                title: t('orders.receipt_no_menu_mapped_title'),
                text: t('orders.receipt_no_menu_mapped_text', { items: itemList }),
                onConfirm: () => setSwal(null),
            });
            return;
        }
        const missingTableOrders = receiptRowsByOrder
            .map(([orderId]) => orderId)
            .filter((orderId) => {
                const meta = receiptMetaById[orderId];
                return isDineInOrderType(meta?.orderType ?? 'DINE_IN') && !meta?.tableId;
            });
        if (missingTableOrders.length > 0) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.table_required_title'),
                text: `${t('orders.swal.table_required_text')} (${missingTableOrders.map((id) => `ORDER ${id}`).join(', ')})`,
                onConfirm: () => setSwal(null),
            });
            return;
        }
        const resolvedBranch = isAllBranches ? receiptOrderBranchId : branchId;
        setReceiptSubmitting(true);
        try {
            const encodedDt = encodedDtPickerDateManilaNow(receiptOrderDate);

            // Fresh menu list — avoids empty/stale state if user saves before useEffect finishes loading menus.
            const menuList = await getMenus(resolvedBranch).then((m) =>
                (Array.isArray(m) ? m : []).filter((x) => x.active && (x.effectiveAvailable ?? x.isAvailable))
            );
            const byOrder = new Map<number, typeof receiptRows>();
            for (const row of receiptRows) {
                const key = Number.isFinite(row.orderId) && row.orderId > 0 ? Math.floor(row.orderId) : 1;
                const bucket = byOrder.get(key);
                if (bucket) bucket.push(row);
                else byOrder.set(key, [row]);
            }

            const createdOrderIds: number[] = [];
            const createdOrderNos: string[] = [];

            for (const [orderId, blockRows] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
                const merged = new Map<string, NewOrderItem>();
                for (const row of blockRows) {
                    if (!row.menuId) continue;
                    const menu = menuList.find((m) => String(m.id) === String(row.menuId));
                    if (!menu) continue;
                    const qty = Number(row.qty);
                    if (!Number.isFinite(qty) || qty <= 0) continue;
                    const unitPrice = Number(menu.price || 0);
                    const prev = merged.get(String(row.menuId));
                    if (prev) merged.set(String(row.menuId), { ...prev, qty: prev.qty + qty });
                    else merged.set(String(row.menuId), { menuId: String(row.menuId), name: menu.name, unitPrice, qty });
                }
                if (merged.size === 0) continue;
                const builtItems = Array.from(merged.values());
                const subtotal = builtItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);
                const items = builtItems.map((it) => ({
                    menu_id: Number(it.menuId),
                    qty: Number(it.qty),
                    unit_price: Number(it.unitPrice),
                    line_total: Number(it.qty) * Number(it.unitPrice),
                    status: ORDER_STATUS.PENDING,
                }));
                const meta = receiptMetaById[orderId];
                const orderNo = meta?.orderNo && meta.orderNo.trim() ? meta.orderNo.trim() : generateOrderNo();
                const orderType = meta?.orderType ?? receiptOrderType;
                const shouldAutoAddServiceCharge =
                    hasDineInServiceCharge(resolvedBranch) &&
                    isDineInOrderType(orderType) &&
                    !receiptDetectedHasServiceCharge;
                const serviceCharge = shouldAutoAddServiceCharge
                    ? tenPercentServiceCharge(subtotal)
                    : 0;

                const created = await createManualSettledOrder({
                    ORDER_NO: orderNo,
                    order_no: orderNo,
                    BRANCH_ID: resolvedBranch,
                    branch_id: resolvedBranch,
                    TABLE_ID: isDineInOrderType(orderType) && meta?.tableId ? Number(meta.tableId) : null,
                    ORDER_TYPE: orderType,
                    order_type: orderType,
                    ENCODED_DT: encodedDt,
                    STATUS: ORDER_STATUS.SETTLED,
                    SUBTOTAL: subtotal,
                    TAX_AMOUNT: 0,
                    SERVICE_CHARGE: serviceCharge,
                    DISCOUNT_AMOUNT: 0,
                    GRAND_TOTAL: subtotal,
                    ORDER_ITEMS: items,
                    items,
                    payment_method: 'CASH',
                    payment_ref: 'Receipt scan auto-settled',
                    PAYMENT_METHOD: 'CASH',
                    PAYMENT_REF: 'Receipt scan auto-settled',
                });
                if (created?.id != null) {
                    createdOrderIds.push(Number(created.id));
                    createdOrderNos.push(orderNo);
                }
            }

            // Save one receipt-scan history row per created order (reuse same uploaded image path).
            try {
                const firstOrderId = createdOrderIds[0] ?? null;
                let receiptImagePath: string | null = null;
                if (firstOrderId != null) {
                    const first = await saveReceiptScanHistory({
                        branch_id: String(resolvedBranch),
                        order_id: firstOrderId,
                        encoded_dt: encodedDt,
                        receipt_grand_total: receiptExtractResult?.receipt_grand_total ?? null,
                        receipt_image_data_url: receiptImage,
                    });
                    receiptImagePath = (first as any)?.receipt_image_path ?? null;
                }
                for (const oid of createdOrderIds.slice(1)) {
                    await saveReceiptScanHistory({
                        branch_id: String(resolvedBranch),
                        order_id: oid,
                        encoded_dt: encodedDt,
                        receipt_grand_total: receiptExtractResult?.receipt_grand_total ?? null,
                        receipt_image_path: receiptImagePath,
                    });
                }
            } catch {
                toast.warning(t('orders.receipt_history_save_failed'));
            }

            resetReceiptOrderForm();
            setReceiptOrderOpen(false);
            await loadOrders();
            toast.success(
                createdOrderNos.length > 1
                    ? `Created ${createdOrderNos.length} orders from receipt`
                    : t('orders.swal.created_text', { orderNo: createdOrderNos[0] ?? receiptOrderNo.trim() })
            );
        } catch (e) {
            if (e instanceof InventoryInsufficientError && e.insufficient?.length) {
                const list = e.insufficient
                    .map((i) =>
                        t('orders.swal.insufficient_inventory_item', {
                            name: i.ingredientName,
                            required: i.required,
                            available: i.available,
                            unit: i.unit,
                        })
                    )
                    .join('\n');
                setSwal({
                    type: 'warning',
                    title: t('orders.swal.insufficient_inventory_title'),
                    text: `${t('orders.swal.insufficient_inventory_text')}\n\n${list}`,
                    onConfirm: () => setSwal(null),
                });
            } else {
                toast.error(e instanceof Error ? e.message : t('orders.swal.create_failed'));
            }
        } finally {
            setReceiptSubmitting(false);
        }
    };

    useEffect(() => {
        if (!manualOrderOpen) return;
        if (!effectiveManualBranchId) {
            setManualOrderMenus([]);
            return;
        }
        let cancelled = false;
        setManualOrderLoadingRefs(true);
        getMenus(effectiveManualBranchId)
            .then((menus) => {
                if (cancelled) return;
                setManualOrderMenus((Array.isArray(menus) ? menus : []).filter((m) => m.active && (m.effectiveAvailable ?? m.isAvailable)));
            })
            .catch(() => { if (!cancelled) setManualOrderMenus([]); })
            .finally(() => { if (!cancelled) setManualOrderLoadingRefs(false); });
        return () => { cancelled = true; };
    }, [manualOrderOpen, effectiveManualBranchId]);

    // Table source switches between manualBranchTables / branchTables depending on
    // whether the modal has its own branch picker (All Branches view). Floor is
    // read-only and derived from the selected table (dine-in only).
    const manualOrderTableOptions = isAllBranches ? manualBranchTables : branchTables;
    const manualOrderIsDineIn = isDineInOrderType(manualOrderType);
    const manualOrderFloor: TableFloor | '' =
        manualOrderTableOptions.find((t) => t.value === manualOrderTableId)?.floor ?? '';

    const manualOrderSubtotal = manualOrderItems.reduce((sum, it) => sum + it.qty * it.unitPrice, 0);

    const MANUAL_ROOM_CHARGE_ITEM_ID = '__ROOM_CHARGE__';
    const roundToHalf = (v: number) => Math.round(v * 2) / 2;
    const manualRoomCharge = !!manualOrderTableId && Object.prototype.hasOwnProperty.call(manualBranchTablesRoomChargeById, manualOrderTableId)
        ? Number(manualBranchTablesRoomChargeById[manualOrderTableId])
        : 0;
    const hasManualRoomChargeRow = !!manualOrderTableId && Number.isFinite(manualRoomCharge) && manualRoomCharge > 0;
    const manualDisplayOrderItems: NewOrderItem[] = hasManualRoomChargeRow
        ? [
            {
                menuId: MANUAL_ROOM_CHARGE_ITEM_ID,
                name: t('table.room_charge'),
                unitPrice: manualRoomCharge,
                qty: manualRoomChargeQty,
            },
            ...manualOrderItems,
        ]
        : manualOrderItems;
    const manualServiceCharge = hasDineInServiceCharge(effectiveManualBranchId) && isDineInOrderType(manualOrderType)
        ? tenPercentServiceCharge(manualOrderSubtotal)
        : 0;
    const manualGrandTotalBase =
        manualOrderSubtotal +
        (hasManualRoomChargeRow ? manualRoomChargeQty * manualRoomCharge : 0) +
        manualServiceCharge;
    const manualDiscountNumber = (() => {
        const n = parseFloat(String(manualDiscountAmount ?? '').trim());
        return Number.isFinite(n) ? n : 0;
    })();
    const manualDiscountApplied = Math.max(0, manualDiscountNumber);
    const manualGrandTotalPreview = Math.max(0, manualGrandTotalBase - manualDiscountApplied);

    const addManualMenuById = (menuId: string, qtyToAdd = 1) => {
        const menu = manualOrderMenus.find((m) => m.id === menuId);
        if (!menu) return;
        const qty = Number(qtyToAdd);
        if (!Number.isFinite(qty) || qty <= 0) return;
        setManualOrderItems((prev) => {
            const idx = prev.findIndex((p) => p.menuId === menuId);
            if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { ...copy[idx], qty: Math.max(1, copy[idx].qty + qty) };
                return copy;
            }
            return [{ menuId, name: menu.name, unitPrice: Number(menu.price || 0), qty }, ...prev];
        });
        // Briefly highlight the affected row so users can track what was just added.
        setManualRowFlash({ menuId, nonce: Date.now() });
    };

    const removeManualOrderItem = (menuId: string) => setManualOrderItems((prev) => prev.filter((p) => p.menuId !== menuId));
    const decManualOrderItemQty = (menuId: string) =>
        setManualOrderItems((prev) => {
            const idx = prev.findIndex((p) => p.menuId === menuId);
            if (idx < 0) return prev;
            const nextQty = (prev[idx].qty || 1) - 1;
            if (nextQty <= 0) return prev.filter((p) => p.menuId !== menuId);
            const copy = [...prev];
            copy[idx] = { ...copy[idx], qty: nextQty };
            return copy;
        });

    const filteredManualMenus = useMemo(() => {
        const q = manualMenuQuery.trim().toLowerCase();
        const base = (Array.isArray(manualOrderMenus) ? manualOrderMenus : [])
            .filter((m) => m.active && (m.effectiveAvailable ?? m.isAvailable));
        if (!q) return base;
        return base.filter((m) => String(m.name || '').toLowerCase().includes(q));
    }, [manualMenuQuery, manualOrderMenus]);

    const MANUAL_MENU_PAGE_SIZE = 20;
    const manualMenuTotalPages = useMemo(
        () => Math.max(1, Math.ceil(filteredManualMenus.length / MANUAL_MENU_PAGE_SIZE)),
        [filteredManualMenus.length]
    );
    const paginatedManualMenus = useMemo(() => {
        const page = Math.min(Math.max(1, manualMenuPage), manualMenuTotalPages);
        const start = (page - 1) * MANUAL_MENU_PAGE_SIZE;
        return filteredManualMenus.slice(start, start + MANUAL_MENU_PAGE_SIZE);
    }, [filteredManualMenus, manualMenuPage, manualMenuTotalPages]);

    useEffect(() => {
        setManualMenuPage(1);
    }, [manualOrderOpen, manualMenuQuery, effectiveManualBranchId]);

    useEffect(() => {
        setManualMenuPage((prev) => Math.min(prev, manualMenuTotalPages));
    }, [manualMenuTotalPages]);

    useEffect(() => {
        if (!manualRowFlash) return;
        const timer = window.setTimeout(() => setManualRowFlash(null), 900);
        return () => window.clearTimeout(timer);
    }, [manualRowFlash]);

    const submitManualOrder = async () => {
        if (isAllBranches && !manualOrderBranchId) {
            setSwal({
                type: 'warning',
                title: t('header.select_branch'),
                text: t('categories.messages.select_branch'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        if (!manualOrderNo.trim()) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.order_no_required_title'),
                text: t('orders.swal.order_no_required_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        if (manualOrderIsDineIn && !manualOrderTableId) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.table_required_title'),
                text: t('orders.swal.table_required_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        // Allow creating the order when room charge exists (room charge is injected separately)
        // so the user can proceed even if the manual items list is empty — unless qty is 0 (waived).
        if (manualOrderItems.length === 0 && (!hasManualRoomChargeRow || manualRoomChargeQty <= 0)) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.add_items_title'),
                text: t('orders.swal.add_items_text'),
                onConfirm: () => setSwal(null)
            });
            return;
        }
        setManualOrderSubmitting(true);
        try {
            const encodedDt = encodedDtPickerDateManilaNow(manualOrderDate);

            const items = manualOrderItems.map((it) => ({ menu_id: Number(it.menuId), qty: Number(it.qty), unit_price: Number(it.unitPrice), line_total: Number(it.qty) * Number(it.unitPrice), status: ORDER_STATUS.PENDING }));
            // Backend always adds table ROOM_CHARGE once.
            // To make qty > 1 work, we add extra service charge: (qty - 1) * roomCharge
            // so final becomes: roomCharge + extra = qty * roomCharge.
            const roomChargeAdditionalService =
                hasManualRoomChargeRow ? (manualRoomChargeQty - 1) * manualRoomCharge : 0;
            const manualGrandTotal = Math.max(0, manualGrandTotalPreview);
            const created = await createManualSettledOrder({
                ORDER_NO: manualOrderNo.trim(), order_no: manualOrderNo.trim(),
                BRANCH_ID: effectiveManualBranchId, branch_id: effectiveManualBranchId,
                TABLE_ID: manualOrderIsDineIn && manualOrderTableId ? Number(manualOrderTableId) : null,
                ORDER_TYPE: manualOrderType, order_type: manualOrderType,
                ENCODED_DT: encodedDt,
                STATUS: ORDER_STATUS.SETTLED,
                SUBTOTAL: manualOrderSubtotal,
                TAX_AMOUNT: 0,
                SERVICE_CHARGE: roomChargeAdditionalService + manualServiceCharge,
                DISCOUNT_AMOUNT: manualDiscountApplied,
                GRAND_TOTAL: manualGrandTotal,
                ORDER_ITEMS: items, items,
                // Keep both lower/upper-case keys for compatibility with backend.
                payment_method: manualPaymentMethod,
                payment_ref: manualPaymentRef?.trim() ? manualPaymentRef.trim() : null,
                PAYMENT_METHOD: manualPaymentMethod,
                PAYMENT_REF: manualPaymentRef?.trim() ? manualPaymentRef.trim() : null,
            });
            setManualOrderOpen(false);
            setManualOrderTableId('');

            // After creating/settling, clear local filters so the new record is visible.
            // (If user is filtering by PENDING, a SETTLED manual order would be hidden.)
            setSearchTerm('');
            setStatusFilter('all');

            await loadOrders();

            // Workaround: if the list endpoint (`getOrders`) doesn't include
            // newly-created manual-settled orders yet, ensure the specific order
            // is inserted into the current table state.
            if (created?.id != null) {
                try {
                    const createdOrder = await getOrderById(String(created.id));
                    if (createdOrder) {
                        setOrders((prev) => {
                            if (prev.some((o) => Number(o.IDNo) === Number(createdOrder.IDNo))) return prev;
                            return [createdOrder, ...prev];
                        });
                    }
                } catch {
                    // Ignore; table will still update after `loadOrders()` in the common case.
                }
            }
            toast.success(t('orders.swal.manual_created_text', { orderNo: manualOrderNo.trim() }));
        } catch (e) {
            if (e instanceof InventoryInsufficientError && e.insufficient?.length) {
                const list = e.insufficient.map((i) => t('orders.swal.insufficient_inventory_item', {
                    name: i.ingredientName,
                    required: i.required,
                    available: i.available,
                    unit: i.unit,
                })).join('\n');
                setSwal({
                    type: 'warning',
                    title: t('orders.swal.insufficient_inventory_title'),
                    text: `${t('orders.swal.insufficient_inventory_text')}\n\n${list}`,
                    onConfirm: () => setSwal(null),
                });
            } else {
                toast.error(e instanceof Error ? e.message : t('orders.swal.create_failed'));
            }
        } finally {
            setManualOrderSubmitting(false);
        }
    };

    // Load menus for adding items to existing order (detail modal)
    useEffect(() => {
        if (!detailOrder) {
            setDetailMenus([]);
            setDetailSelectedMenuId('');
            setDetailAddQty(1);
            return;
        }
        // Allow adding items when order is PENDING or CONFIRMED (not settled/cancelled)
        if (detailOrder.STATUS === ORDER_STATUS.SETTLED || detailOrder.STATUS === ORDER_STATUS.CANCELLED) return;
        let cancelled = false;
        setDetailMenusLoading(true);
        getMenus(branchId)
            .then((menus) => {
                if (cancelled) return;
                setDetailMenus((Array.isArray(menus) ? menus : []).filter((m) => m.active && (m.effectiveAvailable ?? m.isAvailable)));
            })
            .catch(() => {
                if (!cancelled) setDetailMenus([]);
            })
            .finally(() => {
                if (!cancelled) setDetailMenusLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [detailOrder, branchId]);

    // Clear add-item selection if the selected menu is already in the order (use edit qty instead)
    useEffect(() => {
        if (detailSelectedMenuId && detailItems.some((it) => Number(it.MENU_ID) === Number(detailSelectedMenuId))) {
            setDetailSelectedMenuId('');
        }
    }, [detailItems, detailSelectedMenuId]);

    const addDetailOrderItem = async () => {
        if (!detailOrder) return;
        if (detailOrder.STATUS === ORDER_STATUS.SETTLED || detailOrder.STATUS === ORDER_STATUS.CANCELLED) {
            toast.error(t('orders.additional_items_not_allowed'));
            return;
        }
        if (!detailSelectedMenuId) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.select_item_title'),
                text: t('orders.swal.select_item_text'),
                onConfirm: () => setSwal(null),
            });
            return;
        }
        const qty = Number(detailAddQty);
        if (!Number.isFinite(qty) || qty <= 0) {
            setSwal({
                type: 'warning',
                title: t('orders.swal.invalid_qty_title'),
                text: t('orders.swal.invalid_qty_text'),
                onConfirm: () => setSwal(null),
            });
            return;
        }
        const menu = detailMenus.find((m) => m.id === detailSelectedMenuId);
        if (!menu) return;
        const payloadItems: CreateOrderItemPayload[] = [
            {
                menu_id: Number(menu.id),
                qty,
                unit_price: Number(menu.price || 0),
                line_total: Number(qty) * Number(menu.price || 0),
                status: ORDER_STATUS.PENDING,
            },
        ];
        setDetailAdding(true);
        try {
            await addItemsToOrder(String(detailOrder.IDNo), payloadItems);
            const [refreshed, updatedOrder] = await Promise.all([
                getOrderItems(String(detailOrder.IDNo)),
                getOrderById(String(detailOrder.IDNo)),
            ]);
            setDetailItems(refreshed);
            if (updatedOrder) setDetailOrder(updatedOrder);
            await loadOrders();
            toast.success(t('orders.additional_items_added_success'));
            setDetailSelectedMenuId('');
            setDetailAddQty(1);
        } catch (e) {
            if (e instanceof InventoryInsufficientError && e.insufficient?.length) {
                const list = e.insufficient
                    .map((i) =>
                        t('orders.swal.insufficient_inventory_item', {
                            name: i.ingredientName,
                            required: i.required,
                            available: i.available,
                            unit: i.unit,
                        })
                    )
                    .join('\n');
                setSwal({
                    type: 'warning',
                    title: t('orders.swal.insufficient_inventory_title'),
                    text: `${t('orders.swal.insufficient_inventory_text')}\n\n${list}`,
                    onConfirm: () => setSwal(null),
                });
            } else {
                toast.error(e instanceof Error ? e.message : t('orders.swal.update_failed'));
            }
        } finally {
            setDetailAdding(false);
        }
    };

    // ==================== Badges ====================
    const statusBadge = (status: number) => {
        const label = getStatusLabel(status);
        const style = status === ORDER_STATUS.SETTLED ? 'bg-green-100 text-green-600' : status === ORDER_STATUS.CANCELLED ? 'bg-red-100 text-red-600' : status === ORDER_STATUS.CONFIRMED ? 'bg-blue-100 text-blue-600' : 'bg-orange-100 text-orange-600';
        return <span className={cn('text-xs font-bold px-2 py-1 rounded-lg', style)}>{label}</span>;
    };

    const orderTypeBadge = (orderType: string | null | undefined) => {
        if (!orderType) return <span className="text-brand-muted text-sm">—</span>;
        const normalized = orderType.trim().toUpperCase().replace(/\s+/g, '_');
        const label = normalized === 'DINE_IN' ? t('orders.dine_in') : normalized === 'TAKE_OUT' ? t('orders.take_out') : normalized === 'DELIVERY' ? t('orders.delivery') : orderType;
        return <span className="text-xs font-bold bg-gray-100 px-2 py-1 rounded-lg">{label}</span>;
    };

    // ==================== Table columns ====================
    const columns: ColumnDef<OrderRecord>[] = useMemo(() => [
        {
            header: t('orders.order_no'),
            render: (order) => (
                <div className="flex items-center gap-3 min-w-[160px]">
                    <Receipt size={16} className="text-brand-muted shrink-0" />
                    <div className="min-w-0">
                        <p className="text-sm font-bold">{order.ORDER_NO}</p>
                        <p className="text-[10px] text-brand-muted">
                            {formatEncodedDt(order.ENCODED_DT)}
                        </p>
                    </div>
                </div>
            ),
        },
        {
            header: t('orders.table'),
            render: (order) => <span className="text-sm font-bold">{order.TABLE_NUMBER ?? '—'}</span>,
        },
        {
            header: t('orders.type'),
            render: (order) => orderTypeBadge(order.ORDER_TYPE),
        },
        {
            header: t('orders.status'),
            render: (order) => statusBadge(order.STATUS),
        },
        {
            header: t('orders.grand_total'),
            render: (order) => (
                <span className="text-sm font-bold text-brand-text tabular-nums">
                    ₱{formatPesoUpToTwoDecimals(Number(order.GRAND_TOTAL))}
                </span>
            ),
        },
        {
            header: t('orders.actions'),
            className: 'text-right',
            render: (order) => (
                <div className="flex justify-end items-center gap-2">
                    <button
                        onClick={() => openDetail(order)}
                        className="p-2 text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors rounded-lg"
                        title={t('orders.view_details')}
                    >
                        <Eye size={16} />
                    </button>
                    {canEditOrderMeta && (
                        <>
                            <button
                                onClick={() => openEncodedDtModal(order)}
                                disabled={encodedDtSubmitting}
                                className="p-2 text-amber-600 hover:bg-amber-50 transition-colors rounded-lg disabled:opacity-50"
                                title={t('orders.update_encoded_dt')}
                            >
                                <Calendar size={16} />
                            </button>
                            <button
                                onClick={() => confirmSoftDelete(order)}
                                disabled={statusSubmitting}
                                className="p-2 text-red-500 hover:bg-red-50 transition-colors rounded-lg disabled:opacity-50"
                                title={t('orders.soft_delete')}
                            >
                                <Trash2 size={16} />
                            </button>
                        </>
                    )}
                    {/* Confirm / Cancel are treated as updates on the order */}
                    {canUpdate('orders') && order.STATUS === ORDER_STATUS.PENDING && (
                        <button
                            onClick={() => confirmUpdateStatus(order, ORDER_STATUS.CONFIRMED)}
                            disabled={statusSubmitting}
                            className="p-2 text-green-600 hover:bg-green-50 transition-colors rounded-lg disabled:opacity-50"
                            title={t('orders.confirmed')}
                        >
                            <CheckCircle2 size={16} />
                        </button>
                    )}
                    {canUpdate('orders') &&
                      order.STATUS !== ORDER_STATUS.SETTLED &&
                      order.STATUS !== ORDER_STATUS.CANCELLED && (
                        <button
                            onClick={() => confirmUpdateStatus(order, ORDER_STATUS.CANCELLED)}
                            disabled={statusSubmitting}
                            className="p-2 text-red-500 hover:bg-red-50 transition-colors rounded-lg disabled:opacity-50"
                            title={t('orders.cancel_order')}
                        >
                            <XCircle size={16} />
                        </button>
                    )}
                </div>
            ),
        },
    ], [statusSubmitting, encodedDtSubmitting, t, canUpdate, canEditOrderMeta]);

    // ==================== RENDER ====================
    return (
        <div className="pt-6">
            <AnimatePresence mode="wait">
                {loading ? (
                    <motion.div
                        key="skeleton"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="space-y-8"
                    >
                        <SkeletonPageHeader />
                        <SkeletonStatCards />
                        <div className="bg-white rounded-2xl shadow-sm p-6">
                            <SkeletonTable columns={6} rows={10} />
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        key="content"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        className="space-y-8"
                    >
                        {/* Top bar: Filter + Search + Action */}
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className="bg-white p-3 rounded-xl shadow-sm">
                                    <Filter size={18} className="text-brand-muted" />
                                </div>
                                <div className="relative">
                                    <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                                    <input
                                        type="text"
                                        placeholder={t('orders.search_placeholder')}
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
                                    />
                                </div>
                                <Select2
                                    options={[
                                        { value: 'all', label: t('orders.all_statuses') },
                                        { value: String(ORDER_STATUS.PENDING), label: t('orders.pending') },
                                        { value: String(ORDER_STATUS.CONFIRMED), label: t('orders.confirmed') },
                                        { value: String(ORDER_STATUS.SETTLED), label: t('orders.settled') },
                                        { value: String(ORDER_STATUS.CANCELLED), label: t('orders.cancelled') },
                                    ]}
                                    value={statusFilter}
                                    onChange={(v) => setStatusFilter(v ? String(v) : 'all')}
                                    placeholder={t('orders.all_statuses')}
                                    className="w-48"
                                />
                            </div>
                            {canCreate('orders') && (
                              <div className="flex items-center gap-3">
                                <button
                                    onClick={openNewOrder}
                                    className="bg-brand-primary text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 transition-all"
                                >
                                    <Plus size={18} />
                                    {t('orders.new_order')}
                                </button>
                                <button
                                    type="button"
                                    onClick={openReceiptOrder}
                                    className="bg-violet-600 text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-violet-600/20 hover:bg-violet-700 transition-all"
                                    title={t('orders.upload_receipt_helper')}
                                >
                                    <ScanLine size={18} />
                                    {t('orders.upload_receipt')}
                                </button>
                                <button
                                    type="button"
                                    onClick={openReceiptHistoryPanel}
                                    className="bg-slate-700 text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-slate-700/20 hover:bg-slate-800 transition-all"
                                    title={t('orders.receipt_history_sub')}
                                >
                                    <History size={18} />
                                    {t('orders.receipt_history')}
                                </button>
                                <button
                                    onClick={openManualOrder}
                                    className="bg-emerald-600 text-white px-6 py-2.5 rounded-xl text-base font-bold flex items-center gap-2 shadow-lg shadow-emerald-600/20 hover:bg-emerald-700 transition-all"
                                    title={t('orders.manual_order_helper')}
                                >
                                    <CheckCircle2 size={18} />
                                    {t('orders.manual_order')}
                                </button>
                              </div>
                            )}
                        </div>

                        {/* Error */}
                        {error && (
                            <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 p-4 rounded-2xl">
                                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                                <div className="text-sm">
                                    <p className="font-bold">{t('orders.unable_to_load')}</p>
                                    <p className="text-xs text-red-600 mt-0.5">{error}</p>
                                </div>
                            </div>
                        )}

                        {/* Stat Cards */}
                        <div className="grid grid-cols-5 gap-6">
                            <div className="bg-white p-6 rounded-2xl shadow-sm">
                                <p className="text-brand-muted text-sm font-medium mb-1">{t('orders.total_orders')}</p>
                                <h3 className="text-3xl font-bold">{stats.total}</h3>
                            </div>
                            <div className="bg-white p-6 rounded-2xl shadow-sm">
                                <p className="text-brand-muted text-sm font-medium mb-1">{t('orders.pending')}</p>
                                <div className="flex items-center gap-2">
                                    <h3 className="text-3xl font-bold text-orange-500">{stats.pending}</h3>
                                    {stats.pending > 0 && <Clock size={18} className="text-orange-500" />}
                                </div>
                            </div>
                            <div className="bg-white p-6 rounded-2xl shadow-sm">
                                <p className="text-brand-muted text-sm font-medium mb-1">{t('orders.confirmed')}</p>
                                <h3 className="text-3xl font-bold text-blue-500">{stats.confirmed}</h3>
                            </div>
                            <div className="bg-white p-6 rounded-2xl shadow-sm">
                                <p className="text-brand-muted text-sm font-medium mb-1">{t('orders.settled')}</p>
                                <h3 className="text-3xl font-bold text-green-500">{stats.settled}</h3>
                            </div>
                            <div className="bg-white p-6 rounded-2xl shadow-sm">
                                <p className="text-brand-muted text-sm font-medium mb-1">{t('orders.cancelled')}</p>
                                <h3 className="text-3xl font-bold text-red-500">{stats.cancelled}</h3>
                            </div>
                        </div>

                        {/* Data Table */}
                        <DataTable
                            data={filteredOrders}
                            columns={columns}
                            keyExtractor={(item) => String(item.IDNo)}
                        />
                    </motion.div>
                )}
            </AnimatePresence>

            <Modal
                isOpen={receiptHistoryOpen}
                onClose={() => setReceiptHistoryOpen(false)}
                title={t('orders.receipt_history')}
                maxWidth="5xl"
                footer={
                    <button
                        type="button"
                        onClick={() => setReceiptHistoryOpen(false)}
                        className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors"
                    >
                        {t('orders.cancel')}
                    </button>
                }
            >
                <p className="text-sm text-brand-muted mb-4">{t('orders.receipt_history_sub')}</p>
                {receiptHistoryLoading ? (
                    <div className="flex justify-center py-12">
                        <Loader2 size={32} className="animate-spin text-brand-primary" />
                    </div>
                ) : filteredReceiptHistory.length === 0 ? (
                    <p className="text-center text-brand-muted py-8">
                        {receiptHistoryRows.length > 0
                            ? t('orders.receipt_history_empty_range')
                            : t('orders.receipt_history_empty')}
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-xl border border-gray-200">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 text-left">
                                <tr>
                                    <th className="px-3 py-2 font-bold">{t('orders.date')}</th>
                                    {isAllBranches ? (
                                        <th className="px-3 py-2 font-bold">{t('orders.receipt_history_branch')}</th>
                                    ) : null}
                                    <th className="px-3 py-2 font-bold">{t('orders.receipt_history_source')}</th>
                                    <th className="px-3 py-2 font-bold">{t('orders.order_no')}</th>
                                    <th className="px-3 py-2 font-bold text-right">Order total</th>
                                    <th className="px-3 py-2 w-28" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {filteredReceiptHistory.map((r) => (
                                    <tr key={r.IDNo} className="hover:bg-gray-50/80">
                                        <td className="px-3 py-2 whitespace-nowrap">{formatEncodedDt(r.ENCODED_DT)}</td>
                                        {isAllBranches ? (
                                            <td className="px-3 py-2">{r.BRANCH_NAME ?? r.BRANCH_ID}</td>
                                        ) : null}
                                        <td className="px-3 py-2 font-mono text-xs">
                                            {formatReceiptScanHistorySourceLabel(receiptScanHistoryRowSource(r))}
                                        </td>
                                        <td className="px-3 py-2 font-mono">{r.ORDER_NO ?? '—'}</td>
                                        <td className="px-3 py-2 text-right tabular-nums">
                                            {r.ORDER_GRAND_TOTAL != null
                                                ? `₱${formatPesoUpToTwoDecimals(Number(r.ORDER_GRAND_TOTAL))}`
                                                : r.RECEIPT_GRAND_TOTAL != null
                                                    ? `₱${formatPesoUpToTwoDecimals(Number(r.RECEIPT_GRAND_TOTAL))}`
                                                    : '—'}
                                        </td>
                                        <td className="px-3 py-2">
                                            <button
                                                type="button"
                                                onClick={() => void openReceiptHistoryDetail(r.IDNo)}
                                                className="text-brand-primary font-bold hover:underline"
                                            >
                                                {t('orders.receipt_history_view')}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Modal>

            <Modal
                isOpen={receiptHistoryDetailOpen}
                onClose={() => {
                    setReceiptHistoryDetailOpen(false);
                    setReceiptHistoryDetail(null);
                }}
                title={t('orders.receipt_history_detail_title')}
                maxWidth="6xl"
                footer={
                    <button
                        type="button"
                        onClick={() => {
                            setReceiptHistoryDetailOpen(false);
                            setReceiptHistoryDetail(null);
                        }}
                        className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors"
                    >
                        {t('orders.cancel')}
                    </button>
                }
            >
                {receiptHistoryDetailLoading ? (
                    <div className="flex justify-center py-12">
                        <Loader2 size={32} className="animate-spin text-brand-primary" />
                    </div>
                ) : receiptHistoryDetail ? (
                    <div className="flex flex-col gap-3 h-full min-h-0">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                            <div className="min-w-0">
                                <span className="text-brand-muted">{t('orders.date')}</span>
                                <div className="font-semibold truncate">{formatEncodedDt(receiptHistoryDetail.ENCODED_DT)}</div>
                            </div>
                            <div className="min-w-0">
                                <span className="text-brand-muted">{t('orders.receipt_history_source')}</span>
                                <div className="font-mono truncate">
                                    {formatReceiptScanHistorySourceLabel(
                                        receiptScanHistoryRowSource(receiptHistoryDetail)
                                    )}
                                </div>
                            </div>
                            <div className="min-w-0">
                                <span className="text-brand-muted">{t('orders.order_no')}</span>
                                <div className="font-mono truncate">
                                    {receiptHistoryDetail.ORDER_NO ?? (receiptHistoryDetail.ORDER_ID != null ? `#${receiptHistoryDetail.ORDER_ID}` : '—')}
                                </div>
                            </div>
                            <div className="min-w-0">
                                <span className="text-brand-muted">Order total</span>
                                <div className="tabular-nums font-semibold truncate">
                                    {receiptHistoryDetail.ORDER_GRAND_TOTAL != null
                                        ? `₱${formatPesoUpToTwoDecimals(Number(receiptHistoryDetail.ORDER_GRAND_TOTAL))}`
                                        : receiptHistoryDetail.RECEIPT_GRAND_TOTAL != null
                                            ? `₱${formatPesoUpToTwoDecimals(Number(receiptHistoryDetail.RECEIPT_GRAND_TOTAL))}`
                                            : '—'}
                                </div>
                            </div>
                        </div>

                        <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50">
                            {receiptHistoryDetail.receipt_image_data_url ? (
                                <button
                                    type="button"
                                    onClick={() => {
                                        const url = receiptHistoryDetail.receipt_image_data_url;
                                        if (url) window.open(url, '_blank', 'noopener,noreferrer');
                                    }}
                                    className="w-full p-2"
                                    title="Click to view full size"
                                >
                                    <img
                                        src={receiptHistoryDetail.receipt_image_data_url}
                                        alt="Receipt"
                                        className="block w-full h-auto max-h-[78vh] object-contain rounded-xl bg-white"
                                        draggable={false}
                                    />
                                </button>
                            ) : (
                                <div className="h-[40vh] flex items-center justify-center text-brand-muted">
                                    No receipt image
                                </div>
                            )}
                        </div>

                        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
                                <div>
                                    <div className="text-xs font-bold text-brand-muted uppercase tracking-widest">
                                        Order breakdown
                                    </div>
                                    <div className="text-[11px] text-brand-muted mt-0.5">
                                        Click image to view full size
                                    </div>
                                </div>
                            </div>

                            <div className="p-4 space-y-4">
                                {(receiptHistoryDetail.orders || []).length === 0 ? (
                                    <div className="text-sm text-brand-muted">No order items found.</div>
                                ) : (
                                    (receiptHistoryDetail.orders || []).map((o) => {
                                        const items = o.items || [];
                                        return (
                                            <div key={String(o.ORDER_ID)} className="rounded-xl border border-gray-100 overflow-hidden">
                                                <div className="px-4 py-3 bg-gray-50 flex items-center justify-between gap-3">
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-extrabold text-brand-text truncate">
                                                            {o.ORDER_NO ? o.ORDER_NO : `#${o.ORDER_ID}`}
                                                        </div>
                                                        <div className="text-[11px] text-brand-muted truncate">
                                                            {o.TABLE_NUMBER != null && String(o.TABLE_NUMBER).trim() !== ''
                                                                ? `Table ${o.TABLE_NUMBER}`
                                                                : o.ORDER_TYPE || '—'}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="p-3">
                                                    {items.length === 0 ? (
                                                        <div className="text-sm text-brand-muted">No items.</div>
                                                    ) : (
                                                        <div className="overflow-hidden rounded-lg border border-gray-100">
                                                            <table className="w-full text-xs">
                                                                <thead className="bg-white">
                                                                    <tr className="text-brand-muted">
                                                                        <th className="px-3 py-2 text-left font-bold uppercase tracking-widest">Item</th>
                                                                        <th className="px-3 py-2 text-right font-bold uppercase tracking-widest w-[56px]">Qty</th>
                                                                        <th className="px-3 py-2 text-right font-bold uppercase tracking-widest w-[92px]">Total</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-gray-50">
                                                                    {items.map((it) => (
                                                                        <tr key={String(it.ORDER_ITEM_ID)} className="text-brand-text">
                                                                            <td className="px-3 py-2">
                                                                                <div className="font-semibold leading-snug">
                                                                                    {it.MENU_NAME || `#${it.MENU_ID ?? ''}`}
                                                                                </div>
                                                                                {it.REMARKS ? (
                                                                                    <div className="text-[11px] text-brand-muted mt-0.5 break-words">
                                                                                        {it.REMARKS}
                                                                                    </div>
                                                                                ) : null}
                                                                            </td>
                                                                            <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                                                                {Number(it.QTY || 0)}
                                                                            </td>
                                                                            <td className="px-3 py-2 text-right tabular-nums font-bold">
                                                                                {formatPesoUpToTwoDecimals(Number(it.LINE_TOTAL || 0))}
                                                                            </td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    )}

                                                    {(o.SERVICE_CHARGE != null && Number(o.SERVICE_CHARGE) > 0) || (o.SUBTOTAL != null && o.GRAND_TOTAL != null) ? (
                                                        <div className="mt-3">
                                                            <div className="rounded-xl bg-gray-50 px-3 py-2.5">
                                                                <div className="flex flex-col gap-2 text-sm">
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                                                            Subtotal
                                                                        </span>
                                                                        <span className="font-extrabold tabular-nums w-[92px] text-right text-slate-800">
                                                                            {formatPesoUpToTwoDecimals(Number(o.SUBTOTAL || 0))}
                                                                        </span>
                                                                    </div>
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                                                            Service charge
                                                                        </span>
                                                                        <span className="font-extrabold tabular-nums w-[92px] text-right text-slate-800">
                                                                            {formatPesoUpToTwoDecimals(Number(o.SERVICE_CHARGE || 0))}
                                                                        </span>
                                                                    </div>
                                                                    <div className="pt-2 mt-1 border-t border-gray-200/80 flex items-center justify-between gap-3">
                                                                        <span className="text-brand-muted font-bold uppercase tracking-widest text-[11px]">
                                                                            Total
                                                                        </span>
                                                                        <span className="font-black tabular-nums w-[92px] text-right text-violet-700 text-base">
                                                                            ₱
                                                                            {formatPesoUpToTwoDecimals(
                                                                                Number(o.GRAND_TOTAL || (Number(o.SUBTOTAL || 0) + Number(o.SERVICE_CHARGE || 0)))
                                                                            )}
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                ) : null}
            </Modal>

            {/* New Order Modal */}
            <Modal
                isOpen={newOrderOpen}
                onClose={closeNewOrder}
                title={t('orders.create_new_order')}
                maxWidth="2xl"
                footer={
                    <div className="flex items-center justify-end gap-3">
                        <button onClick={closeNewOrder} disabled={newOrderSubmitting} className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50">
                            {t('orders.cancel')}
                        </button>
                        <button onClick={submitNewOrder} disabled={newOrderSubmitting} className="px-6 py-2.5 rounded-xl font-bold text-white bg-green-600 shadow-lg shadow-green-600/30 hover:bg-green-700 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2">
                            {newOrderSubmitting && <Loader2 size={16} className="animate-spin" />}
                            {t('orders.create_order_btn')}
                        </button>
                    </div>
                }
            >
                <div className="space-y-6">
                    {/* Header / basic info */}
                    <div className="grid grid-cols-3 gap-5">
                        {newOrderIsDineIn && (
                            <div className="space-y-2">
                                <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                    {t('table.table_number')} *
                                </label>
                                <Select2
                                    options={newOrderTableOptions}
                                    value={newOrderTableId || null}
                                    onChange={(v) => setNewOrderTableId(v ? String(v) : '')}
                                    placeholder={t('table.table_number')}
                                />
                            </div>
                        )}
                        <div className="space-y-2">
                            <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                {t('orders.order_no_label')}
                            </label>
                            <input
                                type="text"
                                value={newOrderNo}
                                onChange={(e) => setNewOrderNo(e.target.value)}
                                placeholder={t('orders.order_no_placeholder')}
                                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                {t('orders.order_type')}
                            </label>
                            <Select2
                                options={[
                                    { value: 'DINE_IN', label: t('orders.dine_in') },
                                    { value: 'TAKE_OUT', label: t('orders.take_out') },
                                    { value: 'DELIVERY', label: t('orders.delivery') },
                                ]}
                                value={newOrderType}
                                onChange={(v) => {
                                    const next = (v as typeof newOrderType) || 'DINE_IN';
                                    setNewOrderType(next);
                                    if (!isDineInOrderType(next)) setNewOrderTableId('');
                                }}
                                placeholder={t('orders.select_type')}
                            />
                        </div>
                        {newOrderIsDineIn && isFloorEnabledBranch(branchId) && (
                            <div className="space-y-2">
                                <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                    {t('table.floor')}
                                </label>
                                <input
                                    type="text"
                                    readOnly
                                    tabIndex={-1}
                                    value={
                                        newOrderFloor === 'gf'
                                            ? t('table.ground_floor')
                                            : newOrderFloor === '2f'
                                                ? t('table.second_floor')
                                                : ''
                                    }
                                    placeholder={t('table.floor')}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-600 outline-none cursor-not-allowed placeholder:text-gray-400"
                                />
                            </div>
                        )}
                    </div>

                    {/* Items section */}
                    <div className="space-y-3">
                        <label className="block text-sm font-bold text-brand-text mb-2">{t('orders.order_items')}</label>
                        <div className="grid grid-cols-12 gap-3 items-end">
                            <div className="col-span-7">
                                <Select2
                                    options={newOrderMenus.map((m) => ({ value: m.id, label: `${m.name} — ₱${Number(m.price).toLocaleString()}` }))}
                                    value={newOrderSelectedMenuId || null}
                                    onChange={(v) => setNewOrderSelectedMenuId(v ? String(v) : '')}
                                    placeholder={newOrderLoadingRefs ? t('orders.loading_menu') : t('orders.select_item')}
                                    disabled={newOrderLoadingRefs}
                                />
                            </div>
                            <div className="col-span-2">
                                <input type="number" min={1} value={newOrderQty} onChange={(e) => setNewOrderQty(Number(e.target.value))}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 outline-none transition-all" />
                            </div>
                            <div className="col-span-3">
                                <button type="button" onClick={addNewOrderItem} disabled={newOrderLoadingRefs}
                                    className="w-full px-3 py-3 rounded-xl bg-brand-primary text-white font-bold text-sm hover:bg-brand-primary/90 disabled:opacity-50 transition-all flex items-center justify-center gap-1">
                                    <Plus size={14} /> {t('orders.add')}
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 border border-gray-100 rounded-xl overflow-hidden bg-white">
                            {newOrderItems.length === 0 ? (
                                <div className="p-4 text-sm text-brand-muted text-center">
                                    {t('orders.no_items_added')}
                                </div>
                            ) : (
                                <table className="w-full text-sm">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-4 py-2 text-left font-bold text-brand-muted text-xs">
                                                {t('orders.item')}
                                            </th>
                                            <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">
                                                {t('orders.qty')}
                                            </th>
                                            <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">
                                                {t('orders.unit')}
                                            </th>
                                            <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">
                                                {t('orders.line_total')}
                                            </th>
                                            <th className="px-4 py-2 w-12"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        {newOrderItems.map((it) => (
                                            <tr key={it.menuId}>
                                                <td className="px-4 py-2 font-medium">{it.name}</td>
                                                <td className="px-4 py-2 text-right">{it.qty}</td>
                                                <td className="px-4 py-2 text-right">
                                                    ₱{Number(it.unitPrice).toLocaleString()}
                                                </td>
                                                <td className="px-4 py-2 text-right font-bold">
                                                    ₱{Number(it.qty * it.unitPrice).toLocaleString()}
                                                </td>
                                                <td className="px-4 py-2 text-right">
                                                    <button
                                                        onClick={() => removeNewOrderItem(it.menuId)}
                                                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    {newOrderItems.length > 0 && (
                                        <tfoot className="bg-gray-50">
                                            <tr>
                                                <td
                                                    className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-brand-muted"
                                                    colSpan={3}
                                                >
                                                    Subtotal
                                                </td>
                                                <td className="px-4 py-2 text-right font-bold tabular-nums">
                                                    ₱{formatPesoUpToTwoDecimals(newOrderSubtotal)}
                                                </td>
                                                <td></td>
                                            </tr>
                                            {hasDineInServiceCharge(branchId) && newOrderServiceCharge > 0 ? (
                                                <tr>
                                                    <td
                                                        className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-brand-muted"
                                                        colSpan={3}
                                                    >
                                                        Service charge (10%)
                                                    </td>
                                                    <td className="px-4 py-2 text-right font-bold tabular-nums">
                                                        ₱{formatPesoUpToTwoDecimals(newOrderServiceCharge)}
                                                    </td>
                                                    <td></td>
                                                </tr>
                                            ) : null}
                                            {Number.isFinite(newOrderTableRoomCharge) && newOrderTableRoomCharge > 0 ? (
                                                <tr>
                                                    <td
                                                        className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-brand-muted"
                                                        colSpan={3}
                                                    >
                                                        {t('table.room_charge')}
                                                    </td>
                                                    <td className="px-4 py-2 text-right font-bold tabular-nums">
                                                        ₱{formatPesoUpToTwoDecimals(newOrderTableRoomCharge)}
                                                    </td>
                                                    <td></td>
                                                </tr>
                                            ) : null}
                                            <tr>
                                                <td
                                                    className="px-4 py-2 text-right font-bold text-brand-text"
                                                    colSpan={3}
                                                >
                                                    {t('orders.grand_total')}
                                                </td>
                                                <td className="px-4 py-2 text-right font-extrabold text-brand-primary tabular-nums">
                                                    ₱{formatPesoUpToTwoDecimals(newOrderEstimatedGrandTotal)}
                                                </td>
                                                <td></td>
                                            </tr>
                                        </tfoot>
                                    )}
                                </table>
                            )}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Receipt scan → new order */}
            <Modal
                isOpen={receiptOrderOpen}
                onClose={closeReceiptOrder}
                title={t('orders.receipt_order_title')}
                maxWidth="6xl"
                footer={
                    receiptRows.length === 0 ? (
                        <div className="flex items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => void finishReceiptScan()}
                                disabled={receiptExtracting || receiptStitching || receiptSegments.length === 0}
                                className="px-6 py-2.5 rounded-xl font-bold text-white bg-violet-600 shadow-lg shadow-violet-600/30 hover:bg-violet-700 transition-all disabled:opacity-50 flex items-center gap-2"
                                title={receiptSegments.length === 0 ? 'Add at least 1 page first' : 'Scan receipt'}
                            >
                                {(receiptExtracting || receiptStitching) && <Loader2 size={16} className="animate-spin" />}
                                <ScanLine size={16} />
                                Scan receipt
                            </button>
                            <button
                                type="button"
                                onClick={() => receiptFileInputRef.current?.click()}
                                disabled={receiptExtracting || receiptStitching || receiptSegments.length >= RECEIPT_MAX_PAGES}
                                className="px-6 py-2.5 rounded-xl font-bold text-brand-text bg-white border border-gray-200 hover:bg-gray-50 transition-all disabled:opacity-50 flex items-center gap-2"
                                title={receiptSegments.length >= RECEIPT_MAX_PAGES ? 'Max pages reached' : 'Add page'}
                            >
                                <Upload size={16} />
                                Add page
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={closeReceiptOrder}
                                disabled={receiptSubmitting || receiptExtracting}
                                className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
                            >
                                {t('orders.cancel')}
                            </button>
                            <button
                                type="button"
                                onClick={submitReceiptOrder}
                                disabled={
                                    receiptSubmitting ||
                                    receiptExtracting ||
                                    receiptOrderMenusLoading ||
                                    receiptUnmappedRows.length > 0
                                }
                                title={
                                    receiptUnmappedRows.length > 0
                                        ? t('orders.receipt_map_all_required')
                                        : undefined
                                }
                                className="px-6 py-2.5 rounded-xl font-bold text-white bg-violet-600 shadow-lg shadow-violet-600/30 hover:bg-violet-700 transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {receiptSubmitting && <Loader2 size={16} className="animate-spin" />}
                                {t('orders.create_order_btn')}
                            </button>
                        </div>
                    )
                }
            >
                <div className="space-y-6">
                    {isAllBranches && (
                        <div className="space-y-2">
                            <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                {t('header.select_branch')}
                            </label>
                            <Select2
                                options={manualBranchOptions}
                                value={receiptOrderBranchId || null}
                                onChange={(v) => {
                                    setReceiptOrderBranchId(v ? String(v) : '');
                                    setReceiptOrderTableId('');
                                    setReceiptImage(null);
                                    setReceiptRows([]);
                                    setReceiptExtractResult(null);
                                    setReceiptError(null);
                                }}
                                placeholder={t('header.select_branch')}
                            />
                            <p className="text-xs text-brand-muted">{t('orders.receipt_branch_hint')}</p>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-5">
                        <div className="space-y-2">
                            <label className="block text-xs font-bold text-brand-muted uppercase tracking-widest">
                                {t('orders.date')}
                            </label>
                            <input
                                type="date"
                                value={receiptOrderDate}
                                onChange={(e) => setReceiptOrderDate(e.target.value)}
                                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500/20 outline-none"
                            />
                        </div>
                    </div>

                    <input
                        ref={receiptFileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            void appendReceiptSegmentsFromFiles(Array.from(e.target.files || []));
                            e.target.value = '';
                        }}
                    />

                    <div
                        onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onDrop={(e) => {
                            e.preventDefault();
                            void appendReceiptSegmentsFromFiles(Array.from(e.dataTransfer.files || []));
                        }}
                        className={cn(
                            'rounded-2xl border-2 border-dashed p-6 text-center transition-colors',
                            isAllBranches && !receiptOrderBranchId
                                ? 'border-gray-200 bg-gray-50 opacity-60 pointer-events-none'
                                : 'border-violet-200 bg-violet-50/40 hover:border-violet-300'
                        )}
                    >
                        {receiptExtracting || receiptStitching ? (
                            <div className="flex flex-col items-center gap-3 py-6 text-brand-muted">
                                <Loader2 className="w-10 h-10 animate-spin text-violet-600" />
                                <p className="text-sm font-medium">{t('orders.receipt_scanning')}</p>
                            </div>
                        ) : (
                            <>
                                {receiptSegments.length > 0 && !receiptImage ? (
                                    <div className="w-full max-w-3xl mx-auto space-y-4">
                                        <div className="flex items-center justify-between gap-3 flex-wrap">
                                            <div className="text-left">
                                                <p className="text-sm font-extrabold text-brand-text">
                                                    Receipt pages ({receiptSegments.length}/{RECEIPT_MAX_PAGES})
                                                </p>
                                                <p className="text-xs text-brand-muted mt-1">
                                                    Add pages top → bottom with slight overlap, then use the footer buttons below.
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                                            {receiptSegments.map((src, idx) => (
                                                <div
                                                    key={`seg-${idx}`}
                                                    className="relative shrink-0 w-24 sm:w-28 rounded-xl border border-gray-200 bg-white overflow-hidden"
                                                >
                                                    <img
                                                        src={src}
                                                        alt={`Page ${idx + 1}`}
                                                        className="w-full h-28 object-cover object-top"
                                                    />
                                                    <span className="absolute bottom-0 inset-x-0 py-0.5 text-[10px] font-mono text-center bg-black/55 text-white">
                                                        {idx + 1}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            removeReceiptSegment(idx);
                                                        }}
                                                        className="absolute top-1 right-1 w-7 h-7 rounded-lg bg-black/50 text-white flex items-center justify-center"
                                                        aria-label={`Remove page ${idx + 1}`}
                                                    >
                                                        <X size={16} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="flex flex-wrap items-center justify-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => receiptFileInputRef.current?.click()}
                                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 text-sm font-bold hover:bg-gray-50"
                                            >
                                                <Upload size={16} />
                                                Add from files
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setReceiptSegments([]);
                                                    setReceiptImage(null);
                                                    setReceiptRows([]);
                                                    setReceiptExtractResult(null);
                                                    setReceiptError(null);
                                                }}
                                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-brand-muted hover:bg-white/80"
                                            >
                                                <RefreshCw size={16} />
                                                {t('orders.receipt_clear')}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <Upload className="w-10 h-10 mx-auto text-violet-500 mb-3" />
                                        <p className="text-sm font-bold text-brand-text mb-1">{t('orders.receipt_drop_hint')}</p>
                                        <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
                                            <button
                                                type="button"
                                                disabled={isAllBranches && !receiptOrderBranchId}
                                                onClick={() => receiptFileInputRef.current?.click()}
                                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 text-sm font-bold hover:bg-gray-50 disabled:opacity-50"
                                            >
                                                <Upload size={16} />
                                                {t('orders.receipt_choose_file')}
                                            </button>
                                            {(receiptImage || receiptSegments.length > 0) && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setReceiptSegments([]);
                                                        setReceiptImage(null);
                                                        setReceiptRows([]);
                                                        setReceiptExtractResult(null);
                                                        setReceiptError(null);
                                                    }}
                                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-brand-muted hover:bg-white/80"
                                                >
                                                    <RefreshCw size={16} />
                                                    {t('orders.receipt_clear')}
                                                </button>
                                            )}
                                        </div>

                                        {receiptSegments.length > 0 && !receiptImage ? (
                                            <div className="mt-4 flex flex-col items-center gap-3">
                                                <p className="text-xs text-brand-muted">
                                                    Added {receiptSegments.length} page(s). Use the footer buttons below to scan or add more pages.
                                                </p>
                                            </div>
                                        ) : null}

                                        {receiptImage && !receiptExtracting && (
                                            <div className="mt-4 flex justify-center">
                                                <img
                                                    src={receiptImage}
                                                    alt=""
                                                    className="max-h-40 rounded-lg border border-gray-200 shadow-sm"
                                                />
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </div>

                    {receiptError && (
                        <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 p-4 rounded-xl text-sm">
                            <AlertCircle size={18} className="mt-0.5 shrink-0" />
                            <span>{receiptError}</span>
                        </div>
                    )}

                    {receiptRows.length > 0 && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between flex-wrap gap-2">
                                <label className="block text-sm font-bold text-brand-text">{t('orders.receipt_mapped_items')}</label>
                                <span className="text-xs font-mono text-brand-muted">
                                    {receiptRows.length} lines · {receiptRowsByOrder.length}{' '}
                                    {receiptRowsByOrder.length === 1 ? 'order' : 'orders'}
                                </span>
                                {receiptOrderMenusLoading && (
                                    <span className="text-xs text-brand-muted flex items-center gap-1">
                                        <Loader2 size={14} className="animate-spin" />
                                        {t('orders.loading_menu')}
                                    </span>
                                )}
                            </div>

                            {receiptUnmappedRows.length > 0 ? (
                                <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                    {t('orders.receipt_unmapped_banner', { count: receiptUnmappedRows.length })}
                                </div>
                            ) : null}

                            <div className="space-y-6">
                                {receiptRowsByOrder.map(([orderId, blockRows]) => {
                                    const blockMeta = receiptExtractResult?.orders.find((o) => o.order_id === orderId);
                                    const blockTotal =
                                        blockMeta?.order_total_amount ??
                                        blockRows.reduce((s, r) => s + r.receiptLineTotal, 0);
                                    const meta = receiptMetaById[orderId] ?? {
                                        orderNo: generateOrderNo(),
                                        orderType: 'DINE_IN',
                                        tableNo: '',
                                    };
                                    const metaIsDineIn = isDineInOrderType(meta.orderType);
                                    const selectedTable = metaIsDineIn && meta.tableId
                                        ? receiptTableSelectOptions.find((t) => String(t.value) === String(meta.tableId))
                                        : undefined;
                                    const tableLabel = selectedTable?.label ? String(selectedTable.label) : '—';
                                    const metaFloor = selectedTable?.floor ?? '';
                                    const encodedLabel = (() => {
                                        const raw = String(receiptOrderDate || '').trim();
                                        if (!raw) return '—';
                                        try {
                                            const [yy, mm, dd] = raw.split('-').map((x) => Number(x));
                                            if (!yy || !mm || !dd) return raw;
                                            const d = new Date(Date.UTC(yy, mm - 1, dd));
                                            return new Intl.DateTimeFormat('en-US', {
                                                timeZone: 'Asia/Manila',
                                                month: 'short',
                                                day: '2-digit',
                                                year: 'numeric',
                                            }).format(d);
                                        } catch {
                                            return raw;
                                        }
                                    })();
                                    const shouldAddServiceCharge =
                                        hasDineInServiceCharge(effectiveReceiptBranchId) &&
                                        isDineInOrderType(meta.orderType) &&
                                        !receiptDetectedHasServiceCharge;
                                    const blockServiceChargePreview = shouldAddServiceCharge
                                        ? tenPercentServiceCharge(blockTotal)
                                        : 0;
                                    return (
                                        <React.Fragment key={`receipt-order-${orderId}`}>
                                            <ReceiptOrderBlockCard
                                                title={`ORDER ${orderId}`}
                                            >
                                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                                    {metaIsDineIn && (
                                                        <div className="space-y-1.5">
                                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                                {t('table.table_number')} *
                                                            </label>
                                                            <Select2
                                                                options={receiptTableSelectOptions}
                                                                value={meta.tableId || null}
                                                                onChange={(v) => updateReceiptMeta(orderId, { tableId: v ? String(v) : '' })}
                                                                placeholder={t('table.table_number')}
                                                            />
                                                        </div>
                                                    )}
                                                    <div className="space-y-1.5">
                                                        <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                            {t('orders.order_type')}
                                                        </label>
                                                        <Select2
                                                            options={[
                                                                { value: 'DINE_IN', label: t('orders.dine_in') },
                                                                { value: 'TAKE_OUT', label: t('orders.take_out') },
                                                                { value: 'DELIVERY', label: t('orders.delivery') },
                                                            ]}
                                                            value={meta.orderType}
                                                            onChange={(v) => {
                                                                const next = (v as typeof meta.orderType) || 'DINE_IN';
                                                                updateReceiptMeta(orderId, isDineInOrderType(next) ? { orderType: next } : { orderType: next, tableId: '' });
                                                            }}
                                                            placeholder={t('orders.select_type')}
                                                        />
                                                    </div>
                                                    {metaIsDineIn && isFloorEnabledBranch(effectiveReceiptBranchId) && (
                                                        <div className="space-y-1.5">
                                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                                {t('table.floor')}
                                                            </label>
                                                            <input
                                                                type="text"
                                                                readOnly
                                                                tabIndex={-1}
                                                                value={
                                                                    metaFloor === 'gf'
                                                                        ? t('table.ground_floor')
                                                                        : metaFloor === '2f'
                                                                            ? t('table.second_floor')
                                                                            : ''
                                                                }
                                                                placeholder={t('table.floor')}
                                                                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-600 outline-none cursor-not-allowed placeholder:text-gray-400"
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="rounded-2xl border border-gray-200 bg-[#fffdf7] p-4 sm:p-5 font-mono text-[12px] leading-relaxed">
                                                    <div className="space-y-2">
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-[11px] uppercase tracking-[0.12em] text-gray-500">Order No</div>
                                                                <div className="text-[13px] font-semibold text-slate-900 break-all">{meta.orderNo || '—'}</div>
                                                            </div>
                                                            <div className="text-right shrink-0">
                                                                <div className="text-[11px] uppercase tracking-[0.12em] text-gray-500">Type</div>
                                                                <div className="text-[13px] font-semibold text-slate-900">{orderTypeLabel(meta.orderType)}</div>
                                                            </div>
                                                        </div>

                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="min-w-0">
                                                                <div className="text-[11px] uppercase tracking-[0.12em] text-gray-500">Table</div>
                                                                <div className="text-[13px] font-semibold text-slate-900 break-words">{tableLabel}</div>
                                                            </div>
                                                            <div className="text-right shrink-0">
                                                                <div className="text-[11px] uppercase tracking-[0.12em] text-gray-500">Encoded</div>
                                                                <div className="text-[13px] font-semibold text-slate-900">{encodedLabel}</div>
                                                            </div>
                                                        </div>

                                                        <div className="pt-2">
                                                            <div className="border-t border-dashed border-slate-300/70" />
                                                            <div className="mt-2 grid grid-cols-12 gap-2 text-[11px] uppercase tracking-[0.12em] text-gray-500">
                                                                <div className="col-span-5">Item</div>
                                                                <div className="col-span-2 text-right">Qty</div>
                                                                <div className="col-span-2 text-right leading-tight">Unit price</div>
                                                                <div className="col-span-3 text-right">Amount</div>
                                                            </div>
                                                            <div className="mt-2 border-t border-dashed border-slate-200" />
                                                        </div>

                                                        <div className="space-y-2 pt-1">
                                                            {blockRows.map((row) => {
                                                                const qty = Number(row.qty) || 1;
                                                                const amt = Number(row.receiptLineTotal) || 0;
                                                                const unit = qty > 0 ? amt / qty : 0;
                                                                const unitRounded = Math.round(unit * 100) / 100;
                                                                const unitFrac = !Number.isInteger(unitRounded);
                                                                const rowUnmapped =
                                                                    !row.menuId ||
                                                                    !receiptMenuIdSet.has(String(row.menuId)) ||
                                                                    !isReceiptLineMappedToMenu(
                                                                        row.extractedName,
                                                                        Number(row.receiptLineTotal) || 0,
                                                                        Number(row.qty) || 1,
                                                                        row.menuId,
                                                                        receiptOrderMenus
                                                                    );
                                                                return (
                                                                    <div key={row.id} className="pb-2 border-b border-dashed border-slate-200/80 last:border-b-0 last:pb-0">
                                                                        <div className="grid grid-cols-12 gap-2 items-start">
                                                                            <div className="col-span-5 min-w-0">
                                                                                <div className="text-[13px] font-semibold text-slate-900 leading-snug break-words">
                                                                                    {row.extractedName}
                                                                                </div>
                                                                                {row.menuSelection ? (
                                                                                    <div className="text-[12px] text-slate-500 leading-snug break-words mt-1">
                                                                                        {row.menuSelection}
                                                                                    </div>
                                                                                ) : null}
                                                                                {rowUnmapped ? (
                                                                                    <p className="text-[11px] font-semibold text-amber-700 mt-1">
                                                                                        {t('orders.receipt_unmapped_item_hint')}
                                                                                    </p>
                                                                                ) : null}
                                                                            </div>
                                                                            <div className="col-span-2 text-right text-[13px] font-semibold tabular-nums text-slate-900">
                                                                                {qty}
                                                                            </div>
                                                                            <div className="col-span-2 text-right text-[13px] font-semibold tabular-nums text-slate-900">
                                                                                ₱{unitRounded.toLocaleString(undefined, {
                                                                                    maximumFractionDigits: unitFrac ? 2 : 0,
                                                                                    minimumFractionDigits: unitFrac ? 2 : 0,
                                                                                })}
                                                                            </div>
                                                                            <div className="col-span-3 text-right text-[13px] font-semibold tabular-nums text-slate-900">
                                                                                ₱{amt.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>

                                                        <div className="pt-2">
                                                            <div className="border-t border-dashed border-slate-300/70" />
                                                            <div className="mt-2 space-y-1">
                                                                <div className="flex items-center justify-between text-[13px] font-semibold text-slate-900">
                                                                    <span className="tracking-[0.12em] uppercase text-[11px] text-gray-500">TOTAL AMOUNT</span>
                                                                    <span className="tabular-nums">₱{blockTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                                                                </div>
                                                                {shouldAddServiceCharge ? (
                                                                    <>
                                                                        <div className="flex items-center justify-between text-[13px] font-semibold text-slate-900">
                                                                            <span className="tracking-[0.12em] uppercase text-[11px] text-gray-500">SERVICE CHARGE (10%)</span>
                                                                            <span className="tabular-nums">₱{formatPesoUpToTwoDecimals(blockServiceChargePreview)}</span>
                                                                        </div>
                                                                        <div className="flex items-center justify-between text-[13px] font-semibold text-slate-900">
                                                                            <span className="tracking-[0.12em] uppercase text-[11px] text-gray-500">TOTAL DUE</span>
                                                                            <span className="tabular-nums">
                                                                                ₱{formatPesoUpToTwoDecimals(blockTotal + blockServiceChargePreview)}
                                                                            </span>
                                                                        </div>
                                                                    </>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4">
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setReceiptMapOpenByOrderId((prev) => ({ ...prev, [orderId]: !prev[orderId] }))
                                                        }
                                                        className="text-xs font-bold text-brand-primary hover:underline"
                                                    >
                                                        {receiptMapOpenByOrderId[orderId] ? 'Hide mapping controls' : 'Show mapping controls'}
                                                    </button>
                                                </div>

                                                {receiptMapOpenByOrderId[orderId] ? (
                                                    <div className="mt-3 space-y-3">
                                                        {blockRows.map((row) => {
                                                            const rowUnmapped =
                                                                !row.menuId ||
                                                                !receiptMenuIdSet.has(String(row.menuId)) ||
                                                                !isReceiptLineMappedToMenu(
                                                                    row.extractedName,
                                                                    Number(row.receiptLineTotal) || 0,
                                                                    Number(row.qty) || 1,
                                                                    row.menuId,
                                                                    receiptOrderMenus
                                                                );
                                                            return (
                                                            <div
                                                                key={`map-${row.id}`}
                                                                className={cn(
                                                                    'rounded-xl border p-4',
                                                                    rowUnmapped
                                                                        ? 'border-amber-300 bg-amber-50/50'
                                                                        : 'border-gray-100 bg-gray-50/60'
                                                                )}
                                                            >
                                                                <div className="text-sm font-semibold text-brand-text">{row.extractedName}</div>
                                                                {row.menuSelection ? (
                                                                    <div className="text-xs text-brand-muted mt-1">{row.menuSelection}</div>
                                                                ) : null}
                                                                {rowUnmapped ? (
                                                                    <p className="text-xs font-semibold text-amber-800 mt-2">
                                                                        {t('orders.receipt_unmapped_item_hint')}
                                                                    </p>
                                                                ) : null}
                                                                <div className="mt-3 grid grid-cols-1 sm:grid-cols-[minmax(0,7rem)_1fr] gap-3 sm:items-end">
                                                                    <div className="space-y-1">
                                                                        <label className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">
                                                                            {t('orders.qty')}
                                                                        </label>
                                                                        <input
                                                                            type="number"
                                                                            min={0.01}
                                                                            step={0.01}
                                                                            value={row.qty}
                                                                            onChange={(e) => updateReceiptRowQty(row.id, Number(e.target.value))}
                                                                            className="w-full min-h-[44px] bg-white border border-gray-200 rounded-xl px-3 py-2 text-right text-sm font-mono"
                                                                        />
                                                                    </div>
                                                                    <div className="space-y-1 min-w-0">
                                                                        <label className="text-[10px] font-bold text-brand-muted uppercase tracking-wider">
                                                                            {t('orders.menu_item')}
                                                                        </label>
                                                                        <Select2
                                                                            options={receiptOrderMenus.map((m) => ({
                                                                                value: m.id,
                                                                                label: `${m.name} — ₱${Number(m.price).toLocaleString()}`,
                                                                            }))}
                                                                            value={row.menuId || null}
                                                                            onChange={(v) => updateReceiptRowMenu(row.id, v ? String(v) : null)}
                                                                            placeholder={t('orders.select_menu_item')}
                                                                            disabled={receiptOrderMenusLoading}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            );
                                                        })}
                                                    </div>
                                                ) : null}
                                            </ReceiptOrderBlockCard>
                                        </React.Fragment>
                                    );
                                })}
                            </div>

                            <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-bold text-brand-text">
                                        {hasDineInServiceCharge(effectiveReceiptBranchId) ? 'Total due (receipt)' : 'Grand Total (receipt)'}
                                    </span>
                                    <span className="font-extrabold text-violet-600 tabular-nums">
                                        ₱
                                        {formatPesoUpToTwoDecimals(
                                            hasDineInServiceCharge(effectiveReceiptBranchId)
                                                ? receiptPreviewTotalDueReceipt
                                                : receiptPreviewReceiptTotal
                                        )}
                                    </span>
                                </div>
                                {hasDineInServiceCharge(effectiveReceiptBranchId) ? (
                                    <div className="mt-2 text-xs text-brand-muted flex flex-wrap items-center justify-between gap-2">
                                        <span>
                                            Items ₱{formatPesoUpToTwoDecimals(receiptPreviewReceiptTotal)} + SC ₱
                                            {formatPesoUpToTwoDecimals(receiptPreviewServiceChargeReceipt)}
                                        </span>
                                        <span className="font-mono">
                                            {receiptRowsByOrder.length} order{receiptRowsByOrder.length === 1 ? '' : 's'}
                                        </span>
                                    </div>
                                ) : null}
                            </div>
                            <p className="text-xs text-brand-muted">
                                Totals above are based on receipt extracted amounts (same as tablet UI). Menu mapping affects what will be saved to the order.
                            </p>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Manual Order Modal (Settled immediately) */}
            <Modal
                isOpen={manualOrderOpen}
                onClose={closeManualOrder}
                title={t('orders.create_manual_order')}
                maxWidth="6xl"
                footer={
                    <div className="flex items-center justify-end gap-3">
                        <button onClick={closeManualOrder} disabled={manualOrderSubmitting} className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
                            {t('orders.cancel')}
                        </button>
                        <button onClick={submitManualOrder} disabled={manualOrderSubmitting} className="px-6 py-2.5 rounded-xl font-bold text-white bg-emerald-600 shadow-lg shadow-emerald-600/30 hover:bg-emerald-700 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed">
                            {manualOrderSubmitting && <Loader2 size={16} className="animate-spin" />}
                            {t('orders.create_manual_order_btn')}
                        </button>
                    </div>
                }
            >
                <div className="space-y-6">
                    {/* Items section */}
                    <div className="space-y-3">
                        <label className="block text-sm font-bold text-brand-text mb-2">{t('orders.order_items')}</label>
                        <div className="grid grid-cols-12 gap-4">
                            <div className="col-span-5">
                                <div className="space-y-3 h-[680px] flex flex-col">
                                    <div className="flex items-center justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setManualMenuPage((prev) => Math.max(1, prev - 1))}
                                            disabled={manualMenuPage <= 1}
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-brand-muted hover:bg-gray-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                            <ChevronLeft size={14} />
                                            Prev
                                        </button>
                                        <span className="text-[11px] font-bold text-brand-muted min-w-[72px] text-center">
                                            {manualMenuPage} / {manualMenuTotalPages}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setManualMenuPage((prev) => Math.min(manualMenuTotalPages, prev + 1))}
                                            disabled={manualMenuPage >= manualMenuTotalPages}
                                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-brand-muted hover:bg-gray-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                            Next
                                            <ChevronRight size={14} />
                                        </button>
                                    </div>
                                    <div className="relative">
                                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                                        <input
                                            type="text"
                                            value={manualMenuQuery}
                                            onChange={(e) => setManualMenuQuery(e.target.value)}
                                            placeholder={t('orders.search_placeholder')}
                                            className="w-full bg-white border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
                                        />
                                    </div>
                                    <div className="border border-gray-100 rounded-2xl bg-white overflow-hidden flex-1 min-h-0">
                                        <div className="h-full p-3">
                                            {manualOrderLoadingRefs ? (
                                                <div className="flex items-center justify-center py-10 text-brand-muted text-sm">
                                                    <Loader2 size={18} className="animate-spin mr-2" />
                                                    {t('orders.loading_menu')}
                                                </div>
                                            ) : filteredManualMenus.length === 0 ? (
                                                <div className="py-10 text-center text-sm text-brand-muted">
                                                    {t('orders.no_items_added')}
                                                </div>
                                            ) : (
                                                <div className="grid grid-cols-2 gap-2">
                                                    {paginatedManualMenus.map((m) => (
                                                        <button
                                                            key={m.id}
                                                            type="button"
                                                            onClick={() => addManualMenuById(String(m.id), 1)}
                                                            className="w-full text-left p-3 rounded-xl border border-gray-100 hover:border-brand-primary/30 hover:bg-brand-primary/5 transition-colors cursor-pointer"
                                                        >
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div className="min-w-0">
                                                                    <p className="text-sm font-bold text-brand-text truncate">{m.name}</p>
                                                                </div>
                                                                <div className="shrink-0 text-xs font-bold text-brand-primary">
                                                                    ₱{Number(m.price || 0).toLocaleString()}
                                                                </div>
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <p className="text-[11px] text-brand-muted">
                                        Click item para auto-add. Click ulit para dagdag qty.
                                    </p>
                                </div>
                            </div>
                            <div className="col-span-7">
                                <div className="space-y-4">
                                    {/* Header / basic info */}
                                    <div className="grid grid-cols-12 gap-3">
                                        {isAllBranches && (
                                            <div className="space-y-1.5 col-span-3">
                                                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                    {t('header.select_branch')}
                                                </label>
                                                <Select2
                                                    options={manualBranchOptions}
                                                    value={manualOrderBranchId || null}
                                                    onChange={(v) => { setManualOrderBranchId(v ? String(v) : ''); setManualOrderTableId(''); }}
                                                    placeholder={t('header.select_branch')}
                                                />
                                            </div>
                                        )}
                                        {manualOrderIsDineIn && (
                                            <div className={cn("space-y-1.5", isAllBranches ? "col-span-3" : "col-span-4")}>
                                                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                    {t('table.table_number')} *
                                                </label>
                                                <Select2
                                                    options={manualOrderTableOptions}
                                                    value={manualOrderTableId || null}
                                                    onChange={(v) => setManualOrderTableId(v ? String(v) : '')}
                                                    placeholder={t('table.table_number')}
                                                />
                                            </div>
                                        )}
                                        <div className={cn("space-y-1.5", isAllBranches ? "col-span-3" : "col-span-4")}>
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('orders.order_no_label')}
                                            </label>
                                            <input
                                                type="text"
                                                value={manualOrderNo}
                                                onChange={(e) => setManualOrderNo(e.target.value)}
                                                placeholder={t('orders.order_no_placeholder')}
                                                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
                                            />
                                        </div>
                                        <div className={cn("space-y-1.5", isAllBranches ? "col-span-3" : "col-span-4")}>
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('orders.order_type')}
                                            </label>
                                            <Select2
                                                options={[
                                                    { value: 'DINE_IN', label: t('orders.dine_in') },
                                                    { value: 'TAKE_OUT', label: t('orders.take_out') },
                                                    { value: 'DELIVERY', label: t('orders.delivery') },
                                                ]}
                                                value={manualOrderType}
                                                onChange={(v) => {
                                                    const next = (v as typeof manualOrderType) || 'DINE_IN';
                                                    setManualOrderType(next);
                                                    if (!isDineInOrderType(next)) setManualOrderTableId('');
                                                }}
                                                placeholder={t('orders.select_type')}
                                            />
                                        </div>
                                        {manualOrderIsDineIn && isFloorEnabledBranch(effectiveManualBranchId) && (
                                            <div className={cn("space-y-1.5", isAllBranches ? "col-span-3" : "col-span-4")}>
                                                <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                    {t('table.floor')}
                                                </label>
                                                <input
                                                    type="text"
                                                    readOnly
                                                    tabIndex={-1}
                                                    value={
                                                        manualOrderFloor === 'gf'
                                                            ? t('table.ground_floor')
                                                            : manualOrderFloor === '2f'
                                                                ? t('table.second_floor')
                                                                : ''
                                                    }
                                                    placeholder={t('table.floor')}
                                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-600 outline-none cursor-not-allowed placeholder:text-gray-400"
                                                />
                                            </div>
                                        )}
                                        {/* Keep date on its own row for cleaner alignment */}
                                        <div className="space-y-1.5 col-span-12">
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('orders.date') ?? 'Date'}
                                            </label>
                                            <input
                                                type="date"
                                                value={manualOrderDate}
                                                onChange={(e) => setManualOrderDate(e.target.value)}
                                                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                                            />
                                        </div>
                                    </div>

                                    {/* Payment */}
                                    <div className="grid grid-cols-12 gap-3">
                                        <div className="space-y-1.5 col-span-4">
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('billing.payment_method')}
                                            </label>
                                            <Select2
                                                options={[
                                                    { value: 'CASH', label: 'CASH' },
                                                    { value: 'CARD', label: 'CARD' },
                                                    { value: 'GCASH', label: 'GCASH' },
                                                    { value: 'BANK', label: 'BANK' },
                                                ]}
                                                value={manualPaymentMethod}
                                                onChange={(v) => setManualPaymentMethod((v as any) || 'CASH')}
                                                placeholder={t('billing.payment_method')}
                                            />
                                        </div>
                                        <div className="space-y-1.5 col-span-8">
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('billing.payment_reference')}
                                            </label>
                                            <input
                                                type="text"
                                                value={manualPaymentRef}
                                                onChange={(e) => setManualPaymentRef(e.target.value)}
                                                placeholder={t('billing.payment_reference_placeholder')}
                                                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
                                            />
                                            <p className="text-[11px] text-brand-muted">
                                                {t('orders.manual_order_payment_helper')}
                                            </p>
                                        </div>
                                        <div className="space-y-1.5 col-span-12">
                                            <label className="block text-[11px] font-bold text-brand-muted uppercase tracking-wider">
                                                {t('orders.discount')}
                                            </label>
                                            <input
                                                type="number"
                                                min={0}
                                                step="0.01"
                                                value={manualDiscountAmount}
                                                onChange={(e) => setManualDiscountAmount(e.target.value)}
                                                placeholder="0.00"
                                                className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-4 border border-gray-100 rounded-xl overflow-hidden bg-white">
                                    {manualDisplayOrderItems.length === 0 ? (
                                        <div className="p-4 text-sm text-brand-muted text-center">
                                            {t('orders.no_items_added')}
                                        </div>
                                    ) : (
                                        <table className="w-full text-sm">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="px-4 py-2 text-left font-bold text-brand-muted text-xs">
                                                        {t('orders.item')}
                                                    </th>
                                                    <th className="px-3 py-2 text-center font-bold text-brand-muted text-xs w-[120px]">
                                                        {t('orders.qty')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">
                                                        {t('orders.unit')}
                                                    </th>
                                                    <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">
                                                        {t('orders.line_total')}
                                                    </th>
                                                    <th className="px-4 py-2 w-12"></th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-50">
                                                {manualDisplayOrderItems.map((it) => {
                                                    const isRoomChargeRow = it.menuId === MANUAL_ROOM_CHARGE_ITEM_ID;
                                                    return (
                                                    <tr
                                                        key={it.menuId}
                                                        className={cn(
                                                            'transition-colors duration-700',
                                                            manualRowFlash?.menuId === it.menuId && 'bg-indigo-50'
                                                        )}
                                                    >
                                                        <td className="px-4 py-2 font-medium">{it.name}</td>
                                                        <td className="px-3 py-2 text-center">
                                                            {isRoomChargeRow ? (
                                                                <div className="flex items-center justify-center gap-3">
                                                                    <button
                                                                        type="button"
                                                                            onClick={() => {
                                                                                setManualRoomChargeQty((prev) => roundToHalf(Math.max(0, prev - 0.5)));
                                                                                setManualRowFlash({ menuId: MANUAL_ROOM_CHARGE_ITEM_ID, nonce: Date.now() });
                                                                            }}
                                                                            disabled={it.qty <= 0}
                                                                        className="w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-brand-muted font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                                                        title="Decrease"
                                                                    >
                                                                        −
                                                                    </button>
                                                                    <span className="inline-block w-8 text-center font-bold">
                                                                        {it.qty}
                                                                    </span>
                                                                    <button
                                                                        type="button"
                                                                            onClick={() => {
                                                                                setManualRoomChargeQty((prev) => roundToHalf(prev + 0.5));
                                                                                setManualRowFlash({ menuId: MANUAL_ROOM_CHARGE_ITEM_ID, nonce: Date.now() });
                                                                            }}
                                                                        className="w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-brand-muted font-bold cursor-pointer"
                                                                        title="Increase"
                                                                    >
                                                                        +
                                                                    </button>
                                                                </div>
                                                            ) : (
                                                                <div className="flex items-center justify-center gap-3">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decManualOrderItemQty(it.menuId)}
                                                                        className="w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-brand-muted font-bold cursor-pointer"
                                                                        title="Decrease"
                                                                    >
                                                                        −
                                                                    </button>
                                                                    <span className="inline-block w-8 text-center font-bold">
                                                                        {it.qty}
                                                                    </span>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => addManualMenuById(it.menuId, 1)}
                                                                        className="w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-brand-muted font-bold cursor-pointer"
                                                                        title="Increase"
                                                                    >
                                                                        +
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2 text-right">
                                                            ₱{Number(it.unitPrice).toLocaleString()}
                                                        </td>
                                                        <td className="px-4 py-2 text-right font-bold">
                                                            ₱{Number(it.qty * it.unitPrice).toLocaleString()}
                                                        </td>
                                                        <td className="px-4 py-2 text-right">
                                                            {isRoomChargeRow ? null : (
                                                                <button
                                                                    onClick={() => removeManualOrderItem(it.menuId)}
                                                                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg cursor-pointer"
                                                                >
                                                                    <Trash2 size={16} />
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                    );
                                                })}
                                            </tbody>
                                            {manualDisplayOrderItems.length > 0 && (
                                                <tfoot className="bg-gray-50">
                                                    {hasDineInServiceCharge(effectiveManualBranchId) && manualServiceCharge > 0 ? (
                                                        <tr>
                                                            <td
                                                                className="px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-brand-muted"
                                                                colSpan={3}
                                                            >
                                                                Service charge (10%)
                                                            </td>
                                                            <td className="px-4 py-2 text-right font-bold tabular-nums">
                                                                ₱{formatPesoUpToTwoDecimals(manualServiceCharge)}
                                                            </td>
                                                            <td></td>
                                                        </tr>
                                                    ) : null}
                                                    <tr>
                                                        <td
                                                            className="px-4 py-2 text-right font-bold text-brand-text"
                                                            colSpan={3}
                                                        >
                                                            {t('orders.grand_total')}
                                                        </td>
                                                        <td className="px-4 py-2 text-right font-extrabold text-emerald-700 tabular-nums">
                                                            ₱{formatPesoUpToTwoDecimals(manualGrandTotalPreview)}
                                                        </td>
                                                        <td></td>
                                                    </tr>
                                                </tfoot>
                                            )}
                                        </table>
                                    )}
                                </div>
                            </div>
                        </div>

                    </div>
                </div>
            </Modal>

            {/* Detail Modal */}
            <Modal
                isOpen={!!detailOrder}
                onClose={closeDetail}
                title={detailOrder ? `${t('orders.order_no')} ${detailOrder.ORDER_NO}` : t('orders.view_details')}
                maxWidth="2xl"
            >
                {detailOrder && (
                    <div className="space-y-6">
                        {/* Summary header */}
                        <div className="grid grid-cols-4 gap-4 bg-gray-50 rounded-2xl p-5 border border-gray-100">
                            <div className="space-y-1">
                                <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">
                                    {t('orders.status')}
                                </p>
                                <div>{statusBadge(detailOrder.STATUS)}</div>
                            </div>
                            <div className="space-y-1">
                                <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">
                                    {t('orders.type')}
                                </p>
                                <div>{orderTypeBadge(detailOrder.ORDER_TYPE)}</div>
                            </div>
                            <div className="space-y-1">
                                <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">
                                    {t('orders.table')}
                                </p>
                                <p className="text-sm font-bold mt-0.5">
                                    {detailOrder.TABLE_NUMBER ?? '—'}
                                </p>
                            </div>
                            <div className="space-y-1 text-right">
                                <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">
                                    {t('orders.grand_total')}
                                </p>
                                <p className="text-2xl font-extrabold text-brand-primary mt-0.5 tabular-nums">
                                    ₱{formatPesoUpToTwoDecimals(Number(detailOrder.GRAND_TOTAL))}
                                </p>
                            </div>
                        </div>

                        {/* Items table */}
                        <div className="space-y-4">
                            <label className="block text-sm font-bold text-brand-text mb-2">{t('orders.order_items')}</label>
                            {detailLoading ? (
                                <div className="flex items-center justify-center py-8"><Loader2 size={24} className="animate-spin text-brand-primary" /></div>
                            ) : detailItems.length === 0 &&
                                !((detailOrder?.STATUS === ORDER_STATUS.SETTLED || detailOrder?.STATUS === ORDER_STATUS.CANCELLED) && Number(detailOrder?.SERVICE_CHARGE) > 0) ? (
                                <p className="text-sm text-brand-muted py-4">{t('orders.no_items_added')}</p>
                            ) : (
                                <div className="border border-gray-100 rounded-2xl overflow-hidden bg-white">
                                    <table className="w-full text-sm">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-4 py-2 text-left font-bold text-brand-muted text-xs">{t('orders.item')}</th>
                                                <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">{t('orders.qty')}</th>
                                                <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">{t('orders.unit')}</th>
                                                <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs">{t('orders.line_total')}</th>
                                                {detailOrder.STATUS !== ORDER_STATUS.SETTLED && detailOrder.STATUS !== ORDER_STATUS.CANCELLED && (
                                                    <th className="px-4 py-2 text-right font-bold text-brand-muted text-xs w-24">{t('orders.actions')}</th>
                                                )}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-50">
                                            {(detailOrder.STATUS === ORDER_STATUS.SETTLED || detailOrder.STATUS === ORDER_STATUS.CANCELLED) &&
                                                Number(detailOrder.SERVICE_CHARGE) > 0 && (
                                                    <tr key="__ROOM_CHARGE__">
                                                        <td className="px-4 py-2 font-medium">
                                                            {detailIsRoomCharge
                                                                ? (t('table.room_charge') ?? 'Room charge')
                                                                : (t('orders.service_charge') ?? 'Service charge')}
                                                        </td>
                                                        <td className="px-4 py-2 text-right">{detailRoomChargeQtyForRow}</td>
                                                        <td className="px-4 py-2 text-right tabular-nums">
                                                            ₱{formatPesoUpToTwoDecimals(Number(detailRoomChargeUnitForRow))}
                                                        </td>
                                                        <td className="px-4 py-2 text-right font-bold tabular-nums">
                                                            ₱{formatPesoUpToTwoDecimals(Number(detailServiceCharge))}
                                                        </td>
                                                        {detailOrder.STATUS !== ORDER_STATUS.SETTLED && detailOrder.STATUS !== ORDER_STATUS.CANCELLED && (
                                                            <td className="px-4 py-2 text-right"></td>
                                                        )}
                                                    </tr>
                                                )}
                                            {detailItems.map((item) => {
                                                const isEditing = editingItemId === item.IDNo;
                                                return (
                                                    <tr key={item.IDNo}>
                                                        <td className="px-4 py-2">{item.MENU_NAME ?? `Menu #${item.MENU_ID}`}</td>
                                                        <td className="px-4 py-2 text-right">
                                                            {isEditing ? (
                                                                <input
                                                                    type="number"
                                                                    min={1}
                                                                    value={editingQty}
                                                                    onChange={(e) => setEditingQty(Number(e.target.value))}
                                                                    className="w-20 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 text-right text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 outline-none transition-all"
                                                                />
                                                            ) : (
                                                                item.QTY
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2 text-right">₱{Number(item.UNIT_PRICE).toLocaleString()}</td>
                                                        <td className="px-4 py-2 text-right font-bold">₱{Number(item.LINE_TOTAL).toLocaleString()}</td>
                                                        {detailOrder.STATUS !== ORDER_STATUS.SETTLED && detailOrder.STATUS !== ORDER_STATUS.CANCELLED && (
                                                            <td className="px-4 py-2 text-right">
                                                                <div className="flex items-center justify-end gap-1">
                                                                    {isEditing ? (
                                                                        <>
                                                                            <button
                                                                                onClick={() => submitEditItem(item)}
                                                                                disabled={itemUpdating}
                                                                                className="p-2 text-green-600 hover:bg-green-50 rounded-lg disabled:opacity-50 transition-colors"
                                                                                title={t('orders.save_item')}
                                                                            >
                                                                                <Check size={16} />
                                                                            </button>
                                                                            <button
                                                                                onClick={cancelEditItem}
                                                                                disabled={itemUpdating}
                                                                                className="p-2 text-brand-muted hover:bg-gray-50 rounded-lg disabled:opacity-50 transition-colors"
                                                                                title={t('orders.cancel')}
                                                                            >
                                                                                <X size={16} />
                                                                            </button>
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <button
                                                                                onClick={() => startEditItem(item)}
                                                                                disabled={itemRemoving || itemUpdating}
                                                                                className="p-2 text-brand-muted hover:bg-gray-50 rounded-lg disabled:opacity-50 transition-colors"
                                                                                title={t('orders.edit_item')}
                                                                            >
                                                                                <Pencil size={16} />
                                                                            </button>
                                                                            <button
                                                                                onClick={() => confirmRemoveItem(item)}
                                                                                disabled={itemRemoving || itemUpdating}
                                                                                className="p-2 text-red-500 hover:bg-red-50 rounded-lg disabled:opacity-50 transition-colors"
                                                                                title={t('orders.remove_item')}
                                                                            >
                                                                                <Trash2 size={16} />
                                                                            </button>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </td>
                                                        )}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {/* Totals breakdown — GRAND_TOTAL can include a service/room
                            charge on top of the item subtotal (see SERVICE_CHARGE),
                            which otherwise makes the total look wrong next to the
                            visible items. Settled/cancelled orders already show the
                            charge as its own row inside the items table above, so
                            this only kicks in for orders still in progress. */}
                        {!(detailOrder.STATUS === ORDER_STATUS.SETTLED || detailOrder.STATUS === ORDER_STATUS.CANCELLED) &&
                            (detailServiceCharge > 0 || Number(detailOrder.TAX_AMOUNT || 0) > 0 || Number(detailOrder.DISCOUNT_AMOUNT || 0) > 0) && (
                                <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 space-y-1.5">
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-brand-muted">{t('orders.subtotal')}</span>
                                        <span className="font-semibold tabular-nums">
                                            ₱{formatPesoUpToTwoDecimals(Number(detailOrder.SUBTOTAL || 0))}
                                        </span>
                                    </div>
                                    {detailServiceCharge > 0 && (
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-brand-muted">
                                                {detailIsRoomCharge ? (t('table.room_charge') ?? 'Room charge') : t('orders.service_charge')}
                                            </span>
                                            <span className="font-semibold tabular-nums">
                                                ₱{formatPesoUpToTwoDecimals(detailServiceCharge)}
                                            </span>
                                        </div>
                                    )}
                                    {Number(detailOrder.TAX_AMOUNT || 0) > 0 && (
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-brand-muted">{t('orders.tax')}</span>
                                            <span className="font-semibold tabular-nums">
                                                ₱{formatPesoUpToTwoDecimals(Number(detailOrder.TAX_AMOUNT || 0))}
                                            </span>
                                        </div>
                                    )}
                                    {Number(detailOrder.DISCOUNT_AMOUNT || 0) > 0 && (
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-brand-muted">{t('orders.discount')}</span>
                                            <span className="font-semibold tabular-nums text-red-600">
                                                -₱{formatPesoUpToTwoDecimals(Number(detailOrder.DISCOUNT_AMOUNT || 0))}
                                            </span>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between text-sm pt-1.5 border-t border-gray-200">
                                        <span className="font-bold text-brand-text">{t('orders.grand_total')}</span>
                                        <span className="font-extrabold text-brand-primary tabular-nums">
                                            ₱{formatPesoUpToTwoDecimals(Number(detailOrder.GRAND_TOTAL))}
                                        </span>
                                    </div>
                                </div>
                            )}

                        {/* Additional items (add menu to this order) */}
                        {canUpdate('orders') && detailOrder.STATUS !== ORDER_STATUS.SETTLED && detailOrder.STATUS !== ORDER_STATUS.CANCELLED && (
                            <div className="space-y-3 pt-2 border-t border-gray-100">
                                <p className="text-xs font-bold text-brand-muted uppercase tracking-widest">
                                    {t('orders.additional_items')}
                                </p>
                                <div className="grid grid-cols-12 gap-3 items-end">
                                    <div className="col-span-7">
                                        <Select2
                                            options={detailMenus
                                                .filter((m) => !detailItems.some((it) => Number(it.MENU_ID) === Number(m.id)))
                                                .map((m) => ({
                                                    value: m.id,
                                                    label: `${m.name} — ₱${Number(m.price).toLocaleString()}`,
                                                }))}
                                            value={detailSelectedMenuId || null}
                                            onChange={(v) => setDetailSelectedMenuId(v ? String(v) : '')}
                                            placeholder={
                                                detailMenusLoading
                                                    ? t('orders.loading_menu')
                                                    : t('orders.select_item')
                                            }
                                            disabled={detailMenusLoading || detailAdding}
                                        />
                                    </div>
                                    <div className="col-span-2">
                                        <input
                                            type="number"
                                            min={1}
                                            value={detailAddQty}
                                            onChange={(e) => setDetailAddQty(Number(e.target.value))}
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="col-span-3">
                                        <button
                                            type="button"
                                            onClick={addDetailOrderItem}
                                            disabled={detailMenusLoading || detailAdding}
                                            className="w-full px-3 py-3 rounded-xl bg-brand-primary text-white font-bold text-sm hover:bg-brand-primary/90 disabled:opacity-50 transition-all flex items-center justify-center gap-1"
                                        >
                                            {detailAdding && <Loader2 size={14} className="animate-spin" />}
                                            {!detailAdding && <Plus size={14} />}
                                            {t('orders.add')}
                                        </button>
                                    </div>
                                </div>
                                <p className="text-[11px] text-brand-muted">
                                    {t('orders.additional_items_helper')}
                                </p>
                            </div>
                        )}

                        {canEditOrderMeta && (
                            <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
                                <button
                                    type="button"
                                    onClick={() => openEncodedDtModal(detailOrder)}
                                    disabled={encodedDtSubmitting}
                                    className="flex-1 px-4 py-3 bg-amber-500 text-white rounded-xl font-bold text-sm hover:bg-amber-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    <Calendar size={16} /> {t('orders.update_encoded_dt')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { closeDetail(); confirmSoftDelete(detailOrder); }}
                                    disabled={statusSubmitting}
                                    className="flex-1 px-4 py-3 bg-red-500 text-white rounded-xl font-bold text-sm hover:bg-red-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    <Trash2 size={16} /> {t('orders.soft_delete')}
                                </button>
                            </div>
                        )}

                        {canUpdate('orders') && detailOrder.STATUS !== ORDER_STATUS.SETTLED && detailOrder.STATUS !== ORDER_STATUS.CANCELLED && (
                            <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
                                {detailOrder.STATUS === ORDER_STATUS.PENDING && (
                                    <button
                                        onClick={() => { closeDetail(); confirmUpdateStatus(detailOrder, ORDER_STATUS.CONFIRMED); }}
                                        disabled={statusSubmitting}
                                        className="flex-1 px-4 py-3 bg-green-600 text-white rounded-xl font-bold text-sm hover:bg-green-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        <CheckCircle2 size={16} /> {t('orders.confirmed')}
                                    </button>
                                )}
                                <button onClick={() => { closeDetail(); confirmUpdateStatus(detailOrder, ORDER_STATUS.CANCELLED); }} disabled={statusSubmitting}
                                    className="flex-1 px-4 py-3 bg-red-500 text-white rounded-xl font-bold text-sm hover:bg-red-600 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                                    <XCircle size={16} /> {t('orders.cancel_order')}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </Modal>

            <Modal
                isOpen={!!encodedDtOrder}
                onClose={closeEncodedDtModal}
                title={t('orders.update_encoded_dt')}
                maxWidth="md"
                layerClassName="z-[70]"
                footer={
                    <div className="flex justify-end gap-3">
                        <button
                            type="button"
                            onClick={closeEncodedDtModal}
                            disabled={encodedDtSubmitting}
                            className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50"
                        >
                            {t('orders.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void saveEncodedDt()}
                            disabled={encodedDtSubmitting || !encodedDtValue}
                            className="px-5 py-2.5 rounded-xl font-bold bg-brand-primary text-white hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                            {encodedDtSubmitting && <Loader2 size={16} className="animate-spin" />}
                            {t('orders.save_encoded_dt')}
                        </button>
                    </div>
                }
            >
                {encodedDtOrder && (
                    <div className="space-y-4">
                        <p className="text-sm text-brand-muted">{t('orders.update_encoded_dt_helper')}</p>
                        <div>
                            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block mb-1.5">
                                {t('orders.order_no')}
                            </label>
                            <p className="text-sm font-bold">{encodedDtOrder.ORDER_NO}</p>
                        </div>
                        <div>
                            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block mb-1.5">
                                {t('orders.encoded_dt')}
                            </label>
                            <input
                                type="datetime-local"
                                step="1"
                                value={encodedDtValue}
                                onChange={(e) => setEncodedDtValue(e.target.value)}
                                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 outline-none transition-all"
                            />
                            <p className="text-[11px] text-brand-muted mt-2">
                                {t('orders.update_encoded_dt_tables')}
                            </p>
                        </div>
                    </div>
                )}
            </Modal>

            {/* SweetAlert-style popup */}
            <AnimatePresence>
                {swal && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4">
                        <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} transition={{ type: 'spring', damping: 25, stiffness: 300 }} className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
                            <div className="flex justify-center mb-4">
                                {swal.type === 'question' && <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center"><AlertCircle size={40} className="text-blue-500" /></div>}
                                {swal.type === 'success' && <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center"><CheckCircle2 size={40} className="text-green-500" /></div>}
                                {swal.type === 'error' && <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center"><X size={40} className="text-red-500" /></div>}
                                {swal.type === 'warning' && <div className="w-16 h-16 rounded-full bg-yellow-100 flex items-center justify-center"><AlertTriangle size={40} className="text-yellow-500" /></div>}
                            </div>
                            <h3 className="text-2xl font-bold text-brand-text text-center mb-2">{swal.title}</h3>
                            <p className="text-brand-muted text-center mb-6">{swal.text}</p>
                            <div className="flex justify-center gap-3">
                                {swal.showCancel && (
                                    <button onClick={() => { swal.onCancel?.(); setSwal(null); }} className="px-6 py-2.5 bg-gray-100 text-brand-muted rounded-xl font-bold hover:bg-gray-200 transition-all">{t('orders.cancel')}</button>
                                )}
                                <button onClick={async () => { if (swal.onConfirm) await swal.onConfirm(); }}
                                    className={cn('px-6 py-2.5 text-white rounded-xl font-bold transition-all',
                                        swal.type === 'error' ? 'bg-red-500 hover:bg-red-600' : swal.type === 'success' ? 'bg-green-500 hover:bg-green-600' : swal.type === 'question' ? 'bg-red-500 hover:bg-red-600' : 'bg-brand-primary hover:opacity-90')}>
                                    {swal.confirmText || t('orders.swal.ok')}
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
