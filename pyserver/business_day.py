"""Per-branch "business day" cutoff.

A branch whose shift crosses midnight (e.g. trades 3PM -> 6AM) would otherwise
have an order taken at 12:30AM reported under the *next* calendar date. For
branches listed here a business day starts at the given Manila hour instead of
00:00, i.e. with ``{<branch_id>: 7}`` the business day of 2026-10-06 runs
2026-10-06 07:00 -> 2026-10-07 06:59:59 (PH). Stored timestamps are never
altered -- only how rows are bucketed into days.

Every other branch keeps the plain calendar day (hour 0). Empty = no branch has
a cutoff, so every report uses plain calendar days.

Keep in sync with server/utils/businessDay.js and src/utils/businessDay.ts.
"""

from typing import Dict, List, Optional

BUSINESS_DAY_START_HOURS: Dict[int, int] = {}


def business_day_start_hour(branch_id: Optional[int]) -> int:
    try:
        return int(BUSINESS_DAY_START_HOURS.get(int(branch_id), 0))
    except (TypeError, ValueError):
        return 0


def has_business_day_branches() -> bool:
    return bool(BUSINESS_DAY_START_HOURS)


def branch_ids_by_start_hour() -> Dict[int, List[int]]:
    """Branch ids grouped by cutoff hour, e.g. ``{7: [<branch_id>]}``. Hour 0 is never listed."""
    grouped: Dict[int, List[int]] = {}
    for branch_id, hour in BUSINESS_DAY_START_HOURS.items():
        if hour:
            grouped.setdefault(hour, []).append(branch_id)
    return grouped


def business_day_shift_hours_sql(branch_column: str) -> str:
    """Hours to subtract from a PH-local timestamp to get the row's business-day date.

    ``branch_column`` is a trusted constant such as ``"b.BRANCH_ID"``, never user input.
    """
    whens = " ".join(f"WHEN {int(i)} THEN {int(h)}" for i, h in BUSINESS_DAY_START_HOURS.items())
    return f"(CASE {branch_column} {whens} ELSE 0 END)" if whens else "0"


def business_date_sql(local_dt_expr: str, branch_column: Optional[str] = None) -> str:
    """SQL for the business-day DATE of a PH-local datetime expression.

    Falls back to a plain ``DATE()`` when no branch column is given.
    """
    if not branch_column or not has_business_day_branches():
        return f"DATE({local_dt_expr})"
    return f"DATE(DATE_SUB({local_dt_expr}, INTERVAL {business_day_shift_hours_sql(branch_column)} HOUR))"
