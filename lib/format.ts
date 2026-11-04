export const ACTION_LABEL: Record<string, string> = {
  REORDER_NOW: "Reorder now", REORDER_HIGH_DEMAND: "Reorder (high demand)", PAUSE_ORDER: "Pause next order", PAUSE_REVIEW: "Pause + review",
  NO_ACTION: "No action", EXCEPTION: "Needs judgment",
};
export const FLAG_LABEL: Record<string, string> = { HIGH_DEMAND: "High demand", STOCKOUT_RISK: "Stockout risk", OVERSTOCK_RISK: "Overstock risk" };
export const REASON_LABEL: Record<string, string> = { market_knowledge: "Market knowledge", supplier_issue: "Supplier issue", already_ordered: "Already ordered", data_wrong: "Data is wrong", other: "Other" };
export const EXC_HINT: Record<string, string> = {
  NEW_SKU: "Not enough history for any rule", NO_DEMAND_STOCK_HELD: "Dead stock or a delisted SKU", DISTRIBUTOR_ANOMALY: "A distributor behaves unusually",
  SKU_SPIKE_OR_DROP: "Week-on-week jump or drop", RULE_CONFLICT: "High demand and overstock together", DATA_ISSUE: "Inputs cannot be trusted",
};
export const n1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(d));
export const signed = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%");
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
