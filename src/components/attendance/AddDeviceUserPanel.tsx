import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Info, AlertTriangle, Contact, Smartphone } from 'lucide-react';
import { SidePanel } from '../ui/SidePanel';
import { Select2 } from '../ui/Select2';
import { cn } from '../../lib/utils';
import { createDeviceUser, type EmployeeProfile, type ZkDevice } from '../../services/zktecoService';
import {
  ContactFields,
  DraftInput,
  PositionField,
  RequiredMark,
  deviceNameFor,
  draftError,
  inputClass,
  labelClass,
  toChanges,
  toDraft,
  type ProfileDraft,
} from './profileFields';

// Same rule the server enforces (server/controllers/zktecoController.js NEW_USER_RULES).
const PIN_RE = /^[1-9]\d{0,8}$/;

const sectionClass = 'rounded-2xl border border-gray-100 p-4 space-y-4';
const sectionTitle = 'flex items-center gap-2 text-sm font-bold text-brand-text';

interface AddDeviceUserPanelProps {
  isOpen: boolean;
  onClose: () => void;
  branchId: string | number;
  devices: ZkDevice[];
  /** PINs already used (or waiting to be added) per device id. */
  takenPins: Map<number, Set<string>>;
  /** The user was queued for the device (the page can go straight to fingerprint enrollment). */
  onQueued: (user: { deviceId: number; pin: string; name: string }) => void;
  /**
   * "Add again" for a removed user: their device name and saved profile, and their old User ID
   * if it's still free. They get a new user record either way (a removed one is never
   * reactivated); `userId` is the removed record, hidden from Show deleted once the device
   * confirms the add. Their profile is kept and updated with what's entered here.
   */
  prefill?: { userId: number; deviceId: number; name: string; pin: string; profile: EmployeeProfile | null } | null;
}

const nextFreePin = (taken: Set<string> | undefined) => {
  let max = 0;
  taken?.forEach((pin) => {
    const n = Number(pin);
    if (Number.isInteger(n) && n > max) max = n;
  });
  return String(max + 1);
};

/**
 * Adds an employee: queues them for the MB160 as a regular user (no password; they punch with
 * their fingerprint, enrolled next) and saves their profile once the device confirms them. The
 * name on the device is made from their name (shortened to fit) and shown, not typed.
 */
