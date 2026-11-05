// ============================================
// DEVICE NAME SYNC
// ============================================
// File: services/deviceNameSync.js
// Description: The name on the MB160 follows the employee's profile name (since 2026-11-04 it
// isn't edited separately). When a profile's name changes, this queues the new name, shortened
// to fit the device (deviceNameFor), for that person's active device user. A rename made on the
// device itself is not copied back: the profile is the source of truth. See docs/zkteco-mb160.md.
// ============================================

const ZktecoModel = require('../models/zktecoModel');
const AdmsService = require('./admsService');
const { deviceNameFor } = require('../utils/employeeProfile');

/**
 * Queues the profile name for the device user (deviceId, pin) when it differs from the name
 * the device has. Skipped when the user is being removed. Returns { name, queued }.
 */
async function syncDeviceName({ deviceId, pin, firstName, lastName }, userId) {
	const name = deviceNameFor(firstName, lastName);
	if (!name) return { name, queued: false };
	const user = await ZktecoModel.getDeviceUserForEdit(deviceId, pin);
	if (!user) return { name, queued: false };

	// What the device will have once the queued changes run: the newest pending rename, else its
	// current name. A pending removal wins over a rename.
	const pending = await ZktecoModel.getPendingUserCommandsFor(deviceId, pin);
	if (pending.some((c) => c.COMMAND === ZktecoModel.userDeleteCommand(pin))) return { name, queued: false };
	const pendingName = pending.length ? /\tName=([^\t]*)/.exec(pending[0].COMMAND)?.[1] : null;
	if ((pendingName ?? String(user.NAME ?? '')) === name) return { name, queued: false };

	// The device replaces the whole record, so everything else is sent as it is now (an admin
	// stays an admin; a card or password set on the device is kept).
	await AdmsService.queueCommand(
		deviceId,
		ZktecoModel.userEditLabel(pin, name),
		AdmsService.buildUserUpdateCommand({
			pin,
			name,
			privilege: ZktecoModel.isAdminPrivilege(user.PRIVILEGE) ? AdmsService.PRIVILEGE_ADMIN : AdmsService.PRIVILEGE_USER,
			password: String(user.PASSWORD ?? ''),
			card: String(user.CARD_NO ?? ''),
			group: user.GROUP_NO,
			tz: user.USER_TZ,
			verify: user.VERIFY_MODE,
		}),
		userId ?? null
	);
	return { name, queued: true };
}

module.exports = { syncDeviceName };
