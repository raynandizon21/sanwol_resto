# ZKTeco MB160 integration

The restaurant uses a **ZKTeco MB160** (fingerprint/face/password terminal) for staff time and attendance. This is the **start** of its integration into sanwol_resto. Today the app receives and stores everything the device pushes, shows two pages that update live (**Attendance Logs** and **Employees**, which was called *Device Users* until 2026-10-27), and can add users to the device. Computed attendance, employee profiles and schedules are described in [attendance.md](attendance.md). Everything below is written so later work can extend it, and so the move to a cloud DB or another network is a config change.

The protocol was proven first in the separate test app `zkteco_test` (sibling repo, `C:\Users\Chester\Desktop\Projects\1REPOSITORIES\zkteco_test`). Its README is the long-form protocol and device-menu reference; this doc covers how sanwol_resto does it.

**Where the data lives (since 2026-11-05).** Everything is in the main `sanwol_resto` DB. What came from the ZKTeco integration is named so you can tell at a glance: **tables start with `zk_`** (`zk_devices`, `zk_attendance_logs`, `zk_biometric_templates`, `zk_device_commands`, `zk_raw_requests`, each with a `ZKTeco MB160: …` table comment), and **a person on the device is their `employee` row**, with the device's fields in **`ZK_` columns** (`ZK_PIN`, `ZK_NAME`, `ZK_ON_DEVICE`, …). Until 2026-11-05 this was a separate `zkteco` DB with `device_users`, `attendance_log_corrections`, `attendance_manual_punches` and `operation_logs`; see *Database* for what replaced each.

## Status (2026-11-05)

| Done | Not yet |
|---|---|
| ADMS receiver in the Node server, on its own port | Payroll (see [attendance.md](attendance.md)) |
| `zk_` tables in sanwol_resto, people as `employee` rows (`ZK_` columns) | |
| **Attendance** (hours worked per day from time-ins and time-outs; late, undertime and absences against optional schedules; holidays, day marks, cutoffs) and **employee profiles**: see [attendance.md](attendance.md) | Overtime, payroll (on hold; see attendance.md) |
| **Manual punches** for forgotten punches (`zk_attendance_logs` rows with `SOURCE = 'manual'`) | |
| Attendance Logs page (header date range) | Changing a user's User ID (a new ID = a new user) |
| Employees page (a *Device admin* tag, **Fingerprints** column (which fingers, e.g. "Right index"; at most two, then "+N" with all of them on hover; an orange *None* chip when there are none) and an "Also:" note for any face, palm, card or password set on the device; profile columns in [attendance.md](attendance.md)) | Remote **face** enrollment (not possible on this firmware; enroll faces on the device) |
| **Live updates**: pages re-fetch the moment the device sends data (SSE) | UI to assign a device to a branch (uses `ZK_DEFAULT_BRANCH_ID`) |
| **Add User**: create a user in the app and push it to the device | Offline-device alerts |
| **Remote fingerprint enrollment**: the app makes the device prompt for a finger (right after Add User, or per row) | |
| Initial sync: a newly seen device is asked for all users and punches | HTTPS for the device link (needed for cloud) |
| Stores which biometrics each user has (metadata only: the biometric data itself is never stored, since 2026-11-05) | |
| Mirrors users deleted on the device (OPLOG 103) and cards removed on the device (OPLOG 12) | |
| **Remove users from the app**: their employee row stays (`ZK_ON_DEVICE = 0`), so past punches keep the name; **Show deleted** + **Add again** | |
| **Edit users**: fingerprints; the device name follows the profile name (since 2026-11-04 role, password, card and face are managed on the device only) | |
| **Punch corrections**: edit a punch's time/status, delete and restore punches (raw punches never change) | Change history per punch (only the latest correction is kept) |
| **Cards**: added and removed on the device (like faces); the Employees list shows a Card chip | Remote card prompt (not possible on this firmware) |

## How it works

The **device is the HTTP client**. It connects out to the server and polls it, and the server never connects to the device. That's why commands to the device need no port forwarding, even when the server is in the cloud.

```
 MB160 192.168.110.190                 Node server (this PC 192.168.110.26)                  MySQL
 ─────────────────────                 ─────────────────────────────────────                  ─────
 boot ── GET  /iclock/cdata?options=all ──▶ :2500 admsServer ─▶ reply options + stamps
 punch ─ POST /iclock/cdata?table=ATTLOG ─▶ :2500             ─▶ "OK: n" after commit ─▶ zk_attendance_logs (EMPLOYEE_ID set on arrival)
 enroll  POST /iclock/cdata?table=OPERLOG ▶ :2500             ─▶ "OK: n"             ─▶ employee (ZK_ columns) / zk_biometric_templates
 every 10s GET /iclock/getrequest ────────▶ :2500             ─▶ "OK" or "C:<id>:<cmd>"  ◀─ zk_device_commands
 browser ── GET /data-api/zkteco/* ──▶ Vite :3600 ─▶ API :2300 zktecoRoutes (JWT auth, branch scope) ─▶ zk_* joined with employee / branches / user_info
 browser ── GET /data-api/zkteco/events (SSE) ◀── "change" events ◀── zktecoEvents ◀── admsService (after each commit)
 browser ── POST /data-api/zkteco/device-users ─▶ zk_device_commands (pending) ─▶ next poll ─▶ device ─▶ devicecmd ─▶ employee
```

