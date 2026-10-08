/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, useCallback, useState, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ClipboardList,
  MessageSquare,
  Calendar,
  UtensilsCrossed,
  Package,
  Star,
  Search,
  Bell,
  Settings,
  ChevronDown,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  LogIn
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sidebar } from './components/partials/Sidebar';
import { Header } from './components/partials/Header';
import { Footer } from './components/partials/Footer';
import { DashboardSkeleton } from './components/dashboard/DashboardSkeleton';

const Dashboard = React.lazy(() =>
  import('./components/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const AdminDashboard = React.lazy(() =>
  import('./components/dashboard/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
import { Inventory } from './components/inventory/Inventory';
import { Categories } from './components/categories/Categories';
import { ExpensesMock } from './components/expenses/ExpensesMock';
import { Ingredients } from './components/ingredients/Ingredients';
import { Users } from './components/users/Users';
import { UserRole } from './components/users/UserRole';
import { UserAccess } from './components/users/UserAccess';
import { Branches } from './components/users/Branches';
import { Tables } from './components/users/Tables';
import { Menu } from './components/menu/Menu';
import { Orders } from './components/orders/Orders';
import { Billing } from './components/orders/Billing';
import { SalesAnalytics } from './components/analytics/SalesAnalytics';
import { MenuReport } from './components/analytics/MenuReport';
import { CategoryReport } from './components/analytics/CategoryReport';
import { PaymentReport } from './components/analytics/PaymentReport';
import { ReceiptReport } from './components/analytics/ReceiptReport';
import { AnalyticsAiAssistant } from './components/analytics/AnalyticsAiAssistant';
import { cn } from './lib/utils';

// Panels
import { NotificationPanel } from './components/panels/NotificationPanel';
import { SystemSettingsPanel } from './components/panels/SystemSettingsPanel';
import { AccountSettingsPanel } from './components/panels/AccountSettingsPanel';

// Types
import { type Branch } from './components/partials/Header';
import { getManilaMonthToDateRange, getManilaTodayYmd } from './utils/manilaDateTime';

/** Default MTD in Asia/Manila so all users share the same end date (not PC clock/TZ). */
const getDefaultDateRange = () => getManilaMonthToDateRange();


// --- Mock Data ---

const revenueData = [
  { name: 'Mar', income: 8000, expense: 5000 },
  { name: 'Apr', income: 10000, expense: 6000 },
  { name: 'May', income: 9000, expense: 7000 },
  { name: 'Jun', income: 12000, expense: 8000 },
  { name: 'Jul', income: 16580, expense: 9000 },
  { name: 'Aug', income: 11000, expense: 7000 },
  { name: 'Sep', income: 14000, expense: 8500 },
  { name: 'Oct', income: 13000, expense: 7500 },
];

// --- Components ---

const StatCard = ({ icon: Icon, label, value, trend, trendType }: { icon: any, label: string, value: string, trend: string, trendType: 'up' | 'down' }) => (
  <div className="bg-white p-5 rounded-2xl shadow-sm flex items-center gap-4 flex-1 min-w-[200px]">
    <div className="w-12 h-12 rounded-xl bg-brand-primary flex items-center justify-center text-white">
      <Icon size={24} />
    </div>
    <div>
      <p className="text-brand-muted text-sm font-medium mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <h3 className="text-2xl font-bold">{value}</h3>
        <span className={cn(
          "text-xs font-bold flex items-center gap-0.5",
          trendType === 'up' ? "text-green-500" : "text-red-500"
        )}>
          {trendType === 'up' ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
          {trend}
        </span>
      </div>
    </div>
  </div>
);

const TrendingMenuItem = ({ menu }: { menu: any, key?: any }) => (
  <div className="group cursor-pointer">
    <div className="relative mb-3 overflow-hidden rounded-2xl">
      <img
        src={menu.image}
        alt={menu.name}
        className="w-full aspect-[4/3] object-cover group-hover:scale-105 transition-transform duration-500"
        referrerPolicy="no-referrer"
      />
      <div className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-lg flex items-center gap-1 shadow-sm">
        <Star size={10} className="text-yellow-500 fill-yellow-500" />
        <span className="text-xs font-bold">{menu.rating}</span>
      </div>
    </div>
    <div className="flex items-start justify-between">
      <div>
        <h5 className="text-base font-bold group-hover:text-brand-primary transition-colors">{menu.name}</h5>
        <p className="text-xs text-brand-muted font-medium mb-2">{menu.category}</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-brand-muted">
            <Star size={12} />
            <span className="text-xs font-bold">{menu.rating}</span>
          </div>
          <div className="flex items-center gap-1.5 text-brand-muted">
            <ClipboardList size={12} />
            <span className="text-xs font-bold">{menu.orders}</span>
          </div>
        </div>
      </div>
      <p className="text-xl font-bold text-brand-primary">${menu.price.toFixed(2)}</p>
    </div>
  </div>
);

const VerticalCarousel = ({ items }: { items: any[] }) => {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % items.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [items.length]);

  return (
    <div className="relative h-full overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={index}
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -100, opacity: 0 }}
          transition={{
            type: "spring",
            stiffness: 300,
            damping: 30,
            opacity: { duration: 0.2 }
          }}
          className="space-y-6"
        >
          {/* Show 3 items starting from index, wrapping around */}
          {[...items, ...items, ...items].slice(index, index + 3).map((menu, i) => (
            <TrendingMenuItem key={`${menu.name}-${index}-${i}`} menu={menu} />
          ))}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

import { useUser } from './context/UserContext';
import { Toaster } from 'sonner';
import {
  isAdminDashboardUser,
  prefetchAdminDashboardBundle,
} from './utils/prefetchAdminDashboard';
import {
  prefetchBranchDashboardBundle,
  shouldPrefetchBranchDashboard,
} from './utils/prefetchBranchDashboard';
import {
  prefetchSalesAnalyticsBundle,
  resolveSalesAnalyticsBranchId,
} from './utils/prefetchSalesAnalytics';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isLoggedIn } = useUser();
  const location = useLocation();

  if (!isLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

const LoginView = () => {
  const navigate = useNavigate();
  const { login } = useUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      const result = await response.json();

      if (result.success) {
        login(result.data, result.tokens.accessToken);
        // Prefetch only the landing dashboard — sales/menu reports load on demand
        // to avoid a PyServer stampede right after login.
        if (isAdminDashboardUser(result.data?.permissions)) {
          prefetchAdminDashboardBundle();
          void import('./components/dashboard/AdminDashboard');
        } else if (shouldPrefetchBranchDashboard(result.data?.permissions, result.data?.branch_id)) {
          prefetchBranchDashboardBundle({ branchId: String(result.data.branch_id) });
          void import('./components/dashboard/Dashboard');
        } else {
          const salesBranchId = resolveSalesAnalyticsBranchId(result.data?.permissions, result.data?.branch_id);
          prefetchSalesAnalyticsBundle({ branchId: salesBranchId });
        }
        navigate('/dashboard');
      } else {
        setError(result.error || 'Invalid username or password');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError('Connection failed. Please check if the server is running.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-brand-bg">
      {/* Background Image Side */}
      <div
        className="hidden lg:block lg:w-2/3 h-full bg-cover bg-center"
        style={{ backgroundImage: `url('/login-bg.jpg')` }}
      >
      </div>

      {/* Login Panel Side */}
      <div className="w-full lg:w-1/3 h-full bg-white flex flex-col justify-center px-12 py-10 shadow-[-10px_0_30px_rgba(0,0,0,0.1)] z-10">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-sm mx-auto"
        >
          <div className="flex flex-col items-start mb-10">
            <div className="w-16 h-16 bg-brand-primary rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-brand-primary/30">
              <UtensilsCrossed size={32} className="text-white" />
            </div>
            <h2 className="text-4xl font-bold tracking-tight text-brand-text mb-2">Welcome Back</h2>
            <p className="text-brand-muted text-base">Please enter your details to sign in</p>
          </div>

          <form className="space-y-6" onSubmit={handleLogin}>
            {error && (
              <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                disabled={isLoading}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3.5 text-base focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400 disabled:opacity-50"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted ml-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                disabled={isLoading}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3.5 text-base focus:bg-white focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary/50 outline-none transition-all placeholder:text-gray-400 disabled:opacity-50"
              />
            </div>

            <div className="flex items-center justify-between text-sm pt-2">
              <label className="flex items-center gap-2 cursor-pointer group">
                <input type="checkbox" defaultChecked className="w-4 h-4 rounded border-gray-300 text-brand-primary focus:ring-brand-primary/20" />
                <span className="text-brand-muted group-hover:text-brand-text transition-colors">Remember me</span>
              </label>
              <a href="#" className="text-brand-primary font-bold hover:underline transition-all">Forgot password?</a>
            </div>

            <button
              disabled={isLoading}
              className="w-full bg-brand-primary text-white text-base font-bold py-4 rounded-xl shadow-lg shadow-brand-primary/30 hover:shadow-brand-primary/40 hover:-translate-y-0.5 transition-all active:scale-[0.98] mt-4 disabled:opacity-70 disabled:hover:translate-y-0"
            >
              {isLoading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-12 pt-8 border-t border-gray-100 text-center">
            <p className="text-sm text-brand-muted">
              Don't have an account? <a href="#" className="text-brand-primary font-bold hover:underline ml-1">Contact Support</a>
            </p>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isLoggedIn, syncSessionUser, logout, user } = useUser();
  const parseBranchFromSearch = (search: string): Branch | null => {
    const params = new URLSearchParams(search);
    const branchId = params.get('branchId');
    if (!branchId) return null;
    const branchName = params.get('branchName');
    return {
      id: branchId,
      name: branchName || (branchId === 'all' ? 'All Branches' : `Branch ${branchId}`),
    };
  };

  // Initial session check
  useEffect(() => {
    const checkSession = async () => {
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const response = await fetch('/api/me', {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          const result = await response.json();
          if (result.success && result.data) {
            // Keep in-memory user/session state in sync after hard refresh.
            syncSessionUser(result.data);
          } else {
            // Token invalid or expired
            logout();
          }
        } catch (err) {
          console.error('Session check failed:', err);
        }
      }
    };
    checkSession();
  }, [logout, syncSessionUser]);

  // Warm only the landing dashboard on session restore (avoid PyServer stampede).
  useEffect(() => {
    if (!isLoggedIn || !user) return;
    if (isAdminDashboardUser(user.permissions)) {
      prefetchAdminDashboardBundle();
      return;
    }
    if (shouldPrefetchBranchDashboard(user.permissions, user.branch_id)) {
      prefetchBranchDashboardBundle({ branchId: String(user.branch_id) });
      return;
    }
    const salesBranchId = resolveSalesAnalyticsBranchId(user.permissions, user.branch_id);
    prefetchSalesAnalyticsBundle({ branchId: salesBranchId });
  }, [isLoggedIn, user?.permissions, user?.branch_id]);

  // Panel States
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(() => parseBranchFromSearch(location.search));
  const [branchSidebarPermissions, setBranchSidebarPermissions] = useState<string[] | null>(null);
  const [inventoryCrumbById, setInventoryCrumbById] = useState<Record<string, string>>({});

  const handleInventoryCategoryResolved = useCallback((id: string, name: string) => {
    setInventoryCrumbById((prev) => ({ ...prev, [String(id)]: String(name) }));
  }, []);

  useEffect(() => {
    const resolved = parseBranchFromSearch(location.search);
    if (!resolved) return;
    setSelectedBranch((prev) => {
      if (prev && String(prev.id) === String(resolved.id) && prev.name === resolved.name) return prev;
      return resolved;
    });
  }, [location.search]);

  // Ensure we have a stable selectedBranch on hard refresh.
  // Without this, the app can briefly load reports without branch_id (showing mixed branches)
  // until Header finishes fetching branch list and calls onBranchChange.
  useEffect(() => {
    if (!isLoggedIn) return;
    const params = new URLSearchParams(location.search);
    const branchIdInUrl = params.get('branchId');
    if (branchIdInUrl) return;
    const savedId = (() => {
      try {
        return (localStorage.getItem('lastSelectedBranchId') || '').trim();
      } catch {
        return '';
      }
    })();
    const savedName = (() => {
      try {
        return (localStorage.getItem('lastSelectedBranchName') || '').trim();
      } catch {
        return '';
      }
    })();

    // Managers must always stay within their assigned branch.
    // Admins can restore last selected branch (savedId) on refresh.
    const isManager = Number(user?.permissions) === 3;
    const isAdmin = Number(user?.permissions) === 1;
    const preferredId = isAdmin
      ? 'all'
      : isManager
        ? (user?.branch_id ? String(user.branch_id) : '')
        : (savedId || (user?.branch_id ? String(user.branch_id) : ''));
    if (!preferredId) return;

    const userBranchName = (user as any)?.branch_name ? String((user as any).branch_name) : '';

    const next: Branch = {
      id: preferredId,
      // If we have a real branch label from previous selection, keep it stable on refresh.
      // Otherwise fall back to a placeholder until Header fetches the branch list and replaces it.
      name: isAdmin ? 'All Branches' : (userBranchName || savedName || `Branch ${preferredId}`),
    };
    setSelectedBranch(next);

    params.set('branchId', String(next.id));
    params.set('branchName', next.name);
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
  }, [isLoggedIn, user?.permissions, user?.branch_id, location.pathname, location.search, navigate]);

  // Guard: if a manager lands on a URL with a different branchId, force it back to their own.
  useEffect(() => {
    if (!isLoggedIn) return;
    const isManager = Number(user?.permissions) === 3;
    const userBranchId = user?.branch_id ? String(user.branch_id) : '';
    if (!isManager || !userBranchId) return;

    const params = new URLSearchParams(location.search);
    const branchIdInUrl = (params.get('branchId') || '').trim();
    if (!branchIdInUrl) return;
    if (String(branchIdInUrl) === userBranchId) return;

    // Clear any persisted "last selected branch" so it can't override later loads.
    try {
      localStorage.removeItem('lastSelectedBranchId');
      localStorage.removeItem('lastSelectedBranchName');
    } catch {
      // ignore
    }

    const userBranchName = (user as any)?.branch_name ? String((user as any).branch_name) : '';
    const next: Branch = { id: userBranchId, name: userBranchName || `Branch ${userBranchId}` };
    setSelectedBranch(next);
    params.set('branchId', userBranchId);
    params.set('branchName', next.name);
    const search = params.toString();
    navigate(`${location.pathname}${search ? `?${search}` : ''}`, { replace: true });
  }, [isLoggedIn, user?.permissions, user?.branch_id, location.pathname, location.search, navigate]);

  // Fetch sidebar permissions for selected branch (so sidebar shows only allowed items per branch)
  useEffect(() => {
    const branchId = selectedBranch?.id;
    if (branchId == null || branchId === 'all') {
      setBranchSidebarPermissions(null);
      return;
    }
    const token = localStorage.getItem('token');
    fetch(`/branch/${branchId}/sidebar-permissions`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
      .then((res) => res.json())
      .then((json) => {
        const list = json?.data?.features ?? json?.features;
        setBranchSidebarPermissions(Array.isArray(list) ? list : null);
      })
      .catch(() => setBranchSidebarPermissions(null));
  }, [selectedBranch?.id]);

  // Parse active tab from URL path
  const pathParts = location.pathname.split('/').filter(Boolean);
  const primaryPath = pathParts[0] || 'dashboard';

  // Create breadcrumb array
  const breadcrumbs = pathParts.map((part, idx) => {
    if (part === 'menu-management') return 'Menu Management';
    if (part === 'users') return 'User Management';
    if (part === 'branches') return 'Branch Management';
    if (part === 'sales-report') return 'Sales Report';
    if (part === 'info') return 'User Info';
    if (part === 'role') return 'User Role';
    if (part === 'access') return 'User Access';
    if (part === 'sales-analytics') return 'Sales Analytics';
    if (part === 'ai-assistant') return 'AI Sales Assistant';
    if (part === 'expenses-mock') return 'Expenses';
    if (primaryPath === 'inventory' && idx === 1) {
      const id = String(part);
      const fromNavState =
        (location.state as any)?.categoryName != null
          ? String((location.state as any).categoryName)
          : '';
      const fromMemory = inventoryCrumbById[id] || '';
      return (fromNavState || fromMemory || id).trim();
    }
    return part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
  });
  if (breadcrumbs.length === 0) breadcrumbs.push('Dashboard');

  const activeTab = breadcrumbs[breadcrumbs.length - 1];
  const displayActiveTab = activeTab;

  const [dateRange, setDateRange] = useState(getDefaultDateRange);
  const previousDateRangeBeforeFocusRef = useRef<{ start: string; end: string } | null>(null);
  const focusDateOverrideActiveRef = useRef(false);

  // Clamp accidental future end dates (wrong PC clock / picker) to Manila today.
  useEffect(() => {
    const today = getManilaTodayYmd();
    setDateRange((prev) => {
      if (!prev.end || prev.end <= today) return prev;
      const start = prev.start && prev.start <= today ? prev.start : today;
      return { start, end: today };
    });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const focusDate = (params.get('focus_date') || '').trim();
    const isFocusDate = /^\d{4}-\d{2}-\d{2}$/.test(focusDate);

    if (location.pathname === '/expenses' && isFocusDate) {
      setDateRange((prev) => {
        if (!focusDateOverrideActiveRef.current) {
          previousDateRangeBeforeFocusRef.current = prev;
          focusDateOverrideActiveRef.current = true;
        }
        if (prev.start === focusDate && prev.end === focusDate) return prev;
        return { start: focusDate, end: focusDate };
      });
      return;
    }

    if (location.pathname !== '/expenses' && focusDateOverrideActiveRef.current) {
      const previous = previousDateRangeBeforeFocusRef.current;
      focusDateOverrideActiveRef.current = false;
      previousDateRangeBeforeFocusRef.current = null;
      if (previous) setDateRange(previous);
    }
  }, [location.pathname, location.search]);

  // Dynamic data generation based on date range (simulated)
  // const getDynamicRevenueData = () => {
  //   const seed = dateRange.start.length + dateRange.end.length;
  //   return revenueData.map((item, idx) => ({
  //     ...item,
  //     income: Math.floor(item.income * (0.8 + (seed % 5) * 0.1) + (idx * 100)),
  //     expense: Math.floor(item.expense * (0.9 + (seed % 3) * 0.05))
  //   }));
  // };

  // const getDynamicStats = () => {
  //   const seed = dateRange.start.length + dateRange.end.length;
  //   return {
  //     orders: (48652 + (seed * 123)).toLocaleString(),
  //     customers: (1248 + (seed * 5)).toLocaleString(),
  //     revenue: `$${(215860 + (seed * 456)).toLocaleString()}`
  //   };
  // };

  // const dynamicStats = getDynamicStats();
  // const dynamicRevenueData = getDynamicRevenueData();

  const handleTabChange = (tab: string) => {
    const params = new URLSearchParams(location.search);
    params.delete('breakdown');
    params.delete('metric');
    params.delete('focus_date');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    switch (tab) {
      case 'User Info': navigate(`/users/info${suffix}`); break;
      case 'User Role': navigate(`/users/role${suffix}`); break;
      case 'User Access': navigate(`/users/access${suffix}`); break;
      case 'Branches': navigate(`/users/branches${suffix}`); break;
      case 'Tables': navigate(`/users/tables${suffix}`); break;
      case 'User Management': navigate(`/users/info${suffix}`); break;
      case 'Sales Analytics': navigate(`/sales-report/sales-analytics${suffix}`); break;
      case 'Menu Management': navigate(`/menu-management${suffix}`); break;
      case 'Menu': navigate(`/sales-report/menu${suffix}`); break;
      case 'Category': navigate(`/sales-report/category${suffix}`); break;
      case 'Payment type': navigate(`/sales-report/payment-type${suffix}`); break;
      case 'Receipt': navigate(`/sales-report/receipt${suffix}`); break;
      case 'AI Sales Assistant': navigate(`/sales-report/ai-assistant${suffix}`); break;
      case 'Expenses Mock': navigate(`/expenses-mock${suffix}`); break;
      case 'Ingredients': navigate(`/ingredients${suffix}`); break;
      default: navigate(`/${tab.toLowerCase()}${suffix}`);
    }
  };

  const isLoginPage = location.pathname === '/login';

  useEffect(() => {
    const appScroller = document.querySelector('[data-app-scroll-container]') as HTMLElement | null;
    // Use the existing app scroll container only to avoid scroll flicker.
    if (!appScroller) return;
    requestAnimationFrame(() => {
      appScroller.scrollTop = 0;
    });
  }, [location.pathname, location.search]);

  if (isLoginPage) {
    if (isLoggedIn) {
      return <Navigate to={`/dashboard${location.search || ''}`} replace />;
    }
    return (
      <>
        <Toaster position="top-right" richColors />
        <LoginView />
      </>
    );
  }

  return (
    <ProtectedRoute>
      <Toaster position="top-right" richColors />
      <div className="flex h-screen overflow-hidden bg-brand-bg">
        <Sidebar
          activeTab={displayActiveTab}
          onTabChange={handleTabChange}
          selectedBranch={selectedBranch}
          allowedFeatures={branchSidebarPermissions}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          <Header
            activeTab={displayActiveTab}
            breadcrumbs={breadcrumbs}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            onOpenNotifications={() => setIsNotificationOpen(true)}
            onOpenSystemSettings={() => setIsSystemSettingsOpen(true)}
            onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
            selectedBranch={selectedBranch}
            onBranchChange={setSelectedBranch}
          />

          <div className="flex-1 overflow-y-auto p-8 pt-0 custom-scrollbar" data-app-scroll-container>
            <AnimatePresence mode="wait">
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<Navigate to={`/dashboard${location.search || ''}`} replace />} />

                <Route path="/dashboard" element={
                  <motion.div
                    key={selectedBranch ? selectedBranch.id : 'initial'}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Suspense fallback={<div className="pt-6"><DashboardSkeleton /></div>}>
                      {selectedBranch && selectedBranch.id === 'all' ? (
                        <AdminDashboard
                          selectedBranch={selectedBranch}
                          dateRange={dateRange}
                          onDateRangeChange={setDateRange}
                        />
                      ) : (
                        <Dashboard
                          selectedBranch={selectedBranch}
                          dateRange={dateRange}
                        />
                      )}
                    </Suspense>
                  </motion.div>
                } />

                <Route path="/orders" element={
                  selectedBranch && String(selectedBranch.id) !== 'all' ? (
                    <Orders
                      key={selectedBranch.id}
                      selectedBranch={selectedBranch}
                      dateRange={dateRange}
                    />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                } />

                <Route path="/billing" element={
                  selectedBranch && String(selectedBranch.id) !== 'all' ? (
                    <Billing
                      key={selectedBranch.id}
                      selectedBranch={selectedBranch}
                      dateRange={dateRange}
                    />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                } />

                <Route path="/menu-management" element={
                  selectedBranch && String(selectedBranch.id) !== 'all' ? (
                    <Menu
                      key={selectedBranch.id}
                      selectedBranch={selectedBranch}
                    />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                } />

                <Route path="/menu" element={
                  selectedBranch && String(selectedBranch.id) !== 'all' ? (
                    <Menu
                      key={selectedBranch.id}
                      selectedBranch={selectedBranch}
                    />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                } />

                <Route path="/inventory" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Categories
                      selectedBranch={selectedBranch}
                      onCategoryClick={(category) => {
                        setInventoryCrumbById((prev) => ({ ...prev, [String(category.id)]: category.name }));
                        navigate(`/inventory/${category.id}${location.search || ''}`, { state: { categoryName: category.name } });
                      }}
                    />
                  </motion.div>
                } />

                <Route path="/users" element={<Navigate to="/users/info" replace />} />
                <Route path="/users/info" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Users />
                  </motion.div>
                } />

                <Route path="/users/role" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <UserRole />
                  </motion.div>
                } />

                <Route path="/users/access" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <UserAccess />
                  </motion.div>
                } />
                <Route path="/users/branches" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Branches />
                  </motion.div>
                } />

                <Route path="/users/tables" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Tables />
                  </motion.div>
                } />

                <Route path="/inventory/:categoryId" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Inventory
                      selectedBranch={selectedBranch}
                      onBack={() => navigate(`/inventory${location.search || ''}`)}
                      onCategoryResolved={handleInventoryCategoryResolved}
                    />
                  </motion.div>
                } />

                <Route path="/ingredients" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <Ingredients selectedBranch={selectedBranch} />
                  </motion.div>
                } />

                <Route path="/expenses" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <ExpensesMock selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />

                <Route path="/sales-report" element={<Navigate to={`/sales-report/sales-analytics${location.search || ''}`} replace />} />
                <Route path="/sales-report/sales-analytics" element={
                  <motion.div
                    key={selectedBranch ? selectedBranch.id : 'initial'}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <SalesAnalytics selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />
                <Route path="/sales-analytics" element={<Navigate to={`/sales-report/sales-analytics${location.search || ''}`} replace />} />
                <Route path="/sales-report/menu" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <MenuReport selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />
                <Route path="/sales-report/category" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <CategoryReport selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />
                <Route path="/sales-report/payment-type" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <PaymentReport selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />
                <Route path="/sales-report/receipt" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <ReceiptReport selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />
                <Route path="/sales-report/ai-assistant" element={
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <AnalyticsAiAssistant selectedBranch={selectedBranch} dateRange={dateRange} />
                  </motion.div>
                } />

                <Route path="*" element={
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center justify-center h-64 text-brand-muted"
                  >
                    {activeTab} content is coming soon...
                  </motion.div>
                } />
              </Routes>
            </AnimatePresence>
          </div>

          <Footer />
        </main>

        {/* Panels */}
        <NotificationPanel
          isOpen={isNotificationOpen}
          onClose={() => setIsNotificationOpen(false)}
        />
        <SystemSettingsPanel
          isOpen={isSystemSettingsOpen}
          onClose={() => setIsSystemSettingsOpen(false)}
        />
        <AccountSettingsPanel
          isOpen={isAccountSettingsOpen}
          onClose={() => setIsAccountSettingsOpen(false)}
        />
      </div>
    </ProtectedRoute>
  );
}
