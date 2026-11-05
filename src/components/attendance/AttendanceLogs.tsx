import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Search, RefreshCw, Pencil, Trash2, RotateCcw, Plus, BarChart3, List } from 'lucide-react';
import { DataTable, type ColumnDef } from '../ui/DataTable';
import { SkeletonTable } from '../ui/Skeleton';
import { type Branch } from '../partials/Header';
import {
  getAttendanceLogs,
  getZkDevices,
  restoreAttendanceLog,
  type AttendanceLog,
  type ZkDevice,
} from '../../services/zktecoService';
import { useCrudPermissions } from '../../hooks/useCrudPermissions';
import { getManilaTodayYmd } from '../../utils/manilaDateTime';
import { cn } from '../../lib/utils';
import { EditPunchDialog, DeletePunchDialog, AddPunchDialog } from './PunchDialogs';
import { AttendanceSummary } from './AttendanceSummary';
import { TimesheetPanel } from './Timesheet';
import {
  DeviceStatusCards,
  LiveBadge,
  ShowDeletedToggle,
  StateTag,
  formatDeviceDateTime,
  punchStatusLabel,
  useZkLiveReload,
  verifyTypeLabel,
} from './zktecoShared';

// How long a punch that just arrived stays highlighted (the row-fresh animation in index.css is 4s).
const FRESH_PUNCH_MS = 4500;

interface AttendanceLogsProps {
  selectedBranch: Branch | null;
  dateRange: { start: string; end: string };
}

type View = 'summary' | 'punches';

/**
 * Two views of the header's date range: Summary (attendance computed from the punches, with
 * charts and per-person timesheets; docs/attendance.md) and Punches (the MB160's punches, newest
 * first). The device's raw punches are never changed: edits and deletes are corrections stored
 * separately (docs/zkteco-mb160.md), deletes can be undone, and forgotten punches are added as
 * manual punches.
 */
