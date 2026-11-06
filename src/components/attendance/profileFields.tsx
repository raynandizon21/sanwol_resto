import React from 'react';
import { useTranslation } from 'react-i18next';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';
import type { EmployeeProfile } from '../../services/zktecoService';
import type { EmployeeProfileChanges } from '../../services/attendanceService';

// Shared by the Profile tab (EmployeeProfileForm) and Add employee (AddDeviceUserPanel), so both
// show the same fields with the same rules. The server validates them again (utils/employeeProfile.js).

// The Position dropdown's list; another position can still be typed (same list as the legacy employee metadata).
/**
 * Positions offered in the Position dropdown, by area (alphabetical inside each). Sanwol's front of
 * house positions are from its FOH schedule (November 2026). Any other position can still be typed.
 * The Schedules page groups people in this order.
 */
export const POSITION_GROUPS: { key: string; label: string; i18nKey: string; positions: string[] }[] = [
  {
    key: 'foh',
    label: 'Front of house',
    i18nKey: 'attendance.area_foh',
    positions: [
      'Banchan Attendant',
      'Bartender',
      'Cashier',
      'Grilling & Charcoal Attendant',
      'Grilling Helper/Utility',
      'Waiter',
      'Waitress',
    ],
  },
  { key: 'kitchen', label: 'Kitchen', i18nKey: 'attendance.area_kitchen', positions: ['Kitchen'] },
  { key: 'management', label: 'Management', i18nKey: 'attendance.area_management', positions: ['Manager', 'Supervisor'] },
  { key: 'support', label: 'Support', i18nKey: 'attendance.area_support', positions: ['Cleaning', 'Maintenance', 'Security'] },
];

export const POSITION_SUGGESTIONS = POSITION_GROUPS.flatMap((g) => g.positions);

/**
 * Sort key for grouping people by position: listed positions in dropdown order, then other typed
 * positions alphabetically, then no position.
 */
export const positionRank = (position: string | null | undefined): [number, string] => {
  const p = String(position ?? '').trim();
  if (!p) return [2, ''];
  const i = POSITION_SUGGESTIONS.findIndex((x) => x.toLowerCase() === p.toLowerCase());
  return i >= 0 ? [0, String(i).padStart(3, '0')] : [1, p.toLowerCase()];
};

export const inputClass =
  'w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-brand-primary/20 outline-none disabled:bg-gray-50 disabled:text-brand-muted';
export const labelClass = 'block text-xs font-bold uppercase tracking-wider text-brand-muted mb-1.5';

export type ProfileDraft = {
  firstName: string;
  lastName: string;
  position: string;
  contactNo: string;
  birthdate: string;
  address: string;
  dateStarted: string;
  dateSeparated: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  notes: string;
};

export const toDraft = (p: EmployeeProfile | null | undefined, fallbackFirstName: string | null): ProfileDraft => ({
  firstName: p?.firstName || fallbackFirstName || '',
  lastName: p?.lastName ?? '',
  position: p?.position ?? '',
  contactNo: p?.contactNo ?? '',
  birthdate: p?.birthdate ?? '',
  address: p?.address ?? '',
  dateStarted: p?.dateStarted ?? '',
  dateSeparated: p?.dateSeparated ?? '',
  emergencyContactName: p?.emergencyContactName ?? '',
  emergencyContactPhone: p?.emergencyContactPhone ?? '',
  notes: p?.notes ?? '',
});

export const toChanges = (d: ProfileDraft): EmployeeProfileChanges => ({
  first_name: d.firstName,
  last_name: d.lastName,
  position: d.position,
  contact_no: d.contactNo,
  birthdate: d.birthdate,
  address: d.address,
  date_started: d.dateStarted,
  date_separated: d.dateSeparated,
  emergency_contact_name: d.emergencyContactName,
  emergency_contact_phone: d.emergencyContactPhone,
  notes: d.notes,
});

/** The first problem with a draft (same checks as the server), or null. */
export const draftError = (d: ProfileDraft, t: (key: string, fallback: string) => string): string | null => {
  if (!d.firstName.trim()) return t('attendance.err_first_name', 'First name is required');
  if (d.dateStarted && d.dateSeparated && d.dateSeparated < d.dateStarted) {
    return t('attendance.err_last_day', 'The last day of work is before the hire date');
  }
  return null;
};

// ---- Name on the device ----

// The MB160 shows about 24 characters of a name (server NEW_USER_RULES).
const DEVICE_NAME_MAX = 24;

