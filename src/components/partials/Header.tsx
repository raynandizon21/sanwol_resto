import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Calendar, Bell, Settings, ChevronDown, MapPin, Globe, ArrowLeft, Check } from 'lucide-react';
import DatePicker from 'react-datepicker';
import { clsx } from 'clsx';

import { useUser } from '../../context/UserContext';
import { cn } from '../../lib/utils';
import { DEFAULT_ALL_BRANCHES_LOGO } from '../../utils/branchLogo';
import { navigateToBranch } from '../../utils/branchNavigation';
import {
  formatDateToLocalYmd,
  formatYmdDisplay,
  getManilaTodayYmd,
  parseYmdToLocalDate,
} from '../../utils/manilaDateTime';

type DateRange = {
  start: string;
  end: string;
};

export type Branch = {
  id: string | number;
  name: string;
  /** Relative path e.g. /uploads/branches/foo.webp — null if none uploaded */
  logo?: string | null;
  /** From branches.MENU_CATEGORY_LEVEL: 1 = single category list; 2 = main + subcategory */
  menuCategoryLevel?: 1 | 2;
};

type HeaderProps = {
  activeTab: string;
  breadcrumbs?: string[];
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  onOpenNotifications: () => void;
  onOpenSystemSettings: () => void;
  onOpenAccountSettings: () => void;
  selectedBranch: Branch | null;
  onBranchChange: (branch: Branch) => void;
};

const localeForLanguage = (lng: string) => {
  const base = String(lng || 'en').split('-')[0];
  if (base === 'ja') return 'ja-JP';
  if (base === 'ko') return 'ko-KR';
  if (base === 'zh') return 'zh-CN';
  return 'en-US';
};

const formatDate = (dateStr: string, lng: string) =>
  formatYmdDisplay(dateStr, localeForLanguage(lng));

const toDate = (s: string): Date | null => (s ? parseYmdToLocalDate(s) : null);

const toYYYYMMDD = (d: Date): string => formatDateToLocalYmd(d);

const getFullMonthRange = (monthDate: Date): [Date, Date] => {
  const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  // Cap "full month" end at Manila today so picking the current month cannot jump to a future day.
  const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
  const manilaToday = parseYmdToLocalDate(getManilaTodayYmd()) ?? new Date();
  const end = monthEnd.getTime() > manilaToday.getTime() ? manilaToday : monthEnd;
  return [start, end];
};