export const AttendanceLogs: React.FC<AttendanceLogsProps> = ({ selectedBranch, dateRange }) => {
  const { t } = useTranslation();
  const branchId = selectedBranch?.id ?? 'all';
  const isAllBranches = String(branchId) === 'all';

  const { canCreate, canUpdate, canDelete } = useCrudPermissions();
  const canAdd = canCreate('attendance_logs');
  const canEdit = canUpdate('attendance_logs');
  const canRemove = canDelete('attendance_logs');
  const [view, setView] = useState<View>('summary');
  const [timesheetFor, setTimesheetFor] = useState<{ employee: { employeeId: number; name: string | null; pin: string }; date?: string } | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);

  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  // Set when the range has more punches than the server returned (it sends the newest ones).
  const [truncatedAt, setTruncatedAt] = useState<number | null>(null);
  const [devices, setDevices] = useState<ZkDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [editLog, setEditLog] = useState<AttendanceLog | null>(null);
  const [deleteLog, setDeleteLog] = useState<AttendanceLog | null>(null);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  // Punches that just arrived live, highlighted briefly; compared against what was on screen.
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const shownIds = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (silent = false, markNew = false) => {
      if (!silent) setLoading(true);
      setRefreshing(true);
      try {
        const [nextLogs, nextDevices] = await Promise.all([
          getAttendanceLogs({ branchId, startDate: dateRange.start, endDate: dateRange.end, includeDeleted: showDeleted }),
          getZkDevices(branchId),
        ]);
        if (markNew) {
          const added = nextLogs.logs.filter((log) => !shownIds.current.has(log.key)).map((log) => log.key);
          if (added.length) {
            setFreshIds((prev) => new Set([...prev, ...added]));
            setTimeout(() => {
              setFreshIds((prev) => {
                const next = new Set(prev);
                added.forEach((id) => next.delete(id));
                return next;
              });
            }, FRESH_PUNCH_MS);
          }
        }
        shownIds.current = new Set(nextLogs.logs.map((log) => log.key));
        setLogs(nextLogs.logs);
        setTruncatedAt(nextLogs.truncatedAt);
        setDevices(nextDevices);
        setError(null);
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [branchId, dateRange.start, dateRange.end, showDeleted],
  );

  useEffect(() => {
    void load();
  }, [load]);
  // New punches (and corrections made elsewhere) appear as soon as they are saved.
  const live = useZkLiveReload(branchId, ['attendance', 'device'], () => void load(true, true));

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((log) =>
      [log.pin, log.currentPin ?? '', log.name ?? ''].some((v) => v.toLowerCase().includes(q)),
    );
  }, [logs, searchQuery]);

  // Deleted punches are only listed (with "Show deleted"); they never count.
  const countedLogs = logs.filter((log) => !log.isDeleted);
  const today = getManilaTodayYmd();
  const todayCount = countedLogs.filter((log) => log.punchDt.startsWith(today)).length;
  // One person even if they punched under an old User ID before being added again.
  const peopleCount = new Set(
    countedLogs.map((log) => (log.personId != null ? `person:${log.personId}` : `pin:${log.deviceId}:${log.pin}`)),
  ).size;

  const restore = async (log: AttendanceLog) => {
    setRestoringKey(log.key);
    try {
      await restoreAttendanceLog(branchId, log.id);
      toast.success(t('attendance.restore_punch_done', 'Punch restored'));
      void load(true);
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.restore_punch_failed', 'Could not restore the punch'));
    } finally {
      setRestoringKey(null);
    }
  };

  /** Tooltip for an edited or deleted punch: what the device recorded, who changed it, why. */
  const correctionNote = (log: AttendanceLog) => {
    const lines: string[] = [];
    if (log.source === 'manual') {
      lines.push(
        t('attendance.manual_added_by', {
          who: log.addedBy || '—',
          defaultValue: `Added in the app by ${log.addedBy || '—'} (not recorded by the device)`,
        }),
      );
    } else if (log.isEdited) {
      const o = formatDeviceDateTime(log.originalPunchDt);
      const status = punchStatusLabel(t, log.originalStatus) ?? t('attendance.status_none', 'No status');
      lines.push(
        t('attendance.correction_original', {
          date: o.date,
          time: o.time,
          status,
          defaultValue: `Device recorded: ${o.date} ${o.time} (${status})`,
        }),
      );
    }
    if (log.correctedDt) {
      const c = formatDeviceDateTime(log.correctedDt);
      lines.push(
        t('attendance.correction_by', {
          who: log.correctedBy || '—',
          date: c.date,
          time: c.time,
          defaultValue: `Changed by ${log.correctedBy || '—'} on ${c.date} ${c.time}`,
        }),
      );
    }
    if (log.correctionReason) {
      lines.push(t('attendance.correction_reason_line', { reason: log.correctionReason, defaultValue: `Reason: ${log.correctionReason}` }));
    }
    return lines.join('\n');
  };

  const dim = (log: AttendanceLog) => (log.isDeleted ? 'opacity-50' : '');

  const iconButton =
    'p-2 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 transition-colors disabled:opacity-40';

  const columns: ColumnDef<AttendanceLog>[] = [
    {
      header: t('attendance.date_time', 'Date & Time'),
      accessorKey: 'punchDt',
      sortable: true,
      render: (log) => {
        const { date, time } = formatDeviceDateTime(log.punchDt);
        return (
          <div className="flex items-start gap-2">
            <div className={cn('flex flex-col', dim(log))}>
              <span className={cn('text-sm font-bold text-brand-text tabular-nums', log.isDeleted && 'line-through')}>{time}</span>
              <span className="text-xs text-brand-muted font-medium">{date}</span>
            </div>
            {log.isDeleted ? (
              <StateTag tone="red" label={t('attendance.tag_deleted', 'Deleted')} title={correctionNote(log)} />
            ) : log.source === 'manual' ? (
              <StateTag tone="primary" label={t('attendance.tag_manual', 'Added manually')} title={correctionNote(log)} />
            ) : (
              log.isEdited && <StateTag tone="orange" label={t('attendance.tag_edited', 'Edited')} title={correctionNote(log)} />
            )}
          </div>
        );
      },
    },
    {
      header: t('attendance.pin', 'User ID'),
      accessorKey: 'pin',
      sortable: true,
      // The User ID the device recorded; if the person was added again under another one, that
      // is shown below (the old ID may belong to someone else by now).
      render: (log) => (
        <div className={cn('flex flex-col', dim(log))}>
          <span className="text-sm font-medium tabular-nums">{log.pin}</span>
          {log.currentPin && (
            <span
              className="text-xs text-brand-muted tabular-nums"
              title={t('attendance.now_pin_hint', {
                pin: log.currentPin,
                defaultValue: `Added to the device again as User ID ${log.currentPin}. The device recorded this punch under the old ID.`,
              })}
            >
              {t('attendance.now_pin', { pin: log.currentPin, defaultValue: `now ${log.currentPin}` })}
            </span>
          )}
        </div>
      ),
    },
    {
      header: t('attendance.name', 'Name'),
      accessorKey: 'name',
      sortable: true,
      render: (log) => (
        <div className={cn('flex items-center gap-2', dim(log))}>
          {log.name ? (
            <span className="text-sm font-bold text-brand-text">{log.name}</span>
          ) : (
            <span className="text-sm text-brand-muted italic">{t('attendance.unknown_user', 'Not on device')}</span>
          )}
          {log.userActive === false && (
            <StateTag
              label={t('attendance.tag_removed', 'Removed')}
              title={t('attendance.tag_removed_hint', 'No longer on the device. The name is kept for past punches.')}
            />
          )}
        </div>
      ),
    },
    {
      header: t('attendance.punch_status', 'Status'),
      render: (log) => {
        const label = punchStatusLabel(t, log.status);
        if (!label) return <span className={cn('text-sm text-brand-muted', dim(log))}>—</span>;
        const isIn = log.status === 0 || log.status === 3 || log.status === 4;
        return (
          <span
            className={cn(
              'px-2.5 py-1 rounded-full text-xs font-bold',
              isIn ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600',
              dim(log),
            )}
          >
            {label}
          </span>
        );
      },
    },
    {
      header: t('attendance.verified_by', 'Verified by'),
      render: (log) => (
        <span className={cn('text-sm font-medium', dim(log))}>
          {log.source === 'manual' ? t('attendance.verify_manual', 'Entered in the app') : verifyTypeLabel(t, log.verifyType)}
        </span>
      ),
    },
    {
      header: t('attendance.device', 'Device'),
      render: (log) => (
        <div className={cn('flex flex-col', dim(log))}>
          <span className="text-sm font-medium">{log.deviceName}</span>
          {isAllBranches && (
            <span className="text-xs text-brand-muted font-medium">
              {log.branchName || t('attendance.unassigned_branch', 'No branch')}
            </span>
          )}
        </div>
      ),
    },
    ...(canEdit || canRemove
      ? [
          {
            header: t('employee.action', 'Action'),
            className: 'text-right',
            render: (log: AttendanceLog) => (
              <div className="flex justify-end gap-1">
                {log.isDeleted ? (
                  canRemove && (
                    <button
                      type="button"
                      onClick={() => void restore(log)}
                      disabled={restoringKey === log.key}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/15 transition-colors disabled:opacity-50"
                    >
                      <RotateCcw size={14} />
                      {t('attendance.restore', 'Restore')}
                    </button>
                  )
                ) : (
                  <>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setEditLog(log)}
                        className={iconButton}
                        title={t('attendance.edit_punch_title', 'Edit punch')}
                        aria-label={t('attendance.edit_punch_title', 'Edit punch')}
                      >
                        <Pencil size={16} />
                      </button>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => setDeleteLog(log)}
                        className={cn(iconButton, 'hover:text-red-600 hover:bg-red-50')}
                        title={t('attendance.delete_punch_title', 'Delete punch')}
                        aria-label={t('attendance.delete_punch_title', 'Delete punch')}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </>
                )}
              </div>
            ),
          } satisfies ColumnDef<AttendanceLog>,
        ]
      : []),
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

        <div className="inline-flex bg-white rounded-xl shadow-sm p-1 gap-1" role="tablist">
          {(
            [
              ['summary', BarChart3, t('attendance.view_summary', 'Summary')],
              ['punches', List, t('attendance.view_punches', 'Punches')],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => setView(key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors',
                view === key ? 'bg-brand-primary text-white' : 'text-brand-muted hover:bg-gray-50',
              )}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {view === 'summary' ? (
          <AttendanceSummary
            branchId={branchId}
            branchName={selectedBranch?.name ?? null}
            dateRange={dateRange}
            onOpenTimesheet={(employee, date) => setTimesheetFor({ employee, date })}
          />
        ) : (
        <>
        <div className="flex items-center justify-between">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
            <input
              type="text"
              placeholder={t('attendance.search_placeholder', 'Search by user ID or name')}
              className="bg-white border-none rounded-xl pl-10 pr-4 py-2.5 text-base w-80 shadow-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
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
                onClick={() => setIsAddOpen(true)}
                disabled={devices.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold text-sm shadow-lg shadow-brand-primary/30 transition-all disabled:opacity-50 disabled:shadow-none"
              >
                <Plus size={18} />
                {t('attendance.add_punch_title', 'Add punch')}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('attendance.punches_in_range', 'Punches in range')}</p>
            <h3 className="text-3xl font-bold">
              {loading ? '—' : truncatedAt ? `${truncatedAt.toLocaleString()}+` : countedLogs.length}
            </h3>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('attendance.people_punched', 'People who punched')}</p>
            <h3 className="text-3xl font-bold">{loading ? '—' : peopleCount}</h3>
          </div>
          <div className="bg-white p-6 rounded-2xl shadow-sm">
            <p className="text-brand-muted text-sm font-medium mb-1">{t('attendance.punches_today', 'Punches today')}</p>
            <h3 className="text-3xl font-bold text-green-600">{loading ? '—' : todayCount}</h3>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-4 rounded-xl text-sm font-medium">
            {t('attendance.load_failed', 'Could not load attendance logs.')} {error}
          </div>
        )}

        {!loading && truncatedAt && (
          <div className="bg-orange-50 border border-orange-100 text-orange-700 p-4 rounded-xl text-sm font-medium">
            {t('attendance.truncated_notice', {
              count: truncatedAt,
              defaultValue: `Showing the newest ${truncatedAt.toLocaleString()} punches. Narrow the date range to see older ones.`,
            })}
          </div>
        )}

        {loading ? (
          <SkeletonTable columns={6} rows={8} showToolbar={false} />
        ) : (
          <DataTable
            data={filteredLogs}
            columns={columns}
            keyExtractor={(log) => log.key}
            rowClassName={(log) => (freshIds.has(log.key) ? 'row-fresh' : undefined)}
          />
        )}
        </>
        )}
      </motion.div>

      <EditPunchDialog log={editLog} branchId={branchId} onClose={() => setEditLog(null)} onDone={() => void load(true)} />
      <DeletePunchDialog log={deleteLog} branchId={branchId} onClose={() => setDeleteLog(null)} onDone={() => void load(true)} />
      <AddPunchDialog isOpen={isAddOpen} branchId={branchId} onClose={() => setIsAddOpen(false)} onDone={() => void load(true)} />
      <TimesheetPanel
        employee={timesheetFor?.employee ?? null}
        initialDate={timesheetFor?.date}
        branchId={branchId}
        canAdd={canAdd}
        canEdit={canEdit}
        canDelete={canRemove}
        onClose={() => setTimesheetFor(null)}
      />
    </div>
  );
};
