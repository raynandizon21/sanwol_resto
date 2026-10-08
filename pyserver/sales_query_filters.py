"""Shared SQL filters for sales report queries.

Exclude cancelled (STATUS = -1) and deleted (STATUS = -2) orders and billing
from sales computations.
"""

from typing import List, Optional, Tuple

from business_day import branch_ids_by_start_hour

SALES_EXCLUDED_STATUSES = "(-1, -2)"


def order_status_ok(alias: str = "o") -> str:
    return f"{alias}.STATUS NOT IN {SALES_EXCLUDED_STATUSES}"


def billing_status_ok(alias: str = "b") -> str:
    return f"{alias}.STATUS NOT IN {SALES_EXCLUDED_STATUSES}"


def billing_join_on(order_alias: str = "o", billing_alias: str = "b", *, include_paid: bool = True) -> str:
    paid = f" AND {billing_alias}.STATUS IN (1, 2)" if include_paid else ""
    return (
        f"{billing_alias}.ORDER_ID = {order_alias}.IDNo"
        f"{paid} AND {billing_status_ok(billing_alias)} AND {order_status_ok(order_alias)}"
    )


def orders_join_on_billing(billing_alias: str = "b", order_alias: str = "o") -> str:
    return f"{order_alias}.IDNo = {billing_alias}.ORDER_ID AND {order_status_ok(order_alias)}"


def billing_where_clauses(*, include_paid: bool = True, billing_alias: str = "b") -> str:
    parts: list[str] = []
    if include_paid:
        parts.append(f"{billing_alias}.STATUS IN (1, 2)")
    parts.append(billing_status_ok(billing_alias))
    return " AND ".join(parts)


def ph_local_day_range_predicate(column: str, shift_hours: int = 0) -> str:
    """Sargable PH(+08:00) inclusive day range on a raw datetime column.

    CONVERT_TZ / DATE_ADD are applied to *constants* only so MySQL can use an
    index on ``column`` (unlike ``DATE(CONVERT_TZ(column, ...)) BETWEEN ...``).
    ``shift_hours`` moves both bounds forward (business-day cutoff, 0 = calendar days).
    Placeholders: start, start, end, end.
    """

    def shift(expr: str) -> str:
        return f"DATE_ADD({expr}, INTERVAL {int(shift_hours)} HOUR)" if shift_hours else expr

    start_local = shift("CONCAT(%s, ' 00:00:00')")
    end_local = shift("DATE_ADD(CONCAT(%s, ' 00:00:00'), INTERVAL 1 DAY)")
    return (
        f"{column} >= COALESCE("
        f"CONVERT_TZ({start_local}, '+08:00', @@session.time_zone), "
        f"DATE_SUB({start_local}, INTERVAL 8 HOUR)"
        f") AND {column} < COALESCE("
        f"CONVERT_TZ({end_local}, '+08:00', @@session.time_zone), "
        f"DATE_SUB({end_local}, INTERVAL 8 HOUR)"
        f")"
    )


def ph_local_day_range_params(start_date: str, end_date: str) -> List[object]:
    return [start_date, start_date, end_date, end_date]


def ph_local_day_range_filter(
    column: str,
    start_date: str,
    end_date: str,
    branch_column: Optional[str] = None,
) -> Tuple[str, List[object]]:
    """Returns (``AND <predicate>``, params) for a PH-local inclusive date range.

    With ``branch_column`` (e.g. ``"b.BRANCH_ID"``) branches that have a business-day
    cutoff (see business_day.py) use their shifted range and every other branch keeps
    the calendar day. Without it the behaviour is the plain calendar-day range.
    """
    by_hour = branch_ids_by_start_hour() if branch_column else {}
    if not by_hour:
        return f"AND {ph_local_day_range_predicate(column)}", ph_local_day_range_params(start_date, end_date)

    arms: List[str] = []
    params: List[object] = []
    configured_ids: List[int] = []
    for hour, ids in by_hour.items():
        configured_ids.extend(ids)
        id_list = ", ".join(str(int(i)) for i in ids)
        arms.append(f"({branch_column} IN ({id_list}) AND {ph_local_day_range_predicate(column, hour)})")
        params.extend(ph_local_day_range_params(start_date, end_date))
    all_ids = ", ".join(str(int(i)) for i in configured_ids)
    arms.append(
        f"(({branch_column} IS NULL OR {branch_column} NOT IN ({all_ids})) "
        f"AND {ph_local_day_range_predicate(column)})"
    )
    params.extend(ph_local_day_range_params(start_date, end_date))
    return f"AND ({' OR '.join(arms)})", params


def ph_local_day_range_condition(
    column: str,
    start_date: str,
    end_date: str,
    branch_column: Optional[str] = None,
) -> Tuple[str, List[object]]:
    """Same as ``ph_local_day_range_filter`` but without the leading ``AND``.

    For queries that collect their conditions in a ``where`` list and join with `` AND ``.
    """
    sql, params = ph_local_day_range_filter(column, start_date, end_date, branch_column)
    return sql[len("AND "):], params


def session_date_or_business_day_filter(
    column: str,
    start_date: str,
    end_date: str,
    branch_column: str,
) -> Tuple[str, List[object]]:
    """Date filter for reports that historically used ``DATE(column) BETWEEN start AND end``.

    Branches with a business-day cutoff (see business_day.py) get their shifted,
    sargable PH range; EVERY OTHER branch keeps the exact legacy ``DATE(column) BETWEEN ...``
    (DB session timezone), so their numbers cannot move. Returns (``AND <cond>``, params).
    """
    by_hour = branch_ids_by_start_hour()
    legacy = f"DATE({column}) BETWEEN %s AND %s"
    legacy_params: List[object] = [start_date, end_date]
    if not by_hour:
        return f"AND {legacy}", legacy_params

    arms: List[str] = []
    params: List[object] = []
    configured_ids: List[int] = []
    for hour, ids in by_hour.items():
        configured_ids.extend(ids)
        id_list = ", ".join(str(int(i)) for i in ids)
        arms.append(f"({branch_column} IN ({id_list}) AND {ph_local_day_range_predicate(column, hour)})")
        params.extend(ph_local_day_range_params(start_date, end_date))
    all_ids = ", ".join(str(int(i)) for i in configured_ids)
    arms.append(f"(({branch_column} IS NULL OR {branch_column} NOT IN ({all_ids})) AND {legacy})")
    params.extend(legacy_params)
    return f"AND ({' OR '.join(arms)})", params
