import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  ClipboardList,
  UtensilsCrossed,
  Package,
  BarChart3,
  Sparkles,
  Users,
  LogOut,
  ChevronDown,
  ChevronRight,
  Circle,
  DollarSign,
  CreditCard,
  FlaskConical,
} from 'lucide-react';
import { useUser } from '../../context/UserContext';
import { cn } from '../../lib/utils';
import { type Branch } from './Header';
import { SIDEBAR_FEATURES, type SidebarFeatureConfig } from '../../constants/sidebarFeatures';
import {
  prepareAllBranchesSidebarLogos,
  resolveBranchLogoUrl,
  resolveSidebarBranchLogo,
} from '../../utils/branchLogo';
import { navigateToBranch } from '../../utils/branchNavigation';

type SidebarProps = {
  activeTab: string;
  onTabChange: (tab: string) => void;
  selectedBranch: Branch | null;
  /** When set, only show sidebar items whose key is in this array (per-branch permissions from User Access). */
  allowedFeatures?: string[] | null;
};

type SidebarItemProps = {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  active?: boolean;
  badge?: number;
  onClick?: () => void;
  children?: React.ReactNode;
  isExpandable?: boolean;
  isExpanded?: boolean;
};

const SidebarItem: React.FC<SidebarItemProps> = ({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
  children,
  isExpandable,
  isExpanded,
}) => (
  <div className="w-full">
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center justify-between px-6 py-3 cursor-pointer transition-all group text-left relative',
        active
          ? 'text-brand-primary bg-brand-primary/5 after:content-[" "] after:absolute after:right-0 after:top-0 after:bottom-0 after:w-1 after:bg-brand-primary after:rounded-l-full'
          : 'text-brand-muted hover:text-brand-text hover:bg-gray-50/50',
      )}
    >
      <div className="flex items-center gap-3">
        <Icon
          size={20}
          className={cn(
            active ? 'text-brand-primary' : 'group-hover:text-brand-text transition-colors'
          )}
        />
        <span className={cn(
          "font-medium text-base",
          active ? "text-brand-primary" : "text-inherit"
        )}>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {badge && (
          <span className="bg-brand-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm">
            {badge}
          </span>
        )}
        {isExpandable && (
          <ChevronDown
            size={16}
            className={cn(
              "transition-transform duration-300",
              isExpanded ? "rotate-0" : "-rotate-90 opacity-40"
            )}
          />
        )}
      </div>
    </button>
    {isExpandable && (
      <div className={cn(
        "overflow-hidden transition-all duration-300 ease-in-out bg-gray-50/30",
        isExpanded ? "max-h-80 opacity-100 py-1" : "max-h-0 opacity-0"
      )}>
        {children}
      </div>
    )}
  </div>
);

const HEADER_TITLE_MAX_PX = 18;
const HEADER_TITLE_MIN_PX = 11;

const ALL_BRANCHES_LOGO_COLS = 3;
const ALL_BRANCHES_LOGO_GAP = 6;
const ALL_BRANCHES_LOGO_SIZE_FACTOR = 1;
const ALL_BRANCHES_LOGO_MIN = 28;
const ALL_BRANCHES_LOGO_MAX = 56;

const AllBranchLogoButton: React.FC<{
  branch: Branch;
  logoSize: number;
  children: React.ReactNode;
}> = ({ branch, logoSize, children }) => (
  <button
    type="button"
    title={branch.name}
    aria-label={branch.name}
    style={{ width: logoSize, height: logoSize }}
    onClick={() => navigateToBranch(branch, { newTab: true })}
    className={cn(
      'shrink-0 rounded-full p-0 border-0 bg-transparent cursor-pointer',
      'transition-transform hover:scale-105',
      'hover:ring-2 hover:ring-brand-primary/25',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
    )}
  >
    {children}
  </button>
);