export const AddDeviceUserPanel: React.FC<AddDeviceUserPanelProps> = ({
  isOpen,
  onClose,
  branchId,
  devices,
  takenPins,
  onQueued,
  prefill,
}) => {
  const { t } = useTranslation();
  // Set when "Add again" couldn't reuse the old User ID (someone else has it now).
  const [oldPinTaken, setOldPinTaken] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(null, ''));
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fresh form each time the panel opens, with the next free User ID suggested
  // (or, for "Add again", the old one when it's still free, and their saved details).
  useEffect(() => {
    if (!isOpen) return;
    const id = prefill?.deviceId ?? (devices.length === 1 ? devices[0].id : null);
    const taken = id != null ? takenPins.get(id) : undefined;
    const reuseOldPin = prefill != null && !taken?.has(prefill.pin);
    setDeviceId(id);
    setPin(reuseOldPin ? prefill.pin : id != null ? nextFreePin(taken) : '');
    setDraft(toDraft(prefill?.profile ?? null, prefill?.name ?? ''));
    setOldPinTaken(prefill != null && !reuseOldPin ? prefill.pin : null);
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const device = devices.find((d) => d.id === deviceId) ?? null;
  // What the device will show (the server makes it the same way).
  const deviceName = deviceNameFor(draft.firstName, draft.lastName);

  const errors = useMemo(() => {
    const e: { deviceId?: string; pin?: string; profile?: string } = {};
    if (deviceId == null) e.deviceId = t('attendance.err_device', 'Choose a device');
    if (!PIN_RE.test(pin)) {
      e.pin = t('attendance.err_pin', 'User ID must be 1–9 digits and not start with 0');
    } else if (deviceId != null && takenPins.get(deviceId)?.has(pin)) {
      e.pin = t('attendance.err_pin_taken', 'This User ID is already on the device');
    }
    const problem = draftError(draft, (key, fallback) => t(key, fallback));
    if (problem) e.profile = problem;
    return e;
  }, [deviceId, pin, draft, takenPins, t]);

  const fieldError = (message: string | undefined) =>
    submitted && message ? <p className="text-xs text-red-500 font-medium mt-1">{message}</p> : null;

  const handleSubmit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || deviceId == null) return;
    setIsSubmitting(true);
    try {
      await createDeviceUser(branchId, {
        deviceId,
        pin,
        // Every field is sent; for someone added again it replaces their saved profile.
        profile: toChanges(draft),
        readdOf: prefill && prefill.deviceId === deviceId ? prefill.userId : undefined,
      });
      toast.success(
        t('attendance.user_queued', 'Sent to the device. The user appears in the list once the device confirms.'),
      );
      onQueued({ deviceId, pin, name: deviceName });
      onClose();
    } catch (err) {
      toast.error((err as Error)?.message || t('attendance.user_queue_failed', 'Could not add the user'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldProps = { draft, set };

  return (
    <SidePanel
      isOpen={isOpen}
      onClose={onClose}
      title={t('attendance.add_employee', 'Add employee')}
      width="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50"
          >
            {isSubmitting ? t('attendance.sending', 'Sending…') : t('attendance.send_to_device', 'Send to device')}
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-2 bg-brand-primary/5 border border-brand-primary/20 text-brand-primary rounded-xl px-4 py-3 text-sm font-medium">
          <Info size={16} className="shrink-0 mt-0.5" />
          <span>
            {t(
              'attendance.add_employee_notice',
              'The device picks up the new employee within about 10 seconds. Next, you can enroll their fingerprint from here; the device will ask them to scan it. Fields marked * are required; the rest can be filled in later on their Profile.',
            )}
          </span>
        </div>

        {device && !device.isOnline && (
          <div className="flex gap-2 bg-orange-50 border border-orange-100 text-orange-600 rounded-xl px-4 py-3 text-sm font-medium">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              {t(
                'attendance.device_offline_notice',
                'This device is offline. The user will be added when it reconnects.',
              )}
            </span>
          </div>
        )}

        {/* Basics */}
        <div className={sectionClass}>
          {devices.length > 1 && (
            <div>
              <label className={labelClass}>{t('attendance.device', 'Device')}</label>
              <Select2
                options={devices.map((d) => ({
                  value: d.id,
                  label: `${d.name} (${d.serialNo})${d.branchName ? ` · ${d.branchName}` : ''}`,
                }))}
                value={deviceId}
                onChange={(v) => {
                  const id = v == null ? null : Number(v);
                  setDeviceId(id);
                  if (id != null) setPin(nextFreePin(takenPins.get(id)));
                }}
                placeholder={t('attendance.choose_device', 'Choose a device')}
              />
              {fieldError(errors.deviceId)}
            </div>
          )}

          <div>
            <label className={labelClass}>
              {t('attendance.pin', 'User ID')}
              <RequiredMark />
            </label>
            <input
              type="text"
              inputMode="numeric"
              aria-required
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 9))}
              className={cn(inputClass, 'tabular-nums')}
            />
            <p className="text-xs text-brand-muted mt-1">
              {t('attendance.pin_hint', 'The number the employee types or is matched by on the device.')}
            </p>
            {oldPinTaken && (
              <p className="text-xs text-orange-600 font-medium mt-1">
                {t('attendance.add_again_pin_taken', {
                  pin: oldPinTaken,
                  defaultValue: `Their old User ID ${oldPinTaken} now belongs to someone else, so the next free one is suggested.`,
                })}
              </p>
            )}
            {fieldError(errors.pin)}
          </div>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <DraftInput
                {...fieldProps}
                field="firstName"
                label={t('attendance.first_name', 'First name')}
                required
                maxLength={100}
                placeholder={t('attendance.first_name_placeholder', 'e.g. Juan')}
              />
              <DraftInput
                {...fieldProps}
                field="lastName"
                label={t('attendance.last_name', 'Last name')}
                maxLength={100}
                placeholder={t('attendance.last_name_placeholder', 'e.g. Dela Cruz')}
              />
            </div>
            {deviceName && (
              <p className="flex items-center gap-1.5 text-xs text-brand-muted mt-1.5">
                <Smartphone size={12} className="shrink-0" />
                {t('attendance.shown_on_device', { name: deviceName, defaultValue: `Shown on the device as: ${deviceName}` })}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <PositionField {...fieldProps} />
            <DraftInput {...fieldProps} field="dateStarted" label={t('attendance.date_hired', 'Date hired')} type="date" />
            {prefill?.profile?.dateSeparated && (
              <DraftInput {...fieldProps} field="dateSeparated" label={t('attendance.last_day', 'Last day of work')} type="date" />
            )}
          </div>
          {prefill?.profile?.dateSeparated && (
            <p className="text-xs text-orange-600 font-medium -mt-2">
              {t(
                'attendance.add_again_last_day_basic',
                "They have a last day of work saved. If they're working here again, clear it (and update the date hired if needed).",
              )}
            </p>
          )}
        </div>

        {/* Contact and other details (optional) */}
        <div className={sectionClass}>
          <p className={sectionTitle}>
            <Contact size={16} className="text-brand-primary" />
            {t('attendance.more_details', 'Contact and other details')}
          </p>
          <ContactFields {...fieldProps} />
        </div>

        {submitted && errors.profile && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{errors.profile}</div>
        )}
      </div>
    </SidePanel>
  );
};