const chars = (s: string) => Array.from(s);
/** Same cleaning as the server: no tabs, line breaks or control characters, single spaces. */
// eslint-disable-next-line no-control-regex
export const cleanDeviceName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The name shown on the device, from the profile name (mirror of deviceNameFor in
 * server/utils/employeeProfile.js). The first that fits in 24 characters: "First Last";
 * "First L."; fewer first-name words with the initial; fewer first-name words; the first word cut.
 */
export const deviceNameFor = (firstName: string, lastName: string): string => {
  const first = cleanDeviceName(firstName);
  const last = cleanDeviceName(lastName);
  if (!first) return chars(last).slice(0, DEVICE_NAME_MAX).join('').trim();
  const fits = (s: string) => chars(s).length <= DEVICE_NAME_MAX;
  const full = last ? `${first} ${last}` : first;
  if (fits(full)) return full;
  const words = first.split(' ');
  const initial = last ? ` ${chars(last)[0]}.` : '';
  for (const suffix of initial ? [initial, ''] : ['']) {
    for (let n = words.length; n >= 1; n -= 1) {
      const candidate = `${words.slice(0, n).join(' ')}${suffix}`;
      if (fits(candidate)) return candidate;
    }
  }
  return chars(words[0]).slice(0, DEVICE_NAME_MAX).join('').trim();
};

// ---- Fields ----

type SetDraft = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => void;

interface FieldProps {
  draft: ProfileDraft;
  set: SetDraft;
  disabled?: boolean;
}

/** Marks a required field's label (fields without it are optional). */
export const RequiredMark: React.FC = () => (
  <span className="text-red-500 ml-0.5" aria-hidden="true">
    *
  </span>
);

/** A labelled text/date/time input bound to one draft field. `required` adds the * to the label. */
export const DraftInput: React.FC<
  FieldProps & { field: keyof ProfileDraft; label: string } & React.InputHTMLAttributes<HTMLInputElement>
> = ({ draft, set, disabled, field, label, required, ...props }) => (
  <div>
    <label className={labelClass}>
      {label}
      {required && <RequiredMark />}
    </label>
    <input
      value={draft[field] as string}
      disabled={disabled}
      aria-required={required || undefined}
      onChange={(e) => set(field, e.target.value as never)}
      className={cn(inputClass, props.type === 'date' || props.type === 'time' ? 'tabular-nums' : '')}
      {...props}
    />
  </div>
);

/** Position: from the list, or typed. */
export const PositionField: React.FC<FieldProps> = ({ draft, set, disabled }) => {
  const { t } = useTranslation();
  // The list by area, plus a position typed earlier that isn't in it, so it still shows.
  const typed = draft.position && !POSITION_SUGGESTIONS.includes(draft.position) ? draft.position : null;
  const options = [
    { value: '', label: t('attendance.not_set', 'Not set') },
    ...(typed ? [{ value: typed, label: typed }] : []),
    ...POSITION_GROUPS.map((g) => ({ label: t(g.i18nKey, g.label), options: g.positions.map((p) => ({ value: p, label: p })) })),
  ];
  return (
    <div>
      <label className={labelClass}>{t('attendance.position', 'Position')}</label>
      <Select2
        options={options}
        value={draft.position}
        onChange={(v) => set('position', String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 50))}
        clearable={false}
        disabled={disabled}
        creatable
        formatCreateLabel={(input) => t('attendance.position_use_typed', { value: input, defaultValue: `Use "${input}"` })}
      />
    </div>
  );
};

/** Contact, birthdate, address, emergency contact and notes. */
export const ContactFields: React.FC<FieldProps> = ({ draft, set, disabled }) => {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <DraftInput draft={draft} set={set} disabled={disabled} field="contactNo" label={t('attendance.contact_no', 'Contact no.')} maxLength={20} inputMode="tel" />
        <DraftInput draft={draft} set={set} disabled={disabled} field="birthdate" label={t('attendance.birthdate', 'Birthdate')} type="date" />
      </div>
      <DraftInput draft={draft} set={set} disabled={disabled} field="address" label={t('attendance.address', 'Address')} maxLength={255} />
      <div className="grid grid-cols-2 gap-3">
        <DraftInput draft={draft} set={set} disabled={disabled} field="emergencyContactName" label={t('attendance.emergency_name', 'Emergency contact')} maxLength={100} />
        <DraftInput draft={draft} set={set} disabled={disabled} field="emergencyContactPhone" label={t('attendance.emergency_phone', 'Emergency phone')} maxLength={20} inputMode="tel" />
      </div>
      <div>
        <label className={labelClass}>{t('attendance.notes', 'Notes')}</label>
        <textarea
          value={draft.notes}
          maxLength={255}
          rows={2}
          disabled={disabled}
          onChange={(e) => set('notes', e.target.value)}
          className={inputClass}
        />
      </div>
    </>
  );
};
