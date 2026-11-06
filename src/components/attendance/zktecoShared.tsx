import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Info } from 'lucide-react';
import { subscribeZkChanges, type ZkChangeType, type ZkDevice } from '../../services/zktecoService';
import { formatYmdDisplay, parseManilaLocalDateTimeToUtcMs } from '../../utils/manilaDateTime';
import { cn } from '../../lib/utils';

/**
 * Fallback re-fetch while the page is open. Changes arrive instantly over the live
 * stream; this only keeps the device's online/offline status current (going offline
 * produces no event) and covers a dropped stream.
 */
export const ZK_FALLBACK_REFRESH_MS = 60000;

/** Bursts (e.g. a sync sends dozens of templates) collapse into one re-fetch. */
const LIVE_RELOAD_DEBOUNCE_MS = 400;

// Codes as the MB160 (ZMM501-NF28VF-Ver3.0.2) sends them. Codes vary by firmware;
// unknown ones are shown as "Code N". See docs/zkteco-mb160.md.
const PUNCH_STATUS_KEYS: Record<number, [string, string]> = {
  0: ['attendance.status_check_in', 'Time-in'],
  1: ['attendance.status_check_out', 'Time-out'],
  2: ['attendance.status_break_out', 'Break-out'],
  3: ['attendance.status_break_in', 'Break-in'],
  4: ['attendance.status_ot_in', 'OT-in'],
  5: ['attendance.status_ot_out', 'OT-out'],
};

const VERIFY_TYPE_KEYS: Record<number, [string, string]> = {
  0: ['attendance.verify_password', 'Password'],
  1: ['attendance.verify_fingerprint', 'Fingerprint'],
  2: ['attendance.verify_card', 'Card'],
  3: ['attendance.verify_password', 'Password'],
  4: ['attendance.verify_card', 'Card'],
  15: ['attendance.verify_face', 'Face'],
  25: ['attendance.verify_palm', 'Palm'],
};

const codeLabel = (t: TFunction, code: number) => t('attendance.code_n', { code, defaultValue: `Code ${code}` });

/** null for "no status" (255 / not sent): the device's status key wasn't used. */
export const punchStatusLabel = (t: TFunction, status: number | null): string | null => {
  if (status == null || status === 255) return null;
  const entry = PUNCH_STATUS_KEYS[status];
  return entry ? t(entry[0], entry[1]) : codeLabel(t, status);
};

export const verifyTypeLabel = (t: TFunction, verify: number | null): string => {
  if (verify == null) return '—';
  const entry = VERIFY_TYPE_KEYS[verify];
  return entry ? t(entry[0], entry[1]) : codeLabel(t, verify);
};

export const isDeviceAdmin = (privilege: number | null) => privilege === 14 || privilege === 6;

