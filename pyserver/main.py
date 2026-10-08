from typing import Any, List, Optional, Literal, Dict, cast, Tuple
import os
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, date

import mysql.connector
from mysql.connector import pooling
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from business_day import business_date_sql
from sales_query_filters import (
    billing_join_on,
    billing_where_clauses,
    orders_join_on_billing,
    ph_local_day_range_condition,
    ph_local_day_range_filter,
    ph_local_day_range_predicate,
    ph_local_day_range_params,
)


BASE_DIR = Path(__file__).resolve().parents[1]

_BILLING_JOIN = billing_join_on()
_BILLING_WHERE = billing_where_clauses()
_ORDERS_ON_BILLING = orders_join_on_billing()

# Load shared env used by Node server
load_dotenv(BASE_DIR / ".env.local")
load_dotenv(BASE_DIR / ".env", override=False)

# PH-local instant for expenses.ENCODED_DT — matches daily-sales billing bucketing (+08:00).
_EXPENSE_LOCAL_DT_SQL = """COALESCE(
    CONVERT_TZ(e.ENCODED_DT, @@session.time_zone, '+08:00'),
    DATE_ADD(e.ENCODED_DT, INTERVAL 8 HOUR)
)"""

# 3Core (IDNo=4) — developer/testing branch. Excluded from "All Branches" aggregates
# (branch_id not given) so it never inflates admin dashboard totals/trend. Mirrors
# is3coreBranch() in src/utils/branchLogo.ts and TEST_BRANCH_NAME_PATTERN in adminDashboardBundle.js.
_TEST_BRANCH_IDS = (4,)


def _get_db_config() -> dict:
    return {
        "host": os.getenv("DB_HOST", "localhost"),
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
        "database": os.getenv("DB_NAME"),
        "port": int(os.getenv("DB_PORT", "3306")),
    }


db_config = _get_db_config()

db_pool: Optional[pooling.MySQLConnectionPool] = None


def get_connection():
    """
    Get a DB connection from the pool.

    The mobile app can burst many parallel analytics requests (swipe + prefetch).
    With a small pool, MySQLConnectionPool can temporarily exhaust and raise.
    We retry briefly, then fall back to a direct connection to avoid intermittent 0/blank charts.
    """
    if db_pool is None:
        # Fallback: try a direct connection rather than crashing the whole request.
        return mysql.connector.connect(**db_config)

    last_exc: Exception | None = None
    for _ in range(4):
        try:
            return db_pool.get_connection()
        except Exception as exc:
            last_exc = exc
            time.sleep(0.05)

    # Last resort: direct connect (may be slower, but avoids flakiness)
    try:
        return mysql.connector.connect(**db_config)
    except Exception:
        # Re-raise original pool error so endpoints can report it
        raise last_exc or RuntimeError("Failed to get database connection")


app = FastAPI(title="RESTO Analytics PyServer", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _ensure_order_items_line_cost(conn) -> None:
    """Idempotent: add order_items.LINE_COST if missing (same as Node ensureSchema)."""
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'LINE_COST'
            LIMIT 1
            """
        )
        if cur.fetchone():
            return
        cur.execute(
            """
            ALTER TABLE order_items
            ADD COLUMN LINE_COST DECIMAL(12,2) NULL DEFAULT NULL
            COMMENT 'Per-line product cost (report Product unit price column); used for gross profit'
            AFTER LINE_TOTAL
            """
        )
        conn.commit()
        print("[PyServer] order_items.LINE_COST created")
    except Exception as exc:
        print("[PyServer] ensure LINE_COST failed:", getattr(exc, "message", str(exc)))
    finally:
        cur.close()


@app.on_event("startup")
def init_db_pool():
    """
    Initialize MySQL connection pool and log basic DB info.
    """
    global db_pool
    try:
        db_pool = pooling.MySQLConnectionPool(
            pool_name="resto_pool",
            # Increase pool to better handle parallel analytics bursts.
            pool_size=int(os.getenv("DB_POOL_SIZE", "20")),
            pool_reset_session=True,
            **db_config,
        )
        conn = db_pool.get_connection()
        cur = conn.cursor()
        cur.execute("SELECT DATABASE()")
        row = cur.fetchone()
        cur.close()
        _ensure_order_items_line_cost(conn)
        conn.close()
        print(
            f"[PyServer] Connected to MySQL at {db_config['host']}:{db_config['port']} - DB: {row[0] if row and row[0] else db_config['database']}"
        )
    except Exception as exc:
        print("[PyServer] Failed to initialize MySQL pool:", getattr(exc, "message", str(exc)))


@app.get("/health")
def health_check():
    """
    Basic health check. Also reports if DB config looks present.
    """
    return {
        "status": "ok",
        "service": "pyserver",
        "db_configured": bool(db_config.get("database")),
    }


def _mysql_column_exists(cur, table: str, column: str) -> bool:
    try:
        cur.execute(
            """
            SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s
            LIMIT 1
            """,
            (table, column),
        )
        return cur.fetchone() is not None
    except Exception:
        return False


@app.get("/api/analytics/sample")
def sample_analytics():
    return {
        "success": True,
        "data": {
            "message": "Python analytics service is working",
        },
    }


class BranchSalesItem(BaseModel):
    branch_id: int
    branch_name: str
    branch_code: str
    total_sales: float
    order_count: int
    avg_order_value: float
    # Same formula as daily-sales net (paid + discount - discount - refund = paid - refund).
    net_sales: float = 0.0


class LeastSellingItem(BaseModel):
    IDNo: int
    MENU_NAME: str
    MENU_PRICE: float
    category: str
    total_quantity: int
    order_count: int
    total_revenue: float


class TopSellingItem(LeastSellingItem):
    """
    Top-selling menu item. Shape is identical to LeastSellingItem.
    """
    pass


class ProfitDriverRow(BaseModel):
    """Lightweight row for Sales Analytics profit drivers (menu-report compatible shape)."""
    id: int
    goods: str
    category: str
    branch: str
    branch_id: Optional[int] = None
    salesQty: int
    totalSales: float
    refundQty: int = 0
    refundAmount: float = 0.0
    discounts: float = 0.0
    netSales: float
    unitCost: float
    totalRevenue: float

class DailySalesItem(BaseModel):
    sale_date: str
    total_sales: float
    refund: float
    discount: float
    net_sales: float
    # SUM(order_items.LINE_COST) — no recipe/ingredients
    product_cost: float
    gross_profit: float


class DailyPerBranchItem(BaseModel):
    """One branch × calendar day row for Sales Analytics weekday / detail views."""
    branch_id: int
    branch_name: str
    sale_date: str
    day_name: str
    total_sales: float
    refund: float
    discount: float
    net_sales: float
    order_count: int


class DailyOrdersItem(BaseModel):
    sale_date: str
    order_count: int


class DailyExpenseItem(BaseModel):
    expense_date: str
    total_expense: float


class ExpenseSummary(BaseModel):
    total_expense: float


class ExpenseCategoryRow(BaseModel):
    branch_id: int
    exp_cat: str
    exp_name: str
    entry_count: int
    total_amount: float


class PerformanceTrendRow(BaseModel):
    name: str
    totalSales: float
    totalExpenses: float
    # Set for weekly=true calendar mode (yyyy-mm-dd) so the chart matches daily-sales per day.
    sale_date: Optional[str] = None


def _safe_parse_yyyy_mm_dd(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:
        return None


def _default_range_for_period(period: str) -> tuple[str, str]:
    # Use PH-local "today" approximation (server-local date). For consistent bucketing,
    # the sales query uses +08:00 conversion on billing timestamps.
    today = datetime.now().date()

    if period == "weekly":
        # Current week Monday..Sunday
        start = today - timedelta(days=today.weekday())
        end = start + timedelta(days=6)
    elif period == "monthly":
        # Current month 1..last day
        start = today.replace(day=1)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        end = next_month - timedelta(days=1)
    else:
        # Yearly: rolling last 12 months including current month
        start = (today.replace(day=1) - timedelta(days=365)).replace(day=1)
        end = today

    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


# DASHBOARD
@app.get("/api/analytics/branch-sales")
def branch_sales(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Gross sales per branch: AMOUNT_PAID + DISCOUNT_AMOUNT.
    Matches daily-sales total_sales summed over the same date range.
    Also returns net_sales (= paid - refund) so admin dashboard can avoid N× daily-sales calls.
    """
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        # Same PH (+08:00) calendar day as daily-sales / least-selling so charts and branch table agree.
        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""

        date_filter_billing = ""
        branch_filter_billing = ""
        billing_params: List[object] = []

        if start_date and end_date:
            date_filter_billing, range_params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )
            billing_params.extend(range_params)

        if branch_id:
            branch_filter_billing = "AND br.IDNo = %s"
            billing_params.append(branch_id)
        else:
            branch_filter_billing = f"AND br.IDNo NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        # amount_paid + refund let us derive daily-sales-equivalent net in one query:
        # net_sales = paid + discount - discount - refund = paid - refund
        billing_query = f"""
            SELECT 
                br.IDNo as branch_id,
                br.BRANCH_NAME as branch_name,
                br.BRANCH_CODE as branch_code,
                COALESCE(SUM(CASE WHEN o.IDNo IS NOT NULL THEN b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0) ELSE 0 END), 0) as total_sales,
                COALESCE(SUM(CASE WHEN o.IDNo IS NOT NULL THEN b.AMOUNT_PAID ELSE 0 END), 0) as amount_paid,
                COALESCE(SUM(CASE WHEN o.IDNo IS NOT NULL THEN COALESCE(b.REFUND, 0) ELSE 0 END), 0) as refund_total,
                COUNT(DISTINCT CASE WHEN o.IDNo IS NOT NULL THEN b.ORDER_ID END) as order_count,
                CASE 
                    WHEN COUNT(DISTINCT CASE WHEN o.IDNo IS NOT NULL THEN b.ORDER_ID END) > 0
                        THEN COALESCE(SUM(CASE WHEN o.IDNo IS NOT NULL THEN b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0) ELSE 0 END), 0)
                             / COUNT(DISTINCT CASE WHEN o.IDNo IS NOT NULL THEN b.ORDER_ID END)
                    ELSE 0
                END as avg_order_value
            FROM branches br
            LEFT JOIN billing b ON b.BRANCH_ID = br.IDNo AND {_BILLING_WHERE} {date_filter_billing}
            LEFT JOIN orders o ON {_ORDERS_ON_BILLING}
            WHERE br.ACTIVE = 1 {branch_filter_billing}
            GROUP BY br.IDNo, br.BRANCH_NAME, br.BRANCH_CODE
            ORDER BY total_sales DESC
        """

        cur.execute(billing_query, billing_params)  # pyright: ignore[reportArgumentType]
        billing_rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] branch-sales DB query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch sales per branch",
            "error": getattr(exc, "message", str(exc)),
        }

    result: List[BranchSalesItem] = []
    for row in billing_rows:
        bid = int(row["branch_id"])
        total_sales = float(row.get("total_sales") or 0)
        amount_paid = float(row.get("amount_paid") or 0)
        refund_total = float(row.get("refund_total") or 0)
        order_count = int(row.get("order_count") or 0)
        avg_order_value = float(row.get("avg_order_value") or 0)
        net_sales = max(0.0, amount_paid - refund_total)

        result.append(
            BranchSalesItem(
                branch_id=bid,
                branch_name=str(row.get("branch_name") or ""),
                branch_code=str(row.get("branch_code") or ""),
                total_sales=total_sales,
                order_count=order_count,
                avg_order_value=avg_order_value,
                net_sales=net_sales,
            )
        )

    # Sort by total_sales DESC, same as Node
    result.sort(key=lambda x: x.total_sales, reverse=True)

    return {"success": True, "data": {"data": [item.model_dump() for item in result]}}


