import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, X } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import {
  getAttendanceRules,
  getHolidays,
  removeHoliday,
  saveAttendanceRules,
  saveHoliday,
  type AttendanceRules,
  type CutoffRule,
  type Holiday,
} from '../../services/attendanceService';
import { formatYmdDisplay, getManilaTodayYmd } from '../../utils/manilaDateTime';
import { WEEKDAYS, weekdayShort } from './attendanceShared';
import { cutoffPeriodOf, shortRangeLabel, stepPeriod } from './timesheetPeriods';

const inputClass =
  'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none disabled:bg-gray-50 disabled:text-brand-muted tabular-nums';
const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';
const hintClass = 'text-xs text-brand-muted mt-1';
const sectionClass = 'rounded-2xl border border-gray-100 p-4 space-y-4';
const sectionTitle = 'text-sm font-bold text-brand-text';

interface AttendanceRulesDialogProps {
  isOpen: boolean;
  branchId: string | number;
  branchName: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Weekday toggles (closed days, rest days). */
export const WeekdayPicker: React.FC<{ value: number[]; onChange: (days: number[]) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-60',
              on ? 'bg-brand-primary text-white border-brand-primary' : 'bg-white text-brand-muted border-gray-200 hover:bg-gray-50',
            )}
          >
            {weekdayShort(t, d)}
          </button>
        );
      })}
    </div>
  );
};

/** A time input that can be left empty (with a clear button). */
export const OptionalTime: React.FC<{ value: string | null; onChange: (v: string | null) => void; disabled?: boolean; clearLabel: string }> = ({
  value,
  onChange,
  disabled,
  clearLabel,
}) => (
  <div className="relative">
    <input type="time" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} className={inputClass} />
    {value && !disabled && (
      <button
        type="button"
        onClick={() => onChange(null)}
        className="absolute right-9 top-1/2 -translate-y-1/2 p-1 rounded-md text-brand-muted hover:text-red-600 hover:bg-red-50"
        aria-label={clearLabel}
        title={clearLabel}
      >
        <X size={14} />
      </button>
    )}
  </div>
);

/**
 * One branch's attendance rules: hours (standard day, longest shift), the branch work schedule
 * (call time, end time, grace period, closed days; all optional), the payroll cutoff, and the
 * branch holidays (saved right away, separately from the rest).
 */
