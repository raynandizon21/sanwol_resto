import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation } from 'react-router-dom';
import { type ColumnDef } from '../ui/DataTable';
import { cn } from '../../lib/utils';
import { toUserFriendlyError } from '../../utils/userFriendlyErrors';
import { type Branch } from '../partials/Header';
import { toast } from 'sonner';
import { getOperationCategories, createOperationCategory, updateOperationCategory, deleteOperationCategory } from '../../services/operationCategoryService';
import {
  getAllMasterCategories,
  type InventoryCategory,
  createInventoryCategory,
  updateInventoryCategory,
  deleteInventoryCategory,
  type CreateInventoryCategoryPayload,
} from '../../services/inventoryService';
import { getExpenses, type ExpenseRecord, createExpense, updateExpense, deleteExpense, updateInventoryStock } from '../../services/expenseService';
import { uploadExpenseReceipt } from '../../services/uploadService';
import { compressReceiptImage, fetchReceiptScannerGeminiKey, stitchReceiptImages } from '../../services/receiptScannerService';
import { extractExpenseItemsFromReceiptImage, type ReceiptExpenseExtractionResult } from '../../services/receiptExpenseExtraction';
import { syncIngredientsFromExpenses } from '../../services/ingredientService';
import { preferredSubCategoryLabels, resolveExistingMasterCategoryId } from '../../utils/expenseCategoryResolve';
import { SidePanel } from '../ui/SidePanel';
import { Modal } from '../ui/Modal';
import { Edit2, Trash2, Plus, Loader2, Check, X, Search, Receipt, Upload, ScanLine, History, Eye } from 'lucide-react';
import { Skeleton, SkeletonTransition, SkeletonCard, SkeletonTable } from '../ui/Skeleton';
import { formatQty, getQtyInputStep, getUnitLabel, UOM_OPTIONS, canonicalUomValue } from '../../lib/uomUtils';
import { Select2 } from '../ui/Select2';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import {
  fetchExpenseSummaryApi,
  fetchExpenseCategoryBreakdownApi,
  type ApiExpenseCategoryRow,
} from '../../services/analyticsService';

type ExpensesMockProps = {
  selectedBranch: Branch | null;
  dateRange: {
    start: string;
    end: string;
  };
};

type Operation = {
  id: string;
  name: string;
  description?: string | null;
  state: number; // 1=inventory, 0=expense
  active: boolean;
};

type Category = {
  id: string;
  operationId: string;
  name: string;
  masterCategoryId?: string;
};

type GlobalSearchHit = {
  itemName: string;
  operationId: string;
  operationName: string;
  subCategoryId: string;
  subCategoryName: string;
};

const ITEMS_PER_PAGE = 50;
const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#22c55e', '#f97316'];

const distinctSeriesColor = (idx: number): string => {
  // Golden-angle palette: visually distinct even for many rows.
  const hue = (idx * 137.508) % 360;
  return `hsl(${hue} 78% 48%)`;
};

const DEFAULT_EXTRACTION_CATEGORIES = ['Food Supplies', 'Utilities', 'FRUITS', 'Others'];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Failed to read file'));
    r.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, filename: string): File {
  const arr = dataUrl.split(',');
  const mime = arr[0]?.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bstr = atob(arr[1] || '');
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mime });
}

function normalizeReceiptUnit(raw: string | null | undefined): string | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!s) return null;
  return canonicalUomValue(s);
}

// Operations, categories, and expenses are loaded from API (operation_category, master_categories, expenses tables).

const formatCurrency = (value: number) => {
  const safe = roundMoney2(Number.isFinite(value) ? value : 0);
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
};

const formatPercent = (value: number, digits = 1) => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(digits)}%`;
};

/** One row per uploaded receipt (lines live in `expenses`, not `receipt_scan_history`). */
type ExpenseReceiptHistoryRow = {
  receiptImagePath: string;
  ENCODED_DT: string;
  SOURCE: string;
  RECEIPT_GRAND_TOTAL: number;
};

function expenseRecordsToReceiptHistoryRows(records: ExpenseRecord[]): ExpenseReceiptHistoryRow[] {
  const map = new Map<string, ExpenseRecord[]>();
  for (const e of records) {
    const p = String(e.receiptImagePath || '').trim();
    if (!p) continue;
    const g = map.get(p);
    if (g) g.push(e);
    else map.set(p, [e]);
  }
  const out: ExpenseReceiptHistoryRow[] = [];
  for (const [path, group] of map.entries()) {
    const encodedList = group
      .map((g) => String(g.encodedDt || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const ENCODED_DT = encodedList.length ? encodedList[encodedList.length - 1] : '';
    const RECEIPT_GRAND_TOTAL = group.reduce((s, g) => s + Number(g.expAmount || 0), 0);
    const SOURCE = group[0]?.expSource ?? 'Resto_Admin';
    out.push({ receiptImagePath: path, ENCODED_DT, SOURCE, RECEIPT_GRAND_TOTAL });
  }
  out.sort((a, b) => String(b.ENCODED_DT).localeCompare(String(a.ENCODED_DT)));
  return out;
}

function receiptPathToDisplayUrl(path: string): string | null {
  const p = String(path || '').trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return `${window.location.origin}${p.startsWith('/') ? '' : '/'}${p}`;
}

/** Normalize EXP_SOURCE for filter (Resto_Admin → resto_admin, ReceiptLens → receiptlens). */
function normExpenseReceiptSource(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

const percentOf = (value: number, denom: number): number => {
  const v = Number(value) || 0;
  const d = Number(denom) || 0;
  if (!Number.isFinite(v) || !Number.isFinite(d) || d <= 0) return 0;
  return (v / d) * 100;
};

const formatYmdForLabel = (ymd: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const d = new Date(`${ymd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const pad2Ymd = (n: number) => String(n).padStart(2, '0');

const formatExpenseAmountInput = (raw: string): string => {
  const cleaned = String(raw || '').replace(/,/g, '').replace(/[^\d.]/g, '');
  if (!cleaned) return '';
  const firstDot = cleaned.indexOf('.');
  const normalized = firstDot === -1 ? cleaned : `${cleaned.slice(0, firstDot + 1)}${cleaned.slice(firstDot + 1).replace(/\./g, '')}`;
  const [intPartRaw, decPartRaw] = normalized.split('.');
  const decPart = decPartRaw !== undefined ? decPartRaw.slice(0, 2) : undefined;
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '');
  const grouped = (intPart || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (normalized.endsWith('.') && decPart === undefined) return `${grouped}.`;
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
};

const parseExpenseAmount = (value: string): number => Number(String(value || '').replace(/,/g, '').trim());

const roundMoney2 = (n: number) => Math.round(n * 100) / 100;

const DREAM_MART_DISCOUNT_BRANCH_ID = '2';
const DREAM_MART_DISCOUNT_MULTIPLIER = 0.85;

const isDreamMartSubCategoryName = (name: string | null | undefined): boolean => {
  const normalized = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return (
    normalized.includes('dream mart') ||
    normalized.includes('dreammart') ||
    normalized.includes('드림마트')
  );
};

const dreamMartDiscountApplies = (
  branchId: string | null | undefined,
  subCategoryName: string | null | undefined,
): boolean => String(branchId) === DREAM_MART_DISCOUNT_BRANCH_ID && isDreamMartSubCategoryName(subCategoryName);

const computeDreamMartNetAmount = (grossAmount: number): number =>
  roundMoney2(grossAmount * DREAM_MART_DISCOUNT_MULTIPLIER);

const dreamMartGrossFromNet = (netAmount: number): number => {
  if (!Number.isFinite(netAmount) || netAmount <= 0) return 0;
  return roundMoney2(netAmount / DREAM_MART_DISCOUNT_MULTIPLIER);
};

const resolveLineAmountForSave = (grossAmount: number, applyDreamMartDiscount: boolean): number => {
  const gross = roundMoney2(grossAmount);
  return applyDreamMartDiscount ? computeDreamMartNetAmount(gross) : gross;
};

const formatExpenseTableAmount = (value: number) =>
  new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    roundMoney2(Number.isFinite(value) ? value : 0),
  );

/** Per-expense line quantity (EXP_QTY), shown in table and forms for all categories. */
const expenseLineQty = (row: ExpenseRecord): number =>
  row.expQty != null && Number.isFinite(Number(row.expQty)) ? Number(row.expQty) : 0;

/** Main category Inventory toggle ON (STATE=1) → sync qty to stock; OFF → expense line qty only. */
const operationTracksInventory = (opId: string | null | undefined, ops: Operation[]): boolean => {
  if (opId == null || String(opId).trim() === '') return false;
  const op = ops.find((o) => String(o.id) === String(opId));
  return op?.state === 1;
};

const masterCatTracksInventory = (
  masterCatId: string | null | undefined,
  masters: InventoryCategory[],
  ops: Operation[],
): boolean => {
  if (masterCatId == null) return false;
  const mc = masters.find((c) => String(c.id) === String(masterCatId));
  return operationTracksInventory(mc?.opCategoryId ?? null, ops);
};

const expenseItemDisplayName = (row: ExpenseRecord) => String(row.expDesc || row.expName || '').trim();

const expenseUnitTrimmed = (unit: string | null | undefined) => String(unit ?? '').trim();

/** True when a real (non-template) expense row for this item already has a unit saved. */
const expenseItemHasEstablishedUnit = (row: ExpenseRecord, siblings: ExpenseRecord[]): boolean => {
  const name = expenseItemDisplayName(row);
  const rowHasUnit = (it: ExpenseRecord) => expenseUnitTrimmed(it.unit).length > 0;
  if (!name) return rowHasUnit(row);
  return siblings.some(
    (it) =>
      !String(it.id || '').startsWith('template-') &&
      expenseItemDisplayName(it) === name &&
      rowHasUnit(it),
  );
};

/** Latest unit for an item name from existing expense rows (newest encoded date first). */
const resolveEstablishedUnitForItem = (row: ExpenseRecord, siblings: ExpenseRecord[]): string => {
  const name = expenseItemDisplayName(row);
  const matches = siblings
    .filter(
      (it) =>
        !String(it.id || '').startsWith('template-') &&
        (!name || expenseItemDisplayName(it) === name) &&
        expenseUnitTrimmed(it.unit).length > 0,
    )
    .sort((a, b) => String(b.encodedDt || '').localeCompare(String(a.encodedDt || '')));
  return expenseUnitTrimmed(matches[0]?.unit) || expenseUnitTrimmed(row.unit);
};

/** EXP_AMOUNT is the manually entered amount for the line (independent of qty). */
const expenseLineAmountStored = (row: ExpenseRecord): number =>
  Number.isFinite(row.expAmount) ? Number(row.expAmount) : 0;

/** YYYY-MM-DD in Asia/Manila for an instant (aligns with dashboard daily-expenses / MySQL DATE in PH). */
const getManilaYmdFromDate = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return `${get('year')}-${pad2Ymd(get('month'))}-${pad2Ymd(get('day'))}`;
};

/**
 * Expense ENCODED_DT → calendar YYYY-MM-DD for range filters (Asia/Manila, same as Python analytics).
 * ISO UTC strings must not use `.slice(0, 10)` — that is the UTC day, not the PH billing day.
 */
function expenseEncodedYmd(encodedDt: string | null | undefined): string | null {
  const raw = (encodedDt || '').trim();
  if (!raw) return null;
  // ISO instant from JSON (e.g. 2026-06-30T19:11:45.000Z) → Manila calendar day.
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) || raw.endsWith('Z')) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    return getManilaYmdFromDate(new Date(ms));
  }
  const leadingYmd = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (leadingYmd) return leadingYmd[1];
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return getManilaYmdFromDate(new Date(ms));
}

/**
 * Same inclusion rules as Python `/api/analytics/daily-expenses` and `expense-summary`:
 * active expense row, active master_categories row, active operation_category (INNER JOIN).
 * Rows outside this scope still appear in the table but are excluded from Grand Total / breakdown
 * so totals match the branch dashboard chart.
 */
function expenseCountsTowardDashboardAnalytics(
  row: ExpenseRecord,
  masterById: Map<string, InventoryCategory>,
  opById: Map<string, Operation>,
): boolean {
  if (!row.active) return false;
  if (row.masterCatId == null || String(row.masterCatId).trim() === '') return false;
  const mc = masterById.get(String(row.masterCatId));
  if (!mc?.active) {
    // Linked master category may be outside branch-scoped category list; trust API join fields.
    return Boolean((row.expCat || '').trim());
  }
  if (mc.opCategoryId == null || String(mc.opCategoryId).trim() === '') return false;
  const oc = opById.get(String(mc.opCategoryId));
  return Boolean(oc?.active) || Boolean((row.expCat || '').trim());
}

/** Label used when Expense Breakdown groups by sub category (must match `expenseBreakdown` useMemo). */
function subCategoryBreakdownLabel(mc: InventoryCategory, useAnalyticsExpenseRows: boolean): string {
  if (useAnalyticsExpenseRows) {
    return ((mc.name || 'Unknown') as string).trim() || 'Unknown';
  }
  return ((mc.categoryType || mc.name || 'Unknown') as string).trim() || 'Unknown';
}

function tableItemBreakdownLabel(exp: ExpenseRecord, subCategoryName: string): string {
  const rawLabel = (exp.expDesc || exp.expName || exp.expSource || 'Unknown') as string;
  const label = rawLabel && rawLabel.trim() ? rawLabel.trim() : 'Unknown';
  if (label === subCategoryName) {
    return ((exp.expDesc || exp.expSource || exp.expName || 'Unknown') as string).trim() || 'Unknown';
  }
  return label;
}

/** Sum Python expense-breakdown rows (same source as Grand Total when analyticsGrandOk). */
function sumAnalyticsExpenseRows(
  rows: ApiExpenseCategoryRow[] | null | undefined,
  branchId: string,
  options: { opName?: string; subName?: string } = {},
): number {
  if (!rows?.length) return 0;
  const opKey = options.opName?.trim();
  const subKey = options.subName?.trim();
  return rows
    .filter((r) => String(r.branch_id) === String(branchId))
    .reduce((sum, r) => {
      if (opKey != null && String(r.exp_cat || '').trim() !== opKey) return sum;
      if (subKey != null && String(r.exp_name || '').trim() !== subKey) return sum;
      return sum + (Number(r.total_amount) || 0);
    }, 0);
}

/** Match expense line to operation + sub-category using API join fields (oc.NAME, mc.CATEGORY_NAME). */
function expenseMatchesOperationSubCategory(
  exp: ExpenseRecord,
  opName: string,
  subCategoryName: string,
): boolean {
  if ((Number(exp.expAmount) || 0) <= 0) return false;
  if ((exp.expCat || '').trim() !== opName.trim()) return false;
  return (exp.expName || '').trim() === subCategoryName.trim();
}

