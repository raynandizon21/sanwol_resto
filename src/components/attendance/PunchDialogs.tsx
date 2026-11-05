import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Info, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';
import {
  createManualPunch,
  deleteAttendanceLog,
  getDeviceUsers,
  updateAttendanceLog,
  APP_PUNCH_STATUSES,
  type AttendanceLog,
} from '../../services/zktecoService';
import type { TimesheetPunch } from '../../services/attendanceService';
import { getManilaTodayYmd } from '../../utils/manilaDateTime';
import { formatDeviceDateTime, punchStatusLabel } from './zktecoShared';
import { addDaysYmd } from './attendanceShared';

const REASON_MAX = 255;
const NO_STATUS = 255;

const inputClass =
  'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none';
const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';
const secondary = 'px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium';

/** "YYYY-MM-DD HH:mm:ss" -> date / time input values (kept as text: device-local, no timezone conversion). */
const splitDt = (dt: string) => ({ date: dt.slice(0, 10), time: dt.slice(11, 19) });
/** <input type="time" step="1"> drops ":00" seconds in some browsers. */
const joinDt = (date: string, time: string) => `${date} ${time.length === 5 ? `${time}:00` : time}`;

const who = (log: AttendanceLog, t: TFunction) =>
  `${log.name || t('attendance.unknown_user', 'Not on device')} · ${t('attendance.pin', 'User ID')} ${log.pin}`;

/** A timesheet punch in the shape the edit/delete dialogs take. */
export const timesheetPunchToLog = (p: TimesheetPunch, name: string | null): AttendanceLog => ({
  key: `${p.source}:${p.id}`,
  id: p.id,
  source: p.source,
  deviceId: p.deviceId,
  deviceName: '',
  branchName: null,
  pin: p.pin,
  name,
  punchDt: p.punchDt,
  status: p.status,
  originalPunchDt: p.originalPunchDt,
  originalStatus: p.originalStatus,
  verifyType: p.verifyType,
  workCode: null,
  receivedDt: p.punchDt,
  userActive: null,
  personId: null,
  currentPin: null,
  isEdited: p.isEdited,
  isDeleted: false,
  correctionReason: p.reason,
  correctedBy: null,
  correctedDt: null,
  addedBy: null,
});

/**
 * Why the punch is being changed. Required for every change except putting a device punch back to
 * what the device recorded. `previous`: the reason saved with the last change, shown for context
 * (the field starts empty so an old reason is never saved against a new change).
 */
const ReasonField: React.FC<{ value: string; onChange: (v: string) => void; required: boolean; previous?: string | null }> = ({
  value,
  onChange,
  required,
  previous,
}) => {
  const { t } = useTranslation();
  return (
    <div>
      <label className={labelClass}>
        {t('attendance.correction_reason', 'Reason')}
        {!required && <span className="normal-case font-medium"> {t('attendance.optional', '(optional)')}</span>}
      </label>
      <input
        type="text"
        value={value}
        maxLength={REASON_MAX}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('attendance.correction_reason_placeholder', 'e.g. Forgot to punch out')}
        className={inputClass}
      />
      {previous && (
        <p className="mt-1.5 text-xs text-brand-muted font-medium">
          {t('attendance.previous_reason', { reason: previous, defaultValue: `Previous reason: ${previous}` })}
        </p>
      )}
    </div>
  );
};

interface PunchDialogProps {
  log: AttendanceLog | null;
  branchId: string | number;
  onClose: () => void;
  /** Saved; the page re-fetches (other open pages update through the live stream). */
  onDone: () => void;
  /** Stacking class when opened above a side panel (the panel is z-[101]). */
  layerClassName?: string;
}

/**
 * Corrects a punch's time and status. The device's own record is never changed: the correction
 * is stored separately, and putting the original values back clears it. A manual punch (added
 * in the app) is simply changed. A reason is required, except when going back to the device's record.
 */
