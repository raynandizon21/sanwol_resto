import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import {
  createShiftType,
  removeShiftType,
  updateShiftType,
  type ShiftType,
  type ShiftTypeInput,
} from '../../services/attendanceService';
import { formatMinutes, scheduleHours, textOn } from './attendanceShared';

const inputClass =
  'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none tabular-nums';
const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';

/** Colors offered for shift types (the seeded ones first, then distinct others). */
export const SHIFT_COLORS = [
  '#FCD34D', '#78350F', '#15803D', '#C2410C', '#2563EB', '#7C3AED',
  '#DB2777', '#0D9488', '#65A30D', '#0284C7', '#B91C1C', '#475569',
];

/** Minutes between two "HH:MM" (an end at or before the start is the next day). */
const lengthOf = (start: string, end: string) => {
  const toM = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const diff = toM(end) - toM(start);
  return diff > 0 ? diff : diff + 1440;
};

const EMPTY: ShiftTypeInput = { name: '', start: '', end: '', color: SHIFT_COLORS[4] };

interface ShiftTypesDialogProps {
  isOpen: boolean;
  branchId: string | number;
  shiftTypes: ShiftType[];
  permissions: { add: boolean; edit: boolean; remove: boolean };
  onClose: () => void;
  /** After any change (the page reloads its schedule). */
  onChanged: () => void;
}

/**
 * A branch's shift types (Opening 10:00 AM – 7:00 PM, ...): add, edit, remove. Editing a shift's
 * times changes today's and later days that have it; past days keep the times they were worked
 * under. Removing one takes it off the list; days already given it keep it.
 */