const DATE_PICKER_MONTHS_SHOWN = 3;

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  breadcrumbs = [],
  dateRange,
  onDateRangeChange,
  onOpenNotifications,
  onOpenSystemSettings,
  onOpenAccountSettings,
  selectedBranch,
  onBranchChange,
}) => {
  const { user } = useUser();
  const is3core = (user?.username || '').trim().toLowerCase() === '3coredev';
  const { t, i18n } = useTranslation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLanguagePanelOpen, setIsLanguagePanelOpen] = useState(false);

  const labelForTab = (tab: string) => {
    const keyByTab: Record<string, string> = {
      Dashboard: 'sidebar.dashboard',
      Expenses: 'sidebar.expenses',
      'Sales Report': 'sidebar.sales_report',
      'Sales Analytics': 'sidebar.sales_analytics',
      Menu: 'sidebar.menu',
      'Menu Management': 'sidebar.menu_management',
      Category: 'sidebar.category',
      'Payment type': 'sidebar.payment_type',
      Receipt: 'sidebar.receipt',
      'AI Sales Assistant': 'sidebar.ai_sales_assistant',
      Orders: 'sidebar.orders',
      Inventory: 'sidebar.inventory',
      'User Info': 'sidebar.user_info',
      'User Role': 'sidebar.user_role',
      'User Access': 'sidebar.user_access',
      'User Management': 'header.user_management',
    };

    if (tab.startsWith('User')) return t('header.user_management');
    const k = keyByTab[tab];
    return k ? t(k) : tab;
  };

  const subtitleForTab = (tab: string) => {
    if (tab === 'Dashboard') {
      return t('header.subtitle_dashboard', { name: user?.firstname || t('header.user') });
    }

    const keyByTab: Record<string, string> = {
      Orders: 'header.subtitle_orders',
      Menu: 'header.subtitle_menu',
      'Menu Management': 'header.subtitle_menu_management',
      Inventory: 'header.subtitle_inventory',
      'User Info': 'header.subtitle_user_info',
      'User Role': 'header.subtitle_user_role',
      'User Access': 'header.subtitle_user_access',
      Expenses: 'header.subtitle_expenses',
      'Sales Report': 'header.subtitle_sales_report',
      'Sales Analytics': 'header.subtitle_sales_analytics',
      Category: 'header.subtitle_category',
      'Payment type': 'header.subtitle_payment_type',
      Receipt: 'header.subtitle_receipt',
      'AI Sales Assistant': 'header.subtitle_ai_assistant',
      'User Management': 'header.subtitle_user_management',
    };

    if (tab.startsWith('User')) {
      return t('header.subtitle_user_management');
    }

    const key = keyByTab[tab];
    return key ? t(key) : t('header.subtitle_default', { tab: labelForTab(tab) });
  };

  const languages = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'ko', name: '한국어', flag: '🇰🇷' },
    { code: 'ja', name: '日本語', flag: '🇯🇵' },
    { code: 'zh', name: '中文', flag: '🇨🇳' },
  ];

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    document.cookie = `lang=${code}; path=/; max-age=${60 * 60 * 24 * 365}`;
    setIsLanguagePanelOpen(false);
  };

  const isAdmin = user?.permissions === 1;
  const isManager = user?.permissions === 3;

  useEffect(() => {
    const fetchBranches = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/branch', {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) {
          const json = await res.json();
          const data = (json.data ?? json).map((b: any) => ({
            id: b.IDNo,
            name: b.BRANCH_LABEL || b.BRANCH_NAME,
            logo: b.BRANCH_LOGO || null,
            menuCategoryLevel: Number(b.MENU_CATEGORY_LEVEL) === 2 ? 2 : 1,
          }));
          const userBranchId = user?.branch_id ? String(user.branch_id) : '';

          let branchOptions: Branch[] = [];

          if (isAdmin) {
            branchOptions = [
              { id: 'all', name: t('header.all_branches'), logo: DEFAULT_ALL_BRANCHES_LOGO },
              ...data,
            ];
          } else if (isManager) {
            // Managers (permission = 3) should only see their specific branch
            branchOptions = userBranchId
              ? data.filter((b: Branch) => String(b.id) === userBranchId)
              : [];
          } else {
            branchOptions = data;
          }

          setBranches(branchOptions);

          const params = new URLSearchParams(window.location.search);
          const branchIdFromUrl = params.get('branchId');
          const branchNameFromUrl = params.get('branchName');

          if (branchIdFromUrl) {
            // URL has branch — prefer full row from /branch list (includes menuCategoryLevel)
            const fromList = data.find((b: Branch) => String(b.id) === String(branchIdFromUrl));
            const urlBranch: Branch = fromList ?? {
              id: branchIdFromUrl,
              name: branchNameFromUrl?.replace(/\+/g, ' ') || (branchIdFromUrl === 'all' ? t('header.all_branches') : `Branch ${branchIdFromUrl}`),
              logo: branchIdFromUrl === 'all' ? DEFAULT_ALL_BRANCHES_LOGO : null,
              menuCategoryLevel: 1,
            };
            const matches =
              selectedBranch &&
              String(selectedBranch.id) === String(branchIdFromUrl);
            if (!matches) {
              onBranchChange(urlBranch);
            } else if (fromList && selectedBranch.logo !== fromList.logo) {
              onBranchChange(fromList);
            }
          } else if (!selectedBranch && branchOptions.length > 0) {
            // No branch in URL — set default by role
            if (isAdmin) {
              const allOption = branchOptions.find((b) => String(b.id) === 'all') || branchOptions[0];
              onBranchChange(allOption);
            } else {
              const resolved =
                userBranchId && userBranchId !== 'all'
                  ? branchOptions.find((b) => String(b.id) === userBranchId) || null
                  : null;
              const firstSpecific = branchOptions.find((b) => String(b.id) !== 'all') || null;
              onBranchChange(
                resolved ||
                  firstSpecific ||
                  branchOptions[0]
              );
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch branches:", error);
      }
    };

    fetchBranches();
  }, [onBranchChange, selectedBranch, t, user?.branch_id, user?.permissions]);

  const startDate = toDate(dateRange.start);
  const endDate = toDate(dateRange.end);
  const pickerValue: [Date | null, Date | null] = [startDate, endDate];

  const handleDateRangeChange = (
    update: [Date | null, Date | null] | null,
    options?: { closeOnComplete?: boolean }
  ) => {
    const [s, e] = update ?? [null, null];
    const manilaToday = getManilaTodayYmd();
    let start = s ? toYYYYMMDD(s) : '';
    let end = e ? toYYYYMMDD(e) : '';
    // Never let the global filter end past Manila today (avoids Jul 30 when today is Jul 29).
    if (end && end > manilaToday) end = manilaToday;
    if (start && end && start > end) start = end;
    onDateRangeChange({ start, end });
    const closeOnComplete = options?.closeOnComplete ?? true;
    if (closeOnComplete && s && e) setDropdownOpen(false);
  };

  const handleClose = () => setDropdownOpen(false);
  const showDateRangePicker =
    activeTab === 'Dashboard' ||
    activeTab === 'Expenses' ||
    activeTab === 'Orders' ||
    activeTab === 'Billing' ||
    activeTab === 'Sales Analytics' ||
    activeTab === 'Menu' ||
    activeTab === 'Category' ||
    activeTab === 'Payment type' ||
    activeTab === 'Receipt';
  // Prevent showing duplicated breadcrumbs like "User Management / User Management"
  const cleanedBreadcrumbs = breadcrumbs.filter(
    (crumb, idx) => idx === 0 || crumb !== breadcrumbs[idx - 1]
  );

  return (
    <>
      <header className="relative z-40 h-20 bg-brand-bg px-8 flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-3xl font-bold flex items-center gap-2">
            {cleanedBreadcrumbs.length > 0 ? (
              cleanedBreadcrumbs.map((crumb, idx) => (
                <React.Fragment key={idx}>
                  <span className={idx === cleanedBreadcrumbs.length - 1 ? "text-brand-text" : "text-brand-muted"}>
                    {labelForTab(crumb)}
                  </span>
                  {idx < cleanedBreadcrumbs.length - 1 && (
                    <span className="text-brand-muted text-xl mx-1">/</span>
                  )}
                </React.Fragment>
              ))
            ) : (
              labelForTab(activeTab)
            )}
          </h2>
          <p className="text-brand-muted text-sm mt-1">
            {subtitleForTab(activeTab)}
          </p>
        </div>

        <div className="flex items-center gap-6">
          {showDateRangePicker && (
            <div className="relative">
              <button
                onClick={() => setDropdownOpen((o) => !o)}
                className="flex items-center gap-3 bg-white px-5 py-2.5 rounded-xl shadow-sm border border-gray-100 hover:border-brand-primary/30 transition-all cursor-pointer"
              >
                <Calendar size={20} className="text-brand-muted" />
                <span className="text-sm text-brand-muted whitespace-nowrap">
                  {dateRange.start && dateRange.end
                    ? `${formatDate(dateRange.start, i18n.language)} - ${formatDate(dateRange.end, i18n.language)}`
                    : t('header.date_range')}
                </span>
                <ChevronDown
                  size={16}
                  className="text-brand-muted group-hover:text-brand-primary transition-colors"
                />
              </button>

              {dropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={handleClose}
                    aria-hidden
                  />
                  <div className="absolute top-full right-0 mt-2 z-50">
                    <div className="date-picker-multi-wrap">
                    <DatePicker
                      inline
                      selectsRange
                      monthsShown={DATE_PICKER_MONTHS_SHOWN}
                      showPreviousMonths
                      startDate={pickerValue[0]}
                      endDate={pickerValue[1]}
                      maxDate={parseYmdToLocalDate(getManilaTodayYmd()) ?? undefined}
                      openToDate={pickerValue[1] ?? pickerValue[0] ?? undefined}
                      onChange={(update) => handleDateRangeChange(update, { closeOnComplete: true })}
                      dateFormat="MMM d, yyyy"
                      calendarClassName="react-datepicker-material react-datepicker-material--multi"
                      isClearable
                      renderCustomHeader={({
                        monthDate,
                        decreaseMonth,
                        increaseMonth,
                        prevMonthButtonDisabled,
                        nextMonthButtonDisabled,
                        customHeaderCount,
                      }) => {
                        const monthLabel = monthDate.toLocaleDateString(localeForLanguage(i18n.language), {
                          month: 'long',
                          year: 'numeric',
                        });
                        const isFirstMonth = customHeaderCount === 0;
                        const isLastMonth = customHeaderCount === DATE_PICKER_MONTHS_SHOWN - 1;

                        return (
                          <div className="react-datepicker-multi-month-header flex items-center justify-between">
                            {isFirstMonth ? (
                              <button
                                type="button"
                                onClick={decreaseMonth}
                                disabled={prevMonthButtonDisabled}
                                className={cn(
                                  'rounded transition-colors shrink-0',
                                  prevMonthButtonDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 cursor-pointer'
                                )}
                                aria-label="Previous month"
                              >
                                <ArrowLeft size={14} className="text-brand-muted" />
                              </button>
                            ) : (
                              <span className="w-3 shrink-0" aria-hidden />
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                handleDateRangeChange(getFullMonthRange(monthDate), { closeOnComplete: true });
                              }}
                              className="react-datepicker-multi-month-title font-bold text-brand-text hover:text-brand-primary cursor-pointer transition-colors rounded hover:bg-gray-100 text-center leading-tight"
                              aria-label={`Select all of ${monthLabel}`}
                            >
                              {monthLabel}
                            </button>

                            {isLastMonth ? (
                              <button
                                type="button"
                                onClick={increaseMonth}
                                disabled={nextMonthButtonDisabled}
                                className={cn(
                                  'rounded transition-colors shrink-0',
                                  nextMonthButtonDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100 cursor-pointer'
                                )}
                                aria-label="Next month"
                              >
                                <ArrowLeft size={14} className="text-brand-muted rotate-180" />
                              </button>
                            ) : (
                              <span className="w-3 shrink-0" aria-hidden />
                            )}
                          </div>
                        );
                      }}
                    />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="relative">
            {isManager ? (
              <div className="flex items-center gap-3 bg-white px-4 py-2.5 rounded-xl shadow-sm border border-gray-100 w-64">
                <div className="flex items-center gap-2">
                  <MapPin size={20} className="text-brand-muted" />
                  <span className="text-sm text-brand-muted">
                    {selectedBranch
                      ? selectedBranch.name
                      : t('header.select_branch')}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setBranchDropdownOpen((o) => !o)}
                  className="flex items-center gap-3 bg-white px-4 py-2.5 rounded-xl shadow-sm border border-gray-100 hover:border-brand-primary/30 transition-all w-64 justify-between group cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <MapPin size={20} className="text-brand-muted" />
                    <span className="text-sm text-brand-muted">
                      {selectedBranch
                        ? (selectedBranch.id === 'all' ? t('header.all_branches') : selectedBranch.name)
                        : t('header.select_branch')}
                    </span>
                  </div>
                  <ChevronDown
                    size={16}
                    className={clsx(
                      'text-brand-muted group-hover:text-brand-primary transition-all duration-200',
                      branchDropdownOpen && 'rotate-180 text-brand-primary'
                    )}
                  />
                </button>

                {branchDropdownOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setBranchDropdownOpen(false)}
                      aria-hidden
                    />
                    <div className="absolute top-full left-0 mt-2 w-full bg-white rounded-xl shadow-xl border border-gray-100 z-50 overflow-hidden py-1">
                      {branches.map((branch) => (
                        <button
                          key={branch.id}
                          onClick={(e) => {
                            // Admin prefers opening each branch in a new tab (branch-to-branch comparison).
                            // Non-admin switches branch in-place; Ctrl/Cmd click still opens a new tab.
                            const hotkeyNewTab = (e as any)?.metaKey || (e as any)?.ctrlKey;
                            const shouldOpenNewTab = Boolean(isAdmin || hotkeyNewTab);

                            if (!shouldOpenNewTab) {
                              onBranchChange(branch);
                            }
                            navigateToBranch(branch, { newTab: shouldOpenNewTab });
                            setBranchDropdownOpen(false);
                          }}
                          className={clsx(
                            'w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-brand-primary/5 cursor-pointer',
                            selectedBranch?.id === branch.id
                              ? 'text-brand-muted bg-brand-primary/5'
                              : 'text-brand-text'
                          )}
                        >
                          {branch.id === 'all' ? t('header.all_branches') : branch.name}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsLanguagePanelOpen(true)}
              className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm text-brand-muted hover:text-brand-text transition-colors cursor-pointer"
            >
              <Globe size={20} />
            </button>
            <button
              onClick={onOpenNotifications}
              className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm text-brand-muted hover:text-brand-text transition-colors cursor-pointer"
            >
              <Bell size={20} />
            </button>
            {is3core && (
              <button
                onClick={onOpenSystemSettings}
                className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm text-brand-muted hover:text-brand-text transition-colors cursor-pointer"
              >
                <Settings size={20} />
              </button>
            )}
          </div>

          <div
            onClick={onOpenAccountSettings}
            className="flex items-center gap-3 pl-6 border-l border-gray-200 cursor-pointer group"
          >
            <div className="text-right">
              <p className="text-base font-bold group-hover:text-brand-primary transition-colors">
                {user ? `${user.firstname} ${user.lastname}` : t('header.user')}
              </p>
              <p className="text-xs text-brand-muted font-medium">
                {user?.permissions === 1
                  ? t('header.admin')
                  : user?.permissions === 3
                    ? t('header.manager', 'Manager')
                    : t('header.staff')}
              </p>
            </div>
            <img
              src={user?.avatar || 'https://picsum.photos/seed/user/100/100'}
              alt={t('header.profile')}
              className="w-10 h-10 rounded-xl object-cover border-2 border-white shadow-sm group-hover:border-brand-primary/20 transition-all"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      </header>

      <AnimatePresence>
        {isLanguagePanelOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsLanguagePanelOpen(false)}
              className="fixed inset-0 bg-black/20 z-[60]"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-[70] flex flex-col"
            >
              <div className="flex flex-col h-full">
                <div className="p-6 border-b border-gray-100">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setIsLanguagePanelOpen(false)}
                      className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-brand-muted cursor-pointer"
                    >
                      <ArrowLeft size={20} />
                    </button>
                    <h3 className="text-lg font-bold">{t('header.select_language')}</h3>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-2">
                  {languages.map((lang) => (
                    <button
                      key={lang.code}
                      onClick={() => handleLanguageChange(lang.code)}
                      className={cn(
                        "w-full flex items-center justify-between p-4 rounded-2xl transition-all cursor-pointer border",
                        i18n.language === lang.code
                          ? "bg-brand-orange/5 border-brand-orange/20 text-brand-orange"
                          : "bg-transparent border-transparent hover:bg-gray-50 text-brand-text"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <span className="text-2xl">{lang.flag}</span>
                        <span className="font-bold text-sm">{lang.name}</span>
                      </div>
                      {i18n.language === lang.code && <Check size={18} />}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};