@app.get("/api/analytics/least-selling")
def least_selling(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
    limit: int = 5,
) -> dict:
    """
    Least-selling menu items.
    Mirrors Node's ReportsModel.getLeastSellingItems:
    - Merges product_sales_summary and actual orders/billing/order_items/menu/categories
    - Applies optional date and branch filters on actual orders
    """
    try:
        effective_limit = max(1, min(int(limit or 5), 50))

        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        # Legacy table product_sales_summary has been removed; rely only on actual orders.
        summary_rows: List[dict] = []

        # Source 2: actual orders (paid billings) — same sale-day + status rules as daily-sales
        # so dashboard "income" drill-down matches the chart (PH local billing date, STATUS 1/2).
        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""
        order_date_filter = ""
        order_branch_filter = ""
        order_params: List[object] = []

        if start_date and end_date:
            order_date_filter, range_params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )
            order_params.extend(range_params)
        if branch_id:
            order_branch_filter = "AND b.BRANCH_ID = %s"
            order_params.append(branch_id)
        else:
            order_branch_filter = f"AND b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        orders_query = f"""
            SELECT
                m.MENU_NAME as name,
                COALESCE(c.CAT_NAME, 'Uncategorized') as category,
                COALESCE(SUM(oi.QTY), 0) as total_quantity,
                COALESCE(SUM(oi.LINE_TOTAL), 0) as total_revenue,
                m.MENU_PRICE
            FROM orders o
            INNER JOIN billing b ON b.ORDER_ID = o.IDNo
            INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
            INNER JOIN menu m ON m.IDNo = oi.MENU_ID
            LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
            WHERE b.STATUS IN (1, 2)
            {order_date_filter}
            {order_branch_filter}
            GROUP BY m.IDNo, m.MENU_NAME, m.MENU_PRICE, c.CAT_NAME
            HAVING total_quantity > 0
            ORDER BY total_quantity ASC, total_revenue ASC
            LIMIT %s
        """
        order_params.append(effective_limit)

        cur.execute(orders_query, order_params)
        order_rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] least-selling query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch least selling items",
            "error": getattr(exc, "message", str(exc)),
        }

    # Merge both sources by product name
    data_map = {}

    for row in summary_rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        if name not in data_map:
            data_map[name] = {
                "name": name,
                "category": row.get("category") or "Uncategorized",
                "total_quantity": 0,
                "total_revenue": 0.0,
                "price": 0.0,
            }
        data = data_map[name]
        data["total_quantity"] += int(row.get("total_quantity") or 0)
        data["total_revenue"] += float(row.get("total_revenue") or 0.0)

    for row in order_rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        if name not in data_map:
            data_map[name] = {
                "name": name,
                "category": row.get("category") or "Uncategorized",
                "total_quantity": 0,
                "total_revenue": 0.0,
                "price": float(row.get("MENU_PRICE") or 0.0),
            }
        data = data_map[name]
        data["total_quantity"] += int(row.get("total_quantity") or 0)
        data["total_revenue"] += float(row.get("total_revenue") or 0.0)
        if row.get("MENU_PRICE") is not None:
            data["price"] = float(row.get("MENU_PRICE") or data["price"])

    # Convert to list, filter, sort by least total revenue (then quantity), then limit
    merged_items: List[LeastSellingItem] = []
    for idx, item in enumerate(
        sorted(
            (
                v
                for v in data_map.values()
                if (v.get("total_quantity") or 0) > 0 and (v.get("total_revenue") or 0.0) > 0.0
            ),
            key=lambda x: (x["total_revenue"], x["total_quantity"]),
        )[:effective_limit],
        start=1,
    ):
        merged_items.append(
            LeastSellingItem(
                IDNo=idx,
                MENU_NAME=item["name"],
                MENU_PRICE=float(item.get("price") or 0.0),
                category=str(item.get("category") or "Uncategorized"),
                total_quantity=int(item.get("total_quantity") or 0),
                order_count=int(item.get("total_quantity") or 0),
                total_revenue=float(item.get("total_revenue") or 0.0),
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in merged_items]}}


@app.get("/api/analytics/top-selling")
def top_selling(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
    limit: int = 5,
) -> dict:
    """
    Top-selling menu items.
    Mirrors least_selling aggregation but sorts by highest quantity instead of lowest.
    """
    try:
        effective_limit = max(1, min(int(limit or 5), 50))

        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        # Legacy table product_sales_summary has been removed; rely only on actual orders.
        summary_rows: List[dict] = []

        # Same sale-day + paid rules as daily-sales (chart income) — see least_selling / daily_sales.
        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""
        _ = billing_local_dt  # display/day bucketing elsewhere; filter is sargable on raw column
        order_date_filter = ""
        order_branch_filter = ""
        order_params: List[object] = []

        if start_date and end_date:
            order_date_filter, range_params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )
            order_params.extend(range_params)
        if branch_id:
            order_branch_filter = "AND b.BRANCH_ID = %s"
            order_params.append(branch_id)
        else:
            order_branch_filter = f"AND b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        orders_query = f"""
            SELECT 
                m.MENU_NAME as name,
                COALESCE(c.CAT_NAME, 'Uncategorized') as category,
                COALESCE(SUM(oi.QTY), 0) as total_quantity,
                COALESCE(SUM(oi.LINE_TOTAL), 0) as total_revenue,
                m.MENU_PRICE
            FROM billing b
            INNER JOIN orders o ON {_ORDERS_ON_BILLING}
            INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
            INNER JOIN menu m ON m.IDNo = oi.MENU_ID
            LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
            WHERE {_BILLING_WHERE}
            {order_date_filter}
            {order_branch_filter}
            GROUP BY m.IDNo, m.MENU_NAME, m.MENU_PRICE, c.CAT_NAME
            HAVING total_quantity > 0
            ORDER BY total_quantity DESC, total_revenue DESC
            LIMIT %s
        """
        order_params.append(effective_limit)

        cur.execute(orders_query, order_params)
        order_rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] top-selling query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch top selling items",
            "error": getattr(exc, "message", str(exc)),
        }

    # Merge both sources by product name
    data_map = {}

    for row in summary_rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        if name not in data_map:
            data_map[name] = {
                "name": name,
                "category": row.get("category") or "Uncategorized",
                "total_quantity": 0,
                "total_revenue": 0.0,
                "price": 0.0,
            }
        data = data_map[name]
        data["total_quantity"] += int(row.get("total_quantity") or 0)
        data["total_revenue"] += float(row.get("total_revenue") or 0.0)

    for row in order_rows:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        if name not in data_map:
            data_map[name] = {
                "name": name,
                "category": row.get("category") or "Uncategorized",
                "total_quantity": 0,
                "total_revenue": 0.0,
                "price": float(row.get("MENU_PRICE") or 0.0),
            }
        data = data_map[name]
        data["total_quantity"] += int(row.get("total_quantity") or 0)
        data["total_revenue"] += float(row.get("total_revenue") or 0.0)
        if row.get("MENU_PRICE") is not None:
            data["price"] = float(row.get("MENU_PRICE") or data["price"])

    # Convert to list, filter, sort by highest revenue (then quantity), then limit
    merged_items: List[TopSellingItem] = []
    for idx, item in enumerate(
        sorted(
            (
                v
                for v in data_map.values()
                if (v.get("total_quantity") or 0) > 0 and (v.get("total_revenue") or 0.0) > 0.0
            ),
            key=lambda x: (-x["total_revenue"], -x["total_quantity"]),
        )[:effective_limit],
        start=1,
    ):
        merged_items.append(
            TopSellingItem(
                IDNo=idx,
                MENU_NAME=item["name"],
                MENU_PRICE=float(item.get("price") or 0.0),
                category=str(item.get("category") or "Uncategorized"),
                total_quantity=int(item.get("total_quantity") or 0),
                order_count=int(item.get("total_quantity") or 0),
                total_revenue=float(item.get("total_revenue") or 0.0),
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in merged_items]}}


def _daily_sales_billing_local_dt() -> str:
    return """COALESCE(
        CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
        DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
    )"""


def _sale_day_sql(branch_col: str = "b.BRANCH_ID") -> str:
    """Business-day DATE of a billing row (a cutoff branch's overnight shift stays on one date).

    Must be used for both SELECT and GROUP BY, and matches the branch-aware range
    filter below so a row is never filtered into one day and grouped under another.
    """
    return business_date_sql(_daily_sales_billing_local_dt(), branch_col)


def _daily_sales_refund_local_dt() -> str:
    refund_source_dt = "COALESCE(b.REFUND_DT, b.ENCODED_DT)"
    return f"""COALESCE(
        CONVERT_TZ({refund_source_dt}, @@session.time_zone, '+08:00'),
        DATE_ADD({refund_source_dt}, INTERVAL 8 HOUR)
    )"""


def _daily_sales_date_branch_filters(
    billing_local_dt: str,
    start_date: Optional[str],
    end_date: Optional[str],
    branch_id: Optional[int],
    *,
    branch_col: str = "b.BRANCH_ID",
    encoded_dt_col: str = "b.ENCODED_DT",
) -> Tuple[str, str, List[object]]:
    # billing_local_dt kept for GROUP BY / SELECT display; filter uses sargable raw column.
    _ = billing_local_dt
    date_filter = ""
    branch_filter = ""
    params: List[object] = []
    if start_date and end_date:
        date_filter, range_params = ph_local_day_range_filter(encoded_dt_col, start_date, end_date, branch_col)
        params.extend(range_params)
    if branch_id:
        branch_filter = f"AND {branch_col} = %s"
        params.append(branch_id)
    else:
        branch_filter = f"AND {branch_col} NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"
    return date_filter, branch_filter, params


def _daily_sales_fetch_billing(
    start_date: Optional[str],
    end_date: Optional[str],
    branch_id: Optional[int],
) -> List[Dict[str, Any]]:
    billing_local_dt = _daily_sales_billing_local_dt()
    sale_day = _sale_day_sql()
    date_filter, branch_filter, params = _daily_sales_date_branch_filters(
        billing_local_dt, start_date, end_date, branch_id
    )
    query = f"""
        SELECT
            DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
            COALESCE(SUM(b.AMOUNT_PAID), 0) AS total_sales
        FROM billing b
        INNER JOIN orders o ON {_ORDERS_ON_BILLING}
        WHERE {_BILLING_WHERE}
        {date_filter}
        {branch_filter}
        GROUP BY {sale_day}
    """
    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(query, params)
        return cast(List[Dict[str, Any]], cur.fetchall() or [])
    finally:
        cur.close()
        conn.close()


def _daily_sales_fetch_discount(
    start_date: Optional[str],
    end_date: Optional[str],
    branch_id: Optional[int],
) -> List[Dict[str, Any]]:
    billing_local_dt = _daily_sales_billing_local_dt()
    sale_day = _sale_day_sql("o.BRANCH_ID")
    date_filter, branch_filter, params = _daily_sales_date_branch_filters(
        billing_local_dt, start_date, end_date, branch_id, branch_col="o.BRANCH_ID"
    )
    query = f"""
        SELECT
            DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
            COALESCE(SUM(o.DISCOUNT_AMOUNT), 0) AS discount
        FROM orders o
        INNER JOIN billing b ON {_BILLING_JOIN}
        WHERE 1=1
        {date_filter}
        {branch_filter}
        GROUP BY {sale_day}
    """
    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(query, params)
        return cast(List[Dict[str, Any]], cur.fetchall() or [])
    finally:
        cur.close()
        conn.close()


def _daily_sales_fetch_refund(
    start_date: Optional[str],
    end_date: Optional[str],
    branch_id: Optional[int],
) -> List[Dict[str, Any]]:
    refund_local_dt = _daily_sales_refund_local_dt()
    refund_date_filter = ""
    refund_branch_filter = ""
    refund_params: List[object] = []
    if start_date and end_date:
        # {refund_day} is the business-day DATE of the refund (see _sale_day_sql), filled in per query below.
        refund_date_filter = "AND {refund_day} BETWEEN %s AND %s"
        refund_params.extend([start_date, end_date])
    if branch_id:
        refund_branch_filter = "AND {refund_branch_col} = %s"
        refund_params.append(branch_id)
    else:
        refund_branch_filter = f"AND {{refund_branch_col}} NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

    refund_day = business_date_sql(refund_local_dt, "b.BRANCH_ID")
    refund_date_filter_sql = refund_date_filter.format(refund_day=refund_day) if refund_date_filter else ""
    refund_branch_filter_sql = refund_branch_filter.format(refund_branch_col="b.BRANCH_ID") if refund_branch_filter else ""
    query = f"""
        SELECT
            DATE_FORMAT({refund_day}, '%Y-%m-%d') AS sale_date,
            COALESCE(SUM(b.REFUND), 0) AS refund
        FROM billing b
        INNER JOIN orders o ON {_ORDERS_ON_BILLING}
        WHERE b.REFUND IS NOT NULL AND b.REFUND > 0
          AND {_BILLING_WHERE}
        {refund_date_filter_sql}
        {refund_branch_filter_sql}
        GROUP BY {refund_day}
    """

    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(query, refund_params)
        return cast(List[Dict[str, Any]], cur.fetchall() or [])
    finally:
        cur.close()
        conn.close()


def _daily_sales_fetch_cogs(
    start_date: Optional[str],
    end_date: Optional[str],
    branch_id: Optional[int],
    *,
    has_line_cost: bool,
) -> List[Dict[str, Any]]:
    billing_local_dt = _daily_sales_billing_local_dt()
    sale_day = _sale_day_sql()
    line_cogs_expr = "COALESCE(oi.LINE_COST, 0)" if has_line_cost else "0"
    date_filter, branch_filter, params = _daily_sales_date_branch_filters(
        billing_local_dt, start_date, end_date, branch_id
    )
    query = f"""
        SELECT
            DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
            COALESCE(SUM({line_cogs_expr}), 0) AS product_cost
        FROM billing b
        INNER JOIN orders o ON {_ORDERS_ON_BILLING}
        INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
        WHERE {_BILLING_WHERE}
        {date_filter}
        {branch_filter}
        GROUP BY {sale_day}
    """
    conn = get_connection()
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(query, params)
        return cast(List[Dict[str, Any]], cur.fetchall() or [])
    except Exception as cogs_exc:
        print("[PyServer] daily-sales COGS query skipped:", getattr(cogs_exc, "message", str(cogs_exc)))
        return []
    finally:
        cur.close()
        conn.close()


@app.get("/api/analytics/top-profit-drivers")
def top_profit_drivers(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
    limit: int = 20,
) -> dict:
    """
    Fast profit drivers for Sales Analytics dashboard.
    Menu items per branch plus synthetic Room Charge / Service Charge (matches menu-report logic).
    """
    try:
        from reports import _norm_text_sql

        effective_limit = max(1, min(int(limit or 20), 50))
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        billing_local_dt = _daily_sales_billing_local_dt()
        date_filter = ""
        branch_filter = ""
        params: List[object] = []
        if start_date and end_date:
            date_filter, range_params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )
            params.extend(range_params)
        if branch_id:
            branch_filter = "AND b.BRANCH_ID = %s"
            params.append(branch_id)
        else:
            branch_filter = f"AND b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        has_line_cost = _mysql_column_exists(cur, "order_items", "LINE_COST")
        line_cogs_expr = "COALESCE(oi.LINE_COST, 0)" if has_line_cost else "0"

        menu_query = f"""
            SELECT
                m.IDNo AS id,
                COALESCE(m.MENU_NAME, '') AS goods,
                COALESCE(c.CAT_NAME, 'Uncategorized') AS category,
                COALESCE(br.BRANCH_NAME, 'Unknown Branch') AS branch,
                b.BRANCH_ID AS branch_id,
                COALESCE(SUM(oi.QTY), 0) AS salesQty,
                COALESCE(SUM(oi.LINE_TOTAL), 0) AS totalSales,
                COALESCE(SUM({line_cogs_expr}), 0) AS unitCost
            FROM orders o
            INNER JOIN billing b ON {_BILLING_JOIN}
            INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
            INNER JOIN menu m ON m.IDNo = oi.MENU_ID
            LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
            LEFT JOIN branches br ON br.IDNo = b.BRANCH_ID
            WHERE 1=1
            {date_filter}
            {branch_filter}
              AND {_norm_text_sql('m.MENU_NAME')} <> 'ROOM CHARGE'
              AND {_norm_text_sql('c.CAT_NAME')} <> 'ROOM CHARGE'
            GROUP BY m.IDNo, m.MENU_NAME, c.CAT_NAME, b.BRANCH_ID, br.BRANCH_NAME
            HAVING COALESCE(SUM(oi.LINE_TOTAL), 0) > 0
        """

        room_charge_query = f"""
            SELECT
                -9998 AS id,
                'Room Charge' AS goods,
                'Charges' AS category,
                COALESCE(MAX(br.BRANCH_NAME), 'Unknown Branch') AS branch,
                rc.branch_id AS branch_id,
                SUM(rc.sales_qty) AS salesQty,
                SUM(rc.total_sales) AS totalSales,
                0 AS unitCost
            FROM (
                SELECT
                    b.BRANCH_ID AS branch_id,
                    COUNT(DISTINCT o.IDNo) AS sales_qty,
                    COALESCE(SUM(o.SERVICE_CHARGE), 0) AS total_sales
                FROM orders o
                INNER JOIN billing b ON {_BILLING_JOIN}
                LEFT JOIN restaurant_tables rt ON rt.IDNo = o.TABLE_ID
                WHERE COALESCE(o.SERVICE_CHARGE, 0) > 0
                  AND COALESCE(rt.ROOM_CHARGE, 0) > 0
                {date_filter}
                {branch_filter}
                GROUP BY b.BRANCH_ID

                UNION ALL

                SELECT
                    b.BRANCH_ID AS branch_id,
                    COALESCE(SUM(oi.QTY), 0) AS sales_qty,
                    COALESCE(SUM(oi.LINE_TOTAL), 0) AS total_sales
                FROM orders o
                INNER JOIN billing b ON {_BILLING_JOIN}
                INNER JOIN order_items oi ON oi.ORDER_ID = o.IDNo
                INNER JOIN menu m ON m.IDNo = oi.MENU_ID
                LEFT JOIN categories c ON c.IDNo = m.CATEGORY_ID
                WHERE {_norm_text_sql('c.CAT_NAME')} = 'ROOM CHARGE'
                  AND {_norm_text_sql('m.MENU_NAME')} <> 'ROOM CHARGE'
                {date_filter}
                {branch_filter}
                GROUP BY b.BRANCH_ID
            ) rc
            LEFT JOIN branches br ON br.IDNo = rc.branch_id
            GROUP BY rc.branch_id
            HAVING SUM(rc.total_sales) > 0
        """

        # Same split as menu-report: order header SERVICE_CHARGE on tables without ROOM_CHARGE.
        service_charge_query = f"""
            SELECT
                -9999 AS id,
                'Service Charge' AS goods,
                'Charges' AS category,
                COALESCE(MAX(br.BRANCH_NAME), 'Unknown Branch') AS branch,
                b.BRANCH_ID AS branch_id,
                COUNT(DISTINCT o.IDNo) AS salesQty,
                COALESCE(SUM(o.SERVICE_CHARGE), 0) AS totalSales,
                0 AS unitCost
            FROM orders o
            INNER JOIN billing b ON {_BILLING_JOIN}
            LEFT JOIN restaurant_tables rt ON rt.IDNo = o.TABLE_ID
            LEFT JOIN branches br ON br.IDNo = b.BRANCH_ID
            WHERE COALESCE(o.SERVICE_CHARGE, 0) > 0
              AND COALESCE(rt.ROOM_CHARGE, 0) = 0
            {date_filter}
            {branch_filter}
            GROUP BY b.BRANCH_ID
            HAVING COALESCE(SUM(o.SERVICE_CHARGE), 0) > 0
        """

        query = f"""
            SELECT id, goods, category, branch, branch_id, salesQty, totalSales, unitCost
            FROM (
                {menu_query}
                UNION ALL
                {room_charge_query}
                UNION ALL
                {service_charge_query}
            ) combined
            ORDER BY (totalSales - unitCost) DESC, salesQty DESC
            LIMIT {effective_limit}
        """
        # Params: menu + room (header) + room (category items) + service charge
        exec_params = params + params + params + params
        cur.execute(query, exec_params)
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] top-profit-drivers query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch top profit drivers",
            "error": getattr(exc, "message", str(exc)),
        }

    items: List[ProfitDriverRow] = []
    for row in rows:
        total_sales = float(row.get("totalSales") or 0.0)
        unit_cost = float(row.get("unitCost") or 0.0)
        net_sales = total_sales
        profit = max(0.0, net_sales - unit_cost)
        if profit <= 0:
            continue
        branch_id_val = row.get("branch_id")
        items.append(
            ProfitDriverRow(
                id=int(row.get("id") or 0),
                goods=str(row.get("goods") or ""),
                category=str(row.get("category") or "Uncategorized"),
                branch=str(row.get("branch") or "Unknown Branch"),
                branch_id=int(branch_id_val) if branch_id_val is not None else None,
                salesQty=int(row.get("salesQty") or 0),
                totalSales=total_sales,
                netSales=net_sales,
                unitCost=unit_cost,
                totalRevenue=profit,
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in items]}}


@app.get("/api/analytics/daily-sales")
def daily_sales(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
    lightweight: bool = False,
) -> dict:
    """
    Daily gross sales time series:
    - total_sales: AMOUNT_PAID + DISCOUNT_AMOUNT (gross, before refund)
    - refund: SUM of billing.REFUND
    - discount: SUM of orders.DISCOUNT_AMOUNT for paid orders
    - net_sales: total_sales - discount - refund
    - product_cost: SUM(order_items.LINE_COST) (no ingredient/recipe)
    - gross_profit: net_sales - product_cost

    ``lightweight=true`` (dashboard charts): one SQL for paid+discount+billing.REFUND, skip COGS.
    """
    try:
        if lightweight:
            billing_local_dt = _daily_sales_billing_local_dt()
            sale_day = _sale_day_sql()
            date_filter, branch_filter, params = _daily_sales_date_branch_filters(
                billing_local_dt, start_date, end_date, branch_id
            )
            query = f"""
                SELECT
                    DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
                    COALESCE(SUM(b.AMOUNT_PAID), 0) AS paid_total,
                    COALESCE(SUM(COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) AS discount,
                    COALESCE(SUM(COALESCE(b.REFUND, 0)), 0) AS refund
                FROM billing b
                INNER JOIN orders o ON {_ORDERS_ON_BILLING}
                WHERE {_BILLING_WHERE}
                {date_filter}
                {branch_filter}
                GROUP BY {sale_day}
                ORDER BY sale_date
            """
            conn = get_connection()
            cur = conn.cursor(dictionary=True)
            try:
                cur.execute(query, params)
                rows = cast(List[Dict[str, Any]], cur.fetchall() or [])
            finally:
                cur.close()
                conn.close()

            items: List[DailySalesItem] = []
            for row in rows:
                sale_date = row.get("sale_date")
                if sale_date is None:
                    continue
                paid_total = float(row.get("paid_total") or 0.0)
                discount = float(row.get("discount") or 0.0)
                refund = float(row.get("refund") or 0.0)
                total_sales = paid_total + discount
                net_sales = total_sales - discount - refund
                items.append(
                    DailySalesItem(
                        sale_date=str(sale_date),
                        total_sales=total_sales,
                        refund=refund,
                        discount=discount,
                        net_sales=net_sales,
                        product_cost=0.0,
                        gross_profit=max(0.0, net_sales),
                    )
                )
            return {"success": True, "data": {"data": [item.model_dump() for item in items]}}

        meta_conn = get_connection()
        meta_cur = meta_conn.cursor(dictionary=True)
        has_line_cost = _mysql_column_exists(meta_cur, "order_items", "LINE_COST")
        meta_cur.close()
        meta_conn.close()

        with ThreadPoolExecutor(max_workers=4) as pool:
            billing_future = pool.submit(_daily_sales_fetch_billing, start_date, end_date, branch_id)
            discount_future = pool.submit(_daily_sales_fetch_discount, start_date, end_date, branch_id)
            refund_future = pool.submit(
                _daily_sales_fetch_refund,
                start_date,
                end_date,
                branch_id,
            )
            cogs_future = pool.submit(
                _daily_sales_fetch_cogs,
                start_date,
                end_date,
                branch_id,
                has_line_cost=has_line_cost,
            )
            billing_rows = billing_future.result()
            discount_rows = discount_future.result()
            refund_rows = refund_future.result()
            cogs_rows = cogs_future.result()
    except Exception as exc:
        print("[PyServer] daily-sales query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch daily sales",
            "error": getattr(exc, "message", str(exc)),
        }

    # Index discount and refund by sale_date
    discount_map = {}
    for row in discount_rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        discount_map[str(sale_date)] = float(row.get("discount") or 0.0)

    refund_map = {}
    for row in refund_rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        refund_map[str(sale_date)] = float(row.get("refund") or 0.0)

    cogs_map: Dict[str, float] = {}
    for row in cogs_rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        key = str(sale_date)
        cogs_map[key] = float(row.get("product_cost") or 0.0)

    # Merge into final daily series
    items = []
    billing_map = {}
    for row in billing_rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        billing_map[str(sale_date)] = float(row.get("total_sales") or 0.0)

    all_dates = (
        set(billing_map.keys())
        | set(discount_map.keys())
        | set(refund_map.keys())
        | set(cogs_map.keys())
    )
    for key in sorted(all_dates):
        discount = float(discount_map.get(key, 0.0) or 0.0)
        refund = float(refund_map.get(key, 0.0) or 0.0)
        paid_total = float(billing_map.get(key, 0.0) or 0.0)
        product_cost = float(cogs_map.get(key, 0.0) or 0.0)

        # Daily figures:
        # total_sales (gross) = paid_total + discount
        # net_sales = total_sales - discount - refund
        total_sales = paid_total + discount
        net_sales = total_sales - discount - refund
        gross_profit = max(0.0, net_sales - product_cost)

        items.append(
            DailySalesItem(
                sale_date=key,
                total_sales=total_sales,
                refund=refund,
                discount=discount,
                net_sales=net_sales,
                product_cost=product_cost,
                gross_profit=gross_profit,
            )
        )

    # Sort by date
    items.sort(key=lambda x: x.sale_date)
    return {"success": True, "data": {"data": [item.model_dump() for item in items]}}


@app.get("/api/analytics/daily-per-branch")
def daily_per_branch(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Daily sales broken out by branch (day × branch matrix).
    Same PH(+08:00) day + paid-status rules as daily-sales.
    Used by Sales Analytics Week view and all-branches daily detail table.
    """
    try:
        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""

        sale_day = _sale_day_sql()
        date_filter = ""
        params: List[object] = []
        if start_date and end_date:
            date_filter, params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )

        branch_filter = ""
        if branch_id:
            branch_filter = "AND br.IDNo = %s"
            params.append(branch_id)
        else:
            branch_filter = f"AND br.IDNo NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        query = f"""
            SELECT
                br.IDNo AS branch_id,
                br.BRANCH_NAME AS branch_name,
                DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
                DAYNAME({sale_day}) AS day_name,
                COALESCE(SUM(b.AMOUNT_PAID + COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) AS total_sales,
                COALESCE(SUM(COALESCE(b.REFUND, 0)), 0) AS refund,
                COALESCE(SUM(COALESCE(o.DISCOUNT_AMOUNT, 0)), 0) AS discount,
                COALESCE(SUM(b.AMOUNT_PAID - COALESCE(b.REFUND, 0)), 0) AS net_sales,
                COUNT(DISTINCT b.ORDER_ID) AS order_count
            FROM branches br
            INNER JOIN billing b ON b.BRANCH_ID = br.IDNo AND {_BILLING_WHERE} {date_filter}
            INNER JOIN orders o ON {_ORDERS_ON_BILLING}
            WHERE br.ACTIVE = 1 {branch_filter}
            GROUP BY br.IDNo, br.BRANCH_NAME, {sale_day}
            HAVING sale_date IS NOT NULL
            ORDER BY br.BRANCH_NAME, sale_date
        """

        conn = get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(query, params)
            rows = cast(List[Dict[str, Any]], cur.fetchall() or [])
        finally:
            cur.close()
            conn.close()
    except Exception as exc:
        print("[PyServer] daily-per-branch query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch daily sales per branch",
            "error": getattr(exc, "message", str(exc)),
        }

    items: List[DailyPerBranchItem] = []
    for row in rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        items.append(
            DailyPerBranchItem(
                branch_id=int(row["branch_id"]),
                branch_name=str(row.get("branch_name") or ""),
                sale_date=str(sale_date),
                day_name=str(row.get("day_name") or ""),
                total_sales=float(row.get("total_sales") or 0.0),
                refund=float(row.get("refund") or 0.0),
                discount=float(row.get("discount") or 0.0),
                net_sales=float(row.get("net_sales") or 0.0),
                order_count=int(row.get("order_count") or 0),
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in items]}}


@app.get("/api/analytics/daily-orders")
def daily_orders(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Daily order count time series based on billing data, aligned with daily-sales:
    - Counts DISTINCT billing.ORDER_ID per local PH day
    - Filters by branch and date when provided
    """
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""

        date_filter = ""
        branch_filter = ""
        params: List[object] = []

        if start_date and end_date:
            date_filter, range_params = ph_local_day_range_filter(
                "b.ENCODED_DT", start_date, end_date, "b.BRANCH_ID"
            )
            params.extend(range_params)
        if branch_id:
            branch_filter = "AND b.BRANCH_ID = %s"
            params.append(branch_id)
        else:
            branch_filter = f"AND b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})"

        sale_day = _sale_day_sql()
        query = f"""
            SELECT
                DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
                COUNT(DISTINCT b.ORDER_ID) AS order_count
            FROM billing b
            WHERE b.STATUS IN (1, 2)
            {date_filter}
            {branch_filter}
            GROUP BY {sale_day}
        """

        cur.execute(query, params)
        rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] daily-orders query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch daily orders",
            "error": getattr(exc, "message", str(exc)),
        }

    items: List[DailyOrdersItem] = []
    for row in rows:
        sale_date = row.get("sale_date")
        if sale_date is None:
            continue
        items.append(
            DailyOrdersItem(
                sale_date=str(sale_date),
                order_count=int(row.get("order_count") or 0),
            )
        )

    items.sort(key=lambda x: x.sale_date)

    return {"success": True, "data": {"data": [item.model_dump() for item in items]}}


