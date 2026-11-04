# ZKTeco MB160 integration

The restaurant uses a **ZKTeco MB160** (fingerprint/face/password terminal) for staff time and attendance. This is the **start** of its integration into sanwol_resto. Today the app receives and stores everything the device pushes, shows two pages that update live (**Attendance Logs** and **Employees**, which was called *Device Users* until 2026-10-27), and can add users to the device. Computed attendance, employee profiles and schedules are described in [attendance.md](attendance.md). Everything below is written so later work can extend it, and so the move to a cloud DB or another network is a config change.

The protocol was proven first in the separate test app `zkteco_test` (sibling repo, `C:\Users\Chester\Desktop\Projects\1REPOSITORIES\zkteco_test`). Its README is the long-form protocol and device-menu reference; this doc covers how sanwol_resto does it.

## Status (2026-10-26)

| Done | Not yet |
|---|---|
| ADMS receiver in the Node server, on its own port | Payroll (see [attendance.md](attendance.md)) |
| `zkteco` DB in sanwol_resto column style | |
| **Attendance** (basic time tracking: hours worked per day from time-ins and time-outs) and **employee profiles** linked by `device_users.EMPLOYEE_ID`: see [attendance.md](attendance.md) | Overtime, late, absences, payroll (on hold; see attendance.md) |
| **Manual punches** for forgotten punches (`attendance_manual_punches`) | |
| Attendance Logs page (header date range) | Changing a user's User ID (a new ID = a new user) |
| Employees page (role, **Fingerprints** column (which fingers, e.g. "Right index"; at most two, then "+N" with all of them on hover; an orange *None* chip when there are none) and an "Also:" note for any face, palm, card or password set on the device, last punch) | Remote **face** enrollment (not possible on this firmware; enroll faces on the device) |
| **Live updates**: pages re-fetch the moment the device sends data (SSE) | UI to assign a device to a branch (uses `ZK_DEFAULT_BRANCH_ID`) |
| **Add User**: create a user in the app and push it to the device | Offline-device alerts |
| **Remote fingerprint enrollment**: the app makes the device prompt for a finger (right after Add User, or per row) | |
| Initial sync: a newly seen device is asked for all users and punches | HTTPS for the device link (needed for cloud) |
| Stores biometric templates (never returned by the API) | |
| Mirrors users deleted on the device (OPLOG 103) and cards removed on the device (OPLOG 12) | |
| **Remove users from the app**, soft-deleted: removed users keep their name on past punches; **Show deleted** + **Add again** | |
| **Edit users**: fingerprints; the device name follows the profile name (since 2026-11-04 role, password, card and face are managed on the device only) | |
| **Punch corrections**: edit a punch's time/status, delete and restore punches (raw punches never change) | Change history per punch (only the latest correction is kept) |
| **Cards**: added and removed on the device (like faces); the Employees list shows a Card chip | Remote card prompt (not possible on this firmware) |

## How it works

The **device is the HTTP client**. It connects out to the server and polls it, and the server never connects to the device. That's why commands to the device need no port forwarding, even when the server is in the cloud.

```
 MB160 192.168.110.190                 Node server (this PC 192.168.110.26)                  MySQL
 ─────────────────────                 ─────────────────────────────────────                  ─────
 boot ── GET  /iclock/cdata?options=all ──▶ :2500 admsServer ─▶ reply options + stamps
 punch ─ POST /iclock/cdata?table=ATTLOG ─▶ :2500             ─▶ "OK: n" after commit ─▶ zkteco.attendance_logs
 enroll  POST /iclock/cdata?table=OPERLOG ▶ :2500             ─▶ "OK: n"             ─▶ zkteco.device_users / biometric_templates / operation_logs
 every 10s GET /iclock/getrequest ────────▶ :2500             ─▶ "OK" or "C:<id>:<cmd>"  ◀─ zkteco.device_commands
 browser ── GET /data-api/zkteco/* ──▶ Vite :3600 ─▶ API :2300 zktecoRoutes (JWT auth, branch scope) ─▶ zkteco (+ sanwol_resto.branches)
 browser ── GET /data-api/zkteco/events (SSE) ◀── "change" events ◀── zktecoEvents ◀── admsService (after each commit)
 browser ── POST /data-api/zkteco/device-users ─▶ device_commands (pending) ─▶ next poll ─▶ device ─▶ devicecmd ─▶ device_users
```

- **Port 2500 serves only `/iclock/*`.** It is a second Express listener in the same Node process, so none of the app's CORS, session or auth middleware applies. It can be firewalled or exposed on its own.
- **Nothing is lost while the server is down.** The device keeps its logs and resends anything that wasn't acknowledged with `OK: n`. Punches are unique on `(DEVICE_ID, PIN, PUNCH_DT)`, so resends never duplicate.
- **Live updates.** After each commit, `admsService` emits a `change` event (`attendance`, `users`, `commands` or `device`) through `services/zktecoEvents.js`. `GET /zkteco/events` streams them to open pages as Server-Sent Events, filtered by branch, with a `: ping` every 25 s. The pages re-fetch on a matching event (bursts are merged with a 400 ms debounce), and poll every 60 s as a fallback; going offline produces no event. The stream is read with `fetch` (`src/lib/sseClient.ts`), not `EventSource`, so the JWT header is sent. `compression` leaves it alone because of `Cache-Control: no-transform`. **The event bus is in-process**: if the API ever runs as several processes (pm2 cluster), replace it with a shared bus such as Redis pub/sub.
- **Punch times are device-local wall-clock times** (UTC+8). The zkteco pool uses `dateStrings: true` and session `time_zone = +08:00`, so they never shift through JS `Date`. The UI formats the string as-is.

