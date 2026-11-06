import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { motion } from 'framer-motion';
import {
  Fingerprint,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Loader2,
  Trash2,
  Check,
  Hand,
  Info,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { cn } from '../../lib/utils';
import {
  cancelEnrollment,
  getEnrollment,
  removeFingerprint,
  startFingerprintEnrollment,
  type Enrollment,
} from '../../services/zktecoService';

// ZKTeco finger numbers (FID): 0-4 = left hand little → thumb, 5-9 = right hand thumb → little.
const LEFT_HAND = [0, 1, 2, 3, 4];
const RIGHT_HAND = [5, 6, 7, 8, 9];
const FINGER_KEYS: Record<number, [string, string]> = {
  0: ['attendance.finger_little', 'Little'],
  1: ['attendance.finger_ring', 'Ring'],
  2: ['attendance.finger_middle', 'Middle'],
  3: ['attendance.finger_index', 'Index'],
  4: ['attendance.finger_thumb', 'Thumb'],
  5: ['attendance.finger_thumb', 'Thumb'],
  6: ['attendance.finger_index', 'Index'],
  7: ['attendance.finger_middle', 'Middle'],
  8: ['attendance.finger_ring', 'Ring'],
  9: ['attendance.finger_little', 'Little'],
};

export const fingerLabel = (t: TFunction, fid: number) =>
  `${fid < 5 ? t('attendance.hand_left', 'Left') : t('attendance.hand_right', 'Right')} ${t(FINGER_KEYS[fid][0], FINGER_KEYS[fid][1]).toLowerCase()}`;

const POLL_MS = 1500;
/** The MB160 keeps its prompt open about this long (RETRY=3). */
const PROMPT_SECONDS = 60;
/** After "enrolled", keep checking this long for the template copy (it can arrive just after). */
const TEMPLATE_FOLLOW_MS = 25000;
const FINAL_STATES = new Set(['enrolled', 'removed', 'timed_out', 'duplicate', 'expired', 'cancelled', 'failed']);

export interface EnrollTarget {
  deviceId: number;
  pin: string;
  name: string | null;
  fingers: number[];
  deviceOnline: boolean;
  /** Just added from the app; the device creates the user right before prompting. */
  justAdded?: boolean;
}

interface EnrollFingerprintDialogProps {
  target: EnrollTarget | null;
  branchId: string | number;
  onClose: () => void;
  /** Called when a fingerprint was enrolled or removed (the list re-fetches). */
  onChanged: () => void;
}

/**
 * Picks a finger and makes the MB160 prompt for it (ENROLL_FP), following the result live.
 * Enrolled fingers are greyed out: the device rejects scanning an enrolled finger again
 * (even for the same user), so re-enrolling means removing it first (DATA DELETE FINGERTMP).
 */
export const EnrollFingerprintDialog: React.FC<EnrollFingerprintDialogProps> = ({
  target,
  branchId,
  onClose,
  onChanged,
}) => {
  const { t } = useTranslation();
  // Nothing is selected until the user clicks a finger.
  const [finger, setFinger] = useState<number | null>(null);
  // Enroll/remove results from this dialog, in order, applied on top of target.fingers.
  const [changes, setChanges] = useState<Array<{ finger: number; enrolled: boolean }>>([]);
  const [job, setJob] = useState<Enrollment | null>(null);
  const jobRef = useRef<Enrollment | null>(null);
  jobRef.current = job;
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptStartedAt, setPromptStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const enrolled = new Set(target?.fingers ?? []);
  for (const c of changes) {
    if (c.enrolled) enrolled.add(c.finger);
    else enrolled.delete(c.finger);
  }

  // Fresh state for each user (and stop following anything when the dialog closes).
  useEffect(() => {
    setJob(null);
    setChanges([]);
    setError(null);
    setConfirmRemove(false);
    setPromptStartedAt(null);
    setFinishedAt(null);
    setFinger(null);
  }, [target]);

  const following =
    job &&
    (!FINAL_STATES.has(job.state) ||
      // the template copy can land a few seconds after "enrolled"
      (job.state === 'enrolled' && !job.templateReceived && finishedAt != null && now - finishedAt < TEMPLATE_FOLLOW_MS));

  useEffect(() => {
    if (!job || !following) return;
    const id = window.setInterval(async () => {
      setNow(Date.now());
      try {
        const next = await getEnrollment(branchId, job.commandId);
        const prev = jobRef.current;
        if (!prev || prev.commandId !== next.commandId) return; // closed or replaced meanwhile
        if (!FINAL_STATES.has(prev.state) && FINAL_STATES.has(next.state)) {
          setFinishedAt(Date.now());
          if ((next.state === 'enrolled' || next.state === 'removed') && next.finger != null) {
            setChanges((c) => [...c, { finger: next.finger as number, enrolled: next.state === 'enrolled' }]);
            onChangedRef.current();
          }
        }
        if (prev.state !== 'prompting' && next.state === 'prompting') setPromptStartedAt(Date.now());
        setJob(next);
      } catch {
        // keep following; a blip shouldn't end the dialog
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [job?.commandId, following, branchId]);

  // Countdown while the device shows its prompt.
  useEffect(() => {
    if (job?.state !== 'prompting') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [job?.state]);

  if (!target) return null;

  const selectedEnrolled = finger != null && enrolled.has(finger);
  const selectedLabel = finger != null ? fingerLabel(t, finger) : '';
  const who = target.name || '—';

  const run = async (kind: 'enroll' | 'remove') => {
    if (finger == null) return;
    setBusy(true);
    setError(null);
    setConfirmRemove(false);
    setPromptStartedAt(null);
    setFinishedAt(null);
    try {
      const params = { deviceId: target.deviceId, pin: target.pin, finger };
      const { commandId } =
        kind === 'enroll' ? await startFingerprintEnrollment(branchId, params) : await removeFingerprint(branchId, params);
      setJob({ commandId, kind, pin: target.pin, finger, state: 'waiting', returnCode: null, templateReceived: false });
    } catch (err) {
      setError((err as Error)?.message || t('attendance.enroll_start_failed', 'Could not start enrollment'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await cancelEnrollment(branchId, job.commandId);
      setJob({ ...job, state: 'cancelled' });
    } catch (err) {
      setError((err as Error)?.message || '');
    }
  };

  /** Back to the finger picker; `fid` preselects a finger (only after removing it, to enroll it again). */
  const backToPicker = (fid?: number) => {
    setJob(null);
    setError(null);
    setConfirmRemove(false);
    setFinger(fid ?? null);
  };

  const secondsLeft = promptStartedAt
    ? Math.max(0, PROMPT_SECONDS - Math.round((now - promptStartedAt) / 1000))
    : PROMPT_SECONDS;
  const jobFingerId = job?.finger ?? finger;
  const jobFinger = jobFingerId != null ? fingerLabel(t, jobFingerId) : '';

  // One full-width row per hand: side by side, ten buttons in this dialog were too narrow for their labels.
  const renderHand = (title: string, fids: number[], mirrored: boolean) => (
    <div className="rounded-2xl bg-gray-50 p-3">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-muted mb-2.5 px-0.5">
        <Hand size={14} className={cn(mirrored && '-scale-x-100')} />
        {title}
      </p>
      <div className="grid grid-cols-5 gap-2">
        {fids.map((fid) => {
          const isEnrolled = enrolled.has(fid);
          const isSelected = finger === fid;
          const label = t(FINGER_KEYS[fid][0], FINGER_KEYS[fid][1]);
          return (
            <button
              key={fid}
              type="button"
              onClick={() => {
                setFinger(fid);
                setConfirmRemove(false);
              }}
              aria-pressed={isSelected}
              title={isEnrolled ? `${label} · ${t('attendance.finger_enrolled', 'Already enrolled')}` : label}
              className={cn(
                'relative flex h-[68px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 text-xs font-semibold transition-all',
                isSelected
                  ? isEnrolled
                    ? 'border-gray-400 bg-white text-gray-600 ring-2 ring-gray-300/60'
                    : 'border-brand-primary bg-white text-brand-primary ring-2 ring-brand-primary/20'
                  : isEnrolled
                    ? 'border-transparent bg-gray-100 text-gray-400 hover:bg-gray-200/70'
                    : 'border-gray-200 bg-white text-brand-text hover:border-brand-primary/40 hover:bg-brand-primary/[0.03]',
              )}
            >
              <Fingerprint size={20} strokeWidth={1.75} />
              <span className="max-w-full truncate leading-4">{label}</span>
              {isEnrolled && (
                <span className="absolute top-1.5 right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-green-500 text-white">
                  <Check size={9} strokeWidth={3.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  const box = (tone: string, icon: React.ReactNode, title: string, body: React.ReactNode) => (
    <div className={cn('flex gap-3 rounded-2xl px-5 py-4', tone)}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div>
        <p className="font-bold">{title}</p>
        {body && <div className="text-sm font-medium mt-1 opacity-90">{body}</div>}
      </div>
    </div>
  );

  const status = (() => {
    if (!job) return null;
    if (job.kind === 'remove') {
      if (job.state === 'waiting') {
        return box(
          'bg-brand-primary/5 text-brand-primary',
          <Loader2 size={22} className="animate-spin" />,
          t('attendance.remove_waiting', 'Removing the fingerprint from the device…'),
          target.deviceOnline
            ? t('attendance.enroll_waiting_body', 'The device picks this up within about 10 seconds.')
            : t('attendance.remove_waiting_offline', 'The device looks offline. It will be removed when the device reconnects.'),
        );
      }
      if (job.state === 'removed') {
        return box(
          'bg-green-50 text-green-700',
          <CheckCircle2 size={24} />,
          t('attendance.remove_done', 'Fingerprint removed'),
          t('attendance.remove_done_body', {
            finger: jobFinger,
            defaultValue: `The ${jobFinger} finger can be enrolled again now.`,
          }),
        );
      }
      if (job.state === 'cancelled') {
        return box('bg-gray-100 text-brand-muted', <XCircle size={22} />, t('attendance.enroll_cancelled', 'Cancelled'), null);
      }
      return box(
        'bg-red-50 text-red-600',
        <XCircle size={22} />,
        t('attendance.remove_failed', 'The device couldn\'t remove the fingerprint'),
        job.returnCode != null ? `${t('attendance.code_n', { code: job.returnCode, defaultValue: `Code ${job.returnCode}` })}` : null,
      );
    }
    switch (job.state) {
      case 'waiting':
        return box(
          'bg-brand-primary/5 text-brand-primary',
          <Loader2 size={22} className="animate-spin" />,
          t('attendance.enroll_waiting', 'Sending to the device…'),
          target.deviceOnline
            ? t('attendance.enroll_waiting_body', 'The device picks this up within about 10 seconds.')
            : t('attendance.enroll_waiting_offline', 'The device looks offline. If it doesn\'t pick this up within 2 minutes, the request expires.'),
        );
      case 'prompting':
        return box(
          'bg-orange-50 text-orange-700',
          <motion.div animate={{ scale: [1, 1.15, 1] }} transition={{ repeat: Infinity, duration: 1.2 }}>
            <Fingerprint size={26} />
          </motion.div>,
          t('attendance.enroll_prompting', { who, defaultValue: `Ask ${who} to place their finger on the device` }),
          <>
            {t('attendance.enroll_prompting_body', {
              finger: jobFinger,
              defaultValue: `Use the ${jobFinger} finger. The device asks for the same finger 3 times.`,
            })}
            <span className="block mt-1 tabular-nums">
              {t('attendance.enroll_seconds_left', { count: secondsLeft, defaultValue: `About ${secondsLeft}s left` })}
            </span>
          </>,
        );
      case 'enrolled':
        return box(
          'bg-green-50 text-green-700',
          <CheckCircle2 size={24} />,
          t('attendance.enroll_done', 'Fingerprint enrolled'),
          job.templateReceived || !following
            ? t('attendance.enroll_done_body', {
                who,
                finger: jobFinger,
                defaultValue: `${who} can now punch with the ${jobFinger} finger.`,
              })
            : t('attendance.enroll_done_syncing', 'Enrolled on the device. Its copy is being fetched and will appear in the list shortly.'),
        );
      case 'timed_out':
        return box(
          'bg-orange-50 text-orange-700',
          <Clock size={22} />,
          t('attendance.enroll_timed_out', 'No finger was scanned in time'),
          t('attendance.enroll_timed_out_body', 'The device closed its prompt. Try again when the employee is at the device.'),
        );
      case 'duplicate':
        return box(
          'bg-red-50 text-red-600',
          <XCircle size={22} />,
          t('attendance.enroll_duplicate_any', 'This fingerprint is already enrolled on the device'),
          t('attendance.enroll_duplicate_any_body', 'The device doesn\'t accept a finger that is already enrolled, for this user or anyone else. Use a different finger, or remove the existing one first.'),
        );
      case 'expired':
        return box(
          'bg-red-50 text-red-600',
          <AlertTriangle size={22} />,
          t('attendance.enroll_expired', 'The device didn\'t respond'),
          t('attendance.enroll_expired_body', 'It may be offline. Check it shows Online, then try again.'),
        );
      case 'cancelled':
        return box('bg-gray-100 text-brand-muted', <XCircle size={22} />, t('attendance.enroll_cancelled', 'Cancelled'), null);
      default:
        return box(
          'bg-red-50 text-red-600',
          <XCircle size={22} />,
          t('attendance.enroll_failed', {
            code: job.returnCode,
            defaultValue: `The device couldn't enroll the fingerprint (code ${job.returnCode})`,
          }),
          t('attendance.enroll_failed_body', 'Try again. If it keeps failing, enroll the finger on the device itself.'),
        );
    }
  })();

  const secondary = 'px-4 py-2 rounded-xl bg-gray-100 text-brand-muted hover:bg-gray-200 font-medium';
  const primary =
    'px-4 py-2 rounded-xl bg-brand-primary text-white hover:bg-brand-primary/90 font-bold disabled:opacity-50 flex items-center gap-2';
  const danger =
    'px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 font-bold disabled:opacity-50 flex items-center gap-2';

  const footer = (() => {
    if (!job) {
      if (selectedEnrolled) {
        return (
          <div className="flex justify-end gap-2">
            <button onClick={confirmRemove ? () => setConfirmRemove(false) : onClose} className={secondary}>
              {confirmRemove ? t('attendance.remove_keep', 'Keep it') : t('common.cancel')}
            </button>
            {confirmRemove ? (
              <button onClick={() => run('remove')} disabled={busy} className={danger}>
                <Trash2 size={16} />
                {busy ? t('attendance.sending', 'Sending…') : t('attendance.remove_confirm', 'Yes, remove')}
              </button>
            ) : (
              <button onClick={() => setConfirmRemove(true)} className={danger}>
                <Trash2 size={16} />
                {t('attendance.remove_button', 'Remove fingerprint')}
              </button>
            )}
          </div>
        );
      }
      return (
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className={secondary}>
            {target.justAdded ? t('attendance.enroll_skip', 'Skip for now') : t('common.cancel')}
          </button>
          <button onClick={() => run('enroll')} disabled={busy || finger == null} className={primary}>
            <Fingerprint size={16} />
            {busy ? t('attendance.sending', 'Sending…') : t('attendance.enroll_start', 'Start on device')}
          </button>
        </div>
      );
    }
    if (job.state === 'waiting') {
      return (
        <div className="flex justify-end gap-2">
          <button onClick={cancel} className={secondary}>
            {t('common.cancel')}
          </button>
        </div>
      );
    }
    if (job.state === 'prompting') {
      // Closing is fine: the device keeps prompting and the list updates when it finishes.
      return (
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-brand-muted">
            {t('attendance.enroll_stop_hint', 'To stop, press the back (ESC) button on the device, or let it time out.')}
          </p>
          <button onClick={onClose} className={secondary}>
            {t('attendance.close', 'Close')}
          </button>
        </div>
      );
    }
    return (
      <div className="flex justify-end gap-2">
        {job.kind === 'remove' && job.state === 'removed' ? (
          <button onClick={() => backToPicker(job.finger ?? undefined)} className={secondary}>
            {t('attendance.remove_enroll_again', 'Enroll this finger again')}
          </button>
        ) : (
          <button onClick={() => backToPicker()} className={secondary}>
            {job.state === 'enrolled'
              ? t('attendance.enroll_another', 'Enroll another finger')
              : t('attendance.enroll_back', 'Back to fingers')}
          </button>
        )}
        <button onClick={onClose} className={primary}>
          {t('attendance.done', 'Done')}
        </button>
      </div>
    );
  })();

  return (
    <Modal
      isOpen={Boolean(target)}
      onClose={onClose}
      title={t('attendance.enroll_title', 'Enroll fingerprint')}
      subtitle={
        <span className="text-sm text-brand-muted">
          {who}
        </span>
      }
      maxWidth="lg"
      // Above the Edit user side panel (z-[101]), which opens this dialog.
      layerClassName="z-[110]"
      footer={footer}
    >
      <div className="space-y-5">
        {target.justAdded && !job && (
          <div className="flex gap-2 bg-green-50 text-green-700 rounded-xl px-4 py-3 text-sm font-medium">
            <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
            {t('attendance.enroll_after_add', {
              who,
              defaultValue: `${who} is being added to the device. You can enroll their fingerprint right away: the device adds the user first, then asks for the finger.`,
            })}
          </div>
        )}

        {!job ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-brand-text font-semibold">
                {t('attendance.enroll_pick_finger_v3', 'Choose a finger to enroll')}
              </p>
              <span className="flex items-center gap-1.5 text-xs text-brand-muted font-medium whitespace-nowrap">
                <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-green-500 text-white">
                  <Check size={9} strokeWidth={3.5} />
                </span>
                {t('attendance.finger_enrolled', 'Already enrolled')}
              </span>
            </div>
            <div className="space-y-3">
              {renderHand(t('attendance.hand_left_title', 'Left hand'), LEFT_HAND, true)}
              {renderHand(t('attendance.hand_right_title', 'Right hand'), RIGHT_HAND, false)}
            </div>

            {selectedEnrolled &&
              (confirmRemove ? (
                <div className="flex gap-2 bg-red-50 text-red-600 rounded-xl px-4 py-3 text-sm font-medium">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  {t('attendance.remove_confirm_body', {
                    who,
                    finger: selectedLabel,
                    defaultValue: `Remove the ${selectedLabel} fingerprint for ${who}? They can't punch with this finger until it is enrolled again.`,
                  })}
                </div>
              ) : (
                <div className="flex gap-2 bg-orange-50 text-orange-700 rounded-xl px-4 py-3 text-sm font-medium">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  {t('attendance.finger_enrolled_notice', {
                    finger: selectedLabel,
                    defaultValue: `The ${selectedLabel} finger is already enrolled. The device won't accept the same finger again, so to re-enroll it, remove it first.`,
                  })}
                </div>
              ))}

            <p className="flex gap-2 border-t border-gray-100 pt-4 text-xs leading-relaxed text-brand-muted">
              <Info size={14} className="shrink-0 mt-px" />
              <span>
                {t('attendance.enroll_face_note', 'Face can\'t be started from here on this device model. Enroll it on the device: MENU → User Mgt. → select the user → Edit → Face. It appears here automatically.')}
              </span>
            </p>
          </>
        ) : (
          status
        )}

        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 p-3 rounded-xl text-sm font-medium">{error}</div>
        )}
      </div>
    </Modal>
  );
};
