#!/usr/bin/env python3
"""Generate a full-size synthetic dataset in the seed schema, WITH a Distributor_ID column in weekly sales.

Defaults: 400 SKUs, 1,200 distributors, 156 weeks (3 years) ending 2026-W42, as-of 2026-10-19.
Injected on purpose so every code path is exercised: a few NEW_SKU, NO_DEMAND_STOCK_HELD, SKU spikes
and DISTRIBUTOR_ANOMALY cases, plus a spread of stockout / overstock / high-demand SKUs.
"""
import argparse
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data_scale")
    ap.add_argument("--skus", type=int, default=400)
    ap.add_argument("--distributors", type=int, default=1200)
    ap.add_argument("--weeks", type=int, default=156)
    ap.add_argument("--dists-per-sku", type=int, default=30)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    last_monday = datetime.strptime("2026-W42-1", "%G-W%V-%u")
    mondays = [last_monday - timedelta(days=7 * k) for k in range(a.weeks - 1, -1, -1)]
    labels = ["%d-W%02d" % (m.isocalendar()[0], m.isocalendar()[1]) for m in mondays]
    months = np.array([(m + timedelta(days=3)).month for m in mondays])
    festival_wk = np.isin(months, [3, 10, 11])

    S, D, W = a.skus, a.distributors, a.weeks
    sku_ids = ["SKU%03d" % (i + 1) for i in range(S)]
    dist_ids = ["DIST%04d" % (i + 1) for i in range(D)]
    base = np.exp(rng.normal(np.log(600), 0.6, S))            # weekly units per SKU
    perish = rng.random(S) < 0.25
    seasonal = 1 + 0.04 * festival_wk[None, :]   # small step so festival weeks do not look like distributor anomalies
    sku_week = base[:, None] * seasonal * (1 + rng.normal(0, 0.06, (S, W)))

    # last-4-week demand shocks (high demand) for ~8% of SKUs
    shock = rng.choice(S, int(0.08 * S), replace=False)
    sku_week[shock, -4:] *= rng.uniform(1.3, 1.5, (len(shock), 1))
    # trend in the last 16 weeks at random
    sku_week[:, -16:] *= (1 + rng.normal(0, 0.03, (S, 1)))
    # edge cases
    free = [i for i in range(S) if i not in set(shock)]
    new_skus = free[0:5]
    dead = free[5:8]
    spikes = free[8:12]
    for i in new_skus:
        sku_week[i, :-6] = np.nan                               # only 6 weeks of history
    for i in dead:
        sku_week[i, -20:] = 0.0
    for i in spikes:
        sku_week[i, -1] *= 2.4

    # distributor split: each SKU sold through k distributors (Dirichlet weights)
    k = min(a.dists_per_sku, D)
    pair_sku = np.repeat(np.arange(S), k)
    pair_dist = np.concatenate([rng.choice(D, k, replace=False) for _ in range(S)])
    weights = rng.dirichlet(np.ones(k) * 6, S).reshape(-1)
    noise = 1 + rng.normal(0, 0.03, (S * k, W))
    units = sku_week[pair_sku] * weights[:, None] * noise
    # distributor anomalies: 6 pairs drop 70% in the latest week
    anomalous = rng.choice(S * k, 6, replace=False)
    units[anomalous, -1] *= 0.3
    units = np.rint(np.clip(units, 0, None))
    nan_mask = np.isnan(sku_week[pair_sku])
    rows = np.where(~nan_mask)
    sales = pd.DataFrame({
        "SKU_ID": np.array(sku_ids)[pair_sku[rows[0]]],
        "Week": np.array(labels)[rows[1]],
        "Units_Sold": units[rows].astype(int),
        "Distributor_ID": np.array(dist_ids)[pair_dist[rows[0]]],
    })
    sales.to_csv(out / "weekly_sales.csv", index=False)

    eff = base * (1.25)   # festival month at as-of
    cover = rng.uniform(1.2, 20, S)
    stock = np.rint(cover * eff / 10) * 10
    for i in dead:
        stock[i] = 300
    pd.DataFrame({"SKU_ID": sku_ids, "Location": "Pune Central Warehouse", "Units_On_Hand": stock.astype(int),
                  "As_Of_Date": "2026-10-19"}).to_csv(out / "current_inventory.csv", index=False)
    pd.DataFrame({
        "SKU_ID": sku_ids, "SKU_Name": ["Freshroots Item %03d" % (i + 1) for i in range(S)],
        "Category": rng.choice(["Beverage", "Snack", "Staple", "Dairy", "Bakery"], S),
        "Perishability": np.where(perish, "High", "Low"),
        "Standard_Reorder_Qty": (np.rint(base * 1.5 / 10) * 10).astype(int),
        "Unit_of_Measure": "Units", "Distributor_ID": np.array(dist_ids)[pair_dist.reshape(S, k)[:, 0]],
    }).to_csv(out / "sku_master.csv", index=False)
    pd.DataFrame({"Distributor_ID": dist_ids, "Distributor_Name": ["Distributor %04d" % (i + 1) for i in range(D)],
                  "Region": rng.choice(["Maharashtra", "Goa"], D), "Status": "Active"}).to_csv(
        out / "distributor_master.csv", index=False)
    cal = [(y, m, "%d-%02d" % (y, m), "TRUE" if m in (3, 10, 11) else "FALSE") for y in range(2023, 2027) for m in range(1, 13)]
    pd.DataFrame(cal, columns=["Year", "Month", "Year_Month", "Is_Festival_Month"]).to_csv(out / "calendar.csv", index=False)
    print("Wrote %s: %d SKUs, %d distributors, %d sales rows, %d weeks" % (out, S, D, len(sales), W))


if __name__ == "__main__":
    main()
