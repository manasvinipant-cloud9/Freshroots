# Decisions, assumptions and questions about the rubric

Items marked **[RUBRIC?]** are places where I implemented the rubric as written but think it needs confirming with Raghav.

## Rubric behaviour implemented as stated
1. **Festival uplift and R1 [RUBRIC?].** Uplift raises the demand figure for cover (R2/R3); R1 compares recent sales with the *raw* 12-week average. `festival_uplift_applies_to_r1_baseline` flips this (tested both ways, examples 2 and 2b). On the seed data the toggle removes SKU001's high-demand flag (+21.4% becomes -2.8%) and drops its quantity from 750 to 500.
2. Baseline window includes the recent 4 weeks (rubric assumption).
3. Strict inequalities everywhere. Ratios and covers are rounded to 9 decimals first so float noise cannot flip a boundary (cover exactly 6.0, +20.0%).
4. Perishable limits (3 and 4 weeks) replace 6 and 14 in R2/R3. The quantity cap uses the same ceiling.

## Departures, gaps and interpretations
5. **Ranking order.** Rubric 6 lists "sort by value at risk" and "perishables above non-perishables within a tier". I applied perishable first, then value.
6. **Value at risk without price.** Stockout = shortfall units, overstock = excess units. For `REORDER_HIGH_DEMAND` (no cover breach) I use weekly units of demand above the baseline as the proxy. When a `Unit_Price` column appears it multiplies through and `value_unit` becomes `INR`.
7. **Blocking vs non-blocking exceptions.** Blocking (no rule action, action `EXCEPTION`, priority `EX`): `NEW_SKU`, `NO_DEMAND_STOCK_HELD`, `DATA_ISSUE` for missing or negative stock. Non-blocking, rule action kept and row marked "review before approving": `DISTRIBUTOR_ANOMALY`, `SKU_SPIKE_OR_DROP`, `RULE_CONFLICT` (which accompanies `PAUSE_REVIEW`), and `DATA_ISSUE` for a SKU with more than 2 filled sales weeks (rubric section 7 says "flag the SKU", not "stop it").
8. **`PAUSE_REVIEW` [RUBRIC?].** The decision table gives it an action and says it "goes to exceptions". It appears in both queues. Approving it records the decision but creates no PO (quantity 0), as for `PAUSE_ORDER`.
9. **Kill switch scope.** It halts every run trigger (cron, CLI, "Run now") and PO creation. Approving while it is on is still recorded (`APPROVED`), but no PO draft is made until it is released; the Status page then offers "Create PO drafts".
10. **One PO draft per approved row.** Real purchasing would consolidate per vendor. `vendor_id`, `item_id` and `rate` are `null` in the payload because the seed data has no Zoho IDs or prices; `vendor_name_hint` carries the distributor ID.
11. **Stale recommendations.** When a new run succeeds, `PENDING` rows from earlier runs become `SUPERSEDED` so nobody approves yesterday's numbers.
12. **`--as-of` replay.** An as-of date *later* than the data fails the freshness gate, by design. An as-of date *earlier* than the inventory date trims sales to that point and pairs them with the newer stock snapshot (logged as `INVENTORY_NEWER_THAN_AS_OF`). Useful to show a non-festival month, but not a true historical replay.
13. **History length** for `NEW_SKU` counts weeks from a SKU's first sale; gaps inside that span are zero-filled (soft fix), not treated as "new".
14. **ID normalisation** pads the numeric part to the width used in the SKU and distributor masters (SKU1 becomes SKU001).

## Platform choices (to match the other apps)
15. **Stack and method follow tech-stack-scout, kargo-hiring-web and aangan-calls-agent:** Next.js 15, Neon Postgres via `@neondatabase/serverless`, Gemini via `@google/genai` with a primary and a fallback model from env, shared-passcode middleware, cron secured by `CRON_SECRET`, Vercel and GitHub. I did not use OpenRouter (tech-stack-scout does); the brief asks for the Google SDK directly.
16. **Gemini retry = fallback model.** Attempt 1 uses `GEMINI_MODEL`, the one retry uses `GEMINI_FALLBACK_MODEL`. Both are env values; the defaults are copied from tech-stack-scout and should be changed if your account differs.
17. **Timestamps are stored as ISO text, numbers as double precision,** so Neon and the in-memory test database return identical types.
18. **Data upload.** Vercel's filesystem is read-only and function bodies are limited to about 4.5 MB, so the app ships with the seed CSVs and also accepts a validated upload of the five exports (max 4 MB each, stored in Postgres). Real three-year, 1,200-distributor exports need the live SAP connector behind `DataSource`; the scale test reads CSVs from disk.
19. **PO drafts live in Postgres** (downloadable as the exact Zoho JSON). When running locally the same JSON is also written to `out/po_drafts/`.
20. **Identity.** Access is a shared passcode (like the other apps), so the "who" in the audit log is the name typed in the sidebar, not an authenticated identity. Per-user login is the next step if audit needs to be tamper-proof.
21. **Cron time.** Vercel cron is UTC: `30 1 * * 1,4` is Mon and Thu 07:00 IST.

## Findings about the data and the rules at scale
22. **Seed data matches the profile** (15 SKUs, 240 sales rows W27-W42, 15 inventory rows, 4 distributors, 24 calendar rows). The golden table 10b reproduces exactly and no seed SKU triggers any exception code.
23. The seed `Distributor_Master` lists regions Karnataka and Gujarat; the case says Maharashtra and Goa. Not used by any rule.
24. **`DISTRIBUTOR_ANOMALY` is noisy at scale [RUBRIC?].** A SKU-wide demand change moves every distributor at once, and a 12-week standard deviation is a small sample, so on synthetic data many SKUs are flagged. Mitigations in `config/rules.json`: `distributor_anomaly_min_avg_units`, `distributor_anomaly_min_history_weeks`, `distributor_anomaly_z`. A better rule would compare each distributor's movement with the SKU's total movement. I did not change the rubric.
25. Synthetic data is only for plumbing and speed; its business results mean nothing.

## Not verified
26. **Gemini live path.** No API key was available, so the real SDK call has not run. Tests use a fake client for success, API error, bad JSON and out-of-range numbers. The SDK wiring (`responseJsonSchema`, thinking level) is the first thing to check on the first live run.
27. The live `ZohoInventoryClient` has never been called (disabled by default, never used in tests).
28. **Neon.** All SQL is tested on in-memory Postgres (PGlite). Neon's HTTP driver and transaction batching have not been exercised against a real Neon database yet.
