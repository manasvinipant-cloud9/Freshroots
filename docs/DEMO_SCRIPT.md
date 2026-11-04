# 5-minute demo

Setup once: `npm run migrate`, `npm run dev`, open the app (landing page at `/`, planner at `/planner`). Seed data is as-of 2026-10-19: October, a festival month.

1. **Run the pipeline (0:00).** Header, **Run now**, untick Gemini if there is no key, Run. Point out 7 actions out of 15 SKUs. Open **Data quality and runs** to show the report and the fallbacks used (no price, lead time, on-order units, distributor column).
2. **A P1 stockout row (1:00).** On **Recommended actions** click SKU001 Mango Drink: High demand plus Stockout risk, cover 3.35 weeks, +21.4%, Reorder now 750 (1.5 x 500). The drawer shows the machine-readable reasons. Note perishables (Multigrain Bread, Almond Milk) rank first within P1.
3. **A festival-month example (2:00).** Tick "Show no-action SKUs". SKU002 Oats Cookies has 11.5 weeks of cover with the 25% uplift, so no action; without it, 14.3 weeks would be Pause. Also SKU007 Coconut Water at 4.08 weeks against the 4-week perishable limit. Mention the R1 toggle in `config/rules.json` (RUBRIC section 3). To see the same data without the uplift, Run now with as-of 2026-09-14.
4. **Approve one, see the PO draft (3:00).** Select SKU001, Approve. The status becomes PO DRAFTED. **Status and POs** shows the draft; download the Zoho payload.
5. **Reject one with a reason (3:45).** Select SKU013, Reject, reason "Supplier issue", add a note. Then select SKU004, Edit quantity to 100 with reason "Market knowledge", save, and approve.
6. **Kill switch (4:15).** Header, Kill switch, Engage. Run now: the run is SKIPPED. Approve another row: it is recorded but no PO draft is made, and the Status page says so. Release it.
7. **Audit log (4:45).** **Data quality and runs**, Audit log: run, recommendations, approve, reject, edit, PO drafted, kill switch on and off, each with who and when. **Impact** shows the override rate and reasons.

Optional: `npm run scale:data` then `npm run run:local -- --no-ai --data-dir data_scale` for 400 SKUs x 1,200 distributors in a few seconds.
