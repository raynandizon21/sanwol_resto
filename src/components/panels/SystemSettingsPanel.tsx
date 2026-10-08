import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X,
    Settings,
    Globe,
    Shield,
    Info,
    ChevronRight,
    Store,
    Layout,
    Smartphone,
    ArrowLeft,
    Plus,
    Pencil,
    Trash2,
    Check,
    AlertCircle,
    Loader2,
    MapPin,
    Phone,
    Hash,
    Eye,
    EyeOff,
    RefreshCw,
    User as UserIcon,
    FileText,
    QrCode,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// ─── Shared Types & Helpers ────────────────────────────

type Toast = { type: 'success' | 'error'; message: string } | null;

function getToken() {
    return localStorage.getItem('token') || '';
}

function authHeaders(): HeadersInit {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
    };
}

// ─── Shared SettingsItem ────────────────────────────────

type SettingsItemProps = {
    icon: React.ElementType;
    label: string;
    description?: string;
    onClick?: () => void;
    badge?: string;
};

const SettingsItem: React.FC<SettingsItemProps> = ({
    icon: Icon,
    label,
    description,
    onClick,
    badge
}) => (
    <button
        onClick={onClick}
        className="w-full flex items-center justify-between p-4 rounded-2xl transition-all cursor-pointer group border border-transparent hover:bg-brand-orange/5 hover:border-brand-orange/10"
    >
        <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-gray-100 text-brand-muted group-hover:bg-brand-orange/10 group-hover:text-brand-orange transition-colors">
                <Icon size={18} />
            </div>
            <div className="text-left">
                <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-brand-text">{label}</p>
                    {badge && (
                        <span className="px-1.5 py-0.5 bg-brand-orange/10 text-brand-orange text-[10px] font-bold rounded uppercase tracking-wider">
                            {badge}
                        </span>
                    )}
                </div>
                {description && (
                    <p className="text-xs text-brand-muted font-medium">{description}</p>
                )}
            </div>
        </div>
        <ChevronRight
            size={16}
            className="text-brand-muted/40 transition-transform group-hover:translate-x-0.5"
        />
    </button>
);

// ─── Sub-header component ─────────────────────────────

const SubViewHeader: React.FC<{
    title: string;
    onBack: () => void;
    disabled?: boolean;
    action?: React.ReactNode;
}> = ({ title, onBack, disabled, action }) => (
    <div className="p-6 border-b border-gray-100">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
                <button
                    onClick={onBack}
                    disabled={disabled}
                    className={cn("p-2 rounded-lg transition-colors text-brand-muted", disabled ? "cursor-not-allowed opacity-50" : "hover:bg-gray-100 cursor-pointer")}
                >
                    <ArrowLeft size={20} />
                </button>
                <h3 className="text-lg font-bold text-brand-text">{title}</h3>
            </div>
            {action}
        </div>
    </div>
);

// ─── Toast component ──────────────────────────────────

const ToastMessage: React.FC<{ toast: Toast }> = ({ toast }) => (
    <AnimatePresence>
        {toast && (
            <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className={cn(
                    "mx-6 mt-4 px-4 py-3 rounded-xl flex items-center gap-3 text-sm font-medium",
                    toast.type === 'success'
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : "bg-red-50 text-red-700 border border-red-200"
                )}
            >
                {toast.type === 'success' ? <Check size={16} className="shrink-0" /> : <AlertCircle size={16} className="shrink-0" />}
                <span>{toast.message}</span>
            </motion.div>
        )}
    </AnimatePresence>
);

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Branch Management
// ═══════════════════════════════════════════════════════

type BranchRecord = {
    IDNo: number;
    BRANCH_CODE: string;
    BRANCH_NAME: string;
    ADDRESS?: string;
    PHONE?: string;
};