@app.get("/api/analytics/expense-summary")
def expense_summary(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Total expenses over a period, optionally filtered by branch.

    Mirrors Node's ExpenseModel.getSummary (total_expense) semantics:
    - Reads from expenses + master_categories
    - Respects ACTIVE flag
    - Optional branch/date filters
    - Date filters use Asia/Manila (+08:00) calendar day, same as daily-sales.
    """
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        where = ["e.ACTIVE = 1", "oc.ACTIVE = 1"]
        params: List[object] = []

        if branch_id:
            where.append("e.BRANCH_ID = %s")
            params.append(branch_id)
        else:
            where.append(f"e.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")

        if start_date and end_date:
            where.append(ph_local_day_range_predicate("e.ENCODED_DT"))
            params.extend(ph_local_day_range_params(start_date, end_date))
        elif start_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) >= %s")
            params.append(start_date)
        elif end_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) <= %s")
            params.append(end_date)

        where_sql = " AND ".join(where)

        query = f"""
            SELECT
                COALESCE(SUM(e.EXP_AMOUNT), 0) AS total_expense
            FROM expenses e
            LEFT JOIN master_categories mc ON mc.ACTIVE = 1 AND mc.IDNo = e.MASTER_CAT_ID
            INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
            WHERE {where_sql}
        """

        cur.execute(query, params)
        row = cur.fetchone() or {}
        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] expense-summary query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch expense summary",
            "error": getattr(exc, "message", str(exc)),
        }

    summary = ExpenseSummary(total_expense=float(row.get("total_expense") or 0.0))
    return {"success": True, "data": summary.model_dump()}


@app.get("/api/analytics/daily-expenses")
def daily_expenses(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Daily expenses time series based on expenses table.
    Mirrors expense-summary filters; groups by PH (+08:00) calendar day (aligned with daily-sales).
    """
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        where = ["e.ACTIVE = 1", "oc.ACTIVE = 1"]
        params: List[object] = []

        if branch_id:
            where.append("e.BRANCH_ID = %s")
            params.append(branch_id)
        else:
            where.append(f"e.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")

        if start_date and end_date:
            where.append(ph_local_day_range_predicate("e.ENCODED_DT"))
            params.extend(ph_local_day_range_params(start_date, end_date))
        elif start_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) >= %s")
            params.append(start_date)
        elif end_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) <= %s")
            params.append(end_date)

        where_sql = " AND ".join(where)

        query = f"""
            SELECT
                DATE_FORMAT({_EXPENSE_LOCAL_DT_SQL}, '%Y-%m-%d') AS expense_date,
                COALESCE(SUM(e.EXP_AMOUNT), 0) AS total_expense
            FROM expenses e
            LEFT JOIN master_categories mc ON mc.ACTIVE = 1 AND mc.IDNo = e.MASTER_CAT_ID
            INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
            WHERE {where_sql}
            GROUP BY DATE({_EXPENSE_LOCAL_DT_SQL})
            ORDER BY DATE({_EXPENSE_LOCAL_DT_SQL})
        """

        cur.execute(query, params)
        rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] daily-expenses DB query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch daily expenses",
            "error": getattr(exc, "message", str(exc)),
        }

    items: List[DailyExpenseItem] = []
    for row in rows:
        date_val = row.get("expense_date")
        if date_val is None:
            continue
        items.append(
            DailyExpenseItem(
                expense_date=str(date_val),
                total_expense=float(row.get("total_expense") or 0.0),
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in items]}}