const AllBranchesLogoRow: React.FC<{ branches: Branch[] }> = ({ branches }) => {
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const [logoSize, setLogoSize] = useState(40);
  const displayBranches = React.useMemo(
    () => prepareAllBranchesSidebarLogos(branches),
    [branches],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || displayBranches.length === 0) return;

    const fit = () => {
      const available = el.clientWidth;
      const gaps = ALL_BRANCHES_LOGO_GAP * (ALL_BRANCHES_LOGO_COLS - 1);
      const fitted = Math.floor((available - gaps) / ALL_BRANCHES_LOGO_COLS);
      const sized = Math.floor(fitted * ALL_BRANCHES_LOGO_SIZE_FACTOR);
      setLogoSize(
        Math.max(
          ALL_BRANCHES_LOGO_MIN,
          Math.min(ALL_BRANCHES_LOGO_MAX, sized),
        ),
      );
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayBranches.length]);

  const iconSize = Math.max(12, Math.round(logoSize * 0.45));

  const logoRows = React.useMemo(() => {
    const rows: Branch[][] = [];
    for (let i = 0; i < displayBranches.length; i += ALL_BRANCHES_LOGO_COLS) {
      rows.push(displayBranches.slice(i, i + ALL_BRANCHES_LOGO_COLS));
    }
    return rows;
  }, [displayBranches]);

  const renderBranchLogo = (branch: Branch) => {
    const id = String(branch.id);
    const url = resolveBranchLogoUrl(branch.logo);
    if (!url || failedIds.has(id)) {
      return (
        <AllBranchLogoButton key={id} branch={branch} logoSize={logoSize}>
          <span className="w-full h-full rounded-full bg-brand-primary/10 flex items-center justify-center">
            <UtensilsCrossed size={iconSize} className="text-brand-primary" />
          </span>
        </AllBranchLogoButton>
      );
    }
    return (
      <AllBranchLogoButton key={id} branch={branch} logoSize={logoSize}>
        <img
          src={url}
          alt={branch.name}
          className="w-full h-full object-contain pointer-events-none"
          onError={() =>
            setFailedIds((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            })
          }
        />
      </AllBranchLogoButton>
    );
  };

  if (displayBranches.length === 0) return null;

  return (
    <motion.div
      ref={containerRef}
      className="flex w-full flex-col"
      style={{ rowGap: ALL_BRANCHES_LOGO_GAP }}
    >
      {logoRows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className={cn(
            'w-full',
            row.length === ALL_BRANCHES_LOGO_COLS
              ? 'grid grid-cols-3 justify-items-center'
              : 'flex justify-center',
          )}
          style={{
            columnGap: ALL_BRANCHES_LOGO_GAP,
            gap: ALL_BRANCHES_LOGO_GAP,
          }}
        >
          {row.map((branch) => renderBranchLogo(branch))}
        </div>
      ))}
    </motion.div>
  );
};

