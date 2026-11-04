# Freshroots Demand Planning

Twice a week, the app turns SAP exports into ranked purchase recommendations. **Deterministic rules** (from `RUBRIC.md`, Raghav's documented logic) decide every flag, action and quantity. **Gemini** forecasts and explains around them but never changes a rule outcome. **Raghav approves or rejects every row**; nothing becomes a purchase order draft without an explicit Approve.

Stack: Next.js 15 · TypeScript · Neon Postgres · Gemini (`@google/genai`) · Vercel (cron) · GitHub.

## Flow (components map)

| Stage | What happens | Code |
|---|---|---|
| Trigger | Vercel Cron Mon + Thu 07:00 IST, "Run now" button, CLI. Skipped when the kill switch is on. `--as-of` supports demos on static data | `app/api/cron/run`, `app/api/run`, `scripts/run-pipeline.ts` |
| Input | SAP exports behind a `DataSource` (bundled seed CSVs, or five uploaded CSVs). Columns mapped in `config/schema-map.json`; a missing column fails the run loudly | `lib/ingest.ts` |
| Processing | Data cleanup: hard stops, soft fixes, fallbacks, data-quality report per run | `lib/cleanup.ts` |
| Context | Raghav's rules: pure and deterministic, no network, no LLM. Metrics, flags, decision table, quantities with a cap, exceptions, ranking | `lib/rules.ts`, `config/rules.json` |
| AI | Gemini: 4-week forecast, two-sentence explanation, "what looks unusual / what to check". Facts in, JSON out, validated, one retry, graceful fallback | `lib/ai.ts` |
| Output | Dashboard, approve/reject/edit, PO drafts (dry-run Zoho), kill switch, audit log | `app/(app)/*`, `lib/decisions.ts`, `lib/po.ts`, `lib/killswitch.ts` |

Full diagram: [docs/COMPONENTS_MAP.md](docs/COMPONENTS_MAP.md). Assumptions and questions about the rubric: [docs/DECISIONS.md](docs/DECISIONS.md). Five-minute walkthrough: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Design decisions

- **The AI never decides.** Flags, action, quantity and priority are written before the AI stage runs, and Gemini output lands only in separate `ai_*` columns. Tests inject a model that tries to smuggle in a different action and quantity; the stored rule output does not change.
- **Rules first, boundaries exact.** Strict inequalities as Raghav worded them: cover of exactly 6.0 is not a stockout, exactly +20% is not high demand. Every RUBRIC section 10 example is a unit test, and the section 10b golden table is reproduced exactly by an end-to-end run.
- **Festival uplift raises the demand figure used for cover** (R2, R3). By default the high-demand check (R1) compares against the *raw* 12-week average; `festival_uplift_applies_to_r1_baseline` flips it. This is the first thing to confirm with Raghav.
- **Failure is visible, never silent.** A data-quality hard stop gives a `FAILED` run and no recommendations. A Gemini failure completes the run rules-only and shows "AI note unavailable".
- **Human control.** Reject and edit need a reason code. Overrides are rows in `decisions`, the training data for the next phase. Every run, recommendation, decision, edit and kill-switch change is in `audit_log`.
- **Kill switch** halts runs and PO creation, persists in Postgres across restarts and deploys, and leaves the dashboard viewable.

## Run locally

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL (Neon), GEMINI_API_KEY, CRON_SECRET
npm run migrate                   # creates the tables
npm run run:pipeline -- --no-ai   # seed data, rules only: reproduces the golden table
npm run dev                       # http://localhost:3000
npm test                          # 68 tests incl. every rubric example (in-memory Postgres, no Neon needed)
```

No Neon yet? `npm run dev:local` and `npm run run:local -- --no-ai` use an on-disk Postgres in `.local-db` (development only; never set on Vercel).

CLI: `npm run run:pipeline -- --as-of 2026-09-14 --no-ai --data-dir data_scale`. The default as-of date is the inventory `As_Of_Date` (2026-10-19), so the seed run uses W42 as the last complete week and October as a festival month. Freshness is measured against the as-of date, not today.

## Deploy (GitHub + Vercel)

1. Push to GitHub, import the repo into Vercel.
2. Create a Neon database; add `DATABASE_URL`, `GEMINI_API_KEY`, `CRON_SECRET`, `APP_PASSCODE` as Vercel environment variables (see `.env.example`), then run `npm run migrate` once (or open the app: tables are created on first request).
3. `vercel.json` registers the cron (`30 1 * * 1,4` UTC = Mon and Thu 07:00 IST). Vercel sends `Authorization: Bearer $CRON_SECRET`.

## Scale test

```bash
npm run scale:data                                   # 400 SKUs x 1,200 distributors x 156 weeks (~1.85M sales rows) into data_scale/
npm run run:local -- --no-ai --data-dir data_scale   # a few seconds
```
The synthetic sales include `Distributor_ID`, so `DISTRIBUTOR_ANOMALY` is switched on. `tests/scale.test.ts` asserts the full run finishes in under a minute.

## Guardrails

Nothing becomes a PO without Approve · kill switch persists and blocks runs and POs · no secrets in the repo (`.env.example` only) · `lib/rules.ts` has no network access (a test asserts it) · `ZohoInventoryClient` is disabled unless `ZOHO_PO_ENABLED=true` and is never called by tests · uploaded exports are validated against the schema map before they are stored.

Earlier Python/Streamlit prototype: `reference-python/` (kept until you are happy with the TypeScript version).
