# Sales Analytics — Context Breakdown

Page: **Sales Report → Sales Analytics**  
Filter: **date range** + **branch** (`All Branches` or a single branch).

Primary files:

| Area | File |
|------|------|
| Page layout / charts / lists | `src/components/analytics/SalesAnalytics.tsx` |
| Menu item comparison + 6-month trend | `src/components/analytics/MenuItemAnalyticsModal.tsx` |
| Data bundle / APIs | `src/services/analyticsService.ts`, server sales dashboard bundle |

Related: [Branch Comparison](./branch-comparison.md) (Dashboard).

---

## Two layouts 

| Mode | When | Bottom layout |
|------|------|----------------|
| **All Branches** | Branch filter = All Branches | **Total Sales per Branch** + **Top Revenue Items** (side by side) |
| **Single branch** | One branch selected | **Top Revenue Items** (left) + **Menu Item Analytics** panel (right) |

---

## 1. KPI strip (single-branch view; also available when metrics load)

Five clickable metrics for the selected period. Clicking a metric switches the main chart series. **Net sales** also opens Cash Reconciliation.

| KPI | Meaning |
|-----|---------|
| **Total sales** | Gross sales for the period |
| **Refund** | Refunds |
| **Discount** | Discounts |
| **Net sales** | Sales after refund/discount (+ cash recon adjustments where applied) |
| **Gross profit** | Net sales − product cost (may equal net when cost is 0 / unavailable) |

Under each KPI: **delta vs previous period of equal length** (absolute + %).  
Green = up / better; red = down (UI uses signed delta colors).

---

## 2. Daily trend chart (“Total sales” / active metric)

- **X-axis** = each day in the selected range (all dates shown for typical month ranges).  
- **Y-axis** = ₱ (compact `k` / chart scale).  
- Chart type: **Bar** or **Line/Area**; view mode control: Glance / Week (UI).  
- Active series follows the selected KPI (default Total sales).

### Weekend label colors (same rule as Dashboard Total Profit)

| Day | Color |
|-----|--------|
| **Saturday** | Red |
| **Sunday** | Green |
| Weekdays | Gray |

Example (Jul 2026): Sat = Jul 4, 11, 18, 25 · Sun = Jul 5, 12, 19, 26.

---

## 3. All Branches — Total Sales per Branch

Horizontal bars + small table:

| Column | Meaning |
|--------|---------|
| Branch | Name + color dot |
| Total sales | Period sales for that branch |
| Orders | Order count |
| Avg order | Average order value |

- Click a branch row → focuses **Top Revenue Items** to that branch (without leaving All Branches).  
- Bar colors are per-branch palette.

---

## 4. Top Revenue Items

Ranked menu items by revenue for the period.

| Mode | List size | Interaction |
|------|-----------|-------------|
| **All Branches** | Top **7** (modal for more) | Shows branch tag per item; click → **popup** Menu Item Analytics |
| **Single branch** | Top **10** | Click / auto-select #1 → **inline** analytics panel on the right |

Each row typically shows:

- Rank  
- Item name (`goods`)  
- Branch tag (All Branches)  
- Revenue amount  
- Qty sold  

---

## 5. Menu Item Analytics (2nd image — right panel / modal)

Opens for the selected Top Revenue item.

### Header

- Item name  
- Subtitle: High Revenue · branch name  

### Comparison table

Same **three windows** as Branch Comparison (see [branch-comparison.md](./branch-comparison.md) §2).

| Columns | Meaning |
|---------|---------|
| Comparison metric | 전월 동기 / 전월 대비 / 평균 대비 |
| Qty sold | Baseline qty + index `%` |
| Total sales | Baseline ₱ + index `%` |
| Unit price (if shown) | `sales ÷ qty` + index `%` |

**Display**

- Amount / qty = **baseline** (previous / average), not current  
- `%` = index (`100` = flat), e.g. `(105.8%)` = +5.8% vs baseline  
- Green if index ≥ 100; red if &lt; 100  
- No trend arrows (removed by design)

**Example (`end` = Jul 29)**

| Row | Current | Baseline shown |
|-----|---------|----------------|
| 전월 동기 (3일전) | Jul 1–26 | Jun 1–26 |
| 전월 대비 | Jul 1–29 | Jun 1–30 (full) |
| 평균 대비 | Jul 1–29 | avg(Apr+May+Jun full) |

### Monthly trend (6 months)

Two charts side by side:

| Chart | Content |
|-------|---------|
| **Qty sold** | Purple bars |
| **Total sales** | Green area / line |

**Month bars**

| Month type | Range |
|------------|--------|
| Past months (e.g. Feb–Jun) | **Full** calendar month |
| Current month (e.g. Jul) | **1st → selected end** (MTD) |

- X-axis labels = month short name only (`Feb`, `Mar`, …)  
- Year shown in each chart header (e.g. `2026`)  
- Header also shows **avg** across the 6 points (zeros included in ÷6)

Data: one fast Node endpoint `GET /api/analytics/menu-item-trend` (daily series → client aggregates).

---

## 6. Layout maps

### All Branches (image 1)

```text
[ Date range ] [ All Branches ]
┌─────────────────────────────────────┐
│  Daily Total sales chart            │  ← weekend red/green dates
│  (Sat red / Sun green labels)       │
└─────────────────────────────────────┘
┌──────────────────┐ ┌────────────────┐
│ Total Sales      │ │ Top Revenue    │
│ per Branch       │ │ Items (All)    │
│ bars + table     │ │ + branch tags  │
└──────────────────┘ └────────────────┘
         click item → Menu Item Analytics modal
```

### Single branch (image 2)

```text
[ Date range ] [ Kim's Brothers ]
┌──────────────────────────────────────────────────┐
│ Total sales | Refund | Discount | Net | Gross    │  ← KPI + vs prior period
│              Daily chart (active metric)         │
└──────────────────────────────────────────────────┘
┌─────────────────┐ ┌─────────────────────────────┐
│ Top Revenue     │ │ Menu Item Analytics         │
│ Items (10)      │ │ Comparison table            │
│                 │ │ Monthly trend (Qty + Sales) │
└─────────────────┘ └─────────────────────────────┘
```

---

## 7. Quick differences vs Branch Comparison

| Topic | Sales Analytics | Branch Comparison (Dashboard) |
|-------|-----------------|-------------------------------|
| Scope | Daily sales + menu items | Cross-branch P&amp;L style |
| 전월 동기 / 전월 / 평균 | On **menu item** panel | On Sales / Expenses / Profit rows |
| % of sales badges | Not on KPIs the same way | 비용 / 순이익 / Main Expenses |
| Weekend colors | Daily sales chart X-axis | Total Profit trend chart |
| TOP badge | — | Per comparison row |
