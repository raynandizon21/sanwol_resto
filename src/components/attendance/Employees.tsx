import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  Search,
  RefreshCw,
  Fingerprint,
  ScanFace,
  CreditCard,
  KeyRound,
  Hand,
  Plus,
  Clock,
  XCircle,
  Trash2,
  UserPlus,
  Pencil,
  Eye,
  AlertTriangle,
} from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { SkeletonTable } from '../ui/Skeleton';
import { type Branch } from '../partials/Header';
import {
  cancelUserCommand,
  getDeviceUsers,
  getPendingDeviceUsers,
  getZkDevices,
  type DeviceUser,
  type PendingDeviceUser,
  type ZkDevice,
} from '../../services/zktecoService';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import { cn } from '../../lib/utils';
import { AddDeviceUserPanel } from './AddDeviceUserPanel';
import { EnrollFingerprintDialog, fingerLabel, type EnrollTarget } from './EnrollFingerprintDialog';
import { RemoveDeviceUserDialog } from './RemoveDeviceUserDialog';
import { EmployeePanel } from './EmployeePanel';
import {
  DeviceStatusCards,
  LiveBadge,
  ShowDeletedToggle,
  StateTag,
  formatDeviceDateTime,
  isDeviceAdmin,
  useZkLiveReload,
} from './zktecoShared';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';

/** "Add again": the removed user, with their saved profile to show in the form. */
type AddPrefill = NonNullable<React.ComponentProps<typeof AddDeviceUserPanel>['prefill']>;

interface EmployeesProps {
  selectedBranch: Branch | null;
}

// Fingers named in the Fingerprints column; more show as "+N" (all of them on hover).
const FINGERS_SHOWN = 2;

/**
 * A table row: the device user plus flat copies of the profile fields shown as columns, so the
 * table can sort them. null = not filled in (blanks sort last).
 */
type EmployeeRow = DeviceUser & {
  position: string | null;
  contactNo: string | null;
  dateHired: string | null;
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymdOrNull = (v: string | null | undefined) => (v && YMD_RE.test(v) ? v : null);

/** Whole months from one YYYY-MM-DD to another (a month counts once its day of the month is reached). */
const monthsBetween = (from: string, to: string) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
};

/** Length of service, e.g. "1 yr 8 mo", from `start` to `end` (both YYYY-MM-DD). */
const tenureLabel = (t: TFunction, start: string, end: string) => {
  if (start > end) return t('attendance.tenure_not_started', 'Not started yet');
  const months = monthsBetween(start, end);
  if (months < 1) return t('attendance.tenure_under_month', 'Under 1 mo');
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y) return t('attendance.tenure_months', { m, defaultValue: `${m} mo` });
  if (!m) return t('attendance.tenure_years', { y, defaultValue: `${y} yr` });
  return t('attendance.tenure_years_months', { y, m, defaultValue: `${y} yr ${m} mo` });
};

const actionButton =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/15 transition-colors';
// Same icon buttons as the Attendance Logs rows.
const iconButton =
  'p-2 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors disabled:opacity-40';

/**
 * The restaurant's employees: everyone registered on the MB160 (as the device reports them),
 * each with an app-only profile (docs/attendance.md). Adding and removing
 * people goes through the device. Removed people are kept (soft delete) and listed with
 * "Show deleted", with their profile and attendance history.
 */