## Files

| File | Role |
|---|---|
| `server/services/admsServer.js` | The `ZK_ADMS_PORT` listener: raw body, explicit Content-Length, raw-request logging and pruning |
| `server/services/admsService.js` | Protocol handler. **Port of `zkteco_test/src/Adms.php`**; keep the two in step |
| `server/config/zktecoDb.js` | Separate mysql2 pool for the `zkteco` DB (`ZK_DB_*`) |
| `server/models/zktecoModel.js` | Table DDL (auto-created on boot) and the read queries for the pages |
| `server/controllers/zktecoController.js`, `server/routes/zktecoRoutes.js` | `GET /zkteco/devices`, `/zkteco/attendance-logs`, `/zkteco/device-users`, `/zkteco/device-users/pending`, `/zkteco/events` (SSE); `POST /zkteco/device-users`; `PATCH`/`DELETE /zkteco/device-users/:pin`, `DELETE /zkteco/user-commands/:id`; `PATCH`/`DELETE /zkteco/attendance-logs/:id`, `POST /zkteco/attendance-logs/:id/restore` (plus the fingerprint routes) |
| `src/services/zktecoService.ts` | Frontend API client (via the `/data-api` proxy prefix) |
| `server/services/zktecoEvents.js` | In-process change events (receiver → SSE stream) |
| `src/components/attendance/` | `AttendanceLogs.tsx` (Summary / Punches tabs), `Employees.tsx` (was `DeviceUsers.tsx`), `AddDeviceUserPanel.tsx`, `EnrollFingerprintDialog.tsx`, `EmployeePanel.tsx` (was `EditDeviceUserPanel.tsx`; its Device tab = details, fingerprints, card, face), `RemoveDeviceUserDialog.tsx`, `PunchDialogs.tsx` (edit / delete / add punch), `zktecoShared.tsx` (code labels, device status cards, `useZkLiveReload`, `LiveBadge`). Attendance files: see [attendance.md](attendance.md) |
| `src/constants/sidebarFeatures.ts` | Sidebar keys `employee` (Employees page) and `attendance_logs` (Staff section); also in `ALL_FEATURES` in `server/models/branchSidebarPermissionModel.js`. The CRUD module for the Employees page is still keyed `device_users` |

## Configuration (`.env`)