@app.get("/api/analytics/expense-breakdown")
def expense_breakdown(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Expense breakdown grouped by branch + (CATEGORY_TYPE, CATEGORY_NAME).

    This is designed to power the Admin Dashboard comparison side panel.
    It mirrors Node's ExpenseModel.getCategoryBreakdown but also returns branch_id.
    """
    try:
        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        where = ["e.ACTIVE = 1", "oc.ACTIVE = 1"]
        params: List[object] = []

        if branch_id:
            where.append("e.BRANCH_ID = %s")
            params.append(branch_id)
        else:
            where.append(f"e.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")

        if start_date and end_date:
            where.append(ph_local_day_range_predicate("e.ENCODED_DT"))
            params.extend(ph_local_day_range_params(start_date, end_date))
        elif start_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) >= %s")
            params.append(start_date)
        elif end_date:
            where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) <= %s")
            params.append(end_date)

        where_sql = " AND ".join(where)

        query = f"""
            SELECT
                e.BRANCH_ID AS branch_id,
                oc.NAME AS exp_cat,
                mc.CATEGORY_NAME AS exp_name,
                COUNT(*) AS entry_count,
                COALESCE(SUM(e.EXP_AMOUNT), 0) AS total_amount
            FROM expenses e
            LEFT JOIN master_categories mc ON mc.ACTIVE = 1 AND mc.IDNo = e.MASTER_CAT_ID
            INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
            WHERE {where_sql}
            GROUP BY e.BRANCH_ID, oc.NAME, mc.CATEGORY_NAME
            ORDER BY total_amount DESC, oc.NAME ASC, mc.CATEGORY_NAME ASC
        """

        cur.execute(query, params)
        rows = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] expense-breakdown query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch expense breakdown",
            "error": getattr(exc, "message", str(exc)),
        }

    data: List[ExpenseCategoryRow] = []
    for row in rows:
        try:
            bid_raw = row.get("branch_id")
            if bid_raw is None:
                continue
            bid = int(bid_raw)
        except Exception:
            continue
        data.append(
            ExpenseCategoryRow(
                branch_id=bid,
                exp_cat=str(row.get("exp_cat") or ""),
                exp_name=str(row.get("exp_name") or ""),
                entry_count=int(row.get("entry_count") or 0),
                total_amount=float(row.get("total_amount") or 0.0),
            )
        )

    return {"success": True, "data": {"data": [item.model_dump() for item in data]}}


@app.get("/api/analytics/performance-trend")
def performance_trend(
    period: Literal["weekly", "monthly", "yearly"] = "yearly",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    branch_id: Optional[int] = None,
) -> dict:
    """
    Unified performance trend for admin dashboard chart:
    - weekly: up to 7 calendar days ending on end_date (PH billing day), each bar = that day only
      (same basis as daily-sales). If the selected range is shorter than 7 days, returns fewer bars.
    - monthly: 1..31 (bucket by day-of-month, PH billing day)
    - yearly: Jan..Dec (bucket by month, PH billing day). Date args are ignored: always
      the full calendar year of the end date (or start, or current year) so all 12 months show.

    totalSales = paid + discount per daily-sales (discount bucketed by same PH day as billing).
    """
    try:
        effective_start = _safe_parse_yyyy_mm_dd(start_date)
        effective_end = _safe_parse_yyyy_mm_dd(end_date)
        if not effective_start or not effective_end:
            s, e = _default_range_for_period(period)
            effective_start = _safe_parse_yyyy_mm_dd(s)
            effective_end = _safe_parse_yyyy_mm_dd(e)

        # Ensure start <= end
        if effective_start and effective_end and effective_start > effective_end:
            effective_start, effective_end = effective_end, effective_start

        # Narrow Optional[date] for type checker; same runtime fallback as yearly ref below.
        if effective_start is None or effective_end is None:
            today = datetime.now().date()
            effective_start = effective_start or today
            effective_end = effective_end or today

        # Yearly: ignore the day-range from the header — show all months of that year (same as user expectation for "yearly")
        if period == "yearly":
            ref = effective_end or effective_start
            if ref is None:
                ref = datetime.now().date()
            y = ref.year
            effective_start = date(y, 1, 1)
            effective_end = date(y, 12, 31)

        conn = get_connection()
        cur = conn.cursor(dictionary=True)

        billing_local_dt = """COALESCE(
            CONVERT_TZ(b.ENCODED_DT, @@session.time_zone, '+08:00'),
            DATE_ADD(b.ENCODED_DT, INTERVAL 8 HOUR)
        )"""
        # Business-day DATE of a billing row — sales/discount only. Expenses stay on the
        # calendar date: they're keyed in by hand (often date-only, 00:00), so a cutoff would
        # push them onto the previous day.
        sale_day = _sale_day_sql()

        # Weekly: true calendar days (last up-to-7 days in range) — matches Sales Analytics / daily-sales, not weekday rollups.
        if period == "weekly":
            window_end = effective_end
            window_start = max(effective_start, window_end - timedelta(days=6))
            w_start_s = window_start.strftime("%Y-%m-%d")
            w_end_s = window_end.strftime("%Y-%m-%d")

            sales_range_w, sales_range_params_w = ph_local_day_range_condition(
                "b.ENCODED_DT", w_start_s, w_end_s, "b.BRANCH_ID"
            )
            sales_where_w = ["b.STATUS IN (1, 2)", sales_range_w]
            sales_params_w: List[object] = list(sales_range_params_w)
            if branch_id:
                sales_where_w.append("b.BRANCH_ID = %s")
                sales_params_w.append(branch_id)
            else:
                sales_where_w.append(f"b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")
            paid_sql = f"""
                SELECT DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
                       COALESCE(SUM(b.AMOUNT_PAID), 0) AS paid_total
                FROM billing b
                WHERE {" AND ".join(sales_where_w)}
                GROUP BY {sale_day}
            """
            cur.execute(paid_sql, sales_params_w)
            paid_rows = cur.fetchall() or []

            disc_range_w, disc_range_params_w = ph_local_day_range_condition(
                "b.ENCODED_DT", w_start_s, w_end_s, "b.BRANCH_ID"
            )
            disc_where_w = [disc_range_w]
            disc_params_w: List[object] = list(disc_range_params_w)
            if branch_id:
                disc_where_w.append("o.BRANCH_ID = %s")
                disc_params_w.append(branch_id)
            else:
                disc_where_w.append(f"o.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")
            disc_sql = f"""
                SELECT DATE_FORMAT({sale_day}, '%Y-%m-%d') AS sale_date,
                       COALESCE(SUM(o.DISCOUNT_AMOUNT), 0) AS discount_total
                FROM orders o
                INNER JOIN billing b ON b.ORDER_ID = o.IDNo AND b.STATUS IN (1, 2)
                WHERE {" AND ".join(disc_where_w)}
                GROUP BY {sale_day}
            """
            cur.execute(disc_sql, disc_params_w)
            disc_rows_w = cur.fetchall() or []

            exp_where_w = ["e.ACTIVE = 1", "oc.ACTIVE = 1", ph_local_day_range_predicate("e.ENCODED_DT")]
            exp_params_w: List[object] = list(ph_local_day_range_params(w_start_s, w_end_s))
            if branch_id:
                exp_where_w.append("e.BRANCH_ID = %s")
                exp_params_w.append(branch_id)
            else:
                exp_where_w.append(f"e.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")
            exp_sql = f"""
                SELECT DATE_FORMAT(DATE({_EXPENSE_LOCAL_DT_SQL}), '%Y-%m-%d') AS exp_date,
                       COALESCE(SUM(e.EXP_AMOUNT), 0) AS total_expense
                FROM expenses e
                LEFT JOIN master_categories mc ON mc.ACTIVE = 1 AND mc.IDNo = e.MASTER_CAT_ID
                INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
                WHERE {" AND ".join(exp_where_w)}
                GROUP BY DATE({_EXPENSE_LOCAL_DT_SQL})
            """
            cur.execute(exp_sql, exp_params_w)
            exp_rows_w = cur.fetchall() or []

            cur.close()
            conn.close()

            paid_map: Dict[str, float] = {}
            for r in paid_rows:
                k = str(r.get("sale_date") or "")
                if not k:
                    continue
                paid_map[k] = float(r.get("paid_total") or 0.0)
            disc_map_w: Dict[str, float] = {}
            for r in disc_rows_w:
                k = str(r.get("sale_date") or "")
                if not k:
                    continue
                disc_map_w[k] = float(r.get("discount_total") or 0.0)
            exp_map_w: Dict[str, float] = {}
            for r in exp_rows_w:
                k = str(r.get("exp_date") or "")
                if not k:
                    continue
                exp_map_w[k] = float(r.get("total_expense") or 0.0)

            wd_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            rows_weekly: List[PerformanceTrendRow] = []
            cur_d = window_start
            while cur_d <= window_end:
                key = cur_d.strftime("%Y-%m-%d")
                paid = float(paid_map.get(key, 0.0) or 0.0)
                disc = float(disc_map_w.get(key, 0.0) or 0.0)
                expv = float(exp_map_w.get(key, 0.0) or 0.0)
                rows_weekly.append(
                    PerformanceTrendRow(
                        name=wd_labels[cur_d.weekday()],
                        totalSales=paid + disc,
                        totalExpenses=expv,
                        sale_date=key,
                    )
                )
                cur_d = cur_d + timedelta(days=1)

            return {"success": True, "data": {"data": [r.model_dump(exclude_none=True) for r in rows_weekly]}}

        if period == "monthly":
            sales_bucket = f"DAY({sale_day})"  # 1..31
            discount_bucket = f"DAY({sale_day})"
            expense_bucket = f"DAY(DATE({_EXPENSE_LOCAL_DT_SQL}))"
        else:
            sales_bucket = f"MONTH({sale_day})"  # 1..12
            discount_bucket = f"MONTH({sale_day})"
            expense_bucket = f"MONTH(DATE({_EXPENSE_LOCAL_DT_SQL}))"

        # Sales (paid) by bucket
        sales_where = ["b.STATUS IN (1, 2)"]
        sales_params: List[object] = []
        if effective_start and effective_end:
            sales_range, sales_range_params = ph_local_day_range_condition(
                "b.ENCODED_DT",
                effective_start.strftime("%Y-%m-%d"),
                effective_end.strftime("%Y-%m-%d"),
                "b.BRANCH_ID",
            )
            sales_where.append(sales_range)
            sales_params.extend(sales_range_params)
        if branch_id:
            sales_where.append("b.BRANCH_ID = %s")
            sales_params.append(branch_id)
        else:
            sales_where.append(f"b.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")

        sales_query = f"""
            SELECT
                {sales_bucket} AS bucket,
                COALESCE(SUM(b.AMOUNT_PAID), 0) AS paid_total
            FROM billing b
            WHERE {" AND ".join(sales_where)}
            GROUP BY bucket
        """
        cur.execute(sales_query, sales_params)
        sales_rows = cur.fetchall()

        # Discounts by bucket (aligned with daily-sales: filter + group by billing PH day, not order.ENCODED_DT)
        disc_where = ["1=1"]
        disc_params: List[object] = []
        if effective_start and effective_end:
            disc_range, disc_range_params = ph_local_day_range_condition(
                "b.ENCODED_DT",
                effective_start.strftime("%Y-%m-%d"),
                effective_end.strftime("%Y-%m-%d"),
                "b.BRANCH_ID",
            )
            disc_where.append(disc_range)
            disc_params.extend(disc_range_params)
        if branch_id:
            disc_where.append("o.BRANCH_ID = %s")
            disc_params.append(branch_id)
        else:
            disc_where.append(f"o.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")

        disc_query = f"""
            SELECT
                {discount_bucket} AS bucket,
                COALESCE(SUM(o.DISCOUNT_AMOUNT), 0) AS discount_total
            FROM orders o
            INNER JOIN billing b ON b.ORDER_ID = o.IDNo AND b.STATUS IN (1, 2)
            WHERE {" AND ".join(disc_where)}
            GROUP BY bucket
        """
        cur.execute(disc_query, disc_params)
        disc_rows = cur.fetchall()

        # Expenses by bucket
        exp_where = ["e.ACTIVE = 1", "oc.ACTIVE = 1"]
        exp_params: List[object] = []
        if branch_id:
            exp_where.append("e.BRANCH_ID = %s")
            exp_params.append(branch_id)
        else:
            exp_where.append(f"e.BRANCH_ID NOT IN ({','.join(map(str, _TEST_BRANCH_IDS))})")
        if effective_start and effective_end:
            exp_where.append(ph_local_day_range_predicate("e.ENCODED_DT"))
            exp_params.extend(ph_local_day_range_params(
                effective_start.strftime("%Y-%m-%d"), effective_end.strftime("%Y-%m-%d")
            ))
        elif effective_start:
            exp_where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) >= %s")
            exp_params.append(effective_start.strftime("%Y-%m-%d"))
        elif effective_end:
            exp_where.append(f"DATE({_EXPENSE_LOCAL_DT_SQL}) <= %s")
            exp_params.append(effective_end.strftime("%Y-%m-%d"))

        exp_query = f"""
            SELECT
                {expense_bucket} AS bucket,
                COALESCE(SUM(e.EXP_AMOUNT), 0) AS total_expense
            FROM expenses e
            LEFT JOIN master_categories mc ON mc.ACTIVE = 1 AND mc.IDNo = e.MASTER_CAT_ID
            INNER JOIN operation_category oc ON oc.IDNo = mc.OP_CAT_ID AND oc.ACTIVE = 1
            WHERE {" AND ".join(exp_where)}
            GROUP BY bucket
        """
        cur.execute(exp_query, exp_params)
        exp_rows = cur.fetchall()

        cur.close()
        conn.close()
    except Exception as exc:
        print("[PyServer] performance-trend query failed:", getattr(exc, "message", str(exc)))
        return {
            "success": False,
            "message": "Failed to fetch performance trend",
            "error": getattr(exc, "message", str(exc)),
        }

    sales_map: Dict[int, float] = {}
    for r in sales_rows:
        try:
            k = int(r.get("bucket"))
        except Exception:
            continue
        sales_map[k] = float(r.get("paid_total") or 0.0)

    disc_map: Dict[int, float] = {}
    for r in disc_rows:
        try:
            k = int(r.get("bucket"))
        except Exception:
            continue
        disc_map[k] = float(r.get("discount_total") or 0.0)

    exp_map: Dict[int, float] = {}
    for r in exp_rows:
        try:
            k = int(r.get("bucket"))
        except Exception:
            continue
        exp_map[k] = float(r.get("total_expense") or 0.0)

    if period == "monthly":
        keys = list(range(1, 32))
        labels = [str(k) for k in keys]
    else:
        # yearly (weekly returns earlier from the endpoint)
        keys = list(range(1, 13))
        labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    rows_out: List[PerformanceTrendRow] = []
    for idx, k in enumerate(keys):
        name = labels[idx] if idx < len(labels) else str(k)
        paid_total = float(sales_map.get(k, 0.0) or 0.0)
        discount_total = float(disc_map.get(k, 0.0) or 0.0)
        total_sales = paid_total + discount_total
        total_exp = float(exp_map.get(k, 0.0) or 0.0)
        rows_out.append(
            PerformanceTrendRow(name=name, totalSales=total_sales, totalExpenses=total_exp)
        )

    return {"success": True, "data": {"data": [r.model_dump() for r in rows_out]}}


# Attach analytics report routes (menu, category, payment, receipt)
import reports  # noqa: E402

app.include_router(reports.router)
