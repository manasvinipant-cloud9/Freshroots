# Freshroots Demand Planning: Decision Rubric (v1)

This is the rulebook the pipeline runs on. It encodes Raghav Kulkarni's documented forecasting logic (about 80-85% of his monthly recommendations) as deterministic rules. Gemini does not own these rules. Gemini forecasts, explains and flags exceptions *around* them (see section 8).

Anything marked **[ASSUMPTION]** is a judgment call the case did not specify. Each one is a config value, not hardcoded, and should be confirmed with Raghav.

---

## 1. Inputs and field mapping

Mapped against the five seed files as received. Put this mapping in `config/schema_map.yaml` and fail loudly if a column is missing.

| File | Real columns | Logical use |
|---|---|---|
| SKU master (15 SKUs) | `SKU_ID, SKU_Name, Category, Perishability, Standard_Reorder_Qty, Unit_of_Measure, Distributor_ID` | Join key; `Perishability` = `High` means perishable (R5), `Low` means standard; `Standard_Reorder_Qty` is the base reorder quantity; `Distributor_ID` links each SKU to one distributor |
| Weekly sales (240 rows) | `SKU_ID, Week, Units_Sold` | Demand history. `Week` is ISO format like `2026-W27`. 16 weeks (W27 to W42), 15 SKUs, no gaps or duplicates |
| Current inventory (15 rows) | `SKU_ID, Location, Units_On_Hand, As_Of_Date` | Stock. One row per SKU, single location (Pune Central Warehouse), as of 2026-10-19 |
| Distributor master (4 rows) | `Distributor_ID, Distributor_Name, Region, Status` | Display and filtering |
| Calendar (24 rows) | `Year, Month, Year_Month, Is_Festival_Month` | Festival flag by month, Jan 2025 to Dec 2026. Flags Mar, Oct, Nov, matching Raghav's list |

**What the seed data does not have** (each has a fallback, shown in the data-quality report):
- **No distributor dimension in sales.** Sales are weekly per SKU, not per distributor. So `DISTRIBUTOR_ANOMALY` (section 5) cannot run on this data. Build it so it switches on automatically if a `Distributor_ID` column appears in the sales file.
- **No unit price or cost.** Rank by units of shortfall or excess instead of rupees (section 6).
- **No lead time, no on-order units, no open POs.** Not used. Listed in section 11.
- **Stock is at SKU level, not distributor level.** The rules use that single figure.

---

## 2. Parameters (all configurable in `config/rules.yaml`)

| Parameter | Default | Source |
|---|---|---|
| `recent_window_weeks` | 4 | Raghav |
| `baseline_window_weeks` | 12 | Raghav |
| `high_demand_threshold_pct` | 20 | Raghav |
| `high_demand_reorder_multiplier` | 1.5 | Raghav |
| `stockout_cover_weeks` (standard) | 6 | Raghav |
| `overstock_cover_weeks` (standard) | 14 | Raghav |
| `perishable_min_cover_weeks` | 3 | Raghav |
| `perishable_max_cover_weeks` | 4 | Raghav |
| `festival_months` | Oct, Nov, Mar (calendar file overrides if it defines festival weeks) | Raghav |
| `festival_uplift_pct` | 25 | Raghav |
| `festival_uplift_applies_to_r1_baseline` | false | **[ASSUMPTION]** see section 3 |
| `min_history_weeks` | 12 | **[ASSUMPTION]** SKUs with less history go to the exception queue |
| `max_data_age_days` | 10 | **[ASSUMPTION]** freshness gate, measured against the inventory `As_Of_Date`, not the wall clock |
| `run_schedule` | Mon and Thu, 07:00 IST | **[ASSUMPTION]** "twice a week" |
| `distributor_anomaly_z` | 2.5 | **[ASSUMPTION]** |
| `sku_wow_spike_pct` | 50 | **[ASSUMPTION]** |

---

## 3. Derived metrics (computed in code, never by the LLM)

Run per SKU, aggregated across all distributors, as of the last *complete* week before the run date (or `--as-of`).

