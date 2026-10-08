import { toast } from 'sonner';

/**
 * Endpoints that are allowed to return 401 on their own terms (wrong password,
 * "not logged in yet" on initial load, etc.) — these already handle their own
 * 401 response and must NOT trigger a forced redirect here.
 */
const AUTH_ENDPOINTS = ['/api/login', '/api/me', '/api/refresh'];

let sessionExpiredHandled = false;

const isAuthEndpoint = (url: string): boolean => AUTH_ENDPOINTS.some((path) => url.includes(path));

/**
 * Patches the global fetch so that ANY authenticated request returning 401
 * (expired/invalid JWT or session) forces a re-login instead of surfacing a
 * raw "Authentication required..." error wherever that request happened to be
 * triggered from (e.g. Delete Expense). Install once, at app bootstrap.
 */
export function installAuthInterceptor(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);

    if (response.status === 401 && !sessionExpiredHandled) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input as Request).url;

      if (!isAuthEndpoint(url)) {
        sessionExpiredHandled = true;
        try {
          localStorage.removeItem('user');
          localStorage.removeItem('token');
          localStorage.removeItem('lastSelectedBranchId');
          localStorage.removeItem('lastSelectedBranchName');
        } catch {
          // localStorage unavailable — nothing more to clean up.
        }
        toast.error('Your session has expired. Please log in again.');
        window.setTimeout(() => {
          window.location.replace('/login');
        }, 600);
      }
    }

    return response;
  };
}
