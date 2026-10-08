# Branch Comparison — Context Breakdown

Side-by-side performance of selected branches for the **selected date range** (e.g. Jul 1–29, 2026).

Also see: [Sales Analytics](./sales-analytics.md) (Sales Report page — All Branches + single-branch + menu item analytics).

- **Columns** = branches  
- **TOP** badge = best value in that row  
  - Default: **highest** wins  
  - **Expenses** rows: **lowest** wins (“lowest is best”)

Metric labels in the UI are always **Korean** (`COMPARE_METRIC_LABELS` in `AdminDashboard.tsx`).

---

## 1. Totals (top block)

Absolute figures for the **full selected date range**.

| Row (UI) | Meaning | Badge / notes |
|----------|---------|----------------|
| **매출액** | Total sales | TOP = highest sales |
| **비용** | Total expenses | Badge = `expenses ÷ sales × 100`. Green if ≥ peer average; yellow if below. TOP = **lowest** expenses |
| **순이익** | Net profit = sales − expenses | Badge = `profit ÷ sales × 100`. Same green/yellow vs peers. TOP = highest profit |

**Click:** 비용 / 순이익 % opens a breakdown popup:

```text
Rate = Amount ÷ Sales × 100
```

---

## 2. Comparison windows (shared by Sales / Expenses / Profit)

Each of **SALES**, **EXPENSES**, and **PROFIT** repeats the same three rows.

| Row (UI) | Current window | Baseline (shown amount) | Purpose |
|----------|----------------|-------------------------|---------|
| **전월 동기 대비(3일전 기준)** | Same calendar stretch this month, ending **3 days before** selected end | Same stretch last month | Fair MoM; incomplete / late days excluded |
| **전월 대비** | Month-to-date (1st → selected end) | **Full** prior calendar month | Partial month vs full prior month |
| **평균 대비** | Month-to-date (same as 전월 대비) | Average of last **3 full** calendar months ÷ 3 | Vs recent run-rate |

### Example (`end` = Jul 29)

| Row | Current | Baseline |
|-----|---------|----------|
| 전월 동기 (3일전) | Jul 1 → Jul 26 | Jun 1 → Jun 26 |
| 전월 대비 | Jul 1 → Jul 29 | Jun 1 → Jun 30 |
| 평균 대비 | Jul 1 → Jul 29 | avg(Apr full + May full + Jun full) |

### Display rules

- **Amount** = baseline (previous / average), not current  
- **%** = Korean-style **index**: `100 + % change`  
  - `100%` = flat  
  - `104.4%` = +4.4% vs baseline  
  - `98.5%` = −1.5% vs baseline  
- **Arrow** (↗ / ↘): only on **전월 동기**  
- **전월 대비** / **평균 대비**: index % only (no arrow)  
- **Sentiment colors**  
  - Sales / Profit: green ≥ 100, red < 100  
  - Expenses: **inverted** (expense up = red / bad)

**Click** a cell → popup with date ranges, current vs previous amounts, and formula.

---

## 3. MAIN EXPENSES

Composition of expenses for the **selected period**, each as **% of that branch’s 매출액**.

| Row (UI) | Content | Typical source categories |
|----------|---------|---------------------------|
| **식자재 및 주류** | Food supplies & liquor (+ market/mart purchases) | Main `식자재 / Food Supplies`, main `마트 / Mart` |
| **임대료** | Rent | Sub/name hints `rent` / `월세` / `임대`, or EXP_DESC (e.g. KumHo `가게월세` under Fixed Costs) |
| **급여** | Labor / salary / benefits | Sub `급여 및 복지 / Labor, Benefits`, pure main `SALARY` / `급여` |
| **그밖에** | Others (remainder) | Operation supplies, indirect, vehicle, fixed costs (minus rent), etc. |

```text
% = category amount ÷ branch total sales × 100
```

- Format: `₱amount (xx.x%)`  
- TOP = **lowest** amount  
- **Click** → popup (category ÷ sales), same style as 비용 / 순이익  

### KumHo (branch 9) mapping notes

| KumHo main / sub | Main Expenses bucket |
|------------------|----------------------|
| `1. 식자재 / Food Supplies` (all subs) | 식자재 및 주류 |
| `3. 마트 / Mart` (all stores) | 식자재 및 주류 |
| `2. 매장운영 / Operation` → `4. 급여 및 복지 / Labor, Benefits` | 급여 |
| `SALARY` → `급여` | 급여 |
| EXP_DESC rent (e.g. `가게월세`, `RENTAL`) under Fixed Costs / Indirect | 임대료 |
| Other Operation / Fixed Costs (non-rent) | 그밖에 |

Rent found via EXP_DESC is subtracted from **그밖에** (not from food). Older bug subtracted rent from food and understated 식자재.
---

## 4. Layout map

```text
매출액 / 비용 / 순이익          ← absolute totals + % of sales
──────── SALES ────────
전월 동기 / 전월 대비 / 평균 대비
──────── EXPENSES ─────
전월 동기 / 전월 대비 / 평균 대비
──────── PROFIT ───────
전월 동기 / 전월 대비 / 평균 대비
──────── MAIN EXPENSES ─
식자재 / 임대료 / 급여 / 그밖에   ← % of 매출액
```

---

## 5. Implementation notes

| Concern | Where |
|---------|--------|
| UI + compare math | `src/components/dashboard/AdminDashboard.tsx` |
| Window helpers | `getSamePeriodWindows`, `getMtdVsFullPreviousMonth`, `getPreviousThreeMonthsRange` |
| Lookback for 전월 동기 | `SAME_PERIOD_LOOKBACK_DAYS = 3` |
| Trailing average months | `TRAILING_AVG_MONTHS = 3` |
| Main expense buckets | `sumMainExpenseBuckets` + rent/salary EXP_DESC fallbacks |

Same date-window logic is reused in **Menu Item Analytics** (`MenuItemAnalyticsModal.tsx`) for the comparison table.
