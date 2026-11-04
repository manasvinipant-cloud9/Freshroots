# Components map

```mermaid
flowchart LR
  subgraph Trigger
    CRON[Vercel Cron\nMon+Thu 07:00 IST] --> RUN
    BTN[Run now button] --> RUN
    CLI[CLI run --as-of] --> RUN
    KS{{Kill switch\nin Postgres}} -.halts.-> RUN
  end
  RUN[lib/pipeline.ts] --> ING
  subgraph Input
    ING[lib/ingest.ts\nDataSource: bundled CSV or uploaded set\nconfig/schema-map.json]
  end
  ING --> CLN
  subgraph Processing
    CLN[lib/cleanup.ts\nhard stops, soft fixes, fallbacks]
  end
  CLN -- hard stop --> FAIL[(run FAILED\nno recommendations)]
  CLN --> RULES
  subgraph Context
    RULES[lib/rules.ts\npure + deterministic\nmetrics, R1-R5, decision table,\nqty cap, exceptions, ranking]
  end
  RULES --> AI
  subgraph AI
    AI[lib/ai.ts\nGemini: forecast + explanation\nfacts in, JSON out, one retry]
  end
  AI -- fails / no key --> RO[rules-only\n'AI note unavailable']
  AI --> DB
  RO --> DB
  subgraph Output
    DB[(Neon Postgres\nruns, recommendations, exceptions,\ndecisions, po_drafts, audit_log)] --> UI[Next.js dashboard\n5 pages + kill switch]
    UI -- Approve / Reject / Edit --> DEC[lib/decisions.ts]
    DEC -- approved reorder --> PO[lib/po.ts]
    PO --> DRY[DryRunZohoClient\nZoho payload JSON]
    PO -.disabled by default.-> ZOHO[ZohoInventoryClient]
    KS -.blocks.-> PO
  end
```

## Determinism boundary

`lib/rules.ts` imports no network or LLM code (a test asserts this). Gemini output is stored in `ai_*` columns only. Flags, action, quantity and priority are written before the AI stage runs, so the model has no path to change them.

## Dashboard pages

| Page | Purpose |
|---|---|
| Recommended actions | Ranked table with filters, per-row Approve / Reject / Edit quantity, bulk approve, reasons drawer |
| Exceptions queue | SKUs needing judgment, with Gemini's "what looks unusual / what to check" |
| Status and POs | Lifecycle counts, every recommendation, PO drafts with payload download |
| Data quality and runs | Run history, per-run data-quality report, fallbacks, Gemini calls, data upload, audit log |
| Impact | The case's baseline next to measured cycle time, data age, P1 flags, approval and override rates |

The kill switch and Run now are in the header on every page.

## Data model

`runs`, `data_quality_issues`, `recommendations` (one row per SKU per run; lifecycle in `status`: PENDING, APPROVED, PO_DRAFTED, REJECTED, SUPERSEDED), `exceptions`, `ai_calls` (every prompt and response with the run id), `decisions`, `po_drafts`, `kill_switch_events`, `audit_log`, `data_files`.