- **Port 2500 serves only `/iclock/*`.** It is a second Express listener in the same Node process, so none of the app's CORS, session or auth middleware applies. It can be firewalled or exposed on its own.
- **Nothing is lost while the server is down.** The device keeps its logs and resends anything that wasn't acknowledged with `OK: n`. Punches are unique on `(DEVICE_ID, PIN, PUNCH_DT)`, so resends never duplicate.
- **Live updates.** After each commit, `admsService` emits a `change` event (`attendance`, `users`, `commands` or `device`) through `services/zktecoEvents.js`. `GET /zkteco/events` streams them to open pages as Server-Sent Events, filtered by branch, with a `: ping` every 25 s. The pages re-fetch on a matching event (bursts are merged with a 400 ms debounce), and poll every 60 s as a fallback; going offline produces no event. The stream is read with `fetch` (`src/lib/sseClient.ts`), not `EventSource`, so the JWT header is sent. `compression` leaves it alone because of `Cache-Control: no-transform`. **The event bus is in-process**: if the API ever runs as several processes (pm2 cluster), replace it with a shared bus such as Redis pub/sub.
- **Punch times are device-local wall-clock times** (UTC+8). The device code uses its own pool on the main DB (`config/zktecoDb.js`) with `dateStrings: true` and session `time_zone = +08:00`, so they never shift through JS `Date`, and `NOW()` compares with punch times. The main pool (`config/db.js`) has neither, which is why the two stay separate. The UI formats the string as-is.

## Files

| File | Role |
|---|---|
| `server/services/admsServer.js` | The `ZK_ADMS_PORT` listener: raw body, explicit Content-Length, raw-request logging and pruning |
| `server/services/admsService.js` | Protocol handler. **Port of `zkteco_test/src/Adms.php`**; keep the two in step |
| `server/config/zktecoDb.js` | mysql2 pool on the main DB (`DB_*`) with device-local time settings |
| `server/models/zktecoModel.js` | DDL of the `zk_` tables and the `ZK_` columns of `employee` (auto-created on boot) and the queries for the pages |
| `server/controllers/zktecoController.js`, `server/routes/zktecoRoutes.js` | `GET /zkteco/devices`, `/zkteco/attendance-logs`, `/zkteco/device-users`, `/zkteco/device-users/pending`, `/zkteco/events` (SSE); `POST /zkteco/device-users`; `DELETE /zkteco/device-users/:pin`, `DELETE /zkteco/user-commands/:id`; `POST /zkteco/attendance-logs` (manual punch), `PATCH`/`DELETE /zkteco/attendance-logs/:id`, `POST /zkteco/attendance-logs/:id/restore` (device and manual punches alike; plus the fingerprint routes) |
| `src/services/zktecoService.ts` | Frontend API client (via the `/data-api` proxy prefix) |
| `server/services/zktecoEvents.js` | In-process change events (receiver → SSE stream) |
| `src/components/attendance/` | `AttendanceLogs.tsx` (Summary / Punches tabs), `Employees.tsx` (was `DeviceUsers.tsx`), `AddDeviceUserPanel.tsx`, `EnrollFingerprintDialog.tsx`, `EmployeePanel.tsx` (was `EditDeviceUserPanel.tsx`; its Device tab = details, fingerprints, card, face), `RemoveDeviceUserDialog.tsx`, `PunchDialogs.tsx` (edit / delete / add punch), `zktecoShared.tsx` (code labels, device status cards, `useZkLiveReload`, `LiveBadge`). Attendance files: see [attendance.md](attendance.md) |
| `src/constants/sidebarFeatures.ts` | Sidebar keys `employee` (Employees page) and `attendance_logs` (Staff section); also in `ALL_FEATURES` in `server/models/branchSidebarPermissionModel.js`. The CRUD module for the Employees page is still keyed `device_users` |

## Configuration (`.env`)

