import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '../../lib/utils';
import type { DeviceUser, ScheduleMode } from '../../services/zktecoService';
import { getEmployeeProfile, updateEmployeeProfile, type BranchSchedule } from '../../services/attendanceService';
import { scheduleHours, weekdayList } from './attendanceShared';
import { OptionalTime, WeekdayPicker } from './AttendanceRulesDialog';

const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';
const hintClass = 'text-xs text-brand-muted mt-1';

interface EmployeeScheduleFormProps {
  user: DeviceUser;
  branchId: string | number;
  /** Employees → Edit. Without it the form is read-only. */
  canEdit: boolean;
  onSaved: () => void;
}

type Draft = { mode: ScheduleMode; start: string | null; end: string | null; restDays: number[] };

/**
 * The work schedule late, undertime and absences are checked against: the branch schedule
 * (default; set in Attendance rules), their own start / end time and rest days, or none.
 */
export const EmployeeScheduleForm: React.FC<EmployeeScheduleFormProps> = ({ user, branchId, canEdit, onSaved }) => {
  const { t } = useTranslation();
  const profile = user.profile;
  const fromProfile = (): Draft => ({
    mode: profile?.scheduleMode ?? 'branch',
    start: profile?.scheduleStart || null,
    end: profile?.scheduleEnd || null,
    restDays: profile?.scheduleRestDays ?? [],
  });
  const [draft, setDraft] = useState<Draft>(fromProfile);
  const [branchSchedule, setBranchSchedule] = useState<BranchSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form per person (not on every live refresh of the same one).
  useEffect(() => {
    setDraft(fromProfile());
    setError(null);
    setBranchSchedule(null);
    if (profile) {
      getEmployeeProfile(branchId, profile.id)
        .then((res) => setBranchSchedule(res.branchSchedule))
        .catch(() => setBranchSchedule(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, branchId]);

  const disabled = !canEdit || !profile;
  const changed = JSON.stringify(draft) !== JSON.stringify(fromProfile());

  const save = async () => {
    if (!profile) return;
    if (draft.mode === 'own' && !draft.start) {
      setError(t('attendance.schedule_start_required', 'Set a start time for their own schedule.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Switching to the branch schedule or none keeps their own times for later.
      await updateEmployeeProfile(
        branchId,
        profile.id,
        draft.mode === 'own'
          ? { schedule_mode: 'own', schedule_start: draft.start ?? '', schedule_end: draft.end ?? '', schedule_rest_days: draft.restDays }
          : { schedule_mode: draft.mode },
      );
      toast.success(t('attendance.schedule_saved', 'Schedule saved'));
      onSaved();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.profile_save_failed', 'Could not save the employee'));
    } finally {
      setSaving(false);
    }
  };

  const branchText = !branchSchedule
    ? '…'
    : branchSchedule.start
      ? `${scheduleHours(branchSchedule.start, branchSchedule.end)}${
          branchSchedule.closedDays.length ? ` · ${t('attendance.closed_short', 'Closed')}: ${weekdayList(t, branchSchedule.closedDays)}` : ''
        } · ${t('attendance.grace_short', { minutes: branchSchedule.graceMinutes, defaultValue: `${branchSchedule.graceMinutes} min grace` })}`
      : t('attendance.branch_no_schedule', 'The branch has no call time set, so this means not tracked for now.');

  const options: { key: ScheduleMode; label: string; hint: string }[] = [
    { key: 'branch', label: t('attendance.schedule_branch', 'Branch schedule'), hint: branchText },
    { key: 'own', label: t('attendance.schedule_own', 'Own schedule'), hint: t('attendance.schedule_own_hint', 'Their own start time, end time and rest days.') },
    {
      key: 'none',
      label: t('attendance.schedule_none', 'No schedule'),
      hint: t('attendance.schedule_none_hint', 'Never late, undertime or absent (e.g. part-time or on call). Hours still count.'),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-100 p-4 space-y-3">
        <p className="text-sm font-bold text-brand-text">{t('attendance.schedule_title', 'Work schedule')}</p>
        <p className={hintClass}>
          {t('attendance.schedule_intro', 'Late, undertime and absences are checked against this. Hours worked count either way.')}
        </p>
        <div className="space-y-2" role="radiogroup">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={draft.mode === o.key}
              disabled={disabled}
              onClick={() => setDraft((d) => ({ ...d, mode: o.key }))}
              className={cn(
                'w-full text-left rounded-xl border px-4 py-2.5 transition-colors disabled:cursor-default',
                draft.mode === o.key ? 'border-brand-primary bg-brand-primary/5' : 'border-gray-200 hover:bg-gray-50',
              )}
            >
              <span className="block text-sm font-bold text-brand-text">{o.label}</span>
              <span className="block text-xs text-brand-muted">{o.hint}</span>
            </button>
          ))}
        </div>

        {draft.mode === 'own' && (
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t('attendance.start_time', 'Start time')} *</label>
                <OptionalTime
                  value={draft.start}
                  disabled={disabled}
                  onChange={(v) => setDraft((d) => ({ ...d, start: v }))}
                  clearLabel={t('attendance.clear', 'Clear')}
                />
              </div>
              <div>
                <label className={labelClass}>{t('attendance.end_time', 'End time')}</label>
                <OptionalTime value={draft.end} disabled={disabled} onChange={(v) => setDraft((d) => ({ ...d, end: v }))} clearLabel={t('attendance.clear', 'Clear')} />
                <p className={hintClass}>{t('attendance.end_time_hint', 'Optional. An earlier time-out is undertime.')}</p>
              </div>
            </div>
            <div>
              <label className={labelClass}>{t('attendance.rest_days', 'Rest days')}</label>
              <WeekdayPicker value={draft.restDays} onChange={(days) => setDraft((d) => ({ ...d, restDays: days }))} disabled={disabled} />
              <p className={hintClass}>
                {t('attendance.rest_days_hint', 'Never absent on these. The grace period is the branch’s.')}
              </p>
            </div>
          </div>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}

      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !changed || !profile}
            className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold text-sm disabled:opacity-50"
          >
            {saving ? t('attendance.saving', 'Saving…') : t('attendance.schedule_save', 'Save schedule')}
          </button>
        </div>
      )}
    </div>
  );
};