export const Employees: React.FC<EmployeesProps> = ({ selectedBranch }) => {
  const { t } = useTranslation();
  const branchId = selectedBranch?.id ?? 'all';
  const isAllBranches = String(branchId) === 'all';

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();
  const punchPermissions = {
    canAdd: canCreate('attendance_logs'),
    canEdit: canUpdate('attendance_logs'),
    canDelete: canDelete('attendance_logs'),
  };
  // Same rule as the server: Add (to enroll right after adding) or Edit on Device Users.
  // Card registration uses the same rule, though it happens at the device itself.
  const canEnroll = canCreate('device_users') || canUpdate('device_users');
  const canAdd = canCreate('device_users');
  const canEditDetails = canUpdate('device_users');
  const canRemove = canDelete('device_users');
  const [enrollTarget, setEnrollTarget] = useState<EnrollTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<DeviceUser | null>(null);
  // Which person the panel shows (device_users id); the row is read from the live list on each render.
  const [editId, setEditId] = useState<number | null>(null);
  const [addPrefill, setAddPrefill] = useState<AddPrefill | null>(null);
  // Active users, plus removed ones while "Show deleted" is on.
  const [users, setUsers] = useState<DeviceUser[]>([]);
  const [pending, setPending] = useState<PendingDeviceUser[]>([]);
  const [devices, setDevices] = useState<ZkDevice[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [switching, setSwitching] = useState(false);
  const loadedBranch = useRef<typeof branchId | null>(null);

  // silent: background reload (no skeleton, errors ignored). keepTable: no skeleton, errors shown.
  const load = useCallback(
    async (silent = false, keepTable = silent) => {
      if (!keepTable) setLoading(true);
      setRefreshing(true);
      try {
        const [nextUsers, nextPending, nextDevices] = await Promise.all([
          getDeviceUsers(branchId, { includeDeleted: showDeleted }),
          getPendingDeviceUsers(branchId),
          getZkDevices(branchId),
        ]);
        setUsers(nextUsers);
        setPending(nextPending);
        setDevices(nextDevices);
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [branchId, showDeleted],
  );

  // Skeleton only for the first load and branch changes; toggling "Show deleted" keeps the
  // current table on screen (dimmed) until the new list arrives.
  useEffect(() => {
    const sameBranch = loadedBranch.current === branchId;
    loadedBranch.current = branchId;
    if (!sameBranch) {
      void load();
      return;
    }
    setSwitching(true);
    void load(false, true).finally(() => setSwitching(false));
  }, [load, branchId]);
  // Users enrolled/deleted on the device, and pushes the device confirms, show up right away.
  const live = useZkLiveReload(branchId, ['users', 'commands', 'device'], () => void load(true));

  // Everything below that counts or looks users up uses active users only: a removed user's
  // PIN may already belong to someone else.
  const activeUsers = useMemo(() => users.filter((u) => u.active), [users]);

  /** 'edit' | 'delete' when a change for this user is still waiting for the device. */
  const pendingChange = (u: DeviceUser): 'edit' | 'delete' | null =>
    pending.find(
      (p) => p.kind !== 'add' && p.status !== 'failed' && p.deviceId === u.deviceId && p.pin === u.pin,
    )?.kind as 'edit' | 'delete' | undefined ?? null;
  const isBeingRemoved = (u: DeviceUser) => pendingChange(u) === 'delete';
  const editUser = editId != null ? users.find((u) => u.id === editId) ?? null : null;

  // The server refuses to remove the last admin (without one, anyone can open the device menu).
  const isLastAdmin = (u: DeviceUser) =>
    isDeviceAdmin(u.privilege) &&
    activeUsers.filter((o) => o.deviceId === u.deviceId && isDeviceAdmin(o.privilege) && !isBeingRemoved(o)).length <= 1;

  const rows = useMemo<EmployeeRow[]>(
    () =>
      users.map((u) => ({
        ...u,
        position: u.profile?.position.trim() || null,
        contactNo: u.profile?.contactNo.trim() || null,
        dateHired: ymdOrNull(u.profile?.dateStarted),
      })),
    [users],
  );

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    // Contact numbers also match by digits only ("09171234567" finds "0917 123 4567").
    const digits = q.replace(/\D/g, '');
    return rows.filter(
      (u) =>
        [u.name ?? '', u.profile?.fullName ?? '', u.position ?? '', u.contactNo ?? ''].some((v) =>
          v.toLowerCase().includes(q),
        ) ||
        (digits.length >= 3 && (u.contactNo ?? '').replace(/\D/g, '').includes(digits)),
    );
  }, [rows, searchQuery]);

  const isDeviceOnline = (deviceId: number) => devices.find((d) => d.id === deviceId)?.isOnline ?? false;

  const openAdd = (prefill: AddPrefill | null) => {
    setAddPrefill(prefill);
    setIsAddOpen(true);
  };

  const cancelPending = async (p: PendingDeviceUser) => {
    try {
      await cancelUserCommand(branchId, p.commandId);
      toast.success(t('attendance.pending_cancelled', 'Cancelled'));
      void load(true);
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.pending_cancel_failed', 'Could not cancel'));
    }
  };

  // The cards count staff only (not people excluded from schedules and attendance).
  const staffUsers = activeUsers.filter((u) => !u.profile?.excludeFromAttendance);
  // Staff punch with fingerprints, so these people can't punch yet.
  const needFingerprintCount = staffUsers.filter((u) => u.fingers.length === 0).length;
  const today = getManilaTodayYmd();

  const dim = (u: DeviceUser) => (u.active ? '' : 'opacity-50');

  /** Tooltip for a removed user: when, and by whom (or on the device). */
  const removedNote = (u: DeviceUser) => {
    const when = u.removedDt ? formatDeviceDateTime(u.removedDt) : null;
    const whenText = when ? `${when.date} ${when.time}` : '—';
    return u.removedBy
      ? t('attendance.removed_by', { who: u.removedBy, when: whenText, defaultValue: `Removed by ${u.removedBy} on ${whenText}` })
      : t('attendance.removed_on_device', { when: whenText, defaultValue: `Removed on the device (noticed ${whenText})` });
  };

  const columns: ColumnDef<EmployeeRow>[] = [
    {
      header: t('attendance.name', 'Name'),
      accessorKey: 'name',
      sortable: true,
      render: (u) => {
        const fullName = u.profile?.fullName || u.name || '—';
        const sub = [
          u.name && u.name !== fullName ? t('attendance.on_device_as', { name: u.name, defaultValue: `On device: ${u.name}` }) : null,
        ].filter(Boolean);
        return (
        <div className="flex items-center gap-2">
          <div className={cn('flex flex-col', dim(u))}>
            <span className="text-sm font-bold text-brand-text">{fullName}</span>
            {sub.length > 0 && <span className="text-xs text-brand-muted font-medium">{sub.join(' · ')}</span>}
          </div>
          {u.profile?.excludeFromAttendance && (
            <StateTag
              tone="gray"
              label={t('attendance.tag_excluded', 'Excluded')}
              title={t('attendance.tag_excluded_hint', 'Excluded from schedules and attendance (Profile). For a system or IT account.')}
            />
          )}
          {u.active && isDeviceAdmin(u.privilege) && (
            <StateTag
              tone="primary"
              label={t('attendance.tag_device_admin', 'Device admin')}
              title={t(
                'attendance.device_admin_hint',
                "Can open the device's menu. Admins are made on the MB160, and its last admin can't be removed.",
              )}
            />
          )}
          {!u.active && <StateTag tone="red" label={t('attendance.tag_removed', 'Removed')} title={removedNote(u)} />}
          {u.active && pendingChange(u) === 'delete' && <StateTag tone="orange" label={t('attendance.tag_removing', 'Removing…')} />}
          {u.active && pendingChange(u) === 'edit' && <StateTag tone="orange" label={t('attendance.tag_updating', 'Updating…')} />}
        </div>
        );
      },
    },
    {
      header: t('attendance.position', 'Position'),
      accessorKey: 'position',
      sortable: true,
      render: (u) => (
        <span className={cn('text-sm font-medium', u.position ? 'text-brand-text' : 'text-brand-muted', dim(u))}>
          {u.position ?? '—'}
        </span>
      ),
    },
    {
      header: t('attendance.contact_no', 'Contact no.'),
      render: (u) => (
        <span className={cn('text-sm font-medium tabular-nums whitespace-nowrap', !u.contactNo && 'text-brand-muted', dim(u))}>
          {u.contactNo ?? '—'}
        </span>
      ),
    },
    {
      // Length of service underneath, up to their last day when one is saved (or, for someone
      // removed without one, the day they were removed).
      header: t('attendance.date_hired', 'Date hired'),
      accessorKey: 'dateHired',
      sortable: true,
      render: (u) => {
        const lastDay = ymdOrNull(u.profile?.dateSeparated);
        const removedDay = !u.active && u.removedDt ? u.removedDt.slice(0, 10) : null;
        const end = [today, lastDay, removedDay].filter((d): d is string => d != null).sort()[0];
        const lines = [
          u.dateHired ? tenureLabel(t, u.dateHired, end) : null,
          lastDay
            ? t('attendance.last_day_on', { date: formatYmdDisplay(lastDay), defaultValue: `Last day ${formatYmdDisplay(lastDay)}` })
            : null,
        ].filter(Boolean);
        return (
          <div className={cn('flex flex-col', dim(u))}>
            <span className={cn('text-sm font-medium tabular-nums whitespace-nowrap', !u.dateHired && 'text-brand-muted')}>
              {u.dateHired ? formatYmdDisplay(u.dateHired) : '—'}
            </span>
            {lines.length > 0 && <span className="text-xs text-brand-muted font-medium">{lines.join(' · ')}</span>}
          </div>
        );
      },
    },
    {
      // Staff punch with fingerprints. Anything else the user has on the device (set there, not in
      // the app) is listed underneath so it isn't missed.
      header: t('attendance.fingerprints_column', 'Fingerprints'),
      render: (u) => {
        // A removed user's fingerprints, face, card and password were erased with them.
        if (!u.active) return <span className="text-sm text-brand-muted opacity-50">—</span>;
        const others = [
          u.hasFace && { key: 'face', icon: ScanFace, label: t('attendance.verify_face', 'Face') },
          u.palms > 0 && { key: 'palm', icon: Hand, label: t('attendance.verify_palm', 'Palm') },
          u.hasCard && { key: 'card', icon: CreditCard, label: t('attendance.verify_card', 'Card') },
          u.hasPassword && { key: 'pw', icon: KeyRound, label: t('attendance.verify_password', 'Password') },
        ].filter((m): m is { key: string; icon: typeof ScanFace; label: string } => Boolean(m));
        return (
          <div className="flex flex-col items-start gap-1">
            {/* Which fingers, in the device's order (left hand, then right): up to two, then "+N"
                with all of them on hover. */}
            {u.fingers.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1" title={u.fingers.map((fid) => fingerLabel(t, fid)).join(', ')}>
                {u.fingers
                  .slice(0, FINGERS_SHOWN)
                  .map((fid) => (
                    <span
                      key={fid}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-gray-50 text-xs font-bold text-brand-text whitespace-nowrap"
                    >
                      <Fingerprint size={13} className="text-brand-primary" />
                      {fingerLabel(t, fid)}
                    </span>
                  ))}
                {u.fingers.length > FINGERS_SHOWN && (
                  <span className="px-2 py-1 rounded-lg bg-gray-50 text-xs font-bold text-brand-muted tabular-nums">
                    +{u.fingers.length - FINGERS_SHOWN}
                  </span>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-orange-50 text-xs font-bold text-orange-700">
                <AlertTriangle size={13} />
                {t('attendance.fingerprints_none', 'None')}
              </span>
            )}
            {others.length > 0 && (
              <span
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium text-brand-muted"
                title={t('attendance.other_methods_hint', 'Also set on the device; manage these on the MB160.')}
              >
                {t('attendance.also_on_device', 'Also:')}
                {others.map(({ key, icon: Icon, label }) => (
                  <span key={key} className="inline-flex items-center gap-0.5">
                    <Icon size={11} />
                    {label}
                  </span>
                ))}
              </span>
            )}
          </div>
        );
      },
    },
    // There's one device (the MB160), so no Device column; with All Branches, show whose it is.
    ...(isAllBranches
      ? [
          {
            header: t('employee.branch', 'Branch'),
            render: (u: DeviceUser) => (
              <span className={cn('text-sm font-medium', dim(u))}>
                {u.branchName || t('attendance.unassigned_branch', 'No branch')}
              </span>
            ),
          },
        ]
      : []),
    {
            header: t('employee.action', 'Action'),
            className: 'text-right',
            render: (u: DeviceUser) => {
              if (!u.active) {
                return (
                  <div className="flex justify-end items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditId(u.id)}
                      className={iconButton}
                      title={t('attendance.view_employee', 'View profile and attendance')}
                      aria-label={t('attendance.view_employee', 'View profile and attendance')}
                    >
                      <Eye size={16} />
                    </button>
                    {canAdd && (
                    <button
                      type="button"
                      onClick={() =>
                        openAdd({ userId: u.id, deviceId: u.deviceId, name: u.name ?? '', pin: u.pin, profile: u.profile ?? null })
                      }
                      className={actionButton}
                      title={t('attendance.add_again_hint', 'Add this person to the device again as a new user')}
                    >
                      <UserPlus size={14} />
                      {t('attendance.add_again', 'Add again')}
                    </button>
                    )}
                  </div>
                );
              }
              const change = pendingChange(u);
              const lastAdmin = isLastAdmin(u);
              return (
                <div className="flex justify-end items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditId(u.id)}
                    className={iconButton}
                    title={t('attendance.edit_employee', 'Open employee')}
                    aria-label={t('attendance.edit_employee', 'Open employee')}
                  >
                    <Pencil size={16} />
                  </button>
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => setRemoveTarget(u)}
                      disabled={change != null || lastAdmin}
                      className={cn(iconButton, 'hover:text-red-600 hover:bg-red-50 disabled:hover:bg-transparent disabled:hover:text-brand-muted')}
                      title={
                        lastAdmin
                          ? t('attendance.remove_last_admin', "The device's only admin can't be removed. Make another user an admin on the device first.")
                          : t('attendance.remove_user_title', 'Remove from device')
                      }
                      aria-label={t('attendance.remove_user_title', 'Remove from device')}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              );
            },
    } satisfies ColumnDef<DeviceUser>,
  ];

  return (
    <div className="space-y-8 pt-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="space-y-8"
      >
        {!loading && <DeviceStatusCards devices={devices} showBranch={isAllBranches} />}

        <div className="flex items-center justify-between">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
            <input
              type="text"
              placeholder={t('attendance.employees_search_placeholder_v2', 'Search name, position or contact no.')}
              className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-96 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-4">
            <LiveBadge live={live} />
            <ShowDeletedToggle value={showDeleted} onChange={setShowDeleted} />
            <button
              type="button"
              onClick={() => void load(true)}
              className="bg-white text-brand-text px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={16} className={cn(refreshing && 'animate-spin')} />
              {t('attendance.refresh', 'Refresh')}
            </button>
            {canAdd && (
              <button
                type="button"
                onClick={() => openAdd(null)}
                disabled={loading || devices.length === 0}
                title={devices.length === 0 ? t('attendance.no_device_short', 'No attendance device for this branch') : undefined}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold text-sm shadow-lg shadow-brand-primary/30 transition-all disabled:opacity-50 disabled:shadow-none"
              >
                <Plus size={18} />
                {t('attendance.add_employee_button', 'Add employee')}
              </button>
            )}
          </div>
        </div>

        {pending.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
            <p className="text-sm font-bold text-brand-text">{t('attendance.pending_title', 'Sending to device')}</p>
            {pending.map((p) => {
              const canCancel =
                p.status === 'pending' && (p.kind === 'delete' ? canRemove : p.kind === 'edit' ? canEditDetails : canAdd);
              return (
                <div key={p.commandId} className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium">
                    <span className="text-brand-muted">
                      {p.kind === 'delete'
                        ? t('attendance.pending_remove', 'Remove')
                        : p.kind === 'edit'
                          ? t('attendance.pending_edit', 'Edit')
                          : t('attendance.pending_add', 'Add')}
                      :{' '}
                    </span>
                    <span className="font-bold text-brand-text">{p.name || '—'}</span>
                    {devices.length > 1 && <span className="text-brand-muted"> · {p.deviceName}</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    {p.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-600">
                        <XCircle size={13} />
                        {p.returnCode == null
                          ? t('attendance.push_no_answer', 'No answer from the device')
                          : t('attendance.push_failed', { code: p.returnCode, defaultValue: `Rejected by device (code ${p.returnCode})` })}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-orange-50 text-orange-600">
                        <Clock size={13} />
                        {p.status === 'sent'
                          ? t('attendance.push_sent', 'Delivered, waiting for confirmation')
                          : t('attendance.push_pending', 'Waiting for the device')}
                      </span>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        onClick={() => void cancelPending(p)}
                        className="px-2.5 py-1 rounded-full text-xs font-bold text-brand-muted bg-gray-100 hover:bg-gray-200"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('attendance.employees_count', 'Employees')}</p>
            <h3 className="text-3xl font-bold">{loading ? '—' : staffUsers.length}</h3>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm" title={t('attendance.need_fingerprint_hint', "No fingerprint enrolled yet, so they can't punch. Enroll one from their row (pencil, then the Device tab).")}>
            <p className="text-brand-muted text-sm font-medium mb-1">{t('attendance.need_fingerprint', 'Need fingerprint')}</p>
            <h3 className={cn('text-3xl font-bold', !loading && needFingerprintCount > 0 ? 'text-orange-600' : 'text-green-600')}>
              {loading ? '—' : needFingerprintCount}
            </h3>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">
            {t('attendance.employees_load_failed', 'Could not load employees.')} {error}
          </div>
        )}

        {loading ? (
          <SkeletonTable columns={8} rows={6} showToolbar={false} />
        ) : (
          <div className={cn('transition-opacity duration-200', switching && 'opacity-60 pointer-events-none')}>
            <DataTable data={filteredUsers} columns={columns} keyExtractor={(u) => String(u.id)} />
          </div>
        )}
      </motion.div>

      <AddDeviceUserPanel
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        branchId={branchId}
        devices={devices}
        prefill={addPrefill}
        onQueued={(added) => {
          void load(true);
          // Straight to fingerprint: the device adds the user, then prompts for the finger.
          if (canEnroll) {
            setEnrollTarget({ ...added, fingers: [], deviceOnline: isDeviceOnline(added.deviceId), justAdded: true });
          }
        }}
      />

      <EnrollFingerprintDialog
        target={enrollTarget}
        branchId={branchId}
        onClose={() => setEnrollTarget(null)}
        onChanged={() => void load(true)}
      />

      <EmployeePanel
        user={editUser}
        branchId={branchId}
        deviceOnline={editUser ? isDeviceOnline(editUser.deviceId) : false}
        canEditDetails={canEditDetails}
        punchPermissions={punchPermissions}
        canEnroll={canEnroll}
        hasPendingChange={editUser?.active ? pendingChange(editUser) != null : false}
        onClose={() => setEditId(null)}
        onSaved={() => void load(true)}
        // The enrollment dialog opens on top of the panel, which stays open behind it.
        onManageFingerprints={(u) =>
          setEnrollTarget({ deviceId: u.deviceId, pin: u.pin, name: u.name, fingers: u.fingers, deviceOnline: isDeviceOnline(u.deviceId) })
        }
      />

      <RemoveDeviceUserDialog
        user={removeTarget}
        branchId={branchId}
        deviceOnline={removeTarget ? isDeviceOnline(removeTarget.deviceId) : false}
        onClose={() => setRemoveTarget(null)}
        onQueued={() => void load(true)}
      />
    </div>
  );
};