| Key | Current value | Meaning |
|---|---|---|
| `ZK_DB_NAME` | `zkteco` | Device database. `ZK_DB_HOST/PORT/USER/PASSWORD` fall back to `DB_*` when empty |
| `ZK_ADMS_PORT` | `2500` | Port the device pushes to. Empty disables the listener |
| `ZK_TZ_OFFSET_HOURS` | `8` | Sent to the device as `TimeZone=`, and used for `NOW()` in the zkteco DB |
| `ZK_ALLOWED_SERIALS` | `ECV3262300063` | Allow-list. Other serials get HTTP 403, so they keep their data and retry. **A new device is registered only when listed**: with the list empty, devices registered before keep working and new serials are refused (since 2026-11-04; before, empty meant "any device", which let anyone register a fake device into `ZK_DEFAULT_BRANCH_ID`) |
| `ZK_ALLOWED_IPS` | (empty) | Optional allow-list of source IPs (e.g. the restaurant's static public IP). Others get 403 before their body is read. Empty = any IP |
| `ZK_TRUST_PROXY` | (empty = `loopback`) | Whose `X-Forwarded-For` to believe for the client IP (Express *trust proxy*). Default: only a proxy on the same server. Don't use `true` with the port exposed directly: anyone could fake their IP |
| `ZK_DEFAULT_BRANCH_ID` | `14` (Sanwol BBQ) | Branch assigned to a device **the first time it connects**. Change it later in `devices.BRANCH_ID` |
| `ZK_RAW_LOG_DAYS` | `14` | Days of `raw_requests` to keep. `0` = don't log |
| `ZK_RESYNC_HOURS` | `12` (default) | Hours between automatic full syncs (`DATA QUERY USERINFO`) that keep the app a mirror of the device. `0` = off |

Setting `devices.ACTIVE = 0` also makes the server reject that device (403).

## The device

| | |
|---|---|
| Model / firmware | MB160 Plus, `ZMM501-NF28VF-Ver3.0.2`, push protocol 2.4.1 |
| Serial number | `ECV3262300063` |
| IP | `192.168.110.190` (LAN 192.168.110.x) |

**Settings for sanwol_resto.** Firmware 8.x menu names; they can differ slightly by version.

| Menu | Setting | Value |
|---|---|---|
| COMM. → Cloud Server Setting | Server Mode | ADMS |
| | Enable Domain Name | **OFF** (ON hides the port field and forces 443/80) |
| | Server Address | `192.168.110.26` (the PC running the Node server) |
| | Server Port | `2500` |
| | Enable Proxy Server | OFF |
| COMM. → PC Connection | HTTPS | **OFF** (the Node listener is plain HTTP) |

**The protocol and the port must match.** With HTTPS ON, the device speaks TLS to any port. Against a plain-HTTP listener, nothing arrives except garbage (`\x16\x03\x01…`). See zkteco_test README §4.3 and §9.

The `zkteco_test` Apache app (ports 8081/8443) now uses the `zkteco_test` database. The device can push to only one server, so pointing it at 2500 means zkteco_test stops receiving.

### Firmware findings (this MB160)

- **Stamps don't trigger a re-upload.** It sends `Stamp=9999` on every upload, and it keeps its own record of what it has already uploaded. After it had pushed everything to zkteco_test, pointing it at sanwol_resto with `Stamp=None` in the handshake brought **only new events**: no users, no old punches. To get existing data, **ask for it**:
  - `DATA QUERY USERINFO` (no PIN) returns **every user plus their FP, FACE and USERPIC templates**, posted to `cdata?table=OPERLOG`.
  - `DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00\tEndTime=2099-12-31 23:59:59` returns the whole punch log, posted to `cdata?table=ATTLOG&…&PackCnt=n&PackIdx=i` (paged on large logs).

  `admsService.touchDevice` queues both automatically the **first time a serial number is seen** (`INITIAL_SYNC_COMMANDS`). This also covers moves to an empty DB (e.g. the cloud). To re-sync a device that is already registered, queue the two commands by hand: `INSERT INTO device_commands (DEVICE_ID, LABEL, COMMAND) VALUES (<IDNo>, 'Manual sync: users', 'DATA QUERY USERINFO')`, and the ATTLOG query above with a real tab. **Don't delete the `devices` row to force it:** the device would get a new `IDNo`, and its existing users and punches would be orphaned, then duplicated under the new ID. Both queries are read-only, and resent data is deduplicated.
- **Verify types in ATTLOG.** `1` fingerprint, `3` password, `4` card (observed 2026-10-26), `15` face. Status is `255` unless the user presses a status key, and `0` (time-in) when the punch-state key is used. **Since 2026-10-27 the device is set to require a punch state**, so new punches always carry 0 time-in, 1 time-out, 4 OT-in or 5 OT-out (2/3 = break). Older punches may still be `255`. The app shows 0/1 as **Time-in / Time-out**. For attendance, 0/3/4 count as arriving and 1/2/5 as leaving ([attendance.md](attendance.md)); the app itself only sets 0/1.
- **One face = 12 `FACE` templates** (FID 0–11). Treat face as yes/no, never as a count.
- **Deleting a user on the device sends no USER line**, only `OPLOG 103` with OBJ1 = PIN. The device's user count drops by one each time. `admsService.saveOpLog` deletes the user and their templates, but only rows last written before the event (a history re-upload can replay an old delete).
- **Privilege** `14` = super admin, `0` = normal user.
- **Cards (tested live 2026-10-26):** this unit has the optional **125 kHz EM (ID)** reader. The box only says "Optional: ID/ADMS", so check the unit, not the box. There's no slot: the card is read around the **fingerprint sensor area**. It reads the chip's ID, not anything printed on the card. **13.56 MHz NFC/Mifare cards are not read at all** (`IsSupportNFC=0` in the options). The card bundled with the device works. A card enrolled on the device arrives in the USER line (`Card=…` → `device_users.CARD_NO`, e.g. `4772564`) with `OPLOG 8`, and card punches have verify type `4`. **Removing a card on the device sends only `OPLOG 12`** (OBJ1 = PIN), no USER line; a `DATA QUERY USERINFO PIN=x` afterwards reported `Card=` (empty). **An unregistered card swiped at the main screen sends nothing** (and shows nothing). **No remote card prompt** (probed live 2026-10-26 with a test user and a card at the device): `ENROLL_CARD` and 30+ other guesses → `-1002` (unknown), including `ENROLL_CARDNUMBER`, `ENROLL_CARD_NO`, `ENROLL_BADGE`, `ENROLL_IDCARD`, `ENROLL_ID`, `ENROLL_RF(CARD)`, `ENROLL_HID(CARD)`, `ENROLL_EM(CARD)`, `ENROLL_IC(CARD)`, `ENROLL_PROX(CARD)`, `ENROLL_RFID`, `ENROLL_MIFARE`, `ENROLL_VICECARD`, `ENROLL_USER`, `ENROLL_CN`, `ENROLL_NC`, `REG_CARD`, `REGISTER_CARD`, `READ_CARD`, `ENROLL_PWD`. The verb is matched by prefix (`ENROLL_MFCARD` runs as `ENROLL_MF`). **`ENROLL_MF`** is the only card-related verb it knows: it answers `Return=0` at once, shows **nothing** on screen, then silently waits ~65 s for a Mifare card (a second `ENROLL_MF` in that time waits it out and gets `-1003`). Tapping the 125 kHz card or a 13.56 MHz NFC card during the wait does nothing. Don't use it.
- **Remote enrollment (tested live 2026-10-23):** `ENROLL_FP` works (Return 0 = enrolled, 6 = nobody scanned, 4 = that finger is already enrolled, for anyone including the same user). `DATA DELETE FINGERTMP PIN=…\tFID=…` removes one finger (Return 0). **Face cannot be started remotely:** `ENROLL_FACE` → `-1002` (unknown command), and `ENROLL_BIO TYPE=2` opened the *fingerprint* prompt instead (ended `-1003` with no finger). Faces are enrolled on the device (MENU → User Mgt. → user → Edit → Face) and sync to the app automatically.
- **Adding a user from the server** (`DATA UPDATE USERINFO PIN=…\tName=…\tPri=…\tPasswd=…\tCard=…\tGrp=1\tTZ=0000000100000000\tVerify=0\tViceCard=`) returns `Return=0` about 6 s after queueing (one poll), and the device's user count goes up by one. Verified end-to-end on 2026-10-23 (test user 9001 added, then removed with `DATA DELETE USERINFO PIN=9001`).

## Adding users from the app

**Employees → Add employee** (needs admin, or a role granted **Employees → Add** in User Access → CRUD permissions; the server enforces it too). Since 2026-11-04 everyone added from the app is a **regular user (Pri=0) with no password**: staff punch with their fingerprint, and device admins are made on the MB160 itself. The server ignores any `privilege`/`password` sent. Fields and limits, enforced in both `AddDeviceUserPanel.tsx` and `zktecoController.createDeviceUser`:

| Field | Rule |
|---|---|
| User ID (PIN) | 1–9 digits, no leading zero, not already on the device or waiting to be added. The next free number is suggested |
| Profile (`profile`, snake_case like `PATCH /attendance/employees/:id`) | First name required; last name, position, date hired, contact and other details optional. Validated by `utils/employeeProfile.readProfile` (same as the Profile tab) |
| Name on the device | Not typed (since 2026-11-04): the server makes it from the profile name, up to 24 characters (`deviceNameFor`): *First Last* → *First L.* → fewer first-name words with the initial → fewer first-name words → first word cut to 24 characters. Tabs, line breaks and control characters become spaces. The form shows the result. A `name` in the body is only used when no `profile` is sent |
| Card, face | Not part of Add employee: added on the device afterwards (see *Registering cards*) |

**How the profile details reach the profile** (no write to `sanwol_resto` until the device confirms, and the ADMS listener never touches that DB): they're stored as JSON on the command (`device_commands.PROFILE_JSON`). When the device answers `Return=0`, `applyCommandResult` moves them to the new row (`device_users.PENDING_PROFILE_JSON`) and clears the command's copy in the same transaction. The next link pass (`employeeLinkService`, run when the Employees page or the summary loads, which the live stream triggers) creates the profile from them, or for **Add again** updates the person's existing profile, then clears them. A rejected, unanswered or cancelled add clears `PROFILE_JSON`, so personal details don't stay in the queue and no orphan profile is left.

The request queues a command. It does **not** write `device_users`. The user appears in the list when the device confirms (`applyCommandResult`), with **Added from = This app** (`SOURCE = 'server'`, which is kept even after they enroll a fingerprint on the device). Until then, a "Sending to device" strip shows it as *Waiting for the device* (`pending`) or *Delivered, waiting for confirmation* (`sent`). A rejection shows as *Rejected by device (code N)* for a day. If the device is offline, the command waits in the queue and is delivered when it reconnects. Fingerprint/face is enrolled on the device afterwards (MENU → User Mgt. → user → Edit).

Raw `COMMAND` text contains the device password, so `getPendingUserCommands` parses out only PIN and name.

## Keeping the app a mirror of the device

- **`SYNCED_DT`** (device_users, biometric_templates) is set every time the device reports the row. **`EDITED_DT`** moves only when a field or template really changes (re-uploads no longer touch it).
- After a successful **`DATA QUERY USERINFO`** (all users, or `PIN=x`), `reconcileAfterUserQuery` waits 20 s for the uploads to settle. It then deactivates users (soft delete, see *Removing users*) and deletes templates in that scope that the device didn't report since the query was sent. That is how fingerprints or users removed **at the device** disappear here (the device only announces whole-user deletes, via OPLOG 103, and card removals, via OPLOG 12; `saveOpLog` applies both right away, but only to rows last written before the event). zkteco_test only stores OPLOG lines; acting on 103/12 is sanwol_resto-only.
- A full sync is queued automatically every `ZK_RESYNC_HOURS` (default 12) while the device is polling, and on first connect. Verified live: a full sync kept all 7 users, 4 fingerprints, 12 face templates and the photo.
- **Unanswered commands**: a `DATA UPDATE`/`DATA DELETE` the device took but never answered (e.g. it rebooted) is re-sent once after 5 min, then marked `failed`. A failed add frees its User ID and shows "No answer from the device" in the pending strip.
- **Names with ñ/Ñ** round-trip intact (the device returns the same UTF-8 bytes).
- **Attendance Logs** returns at most 5,000 punches (newest first). When a range has more, the API sets `X-Result-Truncated: 5000`, and the page shows "5,000+" with a notice to narrow the range.

## Enrolling fingerprints from the app

**Device Users → Fingerprint button** on any row, and automatically right after **Add User** (the panel hands off to the enrollment dialog). Needs admin, or **Device Users → Add or Edit** permission (Add is enough, so whoever adds a user can enroll their finger straight away).

How it works: `POST /zkteco/device-users/:pin/fingerprint { device_id, finger }` queues `ENROLL_FP PIN=…\tFID=<finger>\tRETRY=3\tOVERWRITE=1`. On its next poll (≤ 10 s) the device opens its "place finger" prompt (~60 s, same finger 3 times), **uploads the FP template itself**, then answers. The dialog polls `GET /zkteco/enrollments/:id` (every 1.5 s) for one `STATE`:

| STATE | Meaning |
|---|---|
| `waiting` | Queued; the device hasn't picked it up yet |
| `prompting` | The device is showing its prompt |
| `enrolled` | `Return=0`; `FP_RECEIVED` says the template has arrived (if not, `ensureEnrolledTemplate` queues `DATA QUERY USERINFO` to fetch it) |
| `timed_out` | `Return=6`: nobody scanned within ~60 s (also used for a `sent` prompt with no answer after 180 s, e.g. the device rebooted) |
| `duplicate` | `Return=4`: that fingerprint is already enrolled on the device, **for anyone, this user included**. The MB160 compares every scan with all stored fingerprints and `OVERWRITE=1` does not bypass it (confirmed live twice: same finger on two users, and re-scanning 3Core's enrolled finger) |
| `expired` | The device didn't pick it up within 2 min (`ENROLL_PICKUP_TIMEOUT_SECONDS`). Expired in `getRequest` so an offline device never prompts hours later |
| `cancelled` | `DELETE /zkteco/enrollments/:id` before pickup. After pickup it can only be stopped at the device (back/ESC) |
| `failed` | Any other code |

- **One enrollment per device at a time**: a second one gets 409 while one is `pending`, or `sent` within 180 s.
- **Enrolling right after Add User works** because commands run in queue order: the device creates the user, then prompts. It answers both in one `devicecmd` post *after* the enrollment ends, so the new user appears in the list only then.
- **Finger numbers (FID)**: 0–4 = left little → left thumb, 5–9 = right thumb → right little (ZKTeco convention). The picker starts with no finger selected; "Start on device" is enabled once one is clicked.
- **Re-enrolling a finger = remove, then enroll.** Enrolled fingers are greyed out (with a check) in the dialog, and the server refuses to enroll them (409). Selecting one offers **Remove fingerprint** (with a confirmation): `DELETE /zkteco/device-users/:pin/fingerprints/:finger?device_id=` queues `DATA DELETE FINGERTMP PIN=…\tFID=…`. On `Return=0` the template is deleted here too, and the device accepts that finger again. Verified live 2026-10-23: enroll → remove (confirmed in 2 s) → same finger enrolled again. Removal follows the same `GET /zkteco/enrollments/:id` with `KIND: 'remove'` (states `waiting`, `removed`, `cancelled`, `failed`) and does not expire (a removal for an offline device waits until it reconnects; it can be cancelled until then).
- **Template after enrollment**: the device sends it just before *or* just after its answer (both seen). `ensureEnrolledTemplate` waits 15 s, then asks for that user only (`DATA QUERY USERINFO PIN=x`, verified), never a full re-download.
- The dialog can be closed while the device is prompting; the enrollment carries on, and the list updates live when it ends.
- For `ENROLL_*` commands only `Return=0` is success (`deviceCmd`); other commands keep "≥ 0 = success".

## Registering cards

The MB160 can't be told to prompt for a card, and it reports nothing for an unregistered swipe (see *Cards* above). So, like faces, **cards are added at the device** and the app only shows the result:

- **On the device:** MENU → User Mgt. → user → Edit → **Card Number** → hold the card against the fingerprint sensor area until it beeps → save and **exit the user's menu**. The device sends the USER line with `Card=…` **only once the user's menu is exited**, not when the card is read or saved (confirmed live 2026-10-26: it arrived ~80 s after entering the menu, as the admin backed out). That updates `device_users` and, through the live stream, the Card chip on the row.
- **Removing a card** is done on the device (Edit → Card Number → delete; `OPLOG 12` clears `CARD_NO` here right away). Since 2026-11-04 the app no longer has Card, Face, Password or Role sections in Edit user (the restaurant uses fingerprints); an edit from the app keeps whatever the device has.
- The API returns only `HAS_CARD`, never the card number.
- History: a guided *Register card* dialog (opened from Add User, the row and the fingerprint dialog) was built and then removed on 2026-10-26. Since the device's menu is needed anyway, it only added a step. The Card and Face status sections of Edit user, and *Remove card* / password / role editing, were removed on 2026-11-04.

## Editing users

**Employees → pencil → Device tab** shows the **name on the device** (read-only) and the **fingerprints** (Add or Edit, same rule as enrollment; the enrollment dialog opens on top of the panel, `layerClassName="z-[110]"`, the side panel is `z-[101]`). Role (admins), password, card and face are managed on the MB160 only.

- **The name on the device follows the profile name** (since 2026-11-04; there's no rename endpoint any more). Saving a profile (`PATCH /attendance/employees/:id`) calls `services/deviceNameSync.syncDeviceName`, which queues the profile name shortened to 24 characters (`deviceNameFor`) when it differs from the device's name, or from the name a pending rename will set. A pending removal skips it. A rename made on the device isn't copied to the profile.
- **The device has no "edit": `DATA UPDATE USERINFO` replaces the whole record.** So a rename is built with the user's **current** `Pri`, `Passwd`, `Card`, `Grp`, `TZ` and `Verify` (from `device_users`) and changes only the name (`admsService.buildUserUpdateCommand`). Never reuse `buildUserUpsertCommand` (the add command) for an existing user: it sends `Card=` and an empty password and would wipe them. Verified live 2026-10-26: renaming test user 9101 returned `Return=0`, and `DATA QUERY USERINFO` reported the new name with the other fields unchanged. *Still to verify live: a user's fingerprint survives an edit.*
- Renames are queued in order, and each carries the newest name, so a second rename before the first is confirmed is safe. Removal still waits for a pending rename (409). The User ID can't be edited. The API never returns the password or card number.
- Edits are told apart from adds in `device_commands` by their label (`Edit user …`, `USER_EDIT_LABEL_PREFIX`). The pending strip shows them as *Edit: …* (cancellable until the device picks them up) and the row as *Updating…*. The app's copy changes when the device confirms (`applyCommandResult` → `saveUser`).

## Removing users (soft delete)

**Device Users → trash button** (needs admin, or **Device Users → Delete** in CRUD permissions). `DELETE /zkteco/device-users/:pin?device_id=` queues `DATA DELETE USERINFO PIN=x` (verified 2026-10-23: the device deletes the user with their fingerprints, face and card). The pending strip shows *Remove: …* with **Cancel** until the device picks it up.

- **Refused** (409): the device's **only admin** (privilege 14/6; without one anyone can open the device menu), a user already being removed, or while a fingerprint enrollment is running on that device.
- **Soft delete everywhere.** All three removal paths set `ACTIVE = 0` instead of deleting the row: the app's delete (on the device's `Return=0`, `EDITED_BY` = who queued it), a delete on the device (OPLOG 103), and a user missing from a full sync. The row keeps PIN and name, so **past punches keep their name**. What the device erased is erased here too: `PASSWORD`, `CARD_NO`, `FIELDS_JSON` and all of that PIN's biometric templates (`DEACTIVATE_USER_SQL` in `admsService.js`).
- **One active row per PIN.** `ACTIVE_PIN` is a stored generated column (`PIN` while active, `NULL` once removed) with `UNIQUE (DEVICE_ID, ACTIVE_PIN)`. `saveUser`'s upsert therefore updates the active user, or **inserts a new row** when the PIN is free or only held by removed users. **Removed rows are never reactivated**: a reused PIN is a new person, and "Add again" creates a new row too (with the old PIN if it's free).
- **Who a punch belongs to** (`punchOwnerId` in `zktecoModel.js`): the user row created most recently at or before the punch, else the earliest row for that PIN (punches older than every row, e.g. history uploaded on first connect). Attendance Logs and Device Users' *Last punch* both use it, so a reused PIN doesn't move the old person's punches to the new one. It compares `ENCODED_DT` (server time) with `PUNCH_DT` (device time), both +08:00; a punch within seconds of a user being created on the device can land on the previous holder.
- **Show deleted** (Device Users) lists removed users greyed out with *Removed* (tooltip: who removed them, or "on the device") and **Add again** (Add User pre-filled with the name, and the old User ID when free).
- **Add again links the rows.** The add carries `readd_of` (the removed row), stored as `device_commands.READD_OF_ID`; the controller refuses it (409) if that row was already added again or has an add pending. When the device confirms the add, `applyCommandResult` sets `READDED_AS_ID` = the new row on the removed row **and** on any earlier rows already pointing at it, so it always names the person's latest row. Device Users never lists rows with `READDED_AS_ID` (not even with Show deleted), and the latest row's *Last punch* includes its earlier rows' punches. In Attendance Logs each punch still belongs to its own row (`punchOwnerId`), but name and *Removed* come from the person's latest row (`PERSON_ID`): a re-added person's old punches lose the *Removed* tag and show their current name. The User ID column keeps the PIN the device recorded; when they came back under another User ID it adds *now 9102* (`CURRENT_PIN`), search matches either ID, and *People who punched* counts by `PERSON_ID`. A PIN reused by a different person (plain Add User) isn't linked. Re-adds made before this (2026-10-26) aren't linked; their old rows stay in Show deleted.
- Migration: `ensureSchema` adds `ACTIVE`, `ACTIVE_PIN`, `EDITED_BY`, then swaps `uq_device_users (DEVICE_ID, PIN)` for `uq_device_users_active` + `idx_device_users_pin` (`INDEX_CHANGES`). Existing rows start active. Applied to the live DB 2026-10-26 (MariaDB 10.4). Users hard-deleted before that are gone; their old punches show *Not on device*. Soft delete, `ACTIVE_PIN` and corrections are sanwol_resto-only; zkteco_test still hard-deletes users.

## Correcting punches

**Attendance Logs → pencil / trash** (needs admin, or **Attendance Logs → Edit** (edit) / **Delete** (delete and restore) in CRUD permissions). Raw `attendance_logs` rows are **never changed**: corrections live in `attendance_log_corrections`, one row per punch, matched on the original `(DEVICE_ID, PIN, PUNCH_DT)`. Because it isn't keyed on `attendance_logs.IDNo`, a correction still applies if the device uploads its history again (verified: a re-uploaded deleted punch stays deleted).

- **Edit** (`PATCH /zkteco/attendance-logs/:id { punch_dt, status, reason? }`): date/time (device-local text, not in the future) and status (255 none, 0-5). Stored as `PUNCH_DT_NEW` / `PUNCH_STATUS_NEW`; setting a value back to the original stores `NULL`, so "Use the device's record" clears the edit.
- **Delete / restore** (`DELETE …/:id { reason? }`, `POST …/:id/restore`): `IS_DELETED`. Edits are kept, so a restored punch comes back as it was. A deleted punch can't be edited until restored.
- **Reads**: `getAttendanceLogs` returns the corrected `PUNCH_DT` / `PUNCH_STATUS`, the originals as `ORIGINAL_*`, `IS_EDITED`, `IS_DELETED`, reason, and who/when (`CORRECTED_BY_NAME` from `sanwol_resto.user_info`). Deleted punches are left out unless `include_deleted=1` (**Show deleted**), and never count in the page's totals or a user's *Last punch*. The date range and order use the corrected time, so they don't use the `PUNCH_DT` index; fine at restaurant volume.
- The page shows *Edited* (orange) / *Deleted* (red) tags; the tooltip has the device's original, who changed it and the reason. Only the **latest** correction and reason are kept, not a history.
- Anything that computes attendance (time in/out, payroll) must read punches through these corrections, not `attendance_logs` alone, plus active manual punches: use `ZktecoModel.getPunchesForAttendance`.

## Database (`zkteco`)

Same conventions as sanwol_resto: snake_case tables, UPPERCASE columns, `IDNo` primary key, `*_ID` references, `*_DT` datetimes, `ACTIVE`, `ENCODED_*`/`EDITED_*`.

| Table | Contents |
|---|---|
| `devices` | One row per serial number: `BRANCH_ID`, IP, firmware, device-reported counts, stamps, `LAST_SEEN_DT` (online = seen in the last 60 s) |
| `attendance_logs` | Raw punches. **Never edit them**; compute attendance from them with `attendance_log_corrections` applied. `BRANCH_ID` is the device's branch at punch time |
| `attendance_log_corrections` | The app's edits / soft deletes of punches, keyed by the original `(DEVICE_ID, PIN, PUNCH_DT)` (see *Correcting punches*) |
| `device_users` | Users on each device: PIN, name, privilege, password, card, `SOURCE` (`device` / `server`). Removed users stay with `ACTIVE = 0`; one active row per PIN (`ACTIVE_PIN`); `READDED_AS_ID` links a removed row to the person's latest row after Add again; see *Removing users*. `EMPLOYEE_ID` = the person's profile in `sanwol_resto.employee` ([attendance.md](attendance.md)); `PENDING_PROFILE_JSON` = Add employee details waiting to be applied to it (cleared by the link pass; never returned by the API) |
| `attendance_manual_punches` | Punches added in the app for forgotten time-ins/outs; counted like device punches, soft-deleted with `ACTIVE = 0` ([attendance.md](attendance.md)) |
| `biometric_templates` | FP / FACE / BIODATA templates and user photos (base64). **Sensitive: no API returns them** |
| `operation_logs` | OPLOG events (menu access, enrollments, deletions) |
| `device_commands` | Server → device queue. `IDNo` is sent as `C:<IDNo>:<COMMAND>`; the result comes back on `/iclock/devicecmd`. `READD_OF_ID`: the removed user an "Add again" brings back. `PROFILE_JSON`: Add employee details, moved to the new user when the device confirms, cleared when the add fails or is cancelled |
| `raw_requests` | Every non-idle device request and response, verbatim. First place to look when something breaks |

`device_users.PASSWORD` and the templates are stored only so a user can be restored or synced to another device later.

**Could this live inside `sanwol_resto` instead?** Yes. Nothing requires a separate DB: put the tables in `sanwol_resto` with a `zk_` prefix (e.g. `zk_attendance_logs`), set `ZK_DB_NAME=sanwol_resto`, and rename the tables in `zktecoModel.js`/`admsService.js`. It would mean one DB, one user and one backup, and joins to `branches`/`employee` become plain joins. Today the code never joins across the two DBs (branch and user names are looked up separately in `zktecoController.attachBranchNames` / `attachUserNames`). Keep it that way, so the split stays possible.

## Moving to the cloud / another network

The device always initiates the connection, so **only the device's Cloud Server Setting and the server's env change.** Nothing changes at the restaurant's router (no port forwarding).

1. **DB.** Create the `zkteco` DB on the cloud server (`zktecoDb.ensureDatabase` tries, but cloud users usually can't `CREATE DATABASE`). Set `ZK_DB_*`. Use a least-privilege user and never expose 3306.
2. **Listener.** Open `ZK_ADMS_PORT` in the cloud firewall. Test from outside: `curl "http://<server>:<port>/iclock/cdata?SN=TEST&options=all"`. You should get `ERROR: unknown device` (allow-list working) or `GET OPTION FROM: TEST`.
3. **HTTPS.** Plain HTTP over the internet exposes passwords and templates. Put nginx/Caddy with TLS in front of the ADMS port (the device does not validate certificates) and turn the device's **PC Connection → HTTPS ON**. With a domain name (Enable Domain Name ON), the device uses port **443** (HTTPS) or **80**. With Cloudflare proxying, only certain ports work (443, 8443, …); see zkteco_test README §11.3. The listener believes `X-Forwarded-For` only from a proxy on the same server (`ZK_TRUST_PROXY`, default loopback), so the logged IP is the real one behind nginx/Caddy and can't be faked by others.
4. **Device.** Set Server Address to the public IP or domain, set the port, then reboot. Punches stored while it was offline upload on reconnect.
5. **New restaurant LAN.** Set the device's IP, gateway and DNS for that network (COMM. → Ethernet). It needs outbound internet to reach the cloud. Nothing in the app changes.
6. **Time.** Keep `ZK_TZ_OFFSET_HOURS=8` even if the cloud server runs in UTC.
7. **Data.** Either export/import the `zkteco` DB, or start clean: on first contact the new server queues `DATA QUERY USERINFO` + `DATA QUERY ATTLOG`, and the device sends back its users, templates and full punch log (the device does **not** re-upload on its own).

Security for an internet-facing ADMS port. The protocol has no login: **the serial number is the only identity**, and it is printed on the device and shown in the app. Anyone who knows it can push made-up punches or user changes, or poll for queued commands. So: keep `ZK_ALLOWED_SERIALS` set (only listed serials can register), set `ZK_ALLOWED_IPS` (or a firewall rule) to the restaurant's public IP if it is static, use HTTPS (step 3) so nothing can be read in transit, and rate-limit `/iclock/*` at the proxy. Refused requests are logged without their body.

## Roadmap notes

- **Time in / time out**: done, see [attendance.md](attendance.md). The device now requires a punch state; unlabeled (255) punches fall back to first = in, last = out. A shift belongs to the day it started, so no business-day cutoff is needed. Attendance is computed on the fly, never stored; `attendance_logs` is never edited.
- **Employees**: done, linked by `device_users.EMPLOYEE_ID` (not by name or PIN). The device stays the master list: adding/removing people still goes through Add User / Remove.
- **Commands to the device.** Use `AdmsService.queueCommand(deviceId, label, command, userId)` (it inserts into `device_commands`). It is delivered on the next poll (≤ 10 s). `applyCommandResult` mirrors successful user add/delete into `device_users`, because the device doesn't echo server-initiated changes. Formats are tab-separated (`\t`):

  | Purpose | Command |
  |---|---|
  | Add/update user | `DATA UPDATE USERINFO PIN=1\tName=Juan\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000100000000\tVerify=0\tViceCard=` |
  | Delete user (and biometrics) | `DATA DELETE USERINFO PIN=1` |
  | Push fingerprint / face | `DATA UPDATE FINGERTMP PIN=1\tFID=6\tSize=…\tValid=1\tTMP=…` / `DATA UPDATE BIODATA Pin=1\t…\tTmp=…` |
  | Query a user / punches | `DATA QUERY USERINFO PIN=1` / `DATA QUERY ATTLOG StartTime=…\tEndTime=…` |
  | Re-read options, upload new data | `CHECK` |
  | Device info / reboot | `INFO` / `REBOOT` |
  | Erase all punches | `CLEAR LOG` (**destructive; never on the client's device**) |

  Strip tabs and newlines from user-entered values before building a command. zkteco_test `src/Api.php` has a tested command builder to port.
- **Multi-device sync.** Templates are stored per device. To restore a user or copy them to a second device, replay their `device_users.FIELDS_JSON` and `biometric_templates` as `DATA UPDATE` commands (zkteco_test's "Restore user + biometrics" does this).
- **Alerts.** `devices.LAST_SEEN_DT` older than a few minutes means the device is offline or unreachable.

## Testing without touching the device

Real device traffic is recorded in `raw_requests` (here and in `zkteco_test.raw_requests`). To test a protocol change, replay those rows through `createAdmsApp()` (exported by `admsServer.js`) into a throwaway DB. Set `ZK_DB_NAME=zkteco_scratch` and stub `dotenv.config` so `.env` doesn't override it, then compare the tables. This is how the Node port was checked against the PHP app. Never post fake data with the real serial number to the live DB.

**Gotcha (cost a sync flood on 2026-10-23):** mysql2 sets `CLIENT_FOUND_ROWS`, so `INSERT … ON DUPLICATE KEY UPDATE` reports `affectedRows = 1` both for a new row **and** for an existing row whose values didn't change (several device requests in the same second). Don't use that number to detect "new row". `touchDevice` uses `INSERT IGNORE` (1 = inserted, 0 = existed) plus a separate `UPDATE`. A scratch test fires 20 concurrent first requests and expects exactly 2 sync commands.
