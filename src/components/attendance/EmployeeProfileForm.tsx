import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Info, Link2, Smartphone } from 'lucide-react';
import { Select2 } from '../ui/Select2';
import type { DeviceUser } from '../../services/zktecoService';
import {
  getFormerEmployees,
  linkFormerEmployee,
  updateEmployeeProfile,
  type FormerEmployee,
} from '../../services/attendanceService';
import { formatYmdDisplay } from '../../utils/manilaDateTime';
import {
  ContactFields,
  DraftInput,
  PositionField,
  deviceNameFor,
  draftError,
  toChanges,
  toDraft,
  type ProfileDraft,
} from './profileFields';

const sectionClass = 'rounded-2xl border border-gray-100 p-4 space-y-4';
const sectionTitle = 'flex items-center gap-2 text-sm font-bold text-brand-text';

interface EmployeeProfileFormProps {
  user: DeviceUser;
  branchId: string | number;
  /** Employees → Edit. Without it the form is read-only. */
  canEdit: boolean;
  onSaved: () => void;
}

/**
 * The app-only part of an employee: details the device doesn't keep. The name on the device
 * follows the name here (saving a new name queues it for the device, shortened to fit).
 */
export const EmployeeProfileForm: React.FC<EmployeeProfileFormProps> = ({ user, branchId, canEdit, onSaved }) => {
  const { t } = useTranslation();
  const profile = user.profile;
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile, user.name));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [former, setFormer] = useState<FormerEmployee[] | null>(null);
  const [linkTo, setLinkTo] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);

  // Fresh form per person (not on every live refresh of the same one).
  useEffect(() => {
    setDraft(toDraft(profile, user.name));
    setError(null);
    setFormer(null);
    setLinkTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const changed = JSON.stringify(draft) !== JSON.stringify(toDraft(profile, user.name));
  const disabled = !canEdit || !profile;

  const save = async () => {
    if (!profile) return;
    const problem = draftError(draft, (key, fallback) => t(key, fallback));
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { deviceRename } = await updateEmployeeProfile(branchId, profile.id, toChanges(draft));
      toast.success(
        deviceRename
          ? t('attendance.profile_saved_renamed', {
              name: deviceRename,
              defaultValue: `Employee saved. The device will show "${deviceRename}" once it confirms.`,
            })
          : t('attendance.profile_saved', 'Employee saved'),
      );
      onSaved();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.profile_save_failed', 'Could not save the employee'));
    } finally {
      setSaving(false);
    }
  };

  const loadFormer = async () => {
    try {
      setFormer(await getFormerEmployees(branchId));
    } catch (err) {
      setError((err as Error)?.message || String(err));
    }
  };

  const link = async () => {
    if (!linkTo) return;
    setLinking(true);
    setError(null);
    try {
      await linkFormerEmployee(branchId, user.id, linkTo);
      toast.success(t('attendance.link_done', 'Linked. Their earlier details and attendance are back.'));
      setFormer(null);
      onSaved();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.link_failed', 'Could not link the employee'));
    } finally {
      setLinking(false);
    }
  };

  const fieldProps = { draft, set, disabled };
  // The name the device would get from the name typed here.
  const nextDeviceName = deviceNameFor(draft.firstName, draft.lastName);

  return (
    <div className="space-y-5">
      {!profile && (
        <div className="flex gap-2 bg-orange-50 text-orange-700 rounded-xl px-4 py-3 text-sm font-medium">
          <Info size={16} className="shrink-0 mt-0.5" />
          {t('attendance.profile_missing', "This employee's profile is being created. Refresh in a moment.")}
        </div>
      )}

      <div className={sectionClass}>
        <div className="grid grid-cols-2 gap-3">
          <DraftInput {...fieldProps} field="firstName" label={t('attendance.first_name', 'First name')} required maxLength={100} />
          <DraftInput {...fieldProps} field="lastName" label={t('attendance.last_name', 'Last name')} maxLength={100} />
        </div>
        {user.active && (
          <p className="flex items-center gap-1.5 text-xs text-brand-muted -mt-2">
            <Smartphone size={12} className="shrink-0" />
            {nextDeviceName && nextDeviceName !== user.name
              ? t('attendance.device_name_will_change', {
                  from: user.name || '—',
                  to: nextDeviceName,
                  defaultValue: `Shown on the device as: ${user.name || '—'}. Saving changes it to: ${nextDeviceName}`,
                })
              : t('attendance.shown_on_device', { name: user.name || '—', defaultValue: `Shown on the device as: ${user.name || '—'}` })}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <PositionField {...fieldProps} />
          <DraftInput {...fieldProps} field="dateStarted" label={t('attendance.date_hired', 'Date hired')} type="date" />
          <DraftInput {...fieldProps} field="dateSeparated" label={t('attendance.last_day', 'Last day of work')} type="date" />
        </div>
        <ContactFields {...fieldProps} />
      </div>

      {/* Someone added back directly on the device gets a new profile; this joins them to their old one. */}
      {canEdit && user.active && profile && (
        <div className={sectionClass}>
          <p className={sectionTitle}>
            <Link2 size={16} className="text-brand-primary" />
            {t('attendance.returning_title', 'Returning employee?')}
          </p>
          {former == null ? (
            <button type="button" onClick={() => void loadFormer()} className="text-xs font-bold text-brand-primary hover:underline">
              {t('attendance.returning_link', 'Link this user to a former employee\'s profile')}
            </button>
          ) : former.length === 0 ? (
            <p className="text-xs text-brand-muted">{t('attendance.returning_none', 'There are no former employees in this branch.')}</p>
          ) : (
            <div className="space-y-2">
              <Select2
                options={former.map((f) => ({
                  value: f.id,
                  label: `${f.name || '—'}${f.position ? ` · ${f.position}` : ''}${f.dateSeparated ? ` · ${t('attendance.left_on', 'left')} ${formatYmdDisplay(f.dateSeparated)}` : ''}`,
                }))}
                value={linkTo}
                onChange={(v) => setLinkTo(v == null ? null : Number(v))}
                placeholder={t('attendance.choose_former', 'Choose a former employee')}
              />
              <p className="text-xs text-orange-700">
                {t(
                  'attendance.returning_warning',
                  'Their old profile and attendance history replace what is on this profile now. Details entered here for this user are dropped.',
                )}
              </p>
              <button
                type="button"
                disabled={!linkTo || linking}
                onClick={() => void link()}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-brand-primary hover:bg-brand-primary/90 disabled:opacity-50"
              >
                {linking ? t('attendance.saving', 'Saving…') : t('attendance.link_confirm', 'Link')}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>}

      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !changed || !profile}
            className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold text-sm disabled:opacity-50"
          >
            {saving ? t('attendance.saving', 'Saving…') : t('attendance.profile_save', 'Save profile')}
          </button>
        </div>
      )}
    </div>
  );
};