/** "YYYY-MM-DD HH:mm:ss" (device-local) -> { date: "Oct 23, 2026", time: "1:07:36 PM" }, no timezone conversion. */
export const formatDeviceDateTime = (dt: string | null | undefined): { date: string; time: string } => {
  const m = String(dt || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return { date: '—', time: '' };
  const hour = Number(m[2]);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return { date: formatYmdDisplay(m[1]), time: `${h12}:${m[3]}:${m[4]} ${hour < 12 ? 'AM' : 'PM'}` };
};

const relativeTime = (t: TFunction, dt: string | null): string => {
  if (!dt) return t('attendance.never', 'Never');
  const ms = parseManilaLocalDateTimeToUtcMs(dt.slice(0, 19));
  if (ms == null) return dt;
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return t('attendance.seconds_ago', { count: seconds, defaultValue: `${seconds}s ago` });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('attendance.minutes_ago', { count: minutes, defaultValue: `${minutes} min ago` });
  const { date, time } = formatDeviceDateTime(dt);
  return `${date} ${time}`;
};

export const DeviceStatusCards: React.FC<{ devices: ZkDevice[]; showBranch: boolean }> = ({
  devices,
  showBranch,
}) => {
  const { t } = useTranslation();

  if (devices.length === 0) {
    return (
      <div className="flex items-center gap-2 bg-brand-primary/5 border border-brand-primary/20 text-brand-primary rounded-xl px-4 py-3 text-sm font-medium">
        <Info size={16} className="shrink-0" />
        {t(
          'attendance.no_device_notice',
          'No attendance device has connected for this branch yet. Data appears here as soon as the MB160 sends it.',
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-4">
      {devices.map((device) => (
        <div
          key={device.id}
          className="bg-white px-5 py-4 rounded-2xl shadow-sm flex items-center gap-4 min-w-[280px] flex-1"
        >
          <span
            className={cn(
              'w-2.5 h-2.5 rounded-full shrink-0',
              device.isOnline ? 'bg-green-500 shadow-[0_0_0_4px_rgba(34,197,94,0.15)]' : 'bg-gray-300',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-brand-text">{device.name}</span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-xs font-bold',
                  device.isOnline ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-brand-muted',
                )}
              >
                {device.isOnline ? t('attendance.online', 'Online') : t('attendance.offline', 'Offline')}
              </span>
            </div>
            <p className="text-xs text-brand-muted font-medium mt-0.5 truncate">
              {device.serialNo}
              {showBranch && ` · ${device.branchName || t('attendance.unassigned_branch', 'No branch')}`}
              {` · ${t('attendance.last_seen', 'Last seen')} ${relativeTime(t, device.lastSeen)}`}
            </p>
          </div>
          <div className="flex gap-5 text-right shrink-0">
            <div>
              <p className="text-[11px] text-brand-muted font-medium">{t('attendance.users_on_device', 'Users on device')}</p>
              <p className="text-base font-bold tabular-nums">{device.deviceUserCount ?? '—'}</p>
            </div>
            <div>
              <p className="text-[11px] text-brand-muted font-medium">{t('attendance.punches_on_device', 'Punches on device')}</p>
              <p className="text-base font-bold tabular-nums">{device.devicePunchCount ?? '—'}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Calls `reload` as soon as the server reports one of `types` for this branch, plus a
 * slow fallback poll. Returns whether the live stream is connected.
 */
export function useZkLiveReload(
  branchId: string | number | null | undefined,
  types: ZkChangeType[],
  reload: () => void,
): boolean {
  const [live, setLive] = React.useState(false);
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  const typesKey = types.join(',');

  React.useEffect(() => {
    const wanted = new Set(typesKey.split(','));
    let timer: number | undefined;
    const unsubscribe = subscribeZkChanges(
      branchId,
      (type) => {
        if (!wanted.has(type)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => reloadRef.current(), LIVE_RELOAD_DEBOUNCE_MS);
      },
      setLive,
    );
    const poll = window.setInterval(() => {
      if (!document.hidden) reloadRef.current();
    }, ZK_FALLBACK_REFRESH_MS);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      window.clearInterval(poll);
      setLive(false);
    };
  }, [branchId, typesKey]);

  return live;
}

/** "Live" badge next to Refresh: green when changes stream in, gray while reconnecting. */
export const LiveBadge: React.FC<{ live: boolean }> = ({ live }) => {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-bold',
        live ? 'text-green-600' : 'text-brand-muted',
      )}
      title={
        live
          ? t('attendance.live_tooltip', 'New punches and users appear automatically')
          : t('attendance.reconnecting_tooltip', 'Reconnecting… the page still refreshes every minute')
      }
    >
      <span className={cn('w-2 h-2 rounded-full', live ? 'bg-green-500 animate-pulse' : 'bg-gray-300')} />
      {live ? t('attendance.live', 'Live') : t('attendance.reconnecting', 'Reconnecting')}
    </span>
  );
};

/** "Show deleted" switch next to Refresh: lists removed users / deleted punches, greyed out. */
export const ShowDeletedToggle: React.FC<{ value: boolean; onChange: (value: boolean) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={cn(
        'px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-colors',
        value ? 'bg-brand-primary/10 text-brand-primary' : 'bg-white text-brand-text hover:bg-gray-50',
      )}
    >
      <span className={cn('relative h-4 w-7 rounded-full transition-colors', value ? 'bg-brand-primary' : 'bg-gray-300')}>
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
            value ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
      {t('attendance.show_deleted', 'Show deleted')}
    </button>
  );
};

/** Small grey tag (e.g. "Deleted", "Edited", "Removed"), with the details in its tooltip. */
export const StateTag: React.FC<{ label: string; title?: string; tone?: 'gray' | 'orange' | 'red' | 'primary' }> = ({
  label,
  title,
  tone = 'gray',
}) => (
  <span
    title={title}
    className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap',
      tone === 'orange' && 'bg-orange-50 text-orange-600',
      tone === 'red' && 'bg-red-50 text-red-600',
      tone === 'gray' && 'bg-gray-100 text-brand-muted',
      tone === 'primary' && 'bg-brand-primary/10 text-brand-primary',
      title && 'cursor-help',
    )}
  >
    {label}
  </span>
);