0. **As-of date.** Default to the inventory file's `As_Of_Date` (2026-10-19, a Monday). The last complete ISO week before it is 2026-W42. Support `--as-of` to override.
1. `baseline_avg_weekly` = mean weekly units over the trailing `baseline_window_weeks` (includes the recent weeks). **[ASSUMPTION: baseline includes the recent 4 weeks]**
2. `recent_avg_weekly` = mean weekly units over the trailing `recent_window_weeks`.
3. `festival_active` = the calendar row for the as-of month has `Is_Festival_Month` = TRUE (fall back to Oct, Nov, Mar).
4. `effective_avg_weekly` = `baseline_avg_weekly` x (1 + uplift) if `festival_active`, else `baseline_avg_weekly`. This is the demand figure for every threshold check. The uplift is applied **before** any check, as Raghav specified.
5. `cover_weeks` = `current_stock_units` / `effective_avg_weekly`. If `on_order_units` exists, report cover both with and without it, and use the **with** figure for decisions.
6. `recent_vs_baseline_pct` = (`recent_avg_weekly` / `r1_baseline` - 1) x 100, where `r1_baseline` = `baseline_avg_weekly` (default) or `effective_avg_weekly` if `festival_uplift_applies_to_r1_baseline` is true.

**Why R1 compares against the raw baseline by default.** The case says the uplift applies "before any threshold checks", which can be read two ways. Reading A: the uplift raises the demand figure used for cover (R2, R3) and also the baseline for R1. Reading B (the default here): it raises the demand figure for cover only, and R1 compares recent sales to the plain 12-week average. Reading A would suppress high-demand flags in a festival month because normal festival lift would be absorbed. In the seed data it suppresses **every** high-demand flag in October (SKU001 is +21.4% on the raw baseline but -2.8% on the uplifted one). Reading B keeps R1 alive and lets the uplift do its job on stock cover. This is the first thing to confirm with Raghav (section 11). The toggle makes either reading a config change.

---

## 4. Rules

Thresholds use strict inequalities exactly as worded by Raghav ("more than", "below", "exceeds").

| ID | Rule | Condition | Action |
|---|---|---|---|
| R1 | High demand | `recent_vs_baseline_pct` > 20 | Flag `HIGH_DEMAND`. Reorder at 1.5 x standard quantity |
| R2 | Stockout risk | non-perishable: `cover_weeks` < 6. Perishable: `cover_weeks` < 3 | Flag `STOCKOUT_RISK`. Recommend immediate reorder |
| R3 | Overstock risk | non-perishable: `cover_weeks` > 14. Perishable: `cover_weeks` > 4 | Flag `OVERSTOCK_RISK`. Recommend pausing the next order |
| R4 | Festival uplift | festival month | Applied in section 3, step 4. Not a flag by itself |
| R5 | Perishable windows | `is_perishable` | Replaces the 6 and 14 week limits in R2 and R3 with 3 and 4 |

For perishable SKUs, 3 to 4 weeks of cover (inclusive) is healthy.

### Decision table (precedence)

| R2 stockout | R1 high demand | R3 overstock | Recommended action | Qty multiplier | Priority |
|---|---|---|---|---|---|
| yes | yes | no | `REORDER_NOW` | 1.5 | P1 |
| yes | no | no | `REORDER_NOW` | 1.0 | P1 |
| no | yes | no | `REORDER_HIGH_DEMAND` | 1.5 | P2 |
| no | no | yes | `PAUSE_ORDER` | 0 | P3 |
| no | yes | yes | `PAUSE_REVIEW` (rules conflict, goes to exceptions) | 0 | P2 |
| no | no | no | `NO_ACTION` | n/a | none |

Stockout and overstock cannot both be true for the same SKU, because the cover limits do not overlap. If the data produces that, treat it as a data error and send the SKU to exceptions.

### Reorder quantity

1. `base_qty` = `standard_order_qty` if present. **[ASSUMPTION fallback]** otherwise `max(0, target_cover_weeks - cover_weeks) x effective_avg_weekly`, with `target_cover_weeks` = 8 for non-perishable and 3.5 for perishable.
2. `recommended_qty` = `base_qty` x multiplier, rounded up to whole units.
3. **Cap [ASSUMPTION]:** reduce `recommended_qty` so post-order cover does not exceed the overstock ceiling (14 weeks, or 4 for perishables). If the cap bites, say so in the rationale. This stops a 1.5x rule from pushing a perishable SKU into overstock.

---

## 5. Exceptions (the 15-20% that needs Raghav's judgment)

These SKUs get **no rule-based action**. They go to the Exceptions queue with the reason and a Gemini-written explanation.

| Code | Trigger | Why it needs a human |
|---|---|---|
| `NEW_SKU` | fewer than `min_history_weeks` of sales history | Not enough history for any rule |
| `NO_DEMAND_STOCK_HELD` | baseline average is 0 and stock > 0 | Dead stock or a delisted SKU |
| `DISTRIBUTOR_ANOMALY` | **Only if sales carry a distributor column (not in the seed data).** Any distributor's latest weekly units for the SKU deviate more than `distributor_anomaly_z` standard deviations from that distributor's own trailing average, or drop more than 40% | Matches the "unusual distributor behaviour" and competitor-scheme pattern in the case |
| `SKU_SPIKE_OR_DROP` | week-on-week change in total SKU units exceeds `sku_wow_spike_pct` | Possible one-off market event |
| `RULE_CONFLICT` | high demand and overstock together | Rules disagree |
| `DATA_ISSUE` | missing inventory row, negative stock, impossible values | Cannot trust the inputs |