const SidebarBranchTitle: React.FC<{ text: string }> = ({ text }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const title = titleRef.current;
    if (!container || !title) return;

    const fit = () => {
      let size = HEADER_TITLE_MAX_PX;
      title.style.fontSize = `${size}px`;
      while (title.scrollWidth > container.clientWidth && size > HEADER_TITLE_MIN_PX) {
        size -= 0.5;
        title.style.fontSize = `${size}px`;
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div ref={containerRef} className="min-w-0 w-full overflow-hidden">
      <h1
        ref={titleRef}
        className="font-black text-brand-text leading-tight whitespace-nowrap"
        title={text}
      >
        {text}
      </h1>
    </div>
  );
};

const SubItem: React.FC<{ label: string; active?: boolean; onClick?: () => void }> = ({ label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'w-full flex items-center gap-3 pl-14 pr-6 py-2 cursor-pointer transition-colors group text-left',
      active
        ? 'text-brand-primary'
        : 'text-brand-muted hover:text-brand-text',
    )}
  >
    <Circle
      size={6}
      className={cn(
        "fill-current transition-all",
        active ? "scale-125" : "opacity-30 group-hover:opacity-100"
      )}
    />
    <span className={cn(
      "text-sm font-medium",
      active ? "font-bold" : ""
    )}>{label}</span>
  </button>
);

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, selectedBranch, allowedFeatures }) => {
  // Menu tab is only visible when a specific branch is selected (not 'all' or null)
  const isSpecificBranch = selectedBranch != null && String(selectedBranch.id) !== 'all';
  const { logout, user } = useUser();
  const isAdmin = user?.permissions === 1;
  const { t } = useTranslation();
  const [userMgmtExpanded, setUserMgmtExpanded] = useState(false);
  const [salesReportExpanded, setSalesReportExpanded] = useState(false);
  const [branchLogoError, setBranchLogoError] = useState(false);
  const [allBranchesForLogos, setAllBranchesForLogos] = useState<Branch[]>([]);
  const sidebarLogoUrl = resolveSidebarBranchLogo(selectedBranch);
  const isAllBranches =
    !selectedBranch || String(selectedBranch.id) === 'all';
  const headerTitle = !selectedBranch
    ? '3CORE'
    : isAllBranches
      ? t('header.all_branches')
      : selectedBranch.name;
  const showHeaderLogo = Boolean(
    !isAllBranches && sidebarLogoUrl && !branchLogoError,
  );
  // When allowedFeatures is set (per-branch permissions), only show items in the list; otherwise show all for branch
  const hasFeature = (key: string) =>
    allowedFeatures == null ? true : allowedFeatures.includes(key);
  const salesReportFeature = SIDEBAR_FEATURES.find((f) => f.key === 'sales_report') ?? null;
  const salesReportTabs = (salesReportFeature?.children || [])
    .map((c) => c.tab)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const isSalesReportActive = salesReportTabs.includes(activeTab);
  const isAiAssistantActive = activeTab === 'AI Sales Assistant';

  const isUserMgmtActive =
    activeTab.startsWith('User') ||
    activeTab === 'Branch Management';

  useEffect(() => {
    setUserMgmtExpanded(isUserMgmtActive);
  }, [isUserMgmtActive]);
  useEffect(() => {
    setSalesReportExpanded(isSalesReportActive || isAiAssistantActive);
  }, [isSalesReportActive, isAiAssistantActive]);

  useEffect(() => {
    setBranchLogoError(false);
  }, [selectedBranch?.id, selectedBranch?.logo, sidebarLogoUrl]);

  useEffect(() => {
    if (!isAllBranches) {
      setAllBranchesForLogos([]);
      return;
    }
    let cancelled = false;
    const fetchBranches = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/branch', {
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const data = (json.data ?? json).map((b: { IDNo: string | number; BRANCH_LABEL?: string; BRANCH_NAME?: string; BRANCH_LOGO?: string | null }) => ({
          id: b.IDNo,
          name: b.BRANCH_LABEL || b.BRANCH_NAME || '',
          logo: b.BRANCH_LOGO || null,
        })) as Branch[];
        if (!cancelled) setAllBranchesForLogos(prepareAllBranchesSidebarLogos(data));
      } catch {
        if (!cancelled) setAllBranchesForLogos([]);
      }
    };
    fetchBranches();
    return () => {
      cancelled = true;
    };
  }, [isAllBranches]);

  const handleUserMgmtToggle = () => {
    setUserMgmtExpanded((prev) => {
      const next = !prev;
      if (next) setSalesReportExpanded(false);
      return next;
    });
  };
  const handleSalesReportToggle = () => {
    setSalesReportExpanded((prev) => {
      const next = !prev;
      if (next) setUserMgmtExpanded(false);
      return next;
    });
  };

  const iconMap: Record<string, SidebarItemProps['icon']> = {
    LayoutDashboard,
    BarChart3,
    DollarSign,
    Package,
    UtensilsCrossed,
    ClipboardList,
    CreditCard,
    FlaskConical,
    Users,
  };

  const getSidebarLabel = (item: SidebarFeatureConfig) =>
    item.i18nKey ? t(item.i18nKey, item.label) : item.label;

  const isItemVisible = (item: SidebarFeatureConfig) => {
    if (item.kind === 'admin-only') return false;
    if (item.requiresSpecificBranch && !isSpecificBranch) return false;
    if (item.kind === 'item') return hasFeature(item.key);
    if (item.kind === 'group') {
      const children = item.children || [];
      return children.some((c) => c.kind === 'item' && hasFeature(c.key));
    }
    return false;
  };

  return (
    <aside
      className={cn(
        'w-64 bg-white border-r border-gray-100 flex flex-col shrink-0 shadow-[4px_0_24px_rgba(0,0,0,0.02)]',
        isAllBranches ? 'pt-3 pb-8' : 'py-8',
      )}
    >
      <motion.div
        key={String(selectedBranch?.id ?? 'none')}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className={cn(
          'px-6 border-b border-gray-100',
          isAllBranches ? 'mb-3 pb-3' : 'mb-4 pb-4',
        )}
      >
        {isAllBranches ? (
          <>
            {allBranchesForLogos.length > 0 && (
              <AllBranchesLogoRow branches={allBranchesForLogos} />
            )}
            <motion.div
              className={cn(
                'min-w-0 w-full text-center',
                allBranchesForLogos.length > 0 && 'mt-3',
              )}
            >
              <SidebarBranchTitle text={headerTitle} />
              <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest mt-1 leading-tight">
                {t('sidebar.restaurant_pro')}
              </p>
            </motion.div>
          </>
        ) : (
        <motion.div className="flex items-center gap-3 min-w-0">
          {showHeaderLogo ? (
            <img
              src={sidebarLogoUrl!}
              alt=""
              className="w-16 h-16 shrink-0 object-contain"
              onError={() => setBranchLogoError(true)}
            />
          ) : (
            <div className="w-16 h-16 bg-brand-primary rounded-full flex items-center justify-center shadow-lg shadow-brand-primary/20 shrink-0">
              <UtensilsCrossed size={28} className="text-white" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <SidebarBranchTitle text={headerTitle} />
            <p className="text-[10px] font-bold text-brand-muted uppercase tracking-widest mt-1 leading-tight">
              {t('sidebar.restaurant_pro')}
            </p>
          </div>
        </motion.div>
        )}
      </motion.div>

      <nav className="flex-1 space-y-0.5">
        {SIDEBAR_FEATURES.filter(isItemVisible).map((item) => {
          if (item.kind === 'group' && item.key === 'sales_report') {
            const children = (item.children || []).filter(
              (c) => c.kind === 'item' && hasFeature(c.key),
            );
            const Icon = item.icon ? iconMap[item.icon] : BarChart3;
            return (
              <React.Fragment key={item.key}>
                <SidebarItem
                  icon={Icon}
                  label={getSidebarLabel(item)}
                  active={isSalesReportActive && !isAiAssistantActive}
                  isExpandable
                  isExpanded={salesReportExpanded}
                  onClick={handleSalesReportToggle}
                >
                  {children.map((child) => (
                    <SubItem
                      key={child.key}
                      label={getSidebarLabel(child)}
                      active={activeTab === child.tab}
                      onClick={() => {
                        if (child.tab) onTabChange(child.tab);
                      }}
                    />
                  ))}
                </SidebarItem>
                {isAdmin && !isSpecificBranch && (
                  <SidebarItem
                    icon={Sparkles}
                    label={t('sidebar.ai_sales_assistant')}
                    active={isAiAssistantActive}
                    onClick={() => {
                      setUserMgmtExpanded(false);
                      onTabChange('AI Sales Assistant');
                    }}
                  />
                )}
              </React.Fragment>
            );
          }

          const Icon = item.icon ? iconMap[item.icon] : LayoutDashboard;
          return (
            <SidebarItem
              key={item.key}
              icon={Icon}
              label={getSidebarLabel(item)}
              active={item.tab ? activeTab === item.tab : false}
              onClick={() => {
                if (item.tab) onTabChange(item.tab);
                setUserMgmtExpanded(false);
                setSalesReportExpanded(false);
              }}
            />
          );
        })}
        {isAdmin && !isSpecificBranch && (
          <SidebarItem
            icon={Users}
            label={t('sidebar.user_management')}
            active={isUserMgmtActive}
            isExpandable
            isExpanded={userMgmtExpanded}
            onClick={handleUserMgmtToggle}
          >
            <SubItem
              label={t('sidebar.user_info')}
              active={activeTab === 'User Info'}
              onClick={() => onTabChange('User Info')}
            />
            <SubItem
              label={t('sidebar.user_role')}
              active={activeTab === 'User Role'}
              onClick={() => onTabChange('User Role')}
            />
            <SubItem
              label={t('sidebar.control_panel_access', 'Control Panel')}
              active={activeTab === 'User Access'}
              onClick={() => onTabChange('User Access')}
            />
            <SubItem
              label={t('sidebar.branches')}
              active={activeTab === 'Branch Management'}
              onClick={() => onTabChange('Branches')}
            />
          </SidebarItem>
        )}
      </nav>

      <div className="mt-auto px-4">
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-6 py-4 text-brand-muted hover:text-red-500 hover:bg-red-50/50 rounded-2xl transition-all group border border-transparent hover:border-red-100"
        >
          <LogOut size={20} className="group-hover:rotate-12 transition-transform" />
          <span className="font-bold text-base">{t('sidebar.logout')}</span>
        </button>
      </div>
    </aside>
  );
};

