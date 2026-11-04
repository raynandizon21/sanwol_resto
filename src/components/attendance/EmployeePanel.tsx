import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Fingerprint, Info, UserRound, Smartphone, CalendarDays } from 'lucide-react';
import { SidePanel } from '../ui/SidePanel';
import { cn } from '../../lib/utils';
import type { DeviceUser } from '../../services/zktecoService';
import { fingerLabel } from './EnrollFingerprintDialog';
import { EmployeeProfileForm } from './EmployeeProfileForm';
import { TimesheetView } from './Timesheet';
import { labelClass } from './profileFields';

const sectionClass = 'rounded-2xl border border-gray-100 p-4 space-y-3';
const sectionTitle = 'flex items-center gap-2 text-sm font-bold text-brand-text';
const softButton =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-brand-primary bg-brand-primary/10 hover:bg-brand-primary/15 transition-colors disabled:opacity-40';

type Tab = 'profile' | 'device' | 'attendance';

interface EmployeePanelProps {
  /** The live row from the page, so fingerprints update while the panel is open. */
  user: DeviceUser | null;
  branchId: string | number;
  deviceOnline: boolean;
  /** Employees (CRUD module device_users) → Edit: the profile (whose name the device follows). */
  canEditDetails: boolean;
  /** Attendance Logs → Add / Edit / Delete, for fixing punches from the Attendance tab. */
  punchPermissions: { canAdd: boolean; canEdit: boolean; canDelete: boolean };
  /** Device Users → Add or Edit: fingerprints (same rule as the server). */
  canEnroll: boolean;
  /** An edit or removal for this user is still waiting for the device. */
  hasPendingChange: boolean;
  onClose: () => void;
  onSaved: () => void;
  onManageFingerprints: (user: DeviceUser) => void;
}

/**
 * One employee, in three tabs:
 * - Profile: app-only details (EmployeeProfileForm).
 * - Device: the name shown on the MB160 (it follows the profile name, so it's only shown here)
 *   and the fingerprints (the enrollment dialog opens on top). Role, password, card and face
 *   aren't managed here: staff punch with fingerprints, and the rest is set on the device itself.
 * - Attendance: their timesheet.
 * Someone removed from the device has only Profile and Attendance.
 */
export const EmployeePanel: React.FC<EmployeePanelProps> = ({
  user,
  branchId,
  deviceOnline,
  canEditDetails,
  punchPermissions,
  canEnroll,
  hasPendingChange,
  onClose,
  onSaved,
  onManageFingerprints,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('profile');

  const userKey = user ? `${user.id}` : null;
  // Fresh form for each user (not on every live refresh of the same user).
  useEffect(() => {
    if (!user) return;
    setTab('profile');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey]);

  if (!user) return null;
  const onDevice = user.active;
  const displayName = user.profile?.fullName || user.name || '—';
  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'profile', label: t('attendance.tab_profile', 'Profile'), icon: UserRound },
    ...(onDevice ? [{ key: 'device' as const, label: t('attendance.tab_device', 'Device'), icon: Smartphone }] : []),
    { key: 'attendance', label: t('attendance.tab_attendance', 'Attendance'), icon: CalendarDays },
  ];

  return (
    <SidePanel
      isOpen={Boolean(user)}
      onClose={onClose}
      title={t('attendance.employee_title', {
        name: displayName,
        pin: user.pin,
        defaultValue: `${displayName} · User ID ${user.pin}`,
      })}
      width="lg"
    >
      <div className="inline-flex bg-gray-100 rounded-xl p-1 gap-1 mb-5" role="tablist">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors',
              tab === key ? 'bg-white text-brand-primary shadow-sm' : 'text-brand-muted hover:text-brand-text',
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {!onDevice && (
        <div className="flex gap-2 bg-gray-50 text-brand-muted rounded-xl px-4 py-3 text-sm font-medium mb-5">
          <Info size={16} className="shrink-0 mt-0.5" />
          {t('attendance.employee_removed_note', 'No longer on the device. Their profile and attendance history are kept.')}
        </div>
      )}

      {tab === 'profile' && <EmployeeProfileForm user={user} branchId={branchId} canEdit={canEditDetails} onSaved={onSaved} />}

      {tab === 'attendance' &&
        (user.employeeId ? (
          <TimesheetView
            key={user.employeeId}
            branchId={branchId}
            employeeId={user.employeeId}
            canAdd={punchPermissions.canAdd && onDevice}
            canEdit={punchPermissions.canEdit}
            canDelete={punchPermissions.canDelete}
          />
        ) : (
          <p className="text-sm text-brand-muted">{t('attendance.profile_missing', "This employee's profile is being created. Refresh in a moment.")}</p>
        ))}

      {tab === 'device' && (
      <div className="space-y-5">
        {hasPendingChange && (
          <div className="flex gap-2 bg-orange-50 text-orange-700 rounded-xl px-4 py-3 text-sm font-medium">
            <Clock size={16} className="shrink-0 mt-0.5" />
            {t(
              'attendance.edit_user_pending',
              'A change for this user is waiting for the device. You can edit again once it is confirmed (or cancel it in "Sending to device").',
            )}
          </div>
        )}
        {!deviceOnline && (
          <div className="flex gap-2 bg-orange-50 border border-orange-100 text-orange-600 rounded-xl px-4 py-3 text-sm font-medium">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            {t('attendance.edit_user_offline', 'This device is offline. Changes are sent when it reconnects.')}
          </div>
        )}

        <div>
          <p className={labelClass}>{t('attendance.name_on_device', 'Name on the device')}</p>
          <p className="text-sm font-bold text-brand-text">{user.name || '—'}</p>
          <p className="text-xs text-brand-muted mt-1">
            {t('attendance.name_on_device_follows', 'It follows the name on the Profile tab: change the name there.')}
          </p>
        </div>

        {/* Fingerprints: separate templates, enrolled through the device's prompt */}
        <div className={sectionClass}>
          <div className="flex items-center justify-between gap-2">
            <p className={sectionTitle}>
              <Fingerprint size={16} className="text-brand-primary" />
              {t('attendance.verify_fingerprint', 'Fingerprint')}
            </p>
            {canEnroll && (
              <button type="button" onClick={() => onManageFingerprints(user)} disabled={hasPendingChange} className={softButton}>
                {user.fingers.length
                  ? t('attendance.edit_user_manage_fingers', 'Add or remove')
                  : t('attendance.enroll_button', 'Enroll fingerprint')}
              </button>
            )}
          </div>
          {user.fingers.length ? (
            <div className="flex flex-wrap gap-1.5">
              {user.fingers.map((fid) => (
                <span key={fid} className="px-2 py-1 rounded-lg bg-gray-50 text-xs font-bold text-brand-text">
                  {fingerLabel(t, fid)}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-brand-muted">{t('attendance.edit_user_no_fingers', 'No fingerprint enrolled')}</p>
          )}
        </div>
      </div>
      )}
    </SidePanel>
  );
};