A SKU can carry a rule-based action **and** an exception flag (for example `REORDER_NOW` plus `DISTRIBUTOR_ANOMALY`). In that case show both and mark the row "review before approving".

---

## 6. Ranking so the output is not 400 flags

1. Sort by priority tier (P1, P2, P3).
2. Within a tier, sort by `value_at_risk` descending.
   - Stockout: `shortfall_units` x `unit_price`, where `shortfall_units` = `(stockout_cover_weeks - cover_weeks)` x `effective_avg_weekly`.
   - Overstock: `(cover_weeks - overstock_cover_weeks)` x `effective_avg_weekly` x `unit_cost` (or price).
   - **The seed data has no price field**, so rank by shortfall or excess in units, and note on the dashboard that ranking is by units.
3. Perishable SKUs rank above non-perishable within the same tier.
4. The dashboard default view shows P1 and P2 and exceptions. `NO_ACTION` SKUs are hidden unless filtered in.

---

## 7. Data-quality gates (the "Data cleanup" step)

**Hard stops** (abort the run, record it as `FAILED`, show it on the dashboard, create no recommendations):
- A required file or required logical field is missing.
- Latest sales week, or the inventory `As_Of_Date`, is older than `max_data_age_days` against the as-of date. For the static seed data, run with the default as-of (the inventory date) or the gate will fail against today's date.
- More than 20% of active SKUs have no inventory row.

**Soft fixes** (continue, but log every one in the data-quality report):
- Normalise SKU and distributor IDs (trim, case, leading zeros).
- Duplicate rows on (week, sku, distributor): keep the last, log the count.
- Unknown SKU in sales or inventory: quarantine the row.
- Negative `units_sold`: treat as returns, net against the week, floor the weekly SKU total at 0 for demand, log it.
- Missing weeks for an active SKU: fill with 0 and flag the SKU if more than 2 weeks were filled.
- Missing `standard_order_qty`, price or lead time: use the fallbacks above and record "fallback used".

The data-quality report is stored per run and shown on the dashboard.

---

## 8. What Gemini is and is not allowed to do

**Allowed**
1. **Forecast** next-4-week demand for each non-`NO_ACTION` SKU and each exception SKU, given the cleaned weekly series, the festival flag and the rule outcome.
2. **Explain** each recommendation in two sentences of plain language for Raghav.
3. **Explain exceptions:** say what looks unusual and what Raghav should check.

**Not allowed**
- Changing a rule flag, an action or a quantity. The rule engine output is final input to the dashboard.
- Doing arithmetic. All numbers are computed in code and passed in as facts.
- Making up context (promotions, competitor moves) that is not in the supplied data. It may say "possible competitor scheme" only as a hypothesis, labelled as such.

**Controls**
- Structured JSON output against a schema; validate every response.
- The system computes its own simple statistical forecast (trailing average adjusted for festival uplift). If Gemini's 4-week forecast differs from it by more than 40%, mark the row "forecast disagrees with baseline".
- If Gemini fails, times out or returns invalid JSON after one retry, the run **still completes** rules-only. Rows show "AI note unavailable".
- Log every prompt and response with the run ID.

---

## 9. Human control

- **Approve / Reject** per row, with an optional quantity edit. Rejecting or editing requires a reason code (`market_knowledge`, `supplier_issue`, `already_ordered`, `data_wrong`, `other`) and optional free text.
- **Kill switch:** one global control. When engaged, scheduled runs are skipped and no purchase orders are created or pushed. The dashboard stays viewable.
- **Nothing becomes a purchase order without an Approve.**
- **Audit log:** every run, recommendation, approval, rejection, edit and kill-switch change, with timestamp and user. Overrides are the training data for the next phase.

---

## 10. Worked examples (these are the acceptance tests)

All use a standard order quantity of 300 and no festival unless stated.