export const ShiftTypesDialog: React.FC<ShiftTypesDialogProps> = ({ isOpen, branchId, shiftTypes, permissions, onClose, onChanged }) => {
  const { t } = useTranslation();
  const [list, setList] = useState<ShiftType[]>([]);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<ShiftTypeInput>(EMPTY);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setList(shiftTypes.filter((s) => s.active));
    setEditingId(null);
    setConfirmRemove(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const startEdit = (s: ShiftType | null) => {
    setConfirmRemove(null);
    setEditingId(s ? s.id : 'new');
    setDraft(s ? { name: s.name, start: s.start, end: s.end, color: s.color } : { ...EMPTY, color: SHIFT_COLORS.find((c) => !list.some((x) => x.color === c)) ?? EMPTY.color });
  };

  const valid = draft.name.trim() !== '' && /^\d{2}:\d{2}$/.test(draft.start) && /^\d{2}:\d{2}$/.test(draft.end) && draft.start !== draft.end;

  const save = async () => {
    if (!valid || editingId == null) return;
    setBusy(true);
    try {
      if (editingId === 'new') {
        setList(await createShiftType(branchId, { ...draft, name: draft.name.trim() }));
        toast.success(t('attendance.shift_type_added', 'Shift added'));
      } else {
        const res = await updateShiftType(branchId, editingId, { ...draft, name: draft.name.trim() });
        setList(res.shiftTypes);
        toast.success(
          res.updatedDays
            ? t('attendance.shift_type_saved_days', {
                count: res.updatedDays,
                defaultValue: `Shift saved. ${res.updatedDays} day(s) from today on now use the new times.`,
              })
            : t('attendance.shift_type_saved', 'Shift saved'),
        );
      }
      setEditingId(null);
      onChanged();
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.shift_type_failed', 'Could not save the shift'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      setList(await removeShiftType(branchId, id));
      setConfirmRemove(null);
      toast.success(t('attendance.shift_type_removed', 'Shift removed'));
      onChanged();
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.shift_type_failed', 'Could not save the shift'));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <div className="rounded-2xl border border-brand-primary/30 bg-brand-primary/5 p-4 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-3">
          <label className={labelClass}>{t('attendance.shift_name', 'Name')}</label>
          <input
            type="text"
            maxLength={40}
            value={draft.name}
            placeholder={t('attendance.shift_name_placeholder', 'e.g. Opening')}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>{t('attendance.time_in', 'Time in')}</label>
          <input type="time" value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>{t('attendance.time_out', 'Time out')}</label>
          <input type="time" value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} className={inputClass} />
        </div>
        <div className="flex items-end pb-2 text-xs font-medium text-brand-muted">
          {draft.start && draft.end && draft.start !== draft.end
            ? `${formatMinutes(lengthOf(draft.start, draft.end))}${draft.end < draft.start ? ` · ${t('attendance.ends_next_day', 'ends the next day')}` : ''}`
            : ''}
        </div>
      </div>
      <div>
        <label className={labelClass}>{t('attendance.shift_color', 'Color')}</label>
        <div className="flex flex-wrap gap-2">
          {SHIFT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, color: c }))}
              aria-label={c}
              aria-pressed={draft.color === c}
              className={cn('w-8 h-8 rounded-lg flex items-center justify-center ring-offset-2 transition', draft.color === c && 'ring-2 ring-brand-primary')}
              style={{ backgroundColor: c }}
            >
              {draft.color === c && <Check size={14} color={textOn(c)} />}
            </button>
          ))}
        </div>
      </div>
      {editingId !== 'new' && (
        <p className="text-xs text-brand-muted">
          {t('attendance.shift_edit_hint', 'New times apply to days with this shift from today on. Past days keep the times they were worked under.')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg bg-white text-brand-muted text-sm font-medium hover:bg-gray-100">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || busy}
          className="px-3 py-1.5 rounded-lg bg-brand-primary text-white text-sm font-bold hover:bg-brand-primary/90 disabled:opacity-50"
        >
          {busy ? t('attendance.saving', 'Saving…') : t('attendance.save', 'Save')}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.shift_types_title', 'Shift types')}
      subtitle={
        <span className="text-sm text-brand-muted">
          {t('attendance.shift_types_hint', 'The shifts you pick from on the schedule. A day can also have custom times.')}
        </span>
      }
      maxWidth="lg"
      footer={
        <div className="flex justify-between gap-2">
          {permissions.add && editingId == null ? (
            <button
              type="button"
              onClick={() => startEdit(null)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-primary/10 text-brand-primary text-sm font-bold hover:bg-brand-primary/15"
            >
              <Plus size={15} />
              {t('attendance.add_shift_type', 'Add shift')}
            </button>
          ) : (
            <span />
          )}
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium">
            {t('attendance.close', 'Close')}
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        {list.length === 0 && editingId == null && (
          <p className="text-sm text-brand-muted">{t('attendance.no_shift_types', 'No shifts yet. Add one to start scheduling.')}</p>
        )}
        {list.map((s) =>
          editingId === s.id ? (
            <React.Fragment key={s.id}>{form}</React.Fragment>
          ) : (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border border-gray-100 px-3 py-2.5">
              <span
                className="px-2.5 py-1 rounded-lg text-xs font-bold min-w-[84px] text-center whitespace-nowrap shrink-0"
                style={{ backgroundColor: s.color, color: textOn(s.color) }}
              >
                {s.name}
              </span>
              <span className="flex-1 text-sm text-brand-text tabular-nums">
                {scheduleHours(s.start, s.end)}
                <span className="text-brand-muted"> · {formatMinutes(lengthOf(s.start, s.end))}</span>
              </span>
              {confirmRemove === s.id ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-brand-muted">{t('attendance.shift_remove_confirm', 'Remove? Days already given it keep it.')}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(s.id)}
                    className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-50"
                  >
                    {t('attendance.remove', 'Remove')}
                  </button>
                  <button type="button" onClick={() => setConfirmRemove(null)} className="px-2.5 py-1 rounded-lg bg-gray-100 text-brand-muted font-medium">
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <span className="flex gap-0.5">
                  {permissions.edit && (
                    <button
                      type="button"
                      disabled={editingId != null}
                      onClick={() => startEdit(s)}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-brand-primary hover:bg-brand-primary/10 disabled:opacity-40"
                      aria-label={t('attendance.edit_shift_type', 'Edit shift')}
                      title={t('attendance.edit_shift_type', 'Edit shift')}
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                  {permissions.remove && (
                    <button
                      type="button"
                      disabled={editingId != null}
                      onClick={() => setConfirmRemove(s.id)}
                      className="p-1.5 rounded-lg text-brand-muted hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                      aria-label={t('attendance.remove_shift_type', 'Remove shift')}
                      title={t('attendance.remove_shift_type', 'Remove shift')}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </span>
              )}
            </div>
          ),
        )}
        {editingId === 'new' && form}
      </div>
    </Modal>
  );
};