export const AttendanceRulesDialog: React.FC<AttendanceRulesDialogProps> = ({ isOpen, branchId, branchName, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AttendanceRules | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [holidayDraft, setHolidayDraft] = useState({ date: '', name: '' });
  const [holidayBusy, setHolidayBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setRules(null);
    setError(null);
    setHolidayDraft({ date: '', name: '' });
    getAttendanceRules(branchId)
      .then((res) => {
        setRules(res.rules);
        setCanEdit(res.canEdit);
      })
      .catch((err) => setError((err as Error)?.message || String(err)));
    getHolidays(branchId)
      .then((res) => setHolidays(res.holidays))
      .catch(() => setHolidays([]));
  }, [isOpen, branchId]);

  const set = <K extends keyof AttendanceRules>(key: K, value: AttendanceRules[K]) =>
    setRules((r) => (r ? { ...r, [key]: value } : r));
  const setCutoff = (changes: Partial<CutoffRule>) => setRules((r) => (r ? { ...r, cutoff: { ...r.cutoff, ...changes } } : r));

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setError(null);
    try {
      await saveAttendanceRules(branchId, rules);
      toast.success(t('attendance.rules_saved', 'Attendance rules saved'));
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.rules_save_failed', 'Could not save the rules'));
    } finally {
      setSaving(false);
    }
  };

  const addHoliday = async () => {
    setHolidayBusy(true);
    try {
      setHolidays(await saveHoliday(branchId, holidayDraft.date, holidayDraft.name));
      setHolidayDraft({ date: '', name: '' });
      onSaved();
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.holiday_failed', 'Could not save the holiday'));
    } finally {
      setHolidayBusy(false);
    }
  };

  const deleteHoliday = async (id: number) => {
    setHolidayBusy(true);
    try {
      setHolidays(await removeHoliday(branchId, id));
      onSaved();
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.holiday_failed', 'Could not save the holiday'));
    } finally {
      setHolidayBusy(false);
    }
  };

  const numberField = (key: 'standardHours' | 'maxShiftHours' | 'graceMinutes', label: string, hint: string, step = 1) => (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type="number"
        min={0}
        step={step}
        value={rules ? String(rules[key]) : ''}
        disabled={!canEdit}
        onChange={(e) => set(key, Number(e.target.value))}
        className={inputClass}
      />
      <p className={hintClass}>{hint}</p>
    </div>
  );

  const dayField = (value: number, onChange: (v: number) => void, label: string) => (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type="number"
        min={1}
        max={28}
        value={String(value)}
        disabled={!canEdit}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputClass}
      />
    </div>
  );

  // Preview: the current and the next period with these settings.
  const today = getManilaTodayYmd();
  const preview = (() => {
    if (!rules) return null;
    const c = rules.cutoff;
    const valid =
      (c.type === 'semi_monthly' && c.day1 >= 1 && c.day2 > c.day1 && c.day2 <= 28) ||
      (c.type === 'monthly' && c.day1 >= 1 && c.day1 <= 28) ||
      (c.type === 'weekly' && c.weekday >= 0 && c.weekday <= 6) ||
      (c.type === 'biweekly' && Boolean(c.anchor));
    if (!valid) return null;
    const current = cutoffPeriodOf(c, today);
    return { current: shortRangeLabel(current), next: shortRangeLabel(stepPeriod('cutoff', current, 1, c)) };
  })();

  const cutoffTypes: { key: CutoffRule['type']; label: string }[] = [
    { key: 'semi_monthly', label: t('attendance.cutoff_semi_monthly', 'Twice a month') },
    { key: 'monthly', label: t('attendance.cutoff_monthly', 'Monthly') },
    { key: 'weekly', label: t('attendance.cutoff_weekly', 'Weekly') },
    { key: 'biweekly', label: t('attendance.cutoff_biweekly', 'Every 2 weeks') },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.rules_title', 'Attendance rules')}
      subtitle={branchName ? <span className="text-sm text-brand-muted">{branchName}</span> : undefined}
      maxWidth="2xl"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium">
            {canEdit ? t('common.cancel') : t('attendance.close', 'Close')}
          </button>
          {canEdit && (
            <button
              onClick={save}
              disabled={saving || !rules}
              className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50"
            >
              {saving ? t('attendance.saving', 'Saving…') : t('attendance.save', 'Save')}
            </button>
          )}
        </div>
      }
    >
      {!rules ? (
        error ? (
          <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>
        ) : (
          <p className="text-sm text-brand-muted">{t('attendance.loading', 'Loading…')}</p>
        )
      ) : (
        <div className="space-y-5">
          {/* Hours */}
          <div className={sectionClass}>
            <p className={sectionTitle}>{t('attendance.rules_hours', 'Hours')}</p>
            <div className="grid grid-cols-2 gap-4">
              {numberField(
                'standardHours',
                t('attendance.standard_hours', 'Standard day (hours)'),
                t('attendance.standard_hours_hint_basic', 'Hours a day counted as regular. Time worked past it is shown as "over".'),
                0.5,
              )}
              {numberField('maxShiftHours', t('attendance.max_shift', 'Longest shift (hours)'), t('attendance.max_shift_hint', 'No time-out within this many hours of the time-in means it was forgotten.'))}
            </div>
          </div>

          {/* Branch schedule */}
          <div className={sectionClass}>
            <div>
              <p className={sectionTitle}>{t('attendance.rules_schedule', 'Branch schedule')}</p>
              <p className={hintClass}>
                {t(
                  'attendance.rules_schedule_hint',
                  'Optional. Employees follow it unless their profile has their own schedule or "No schedule". Without a call time, nobody on the branch schedule is checked for late or absences.',
                )}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>{t('attendance.call_time', 'Call time')}</label>
                <OptionalTime
                  value={rules.scheduleStart}
                  disabled={!canEdit}
                  onChange={(v) => setRules((r) => (r ? { ...r, scheduleStart: v, scheduleEnd: v ? r.scheduleEnd : null } : r))}
                  clearLabel={t('attendance.clear', 'Clear')}
                />
                <p className={hintClass}>{t('attendance.call_time_hint', 'A later time-in is late.')}</p>
              </div>
              <div>
                <label className={labelClass}>{t('attendance.end_time', 'End time')}</label>
                <OptionalTime
                  value={rules.scheduleEnd}
                  disabled={!canEdit || !rules.scheduleStart}
                  onChange={(v) => set('scheduleEnd', v)}
                  clearLabel={t('attendance.clear', 'Clear')}
                />
                <p className={hintClass}>{t('attendance.end_time_hint', 'Optional. An earlier time-out is undertime.')}</p>
              </div>
              {numberField('graceMinutes', t('attendance.grace_minutes', 'Grace period (minutes)'), t('attendance.grace_hint', 'Late only past this. Then late counts from the call time.'))}
            </div>
            <div>
              <label className={labelClass}>{t('attendance.closed_days', 'Closed on')}</label>
              <WeekdayPicker value={rules.closedDays} onChange={(days) => set('closedDays', days)} disabled={!canEdit} />
              <p className={hintClass}>{t('attendance.closed_days_hint', 'Rest days for everyone on the branch schedule: never absent.')}</p>
            </div>
          </div>

          {/* Cutoff */}
          <div className={sectionClass}>
            <div>
              <p className={sectionTitle}>{t('attendance.rules_cutoff', 'Cutoff')}</p>
              <p className={hintClass}>{t('attendance.rules_cutoff_hint', 'The pay periods. The Timesheet tab’s "This cutoff" and "Last cutoff" buttons follow it.')}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cutoffTypes.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  disabled={!canEdit}
                  aria-pressed={rules.cutoff.type === c.key}
                  onClick={() => setCutoff({ type: c.key, anchor: c.key === 'biweekly' ? rules.cutoff.anchor || today : rules.cutoff.anchor })}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-60',
                    rules.cutoff.type === c.key ? 'bg-brand-primary text-white border-brand-primary' : 'bg-white text-brand-muted border-gray-200 hover:bg-gray-50',
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-4">
              {rules.cutoff.type === 'semi_monthly' && (
                <>
                  {dayField(rules.cutoff.day1, (v) => setCutoff({ day1: v }), t('attendance.cutoff_first_start', 'First period starts on day'))}
                  {dayField(rules.cutoff.day2, (v) => setCutoff({ day2: v }), t('attendance.cutoff_second_start', 'Second period starts on day'))}
                </>
              )}
              {rules.cutoff.type === 'monthly' && dayField(rules.cutoff.day1, (v) => setCutoff({ day1: v }), t('attendance.cutoff_month_start', 'Starts on day'))}
              {rules.cutoff.type === 'weekly' && (
                <div className="col-span-3">
                  <label className={labelClass}>{t('attendance.cutoff_week_start', 'Starts on')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        disabled={!canEdit}
                        aria-pressed={rules.cutoff.weekday === d}
                        onClick={() => setCutoff({ weekday: d })}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-60',
                          rules.cutoff.weekday === d ? 'bg-brand-primary text-white border-brand-primary' : 'bg-white text-brand-muted border-gray-200 hover:bg-gray-50',
                        )}
                      >
                        {weekdayShort(t, d)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {rules.cutoff.type === 'biweekly' && (
                <div className="col-span-2">
                  <label className={labelClass}>{t('attendance.cutoff_anchor', 'First day of any period')}</label>
                  <input
                    type="date"
                    value={rules.cutoff.anchor ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => setCutoff({ anchor: e.target.value || null })}
                    className={inputClass}
                  />
                  <p className={hintClass}>{t('attendance.cutoff_anchor_hint', 'Periods repeat every 14 days from here, both ways.')}</p>
                </div>
              )}
            </div>
            {rules.cutoff.type === 'semi_monthly' || rules.cutoff.type === 'monthly' ? (
              <p className={hintClass}>{t('attendance.cutoff_days_hint', 'Days 1 to 28, so every month has them.')}</p>
            ) : null}
            {preview && (
              <p className="text-xs font-medium text-brand-text">
                {t('attendance.cutoff_preview', {
                  current: preview.current,
                  next: preview.next,
                  defaultValue: `This cutoff: ${preview.current} · Next: ${preview.next}`,
                })}
              </p>
            )}
          </div>

          {/* Holidays (saved right away) */}
          <div className={sectionClass}>
            <div>
              <p className={sectionTitle}>{t('attendance.rules_holidays', 'Holidays')}</p>
              <p className={hintClass}>
                {t('attendance.rules_holidays_hint', 'Nobody in this branch is absent on these dates. Saved right away. For one person, mark the day in their timesheet.')}
              </p>
            </div>
            {canEdit && (
              <div className="flex gap-2">
                <input
                  type="date"
                  value={holidayDraft.date}
                  onChange={(e) => setHolidayDraft((d) => ({ ...d, date: e.target.value }))}
                  className={cn(inputClass, 'w-44')}
                />
                <input
                  type="text"
                  maxLength={100}
                  value={holidayDraft.name}
                  placeholder={t('attendance.holiday_name_placeholder', 'e.g. Christmas Day')}
                  onChange={(e) => setHolidayDraft((d) => ({ ...d, name: e.target.value }))}
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void addHoliday()}
                  disabled={holidayBusy || !holidayDraft.date || !holidayDraft.name.trim()}
                  className="flex items-center gap-1.5 px-4 rounded-xl bg-brand-primary/10 text-brand-primary text-sm font-bold hover:bg-brand-primary/15 disabled:opacity-50 shrink-0"
                >
                  <Plus size={15} />
                  {t('attendance.add', 'Add')}
                </button>
              </div>
            )}
            {holidays.length === 0 ? (
              <p className="text-xs text-brand-muted">{t('attendance.no_holidays', 'No holidays yet.')}</p>
            ) : (
              <div className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
                {holidays.map((h) => (
                  <div key={h.id} className={cn('flex items-center justify-between gap-3 py-2', h.date < today && 'opacity-60')}>
                    <span className="text-sm">
                      <span className="font-bold text-brand-text tabular-nums">{formatYmdDisplay(h.date)}</span>
                      <span className="text-brand-muted"> · {h.name}</span>
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        disabled={holidayBusy}
                        onClick={() => void deleteHoliday(h.id)}
                        className="p-1.5 rounded-lg text-brand-muted hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                        aria-label={t('attendance.remove_holiday', 'Remove holiday')}
                        title={t('attendance.remove_holiday', 'Remove holiday')}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {!canEdit && (
            <p className="text-xs text-brand-muted">
              {t('attendance.rules_read_only', 'You can view these rules. Changing them needs Attendance Logs → Edit permission.')}
            </p>
          )}
          {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}
        </div>
      )}
    </Modal>
  );
};
