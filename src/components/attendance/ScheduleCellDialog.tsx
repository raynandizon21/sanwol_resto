import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarOff, Eraser, Moon, UserX } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import type { OffDutyType, ScheduleEntry, ScheduleValue, ShiftType } from '../../services/attendanceService';
import { offDutyLabel, scheduleHours, textOn, weekdayOf, weekdaysLabel } from './attendanceShared';

const inputClass =
  'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none tabular-nums';
const sectionTitle = 'text-xs font-bold uppercase tracking-wider text-brand-muted';

const OFF_DUTY_ICONS: Record<OffDutyType, React.ElementType> = { day_off: Moon, leave: CalendarOff, absent: UserX };
// Same colors as the grid (and the day statuses in Attendance Logs).
export const OFF_DUTY_STYLES: Record<OffDutyType, string> = {
  day_off: 'bg-gray-200 text-gray-700',
  leave: 'bg-violet-100 text-violet-800',
  absent: 'bg-red-100 text-red-800',
};

interface ScheduleCellDialogProps {
  isOpen: boolean;
  /** e.g. "Juan Dela Cruz · Nov 6" or "4 people · Nov 6 – Nov 8 (12 days)". */
  summary: string;
  /** The shifts to pick from (each allowed on certain weekdays). */
  shiftTypes: ShiftType[];
  /** The selected dates ("YYYY-MM-DD"): a shift can be picked only when it's allowed on all of them. */
  dates: string[];
  /** The selected days' entry when they all have the same one (to show what's set now). */
  current: ScheduleEntry | null;
  /** Some selected day has an entry (so Clear does something). */
  anySet: boolean;
  onApply: (value: ScheduleValue) => Promise<void>;
  onClose: () => void;
}

/**
 * What to put in the selected schedule days: a shift (one click), a day off, leave or a recorded
 * absence (with an optional note), or clear them (not scheduled). A shift that isn't for every
 * selected weekday (Mid and Whole day are Fri–Sun only) isn't listed, so whatever is picked lands on
 * every selected day. (Custom times were removed 2026-11-06.)
 */
