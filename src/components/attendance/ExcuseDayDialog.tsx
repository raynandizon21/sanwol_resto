import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import { saveExcusedDay, type ExcuseType } from '../../services/attendanceService';
import { formatYmdDisplay } from '../../utils/manilaDateTime';
import { EXCUSE_TYPES, excuseLabel } from './attendanceShared';

interface ExcuseDayDialogProps {
  /** The day to mark (with its current mark, if any); null = closed. */
  target: { employeeId: number; name: string | null; date: string; current: { type: ExcuseType; note: string | null } | null } | null;
  branchId: string | number;
  onClose: () => void;
  onDone: () => void;
  layerClassName?: string;
}

/**
 * Marks one person's day as leave, day off or holiday, so it isn't counted as an absence (and
 * they aren't late on it if they come in). Replaces an earlier mark on that day.
 */
export const ExcuseDayDialog: React.FC<ExcuseDayDialogProps> = ({ target, branchId, onClose, onDone, layerClassName }) => {
  const { t } = useTranslation();
  const [type, setType] = useState<ExcuseType>('leave');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setType(target.current?.type ?? 'leave');
    setNote(target.current?.note ?? '');
    setError(null);
  }, [target]);

  const save = async () => {
    if (!target) return;
    setSaving(true);
    setError(null);
    try {
      await saveExcusedDay(branchId, target.employeeId, target.date, type, note);
      toast.success(t('attendance.excuse_saved', { type: excuseLabel(t, type), defaultValue: `Marked as ${excuseLabel(t, type)}` }));
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.excuse_failed', 'Could not mark the day'));
    } finally {
      setSaving(false);
    }
  };

  const hints: Record<ExcuseType, string> = {
    leave: t('attendance.excuse_leave_hint', 'Approved leave (sick, vacation, emergency…)'),
    day_off: t('attendance.excuse_day_off_hint', 'An extra or swapped day off'),
    holiday: t('attendance.excuse_holiday_hint', 'A holiday for this person only (branch holidays are in Attendance rules)'),
  };

  return (
    <Modal
      isOpen={Boolean(target)}
      onClose={onClose}
      title={t('attendance.excuse_title', 'Mark day')}
      subtitle={
        target ? (
          <span className="text-sm text-brand-muted">
            {target.name || '—'} · {formatYmdDisplay(target.date)}
          </span>
        ) : undefined
      }
      maxWidth="md"
      layerClassName={layerClassName}
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50"
          >
            {saving ? t('attendance.saving', 'Saving…') : t('attendance.save', 'Save')}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2" role="radiogroup">
          {EXCUSE_TYPES.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={type === key}
              onClick={() => setType(key)}
              className={cn(
                'w-full text-left rounded-xl border px-4 py-2.5 transition-colors',
                type === key ? 'border-brand-primary bg-brand-primary/5' : 'border-gray-200 hover:bg-gray-50',
              )}
            >
              <span className="block text-sm font-bold text-brand-text">{excuseLabel(t, key)}</span>
              <span className="block text-xs text-brand-muted">{hints[key]}</span>
            </button>
          ))}
        </div>
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5">{t('attendance.note_optional', 'Note (optional)')}</label>
          <input
            type="text"
            value={note}
            maxLength={255}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('attendance.excuse_note_placeholder', 'e.g. Sick leave, approved by the manager')}
            className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none"
          />
        </div>
        <p className="text-xs text-brand-muted">
          {t('attendance.excuse_effect', "A marked day isn't an absence, and they aren't late on it if they come in.")}
        </p>
        {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}
      </div>
    </Modal>
  );
};
