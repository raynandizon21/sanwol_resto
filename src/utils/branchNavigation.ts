import type { Branch } from '../components/partials/Header';

export function navigateToBranch(
  branch: Branch,
  opts?: { newTab?: boolean; newWindow?: boolean },
) {
  const url = new URL(window.location.href);
  url.searchParams.set('branchId', String(branch.id));
  url.searchParams.set('branchName', branch.name);
  try {
    localStorage.setItem('lastSelectedBranchId', String(branch.id));
    localStorage.setItem('lastSelectedBranchName', String(branch.name || ''));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
  if (opts?.newWindow) {
    // Width/height features force a real popup window (not a browser tab).
    const width = Math.min(1280, Math.floor(window.screen.availWidth * 0.9));
    const height = Math.min(900, Math.floor(window.screen.availHeight * 0.9));
    const left = Math.max(0, Math.floor((window.screen.availWidth - width) / 2));
    const top = Math.max(0, Math.floor((window.screen.availHeight - height) / 2));
    window.open(
      url.toString(),
      '_blank',
      `noopener,noreferrer,width=${width},height=${height},left=${left},top=${top}`,
    );
  } else if (opts?.newTab) {
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  } else {
    window.history.pushState({}, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}