const BranchManagementView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const [branches, setBranches] = useState<BranchRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [toast, setToast] = useState<Toast>(null);
    const [editingBranch, setEditingBranch] = useState<BranchRecord | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [saving, setSaving] = useState(false);

    // Form
    const [formCode, setFormCode] = useState('');
    const [formName, setFormName] = useState('');
    const [formAddress, setFormAddress] = useState('');
    const [formPhone, setFormPhone] = useState('');

    useEffect(() => {
        if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }
    }, [toast]);

    const fetchBranches = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/branch/', { headers: authHeaders() });
            const data = await res.json();
            if (data.success) setBranches(data.data || []);
        } catch { setToast({ type: 'error', message: t('system_settings.branch_load_failed') }); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchBranches(); }, [fetchBranches]);

    const resetForm = () => {
        setFormCode(''); setFormName(''); setFormAddress(''); setFormPhone('');
        setEditingBranch(null); setIsCreating(false);
    };

    const startEdit = (b: BranchRecord) => {
        setEditingBranch(b); setIsCreating(false);
        setFormCode(b.BRANCH_CODE); setFormName(b.BRANCH_NAME);
        setFormAddress(b.ADDRESS || ''); setFormPhone(b.PHONE || '');
    };

    const startCreate = () => {
        resetForm(); setIsCreating(true);
    };

    const handleSave = async () => {
        if (!formCode.trim() || !formName.trim()) {
            setToast({ type: 'error', message: t('system_settings.branch_required') });
            return;
        }
        setSaving(true);
        try {
            const body = { BRANCH_CODE: formCode.trim(), BRANCH_NAME: formName.trim(), ADDRESS: formAddress.trim(), PHONE: formPhone.trim() };
            let res;
            if (editingBranch) {
                res = await fetch(`/branch/${editingBranch.IDNo}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
            } else {
                res = await fetch('/branch/', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            }
            const data = await res.json();
            if (data.success) {
                setToast({ type: 'success', message: editingBranch ? t('system_settings.branch_updated') : t('system_settings.branch_created') });
                resetForm();
                fetchBranches();
            } else {
                setToast({ type: 'error', message: data.message || data.error || t('system_settings.branch_save_failed') });
            }
        } catch { setToast({ type: 'error', message: 'Network error' }); }
        finally { setSaving(false); }
    };

    const handleDelete = async (id: number) => {
        if (!confirm(t('system_settings.branch_delete_confirm'))) return;
        try {
            const res = await fetch(`/branch/${id}`, { method: 'DELETE', headers: authHeaders() });
            const data = await res.json();
            if (data.success) {
                setToast({ type: 'success', message: t('system_settings.branch_deleted') });
                fetchBranches();
            } else {
                setToast({ type: 'error', message: data.message || data.error || t('system_settings.branch_delete_failed') });
            }
        } catch { setToast({ type: 'error', message: 'Network error' }); }
    };

    const showForm = isCreating || editingBranch;

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader
                title={t('system_settings.branch_management')}
                onBack={onBack}
                action={
                    !showForm ? (
                        <button onClick={startCreate} className="p-2 bg-brand-orange/10 text-brand-orange rounded-lg hover:bg-brand-orange/20 transition-colors cursor-pointer">
                            <Plus size={18} />
                        </button>
                    ) : undefined
                }
            />
            <ToastMessage toast={toast} />

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4">
                {showForm ? (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                        <h4 className="text-sm font-bold text-brand-text">{editingBranch ? t('system_settings.edit_branch') : t('system_settings.new_branch')}</h4>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">{t('system_settings.branch_code')} *</label>
                            <div className="relative">
                                <Hash size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                                <input value={formCode} onChange={e => setFormCode(e.target.value)} disabled={saving}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-orange/20 focus:border-brand-orange/50 outline-none transition-all disabled:opacity-50" />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">{t('system_settings.branch_name')} *</label>
                            <div className="relative">
                                <Store size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                                <input value={formName} onChange={e => setFormName(e.target.value)} disabled={saving}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-orange/20 focus:border-brand-orange/50 outline-none transition-all disabled:opacity-50" />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">{t('system_settings.address')}</label>
                            <div className="relative">
                                <MapPin size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                                <input value={formAddress} onChange={e => setFormAddress(e.target.value)} disabled={saving}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-orange/20 focus:border-brand-orange/50 outline-none transition-all disabled:opacity-50" />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">{t('system_settings.phone')}</label>
                            <div className="relative">
                                <Phone size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                                <input value={formPhone} onChange={e => setFormPhone(e.target.value)} disabled={saving}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-3 text-sm focus:bg-white focus:ring-2 focus:ring-brand-orange/20 focus:border-brand-orange/50 outline-none transition-all disabled:opacity-50" />
                            </div>
                        </div>
                        <div className="flex gap-3 pt-2">
                            <button onClick={resetForm} disabled={saving}
                                className="flex-1 py-3 bg-gray-100 text-brand-text rounded-xl font-bold text-sm hover:bg-gray-200 transition-colors cursor-pointer disabled:opacity-50">
                                {t('system_settings.cancel')}
                            </button>
                            <button onClick={handleSave} disabled={saving}
                                className="flex-1 py-3 bg-brand-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-brand-primary/20 hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
                                {saving ? <><Loader2 size={16} className="animate-spin" /> {t('system_settings.saving')}...</> : t('system_settings.save')}
                            </button>
                        </div>
                    </motion.div>
                ) : loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 size={24} className="animate-spin text-brand-orange" />
                    </div>
                ) : branches.length === 0 ? (
                    <div className="text-center py-12">
                        <Store size={40} className="mx-auto text-brand-muted/30 mb-3" />
                        <p className="text-sm text-brand-muted font-medium">{t('system_settings.no_branches')}</p>
                        <button onClick={startCreate} className="mt-3 text-sm text-brand-orange font-bold hover:underline cursor-pointer">+ {t('system_settings.add_first_branch')}</button>
                    </div>
                ) : (
                    branches.map(b => (
                        <motion.div key={b.IDNo} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                            className="p-4 bg-gray-50 rounded-2xl border border-gray-100 hover:border-brand-orange/20 transition-colors group">
                            <div className="flex items-start justify-between">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="px-2 py-0.5 bg-brand-orange/10 text-brand-orange text-[10px] font-bold rounded uppercase tracking-wider">{b.BRANCH_CODE}</span>
                                        <h4 className="text-sm font-bold text-brand-text truncate">{b.BRANCH_NAME}</h4>
                                    </div>
                                    {b.ADDRESS && <p className="text-xs text-brand-muted flex items-center gap-1 mt-1"><MapPin size={12} /> {b.ADDRESS}</p>}
                                    {b.PHONE && <p className="text-xs text-brand-muted flex items-center gap-1 mt-0.5"><Phone size={12} /> {b.PHONE}</p>}
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                                    <button onClick={() => startEdit(b)} className="p-1.5 hover:bg-white rounded-lg text-brand-muted hover:text-brand-orange transition-colors cursor-pointer">
                                        <Pencil size={14} />
                                    </button>
                                    <button onClick={() => handleDelete(b.IDNo)} className="p-1.5 hover:bg-white rounded-lg text-brand-muted hover:text-red-500 transition-colors cursor-pointer">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    ))
                )}
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Localization
// ═══════════════════════════════════════════════════════

const LANGUAGES = [
    { code: 'en', label: 'English', flag: '🇺🇸' },
    { code: 'ko', label: '한국어 (Korean)', flag: '🇰🇷' },
    { code: 'ja', label: '日本語 (Japanese)', flag: '🇯🇵' },
    { code: 'zh', label: '中文 (Chinese)', flag: '🇨🇳' },
];

const LocalizationView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const [currentLang, setCurrentLang] = useState('en');
    const [toast, setToast] = useState<Toast>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        // Read current language from cookie
        const match = document.cookie.match(/(?:^|;\s*)lang=(\w+)/);
        if (match) setCurrentLang(match[1]);
    }, []);

    useEffect(() => {
        if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }
    }, [toast]);

    const handleChangeLang = async (code: string) => {
        if (code === currentLang) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/change-lang?lang=${code}`);
            const data = await res.json();
            if (data.success) {
                setCurrentLang(code);
                setToast({ type: 'success', message: `Language changed to ${LANGUAGES.find(l => l.code === code)?.label}` });
            } else {
                setToast({ type: 'error', message: t('system_settings.lang_change_failed') });
            }
        } catch { setToast({ type: 'error', message: 'Network error' }); }
        finally { setSaving(false); }
    };

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader title={t('system_settings.localization')} onBack={onBack} />
            <ToastMessage toast={toast} />
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-3">
                <p className="text-xs text-brand-muted font-medium mb-4">{t('system_settings.lang_description')}</p>
                {LANGUAGES.map(lang => (
                    <button
                        key={lang.code}
                        onClick={() => handleChangeLang(lang.code)}
                        disabled={saving}
                        className={cn(
                            "w-full flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer disabled:opacity-50",
                            currentLang === lang.code
                                ? "border-brand-orange bg-brand-orange/5"
                                : "border-gray-100 hover:border-brand-orange/20 hover:bg-gray-50"
                        )}
                    >
                        <div className="flex items-center gap-4">
                            <span className="text-2xl">{lang.flag}</span>
                            <span className="text-sm font-bold text-brand-text">{lang.label}</span>
                        </div>
                        {currentLang === lang.code && (
                            <div className="w-6 h-6 bg-brand-orange rounded-full flex items-center justify-center">
                                <Check size={14} className="text-white" />
                            </div>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Dashboard Layout
// ═══════════════════════════════════════════════════════

const DASHBOARD_WIDGETS = [
    { key: 'revenue_chart', label: 'Revenue Chart', description: 'Monthly income vs expense graph' },
    { key: 'stat_cards', label: 'Stat Cards', description: 'Revenue, orders, customers overview' },
    { key: 'trending_menu', label: 'Trending Menu', description: 'Top selling menu items' },
    { key: 'recent_orders', label: 'Recent Orders', description: 'Latest order activity feed' },
    { key: 'quick_actions', label: 'Quick Actions', description: 'Shortcut buttons for common tasks' },
];

const STORAGE_KEY = 'dashboard_widget_visibility';

const DashboardLayoutView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            return saved ? JSON.parse(saved) : {};
        } catch { return {}; }
    });
    const [toast, setToast] = useState<Toast>(null);

    useEffect(() => {
        if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }
    }, [toast]);

    const isVisible = (key: string) => visibility[key] !== false; // default visible

    const toggle = (key: string) => {
        const updated = { ...visibility, [key]: !isVisible(key) };
        setVisibility(updated);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        setToast({ type: 'success', message: `Widget ${isVisible(key) ? 'hidden' : 'shown'}` });
    };

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader title={t('system_settings.dashboard_layout')} onBack={onBack} />
            <ToastMessage toast={toast} />
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-3">
                <p className="text-xs text-brand-muted font-medium mb-4">{t('system_settings.dashboard_layout_desc')}</p>
                {DASHBOARD_WIDGETS.map(w => (
                    <button
                        key={w.key}
                        onClick={() => toggle(w.key)}
                        className={cn(
                            "w-full flex items-center justify-between p-4 rounded-2xl border transition-all cursor-pointer",
                            isVisible(w.key) ? "border-green-200 bg-green-50/50" : "border-gray-100 bg-gray-50 opacity-60"
                        )}
                    >
                        <div className="flex items-center gap-4">
                            <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center",
                                isVisible(w.key) ? "bg-green-100 text-green-600" : "bg-gray-200 text-gray-400"
                            )}>
                                {isVisible(w.key) ? <Eye size={18} /> : <EyeOff size={18} />}
                            </div>
                            <div className="text-left">
                                <p className="text-sm font-bold text-brand-text">{w.label}</p>
                                <p className="text-xs text-brand-muted font-medium">{w.description}</p>
                            </div>
                        </div>
                        <div className={cn(
                            "w-12 h-7 rounded-full p-1 transition-colors",
                            isVisible(w.key) ? "bg-green-500" : "bg-gray-300"
                        )}>
                            <motion.div
                                layout
                                className="w-5 h-5 bg-white rounded-full shadow-sm"
                                style={{ marginLeft: isVisible(w.key) ? 'auto' : 0 }}
                            />
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Mobile App
// ═══════════════════════════════════════════════════════

const MobileAppView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const serverUrl = window.location.origin;

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader title={t('system_settings.mobile_app')} onBack={onBack} />
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                <div className="text-center">
                    <div className="w-20 h-20 mx-auto bg-brand-orange/10 rounded-3xl flex items-center justify-center mb-4">
                        <Smartphone size={36} className="text-brand-orange" />
                    </div>
                    <h4 className="text-base font-bold text-brand-text mb-2">{t('system_settings.connect_mobile')}</h4>
                    <p className="text-xs text-brand-muted font-medium leading-relaxed">
                        {t('system_settings.mobile_description')}
                    </p>
                </div>

                <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-3">
                    <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">{t('system_settings.server_address')}</p>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 bg-white px-3 py-2.5 rounded-xl text-sm font-mono text-brand-text border border-gray-200 truncate">
                            {serverUrl}
                        </code>
                        <button
                            onClick={() => { navigator.clipboard.writeText(serverUrl); }}
                            className="px-3 py-2.5 bg-brand-orange/10 text-brand-orange rounded-xl text-xs font-bold hover:bg-brand-orange/20 transition-colors cursor-pointer shrink-0"
                        >
                            {t('system_settings.copy')}
                        </button>
                    </div>
                </div>

                <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 text-center space-y-3">
                    <QrCode size={80} className="mx-auto text-brand-muted/30" />
                    <p className="text-xs text-brand-muted font-medium">{t('system_settings.qr_description')}</p>
                </div>

                <div className="space-y-2">
                    <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest px-1">{t('system_settings.requirements')}</p>
                    <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 text-xs text-blue-700 font-medium">
                        ✓ {t('system_settings.req_same_network')}
                    </div>
                    <div className="p-3 bg-blue-50 rounded-xl border border-blue-100 text-xs text-blue-700 font-medium">
                        ✓ {t('system_settings.req_server_port')}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Security Audit
// ═══════════════════════════════════════════════════════

type AuditLog = {
    IDNo: number;
    USER_ID: number;
    USERNAME?: string;
    FIRSTNAME?: string;
    LASTNAME?: string;
    ACTION: string;
    TABLE_NAME: string;
    RECORD_ID?: number;
    BRANCH_ID?: number;
    BRANCH_NAME?: string;
    CREATED_DT: string;
};

const SecurityAuditView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [toast, setToast] = useState<Toast>(null);

    useEffect(() => {
        if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); }
    }, [toast]);

    const fetchLogs = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch('/audit-logs?limit=50', { headers: authHeaders() });
            const data = await res.json();
            if (data.success) setLogs(data.data || []);
            else setToast({ type: 'error', message: 'Failed to load audit logs' });
        } catch { setToast({ type: 'error', message: 'Network error' }); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const getActionColor = (action: string) => {
        switch (action) {
            case 'CREATE': return 'bg-green-100 text-green-700';
            case 'UPDATE': return 'bg-blue-100 text-blue-700';
            case 'DELETE': return 'bg-red-100 text-red-700';
            case 'LOGIN': return 'bg-purple-100 text-purple-700';
            default: return 'bg-gray-100 text-gray-600';
        }
    };

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader
                title={t('system_settings.security_audit')}
                onBack={onBack}
                action={
                    <button onClick={fetchLogs} disabled={loading}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-brand-muted cursor-pointer disabled:opacity-50">
                        <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                }
            />
            <ToastMessage toast={toast} />
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-2">
                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 size={24} className="animate-spin text-brand-orange" />
                    </div>
                ) : logs.length === 0 ? (
                    <div className="text-center py-12">
                        <Shield size={40} className="mx-auto text-brand-muted/30 mb-3" />
                        <p className="text-sm text-brand-muted font-medium">{t('system_settings.no_audit_logs')}</p>
                    </div>
                ) : (
                    logs.map(log => (
                        <div key={log.IDNo} className="p-3 bg-gray-50 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors">
                            <div className="flex items-center justify-between mb-1.5">
                                <span className={cn("px-2 py-0.5 text-[10px] font-bold rounded uppercase tracking-wider", getActionColor(log.ACTION))}>
                                    {log.ACTION}
                                </span>
                                <span className="text-[10px] text-brand-muted font-medium">
                                    {new Date(log.CREATED_DT).toLocaleString()}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                                <UserIcon size={12} className="text-brand-muted shrink-0" />
                                <span className="text-brand-text font-medium truncate">
                                    {log.FIRSTNAME && log.LASTNAME ? `${log.FIRSTNAME} ${log.LASTNAME}` : log.USERNAME || `User #${log.USER_ID}`}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs mt-0.5">
                                <FileText size={12} className="text-brand-muted shrink-0" />
                                <span className="text-brand-muted font-medium">{log.TABLE_NAME}{log.RECORD_ID ? ` #${log.RECORD_ID}` : ''}</span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// SUB-VIEW: Version Info
// ═══════════════════════════════════════════════════════

const VersionInfoView: React.FC<{ onBack: () => void; t: (key: string) => string }> = ({ onBack, t }) => {
    const appName = '3Core Dashboard';
    const appVersion = '1.0.0';
    const buildDate = 'Feb 26, 2026';

    const infoItems = [
        { label: t('system_settings.application'), value: appName },
        { label: t('system_settings.version'), value: `v${appVersion}` },
        { label: t('system_settings.build_date'), value: buildDate },
        { label: t('system_settings.frontend'), value: 'React 19 + Vite 6' },
        { label: t('system_settings.backend'), value: 'Node.js + Express 4' },
        { label: t('system_settings.database'), value: 'MySQL' },
        { label: t('system_settings.auth'), value: 'JWT + Session' },
        { label: t('system_settings.realtime'), value: 'Socket.IO' },
    ];

    return (
        <div className="flex flex-col h-full">
            <SubViewHeader title={t('system_settings.version_info')} onBack={onBack} />
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                <div className="text-center">
                    <div className="w-20 h-20 mx-auto bg-gradient-to-br from-brand-orange/20 to-brand-primary/20 rounded-3xl flex items-center justify-center mb-4">
                        <Settings size={36} className="text-brand-orange" />
                    </div>
                    <h4 className="text-lg font-bold text-brand-text">{appName}</h4>
                    <p className="text-sm text-brand-muted font-medium">{t('system_settings.restaurant_management')}</p>
                </div>

                <div className="space-y-1">
                    {infoItems.map((item, i) => (
                        <div key={i} className="flex items-center justify-between p-3 rounded-xl hover:bg-gray-50 transition-colors">
                            <span className="text-xs font-bold text-brand-muted uppercase tracking-wider">{item.label}</span>
                            <span className="text-sm font-bold text-brand-text">{item.value}</span>
                        </div>
                    ))}
                </div>

                <div className="p-4 bg-green-50 rounded-2xl border border-green-100 text-center">
                    <div className="flex items-center justify-center gap-2 mb-1">
                        <Check size={16} className="text-green-600" />
                        <span className="text-sm font-bold text-green-700">{t('system_settings.latest_version')}</span>
                    </div>
                    <p className="text-xs text-green-600 font-medium">{t('system_settings.no_updates')}</p>
                </div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════
// MAIN PANEL
// ═══════════════════════════════════════════════════════

type ViewState = 'main' | 'branch' | 'localization' | 'dashboard-layout' | 'mobile-app' | 'security-audit' | 'version-info';

type SystemSettingsPanelProps = {
    isOpen: boolean;
    onClose: () => void;
};

export const SystemSettingsPanel: React.FC<SystemSettingsPanelProps> = ({
    isOpen,
    onClose,
}) => {
    const [view, setView] = useState<ViewState>('main');
    const { t } = useTranslation();

    const handleClose = () => {
        onClose();
        setTimeout(() => setView('main'), 300);
    };

    const goBack = () => setView('main');

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={handleClose}
                        className="fixed inset-0 bg-black/20 z-[60]"
                    />

                    {/* Side Panel */}
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-[70] flex flex-col"
                    >
                        <AnimatePresence mode="wait">
                            {view === 'main' ? (
                                <motion.div
                                    key="main"
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="flex flex-col h-full"
                                >
                                    {/* Header */}
                                    <div className="p-6 border-b border-gray-100">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 bg-brand-orange/10 text-brand-orange rounded-xl flex items-center justify-center">
                                                    <Settings size={20} />
                                                </div>
                                                <h3 className="text-lg font-bold text-brand-text">{t('system_settings.title')}</h3>
                                            </div>
                                            <button
                                                onClick={handleClose}
                                                className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-brand-muted cursor-pointer"
                                            >
                                                <X size={20} />
                                            </button>
                                        </div>
                                    </div>

                                    {/* Scrollable Content */}
                                    <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                                        <div className="px-4 py-2">
                                            <h5 className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">{t('system_settings.general')}</h5>
                                        </div>
                                        <SettingsItem
                                            icon={Store}
                                            label={t('system_settings.branch_management')}
                                            description={t('system_settings.branch_management_desc')}
                                            onClick={() => setView('branch')}
                                        />
                                        <SettingsItem
                                            icon={Globe}
                                            label={t('system_settings.localization')}
                                            description={t('system_settings.localization_desc')}
                                            onClick={() => setView('localization')}
                                        />
                                        <SettingsItem
                                            icon={Layout}
                                            label={t('system_settings.dashboard_layout')}
                                            description={t('system_settings.dashboard_layout_desc_short')}
                                            badge={t('system_settings.new')}
                                            onClick={() => setView('dashboard-layout')}
                                        />

                                        <div className="px-4 py-2 mt-4">
                                            <h5 className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">{t('system_settings.connect_sync')}</h5>
                                        </div>
                                        <SettingsItem
                                            icon={Smartphone}
                                            label={t('system_settings.mobile_app')}
                                            description={t('system_settings.mobile_app_desc')}
                                            onClick={() => setView('mobile-app')}
                                        />

                                        <div className="px-4 py-2 mt-4">
                                            <h5 className="text-[10px] font-bold text-brand-muted uppercase tracking-widest">{t('system_settings.system_info')}</h5>
                                        </div>
                                        <SettingsItem
                                            icon={Shield}
                                            label={t('system_settings.security_audit')}
                                            description={t('system_settings.security_audit_desc')}
                                            onClick={() => setView('security-audit')}
                                        />
                                        <SettingsItem
                                            icon={Info}
                                            label={t('system_settings.version_info')}
                                            description="v1.0.0 — 3Core Dashboard"
                                            onClick={() => setView('version-info')}
                                        />
                                    </div>

                                    {/* Footer */}
                                    <div className="p-6 border-t border-gray-100">
                                        <div className="bg-brand-bg rounded-2xl p-4 border border-gray-100">
                                            <p className="text-xs text-brand-muted font-medium mb-3">
                                                {t('system_settings.system_health')}: <span className="text-green-600 font-bold uppercase tracking-wider ml-1">{t('system_settings.optimal')}</span>
                                            </p>
                                            <div className="w-full bg-gray-200 h-1.5 rounded-full overflow-hidden">
                                                <motion.div
                                                    initial={{ width: 0 }}
                                                    animate={{ width: '94%' }}
                                                    className="bg-green-500 h-full"
                                                />
                                            </div>
                                            <p className="mt-3 text-[10px] text-brand-muted leading-relaxed">
                                                {t('system_settings.last_update')}: Feb 26, 2026 at 11:00 AM
                                            </p>
                                        </div>
                                    </div>
                                </motion.div>
                            ) : (
                                <motion.div
                                    key={view}
                                    initial={{ opacity: 0, x: 20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    className="flex flex-col h-full"
                                >
                                    {view === 'branch' && <BranchManagementView onBack={goBack} t={t} />}
                                    {view === 'localization' && <LocalizationView onBack={goBack} t={t} />}
                                    {view === 'dashboard-layout' && <DashboardLayoutView onBack={goBack} t={t} />}
                                    {view === 'mobile-app' && <MobileAppView onBack={goBack} t={t} />}
                                    {view === 'security-audit' && <SecurityAuditView onBack={goBack} t={t} />}
                                    {view === 'version-info' && <VersionInfoView onBack={goBack} t={t} />}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};
