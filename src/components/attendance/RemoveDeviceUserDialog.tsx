import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { deleteDeviceUser, type DeviceUser } from '../../services/zktecoService';

interface RemoveDeviceUserDialogProps {
  user: DeviceUser | null;
  branchId: string | number;
  deviceOnline: boolean;
  onClose: () => void;
  /** The removal was queued; the page re-fetches to show it in the pending strip. */
  onQueued: () => void;
}

/**
 * Confirms removing a user from the MB160 (DATA DELETE USERINFO). The app keeps the user as
 * removed (soft delete) so past punches keep the name; their biometrics and card are erased.
 */
export const RemoveDeviceUserDialog: React.FC<RemoveDeviceUserDialogProps> = ({
  user,
  branchId,
  deviceOnline,
  onClose,
  onQueued,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [user]);

  if (!user) return null;
  const who = user.name || '—';

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteDeviceUser(branchId, { deviceId: user.deviceId, pin: user.pin });
      toast.success(t('attendance.remove_user_queued', 'Sent to the device. The user is removed once the device confirms.'));
      onQueued();
      onClose();
    } catch (err) {
      setError((err as Error)?.message || t('attendance.remove_user_failed', 'Could not remove the user'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={Boolean(user)}
      onClose={onClose}
      title={t('attendance.remove_user_title', 'Remove from device')}
      subtitle={
        <span className="text-sm text-brand-muted">
          {who}
        </span>
      }
      maxWidth="md"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium">
            {t('common.cancel')}
          </button>
          <button
            onClick={remove}
            disabled={busy}
            className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 font-bold disabled:opacity-50 flex items-center gap-2"
          >
            <Trash2 size={16} />
            {busy ? t('attendance.sending', 'Sending…') : t('attendance.remove_user_confirm', 'Remove from device')}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm font-medium text-brand-text">
        <p>
          {t('attendance.remove_user_body', {
            who,
            defaultValue: `The device deletes ${who} along with their fingerprints, face, card and password. Their past punches stay in Attendance Logs under their name.`,
          })}
        </p>
        <p className="text-brand-muted">
          {t(
            'attendance.remove_user_readd',
            'To bring them back later, add them again (Show deleted → Add again) and enroll their fingerprint or card again.',
          )}
        </p>
        {!deviceOnline && (
          <div className="flex gap-2 bg-orange-50 text-orange-700 rounded-xl px-4 py-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            {t('attendance.remove_user_offline', 'The device is offline. The user is removed when it reconnects; you can cancel until then.')}
          </div>
        )}
        {error && <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl">{error}</div>}
      </div>
    </Modal>
  );
};
