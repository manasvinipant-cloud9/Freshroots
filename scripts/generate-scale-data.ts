// Full-size synthetic dataset in the seed schema, WITH a Distributor_ID column in weekly sales.
// Defaults: 400 SKUs, 1,200 distributors, 156 weeks ending 2026-W42, as-of 2026-10-19.
// Injected on purpose so every code path runs: NEW_SKU, NO_DEMAND_STOCK_HELD, SKU spikes, DISTRIBUTOR_ANOMALY, and a spread of
// stockout / overstock / high-demand SKUs. Business results on synthetic data mean nothing; it is for plumbing and speed.
import fs from "node:fs";
import path from "node:path";
import { addDays } from "../lib/dates";
import { isoWeekLabel } from "../lib/dates";

export type ScaleOpts = { skus?: number; distributors?: number; weeks?: number; distsPerSku?: number; seed?: number };

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

export function generateScale(outDir: string, o: ScaleOpts = {}) {
  const S = o.skus ?? 400, D = o.distributors ?? 1200, W = o.weeks ?? 156, K = Math.min(o.distsPerSku ?? 30, D);
  const { next, normal } = rng(o.seed ?? 7);
  fs.mkdirSync(outDir, { recursive: true });
  const lastMonday = "2026-10-12";
  const mondays = Array.from({ length: W }, (_, i) => addDays(lastMonday, -7 * (W - 1 - i)));
  const labels = mondays.map(isoWeekLabel);
  const festival = mondays.map((m) => [3, 10, 11].includes(Number(addDays(m, 3).slice(5, 7))));
  const skuIds = Array.from({ length: S }, (_, i) => "SKU" + String(i + 1).padStart(3, "0"));
  const distIds = Array.from({ length: D }, (_, i) => "DIST" + String(i + 1).padStart(4, "0"));
  const base = skuIds.map(() => Math.exp(Math.log(600) + 0.6 * normal()));
  const perish = skuIds.map(() => next() < 0.25);
  const skuWeek = skuIds.map((_, s) => Float64Array.from({ length: W }, (_, w) => base[s] * (1 + 0.04 * Number(festival[w])) * (1 + 0.06 * normal())));
  // last-4-week demand shocks for ~8% of SKUs
  const order = [...Array(S).keys()].sort(() => next() - 0.5);
  const shock = new Set(order.slice(0, Math.floor(0.08 * S)));
  for (const s of shock) { const m = 1.3 + 0.2 * next(); for (let w = W - 4; w < W; w++) skuWeek[s][w] *= m; }
  const free = order.filter((s) => !shock.has(s));
  const [newSkus, dead, spikes] = [free.slice(0, 5), free.slice(5, 8), free.slice(8, 12)];
  for (const s of newSkus) for (let w = 0; w < W - 6; w++) skuWeek[s][w] = NaN;     // only 6 weeks of history
  for (const s of dead) for (let w = W - 20; w < W; w++) skuWeek[s][w] = 0;
  for (const s of spikes) skuWeek[s][W - 1] *= 2.4;

  // each SKU is sold through K distributors with random weights
  const lines: string[] = ["SKU_ID,Week,Units_Sold,Distributor_ID"];
  const primaryDist: string[] = [];
  const anomalous = new Set<number>();
  while (anomalous.size < 6) anomalous.add(Math.floor(next() * S * K));
  let pair = 0, rows = 0;
  for (let s = 0; s < S; s++) {
    const picked = new Set<number>();
    while (picked.size < K) picked.add(Math.floor(next() * D));
    const ds = [...picked];
    primaryDist.push(distIds[ds[0]]);
    const raw = ds.map(() => 0.5 + next() * 1.5);
    const tot = raw.reduce((a, b) => a + b, 0);
    ds.forEach((d, k) => {
      const wgt = raw[k] / tot;
      for (let w = 0; w < W; w++) {
        const v = skuWeek[s][w];
        if (Number.isNaN(v)) continue;
        let u = v * wgt * (1 + 0.03 * normal());
        if (w === W - 1 && anomalous.has(pair)) u *= 0.3;
        lines.push(`${skuIds[s]},${labels[w]},${Math.max(0, Math.round(u))},${distIds[d]}`); rows++;
      }
      pair++;
    });
  }
  fs.writeFileSync(path.join(outDir, "weekly_sales.csv"), lines.join("\n") + "\n");
  const stock = skuIds.map((_, s) => (dead.includes(s) ? 300 : Math.round(((1.2 + 18.8 * next()) * base[s] * 1.25) / 10) * 10));
  fs.writeFileSync(path.join(outDir, "current_inventory.csv"), ["SKU_ID,Location,Units_On_Hand,As_Of_Date", ...skuIds.map((id, s) => `${id},Pune Central Warehouse,${stock[s]},2026-10-19`)].join("\n") + "\n");
  const cats = ["Beverage", "Snack", "Staple", "Dairy", "Bakery"];
  fs.writeFileSync(path.join(outDir, "sku_master.csv"), ["SKU_ID,SKU_Name,Category,Perishability,Standard_Reorder_Qty,Unit_of_Measure,Distributor_ID",
    ...skuIds.map((id, s) => `${id},Freshroots Item ${String(s + 1).padStart(3, "0")},${cats[Math.floor(next() * 5)]},${perish[s] ? "High" : "Low"},${Math.round((base[s] * 1.5) / 10) * 10},Units,${primaryDist[s]}`)].join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "distributor_master.csv"), ["Distributor_ID,Distributor_Name,Region,Status", ...distIds.map((id, i) => `${id},Distributor ${String(i + 1).padStart(4, "0")},${next() < 0.5 ? "Maharashtra" : "Goa"},Active`)].join("\n") + "\n");
  const cal = ["Year,Month,Year_Month,Is_Festival_Month"];
  for (let y = 2023; y <= 2026; y++) for (let m = 1; m <= 12; m++) cal.push(`${y},${m},${y}-${String(m).padStart(2, "0")},${[3, 10, 11].includes(m) ? "TRUE" : "FALSE"}`);
  fs.writeFileSync(path.join(outDir, "calendar.csv"), cal.join("\n") + "\n");
  return { dir: outDir, skus: S, distributors: D, salesRows: rows, weeks: W };
}

if (process.argv[1] && process.argv[1].endsWith("generate-scale-data.ts")) {
  const out = process.argv[2] || "data_scale";
  const r = generateScale(out);
  console.log(`Wrote ${r.dir}: ${r.skus} SKUs, ${r.distributors} distributors, ${r.salesRows} sales rows, ${r.weeks} weeks`);
}