export const ScheduleCellDialog: React.FC<ScheduleCellDialogProps> = ({ isOpen, summary, shiftTypes, dates, current, anySet, onApply, onClose }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // Every shift chip gets the widest one's width, so the chips and the times after them line up.
  const shiftListRef = useRef<HTMLDivElement>(null);
  const [chipWidth, setChipWidth] = useState<number | null>(null);
  // Only the shifts allowed on every selected weekday are listed.
  const selectedWeekdays = [...new Set(dates.map(weekdayOf))];
  const available = shiftTypes.filter((s) => selectedWeekdays.every((d) => s.weekdays.includes(d)));
  const namesKey = available.map((s) => s.name).join('\n');
  useLayoutEffect(() => {
    if (!isOpen) return;
    setChipWidth(null); // measure at natural width first
  }, [isOpen, namesKey]);
  useLayoutEffect(() => {
    if (chipWidth != null || !shiftListRef.current) return;
    const chips = shiftListRef.current.querySelectorAll<HTMLElement>('[data-shift-chip]');
    // offsetWidth ignores the dialog's opening scale animation (getBoundingClientRect wouldn't).
    if (chips.length) setChipWidth(Math.max(...Array.from(chips, (c) => c.offsetWidth)));
  }, [chipWidth, isOpen, namesKey]);
  const [noteFor, setNoteFor] = useState<'leave' | 'absent' | null>(null);
  const [note, setNote] = useState('');

  // A fresh note when the dialog opens (not when the page's data refreshes while it's open, which
  // would wipe a note being typed).
  useEffect(() => {
    if (!isOpen) return;
    setBusy(false);
    setNoteFor(null);
    setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const apply = async (value: ScheduleValue) => {
    setBusy(true);
    try {
      await onApply(value);
    } finally {
      setBusy(false);
    }
  };

  const startNote = (type: 'leave' | 'absent') => {
    setNoteFor(type);
    setNote(current && current.type === type ? current.note ?? '' : '');
  };

  const isCurrentShift = (s: ShiftType) => current?.type === 'shift' && current.shiftTypeId === s.id;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.set_schedule_title', 'Set schedule')}
      subtitle={<span className="text-sm text-brand-muted">{summary}</span>}
      maxWidth="xl"
      footer={
        <div className="flex justify-between gap-2">
          {anySet ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void apply({ type: 'clear' })}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border border-gray-200 text-brand-muted text-sm font-bold hover:text-red-600 hover:border-red-200 hover:bg-red-50 disabled:opacity-50"
              title={t('attendance.clear_days_hint', 'Not scheduled: never late or absent, hours still count')}
            >
              <Eraser size={15} />
              {t('attendance.clear_days', 'Clear')}
            </button>
          ) : (
            <span />
          )}
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium">
            {t('common.cancel')}
          </button>
        </div>
      }
    >
      <div className={cn('space-y-5', busy && 'opacity-60 pointer-events-none')}>
        {/* Shift types: one click sets them. */}
        <div className="space-y-2">
          <p className={sectionTitle}>{t('attendance.shift', 'Shift')}</p>
          {shiftTypes.length === 0 ? (
            <p className="text-sm text-brand-muted">{t('attendance.no_shift_types', 'No shifts yet. Add one to start scheduling.')}</p>
          ) : available.length === 0 ? (
            <p className="text-sm text-brand-muted">{t('attendance.no_shift_for_days', 'No shift is set for all of the selected days.')}</p>
          ) : (
            <div ref={shiftListRef} className="grid grid-cols-2 gap-2">
              {available.map((s) => {
                const everyDay = s.weekdays.length >= 7;
                const days = weekdaysLabel(t, s.weekdays);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void apply({ type: 'shift', shift_type_id: s.id })}
                    className={cn(
                      'flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition hover:shadow-sm',
                      isCurrentShift(s) ? 'border-brand-primary ring-2 ring-brand-primary/20' : 'border-gray-100 hover:border-gray-200',
                    )}
                  >
                    <span
                      data-shift-chip
                      className="px-2 py-1 rounded-md text-xs font-bold min-w-[72px] text-center whitespace-nowrap shrink-0"
                      style={{ backgroundColor: s.color, color: textOn(s.color), width: chipWidth ?? undefined }}
                    >
                      {s.name}
                    </span>
                    <span className="flex flex-col min-w-0">
                      <span className="text-xs font-medium text-brand-text tabular-nums whitespace-nowrap">{scheduleHours(s.start, s.end)}</span>
                      {!everyDay && (
                        <span className="text-[11px] font-bold whitespace-nowrap text-brand-muted">
                          {t('attendance.shift_days_only', { days, defaultValue: `${days} only` })}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Off duty */}
        <div className="space-y-2">
          <p className={sectionTitle}>{t('attendance.off_duty', 'Off duty')}</p>
          <div className="grid grid-cols-3 gap-2">
            {(['day_off', 'leave', 'absent'] as OffDutyType[]).map((type) => {
              const Icon = OFF_DUTY_ICONS[type];
              const selected = noteFor === type || (current?.type === type && noteFor == null);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => (type === 'day_off' ? void apply({ type }) : startNote(type))}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold transition',
                    OFF_DUTY_STYLES[type],
                    selected ? 'ring-2 ring-brand-primary/40' : 'hover:brightness-95',
                  )}
                >
                  <Icon size={15} />
                  {offDutyLabel(t, type)}
                </button>
              );
            })}
          </div>
          {noteFor && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                maxLength={255}
                value={note}
                autoFocus
                placeholder={
                  noteFor === 'leave'
                    ? t('attendance.leave_note_placeholder', 'Note (optional), e.g. Sick leave')
                    : t('attendance.absent_note_placeholder', 'Note (optional), e.g. No call, no show')
                }
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void apply({ type: noteFor, note });
                }}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void apply({ type: noteFor, note })}
                className="px-4 py-2 rounded-xl bg-brand-primary text-white text-sm font-bold hover:bg-brand-primary/90 shrink-0"
              >
                {t('attendance.apply', 'Apply')}
              </button>
            </div>
          )}
          <p className="text-xs text-brand-muted">
            {t(
              'attendance.off_duty_hint',
              'Day off and leave are never absences. Absent counts as an absence (if they punch in anyway, the hours count).',
            )}
          </p>
        </div>
      </div>
    </Modal>
  );
};