| # | Setup | Result |
|---|---|---|
| 1 | Non-perishable. Baseline 100/wk, recent 130/wk, stock 800 | Ratio +30%, cover 8.0. `HIGH_DEMAND`. `REORDER_HIGH_DEMAND`, qty 450 |
| 2 | **November**, default toggle. Baseline 100/wk (effective 125), recent 140/wk, stock 700 | Recent is +40% vs raw baseline, so `HIGH_DEMAND`. Cover 700/125 = 5.6 < 6, so `STOCKOUT_RISK`. `REORDER_NOW`, qty 450. (Without the uplift, cover would be 7.0 and the stockout would be missed.) |
| 2b | Same as 2 with `festival_uplift_applies_to_r1_baseline` = true | Recent is +12% vs effective baseline, so **not** high demand. `STOCKOUT_RISK` only. `REORDER_NOW`, qty 300 |
| 3a | Perishable. Baseline 200/wk, stock 500 | Cover 2.5 < 3. `REORDER_NOW` |
| 3b | Perishable. Baseline 200/wk, stock 700 | Cover 3.5. `NO_ACTION` |
| 3c | Perishable. Baseline 200/wk, stock 900 | Cover 4.5 > 4. `PAUSE_ORDER` |
| 4 | Non-perishable. Baseline 50/wk, stock 800 | Cover 16 > 14. `PAUSE_ORDER` |
| 5 | Baseline 100/wk, recent 150/wk, stock 1500 | High demand and cover 15 > 14. `PAUSE_REVIEW`, exception `RULE_CONFLICT` |
| 6 | Baseline 100/wk, recent 135/wk, stock 400 | Cover 4 < 6 and +35%. `REORDER_NOW`, qty 450, P1 |
| 7 | SKU with 5 weeks of history | Exception `NEW_SKU`, no rule action |
| 8 | Baseline 0/wk, stock 300 | Exception `NO_DEMAND_STOCK_HELD` |
| 9 | Boundary: baseline 100/wk, stock exactly 600 | Cover 6.0, not below 6, so no stockout flag |
| 10 | Boundary: baseline 100/wk, recent exactly 120/wk | +20.0%, not more than 20, so no high-demand flag |

---

### 10b. Golden results on the seed data

As-of 2026-10-19 (W42 last complete week), October festival uplift active, default toggle. The pipeline run on the seed files must reproduce these exactly. They are the end-to-end acceptance test.

| SKU | Perishable | Cover (weeks) | Recent vs baseline | Result |
|---|---|---|---|---|
| SKU001 Mango Drink | no | 3.35 | +21.4% | `HIGH_DEMAND` + `STOCKOUT_RISK`. `REORDER_NOW`, qty 750 (1.5 x 500), P1 |
| SKU003 Brown Rice | no | 4.36 | +0.2% | `STOCKOUT_RISK`. `REORDER_NOW`, qty 300 |
| SKU004 Almond Milk | yes | 1.80 | +1.5% | `STOCKOUT_RISK`. `REORDER_NOW`, qty 150 |
| SKU011 Multigrain Bread | yes | 1.80 | +2.4% | `STOCKOUT_RISK`. `REORDER_NOW`, qty 500 |
| SKU013 Peanut Butter | no | 3.17 | -1.5% | `STOCKOUT_RISK`. `REORDER_NOW`, qty 120 |
| SKU006 Quinoa | no | 22.23 | +1.7% | `OVERSTOCK_RISK`. `PAUSE_ORDER` |
| SKU007 Coconut Water | yes | 4.08 | +9.9% | `OVERSTOCK_RISK` (perishable limit is 4). `PAUSE_ORDER` |
| SKU002, 005, 008, 009, 010, 012, 014, 015 | mixed | 6.77 to 11.46 | within +/-10% | `NO_ACTION` |

Worth noticing for the demo: the festival uplift changes exactly one outcome on this data. SKU002 (Oats Cookies) has 14.3 weeks of cover without the uplift, which would be `PAUSE_ORDER`, and 11.5 weeks with it, which is `NO_ACTION`. SKU007 is a close call at 4.08 weeks against the 4 week perishable cap, so keep the cover figure visible on the dashboard.

Nothing in the seed data triggers the exception codes (all SKUs have 16 weeks of history and no gaps). Test those with fixtures.

## 11. Open questions to confirm with Raghav

0. **Does the 25% festival uplift apply to the R1 baseline as well as to stock cover?** (Section 3. Changes whether any SKU is flagged high demand in a festival month.)
1. Is the 12-week baseline meant to include the most recent 4 weeks?
2. `Standard_Reorder_Qty` in the SKU master is used as the base reorder quantity. Is that the right figure?
3. Inventory is one central warehouse figure per SKU. Is distributor-held stock excluded on purpose?
4. Are open purchase orders in Zoho counted in stock? The case does not mention them, and ignoring them risks duplicate orders.
5. Should lead time raise urgency (for example, a 10-day lead time and 6 weeks of cover is fine, but 3 weeks of lead time is not)?
6. Is the festival uplift meant for the whole month, or only the weeks near the festival?
