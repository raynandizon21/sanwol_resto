import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Modal } from '../ui/Modal';
import { getAttendanceRules, saveAttendanceRules, type AttendanceRules } from '../../services/attendanceService';

const inputClass =
  'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none disabled:bg-gray-50 disabled:text-brand-muted tabular-nums';
const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';
const hintClass = 'text-xs text-brand-muted mt-1';

interface AttendanceRulesDialogProps {
  isOpen: boolean;
  branchId: string | number;
  branchName: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** One branch's attendance rules (basic time tracking): the standard day and the longest shift. */
export const AttendanceRulesDialog: React.FC<AttendanceRulesDialogProps> = ({ isOpen, branchId, branchName, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [rules, setRules] = useState<AttendanceRules | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setRules(null);
    setError(null);
    getAttendanceRules(branchId)
      .then((res) => {
        setRules(res.rules);
        setCanEdit(res.canEdit);
      })
      .catch((err) => setError((err as Error)?.message || String(err)));
  }, [isOpen, branchId]);

  const set = <K extends keyof AttendanceRules>(key: K, value: AttendanceRules[K]) =>
    setRules((r) => (r ? { ...r, [key]: value } : r));

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

  const numberField = (key: keyof AttendanceRules, label: string, hint: string, step = 1) => (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type="number"
        min={0}
        step={step}
        value={rules ? String(rules[key]) : ''}
        disabled={!canEdit}
        onChange={(e) => set(key, Number(e.target.value) as never)}
        className={inputClass}
      />
      <p className={hintClass}>{hint}</p>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.rules_title', 'Attendance rules')}
      subtitle={branchName ? <span className="text-sm text-brand-muted">{branchName}</span> : undefined}
      maxWidth="lg"
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
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            {numberField(
              'standardHours',
              t('attendance.standard_hours', 'Standard day (hours)'),
              t('attendance.standard_hours_hint_basic', 'Hours a day counted as regular. Time worked past it is shown as "over".'),
              0.5,
            )}
            {numberField('maxShiftHours', t('attendance.max_shift', 'Longest shift (hours)'), t('attendance.max_shift_hint', 'No time-out within this many hours of the time-in means it was forgotten.'))}
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