| Key | Current value | Meaning |
|---|---|---|
| `ZK_ADMS_PORT` | `2500` | Port the device pushes to. Empty disables the listener |
| `ZK_TZ_OFFSET_HOURS` | `8` | Sent to the device as `TimeZone=`, and used for `NOW()` in the device code's DB session |
| `ZK_ALLOWED_SERIALS` | `ECV3262300063` | Allow-list. Other serials get HTTP 403, so they keep their data and retry. **A new device is registered only when listed**: with the list empty, devices registered before keep working and new serials are refused (since 2026-11-04; before, empty meant "any device", which let anyone register a fake device into `ZK_DEFAULT_BRANCH_ID`) |
| `ZK_ALLOWED_IPS` | (empty) | Optional allow-list of source IPs (e.g. the restaurant's static public IP). Others get 403 before their body is read. Empty = any IP |
| `ZK_TRUST_PROXY` | (empty = `loopback`) | Whose `X-Forwarded-For` to believe for the client IP (Express *trust proxy*). Default: only a proxy on the same server. Don't use `true` with the port exposed directly: anyone could fake their IP |
| `ZK_DEFAULT_BRANCH_ID` | `14` (Sanwol BBQ) | Branch assigned to a device **the first time it connects**. Change it later in `zk_devices.BRANCH_ID` |
| `ZK_RAW_LOG_DAYS` | `14` | Days of `zk_raw_requests` to keep. `0` = don't log |
| `ZK_RESYNC_HOURS` | `12` (default) | Hours between automatic full syncs (`DATA QUERY USERINFO`) that keep the app a mirror of the device. `0` = off |
| `ZK_COMMAND_LOG_DAYS` | `30` (default) | Days to keep finished `zk_device_commands` (pending/sent ones are never pruned). `0` = keep |

The DB is the main one (`DB_*`). The `ZK_DB_*` keys of the old separate `zkteco` DB are gone.

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

  `admsService.touchDevice` queues both automatically the **first time a serial number is seen** (`INITIAL_SYNC_COMMANDS`). This also covers moves to an empty DB (e.g. the cloud). To re-sync a device that is already registered, queue the two commands by hand: `INSERT INTO zk_device_commands (DEVICE_ID, LABEL, COMMAND) VALUES (<IDNo>, 'Manual sync: users', 'DATA QUERY USERINFO')`, and the ATTLOG query above with a real tab. **Don't delete the `zk_devices` row to force it:** the device would get a new `IDNo`, and its people (`employee.ZK_DEVICE_ID`) and punches would be orphaned, then duplicated under the new ID. Both queries are read-only, and resent data is deduplicated.
- **Verify types in ATTLOG.** `1` fingerprint, `3` password, `4` card (observed 2026-10-26), `15` face. Status is `255` unless the user presses a status key, and `0` (time-in) when the punch-state key is used. **Since 2026-10-27 the device is set to require a punch state**, so new punches always carry 0 time-in, 1 time-out, 4 OT-in or 5 OT-out (2/3 = break). Older punches may still be `255`. The app shows 0/1 as **Time-in / Time-out**. For attendance, 0/3/4 count as arriving and 1/2/5 as leaving ([attendance.md](attendance.md)); the app itself only sets 0/1.
- **One face = 12 `FACE` templates** (FID 0–11). Treat face as yes/no, never as a count.
- **Deleting a user on the device sends no USER line**, only `OPLOG 103` with OBJ1 = PIN. The device's user count drops by one each time. `admsService.saveOpLog` takes the person off the device (`ZK_ON_DEVICE = 0`) and deletes their templates, but only if they were last written before the event (a history re-upload can replay an old delete). Other OPLOG events are acknowledged but not stored (they stay in `zk_raw_requests` for `ZK_RAW_LOG_DAYS`).
- **Privilege** `14` = super admin, `0` = normal user.
- **Cards (tested live 2026-10-26):** this unit has the optional **125 kHz EM (ID)** reader. The box only says "Optional: ID/ADMS", so check the unit, not the box. There's no slot: the card is read around the **fingerprint sensor area**. It reads the chip's ID, not anything printed on the card. **13.56 MHz NFC/Mifare cards are not read at all** (`IsSupportNFC=0` in the options). The card bundled with the device works. A card enrolled on the device arrives in the USER line (`Card=…` → `employee.ZK_CARD_NO`, e.g. `4772564`) with `OPLOG 8`, and card punches have verify type `4`. **Removing a card on the device sends only `OPLOG 12`** (OBJ1 = PIN), no USER line; a `DATA QUERY USERINFO PIN=x` afterwards reported `Card=` (empty). **An unregistered card swiped at the main screen sends nothing** (and shows nothing). **No remote card prompt** (probed live 2026-10-26 with a test user and a card at the device): `ENROLL_CARD` and 30+ other guesses → `-1002` (unknown), including `ENROLL_CARDNUMBER`, `ENROLL_CARD_NO`, `ENROLL_BADGE`, `ENROLL_IDCARD`, `ENROLL_ID`, `ENROLL_RF(CARD)`, `ENROLL_HID(CARD)`, `ENROLL_EM(CARD)`, `ENROLL_IC(CARD)`, `ENROLL_PROX(CARD)`, `ENROLL_RFID`, `ENROLL_MIFARE`, `ENROLL_VICECARD`, `ENROLL_USER`, `ENROLL_CN`, `ENROLL_NC`, `REG_CARD`, `REGISTER_CARD`, `READ_CARD`, `ENROLL_PWD`. The verb is matched by prefix (`ENROLL_MFCARD` runs as `ENROLL_MF`). **`ENROLL_MF`** is the only card-related verb it knows: it answers `Return=0` at once, shows **nothing** on screen, then silently waits ~65 s for a Mifare card (a second `ENROLL_MF` in that time waits it out and gets `-1003`). Tapping the 125 kHz card or a 13.56 MHz NFC card during the wait does nothing. Don't use it.
- **Remote enrollment (tested live 2026-10-23):** `ENROLL_FP` works (Return 0 = enrolled, 6 = nobody scanned, 4 = that finger is already enrolled, for anyone including the same user). `DATA DELETE FINGERTMP PIN=…\tFID=…` removes one finger (Return 0). **Face cannot be started remotely:** `ENROLL_FACE` → `-1002` (unknown command), and `ENROLL_BIO TYPE=2` opened the *fingerprint* prompt instead (ended `-1003` with no finger). Faces are enrolled on the device (MENU → User Mgt. → user → Edit → Face) and sync to the app automatically.
- **Adding a user from the server** (`DATA UPDATE USERINFO PIN=…\tName=…\tPri=…\tPasswd=…\tCard=…\tGrp=1\tTZ=0000000100000000\tVerify=0\tViceCard=`) returns `Return=0` about 6 s after queueing (one poll), and the device's user count goes up by one. Verified end-to-end on 2026-10-23 (test user 9001 added, then removed with `DATA DELETE USERINFO PIN=9001`).

## Adding users from the app

**Employees → Add employee** (needs admin, or a role granted **Employees → Add** in User Access → CRUD permissions; the server enforces it too). Since 2026-11-04 everyone added from the app is a **regular user (Pri=0) with no password**: staff punch with their fingerprint, and device admins are made on the MB160 itself. The server ignores any `privilege`/`password` sent. Fields and limits, enforced in both `AddDeviceUserPanel.tsx` and `zktecoController.createDeviceUser`:

| Field | Rule |
|---|---|
| User ID (PIN) | **Not typed** (since 2026-11-06): assigned by the server (`ZktecoModel.nextNewUserPin`), and a `pin` in the body is ignored. It is one more than the highest User ID ever used on the device: by anyone on it or removed (`ZK_PIN`), by a punch (`zk_attendance_logs.PIN`, also IDs nobody here has), or by an add still pending/sent. So a removed person's ID is never given to someone new. IDs that aren't 1–9 digits without a leading zero are ignored. **Add again** keeps the old ID while nobody else has it. The form shows the ID as a read-only preview (`GET /zkteco/device-users/next-pin?device_id=&readd_of=`). The add picks it again under a per-device MySQL lock (`withAddUserLock`, `GET_LOCK('zk_add_user_<device>')`), so two adds at once get different IDs. If another add took the shown ID first, the form's toast says which ID was used. IDs typed on the MB160 itself can still reuse a number, so the one-person-per-User-ID handling below stays |
| Profile (`profile`, snake_case like `PATCH /attendance/employees/:id`) | First name required; last name, position, date hired, contact and other details optional. Validated by `utils/employeeProfile.readProfile` (same as the Profile tab) |
| Name on the device | Not typed (since 2026-11-04): the server makes it from the profile name, up to 24 characters (`deviceNameFor`): *First Last* → *First L.* → fewer first-name words with the initial → fewer first-name words → first word cut to 24 characters. Tabs, line breaks and control characters become spaces. The form shows the result. A `name` in the body is only used when no `profile` is sent |
| Card, face | Not part of Add employee: added on the device afterwards (see *Registering cards*) |

**How the profile details reach the profile** (no employee row until the device confirms): they're stored as JSON on the command (`zk_device_commands.PROFILE_JSON`). When the device answers `Return=0`, `applyCommandResult` → `saveUser` creates the employee row with those details and the device fields, or for **Add again** puts the same employee row back on the device and updates its details, and clears the command's copy, all in one transaction. A rejected, unanswered or cancelled add clears `PROFILE_JSON`, so personal details don't stay in the queue and no orphan profile is left.

The request queues a command. It does **not** write `employee`. The person appears in the list when the device confirms (`applyCommandResult`), stored with `ZK_SOURCE = 'server'` (kept even after they enroll a fingerprint on the device; no longer shown on the page since 2026-11-06). Until then, a "Sending to device" strip shows it as *Waiting for the device* (`pending`) or *Delivered, waiting for confirmation* (`sent`). A rejection shows as *Rejected by device (code N)* for a day. If the device is offline, the command waits in the queue and is delivered when it reconnects. Fingerprint/face is enrolled on the device afterwards (MENU → User Mgt. → user → Edit).

Raw `COMMAND` text contains the device password, so `getPendingUserCommands` parses out only PIN and name.

## Keeping the app a mirror of the device

- **`ZK_SYNCED_DT`** (employee) and **`SYNCED_DT`** (zk_biometric_templates) are set every time the device reports the person or template. **`ZK_EDITED_DT`** / **`EDITED_DT`** move only when a field or template really changes (templates are compared by `TEMPLATE_HASH`).
- After a successful **`DATA QUERY USERINFO`** (all users, or `PIN=x`), `reconcileAfterUserQuery` waits 20 s for the uploads to settle. It then takes people off the device (see *Removing users*) and deletes templates in that scope that the device didn't report since the query was sent. That is how fingerprints or users removed **at the device** disappear here (the device only announces whole-user deletes, via OPLOG 103, and card removals, via OPLOG 12; `saveOpLog` applies both right away, but only to rows last written before the event). zkteco_test only stores OPLOG lines; acting on 103/12 is sanwol_resto-only, and sanwol_resto doesn't store OPLOG lines.
- **Count-mismatch sync** (since 2026-11-06; sanwol_resto-only). The firmware never re-sends an upload the server missed. On 2026-11-06 the server crash-looped for hours on leftover merge-conflict markers, so a user added, a user renamed and a finger re-enrolled at the device never reached the DB. So `syncIfCountsDiffer` runs on every `getrequest`: it compares the device's last reported `USER_COUNT` / `FP_COUNT` (from `INFO`, which the device sends only at boot and after commands or uploads) with the employees on the device (`ZK_ON_DEVICE = 1`) and their `FP` templates. If they differ, it queues `DATA QUERY USERINFO` ("Count mismatch sync"). It does this at most once per 30 min, and never while a full user query is still pending or sent. Faces aren't compared (one face is 12 templates, and the unit of `FaceCount` isn't verified).
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

- **On the device:** MENU → User Mgt. → user → Edit → **Card Number** → hold the card against the fingerprint sensor area until it beeps → save and **exit the user's menu**. The device sends the USER line with `Card=…` **only once the user's menu is exited**, not when the card is read or saved (confirmed live 2026-10-26: it arrived ~80 s after entering the menu, as the admin backed out). That updates `employee.ZK_CARD_NO` and, through the live stream, the Card chip on the row.
- **Removing a card** is done on the device (Edit → Card Number → delete; `OPLOG 12` clears `ZK_CARD_NO` here right away). Since 2026-11-04 the app no longer has Card, Face, Password or Role sections in Edit user (the restaurant uses fingerprints); an edit from the app keeps whatever the device has.
- The API returns only `HAS_CARD`, never the card number.
- History: a guided *Register card* dialog (opened from Add User, the row and the fingerprint dialog) was built and then removed on 2026-10-26. Since the device's menu is needed anyway, it only added a step. The Card and Face status sections of Edit user, and *Remove card* / password / role editing, were removed on 2026-11-04.

## Editing users

**Employees → pencil → Device tab** shows the **name on the device** (read-only) and the **fingerprints** (Add or Edit, same rule as enrollment; the enrollment dialog opens on top of the panel, `layerClassName="z-[110]"`, the side panel is `z-[101]`). Role (admins), password, card and face are managed on the MB160 only.

- **The name on the device follows the profile name** (since 2026-11-04; there's no rename endpoint any more). Saving a profile (`PATCH /attendance/employees/:id`) calls `services/deviceNameSync.syncDeviceName`, which queues the profile name shortened to 24 characters (`deviceNameFor`) when it differs from the device's name, or from the name a pending rename will set. A pending removal skips it. A rename made on the device isn't copied to the profile.
- **The device has no "edit": `DATA UPDATE USERINFO` replaces the whole record.** So a rename is built with the user's **current** `Pri`, `Passwd`, `Card`, `Grp`, `TZ` and `Verify` (the `ZK_` columns, via `ZktecoModel.getDeviceUserForEdit`) and changes only the name (`admsService.buildUserUpdateCommand`). Never reuse `buildUserUpsertCommand` (the add command) for an existing user: it sends `Card=` and an empty password and would wipe them. Verified live 2026-10-26: renaming test user 9101 returned `Return=0`, and `DATA QUERY USERINFO` reported the new name with the other fields unchanged. *Still to verify live: a user's fingerprint survives an edit.*
- Renames are queued in order, and each carries the newest name, so a second rename before the first is confirmed is safe. Removal still waits for a pending rename (409). The User ID can't be edited. The API never returns the password or card number.
- Edits are told apart from adds in `zk_device_commands` by their label (`Edit user …`, `USER_EDIT_LABEL_PREFIX`). The pending strip shows them as *Edit: …* (cancellable until the device picks them up) and the row as *Updating…*. The app's copy changes when the device confirms (`applyCommandResult` → `saveUser`).

## Removing users

**Employees → trash button** (needs admin, or **Employees → Delete** in CRUD permissions). `DELETE /zkteco/device-users/:pin?device_id=` queues `DATA DELETE USERINFO PIN=x` (verified 2026-10-23: the device deletes the user with their fingerprints, face and card). The pending strip shows *Remove: …* with **Cancel** until the device picks it up.

- **Refused** (409): the device's **only admin** (privilege 14/6; without one anyone can open the device menu), a user already being removed, or while a fingerprint enrollment is running on that device.
- **The person stays.** All three removal paths (the app's delete on the device's `Return=0`, a delete on the device via OPLOG 103, a user missing from a full sync) run `ZktecoModel.REMOVE_FROM_DEVICE_SQL`: `ZK_ON_DEVICE = 0`, `ZK_REMOVED_BY` = who removed them in the app (NULL = on the device). The employee row keeps profile, `ZK_PIN` and `ZK_NAME`, so **past punches keep their name**. What the device erased is erased here too: `ZK_PASSWORD`, `ZK_CARD_NO` and all of that PIN's rows in `zk_biometric_templates`.
- **One person per User ID.** `ZK_ACTIVE_PIN` is a stored generated column (`ZK_PIN` while `ZK_ON_DEVICE = 1`, else `NULL`) with `UNIQUE (ZK_DEVICE_ID, ZK_ACTIVE_PIN)`. `admsService.saveUser` updates whoever holds the PIN, or else gives the PIN a person: the employee named by an "Add again" command, or a **new employee row** (from the Add employee details, or named as on the device). A User ID reused on the device is a new person; someone removed only comes back through Add again (or **Returning employee?**, see [attendance.md](attendance.md)).
- **Who a punch belongs to** is decided **when it arrives** and stored in `zk_attendance_logs.EMPLOYEE_ID` (`saveAttLogs` → `punchOwner`): among the employees who have had that User ID on the device, the one put on it (`ZK_ADDED_DT`) most recently at or before the punch, else the earliest (punches older than everyone, e.g. history uploaded on first connect). A punch whose User ID nobody has stays `NULL` (*Not on device*) and is adopted when that user shows up (`saveUser`). So a reused PIN never moves the old person's punches, and no query has to work it out again.
- **Show deleted** (Employees) lists removed people greyed out with *Removed* (tooltip: who removed them, or "on the device") and **Add again** (Add employee pre-filled with their details; the server gives them back their old User ID when free).
- **Add again is the same row.** The add carries `readd_of` = the employee's `IDNo`, stored as `zk_device_commands.EMPLOYEE_ID`; the controller refuses it (409) if they're already back on the device or have an add pending (`readdBlocker`). When the device confirms, that employee row gets the device fields back (`ZK_ON_DEVICE = 1`, the new `ZK_PIN`, `ZK_ADDED_DT` = now, `ZK_EDITED_DT` cleared so an old OPLOG 103 replay can't remove them again). Their punches are already theirs. In Attendance Logs, a punch the device recorded under an older User ID shows *now 9102* (`CURRENT_PIN`), search matches either ID, and *People who punched* counts by `PERSON_ID` (= `EMPLOYEE_ID`).

## Correcting punches

**Attendance Logs → pencil / trash** (needs admin, or **Attendance Logs → Edit** (edit) / **Delete** (delete and restore) in CRUD permissions). Device and manual punches share the endpoints and the table (`zk_attendance_logs`, `SOURCE` tells them apart).

- **A device punch's own record is never changed.** `PUNCH_DT`, `PUNCH_STATUS`, `PIN` and `RAW_LINE` stay as the device sent them; an edit is stored beside them in `PUNCH_DT_NEW` / `PUNCH_STATUS_NEW`. Setting a value back to the original stores `NULL`, so "Use the device's record" clears the edit. A history re-upload can't undo a correction: punches are unique on `(DEVICE_ID, PIN, PUNCH_DT)` and resent ones are ignored.
- **A manual punch is simply changed** (it's app data): `PUNCH_DT` / `PUNCH_STATUS` are updated.
- **`EFFECTIVE_DT`** is a stored generated column, `COALESCE(PUNCH_DT_NEW, PUNCH_DT)`, indexed with `BRANCH_ID` and with `EMPLOYEE_ID`. Date ranges, ordering and attendance use it, so they're index lookups.
- **Reasons (since 2026-11-05):** adding, editing and deleting a punch all require a reason (dialog and server). The only exceptions are setting a device punch back to what the device recorded (that clears the correction and its reason) and restoring (which keeps the delete's reason). The edit dialog starts with an empty reason and shows the previous one underneath, so an old reason is never saved against a new change.
- **Edit** (`PATCH /zkteco/attendance-logs/:id { punch_dt, status, reason }`): date/time (device-local text, not in the future) and status (Time-in / Time-out, or the type it has now or had on the device). A manual punch can't share the exact time of another of that person's counted punches.
- **Delete / restore** (`DELETE …/:id { reason }`, `POST …/:id/restore`): `IS_DELETED`. Edits are kept, so a restored punch comes back as it was. A deleted punch can't be edited until restored.
- **Reads**: `getAttendanceLogs` returns the corrected `PUNCH_DT` / `PUNCH_STATUS`, the originals as `ORIGINAL_*`, `IS_EDITED`, `IS_DELETED`, reason, and who/when (`CORRECTED_BY_NAME`, `ADDED_BY_NAME`, joined from `user_info`). Deleted punches are left out unless `include_deleted=1` (**Show deleted**), and never count in the page's totals or in attendance.
- The page shows *Edited* (orange) / *Deleted* (red) tags; the tooltip has the device's original, who changed it and the reason. Only the **latest** correction and reason are kept, not a history.
- Anything that computes attendance (time in/out, payroll) must read `EFFECTIVE_DT`, `COALESCE(PUNCH_STATUS_NEW, PUNCH_STATUS)` and skip `IS_DELETED = 1`: use `ZktecoModel.getPunchesForAttendance`.

## Database

All in the main `sanwol_resto` DB, with sanwol_resto conventions: snake_case tables, UPPERCASE columns, `IDNo` primary key, `*_ID` references, `*_DT` datetimes, `ACTIVE`, `ENCODED_*`/`EDITED_*`, `utf8mb4_general_ci`. **Naming rule: tables that belong to the ZKTeco integration start with `zk_`, and columns it adds to an existing table start with `ZK_`.** Each `zk_` table also has a `ZKTeco MB160: …` table comment, and each `ZK_` column a `ZKTeco: …` column comment. The DDL is in `zktecoModel.js` (created on boot).

| Table | Contents |
|---|---|
| `zk_devices` | One row per serial number: `BRANCH_ID`, IP, firmware, device-reported counts, stamps, `LAST_SEEN_DT` (online = seen in the last 60 s) |
| `employee` (`ZK_` columns) | **A person on the device = their employee row.** `ZK_DEVICE_ID`, `ZK_PIN` (User ID), `ZK_ON_DEVICE`, `ZK_ACTIVE_PIN` (generated, unique per device), `ZK_NAME`, `ZK_PRIVILEGE`, `ZK_PASSWORD` and `ZK_CARD_NO` (**never returned by the API**), `ZK_GROUP_NO`, `ZK_USER_TZ`, `ZK_VERIFY_MODE`, `ZK_SOURCE` (`device` / `server`), `ZK_ADDED_DT`, `ZK_EDITED_DT`, `ZK_REMOVED_BY`, `ZK_SYNCED_DT`. The profile columns are described in [attendance.md](attendance.md). Employees that were never on a device have `ZK_DEVICE_ID = NULL` and don't appear on the Employees page |
| `zk_attendance_logs` | Every punch: from the device (`SOURCE = 'device'`, own fields never changed) or added in the app (`SOURCE = 'manual'`, no `DEVICE_ID`/`PIN`). `EMPLOYEE_ID` set on arrival; corrections in `PUNCH_DT_NEW` / `PUNCH_STATUS_NEW` / `IS_DELETED` / `REASON`; `EFFECTIVE_DT` generated. `BRANCH_ID` is the device's branch at punch time |
| `zk_biometric_templates` | Which FP / FACE / BIODATA templates and photos each User ID has (kind, finger number, size, validity, `TEMPLATE_HASH`). **The biometric data itself is not stored** (since 2026-11-05). **`EMPLOYEE_ID`** (since 2026-11-06) = the owner, a real foreign key to `employee.IDNo` (`fk_zk_biometric_templates_employee`, ON DELETE SET NULL, indexed): set on arrival to whoever has that User ID on the device, filled in by `saveUser` for templates sent before their USER line (`linkTemplates`), and moved by `mergeIntoFormerEmployee`. NULL = nobody has that User ID yet. The device still identifies templates by `(DEVICE_ID, PIN)`, which the code uses for syncing and deletes. Added to existing tables by `ZktecoModel.migrateZkTables` (`ZK_TABLE_COLUMNS` / `_INDEXES` / `_FOREIGN_KEYS`, plus a backfill of NULL owners on every start) |
| `zk_device_commands` | Server → device queue. `IDNo` is sent as `C:<IDNo>:<COMMAND>`; the result comes back on `/iclock/devicecmd`. `EMPLOYEE_ID`: the removed person an "Add again" brings back. `PROFILE_JSON`: Add employee details, applied when the device confirms, cleared when the add fails or is cancelled. Finished commands are deleted after `ZK_COMMAND_LOG_DAYS` |
| `zk_raw_requests` | Every non-idle device request and response, with template and photo payloads blanked (`TMP=[1868 chars not stored]`). Deleted after `ZK_RAW_LOG_DAYS`. First place to look when something breaks |

**What replaced the old `zkteco` DB (2026-11-05).** `devices`, `attendance_logs`, `biometric_templates`, `device_commands`, `raw_requests` → the `zk_` tables above. `device_users` → `employee` `ZK_` columns (its history rows, `READDED_AS_ID`, `PENDING_PROFILE_JSON` and the link pass `employeeLinkService` went away: the profile is created in the same transaction as the device user). `attendance_log_corrections` and `attendance_manual_punches` → folded into `zk_attendance_logs`. `operation_logs` → dropped (it was only written; the 103/12 events it carried are still applied). Biometric payloads (`TEMPLATE`) and the raw `FIELDS_JSON` copies → no longer stored. The local data was not migrated: the device re-sent its users and punches on first connect, and the existing profile #6 (3Core) was linked to User ID 1 by hand.

`ZK_PASSWORD` and `ZK_CARD_NO` are kept only because an edit has to resend the whole user record (see *Editing users*).

## Moving to the cloud / another network

The device always initiates the connection, so **only the device's Cloud Server Setting and the server's env change.** Nothing changes at the restaurant's router (no port forwarding).

1. **DB.** Nothing extra: the `zk_` tables and `ZK_` columns are created in the main DB (`DB_*`) on boot. The app's MySQL user needs `CREATE`/`ALTER` for that first boot. Never expose 3306.
2. **Listener.** Open `ZK_ADMS_PORT` in the cloud firewall. Test from outside: `curl "http://<server>:<port>/iclock/cdata?SN=TEST&options=all"`. You should get `ERROR: unknown device` (allow-list working) or `GET OPTION FROM: TEST`.
3. **HTTPS.** Plain HTTP over the internet exposes passwords and templates. Put nginx/Caddy with TLS in front of the ADMS port (the device does not validate certificates) and turn the device's **PC Connection → HTTPS ON**. With a domain name (Enable Domain Name ON), the device uses port **443** (HTTPS) or **80**. With Cloudflare proxying, only certain ports work (443, 8443, …); see zkteco_test README §11.3. The listener believes `X-Forwarded-For` only from a proxy on the same server (`ZK_TRUST_PROXY`, default loopback), so the logged IP is the real one behind nginx/Caddy and can't be faked by others.
4. **Device.** Set Server Address to the public IP or domain, set the port, then reboot. Punches stored while it was offline upload on reconnect.
5. **New restaurant LAN.** Set the device's IP, gateway and DNS for that network (COMM. → Ethernet). It needs outbound internet to reach the cloud. Nothing in the app changes.
6. **Time.** Keep `ZK_TZ_OFFSET_HOURS=8` even if the cloud server runs in UTC.
7. **Data.** Either export/import the `zk_` tables together with `employee`, or start clean: on first contact the new server queues `DATA QUERY USERINFO` + `DATA QUERY ATTLOG`, and the device sends back its users, templates and full punch log (the device does **not** re-upload on its own). Starting clean against an `employee` table that already has profiles creates a new profile per device user; link existing profiles first (set `ZK_DEVICE_ID`, `ZK_PIN`, `ZK_ON_DEVICE = 1` once the `zk_devices` row exists, as was done locally on 2026-11-05) or merge them afterwards with **Returning employee?**. Edits and manual punches live only in the app, so they come over only with an export.

Security for an internet-facing ADMS port. The protocol has no login: **the serial number is the only identity**, and it is printed on the device and shown in the app. Anyone who knows it can push made-up punches or user changes, or poll for queued commands. So: keep `ZK_ALLOWED_SERIALS` set (only listed serials can register), set `ZK_ALLOWED_IPS` (or a firewall rule) to the restaurant's public IP if it is static, use HTTPS (step 3) so nothing can be read in transit, and rate-limit `/iclock/*` at the proxy. Refused requests are logged without their body.

## Roadmap notes

- **Time in / time out**: done, see [attendance.md](attendance.md). The device now requires a punch state; unlabeled (255) punches fall back to first = in, last = out. A shift belongs to the day it started, so no business-day cutoff is needed. Attendance is computed on the fly, never stored; a device punch's own fields are never edited.
- **Employees**: done; a person on the device is their `employee` row (`ZK_` columns), never matched by name. The device stays the master list: adding/removing people still goes through Add employee / Remove.
- **Commands to the device.** Use `AdmsService.queueCommand(deviceId, label, command, userId)` (it inserts into `zk_device_commands`). It is delivered on the next poll (≤ 10 s). `applyCommandResult` mirrors successful user add/edit/delete into `employee`, because the device doesn't echo server-initiated changes. Formats are tab-separated (`\t`):

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
- **Multi-device.** An employee is on at most one device (`ZK_DEVICE_ID`). Staff on two devices would need a link table (employee ↔ device ↔ PIN) in place of the `ZK_` columns. Since biometric data isn't stored (2026-11-05), the app can't copy a user's fingerprints to another device: enroll them there (remotely with `ENROLL_FP`).
- **Alerts.** `zk_devices.LAST_SEEN_DT` older than a few minutes means the device is offline or unreachable.

## Testing without touching the device

Real device traffic is recorded in `zk_raw_requests` (here and in `zkteco_test.raw_requests`; template payloads are blanked here, so replayed templates arrive without data). To test a protocol change, replay those rows (or hand-written device lines) through `createAdmsApp()` / `AdmsService.dispatch` into a throwaway DB: create it with `CREATE TABLE … LIKE` copies of `employee`, `branches` and `user_info`, set `DB_NAME` to it, stub `dotenv.config` so `.env` doesn't override it, and use a fake serial in `ZK_ALLOWED_SERIALS`. The 2026-11-05 refactor was checked this way (users, punches before/after their user, OPLOG 12/103, reused PINs, Add employee, Add again, edits, removals, manual punches, corrections, Returning employee, full-sync reconcile, log redaction). Never post fake data with the real serial number to the live DB.

**Don't edit the zk code while the dev server (nodemon) and the device are both running if the schema is changing.** Each save restarts the server, and a half-edited model can create tables or rows with the old design (this happened on 2026-11-05: old-named tables and a duplicate profile had to be dropped). Stop the server, or write the model first.

**Gotcha (cost a sync flood on 2026-10-23):** mysql2 sets `CLIENT_FOUND_ROWS`, so `INSERT … ON DUPLICATE KEY UPDATE` reports `affectedRows = 1` both for a new row **and** for an existing row whose values didn't change (several device requests in the same second). Don't use that number to detect "new row". `touchDevice` uses `INSERT IGNORE` (1 = inserted, 0 = existed) plus a separate `UPDATE`. A scratch test fires 20 concurrent first requests and expects exactly 2 sync commands.
