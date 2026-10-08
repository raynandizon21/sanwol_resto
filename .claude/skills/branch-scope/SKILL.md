---
name: branch-scope
description: Rules for which branches count in "All Branches" totals and where per-branch options (business-day cutoff, floors, cents, service charge) live. Use when adding or changing any analytics/report query, dashboard card, Sales Report page, branch picker, or when a branch is added, renamed, or retired.
---

# Branch scope

This project (Sanwol BBQ Resto) has **no hard-coded real branches**.
Branches come from the `branches` table, and every active branch is counted
in **All Branches** except the developer/testing branch:

| IDNo | Code      | Branch           | All Branches? |
|------|-----------|------------------|---------------|
| 4    | Developer | 3Core            | No (testing)  |
| 14   | BR001     | Sanwol BBQ Resto | Yes           |

A new branch created in the app shows up everywhere automatically: the branch
picker, the All Branches sidebar grid, User Management tabs, and every total.
Don't add name or ID checks for specific branches.

## 3Core exclusion (keep in sync)

3Core is the only excluded branch. It is still viewable on its own: when a
specific `branch_id` is requested, queries filter `= that id` and the exclusion
does not apply.

1. **Python:** `_TEST_BRANCH_IDS = (4,)` in `pyserver/main.py`. It is imported by
   `pyserver/reports.py`.
2. **Node:** `TEST_BRANCH_IDS` in `server/models/expenseModel.js`, the
   `NOT IN (4)` in `server/models/cashReconciliationModel.js`, and
   `TEST_BRANCH_NAME_PATTERN = /3core/i` in `server/services/adminDashboardBundle.js`.
3. **Frontend:** `is3coreBranch` / `isExcludedFromAllBranchesView` in
   `src/utils/branchLogo.ts`, used for the sidebar grid, compare lists and
   User Management tabs (3Core gets its tab last).

When no `branch_id` is given (All Branches), filter out the test branch:

```python
if branch_id:
    branch_filter = "AND b.BRANCH_ID = %s"; params.append(branch_id)
else:
    branch_filter = f"AND b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"
```

The **frontend must send `branch_id=all`** for All Branches. If `branch_id` is
missing, `ReportsController.resolveAnalyticsBranchId` falls back to the
logged-in user's branch.

## Per-branch options

Each option is opt-in by branch `IDNo` and empty (off for every branch) by
default. Add an ID only when a branch really needs it.

| Option | Where |
|--------|-------|
| Business-day cutoff (shift crosses midnight, e.g. `{ 14: 7 }` = day starts 7AM) | `BUSINESS_DAY_START_HOURS` in `server/utils/businessDay.js`, `pyserver/business_day.py` and `src/utils/businessDay.ts`. Keep all three identical. |
| Ground / 2nd-floor tables | `FLOOR_ENABLED_BRANCH_IDS` in `src/utils/floorScope.ts` (only 3Core today) |
| Money shown with cents | `MONEY_CENTS_BRANCH_IDS` in `src/utils/branchFeatures.ts` |
| 10% dine-in service charge | `DINE_IN_SERVICE_CHARGE_BRANCH_IDS` in `src/utils/branchFeatures.ts` |

After changing backend config, restart both services:
`pm2 restart resto-pyserver resto-nodeserver` (or restart `npm run dev:all`).

## Verify

```bash
# Old-project branches must not come back (should print nothing):
grep -rniE "kim'?s|blue ?moon|kumho|eesome|prime bbq|noir|isDemoBranch|NOT IN \(4, ?14" src server/models server/services server/utils server/controllers pyserver/*.py
# Current branches:
#   SELECT IDNo, BRANCH_CODE, BRANCH_NAME, ACTIVE FROM branches;
```

## Telegram bot

`server/services/telegramService.js` builds its report buttons from the same
active branches (`getReportBranches()`, 3Core excluded), one button per branch
with callback `report_branch_<IDNo>`. The "합계 Total" report lists every branch
card from the admin dashboard bundle. The "업장별 비교" button only appears when
both `BRANCH_COMPARE_PUBLIC_URL` (https) and `TELEGRAM_MINIAPP_SECRET` are set in
`.env`. The bot is off by default (`TELEGRAM_POLLING_ENABLED=false`).