export const EditPunchDialog: React.FC<PunchDialogProps> = ({ log, branchId, onClose, onDone, layerClassName }) => {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [status, setStatus] = useState<number>(NO_STATUS);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!log) return;
    const current = splitDt(log.punchDt);
    setDate(current.date);
    setTime(current.time);
    setStatus(log.status ?? NO_STATUS);
    setReason('');
    setError(null);
  }, [log]);

  if (!log) return null;

  const isManual = log.source === 'manual';
  const original = formatDeviceDateTime(log.originalPunchDt);
  const originalStatus = punchStatusLabel(t, log.originalStatus) ?? t('attendance.status_none', 'No status');
  const isOriginal =
    !isManual && joinDt(date, time) === log.originalPunchDt && status === (log.originalStatus ?? NO_STATUS);
  // Going back to what the device recorded needs no explanation; any other change does.
  const reasonRequired = !isOriginal;

  const resetToOriginal = () => {
    const o = splitDt(log.originalPunchDt);
    setDate(o.date);
    setTime(o.time);
    setStatus(log.originalStatus ?? NO_STATUS);
  };

  const save = async () => {
    if (!date || !time) {
      setError(t('attendance.edit_punch_err_dt', 'Enter a date and time'));
      return;
    }
    if (reasonRequired && !reason.trim()) {
      setError(t('attendance.edit_punch_err_reason', 'Give a reason for the change'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateAttendanceLog(branchId, log.id, { punchDt: joinDt(date, time), status, reason: reason.trim() });
      toast.success(
        isOriginal
          ? t('attendance.edit_punch_cleared', 'Punch set back to what the device recorded')
          : t('attendance.edit_punch_saved', 'Punch updated'),
      );
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.edit_punch_failed', 'Could not update the punch'));
    } finally {
      setSaving(false);
    }
  };

  // Time-in / Time-out, plus the type the punch has now (and, for a device punch, the type the
  // device recorded) so an edit never forces a change of type.
  const statusCodes = [...new Set<number>([
    ...APP_PUNCH_STATUSES,
    log.status ?? NO_STATUS,
    ...(isManual ? [] : [log.originalStatus ?? NO_STATUS]),
  ])];
  const statusOptions = statusCodes.map((code) => ({
    value: code,
    label: punchStatusLabel(t, code) ?? t('attendance.status_none', 'No status'),
  }));

  return (
    <Modal
      isOpen={Boolean(log)}
      onClose={onClose}
      title={t('attendance.edit_punch_title', 'Edit punch')}
      subtitle={<span className="text-sm text-brand-muted">{who(log, t)}</span>}
      maxWidth="lg"
      layerClassName={layerClassName}
      footer={
        <div className="flex items-center justify-between gap-2">
          {isManual ? (
            <span />
          ) : (
            <button
              onClick={resetToOriginal}
              disabled={isOriginal}
              className={cn(secondary, 'flex items-center gap-2 disabled:opacity-50')}
            >
              <RotateCcw size={16} />
              {t('attendance.edit_punch_reset', "Use the device's record")}
            </button>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className={secondary}>
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50"
            >
              {saving ? t('attendance.saving', 'Saving…') : t('attendance.save', 'Save')}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 bg-gray-50 rounded-xl px-4 py-3 text-sm font-medium text-brand-text">
          <Info size={16} className="shrink-0 mt-0.5 text-brand-muted" />
          <span>
            {isManual
              ? t('attendance.edit_manual_punch_note', 'This punch was added in the app, not recorded by the device.')
              : t('attendance.edit_punch_original', {
                  date: original.date,
                  time: original.time,
                  status: originalStatus,
                  defaultValue: `The device recorded ${original.date} ${original.time} (${originalStatus}). That record isn't changed; the correction is kept in the app.`,
                })}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t('attendance.date', 'Date')}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputClass, 'tabular-nums')} />
          </div>
          <div>
            <label className={labelClass}>{t('attendance.time', 'Time')}</label>
            <input
              type="time"
              step={1}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={cn(inputClass, 'tabular-nums')}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>{t('attendance.punch_status', 'Status')}</label>
          <Select2
            options={statusOptions}
            value={status}
            onChange={(v) => setStatus(v == null ? NO_STATUS : Number(v))}
            clearable={false}
          />
        </div>

        <ReasonField value={reason} onChange={setReason} required={reasonRequired} previous={log.correctionReason} />

        {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}
      </div>
    </Modal>
  );
};

/** Soft-deletes a punch: hidden from attendance, restorable from "Show deleted". A reason is required. */
export const DeletePunchDialog: React.FC<PunchDialogProps> = ({ log, branchId, onClose, onDone, layerClassName }) => {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason('');
    setError(null);
  }, [log]);

  if (!log) return null;
  const when = formatDeviceDateTime(log.punchDt);

  const remove = async () => {
    if (!reason.trim()) {
      setError(t('attendance.delete_punch_err_reason', 'Give a reason for deleting the punch'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteAttendanceLog(branchId, log.id, reason.trim());
      toast.success(t('attendance.delete_punch_done', 'Punch deleted. Turn on "Show deleted" to restore it.'));
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.delete_punch_failed', 'Could not delete the punch'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={Boolean(log)}
      onClose={onClose}
      title={t('attendance.delete_punch_title', 'Delete punch')}
      subtitle={<span className="text-sm text-brand-muted">{who(log, t)}</span>}
      maxWidth="md"
      layerClassName={layerClassName}
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={secondary}>
            {t('common.cancel')}
          </button>
          <button
            onClick={remove}
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 font-bold disabled:opacity-50 flex items-center gap-2"
          >
            <Trash2 size={16} />
            {saving ? t('attendance.sending', 'Sending…') : t('attendance.delete_punch_confirm', 'Delete punch')}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-brand-text font-medium">
          {t('attendance.delete_punch_body', {
            date: when.date,
            time: when.time,
            defaultValue: `Delete the punch at ${when.time} on ${when.date}? It no longer counts in attendance, and you can restore it from "Show deleted". The device's own record isn't changed.`,
          })}
        </p>
        <ReasonField value={reason} onChange={setReason} required />
        {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}
      </div>
    </Modal>
  );
};

interface AddPunchDialogProps {
  isOpen: boolean;
  branchId: string | number;
  /** Fixed person (from a timesheet); otherwise the dialog lists the device's active users. */
  employee?: { employeeId: number; name: string | null; pin: string } | null;
  defaultDate?: string;
  defaultStatus?: number;
  /** Time-in ("YYYY-MM-DD HH:mm") of the shift the punch is for, to catch a time-out put before it. */
  shiftIn?: string | null;
  onClose: () => void;
  onDone: () => void;
  layerClassName?: string;
}

// Time-out and OT-out: they end a shift, so they can't come before its time-in.
const ENDING_STATUSES = [1, 5];

/**
 * Adds a punch someone forgot (e.g. no time-out). It's kept apart from the device's punches,
 * tagged "Added manually", and counts in attendance like any other punch. A reason is required.
 */
export const AddPunchDialog: React.FC<AddPunchDialogProps> = ({
  isOpen,
  branchId,
  employee,
  defaultDate,
  defaultStatus,
  shiftIn,
  onClose,
  onDone,
  layerClassName,
}) => {
  const { t } = useTranslation();
  const [people, setPeople] = useState<{ value: number; label: string }[]>([]);
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [status, setStatus] = useState<number>(0);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setEmployeeId(employee?.employeeId ?? null);
    setDate(defaultDate || getManilaTodayYmd());
    setTime('');
    setStatus(defaultStatus ?? 0);
    setReason('');
    setError(null);
    if (employee) return;
    let cancelled = false;
    getDeviceUsers(branchId)
      .then((users) => {
        if (cancelled) return;
        setPeople(
          users
            .filter((u) => u.active)
            .map((u) => ({
              value: u.id,
              label: `${u.profile?.fullName || u.name || '—'} · ${t('attendance.pin', 'User ID')} ${u.pin}`,
            })),
        );
      })
      .catch((err) => !cancelled && setError((err as Error)?.message || String(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, employee?.employeeId, defaultDate, defaultStatus, branchId]);

  if (!isOpen) return null;

  // A night shift's time-out after midnight goes on the next date; entered on the work date it
  // would land before the time-in and count as a separate, broken shift.
  const beforeShiftIn = Boolean(
    shiftIn && date && time && ENDING_STATUSES.includes(status) && `${date} ${time.slice(0, 5)}` <= shiftIn,
  );

  const save = async () => {
    if (!employeeId) {
      setError(t('attendance.add_punch_err_who', 'Choose who the punch is for'));
      return;
    }
    if (!date || !time) {
      setError(t('attendance.edit_punch_err_dt', 'Enter a date and time'));
      return;
    }
    if (!reason.trim()) {
      setError(t('attendance.add_punch_err_reason', 'Give a reason, e.g. "Forgot to time out"'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createManualPunch(branchId, { employeeId, punchDt: joinDt(date, time), status, reason: reason.trim() });
      toast.success(t('attendance.add_punch_done', 'Punch added'));
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.add_punch_failed', 'Could not add the punch'));
    } finally {
      setSaving(false);
    }
  };

  const statusOptions = APP_PUNCH_STATUSES.map((code) => ({ value: code, label: punchStatusLabel(t, code) ?? String(code) }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.add_punch_title', 'Add punch')}
      subtitle={
        employee ? (
          <span className="text-sm text-brand-muted">
            {employee.name || '—'} · {t('attendance.pin', 'User ID')} {employee.pin}
          </span>
        ) : undefined
      }
      maxWidth="lg"
      layerClassName={layerClassName}
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={secondary}>
            {t('common.cancel')}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50 flex items-center gap-2"
          >
            <Plus size={16} />
            {saving ? t('attendance.saving', 'Saving…') : t('attendance.add_punch_confirm', 'Add punch')}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2 bg-gray-50 rounded-xl px-4 py-3 text-sm font-medium text-brand-text">
          <Info size={16} className="shrink-0 mt-0.5 text-brand-muted" />
          <span>
            {t(
              'attendance.add_punch_note',
              'For a punch someone forgot. It counts like a device punch and is marked "Added manually". The device\'s own records aren\'t changed.',
            )}
          </span>
        </div>

        {!employee && (
          <div>
            <label className={labelClass}>{t('attendance.employee', 'Employee')}</label>
            <Select2
              options={people}
              value={employeeId}
              onChange={(v) => setEmployeeId(v == null ? null : Number(v))}
              placeholder={t('attendance.choose_employee', 'Choose an employee')}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t('attendance.date', 'Date')}</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputClass, 'tabular-nums')} />
          </div>
          <div>
            <label className={labelClass}>{t('attendance.time', 'Time')}</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(inputClass, 'tabular-nums')} />
          </div>
        </div>

        {beforeShiftIn && shiftIn && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-orange-50 rounded-xl px-3 py-2.5 text-xs font-bold text-orange-700">
            <span>
              {t('attendance.add_punch_before_in', {
                time: shiftIn.slice(11, 16),
                defaultValue: `This is before the time-in at ${shiftIn.slice(11, 16)}. A time-out after midnight goes on the next day.`,
              })}
            </span>
            <button
              type="button"
              onClick={() => setDate(addDaysYmd(date, 1))}
              className="px-2.5 py-1 rounded-lg bg-white text-orange-700 border border-orange-200 hover:bg-orange-100"
            >
              {t('attendance.add_punch_use_next_day', {
                date: addDaysYmd(date, 1),
                defaultValue: `Use ${addDaysYmd(date, 1)}`,
              })}
            </button>
          </div>
        )}

        <div>
          <label className={labelClass}>{t('attendance.punch_type', 'Punch type')}</label>
          <Select2 options={statusOptions} value={status} onChange={(v) => setStatus(v == null ? 0 : Number(v))} clearable={false} />
        </div>

        <div>
          <label className={labelClass}>{t('attendance.correction_reason', 'Reason')}</label>
          <input
            type="text"
            value={reason}
            maxLength={REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('attendance.correction_reason_placeholder', 'e.g. Forgot to punch out')}
            className={inputClass}
          />
        </div>

        {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}
      </div>
    </Modal>
  );
};