export const ExpensesMock: React.FC<ExpensesMockProps> = ({ selectedBranch, dateRange }) => {
  const location = useLocation();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [masterCategories, setMasterCategories] = useState<InventoryCategory[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  /** Same Python analytics as branch dashboard (expense-summary / expense-breakdown). */
  const [analyticsFinanceLoading, setAnalyticsFinanceLoading] = useState(false);
  const [analyticsGrandOk, setAnalyticsGrandOk] = useState(false);
  const [analyticsGrandTotal, setAnalyticsGrandTotal] = useState(0);
  const [analyticsExpenseBreakdownRows, setAnalyticsExpenseBreakdownRows] = useState<ApiExpenseCategoryRow[] | null>(null);
  /** Increment to re-run expense-summary / breakdown fetch so Grand Total matches table after CRUD (no full reload). */
  const [expenseAnalyticsRefreshKey, setExpenseAnalyticsRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tableItemsNameFilter, setTableItemsNameFilter] = useState<Set<string> | null>(null);
  const [globalSearch, setGlobalSearch] = useState('');
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

  const [isOperationPanelOpen, setIsOperationPanelOpen] = useState(false);
  const [isCategoryPanelOpen, setIsCategoryPanelOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingOperation, setEditingOperation] = useState<Operation | null>(null);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [operationToDelete, setOperationToDelete] = useState<Operation | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [isExpensePanelOpen, setIsExpensePanelOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseRecord | null>(null);
  const [expenseToDelete, setExpenseToDelete] = useState<ExpenseRecord | null>(null);
  const [expenseForm, setExpenseForm] = useState({
    expDesc: '',
    expAmount: '',
    expSource: '',
    stockQty: '',
    unit: '',
    // Stored as YYYY-MM-DD (from <input type="date" />)
    encodedDate: '',
  });
  const [addingAmountForId, setAddingAmountForId] = useState<string | null>(null);
  const [addingAmountValue, setAddingAmountValue] = useState('');
  const [addingQtyValue, setAddingQtyValue] = useState('');
  const [addingUnitValue, setAddingUnitValue] = useState('');
  const [editingQtyForId, setEditingQtyForId] = useState<string | null>(null);
  const [editingQtyValue, setEditingQtyValue] = useState('');

  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [receiptUploadLoading, setReceiptUploadLoading] = useState(false);
  const [receiptExtractLoading, setReceiptExtractLoading] = useState(false);
  const [receiptScanLoading, setReceiptScanLoading] = useState(false);
  const [receiptSendLoading, setReceiptSendLoading] = useState(false);
  const [receiptFileError, setReceiptFileError] = useState<string | null>(null);
  const [receiptPreviewDataUrl, setReceiptPreviewDataUrl] = useState<string | null>(null);
  const [uploadedReceiptPath, setUploadedReceiptPath] = useState<string | null>(null);
  const [receiptExtractResult, setReceiptExtractResult] = useState<ReceiptExpenseExtractionResult | null>(null);
  const [receiptEncodedDateYmd, setReceiptEncodedDateYmd] = useState('');
  const [receiptSegments, setReceiptSegments] = useState<string[]>([]);
  const [receiptScannedImage, setReceiptScannedImage] = useState<string | null>(null);
  const [receiptPreviewLightboxOpen, setReceiptPreviewLightboxOpen] = useState(false);
  const [receiptSaveConfirmOpen, setReceiptSaveConfirmOpen] = useState(false);
  const [receiptHistoryOpen, setReceiptHistoryOpen] = useState(false);
  const [receiptHistoryRows, setReceiptHistoryRows] = useState<ExpenseReceiptHistoryRow[]>([]);
  const [receiptHistoryLoading, setReceiptHistoryLoading] = useState(false);
  const [receiptHistoryError, setReceiptHistoryError] = useState<string | null>(null);
  const [receiptHistoryPageSize, setReceiptHistoryPageSize] = useState<number>(20);
  const [receiptHistorySourceFilter, setReceiptHistorySourceFilter] = useState<
    'all' | 'resto_admin' | 'receiptlens'
  >('all');
  const [breakdownDetailModal, setBreakdownDetailModal] = useState<{
    title: string;
    subtitle: string;
    expenses: ExpenseRecord[];
    total: number;
  } | null>(null);
  const [receiptHistoryDetailOpen, setReceiptHistoryDetailOpen] = useState(false);
  const [receiptHistoryDetailLoading, setReceiptHistoryDetailLoading] = useState(false);
  const [receiptHistoryDetail, setReceiptHistoryDetail] = useState<{
    receiptImagePath: string;
    receiptImageDisplayUrl: string | null;
  } | null>(null);

  const [operationForm, setOperationForm] = useState<{ name: string; description: string; state: number }>({
    name: '',
    description: '',
    state: 0, // 0=expense, 1=inventory
  });

  const [categoryForm, setCategoryForm] = useState<{ name: string; description: string; isManualStock: boolean }>({
    name: '',
    description: '',
    isManualStock: false,
  });

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();

  const tableItemsScrollRef = useRef<HTMLDivElement | null>(null);
  const expenseBreakdownRef = useRef<HTMLDivElement | null>(null);
  const globalSearchWrapRef = useRef<HTMLDivElement | null>(null);
  /** Skip one auto-nav cycle after an explicit dropdown pick. */
  const skipGlobalSearchAutoNavRef = useRef(false);

  const scrollTableItemsToTop = useCallback(() => {
    requestAnimationFrame(() => {
      tableItemsScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, []);

  const scrollPageToTop = useCallback(() => {
    const appScroller = document.querySelector('[data-app-scroll-container]') as HTMLElement | null;
    if (appScroller) {
      appScroller.scrollTop = 0;
      return;
    }
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const shouldJumpToBreakdown = params.get('breakdown') === '1';
    if (!shouldJumpToBreakdown) return;

    // When entering from dashboard breakdown links, default to "all categories"
    // so users immediately see the full breakdown, not a stale previous selection.
    setSelectedOperationId(null);
    setSelectedCategoryId(null);
    setTableItemsNameFilter(null);

    requestAnimationFrame(() => {
      expenseBreakdownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [location.search]);

  const isSpecificBranch = selectedBranch != null && String(selectedBranch.id) !== 'all';

  // Keep ENCODED_DT consistent with Orders UI using Asia/Manila.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const getManilaParts = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute'),
      second: get('second'),
    };
  };
  const getManilaDateStr = (d: Date) => {
    const p = getManilaParts(d);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  };
  const toManilaDateTimeStr = (dateStr: string) => {
    const [yy, mm, dd] = dateStr.split('-').map((x) => Number(x));
    const p = getManilaParts(new Date());
    const timePart = `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
    return `${yy}-${pad2(mm)}-${pad2(dd)} ${timePart}`;
  };
  const getCurrentManilaRange = () => {
    const now = new Date();
    const p = getManilaParts(now);
    return {
      start: `${p.year}-${pad2(p.month)}-01`,
      end: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    };
  };

  // Load operations from operation_category table and categories from master_categories (by BRANCH_ID)
  useEffect(() => {
    let isMounted = true;

    const loadOperations = async () => {
      try {
        if (!isSpecificBranch) {
          setOperations([]);
          setMasterCategories([]);
          setExpenses([]);
          setLoading(false);
          return;
        }
        const resolvedBranchId =
          !selectedBranch || String(selectedBranch.id) === 'all' ? '' : String(selectedBranch.id);

        if (!resolvedBranchId) {
          setOperations([]);
          setMasterCategories([]);
          setExpenses([]);
          setLoading(false);
          return;
        }

        setLoading(true);
        if (isMounted) {
          setBranchId(resolvedBranchId);
        }

        const rangeStart = dateRange?.start || getCurrentManilaRange().start;
        const rangeEnd = dateRange?.end || getCurrentManilaRange().end;

        const [apiOps, apiCats, apiExpenses] = await Promise.all([
          getOperationCategories(resolvedBranchId),
          getAllMasterCategories(resolvedBranchId),
          getExpenses(resolvedBranchId, { startDate: rangeStart, endDate: rangeEnd }),
        ]);
        if (!isMounted) return;

        // Ensure data is strictly scoped to the currently selected branch.
        // Include operations that match the branch OR have no branch (global/shared).
        const filteredOps = apiOps.filter(
          (row) =>
            row.branchId == null || String(row.branchId) === resolvedBranchId,
        );
        const mapped: Operation[] = filteredOps.map((row) => ({
          id: String(row.id),
          name: row.name,
          description: row.description ?? null,
          state: row.state === 1 ? 1 : 0,
          active: row.active,
        }));
        mapped.sort((a, b) => {
          const numA = /^(\d+)\.?\s/.exec(a.name);
          const numB = /^(\d+)\.?\s/.exec(b.name);
          if (numA && numB) {
            const nA = parseInt(numA[1], 10);
            const nB = parseInt(numB[1], 10);
            if (nA !== nB) return nA - nB;
          }
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        });

        const filteredCategories = apiCats.filter(
          (cat) => String(cat.branchId) === resolvedBranchId,
        );
        const filteredExpenses = apiExpenses.filter(
          (exp) => String(exp.branchId) === resolvedBranchId,
        );

        setOperations(mapped);
        setMasterCategories(filteredCategories);
        setExpenses(filteredExpenses);
        setSelectedOperationId((prev) => prev && mapped.some((op) => op.id === prev) ? prev : null);
      } catch (error) {
        console.error('Failed to load operation categories:', error);
        setOperations([]);
        setMasterCategories([]);
        setExpenses([]);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadOperations();

    return () => {
      isMounted = false;
    };
  }, [isSpecificBranch, selectedBranch?.id, dateRange?.start, dateRange?.end]);

  const selectedOperation = useMemo(() => {
    if (!selectedOperationId) return null;
    return operations.find((op) => op.id === selectedOperationId) ?? null;
  }, [operations, selectedOperationId]);

  const categoriesForOperation = useMemo(() => {
    if (!selectedOperationId) return [];
    // Derive categories from master_categories table using OP_CAT_ID mapping
    const cats = masterCategories.filter(
      (cat) => cat.opCategoryId != null && cat.opCategoryId === selectedOperationId,
    );
    const byType = new Map<string, { id: string; label: string; masterCategoryId: string }>();

    cats.forEach((cat) => {
      const typeLabel = (cat.categoryType || cat.name || '').trim();
      if (!typeLabel) return;
      if (!byType.has(typeLabel)) {
        byType.set(typeLabel, {
          id: typeLabel,
          label: typeLabel,
          masterCategoryId: cat.id,
        });
      }
    });

    return Array.from(byType.values())
      .map<Category>((entry) => ({
        id: entry.id,
        operationId: selectedOperationId,
        name: entry.label,
        masterCategoryId: entry.masterCategoryId,
      }))
      .sort((a, b) => {
        const numA = /^(\d+)\.?\s/.exec(a.name);
        const numB = /^(\d+)\.?\s/.exec(b.name);
        if (numA && numB) {
          const nA = parseInt(numA[1], 10);
          const nB = parseInt(numB[1], 10);
          if (nA !== nB) return nA - nB;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }, [masterCategories, selectedOperationId]);

  const selectedCategory = useMemo(() => {
    if (!selectedCategoryId) return null;
    const op = selectedOperationId;
    const fromDerived = op
      ? categoriesForOperation.find((c) => c.id === selectedCategoryId) ?? null
      : null;
    return fromDerived;
  }, [categoriesForOperation, selectedCategoryId, selectedOperationId]);

  const effectiveDateRange = useMemo(() => {
    const fallback = getCurrentManilaRange();
    return {
      start: dateRange.start || fallback.start,
      end: dateRange.end || fallback.end,
    };
  }, [dateRange.end, dateRange.start]);

  const loadExpenseList = useCallback(
    (bid?: string) =>
      getExpenses(bid, {
        startDate: effectiveDateRange.start,
        endDate: effectiveDateRange.end,
      }),
    [effectiveDateRange.end, effectiveDateRange.start],
  );

  const dateRangeLabel = useMemo(
    () => `${formatYmdForLabel(effectiveDateRange.start)} - ${formatYmdForLabel(effectiveDateRange.end)}`,
    [effectiveDateRange.end, effectiveDateRange.start],
  );

  const extractionCategoryTypes = useMemo(() => {
    const opStateById = new Map(
      (operations || []).map((o) => [String(o.id), Number(o.state) === 1 ? 1 : 0] as const),
    );
    const list = preferredSubCategoryLabels(masterCategories || [], opStateById).slice(0, 40);
    return list.length ? list : DEFAULT_EXTRACTION_CATEGORIES;
  }, [masterCategories, operations]);

  const openReceiptModal = useCallback(() => {
    setReceiptFileError(null);
    setReceiptPreviewDataUrl(null);
    setUploadedReceiptPath(null);
    setReceiptExtractResult(null);
    setReceiptSegments([]);
    setReceiptScannedImage(null);
    setReceiptPreviewLightboxOpen(false);
    setReceiptSaveConfirmOpen(false);
    setReceiptUploadLoading(false);
    setReceiptExtractLoading(false);
    setReceiptScanLoading(false);
    setReceiptSendLoading(false);
    setReceiptEncodedDateYmd(effectiveDateRange.end || '');
    setIsReceiptModalOpen(true);
  }, [effectiveDateRange.end]);

  const closeReceiptModal = useCallback(() => {
    if (receiptUploadLoading || receiptExtractLoading || receiptSendLoading) return;
    setReceiptPreviewLightboxOpen(false);
    setReceiptSaveConfirmOpen(false);
    setIsReceiptModalOpen(false);
  }, [receiptUploadLoading, receiptExtractLoading, receiptSendLoading]);

  useEffect(() => {
    if (!receiptPreviewLightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReceiptPreviewLightboxOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [receiptPreviewLightboxOpen]);

  useEffect(() => {
    if (!receiptScannedImage) setReceiptPreviewLightboxOpen(false);
  }, [receiptScannedImage]);

  const handleReceiptFilePicked = useCallback(async (file: File | null) => {
    setReceiptFileError(null);
    setReceiptPreviewDataUrl(null);
    setUploadedReceiptPath(null);
    setReceiptExtractResult(null);
    setReceiptScannedImage(null);
    if (!file) return;
    try {
      const raw = await fileToDataUrl(file);
      const jpeg = await compressReceiptImage(raw).catch(() => raw);
      setReceiptSegments((prev) => [...prev, jpeg].slice(0, 8));
    } catch (e) {
      setReceiptFileError(toUserFriendlyError(e));
    }
  }, []);

  const scanReceipt = useCallback(async () => {
    if (!receiptSegments.length) return;
    setReceiptFileError(null);
    setReceiptExtractResult(null);
    setReceiptScanLoading(true);
    try {
      let stitched: string;
      if (receiptSegments.length === 1) stitched = receiptSegments[0];
      else {
        stitched = await stitchReceiptImages(receiptSegments, { maxWidth: 1400, maxHeight: 8192, quality: 90 });
      }
      const compressed = await compressReceiptImage(stitched).catch(() => stitched);
      setReceiptScannedImage(compressed);
      setReceiptPreviewDataUrl(compressed);
      setReceiptExtractLoading(true);
      try {
        const extracted = await extractExpenseItemsFromReceiptImage({
          imageDataUrl: compressed,
          apiKey: undefined,
          categories: extractionCategoryTypes,
        });
        setReceiptExtractResult(extracted);
      } catch (e) {
        setReceiptFileError(toUserFriendlyError(e));
        setReceiptExtractResult(null);
      } finally {
        setReceiptExtractLoading(false);
      }
    } catch (e) {
      setReceiptFileError(toUserFriendlyError(e));
      setReceiptScannedImage(null);
      setReceiptPreviewDataUrl(null);
    } finally {
      setReceiptScanLoading(false);
    }
  }, [receiptSegments, extractionCategoryTypes]);

  const openReceiptHistory = useCallback(() => {
    if (!branchId || branchId === 'all') {
      toast.error('Select a branch first');
      return;
    }
    setReceiptHistoryOpen(true);
  }, [branchId]);

  useEffect(() => {
    if (!receiptHistoryOpen) return;
    if (!branchId || branchId === 'all') return;
    let cancelled = false;
    setReceiptHistoryLoading(true);
    setReceiptHistoryError(null);
    void (async () => {
      try {
        const list = await loadExpenseList(String(branchId));
        const scoped = list.filter((e) => String(e.branchId) === String(branchId));
        if (!cancelled) setReceiptHistoryRows(expenseRecordsToReceiptHistoryRows(scoped));
      } catch (e) {
        if (!cancelled) setReceiptHistoryError(toUserFriendlyError(e));
      } finally {
        if (!cancelled) setReceiptHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receiptHistoryOpen, branchId]);

  const openReceiptHistoryDetail = useCallback((receiptImagePath: string) => {
    setReceiptHistoryDetailOpen(true);
    setReceiptHistoryDetailLoading(false);
    setReceiptHistoryDetail({
      receiptImagePath,
      receiptImageDisplayUrl: receiptPathToDisplayUrl(receiptImagePath),
    });
  }, []);

  const sendExtractedReceiptToExpenses = useCallback(async () => {
    if (!branchId || branchId === 'all') {
      toast.error('Select a branch first');
      return;
    }
    if (!receiptExtractResult?.items?.length) return;

    setReceiptFileError(null);
    setReceiptSendLoading(true);
    try {
      let receiptPath = uploadedReceiptPath;
      if (!receiptPath) {
        const img = receiptScannedImage || receiptPreviewDataUrl;
        if (!img) throw new Error('Scan receipt first.');
        setReceiptUploadLoading(true);
        try {
          const file = dataUrlToFile(img, `expense-receipt-${Date.now()}.jpg`);
          const uploaded = await uploadExpenseReceipt(file);
          receiptPath = uploaded.path || null;
          setUploadedReceiptPath(receiptPath);
        } finally {
          setReceiptUploadLoading(false);
        }
      }

      const resolvedOp = operations.find((o) => o.active && o.state === 1) ?? operations.find((o) => o.active) ?? null;
      const defaultOpCategoryId = resolvedOp?.id ?? null;
      const opStateById = new Map(
        operations.map((o) => [String(o.id), Number(o.state) === 1 ? 1 : 0] as const),
      );
      const categoryMap = new Map<string, string>();

      const resolveCategory = (extractedCategory: string): string => {
        const key = String(extractedCategory || '').trim() || 'Others';
        const cached = categoryMap.get(key);
        if (cached) return cached;
        const masterCatId = resolveExistingMasterCategoryId(
          masterCategories,
          key,
          defaultOpCategoryId,
          opStateById,
        );
        categoryMap.set(key, masterCatId);
        return masterCatId;
      };

      const encodedDt =
        receiptEncodedDateYmd && /^\d{4}-\d{2}-\d{2}$/.test(receiptEncodedDateYmd)
          ? `${receiptEncodedDateYmd} 12:00:00`
          : null;

      await Promise.all(
        receiptExtractResult.items.map(async (item) => {
          const qty = item.qty != null && Number.isFinite(Number(item.qty)) ? Number(item.qty) : 0;
          const masterCatId = resolveCategory(item.category);
          const unit = normalizeReceiptUnit(item.unit);
          const masterCat = masterCategories.find((mc) => String(mc.id) === String(masterCatId));
          const receiptGross = Number(item.price || 0);
          const receiptAmount = dreamMartDiscountApplies(branchId, masterCat?.categoryType || masterCat?.name)
            ? computeDreamMartNetAmount(receiptGross)
            : receiptGross;
          const newId = await createExpense({
            branchId,
            masterCatId,
            expDesc: String(item.name || '').trim() || null,
            expAmount: receiptAmount,
            expQty: qty > 0 ? qty : null,
            expSource: 'Resto_Admin',
            unit: unit ?? null,
            receiptImagePath: receiptPath ?? null,
            encodedDt,
          });
          if (masterCatTracksInventory(masterCatId, masterCategories, operations) && unit) {
            try {
              const stockQty = qty > 0 ? qty : 0;
              await updateInventoryStock(String(newId), stockQty, branchId, true, unit);
            } catch {
              // non-fatal
            }
          }
        }),
      );

      try {
        await syncIngredientsFromExpenses();
      } catch {
        // non-fatal
      }

      const list = await loadExpenseList(branchId);
      setExpenses(list.filter((e) => String(e.branchId) === String(branchId)));
      toast.success('Receipt items saved to Expenses');
      setReceiptSaveConfirmOpen(false);
      setIsReceiptModalOpen(false);
      setExpenseAnalyticsRefreshKey((k) => k + 1);
    } catch (e) {
      setReceiptFileError(toUserFriendlyError(e));
    } finally {
      setReceiptSendLoading(false);
    }
  }, [
    branchId,
    operations,
    masterCategories,
    receiptExtractResult,
    receiptEncodedDateYmd,
    uploadedReceiptPath,
    receiptScannedImage,
    receiptPreviewDataUrl,
  ]);

  const openReceiptSaveConfirm = useCallback(() => {
    if (!branchId || branchId === 'all') {
      toast.error('Select a branch first');
      return;
    }
    if (!receiptExtractResult?.items?.length) return;
    setReceiptSaveConfirmOpen(true);
  }, [branchId, receiptExtractResult]);

  const receiptSaveEncodedDateLabel = useMemo(() => {
    if (!receiptEncodedDateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(receiptEncodedDateYmd)) return 'Not set';
    const d = new Date(`${receiptEncodedDateYmd}T12:00:00`);
    if (Number.isNaN(d.getTime())) return receiptEncodedDateYmd;
    return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }, [receiptEncodedDateYmd]);

  const receiptHistoryRowsInRange = useMemo(() => {
    const { start, end } = effectiveDateRange;
    let inRange = (receiptHistoryRows || []).filter((r) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return true;
      const ymd = String(r.ENCODED_DT || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
      return ymd >= start && ymd <= end;
    });
    if (receiptHistorySourceFilter !== 'all') {
      inRange = inRange.filter((r) => normExpenseReceiptSource(r.SOURCE) === receiptHistorySourceFilter);
    }
    return inRange.slice(0, Math.max(1, receiptHistoryPageSize));
  }, [effectiveDateRange, receiptHistoryRows, receiptHistoryPageSize, receiptHistorySourceFilter]);

  const refreshExpenseAnalyticsFromServer = useCallback(() => {
    setExpenseAnalyticsRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!isSpecificBranch || !branchId) {
      setAnalyticsGrandOk(false);
      setAnalyticsExpenseBreakdownRows(null);
      setAnalyticsFinanceLoading(false);
      return;
    }
    const { start, end } = effectiveDateRange;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      setAnalyticsGrandOk(false);
      setAnalyticsExpenseBreakdownRows(null);
      return;
    }

    let cancelled = false;
    setAnalyticsFinanceLoading(true);
    setAnalyticsGrandOk(false);
    setAnalyticsExpenseBreakdownRows(null);

    const params = new URLSearchParams();
    params.set('start_date', start);
    params.set('end_date', end);
    params.set('branch_id', branchId);

    void (async () => {
      try {
        const [sumRes, brRes] = await Promise.allSettled([
          fetchExpenseSummaryApi(new URLSearchParams(params)),
          fetchExpenseCategoryBreakdownApi(new URLSearchParams(params)),
        ]);
        if (cancelled) return;

        if (sumRes.status === 'fulfilled') {
          setAnalyticsGrandTotal(Number(sumRes.value.total_expense ?? 0));
          setAnalyticsGrandOk(true);
          if (brRes.status === 'fulfilled') {
            setAnalyticsExpenseBreakdownRows(brRes.value);
          } else {
            setAnalyticsExpenseBreakdownRows(null);
          }
        } else {
          setAnalyticsGrandOk(false);
          setAnalyticsExpenseBreakdownRows(null);
        }
      } catch {
        if (!cancelled) {
          setAnalyticsGrandOk(false);
          setAnalyticsExpenseBreakdownRows(null);
        }
      } finally {
        if (!cancelled) setAnalyticsFinanceLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSpecificBranch, branchId, effectiveDateRange.start, effectiveDateRange.end, expenseAnalyticsRefreshKey]);

  const expensesInRange = useMemo(() => {
    const { start, end } = effectiveDateRange;
    return expenses.filter((row) => {
      const encodedYmd = expenseEncodedYmd(row.encodedDt);
      if (!encodedYmd || !/^\d{4}-\d{2}-\d{2}$/.test(encodedYmd)) return false;
      return encodedYmd >= start && encodedYmd <= end;
    });
  }, [effectiveDateRange, expenses]);

  const expensesInAnalyticsRange = useMemo(() => {
    const masterById = new Map(masterCategories.map((c) => [String(c.id), c]));
    const opById = new Map(operations.map((o) => [String(o.id), o]));
    return expensesInRange.filter((row) =>
      expenseCountsTowardDashboardAnalytics(row, masterById, opById),
    );
  }, [expensesInRange, masterCategories, operations]);

  const grandTotalExpenses = useMemo(
    () => expensesInAnalyticsRange.reduce((sum, row) => sum + row.expAmount, 0),
    [expensesInAnalyticsRange],
  );

  const grandTotalDisplayed = analyticsGrandOk ? analyticsGrandTotal : grandTotalExpenses;

  const itemsForCategory = useMemo(() => {
    if (!selectedCategory) return [];

    // Selected category represents CATEGORY_TYPE; gather all master category IDs for this type + operation
    const relevantMasterIds = new Set(
      masterCategories
        .filter(
          (cat) =>
            cat.opCategoryId != null &&
            cat.opCategoryId === selectedOperationId &&
            (cat.categoryType || cat.name || '').trim() === selectedCategory.name,
        )
        .map((cat) => cat.id),
    );

    if (relevantMasterIds.size === 0) return [];

    return expenses
      .filter((exp) => exp.masterCatId != null && relevantMasterIds.has(exp.masterCatId))
      .slice()
      .sort((a, b) => {
        const ad = a.encodedDt || '';
        const bd = b.encodedDt || '';
        return ad < bd ? 1 : -1;
      });
  }, [expenses, masterCategories, selectedCategory, selectedOperationId]);

  const rangeEntriesForCategory = useMemo(() => {
    const { start, end } = effectiveDateRange;
    return itemsForCategory.filter((row) => {
      const encodedYmd = expenseEncodedYmd(row.encodedDt);
      if (!encodedYmd || !/^\d{4}-\d{2}-\d{2}$/.test(encodedYmd)) return false;
      return encodedYmd >= start && encodedYmd <= end;
    });
  }, [effectiveDateRange, itemsForCategory]);

  const rangeEntriesForCategoryAnalytics = useMemo(() => {
    const masterById = new Map(masterCategories.map((c) => [String(c.id), c]));
    const opById = new Map(operations.map((o) => [String(o.id), o]));
    return rangeEntriesForCategory.filter((row) =>
      expenseCountsTowardDashboardAnalytics(row, masterById, opById),
    );
  }, [rangeEntriesForCategory, masterCategories, operations]);

  const tableRowsForCategory = useMemo(() => {
    const rangedNameSet = new Set(
      rangeEntriesForCategory.map((row) => String(row.expDesc || row.expName || '').trim()).filter(Boolean),
    );
    const templateByName = new Map<string, ExpenseRecord>();

    for (const row of itemsForCategory) {
      const name = String(row.expDesc || row.expName || '').trim();
      if (!name || rangedNameSet.has(name)) continue;
      if (!templateByName.has(name)) {
        templateByName.set(name, {
          ...row,
          id: `template-${name.toLowerCase().replace(/\s+/g, '-')}`,
          expAmount: 0,
          expQty: 0,
          stockQty: 0,
          encodedDt: '',
        });
      }
    }

    return [...rangeEntriesForCategory, ...Array.from(templateByName.values())];
  }, [itemsForCategory, rangeEntriesForCategory]);

  const expenseBreakdown = useMemo(() => {
    // Build a simple breakdown based on current selection.
    // - If a main category is selected (no sub category): group by CATEGORY_TYPE (sub-category).
    // - If a sub category is selected: group by "table items" (expense item names) under that sub category.
    // - Else: group by sub category (CATEGORY_TYPE) across all main categories.
    type Row = { name: string; value: number };

    const add = (map: Map<string, number>, key: string, amount: number) => {
      const k = (key || 'Unknown').trim() || 'Unknown';
      map.set(k, (map.get(k) || 0) + (Number(amount) || 0));
    };

    const map = new Map<string, number>();

    if (selectedCategory) {
      // Sub category selected → mirror analytics scope (dashboard chart / Python totals)
      for (const exp of rangeEntriesForCategoryAnalytics) {
        const amount = Number(exp.expAmount) || 0;
        if (amount <= 0) continue;
        add(map, tableItemBreakdownLabel(exp, selectedCategory.name), amount);
      }
    } else if (
      analyticsGrandOk &&
      analyticsExpenseBreakdownRows !== null &&
      branchId &&
      !selectedCategory
    ) {
      const filtered = analyticsExpenseBreakdownRows.filter((r) => String(r.branch_id) === String(branchId));
      if (selectedOperationId) {
        const op = operations.find((o) => o.id === selectedOperationId);
        const opName = (op?.name || '').trim();
        for (const r of filtered) {
          if (String(r.exp_cat || '').trim() !== opName) continue;
          add(map, (r.exp_name || 'Unknown') as string, Number(r.total_amount || 0));
        }
      } else {
        for (const r of filtered) {
          add(map, (r.exp_cat || 'Uncategorized') as string, Number(r.total_amount || 0));
        }
      }
    } else {
      const masterById = new Map<string, InventoryCategory>();
      for (const mc of masterCategories) {
        masterById.set(String(mc.id), mc);
      }

      const opById = new Map<string, Operation>();
      for (const op of operations) {
        opById.set(String(op.id), op);
      }

      for (const exp of expensesInAnalyticsRange) {
        const amount = Number(exp.expAmount) || 0;
        if (amount <= 0) continue;

        const mc = exp.masterCatId != null ? masterById.get(String(exp.masterCatId)) : undefined;

        if (selectedOperationId) {
          // Under the selected main category, group by CATEGORY_TYPE
          if (mc?.opCategoryId == null || String(mc.opCategoryId) !== String(selectedOperationId)) continue;
          add(map, subCategoryBreakdownLabel(mc, false), amount);
          continue;
        }

        // Nothing selected: group by main category (operation)
        const opId = mc?.opCategoryId != null ? String(mc.opCategoryId) : '';
        const opName = opById.get(opId)?.name || 'Uncategorized';
        add(map, opName, amount);
      }
    }

    const rows: Row[] = Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);

    // Only collapse into "Others" when viewing table items of a specific sub category.
    // For main/sub-category summaries, show all rows so nothing appears "missing".
    if (!selectedCategory) {
      const allKeys = new Set(rows.map((r) => r.name));
      return {
        rows,
        topKeys: allKeys,
        othersKeys: new Set<string>(),
        hasOthers: false,
      };
    }

    const top = rows.slice(0, 6);
    const rest = rows.slice(6);
    const restSum = rest.reduce((s, r) => s + r.value, 0);

    const topKeys = new Set(top.map((r) => r.name));
    const othersKeys = new Set(rest.map((r) => r.name));

    const output = restSum > 0 ? [...top, { name: 'Others', value: restSum }] : top;

    return {
      rows: output,
      topKeys,
      othersKeys,
      hasOthers: restSum > 0,
    };
  }, [
    analyticsExpenseBreakdownRows,
    analyticsGrandOk,
    branchId,
    expensesInAnalyticsRange,
    masterCategories,
    operations,
    rangeEntriesForCategoryAnalytics,
    selectedCategory,
    selectedOperationId,
  ]);

  const breakdownUsesAnalyticsSubCategoryRows = useMemo(
    () =>
      analyticsGrandOk &&
      analyticsExpenseBreakdownRows !== null &&
      Boolean(branchId) &&
      Boolean(selectedOperationId) &&
      !selectedCategory,
    [analyticsGrandOk, analyticsExpenseBreakdownRows, branchId, selectedCategory, selectedOperationId],
  );

  const openBreakdownRowDetail = useCallback(
    (rowName: string) => {
      const masterById = new Map(masterCategories.map((c) => [String(c.id), c]));
      let items: ExpenseRecord[] = [];
      const opName = (selectedOperation?.name || '').trim();

      if (selectedCategory) {
        // "Others" rolls up every item beyond the top 6 rows, so match against
        // the whole group of names instead of a single exact name.
        const matchNames = rowName === 'Others' ? expenseBreakdown.othersKeys : new Set([rowName]);
        items = rangeEntriesForCategoryAnalytics.filter((exp) =>
          matchNames.has(tableItemBreakdownLabel(exp, selectedCategory.name)),
        );
        if (items.length === 0) {
          items = expensesInRange.filter((exp) =>
            matchNames.has(tableItemBreakdownLabel(exp, selectedCategory.name)),
          );
        }
      } else if (rowName !== 'Others' && selectedOperationId) {
        if (breakdownUsesAnalyticsSubCategoryRows && opName) {
          items = expensesInRange.filter((exp) =>
            expenseMatchesOperationSubCategory(exp, opName, rowName),
          );
        }
        if (items.length === 0) {
          items = expensesInAnalyticsRange.filter((exp) => {
            const mc = exp.masterCatId != null ? masterById.get(String(exp.masterCatId)) : undefined;
            if (!mc || String(mc.opCategoryId) !== String(selectedOperationId)) return false;
            return subCategoryBreakdownLabel(mc, breakdownUsesAnalyticsSubCategoryRows) === rowName;
          });
        }
        if (items.length === 0 && opName) {
          items = expensesInRange.filter((exp) =>
            expenseMatchesOperationSubCategory(exp, opName, rowName),
          );
        }
      } else {
        return;
      }

      items.sort((a, b) => {
        const ad = expenseEncodedYmd(a.encodedDt) || '';
        const bd = expenseEncodedYmd(b.encodedDt) || '';
        return bd.localeCompare(ad);
      });

      const total = items.reduce((sum, row) => sum + (Number(row.expAmount) || 0), 0);
      const subtitle = selectedCategory
        ? `${selectedOperation?.name ?? ''} • ${selectedCategory.name}`
        : (selectedOperation?.name ?? '');

      setBreakdownDetailModal({
        title: rowName,
        subtitle: subtitle.trim(),
        expenses: items,
        total,
      });
    },
    [
      breakdownUsesAnalyticsSubCategoryRows,
      expenseBreakdown,
      expensesInAnalyticsRange,
      expensesInRange,
      masterCategories,
      rangeEntriesForCategoryAnalytics,
      selectedCategory,
      selectedOperation,
      selectedOperationId,
    ],
  );

  // Unit for expense form: from explicit selection (required when adding) or pre-filled when editing
  const expenseFormUnit = expenseForm.unit || expenseUnitTrimmed(editingExpense?.unit);

  const totalForView = useMemo(() => {
    if (selectedCategoryId && selectedCategory) {
      return rangeEntriesForCategoryAnalytics.reduce((sum, row) => sum + row.expAmount, 0);
    }
    if (selectedOperationId) {
      const opName = (selectedOperation?.name || '').trim();
      const opMasterIds = new Set(
        masterCategories
          .filter((cat) => cat.opCategoryId != null && cat.opCategoryId === selectedOperationId)
          .map((cat) => cat.id),
      );
      const localTotal = expensesInAnalyticsRange.reduce(
        (sum, row) => (row.masterCatId != null && opMasterIds.has(row.masterCatId) ? sum + row.expAmount : sum),
        0,
      );
      if (breakdownUsesAnalyticsSubCategoryRows && branchId && opName) {
        const analyticsTotal = sumAnalyticsExpenseRows(analyticsExpenseBreakdownRows, branchId, { opName });
        return analyticsTotal > 0 ? analyticsTotal : localTotal;
      }
      return localTotal;
    }
    // Nothing selected → selected total is 0
    return 0;
  }, [
    analyticsExpenseBreakdownRows,
    branchId,
    breakdownUsesAnalyticsSubCategoryRows,
    expensesInAnalyticsRange,
    masterCategories,
    rangeEntriesForCategoryAnalytics,
    selectedCategory,
    selectedCategoryId,
    selectedOperation,
    selectedOperationId,
  ]);

  // When a sub category is selected, we show two % badges:
  // - main category share vs grand total
  // - sub category share vs main category
  const totalForSelectedMainCategory = useMemo(() => {
    if (!selectedOperationId) return 0;
    const opName = (selectedOperation?.name || '').trim();
    const opMasterIds = new Set(
      masterCategories
        .filter((cat) => cat.opCategoryId != null && cat.opCategoryId === selectedOperationId)
        .map((cat) => cat.id),
    );
    const localTotal = expensesInAnalyticsRange.reduce(
      (sum, row) => (row.masterCatId != null && opMasterIds.has(row.masterCatId) ? sum + row.expAmount : sum),
      0,
    );
    if (breakdownUsesAnalyticsSubCategoryRows && branchId && opName) {
      const analyticsTotal = sumAnalyticsExpenseRows(analyticsExpenseBreakdownRows, branchId, { opName });
      return analyticsTotal > 0 ? analyticsTotal : localTotal;
    }
    return localTotal;
  }, [
    analyticsExpenseBreakdownRows,
    branchId,
    breakdownUsesAnalyticsSubCategoryRows,
    expensesInAnalyticsRange,
    masterCategories,
    selectedOperation,
    selectedOperationId,
  ]);

  /** Inventory toggle ON for selected main category → stock sync. Qty/Unit always shown (standard process). */
  const isInventoryCategory =
    selectedOperationId != null && operationTracksInventory(selectedOperationId, operations);

  const dreamMartDiscountEnabled = useMemo(
    () => dreamMartDiscountApplies(branchId, selectedCategory?.name),
    [branchId, selectedCategory?.name],
  );

  const columns: ColumnDef<ExpenseRecord>[] = useMemo(
    () => [
      {
        header: 'Date',
        render: (row) => (
          <span>{row.encodedDt ? expenseEncodedYmd(row.encodedDt) ?? '' : ''}</span>
        ),
      },
      {
        header: 'Item',
        render: (row) => <span>{row.expDesc || row.expName}</span>,
      },
      {
        header: 'Qty',
        render: (row: ExpenseRecord) => {
          const qty = expenseLineQty(row);
          const unit = resolveEstablishedUnitForItem(row, itemsForCategory);
          const qtyText = unit ? formatQty(qty, unit) : (qty > 0 ? String(qty) : formatQty(qty, 'pcs'));
          return (
            <div className="flex items-center justify-end gap-1">
              <span className="text-right px-2 py-1 rounded">{qtyText}</span>
              {unit ? <span className="text-xs text-brand-muted">{getUnitLabel(unit)}</span> : null}
            </div>
          );
        },
        className: 'text-right',
        headerClassName: 'text-right',
        cellClassName: 'text-right',
      },
      {
        header: 'Amount',
        render: (row) => {
          const stored = expenseLineAmountStored(row);
          const display = dreamMartDiscountEnabled ? dreamMartGrossFromNet(stored) : stored;
          return <span>{formatExpenseTableAmount(display)}</span>;
        },
        className: 'text-right',
        headerClassName: 'text-right',
        cellClassName: 'text-right',
      },
      ...(dreamMartDiscountEnabled
        ? [
            {
              header: '15% Off',
              render: (row: ExpenseRecord) => {
                const net = expenseLineAmountStored(row);
                return <span className="font-semibold text-emerald-700">{formatExpenseTableAmount(net)}</span>;
              },
              className: 'text-right',
              headerClassName: 'text-right',
              cellClassName: 'text-right',
            } satisfies ColumnDef<ExpenseRecord>,
          ]
        : []),
      {
        header: 'Action',
        className: 'text-right',
        headerClassName: 'text-right',
        cellClassName: 'text-right',
        render: (row) => {
          const isAdding = addingAmountForId === row.id;
          const isTemplateRow = String(row.id || '').startsWith('template-');
          const needsUnitPick = !expenseItemHasEstablishedUnit(row, itemsForCategory);
          const inlineUnit = needsUnitPick
            ? addingUnitValue
            : resolveEstablishedUnitForItem(row, itemsForCategory);
          return (
            <div className="flex items-center justify-end gap-3">
              {isAdding ? (
                <>
                  <input
                    type="number"
                    min={0}
                    step={getQtyInputStep(inlineUnit || 'pcs')}
                    value={addingQtyValue}
                    onChange={(e) => setAddingQtyValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveSameItemAmount(row);
                      if (e.key === 'Escape') handleCancelAddSameItemAmount();
                    }}
                    className="w-20 px-2 py-1 text-sm rounded-lg border border-gray-200 focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary outline-none"
                    placeholder="Qty"
                    autoFocus
                  />
                  {needsUnitPick ? (
                    <Select2
                      options={UOM_OPTIONS.map((u) => ({
                        value: u,
                        label: getUnitLabel(u),
                      }))}
                      value={addingUnitValue || null}
                      onChange={(val) => setAddingUnitValue((val as string) || '')}
                      placeholder="Select unit"
                      variant="compact"
                      clearable={false}
                      className="w-[8.5rem] min-w-[8.5rem] shrink-0 mt-0"
                    />
                  ) : null}
                  <div className="flex flex-col items-end gap-0.5">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={addingAmountValue}
                      onChange={(e) => setAddingAmountValue(formatExpenseAmountInput(e.target.value))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveSameItemAmount(row);
                        if (e.key === 'Escape') handleCancelAddSameItemAmount();
                      }}
                      className="min-w-[7rem] w-32 max-w-[10rem] px-2 py-1 text-sm rounded-lg border border-gray-200 focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary outline-none"
                      placeholder={dreamMartDiscountEnabled ? 'Before 15% off' : 'Amount'}
                    />
                    {dreamMartDiscountEnabled && addingAmountValue.trim() !== '' && Number.isFinite(parseExpenseAmount(addingAmountValue)) ? (
                      <span className="text-[10px] text-emerald-700 whitespace-nowrap">
                        15% off: {formatExpenseTableAmount(computeDreamMartNetAmount(parseExpenseAmount(addingAmountValue)))}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSaveSameItemAmount(row)}
                    disabled={
                      isSubmitting ||
                      addingAmountValue.trim() === '' ||
                      !Number.isFinite(parseExpenseAmount(addingAmountValue)) ||
                      parseExpenseAmount(addingAmountValue) < 0 ||
                      (addingQtyValue.trim() !== '' &&
                        (!Number.isFinite(Number(addingQtyValue)) || Number(addingQtyValue) < 0)) ||
                      (needsUnitPick &&
                        (!addingUnitValue.trim() ||
                          addingQtyValue.trim() === '' ||
                          !Number.isFinite(Number(addingQtyValue)) ||
                          Number(addingQtyValue) < 0)) ||
                      (isInventoryCategory &&
                        (addingQtyValue.trim() === '' || !Number.isFinite(Number(addingQtyValue))))
                    }
                    className="p-1.5 rounded-lg bg-brand-primary text-white hover:bg-brand-primary/90 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                    aria-label="Save"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelAddSameItemAmount}
                    disabled={isSubmitting}
                    className="p-1.5 rounded-lg text-brand-muted hover:bg-gray-100 cursor-pointer disabled:cursor-not-allowed"
                    aria-label="Cancel"
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  {canCreate('expenses') && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleStartAddSameItemAmount(row); }}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-green-600 hover:bg-green-50 transition-colors cursor-pointer"
                      aria-label="Add same item with new amount"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                  {canUpdate('expenses') && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleOpenEditExpense(row); }}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors cursor-pointer"
                      aria-label="Edit expense"
                    >
                      <Edit2 size={14} />
                    </button>
                  )}
                  {canDelete('expenses') && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isTemplateRow) {
                          toast.error('Template row cannot be deleted. Delete an existing dated entry instead.');
                          return;
                        }
                        setExpenseToDelete(row);
                      }}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                      aria-label="Delete expense"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        },
      },
    ],
    [masterCategories, addingAmountForId, addingAmountValue, addingQtyValue, addingUnitValue, dreamMartDiscountEnabled, itemsForCategory, isSubmitting, isInventoryCategory, editingQtyForId, editingQtyValue, operations, selectedOperationId, totalForView],
  );

  const handleSaveQty = async (row: ExpenseRecord) => {
    if (!isInventoryCategory) {
      toast.error('Stock updates apply only when Inventory is enabled on the main category.');
      return;
    }
    const qty = Number(editingQtyValue);
    if (!branchId || !Number.isFinite(qty) || qty < 0) {
      toast.error('Enter a valid quantity');
      return;
    }
    setIsSubmitting(true);
    try {
      await updateInventoryStock(row.id, qty, branchId);
      const list = await loadExpenseList(branchId);
      const filtered = list.filter((e) => String(e.branchId) === branchId);
      setExpenses(filtered);
      setEditingQtyForId(null);
      setEditingQtyValue('');
      toast.success('Inventory quantity updated');
    } catch (error) {
      console.error('Failed to update inventory qty:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update quantity');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelEditQty = () => {
    setEditingQtyForId(null);
    setEditingQtyValue('');
  };

  const handleSelectOperation = (opId: string) => {
    setGlobalSearch('');
    setGlobalSearchOpen(false);
    setSelectedOperationId(opId);
    setSelectedCategoryId(null);
    scrollTableItemsToTop();
    scrollPageToTop();
  };

  const handleSelectCategory = (catId: string) => {
    setGlobalSearch('');
    setGlobalSearchOpen(false);
    setSelectedCategoryId(catId);
    scrollTableItemsToTop();
    scrollPageToTop();
  };

  const handleOpenAddOperation = () => {
    setEditingOperation(null);
    setOperationForm({ name: '', description: '', state: 0 });
    setIsOperationPanelOpen(true);
  };

  const handleOpenEditOperation = (e: React.MouseEvent, op: Operation) => {
    e.stopPropagation();
    setEditingOperation(op);
    setOperationForm({ name: op.name, description: op.description ?? '', state: op.state === 1 ? 1 : 0 });
    setIsOperationPanelOpen(true);
  };

  const handleOpenAddCategory = () => {
    setEditingCategory(null);
    setCategoryForm({ name: '', description: '', isManualStock: false });
    setIsCategoryPanelOpen(true);
  };

  const handleOpenEditCategory = (e: React.MouseEvent, cat: Category) => {
    e.stopPropagation();
    if (!cat.masterCategoryId) return;
    const mc = masterCategories.find((m) => m.id === cat.masterCategoryId);
    setEditingCategory(cat);
    setCategoryForm({
      name: mc ? (mc.categoryType || mc.name || cat.name) : cat.name,
      description: mc?.description ?? '',
      isManualStock: mc?.isManualStock ?? false,
    });
    setIsCategoryPanelOpen(true);
  };

  const handleCloseOperationPanel = () => {
    if (!isSubmitting) {
      setIsOperationPanelOpen(false);
      setEditingOperation(null);
      setOperationForm({ name: '', description: '', state: 0 });
    }
  };

  const handleCloseCategoryPanel = () => {
    if (!isSubmitting) {
      setIsCategoryPanelOpen(false);
      setEditingCategory(null);
      setCategoryForm({ name: '', description: '', isManualStock: false });
    }
  };

  const handleOpenAddExpense = () => {
    setEditingExpense(null);
    setExpenseForm({
      expDesc: '',
      expAmount: '',
      expSource: '',
      stockQty: '',
      unit: '',
      encodedDate: getManilaDateStr(new Date()),
    });
    setIsExpensePanelOpen(true);
  };

  const toExpenseFormValues = (row: ExpenseRecord) => {
    const qty = expenseLineQty(row);
    const line = expenseLineAmountStored(row);
    const grossLine = dreamMartDiscountEnabled && line > 0 ? dreamMartGrossFromNet(line) : line;
    const amountForForm = grossLine > 0 ? formatExpenseAmountInput(roundMoney2(grossLine).toFixed(2)) : '';
    return {
      expDesc: row.expDesc ?? '',
      expAmount: amountForForm,
      expSource: row.expSource ?? '',
      stockQty: String(qty),
      unit: expenseUnitTrimmed(row.unit) ? canonicalUomValue(row.unit) : '',
      encodedDate: expenseEncodedYmd(row.encodedDt) ?? getManilaDateStr(new Date()),
    };
  };

  const handleOpenEditExpense = (row: ExpenseRecord) => {
    if (String(row.id || '').startsWith('template-')) {
      // Template rows are placeholders (no real DB ID). Try to open the latest
      // real record with the same item name so users can still edit unit/amount.
      const templateName = String(row.expDesc || row.expName || '').trim();
      const latestReal = itemsForCategory.find((it) => {
        const realName = String(it.expDesc || it.expName || '').trim();
        return realName && realName === templateName && !String(it.id || '').startsWith('template-');
      });
      if (latestReal) {
        setEditingExpense(latestReal);
        setExpenseForm(toExpenseFormValues(latestReal));
        setIsExpensePanelOpen(true);
        toast.success('Opened latest existing entry for this item.');
        return;
      }
      // No historical real row found; fallback to add flow.
      handleStartAddSameItemAmount(row);
      toast.error('No existing entry found to edit. Added as new item instead.');
      return;
    }
    setEditingExpense(row);
    setExpenseForm(toExpenseFormValues(row));
    setIsExpensePanelOpen(true);
  };

  const handleCloseExpensePanel = () => {
    if (!isSubmitting) {
      setIsExpensePanelOpen(false);
      setEditingExpense(null);
      setExpenseForm({ expDesc: '', expAmount: '', expSource: '', stockQty: '', unit: '', encodedDate: getManilaDateStr(new Date()) });
    }
  };

  const handleSubmitExpense = async () => {
    if (!branchId || !selectedCategory?.masterCategoryId) return;
    const amountForSave = parseExpenseAmount(expenseForm.expAmount);
    if (!Number.isFinite(amountForSave) || amountForSave < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (!expenseForm.unit.trim()) {
      toast.error('Select a unit of measurement');
      return;
    }
    const qtyRaw = expenseForm.stockQty.trim();
    const hasQty = qtyRaw !== '';
    const qty = hasQty ? Number(qtyRaw) : NaN;
    const lineAmountForSave = resolveLineAmountForSave(amountForSave, dreamMartDiscountEnabled);
    const selectedDateStr = expenseForm.encodedDate?.trim() ? expenseForm.encodedDate.trim() : getManilaDateStr(new Date());
    const encodedDt = toManilaDateTimeStr(selectedDateStr);
    setIsSubmitting(true);
    try {
      if (editingExpense) {
        const unitSaved = canonicalUomValue(expenseForm.unit);
        await updateExpense(editingExpense.id, {
          masterCatId: editingExpense.masterCatId ?? selectedCategory.masterCategoryId,
          expDesc: expenseForm.expDesc.trim() || null,
          expAmount: lineAmountForSave,
          expQty: hasQty && Number.isFinite(qty) && qty >= 0 ? qty : null,
          expSource: expenseForm.expSource.trim() || null,
          unit: unitSaved,
          encodedDt,
        });
        if (isInventoryCategory && hasQty && Number.isFinite(qty) && qty >= 0) {
          try {
            const oldQty = editingExpense.expQty ?? editingExpense.stockQty ?? 0;
            const delta = qty - Number(oldQty);
            const prevUnit = canonicalUomValue(editingExpense.unit);
            if (delta !== 0) {
              await updateInventoryStock(editingExpense.id, delta, branchId, true, unitSaved);
            } else if (unitSaved !== prevUnit) {
              await updateInventoryStock(editingExpense.id, 0, branchId, true, unitSaved);
            }
          } catch (error) {
            console.error('Failed to update inventory qty after expense update:', error);
            toast.error('Expense saved, but failed to update inventory stock.');
          }
        }
        const list = await loadExpenseList(branchId);
        const filtered = list.filter((e) => String(e.branchId) === branchId);
        setExpenses(filtered);
        refreshExpenseAnalyticsFromServer();
        setIsExpensePanelOpen(false);
        setEditingExpense(null);
        setExpenseForm({
          expDesc: '',
          expAmount: '',
          expSource: '',
          stockQty: '',
          unit: '',
          encodedDate: getManilaDateStr(new Date()),
        });
        toast.success('Expense updated');
      } else {
        const newId = await createExpense({
          branchId,
          masterCatId: selectedCategory.masterCategoryId,
          expDesc: expenseForm.expDesc.trim() || null,
          expAmount: lineAmountForSave,
          expQty: hasQty && Number.isFinite(qty) && qty >= 0 ? qty : null,
          expSource: expenseForm.expSource.trim() || null,
          unit: canonicalUomValue(expenseForm.unit),
          encodedDt,
        });
        const list = await loadExpenseList(branchId);
        const filtered = list.filter((e) => String(e.branchId) === branchId);
        setExpenses(filtered);
        if (isInventoryCategory && hasQty && Number.isFinite(qty) && qty >= 0 && newId) {
          try {
            await updateInventoryStock(String(newId), qty, branchId, true, canonicalUomValue(expenseForm.unit));
            const refreshed = await loadExpenseList(branchId);
            setExpenses(refreshed.filter((e) => String(e.branchId) === branchId));
          } catch (error) {
            console.error('Failed to update inventory qty after creating expense:', error);
            toast.error('Expense saved, but failed to update inventory stock.');
          }
        }
        refreshExpenseAnalyticsFromServer();
        setIsExpensePanelOpen(false);
        setEditingExpense(null);
        setExpenseForm({
          expDesc: '',
          expAmount: '',
          expSource: '',
          stockQty: '',
          unit: '',
          encodedDate: getManilaDateStr(new Date()),
        });
        toast.success('Expense added');
      }
    } catch (error) {
      console.error('Failed to save expense:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDeleteExpense = async () => {
    if (!expenseToDelete) return;
    setIsSubmitting(true);
    try {
      await deleteExpense(expenseToDelete.id);
      const list = await loadExpenseList(branchId || undefined);
      const filtered = branchId ? list.filter((e) => String(e.branchId) === branchId) : list;
      setExpenses(filtered);
      refreshExpenseAnalyticsFromServer();
      setExpenseToDelete(null);
      toast.success('Expense deleted');
    } catch (error) {
      console.error('Failed to delete expense:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStartAddSameItemAmount = (row: ExpenseRecord) => {
    setAddingAmountForId(row.id);
    setAddingAmountValue('');
    setAddingQtyValue('');
    setAddingUnitValue('');
  };

  const handleCancelAddSameItemAmount = () => {
    setAddingAmountForId(null);
    setAddingAmountValue('');
    setAddingQtyValue('');
    setAddingUnitValue('');
  };

  const handleSaveSameItemAmount = async (row: ExpenseRecord) => {
    const amount = parseExpenseAmount(addingAmountValue);
    const qtyRaw = addingQtyValue.trim();
    const hasQty = qtyRaw !== '';
    const qty = hasQty ? Number(qtyRaw) : NaN;
    const isTemplateRow = String(row.id || '').startsWith('template-');
    const isQtyOnlyRestock =
      isInventoryCategory &&
      !isTemplateRow &&
      hasQty &&
      Number.isFinite(qty) &&
      qty >= 0 &&
      (addingAmountValue.trim() === '' || amount === 0);

    if (isQtyOnlyRestock) {
      // Add qty to existing row only — no new expense, no duplicate
      if (!branchId || !row.id) {
        toast.error('Cannot add quantity');
        return;
      }
      setIsSubmitting(true);
      try {
        await updateInventoryStock(String(row.id), qty, branchId, true);
        const list = await loadExpenseList(branchId);
        setExpenses(list.filter((e) => String(e.branchId) === branchId));
        setAddingAmountForId(null);
        setAddingAmountValue('');
        setAddingQtyValue('');
        setAddingUnitValue('');
        toast.success(`${qty} qty added to stock`);
      } catch (error) {
        console.error('Failed to add qty:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to add quantity');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!branchId || !selectedCategory?.masterCategoryId || !Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (isInventoryCategory) {
      if (!hasQty) {
        toast.error('Enter quantity for inventory restock');
        return;
      }
      if (!Number.isFinite(qty) || qty < 0) {
        toast.error('Enter a valid quantity');
        return;
      }
    }
    const needsUnitPick = !expenseItemHasEstablishedUnit(row, itemsForCategory);
    if (needsUnitPick) {
      if (!hasQty || !Number.isFinite(qty) || qty < 0) {
        toast.error('Enter quantity for first entry');
        return;
      }
    }
    const unitForSave = needsUnitPick
      ? canonicalUomValue(addingUnitValue)
      : canonicalUomValue(resolveEstablishedUnitForItem(row, itemsForCategory));
    if (!expenseUnitTrimmed(unitForSave)) {
      toast.error('Select a unit of measurement');
      return;
    }
    setIsSubmitting(true);
    try {
      const encodedDt = toManilaDateTimeStr(getManilaDateStr(new Date()));
      const lineAmountNew = resolveLineAmountForSave(amount, dreamMartDiscountEnabled);
      const newId = await createExpense({
        branchId,
        masterCatId: row.masterCatId ?? selectedCategory.masterCategoryId,
        expDesc: row.expDesc ?? row.expName ?? null,
        expAmount: lineAmountNew,
        expQty: hasQty && Number.isFinite(qty) && qty >= 0 ? qty : null,
        expSource: row.expSource ?? null,
        unit: unitForSave,
        encodedDt,
      });
      if (isInventoryCategory && hasQty && Number.isFinite(qty) && qty >= 0 && newId) {
        try {
          await updateInventoryStock(String(newId), qty, branchId, true, unitForSave);
        } catch (error) {
          console.error('Failed to update inventory qty after adding amount:', error);
          toast.error('Amount saved, but failed to update inventory stock.');
        }
      }
      const list = await loadExpenseList(branchId);
      const filtered = list.filter((e) => String(e.branchId) === branchId);
      setExpenses(filtered);
      refreshExpenseAnalyticsFromServer();
      setAddingAmountForId(null);
      setAddingAmountValue('');
      setAddingQtyValue('');
      setAddingUnitValue('');
      toast.success('Amount added');
    } catch (error) {
      console.error('Failed to add amount:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to add');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitOperation = async () => {
    if (!operationForm.name.trim()) return;
    setIsSubmitting(true);
    try {
      if (editingOperation) {
        await updateOperationCategory(editingOperation.id, {
          name: operationForm.name.trim(),
          description: operationForm.description.trim() || null,
          state: operationForm.state,
        });
        setOperations((prev) =>
          prev.map((op) =>
            op.id === editingOperation.id
              ? { ...op, name: operationForm.name.trim(), description: operationForm.description.trim() || null, state: operationForm.state }
              : op,
          ),
        );
        handleCloseOperationPanel();
        toast.success('Operation updated');
      } else {
        const newId = await createOperationCategory({
          branchId,
          name: operationForm.name.trim(),
          description: operationForm.description.trim() || null,
          state: operationForm.state,
          active: true,
        });
        setOperations((prev) => [
          ...prev,
          {
            id: String(newId),
            name: operationForm.name.trim(),
            description: operationForm.description.trim() || null,
            state: operationForm.state,
            active: true,
          },
        ]);
        handleCloseOperationPanel();
        toast.success('Operation created');
      }
    } catch (error) {
      console.error('Failed to save operation category:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitCategory = async () => {
    if (!categoryForm.name.trim() || !branchId) return;

    setIsSubmitting(true);
    try {
      if (editingCategory?.masterCategoryId) {
        await updateInventoryCategory(editingCategory.masterCategoryId, {
          name: categoryForm.name.trim(),
          categoryType: categoryForm.name.trim(),
          description: categoryForm.description.trim() || null,
          icon: null,
          opCategoryId: selectedOperationId ?? undefined,
          isManualStock: categoryForm.isManualStock,
        });
        // Refresh data so categories list updates
        const [apiCats] = await Promise.all([getAllMasterCategories(branchId)]);
        const filtered = apiCats.filter((c) => String(c.branchId) === branchId);
        setMasterCategories(filtered);
        handleCloseCategoryPanel();
        toast.success('Category updated');
      } else {
        const payload: CreateInventoryCategoryPayload = {
          branchId,
          name: categoryForm.name.trim(),
          categoryType: categoryForm.name.trim(),
          description: categoryForm.description.trim() || null,
          icon: null,
          opCategoryId: selectedOperationId ?? undefined,
          isManualStock: categoryForm.isManualStock,
        };
        await createInventoryCategory(payload);
        const [apiCats] = await Promise.all([getAllMasterCategories(branchId)]);
        const filtered = apiCats.filter((c) => String(c.branchId) === branchId);
        setMasterCategories(filtered);
        handleCloseCategoryPanel();
        toast.success('Category created');
      }
    } catch (error) {
      console.error('Failed to save category:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDeleteOperation = async () => {
    if (!operationToDelete) return;
    setIsSubmitting(true);
    try {
      await deleteOperationCategory(operationToDelete.id);
      setOperations((prev) => prev.filter((op) => op.id !== operationToDelete.id));
      if (selectedOperationId === operationToDelete.id) {
        setSelectedOperationId(null);
        setSelectedCategoryId(null);
      }
      setOperationToDelete(null);
      toast.success('Operation deleted');
    } catch (error) {
      console.error('Failed to delete operation:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete');
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDeleteCategory = async () => {
    if (!categoryToDelete?.masterCategoryId) return;
    setIsSubmitting(true);
    try {
      await deleteInventoryCategory(categoryToDelete.masterCategoryId);
      const [apiCats] = await Promise.all([getAllMasterCategories(branchId || undefined)]);
      const filtered = branchId ? apiCats.filter((c) => String(c.branchId) === branchId) : apiCats;
      setMasterCategories(filtered);
      if (selectedCategoryId === categoryToDelete.id) setSelectedCategoryId(null);
      setCategoryToDelete(null);
      toast.success('Category deleted');
    } catch (error) {
      console.error('Failed to delete category:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete');
    } finally {
      setIsSubmitting(false);
    }
  };

  const [tableSearch, setTableSearch] = useState('');

  const globalSearchHits = useMemo(() => {
    const term = globalSearch.trim().toLowerCase();
    if (!term) return [] as GlobalSearchHit[];

    const masterById = new Map(masterCategories.map((c) => [String(c.id), c]));
    const opById = new Map(operations.map((o) => [String(o.id), o]));
    const seen = new Set<string>();
    const hits: GlobalSearchHit[] = [];

    for (const exp of expenses) {
      const itemName = expenseItemDisplayName(exp);
      if (!itemName || !itemName.toLowerCase().includes(term)) continue;
      if (exp.masterCatId == null) continue;

      const mc = masterById.get(String(exp.masterCatId));
      if (!mc?.opCategoryId) continue;

      const operationId = String(mc.opCategoryId);
      const op = opById.get(operationId);
      if (!op) continue;

      const subCategoryId = (mc.categoryType || mc.name || '').trim();
      if (!subCategoryId) continue;

      const key = `${itemName.toLowerCase()}|${operationId}|${subCategoryId.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        itemName,
        operationId,
        operationName: op.name,
        subCategoryId,
        subCategoryName: subCategoryId,
      });
    }

    hits.sort((a, b) => {
      const aL = a.itemName.toLowerCase();
      const bL = b.itemName.toLowerCase();
      const rank = (name: string) => (name === term ? 0 : name.startsWith(term) ? 1 : 2);
      const ra = rank(aL);
      const rb = rank(bL);
      if (ra !== rb) return ra - rb;
      return a.itemName.localeCompare(b.itemName, undefined, { sensitivity: 'base' });
    });

    return hits.slice(0, 25);
  }, [expenses, globalSearch, masterCategories, operations]);

  const selectedOperationIdRef = useRef(selectedOperationId);
  const selectedCategoryIdRef = useRef(selectedCategoryId);
  const globalSearchRef = useRef(globalSearch);
  selectedOperationIdRef.current = selectedOperationId;
  selectedCategoryIdRef.current = selectedCategoryId;
  globalSearchRef.current = globalSearch;

  const navigateToSearchHit = useCallback(
    (hit: GlobalSearchHit, filterTerm?: string, options?: { closeDropdown?: boolean }) => {
      const term = (filterTerm ?? hit.itemName).trim();
      const sameCategory =
        selectedOperationIdRef.current === hit.operationId &&
        selectedCategoryIdRef.current === hit.subCategoryId;

      setTableSearch(term);
      setTableItemsNameFilter(null);

      if (!sameCategory) {
        setSelectedOperationId(hit.operationId);
        setSelectedCategoryId(hit.subCategoryId);
      }

      if (options?.closeDropdown !== false) {
        setGlobalSearchOpen(false);
      }
      scrollTableItemsToTop();
      scrollPageToTop();
    },
    [scrollPageToTop, scrollTableItemsToTop],
  );

  // Auto-select main + sub category of the best match while typing.
  useEffect(() => {
    const term = globalSearch.trim();
    if (!term || globalSearchHits.length === 0) return;

    const hit = globalSearchHits[0];
    const timer = window.setTimeout(() => {
      if (skipGlobalSearchAutoNavRef.current) {
        skipGlobalSearchAutoNavRef.current = false;
        return;
      }
      navigateToSearchHit(hit, term, { closeDropdown: false });
    }, 280);

    return () => window.clearTimeout(timer);
  }, [globalSearch, globalSearchHits, navigateToSearchHit]);

  // Close suggestions when clicking outside.
  useEffect(() => {
    if (!globalSearchOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const el = globalSearchWrapRef.current;
      if (el && !el.contains(e.target as Node)) setGlobalSearchOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [globalSearchOpen]);

  const filteredItemsForCategory = useMemo(() => {
    const term = tableSearch.trim().toLowerCase();
    const base = tableRowsForCategory;
    const byNameSet =
      tableItemsNameFilter && tableItemsNameFilter.size > 0
        ? base.filter((row) => tableItemsNameFilter.has(String(row.expDesc || row.expName || '').trim()))
        : base;

    if (!term) return byNameSet;
    return byNameSet.filter((row) => {
      const name = (row.expDesc || row.expName || '').toLowerCase();
      return name.includes(term);
    });
  }, [tableItemsNameFilter, tableRowsForCategory, tableSearch]);

  const shouldPaginate = filteredItemsForCategory.length > ITEMS_PER_PAGE;
  const [currentPage, setCurrentPage] = useState(1);

  const pagedItems = useMemo(() => {
    if (!shouldPaginate) return filteredItemsForCategory;
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return filteredItemsForCategory.slice(startIndex, endIndex);
  }, [currentPage, filteredItemsForCategory, shouldPaginate]);

  const totalPages = useMemo(() => {
    if (!shouldPaginate) return 1;
    return Math.max(1, Math.ceil(filteredItemsForCategory.length / ITEMS_PER_PAGE));
  }, [filteredItemsForCategory.length, shouldPaginate]);

  React.useEffect(() => {
    setCurrentPage(1);
    setTableItemsNameFilter(null);
    // Keep table filter when global search is driving the selection.
    if (!globalSearchRef.current.trim()) {
      setTableSearch('');
    }
  }, [selectedCategoryId, selectedOperationId]);

  if (!isSpecificBranch) {
    return (
      <div className="pt-6">
        <div className="bg-white rounded-2xl shadow-sm p-6 text-brand-muted font-bold">
          Please select a specific branch (not “All Branches”) to manage expenses.
        </div>
      </div>
    );
  }

  const expensesSkeleton = (
    <div className="pt-6 overflow-x-hidden space-y-6 animate-in fade-in duration-300">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonCard className="rounded-2xl" />
        <SkeletonCard className="rounded-2xl" />
      </div>
      <div className="flex gap-6 items-stretch min-h-[560px]">
        <section className="w-[280px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-gray-100">
            <Skeleton className="h-4 w-28 mb-2" />
            <Skeleton className="h-3 w-40" />
          </div>
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        </section>
        <section className="w-[360px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-gray-100">
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-11 w-full rounded-xl" />
            ))}
          </div>
        </section>
        <section className="flex-1 min-w-0">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden h-full flex flex-col">
            <div className="px-6 py-5 border-b border-gray-100">
              <Skeleton className="h-4 w-32 mb-2" />
              <Skeleton className="h-3 w-56" />
            </div>
            <div className="p-6">
              <SkeletonTable columns={4} rows={8} showToolbar={false} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );

  return (
    <SkeletonTransition
      loading={loading}
      skeleton={expensesSkeleton}
      className="block"
    >
      <>
    <div className="pt-6 overflow-x-hidden">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <div ref={globalSearchWrapRef} className="relative w-full sm:w-80">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-brand-muted"
          />
          <input
            type="text"
            value={globalSearch}
            onChange={(e) => {
              const v = e.target.value;
              setGlobalSearch(v);
              setGlobalSearchOpen(true);
              if (!v.trim()) {
                setTableSearch('');
                setGlobalSearchOpen(false);
              }
            }}
            onFocus={() => {
              if (globalSearch.trim()) setGlobalSearchOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setGlobalSearchOpen(false);
                return;
              }
              if (e.key === 'Enter' && globalSearchHits.length > 0) {
                e.preventDefault();
                skipGlobalSearchAutoNavRef.current = true;
                const hit = globalSearchHits[0];
                setGlobalSearch(hit.itemName);
                navigateToSearchHit(hit, hit.itemName);
              }
            }}
            placeholder="Search expense items..."
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-9 text-sm font-medium text-brand-text outline-none transition-shadow placeholder:text-brand-muted focus:border-brand-primary/40 focus:ring-2 focus:ring-brand-primary/15"
            aria-label="Global search expense items"
            autoComplete="off"
            role="combobox"
            aria-expanded={globalSearchOpen && Boolean(globalSearch.trim())}
            aria-autocomplete="list"
          />
          {globalSearch ? (
            <button
              type="button"
              onClick={() => {
                setGlobalSearch('');
                setTableSearch('');
                setGlobalSearchOpen(false);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-brand-muted hover:bg-gray-100 hover:text-brand-text"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : null}
          {globalSearchOpen && globalSearch.trim() && (
            <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-72 overflow-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
              {globalSearchHits.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-brand-muted">No matching items.</div>
              ) : (
                globalSearchHits.map((hit) => (
                  <button
                    key={`${hit.operationId}-${hit.subCategoryId}-${hit.itemName}`}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      skipGlobalSearchAutoNavRef.current = true;
                      setGlobalSearch(hit.itemName);
                      navigateToSearchHit(hit, hit.itemName);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-brand-bg"
                  >
                    <span className="truncate text-sm font-semibold text-brand-text">{hit.itemName}</span>
                    <span className="truncate text-[11px] text-brand-muted">
                      {hit.operationName} → {hit.subCategoryName}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={openReceiptModal}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-base font-bold text-white shadow-lg shadow-violet-600/20 transition-all hover:bg-violet-700 sm:w-auto"
        >
          <ScanLine size={18} />
          Upload Receipt
        </button>
        <button
          type="button"
          onClick={openReceiptHistory}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-700 px-6 py-2.5 text-base font-bold text-white shadow-lg shadow-slate-700/20 transition-all hover:bg-slate-800 sm:w-auto"
        >
          <History size={18} />
          History
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-6 items-stretch">
        <div className="md:col-span-4 flex flex-col gap-4 h-full">
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6 py-5 flex-1">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[12px] font-black tracking-wide text-brand-muted uppercase">Grand Total Expenses</div>
                {isSpecificBranch && analyticsFinanceLoading ? (
                  <Skeleton className="h-9 w-40 mt-1 rounded-lg" />
                ) : (
                  <div className="text-2xl font-black tracking-tight text-brand-text mt-1">
                    {formatCurrency(grandTotalDisplayed)}
                  </div>
                )}
                <div className="text-[11px] text-brand-muted mt-1">
                  {dateRangeLabel}
                </div>
              </div>
              <div className="h-11 w-11 rounded-2xl bg-brand-primary/10 border border-brand-primary/10 flex items-center justify-center">
                <div className="h-5 w-5 rounded-full bg-brand-primary/70" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-6 py-5 flex-1">
            <div className="flex items-start gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-black tracking-wide text-brand-muted uppercase">Selected Total</div>
                <div className="text-2xl font-black tracking-tight text-brand-text mt-1">
                  {formatCurrency(totalForView)}
                </div>
                <div className="mt-1 text-[11px] text-brand-muted leading-snug">
                  <div
                    className="flex items-center gap-1 tabular-nums whitespace-nowrap"
                    title={`${formatPercent(percentOf(totalForView, grandTotalDisplayed), 1)} of Grand Total Expenses`}
                  >
                    <span>{formatPercent(percentOf(totalForView, grandTotalDisplayed), 1)} of Grand Total Expenses</span>
                  </div>
                </div>
              </div>

              {selectedOperation && (
                <div className="ml-auto min-w-0 max-w-full text-[11px] text-brand-text font-semibold space-y-1 pt-5 leading-tight text-right">
                  {selectedCategory ? (
                    <span
                      className="inline tabular-nums text-brand-muted font-black whitespace-nowrap"
                      title={`${formatPercent(percentOf(totalForView, totalForSelectedMainCategory), 1)} of ${selectedOperation.name}`}
                    >
                      {formatPercent(percentOf(totalForView, totalForSelectedMainCategory), 1)}{' '}
                      <span className="font-semibold">of</span>{' '}
                      <span className="font-semibold">{selectedOperation.name}</span>
                    </span>
                  ) : (
                    <div className="inline-flex max-w-full flex-wrap items-baseline justify-end gap-x-2 gap-y-1 text-right">
                      <span
                        className="min-w-0 text-left truncate md:truncate-none md:whitespace-normal md:break-words lg:truncate lg:whitespace-nowrap lg:max-w-[12rem] xl:max-w-[16rem]"
                        title={selectedOperation.name}
                      >
                        {selectedOperation.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-brand-muted font-black whitespace-nowrap">
                        {formatPercent(percentOf(totalForSelectedMainCategory, grandTotalDisplayed), 1)}{' '}
                        <span className="font-semibold">of Grand Total Expenses</span>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div
          id="expense-breakdown"
          ref={expenseBreakdownRef}
          className="md:col-span-8 bg-white rounded-2xl shadow-sm border border-gray-100 px-6 py-5 h-full flex flex-col"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[12px] font-black tracking-wide text-brand-muted uppercase">Expense Breakdown</div>
              <div className="text-xs text-brand-muted mt-1">
                {selectedCategory
                  ? `By table items • ${selectedCategory.name}`
                  : selectedOperation
                    ? `By sub category • ${selectedOperation.name}`
                    : 'By main category'}
              </div>
            </div>
            {(selectedOperationId || selectedCategoryId) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedOperationId(null);
                  setSelectedCategoryId(null);
                  setTableItemsNameFilter(null);
                  setTableSearch('');
                  setCurrentPage(1);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/5 transition-colors cursor-pointer"
              >
                Back
              </button>
            )}
          </div>

          <div className="mt-3 flex-1 w-full min-w-0 min-h-[210px] flex flex-col">
            {expenseBreakdown.rows.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-brand-muted">
                No data to display
              </div>
            ) : (
              <div className="w-full">
                  {(() => {
                    const maxVal = Math.max(...expenseBreakdown.rows.map((r) => Number(r.value) || 0), 1);
                    return (
                      <ul className="space-y-2.5 pr-2">
                        {expenseBreakdown.rows.map((row, idx) => {
                          const value = Number(row.value) || 0;
                          // Use a compressed scale so extreme outliers don't make all other bars look tiny.
                          // sqrt keeps ordering but reduces the visual gap vs linear scaling.
                          const pctLinear = value / maxVal;
                          const pctScaled = Math.sqrt(Math.max(0, pctLinear));
                          const pct = Math.max(0, Math.min(100, pctScaled * 100));
                          // Reduce overall bar length for nicer composition.
                          const pctDisplay = pct * 0.5;
                          // Use a highly distinct palette so each legend color feels unique.
                          // (We keep PIE_COLORS for other screens, but breakdown rows use HSL.)
                          const color = distinctSeriesColor(idx);
                          const isOthers = row.name === 'Others';
                          const canClickMainCategory =
                            !selectedOperation &&
                            !selectedCategory &&
                            !isOthers &&
                            operations.some((op) => op.name === row.name);
                          const canClickSubCategory =
                            Boolean(selectedOperation) && !selectedCategory && !isOthers;
                          // "Others" only ever appears when a sub category is selected, and it
                          // always has at least one grouped item — open the same detail modal.
                          const canClickTableItem = Boolean(selectedCategory);
                          const canOpenDetailModal = canClickSubCategory || canClickTableItem;
                          const isRowClickable = canClickMainCategory || canOpenDetailModal;
                          const handleBreakdownRowClick = () => {
                            if (canOpenDetailModal) {
                              openBreakdownRowDetail(row.name);
                              return;
                            }
                            if (canClickMainCategory) {
                              const op = operations.find((item) => item.name === row.name);
                              if (!op) return;
                              setSelectedOperationId(op.id);
                              setSelectedCategoryId(null);
                              setCurrentPage(1);
                              setTableSearch('');
                              setTableItemsNameFilter(null);
                            }
                          };
                          return (
                            <li
                              key={`${row.name}-${idx}`}
                              className={cn(
                                'grid items-center gap-3 rounded-xl transition-colors',
                                isRowClickable && 'hover:bg-slate-50/80',
                              )}
                              // Responsive 3-col layout:
                              // - label grows but can't collapse too small
                              // - bar track flexes with screen
                              // - amount stays readable and doesn't get pushed off-screen
                              style={{ gridTemplateColumns: 'minmax(200px, 1.2fr) minmax(220px, 2.2fr) minmax(140px, 0.9fr)' }}
                            >
                              <button
                                type="button"
                                onClick={handleBreakdownRowClick}
                                disabled={!isRowClickable}
                                className={cn(
                                  'flex items-center gap-2 min-w-0 text-left',
                                  isRowClickable ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
                                )}
                                aria-label={
                                  canOpenDetailModal
                                    ? `View expense items for ${row.name}`
                                    : canClickMainCategory
                                      ? 'Open sub category breakdown for selected main category'
                                      : undefined
                                }
                              >
                                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                                <span className="text-xs font-semibold text-slate-700 truncate">{row.name}</span>
                              </button>

                              <button
                                type="button"
                                onClick={handleBreakdownRowClick}
                                disabled={!isRowClickable}
                                className={cn('w-full min-w-0', isRowClickable ? 'cursor-pointer' : 'cursor-default')}
                                aria-label={
                                  canOpenDetailModal
                                    ? `View expense items for ${row.name}`
                                    : canClickMainCategory
                                      ? 'Open sub category breakdown for selected main category'
                                      : undefined
                                }
                              >
                                <div className={cn('h-2.5 rounded-full bg-slate-100 overflow-hidden', isRowClickable ? 'hover:bg-slate-200/60 transition-colors' : '')}>
                                  <motion.div
                                    className="h-full rounded-full"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${pctDisplay}%` }}
                                    transition={{ duration: 0.5, ease: 'easeOut' }}
                                    style={{ backgroundColor: color }}
                                  />
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={handleBreakdownRowClick}
                                disabled={!isRowClickable}
                                className={cn(
                                  'text-right text-xs font-bold tabular-nums whitespace-nowrap min-w-0',
                                  isRowClickable ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
                                )}
                                aria-label={
                                  canOpenDetailModal ? `View expense items for ${row.name}` : undefined
                                }
                              >
                                <span className="text-slate-900">{formatCurrency(value)}</span>
                                <span className="ml-2 text-[11px] font-extrabold" style={{ color }}>
                                  ({formatPercent(
                                    percentOf(
                                      value,
                                      selectedCategory || selectedOperation ? totalForView : grandTotalDisplayed,
                                    ),
                                    1,
                                  )})
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
              </div>
            )}

          </div>
        </div>
      </div>

      <div className="flex gap-6 items-stretch min-h-[560px]">
        <section className="w-[280px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black tracking-wide text-brand-text uppercase">Main Category</div>
            
            </div>
            {canCreate('expenses') && (
              <button
                type="button"
                onClick={handleOpenAddOperation}
                className="h-8 w-8 rounded-full border border-gray-200 flex items-center justify-center text-brand-primary text-lg leading-none hover:bg-brand-primary/5 transition-colors cursor-pointer"
                aria-label="Add main category"
              >
                +
              </button>
            )}
          </div>
        </div>

        <div className="p-2 flex-1 min-h-0 overflow-auto custom-scrollbar">
          {operations.map((op) => {
            const active = op.id === selectedOperationId;
            const categoryCount = masterCategories.filter(
              (cat) => cat.opCategoryId != null && cat.opCategoryId === op.id,
            ).length;
            return (
              <div
                key={op.id}
                className={cn(
                  'group flex items-center rounded-xl transition-colors relative',
                  active ? 'bg-brand-primary/10' : 'hover:bg-brand-bg',
                )}
              >
                <button
                  type="button"
                  onClick={() => handleSelectOperation(op.id)}
                  className={cn(
                    'flex-1 text-left px-4 py-3 min-w-0 cursor-pointer',
                    active ? 'text-brand-primary' : 'text-brand-text',
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={cn('flex-1 font-bold break-words', active ? '' : 'font-semibold')}>{op.name}</span>
                    <span
                      className={cn(
                        'text-[11px] px-2 py-0.5 rounded-full shrink-0 transition-opacity group-hover:opacity-0',
                        active ? 'bg-brand-primary/15 text-brand-primary' : 'bg-gray-100 text-brand-muted',
                      )}
                    >
                      {categoryCount}
                    </span>
                  </div>
                </button>
                {canUpdate('expenses') && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
                    <button
                      type="button"
                      onClick={(e) => handleOpenEditOperation(e, op)}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors cursor-pointer"
                      aria-label="Edit main category"
                    >
                      <Edit2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="w-[360px] shrink-0 bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black tracking-wide text-brand-text uppercase">Sub Category</div>
              
            </div>
            {canCreate('expenses') && (
              <button
                type="button"
                onClick={handleOpenAddCategory}
                className="h-8 w-8 rounded-full border border-gray-200 flex items-center justify-center text-brand-primary text-lg leading-none hover:bg-brand-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                aria-label="Add sub category"
                disabled={!selectedOperationId}
              >
                +
              </button>
            )}
          </div>
        </div>

        <div className="p-2 flex-1 min-h-0 overflow-auto overflow-x-hidden custom-scrollbar relative">
          <AnimatePresence mode="wait">
            {!selectedOperationId ? (
              <motion.div
                key="category-empty"
                initial={{ opacity: 0, x: 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -24 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="px-4 py-6 text-sm text-brand-muted"
              >
                Select a Main Category first.
              </motion.div>
            ) : (
              <motion.div
                key={`category-${selectedOperationId}`}
                initial={{ opacity: 0, x: 32 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -32 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                className="space-y-1"
              >
                {categoriesForOperation.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-brand-muted">No Sub Category.</div>
                ) : (
                  categoriesForOperation.map((cat) => {
                    const active = cat.id === selectedCategoryId;
                    const relatedMasterIds = new Set(
                      masterCategories
                        .filter(
                          (m) =>
                            m.opCategoryId != null &&
                            m.opCategoryId === selectedOperationId &&
                            (m.categoryType || m.name || '').trim() === cat.name,
                        )
                        .map((m) => m.id),
                    );
                    const expenseCount = expensesInAnalyticsRange.filter(
                      (exp) => exp.masterCatId != null && relatedMasterIds.has(exp.masterCatId),
                    ).length;
                    return (
                      <div
                        key={cat.id}
                        className={cn(
                          'group flex items-center rounded-xl transition-colors relative',
                          active ? 'bg-brand-orange/10' : 'hover:bg-brand-bg',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectCategory(cat.id)}
                          className={cn(
                            'flex-1 text-left px-4 py-3 min-w-0 cursor-pointer',
                            active ? 'text-brand-utilities' : 'text-brand-text',
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className={cn('flex-1 break-words', active ? 'font-semibold' : 'font-normal')}>{cat.name}</span>
                            <span
                              className={cn(
                                'text-[11px] px-2 py-0.5 rounded-full shrink-0 transition-opacity group-hover:opacity-0',
                                active ? 'bg-brand-orange/15 text-brand-utilities' : 'bg-gray-100 text-brand-muted',
                              )}
                            >
                              {expenseCount}
                            </span>
                          </div>
                        </button>
                        {cat.masterCategoryId && (canUpdate('expenses') || canDelete('expenses')) && (
                          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
                            {canUpdate('expenses') && (
                              <button
                                type="button"
                                onClick={(e) => handleOpenEditCategory(e, cat)}
                                className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors cursor-pointer"
                                aria-label="Edit sub category"
                              >
                                <Edit2 size={14} />
                              </button>
                            )}
                            {canDelete('expenses') && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCategoryToDelete(cat);
                                }}
                                className="p-1.5 rounded-lg text-brand-muted hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
                                aria-label="Delete sub category"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <section className="flex-1 min-w-0">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden h-full flex flex-col">
          <div className="px-6 py-5 border-b border-gray-100">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-sm font-black tracking-wide text-brand-text uppercase">Item List</div>
              </div>
              {selectedCategoryId && (
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"
                    />
                    <input
                      type="text"
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder="Search item..."
                      className="bg-brand-bg border-none rounded-lg pl-8 pr-3 py-1.5 text-xs w-44 outline-none"
                    />
                  </div>
                  {canCreate('expenses') && (
                    <button
                      type="button"
                      onClick={handleOpenAddExpense}
                      className="bg-brand-primary text-white px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 transition-all cursor-pointer"
                    >
                      <Plus size={16} />
                      New Item
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            <div
              ref={tableItemsScrollRef}
              className="h-full overflow-auto overflow-x-hidden custom-scrollbar"
            >
              <AnimatePresence mode="wait">
                {!selectedCategoryId ? (
                  <motion.div
                    key="table-empty"
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -24 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="px-6 py-10 text-sm text-brand-muted"
                  >
                  Choose a Sub Category to load table items.
                  </motion.div>
                ) : (
                  <motion.div
                    key={`table-${selectedCategoryId}`}
                    initial={{ opacity: 0, x: 40 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -40 }}
                    transition={{ duration: 0.24, ease: 'easeOut' }}
                    className="p-0"
                  >
                    <div className="w-full">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="bg-white border-b border-gray-100">
                              {columns.map((col, i) => (
                                <th
                                  key={col.header}
                                  className={cn(
                                    'px-6 py-4 text-[13px] font-medium whitespace-nowrap',
                                    i === 0
                                      ? 'bg-violet-50 text-brand-text uppercase tracking-wider'
                                      : 'text-brand-muted uppercase tracking-wider',
                                    col.className,
                                    col.headerClassName,
                                    i === 0 && 'border-r-[3px] border-white',
                                  )}
                                >
                                  {col.header}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {pagedItems.map((row) => (
                              <tr key={row.id} className="group transition-colors">
                                {columns.map((col, i) => (
                                  <td
                                    key={i}
                                    className={cn(
                                      'px-4 py-2 text-[11px] text-brand-text',
                                      i === 0
                                        ? 'bg-violet-50 font-medium group-hover:bg-violet-100'
                                        : 'bg-white group-hover:bg-brand-bg/50',
                                      col.className,
                                      col.cellClassName,
                                      i === 0 && 'border-r-[3px] border-white',
                                    )}
                                  >
                                    {col.render
                                      ? col.render(row)
                                      : col.accessorKey
                                        ? (row[col.accessorKey] as React.ReactNode)
                                        : null}
                                  </td>
                                ))}
                              </tr>
                            ))}
                            {pagedItems.length === 0 && (
                              <tr>
                                <td colSpan={columns.length} className="px-6 py-8 text-center text-brand-muted">
                                  No data
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {shouldPaginate && (
                        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-white">
                          <div className="text-sm text-brand-muted">
                            Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to{' '}
                            {Math.min(currentPage * ITEMS_PER_PAGE, filteredItemsForCategory.length)} of {filteredItemsForCategory.length}{' '}
                            entries
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                              disabled={currentPage === 1}
                              className="px-3 py-2 rounded-lg text-sm font-bold text-brand-muted hover:bg-gray-100 disabled:opacity-50 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
                            >
                              Prev
                            </button>
                            <div className="px-3 py-2 rounded-lg text-sm font-black bg-brand-primary text-white">
                              {currentPage}
                            </div>
                            <button
                              type="button"
                              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                              disabled={currentPage === totalPages}
                              className="px-3 py-2 rounded-lg text-sm font-bold text-brand-muted hover:bg-gray-100 disabled:opacity-50 disabled:hover:bg-transparent transition-colors cursor-pointer disabled:cursor-not-allowed"
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </section>
      </div>

      {/* Add/Edit Operation Side Panel */}
      <SidePanel
        isOpen={isOperationPanelOpen}
        onClose={handleCloseOperationPanel}
        title={editingOperation ? 'Edit Main Category' : 'Add Main Category'}
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleCloseOperationPanel}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmitOperation}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
              disabled={isSubmitting || !operationForm.name.trim()}
            >
              {isSubmitting ? 'Saving...' : editingOperation ? 'Update' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Name</label>
            <input
              type="text"
              value={operationForm.name}
              onChange={(e) => setOperationForm((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              placeholder="Operation name"
            />
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Description</label>
            <textarea
              value={operationForm.description}
              onChange={(e) => setOperationForm((prev) => ({ ...prev, description: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all min-h-[80px]"
              placeholder="Optional description"
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
            <label htmlFor="operation-state" className="text-sm font-medium text-brand-text cursor-pointer select-none">
              Inventory
            </label>
            <label htmlFor="operation-state" className="relative inline-flex items-center cursor-pointer select-none">
              <input
                type="checkbox"
                id="operation-state"
                checked={operationForm.state === 1}
                onChange={(e) => setOperationForm((prev) => ({ ...prev, state: e.target.checked ? 1 : 0 }))}
                className="sr-only peer"
              />
              <span className="h-6 w-11 rounded-full bg-gray-200 transition-colors peer-checked:bg-brand-primary peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-brand-primary/20" />
              <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
            </label>
          </div>
        </div>
      </SidePanel>

      {/* Add/Edit Category Side Panel */}
      <SidePanel
        isOpen={isCategoryPanelOpen}
        onClose={handleCloseCategoryPanel}
        title={editingCategory ? 'Edit Sub Category' : 'Add Sub Category'}
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleCloseCategoryPanel}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmitCategory}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
              disabled={isSubmitting || !categoryForm.name.trim() || !branchId}
            >
              {isSubmitting ? 'Saving...' : editingCategory ? 'Update' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Sub category name</label>
            <input
              type="text"
              value={categoryForm.name}
              onChange={(e) => setCategoryForm((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              placeholder="Sub category name"
            />
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Description</label>
            <textarea
              value={categoryForm.description}
              onChange={(e) => setCategoryForm((prev) => ({ ...prev, description: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all min-h-[80px]"
              placeholder="Optional description"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="category-manual-stock"
              checked={categoryForm.isManualStock}
              onChange={(e) => setCategoryForm((prev) => ({ ...prev, isManualStock: e.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-brand-primary focus:ring-brand-primary/20"
            />
            <label htmlFor="category-manual-stock" className="text-sm font-medium text-brand-text cursor-pointer">
              Enable manual stock adjustment (e.g. for seasonings not in menu)
            </label>
          </div>
        </div>
      </SidePanel>

      {/* Delete Operation Confirmation */}
      <Modal
        isOpen={!!operationToDelete}
        onClose={() => !isSubmitting && setOperationToDelete(null)}
        title="Delete Operation"
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setOperationToDelete(null)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeleteOperation}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-brand-muted text-sm">
            Are you sure you want to delete the operation <span className="font-bold text-brand-text">{operationToDelete?.name}</span>?
            This will not delete its categories or expense records.
          </p>
        </div>
      </Modal>

      {/* Delete Category Confirmation */}
      <Modal
        isOpen={!!categoryToDelete}
        onClose={() => !isSubmitting && setCategoryToDelete(null)}
        title="Delete Category"
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setCategoryToDelete(null)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeleteCategory}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-brand-muted text-sm">
            Are you sure you want to delete the category <span className="font-bold text-brand-text">{categoryToDelete?.name}</span>?
            Expense entries under this category will remain but may show as uncategorized.
          </p>
        </div>
      </Modal>

      {/* Add/Edit Expense Side Panel */}
      <SidePanel
        isOpen={isExpensePanelOpen}
        onClose={handleCloseExpensePanel}
        title={editingExpense ? 'Edit Expense' : 'Add Expense'}
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={handleCloseExpensePanel}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmitExpense}
              disabled={
                isSubmitting ||
                expenseForm.expAmount.trim() === '' ||
                !Number.isFinite(parseExpenseAmount(expenseForm.expAmount)) ||
                !expenseForm.unit.trim()
              }
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-brand-primary shadow-lg shadow-brand-primary/30 hover:bg-brand-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {editingExpense ? 'Update' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Item / Description</label>
            <input
              type="text"
              value={expenseForm.expDesc}
              onChange={(e) => setExpenseForm((prev) => ({ ...prev, expDesc: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              placeholder="Item or description"
            />
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              Amount *{dreamMartDiscountEnabled ? ' (before 15% off)' : ''}
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={expenseForm.expAmount}
              onChange={(e) => {
                setExpenseForm((prev) => ({ ...prev, expAmount: formatExpenseAmountInput(e.target.value) }));
              }}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              placeholder={dreamMartDiscountEnabled ? 'Before 15% off' : '0.00'}
            />
            {dreamMartDiscountEnabled && expenseForm.expAmount.trim() !== '' && Number.isFinite(parseExpenseAmount(expenseForm.expAmount)) ? (
              <p className="text-xs text-emerald-700 font-medium">
                After 15% off: {formatExpenseTableAmount(computeDreamMartNetAmount(parseExpenseAmount(expenseForm.expAmount)))}
              </p>
            ) : null}
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              Unit <span className="text-red-500">*</span>
            </label>
            <Select2
              options={UOM_OPTIONS.map((u) => ({
                value: u,
                label: getUnitLabel(u),
              }))}
              value={expenseForm.unit || null}
              onChange={(val) =>
                setExpenseForm((prev) => ({ ...prev, unit: (val as string) || '' }))
              }
              placeholder="Select unit"
              className="mt-0"
            />
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              Qty
              {expenseFormUnit ? (
                <span className="text-brand-muted font-normal normal-case"> — {getUnitLabel(expenseFormUnit)}</span>
              ) : null}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={getQtyInputStep(expenseFormUnit || 'pcs')}
                value={expenseForm.stockQty}
                onChange={(e) => setExpenseForm((prev) => ({ ...prev, stockQty: e.target.value }))}
                className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
                placeholder="0"
              />
              {expenseFormUnit ? (
                <span className="text-sm text-brand-muted shrink-0">{getUnitLabel(expenseFormUnit)}</span>
              ) : null}
            </div>
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">
              Encoded Date
            </label>
            <input
              type="date"
              value={expenseForm.encodedDate}
              onChange={(e) => setExpenseForm((prev) => ({ ...prev, encodedDate: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
            />
          </div>
          <div className="space-y-3">
            <label className="text-xs font-bold text-brand-text uppercase tracking-wider block">Source (optional)</label>
            <input
              type="text"
              value={expenseForm.expSource}
              onChange={(e) => setExpenseForm((prev) => ({ ...prev, expSource: e.target.value }))}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all"
              placeholder="e.g. receipt, vendor"
            />
          </div>
        </div>
      </SidePanel>

      <Modal
        isOpen={isReceiptModalOpen}
        onClose={closeReceiptModal}
        title="Receipt scanner → Expenses"
        maxWidth="4xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            <div />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeReceiptModal}
                disabled={receiptUploadLoading || receiptExtractLoading || receiptSendLoading}
                className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Close
              </button>
              <button
                type="button"
                onClick={openReceiptSaveConfirm}
                disabled={
                  !receiptExtractResult?.items?.length ||
                  receiptSendLoading ||
                  receiptUploadLoading ||
                  receiptExtractLoading ||
                  receiptScanLoading
                }
                className="inline-flex items-center gap-2 rounded-xl bg-brand-primary px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {receiptSendLoading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                Save to Expenses
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-brand-muted">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full border',
                    receiptSegments.length ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-200 bg-white text-brand-muted',
                  )}
                >
                  1
                </span>
                <span>Scan</span>
              </div>
              <div className="h-px w-10 bg-gray-200" />
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-brand-muted">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full border',
                    receiptScannedImage ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-200 bg-white text-brand-muted',
                  )}
                >
                  2
                </span>
                <span>Preview</span>
              </div>
              <div className="h-px w-10 bg-gray-200" />
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-brand-muted">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full border',
                    receiptExtractResult?.items?.length
                      ? 'border-brand-primary bg-brand-primary text-white'
                      : 'border-gray-200 bg-white text-brand-muted',
                  )}
                >
                  3
                </span>
                <span>Submit</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-black',
                  uploadedReceiptPath ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-gray-50 text-brand-muted',
                )}
              >
                {uploadedReceiptPath ? 'Saved' : 'Not saved'}
              </span>
              <span
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-black',
                  receiptExtractResult?.items?.length
                    ? 'border-violet-200 bg-violet-50 text-violet-700'
                    : 'border-gray-200 bg-gray-50 text-brand-muted',
                )}
              >
                {receiptExtractResult?.items?.length ? `${receiptExtractResult.items.length} items` : 'Not extracted'}
              </span>
            </div>
          </div>

          <div
            className={cn('grid grid-cols-1 gap-4 md:items-stretch', receiptSegments.length > 0 && 'md:grid-cols-2')}
          >
            <div className={cn('flex flex-col min-h-[22rem]', receiptSegments.length > 0 && 'md:h-[min(32rem,50vh)]')}>
              <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xl border border-brand-primary/10 bg-brand-primary/10">
                      <Receipt size={14} className="text-brand-primary" />
                    </div>
                    <div className="text-sm font-black text-brand-text">Drop your receipt here</div>
                  </div>
                  <input
                    type="date"
                    value={receiptEncodedDateYmd}
                    onChange={(e) => setReceiptEncodedDateYmd(e.target.value)}
                    disabled={receiptSendLoading}
                    className="shrink-0 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm"
                  />
                </div>
                <div className="custom-scrollbar flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-5">
                  <div className="rounded-3xl border-2 border-dashed border-gray-200 bg-gray-50/40 p-6">
                    <div className="flex flex-col items-center text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-primary/10 bg-brand-primary/10">
                        <ScanLine size={20} className="text-brand-primary" />
                      </div>
                      <div className="mt-4 text-2xl font-black tracking-tight text-brand-text">Drop your receipt here</div>
                      <div className="mt-5 flex justify-center">
                        <label
                          className={cn(
                            'inline-flex w-[140px] cursor-pointer items-center justify-center gap-2 rounded-xl bg-brand-primary px-5 py-2.5 text-sm font-black text-white hover:bg-brand-primary/90',
                            receiptUploadLoading || receiptExtractLoading || receiptSendLoading ? 'cursor-not-allowed opacity-60' : '',
                          )}
                        >
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            disabled={receiptUploadLoading || receiptExtractLoading || receiptSendLoading}
                            className="hidden"
                            onChange={(e) => {
                              const files = Array.from(e.target.files || []);
                              e.target.value = '';
                              files.forEach((f) => void handleReceiptFilePicked(f));
                            }}
                          />
                          Browse file
                        </label>
                      </div>
                    </div>
                  </div>
                  {receiptSegments.length > 0 ? (
                    <div className="flex w-full flex-wrap items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => void scanReceipt()}
                        disabled={receiptScanLoading || receiptUploadLoading || receiptExtractLoading || receiptSendLoading}
                        className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-brand-primary px-4 py-2 text-sm font-black text-white hover:bg-brand-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {receiptScanLoading ? <Loader2 size={16} className="animate-spin" /> : <ScanLine size={16} />}
                        Scan receipt
                      </button>
                      <div className="inline-flex min-w-0 items-center gap-3 rounded-2xl border border-gray-200 bg-white px-3 py-2 text-xs text-brand-muted">
                        <span>
                          <span className="font-black uppercase tracking-wide">Segments</span>: {receiptSegments.length}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setReceiptSegments([]);
                            setReceiptScannedImage(null);
                            setReceiptPreviewDataUrl(null);
                            setReceiptExtractResult(null);
                          }}
                          disabled={receiptScanLoading || receiptExtractLoading || receiptSendLoading}
                          className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-bold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {(receiptFileError || receiptUploadLoading || uploadedReceiptPath) && (
                    <div
                      className={cn(
                        'rounded-2xl border px-4 py-3 text-xs',
                        receiptFileError
                          ? 'border-red-200 bg-red-50 text-red-700'
                          : uploadedReceiptPath
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-gray-200 bg-gray-50 text-brand-muted',
                      )}
                    >
                      {receiptFileError
                        ? receiptFileError
                        : receiptUploadLoading
                          ? 'Saving receipt (WebP)…'
                          : uploadedReceiptPath
                            ? `Saved: ${uploadedReceiptPath}`
                            : ''}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {receiptSegments.length > 0 ? (
              <div
                className={cn(
                  'flex min-h-[22rem] animate-in fade-in duration-300 flex-col md:h-[min(32rem,50vh)]',
                )}
              >
                <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
                  <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-xl border border-gray-900/10 bg-gray-900/5">
                        <Receipt size={14} className="text-brand-muted" />
                      </div>
                      <div className="text-sm font-black text-brand-text">Preview</div>
                    </div>
                    <div />
                  </div>
                  <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
                    {receiptScannedImage ? (
                      <button
                        type="button"
                        onClick={() => setReceiptPreviewLightboxOpen(true)}
                        className="group relative w-full shrink-0 overflow-hidden rounded-2xl border border-gray-200 bg-gray-50 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
                        title="View full receipt"
                      >
                        <img src={receiptScannedImage} alt="Receipt preview" className="block h-auto w-full" />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 via-black/20 to-transparent px-3 py-3 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="text-xs font-bold text-white drop-shadow-sm">Click to open full receipt</span>
                        </div>
                      </button>
                    ) : (
                      <div className="flex min-h-[8rem] flex-1 items-center justify-center rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm text-brand-muted">
                        Preview will appear after you scan.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex max-h-[min(22rem,42vh)] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm md:max-h-[min(26rem,45vh)]">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-xl border border-emerald-500/10 bg-emerald-500/10">
                  <Check size={14} className="text-emerald-600" />
                </div>
                <div className="text-sm font-black text-brand-text">Extracted items</div>
              </div>
              {receiptExtractResult?.items?.length ? (
                <div className="text-xs text-brand-muted">{receiptExtractResult.items.length} item(s)</div>
              ) : (
                <div />
              )}
            </div>
            {receiptExtractResult?.items?.length ? (
              <>
                <div className="custom-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto">
                  <table className="min-w-full text-sm">
                    <thead className="sticky top-0 z-[1] border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-brand-muted shadow-[0_1px_0_0_rgb(15_23_42/0.06)]">
                      <tr>
                        <th className="bg-gray-50 px-4 py-3 text-left">Name</th>
                        <th className="bg-gray-50 px-4 py-3 text-left">Category</th>
                        <th className="bg-gray-50 px-4 py-3 text-right">Qty</th>
                        <th className="bg-gray-50 px-4 py-3 text-left">Unit</th>
                        <th className="bg-gray-50 px-4 py-3 text-right">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptExtractResult.items.map((it, idx) => (
                        <tr key={`${idx}-${it.name}`} className="border-t border-gray-100 transition-colors hover:bg-gray-50/60">
                          <td className="whitespace-nowrap px-4 py-3 font-semibold text-brand-text">
                            {String(it.name || '').trim()}
                          </td>
                          <td className="px-4 py-3 text-brand-muted">
                            <span className="inline-flex rounded-lg border border-gray-200 bg-gray-100 px-2 py-1 text-[11px] font-bold">
                              {String(it.category || '').trim() || 'Others'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{Number(it.qty || 0) || 0}</td>
                          <td className="px-4 py-3 text-brand-muted">
                            {expenseUnitTrimmed(it.unit) ? getUnitLabel(it.unit!).toLowerCase() : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums">
                            {formatCurrency(Number(it.price || 0))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-100 bg-gray-50/90 px-5 py-3">
                  <span className="text-xs font-black uppercase tracking-wide text-brand-muted">Total</span>
                  <span className="text-base font-black tabular-nums text-brand-text">
                    {formatCurrency(Number(receiptExtractResult.receipt_grand_total || 0))}
                  </span>
                </div>
              </>
            ) : (
              <div className="p-5 text-sm text-brand-muted">No extracted items yet.</div>
            )}
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={receiptHistoryOpen}
        onClose={() => {
          if (receiptHistoryDetailOpen) return;
          setReceiptHistoryOpen(false);
        }}
        title="Receipt History"
        maxWidth="4xl"
        containerClassName="items-start pt-10"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setReceiptHistoryOpen(false)}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {receiptHistoryError ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {receiptHistoryError}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div className="text-sm font-black text-brand-text">Scanned receipts</div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-[11px] font-black uppercase tracking-wide text-brand-muted">
                  Source
                </label>
                <select
                  value={receiptHistorySourceFilter}
                  onChange={(e) =>
                    setReceiptHistorySourceFilter(e.target.value as 'all' | 'resto_admin' | 'receiptlens')
                  }
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-brand-text"
                >
                  <option value="all">All</option>
                  <option value="resto_admin">Resto Admin</option>
                  <option value="receiptlens">ReceiptLens</option>
                </select>
                <label className="text-[11px] font-black uppercase tracking-wide text-brand-muted">
                  Page length
                </label>
                <select
                  value={String(receiptHistoryPageSize)}
                  onChange={(e) => setReceiptHistoryPageSize(Number(e.target.value) || 20)}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-brand-text"
                >
                  {[20, 30, 40, 50, 100].map((n) => (
                    <option key={n} value={String(n)}>
                      {n}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-brand-muted">
                  {receiptHistoryLoading ? 'Loading…' : `${receiptHistoryRowsInRange.length} record(s)`}
                </div>
              </div>
            </div>
            <div className="custom-scrollbar max-h-[60vh] overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-[1] border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-brand-muted">
                  <tr>
                    <th className="bg-gray-50 px-4 py-3 text-left">Date</th>
                    <th className="bg-gray-50 px-4 py-3 text-left">Source</th>
                    <th className="bg-gray-50 px-4 py-3 text-right">Total</th>
                    <th className="bg-gray-50 px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {receiptHistoryLoading ? (
                    <tr>
                      <td className="px-4 py-6 text-center text-sm text-brand-muted" colSpan={4}>
                        Loading…
                      </td>
                    </tr>
                  ) : receiptHistoryRowsInRange.length ? (
                    receiptHistoryRowsInRange.map((r) => (
                      <tr
                        key={r.receiptImagePath}
                        className="border-t border-gray-100 hover:bg-gray-50/60 transition-colors"
                      >
                        <td className="px-4 py-3 font-semibold text-brand-text">
                          {String(r.ENCODED_DT || '').slice(0, 10)}
                        </td>
                        <td className="px-4 py-3 text-brand-muted">{r.SOURCE || '—'}</td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">
                          {formatCurrency(Number(r.RECEIPT_GRAND_TOTAL || 0))}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openReceiptHistoryDetail(r.receiptImagePath)}
                            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-bold hover:bg-gray-50"
                          >
                            <Eye size={14} />
                            View
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-6 text-center text-sm text-brand-muted" colSpan={4}>
                        No history yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={receiptHistoryDetailOpen}
        onClose={() => {
          setReceiptHistoryDetailOpen(false);
          setReceiptHistoryDetail(null);
        }}
        title="Receipt Detail"
        maxWidth="5xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReceiptHistoryDetailOpen(false);
                setReceiptHistoryDetail(null);
              }}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          {receiptHistoryDetailLoading ? (
            <div className="text-sm text-brand-muted">Loading…</div>
          ) : receiptHistoryDetail ? (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:items-stretch">
                <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm flex flex-col min-h-0 lg:h-[60vh]">
                  <div className="border-b border-gray-100 px-5 py-4 text-sm font-black text-brand-text shrink-0">Receipt</div>
                  <div className="custom-scrollbar flex-1 min-h-0 overflow-auto bg-slate-50 p-4">
                    {receiptHistoryDetail.receiptImageDisplayUrl ? (
                      <a
                        href={receiptHistoryDetail.receiptImageDisplayUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="group relative block overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
                        title="Open receipt in new tab"
                      >
                        <img
                          src={receiptHistoryDetail.receiptImageDisplayUrl}
                          alt="Receipt"
                          className="mx-auto block h-auto w-full max-w-full"
                        />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 via-black/20 to-transparent px-3 py-3 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="text-xs font-bold text-white drop-shadow-sm">Click to view</span>
                        </div>
                      </a>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm text-brand-muted">
                        No receipt image.
                      </div>
                    )}
                  </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm flex flex-col min-h-0 lg:h-[60vh]">
                  <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                    <div className="text-sm font-black text-brand-text">Expenses created</div>
                    <div className="text-xs text-brand-muted">
                      {(() => {
                        const key = String(receiptHistoryDetail.receiptImagePath || '');
                        const rows = expenses.filter((e) => String(e.receiptImagePath || '') === key);
                        return `${rows.length} item(s)`;
                      })()}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0">
                  {(() => {
                    const key = String(receiptHistoryDetail.receiptImagePath || '');
                    const rows = expenses.filter((e) => String(e.receiptImagePath || '') === key);
                    if (!rows.length) {
                      return (
                        <div className="h-full flex items-center justify-center p-5 text-sm text-brand-muted">
                          No matching expenses found for this receipt in the current list.
                        </div>
                      );
                    }

                    const sortedRows = rows
                      .slice()
                      .sort((a, b) => Number(a.id) - Number(b.id));
                    const total = sortedRows.reduce((s, r) => s + Number(r.expAmount || 0), 0);

                    return (
                      <div className="flex h-full min-h-0 flex-col">
                        <div className="custom-scrollbar min-h-0 flex-1 overflow-auto">
                          <table className="min-w-full text-sm">
                            <thead className="sticky top-0 z-[1] border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-brand-muted">
                              <tr>
                                <th className="bg-gray-50 px-4 py-3 text-left">Name</th>
                                <th className="bg-gray-50 px-4 py-3 text-right">Qty</th>
                                <th className="bg-gray-50 px-4 py-3 text-left">Unit</th>
                                <th className="bg-gray-50 px-4 py-3 text-right">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortedRows.map((r) => (
                                <tr key={String(r.id)} className="border-t border-gray-100">
                                  <td className="px-4 py-3 font-semibold text-brand-text">
                                    {String(r.expDesc || r.expName || '').trim() || '—'}
                                  </td>
                                  <td className="px-4 py-3 text-right tabular-nums">
                                    {formatQty(
                                      expenseLineQty(r),
                                      expenseUnitTrimmed(r.unit) || 'pcs',
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-brand-muted">
                                    {expenseUnitTrimmed(r.unit) ? getUnitLabel(r.unit!) : '—'}
                                  </td>
                                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                                    {formatCurrency(Number(r.expAmount || 0))}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-100 bg-gray-50/90 px-5 py-3">
                          <span className="text-xs font-black uppercase tracking-wide text-brand-muted">Total</span>
                          <span className="text-base font-black tabular-nums text-brand-text">{formatCurrency(total)}</span>
                        </div>
                      </div>
                    );
                  })()}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-brand-muted">No data.</div>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={receiptSaveConfirmOpen}
        onClose={() => {
          if (receiptSendLoading || receiptUploadLoading) return;
          setReceiptSaveConfirmOpen(false);
        }}
        title="Are you sure you want to add in expense?"
        maxWidth="3xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setReceiptSaveConfirmOpen(false)}
              disabled={receiptSendLoading || receiptUploadLoading}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void sendExtractedReceiptToExpenses()}
              disabled={receiptSendLoading || receiptUploadLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-brand-primary px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand-primary/20 hover:bg-brand-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {receiptSendLoading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              Confirm
            </button>
          </div>
        }
      >
        <div className="space-y-4 text-sm text-brand-text">
          <div>
            <div className="text-[11px] font-black uppercase tracking-wide text-brand-muted">Encoded date</div>
            <div className="mt-1 font-semibold">{receiptSaveEncodedDateLabel}</div>
          </div>
          {receiptExtractResult?.items?.length ? (
            <div className="flex max-h-[min(22rem,42vh)] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm md:max-h-[min(26rem,45vh)]">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-xl border border-emerald-500/10 bg-emerald-500/10">
                    <Check size={14} className="text-emerald-600" />
                  </div>
                  <div className="text-sm font-black text-brand-text">Extracted items</div>
                </div>
                <div className="text-xs text-brand-muted">{receiptExtractResult.items.length} item(s)</div>
              </div>
              <div className="custom-scrollbar min-h-0 flex-1 overflow-x-auto overflow-y-auto">
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 z-[1] border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-brand-muted shadow-[0_1px_0_0_rgb(15_23_42/0.06)]">
                    <tr>
                      <th className="bg-gray-50 px-4 py-3 text-left">Name</th>
                      <th className="bg-gray-50 px-4 py-3 text-left">Category</th>
                      <th className="bg-gray-50 px-4 py-3 text-right">Qty</th>
                      <th className="bg-gray-50 px-4 py-3 text-left">Unit</th>
                      <th className="bg-gray-50 px-4 py-3 text-right">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptExtractResult.items.map((it, idx) => (
                      <tr key={`confirm-${idx}-${it.name}`} className="border-t border-gray-100 transition-colors hover:bg-gray-50/60">
                        <td className="whitespace-nowrap px-4 py-3 font-semibold text-brand-text">
                          {String(it.name || '').trim()}
                        </td>
                        <td className="px-4 py-3 text-brand-muted">
                          <span className="inline-flex rounded-lg border border-gray-200 bg-gray-100 px-2 py-1 text-[11px] font-bold">
                            {String(it.category || '').trim() || 'Others'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{Number(it.qty || 0) || 0}</td>
                        <td className="px-4 py-3 text-brand-muted">
                          {expenseUnitTrimmed(it.unit) ? getUnitLabel(it.unit!).toLowerCase() : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums">
                          {formatCurrency(Number(it.price || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-100 bg-gray-50/90 px-5 py-3">
                <span className="text-xs font-black uppercase tracking-wide text-brand-muted">Total</span>
                <span className="text-base font-black tabular-nums text-brand-text">
                  {formatCurrency(Number(receiptExtractResult.receipt_grand_total || 0))}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </Modal>

      <AnimatePresence>
        {receiptPreviewLightboxOpen && receiptScannedImage ? (
          <motion.div
            key="receipt-preview-lightbox"
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setReceiptPreviewLightboxOpen(false)}
            role="presentation"
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="receipt-preview-lightbox-title"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              transition={{ type: 'spring', damping: 28, stiffness: 320 }}
              className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-4">
                <h3 id="receipt-preview-lightbox-title" className="text-lg font-bold text-brand-text">
                  Receipt Preview
                </h3>
                <button
                  type="button"
                  onClick={() => setReceiptPreviewLightboxOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-50 text-brand-muted transition-colors hover:bg-red-50 hover:text-red-500"
                  title="Close"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4">
                <img src={receiptScannedImage} alt="Receipt" className="mx-auto block h-auto w-full max-w-full rounded-lg" />
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Modal
        isOpen={breakdownDetailModal !== null}
        onClose={() => setBreakdownDetailModal(null)}
        title={breakdownDetailModal?.title ?? 'Expense items'}
        maxWidth="3xl"
        bodyClassName="p-0"
        footer={
          <div className="flex w-full items-center justify-between gap-4">
            <div className="text-sm text-brand-muted">
              {breakdownDetailModal ? (
                <>
                  <span className="font-bold text-brand-text">{breakdownDetailModal.expenses.length}</span> item
                  {breakdownDetailModal.expenses.length === 1 ? '' : 's'}
                  {breakdownDetailModal.subtitle ? (
                    <span className="ml-2">• {breakdownDetailModal.subtitle}</span>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {breakdownDetailModal ? (
                <span className="text-sm font-black tabular-nums text-brand-text">
                  Total {formatCurrency(breakdownDetailModal.total)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => setBreakdownDetailModal(null)}
                className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold hover:bg-gray-50 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        }
      >
        {breakdownDetailModal ? (
          <div className="custom-scrollbar max-h-[min(60vh,520px)] overflow-auto">
            {breakdownDetailModal.expenses.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-brand-muted">No expense items in this range.</div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 z-[1] border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-brand-muted">
                  <tr>
                    <th className="bg-gray-50 px-5 py-3 text-left">Date</th>
                    <th className="bg-gray-50 px-5 py-3 text-left">Item</th>
                    <th className="bg-gray-50 px-5 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdownDetailModal.expenses.map((exp) => (
                    <tr key={exp.id} className="border-t border-gray-100 hover:bg-gray-50/60">
                      <td className="px-5 py-3 font-medium text-slate-700 whitespace-nowrap">
                        {expenseEncodedYmd(exp.encodedDt) ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-slate-800">
                        {exp.expDesc || exp.expName || '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-bold tabular-nums text-slate-900">
                        {formatCurrency(Number(exp.expAmount) || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </Modal>

      {/* Delete Expense Confirmation */}
      <Modal
        isOpen={!!expenseToDelete}
        onClose={() => !isSubmitting && setExpenseToDelete(null)}
        title="Delete Expense"
        maxWidth="sm"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => setExpenseToDelete(null)}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl font-bold text-brand-muted hover:bg-gray-100 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeleteExpense}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl font-bold text-white bg-red-500 shadow-lg shadow-red-500/30 hover:bg-red-600 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting && <Loader2 size={16} className="animate-spin" />}
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-brand-muted text-sm">
            Are you sure you want to delete this expense?
            {expenseToDelete && (
              <>
                {' '}
                <span className="font-bold text-brand-text">{expenseToDelete.expDesc || expenseToDelete.expName}</span>
                {' '}
                ({formatCurrency(expenseToDelete.expAmount)})
              </>
            )}
          </p>
        </div>
      </Modal>
    </div>
      </>
    </SkeletonTransition>
  );
};

