"""Output stage: Streamlit dashboard. Run: make dashboard"""
from __future__ import annotations

import json
import os
from datetime import date

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from freshroots import decisions, killswitch
from freshroots.config import ROOT, load_config
from freshroots.pipeline import default_user, run_pipeline
from freshroots.po import get_client
from freshroots.store import Store

load_dotenv(ROOT / ".env")
st.set_page_config(page_title="Freshroots demand planning", layout="wide")


@st.cache_resource
def get_cfg():
    return load_config(db_path=os.environ.get("FRESHROOTS_DB"))


cfg = get_cfg()
store = Store(cfg.db_path)
client = get_client(cfg.po_drafts_dir)
user = st.sidebar.text_input("Your name (audit log)", value=default_user())


def flash(msg, kind="success"):
    st.session_state["flash"] = (kind, msg)
    st.rerun()


def j(v, default=None):
    try:
        return json.loads(v) if v else default
    except (TypeError, ValueError):
        return default


# ------------------------------------------------------------------ header + kill switch
ks = killswitch.state(store)
h1, h2 = st.columns([4, 2])
h1.title("Freshroots demand planning")
with h2:
    if ks["engaged"]:
        st.error("KILL SWITCH ENGAGED\n\nRuns and PO creation are halted (since %s by %s)." % (ks["since"], ks["by"]))
        if st.button("Release kill switch", key="ks_off"):
            killswitch.set_engaged(store, False, user, "released from dashboard")
            st.rerun()
    else:
        st.success("Kill switch: OFF (system live)")
        with st.popover("Engage kill switch"):
            why = st.text_input("Reason", key="ks_reason")
            if st.button("Engage now", type="primary", key="ks_on"):
                killswitch.set_engaged(store, True, user, why)
                st.rerun()

# ------------------------------------------------------------------------------ sidebar
page = st.sidebar.radio("Page", ["Recommended actions", "Exceptions queue", "Status and POs",
                                 "Data quality and runs", "Impact"])
with st.sidebar.expander("Run now", expanded=False):
    as_of_txt = st.text_input("As-of date (blank = inventory date)", value="", placeholder="YYYY-MM-DD")
    use_ai = st.checkbox("Use Gemini", value=bool(os.environ.get("GEMINI_API_KEY")))
    if st.button("Run pipeline now"):
        try:
            as_of = date.fromisoformat(as_of_txt) if as_of_txt.strip() else None
            with st.spinner("Running..."):
                res = run_pipeline(cfg, store, as_of=as_of, use_ai=use_ai, trigger="dashboard", user=user)
            (st.success if res["status"] == "SUCCESS" else st.warning)("Run %s: %s. %s" % (res["run_id"], res["status"], res["message"]))
        except ValueError:
            st.error("As-of date must be YYYY-MM-DD")

runs = store.query("SELECT * FROM runs ORDER BY run_id DESC")
good = [r for r in runs if r["status"] == "SUCCESS"]
run = None
if good:
    labels = {r["run_id"]: "Run %d  (%s, as-of %s)" % (r["run_id"], r["started_at"][:16], r["as_of"]) for r in good}
    rid = st.sidebar.selectbox("Showing run", list(labels), format_func=labels.get)
    run = next(r for r in good if r["run_id"] == rid)


def load_recs(run_id):
    df = pd.DataFrame(store.recommendations(run_id))
    if df.empty:
        return df
    df["flags_l"] = df["flags"].map(lambda v: j(v, []))
    df["exc_l"] = df["exception_codes"].map(lambda v: j(v, []))
    df["qty"] = df["final_qty"].fillna(df["recommended_qty"])
    df["perishable"] = df["perishable"].astype(bool)
    df["gemini"] = df["ai_forecast"].map(lambda v: ", ".join("%.0f" % x for x in j(v, [])) if v else "")
    df["note"] = df.apply(lambda r: r["ai_explanation"] if r["ai_status"] == "OK"
                          else ("AI note unavailable" if r["ai_status"] == "UNAVAILABLE" else ""), axis=1)
    df["check"] = df.apply(lambda r: ("review before approving" if r["review_before_approving"] else ""), axis=1)
    df["disagree"] = df["forecast_disagrees"].map(lambda v: "forecast disagrees with baseline" if v else "")
    return df


def show_table(df, key):
    view = pd.DataFrame({
        "Priority": df["priority"], "SKU": df["sku_id"], "Name": df["sku_name"], "Category": df["category"],
        "Perishable": df["perishable"], "Flags": df["flags_l"].map(", ".join), "Exceptions": df["exc_l"].map(", ".join),
        "Action": df["action"], "Qty": df["qty"], "Weeks of cover": df["cover_weeks"].round(2),
        "Recent vs baseline %": df["recent_vs_baseline_pct"].round(1), "Gemini 4-wk forecast": df["gemini"],
        "Explanation": df["note"], "Flag": (df["check"] + " " + df["disagree"]).str.strip(), "Status": df["status"],
    })
    ev = st.dataframe(view, key=key, hide_index=True, width="stretch", on_select="rerun",
                      selection_mode="multi-row", height=min(80 + 35 * len(view), 600))
    return df.iloc[ev.selection.rows] if ev.selection.rows else df.iloc[0:0]


def action_panel(sel, key):
    if sel.empty:
        st.caption("Select one or more rows above to approve, reject or edit.")
        return
    st.markdown("**%d row(s) selected:** %s" % (len(sel), ", ".join(sel["sku_id"])))
    if len(sel) == 1:
        r = sel.iloc[0]
        with st.expander("Why? (machine-readable reasons, fallbacks, AI)", expanded=True):
            for x in j(r["reasons"], []):
                st.code(json.dumps(x), language="json")
            if j(r["fallbacks"], []):
                st.caption("Fallbacks used on this row: " + ", ".join(j(r["fallbacks"])))
            if r["ai_status"] == "OK":
                st.write(r["ai_explanation"])
                st.caption("Gemini confidence: %s. Statistical baseline: %.0f/week." % (r["ai_confidence"], r["stat_forecast_weekly"]))
                if r["ai_unusual"]:
                    st.write("**What looks unusual:** " + r["ai_unusual"])
                if r["ai_check"]:
                    st.write("**What to check:** " + r["ai_check"])
    pend = sel[(sel["status"] == "PENDING") & ~sel["action"].isin(["EXCEPTION", "NO_ACTION"])]
    if pend.empty:
        st.info("None of the selected rows can be approved (already decided, no rule action, or no action needed).")
        return
    c1, c2, c3 = st.columns(3)
    with c1:
        st.markdown("**Approve**")
        if st.button("Approve %d selected" % len(pend), type="primary", key=key + "_ap"):
            try:
                out = decisions.approve(store, list(pend["rec_id"]), user, client)
                made = [o for o in out if o]
                flash("Approved %d. PO drafts created: %d%s" % (len(out), len(made),
                      "  (kill switch engaged: drafts held back)" if killswitch.is_engaged(store) else ""))
            except decisions.DecisionError as e:
                st.error(str(e))
    with c2:
        st.markdown("**Reject**")
        rc = st.selectbox("Reason code", decisions.REASON_CODES, key=key + "_rc")
        note = st.text_input("Note (optional)", key=key + "_rn")
        if st.button("Reject %d selected" % len(pend), key=key + "_rj"):
            decisions.reject(store, list(pend["rec_id"]), user, rc, note)
            flash("Rejected %d" % len(pend))
    with c3:
        st.markdown("**Edit quantity**")
        if len(pend) == 1:
            r = pend.iloc[0]
            q = st.number_input("New quantity", min_value=0, value=int(r["qty"] or 0), step=10, key=key + "_q")
            ec = st.selectbox("Reason code", decisions.REASON_CODES, key=key + "_ec")
            en = st.text_input("Note (optional)", key=key + "_en")
            if st.button("Save quantity edit", key=key + "_ed"):
                decisions.edit_quantity(store, int(r["rec_id"]), q, user, ec, en)
                flash("Quantity saved. Now approve the row to draft the PO.")
        else:
            st.caption("Select exactly one row to edit its quantity.")


# ---------------------------------------------------------------------------------- pages
if "flash" in st.session_state:
    kind, msg = st.session_state.pop("flash")
    getattr(st, kind)(msg)

if page == "Recommended actions":
    st.header("Recommended actions")
    if run is None:
        st.info("No successful run yet. Use 'Run now' in the sidebar or `make run-pipeline`.")
    else:
        fest = "festival month (+%s%% uplift on cover)" % cfg.rules.festival_uplift_pct if run["festival_active"] else "not a festival month"
        st.caption("As-of %s, last complete week %s, %s. Ranking is by units of shortfall/excess because the data has no unit price."
                   % (run["as_of"], run["last_week"], fest))
        df = load_recs(run["run_id"])
        f1, f2, f3, f4, f5 = st.columns(5)
        flag_sel = f1.multiselect("Flag", ["HIGH_DEMAND", "STOCKOUT_RISK", "OVERSTOCK_RISK"])
        prio_sel = f2.multiselect("Priority", ["P1", "P2", "P3", "EX"], default=["P1", "P2", "EX"])
        per = f3.selectbox("Perishable", ["All", "Perishable only", "Non-perishable only"])
        exc_only = f4.checkbox("Only SKUs with exceptions")
        show_na = f5.checkbox("Show NO_ACTION")
        if not show_na:
            df = df[df["action"] != "NO_ACTION"]
        if prio_sel and not show_na:
            df = df[df["priority"].isin(prio_sel)]
        if flag_sel:
            df = df[df["flags_l"].map(lambda f: any(x in f for x in flag_sel))]
        if per != "All":
            df = df[df["perishable"] == (per == "Perishable only")]
        if exc_only:
            df = df[df["exc_l"].map(len) > 0]
        df = df[df["status"] != "SUPERSEDED"]
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("P1 stockout-risk rows", int((df["priority"] == "P1").sum()))
        m2.metric("Pending", int((df["status"] == "PENDING").sum()))
        m3.metric("Approved / PO drafted", int(df["status"].isin(["APPROVED", "PO_DRAFTED"]).sum()))
        m4.metric("Rejected", int((df["status"] == "REJECTED").sum()))
        sel = show_table(df, "tbl_main")
        action_panel(sel, "main")

elif page == "Exceptions queue":
    st.header("Exceptions queue")
    st.caption("SKUs that need Raghav's judgment. Blocking exceptions have no rule action; others show both and are marked 'review before approving'.")
    if run is None:
        st.info("No successful run yet.")
    else:
        df = load_recs(run["run_id"])
        exc = pd.DataFrame(store.query("SELECT sku_id, code, blocking, detail FROM exceptions WHERE run_id=?", (run["run_id"],)))
        if exc.empty:
            st.success("No exceptions in this run.")
        else:
            code_sel = st.multiselect("Exception code", sorted(exc["code"].unique()))
            if code_sel:
                exc = exc[exc["code"].isin(code_sel)]
            merged = exc.merge(df, on="sku_id", how="left")
            view = pd.DataFrame({
                "SKU": merged["sku_id"], "Name": merged["sku_name"], "Code": merged["code"],
                "Blocks rule action": merged["blocking"].astype(bool), "Detail": merged["detail"],
                "What looks unusual": merged["ai_unusual"].fillna(
                    merged["ai_status"].map(lambda s: "AI note unavailable" if s == "UNAVAILABLE" else "")),
                "What to check": merged["ai_check"].fillna(""), "Rule action": merged["action"],
                "Qty": merged["qty"], "Status": merged["status"],
            })
            ev = st.dataframe(view, key="tbl_exc", hide_index=True, width="stretch", on_select="rerun",
                              selection_mode="multi-row")
            sel = merged.iloc[ev.selection.rows].drop_duplicates("sku_id") if ev.selection.rows else merged.iloc[0:0]
            action_panel(sel, "exc")

elif page == "Status and POs":
    st.header("Status and purchase orders")
    st.caption("Lifecycle: PENDING -> APPROVED -> PO_DRAFTED, or REJECTED. Nothing is ever sent to Zoho automatically.")
    allrecs = pd.DataFrame(store.query("SELECT status, count(*) n FROM recommendations WHERE action NOT IN ('NO_ACTION') GROUP BY status"))
    if not allrecs.empty:
        cols = st.columns(len(allrecs))
        for c, (_, r) in zip(cols, allrecs.iterrows()):
            c.metric(r["status"], int(r["n"]))
    held = store.one("SELECT count(*) n FROM recommendations WHERE status='APPROVED' AND action IN ('REORDER_NOW','REORDER_HIGH_DEMAND')")["n"]
    if held:
        st.warning("%d approved reorder(s) have no PO draft yet%s." % (held, " (kill switch engaged)" if ks["engaged"] else ""))
        if st.button("Create PO drafts for approved rows", disabled=ks["engaged"]):
            made = decisions.create_pending_po_drafts(store, user, client)
            flash("Created %d draft(s)" % len(made))
    life = pd.DataFrame(store.query(
        "SELECT run_id, sku_id, sku_name, action, recommended_qty, final_qty, status, updated_at FROM recommendations "
        "WHERE action NOT IN ('NO_ACTION','EXCEPTION') ORDER BY rec_id DESC LIMIT 500"))
    st.subheader("Every recommendation")
    st.dataframe(life, hide_index=True, width="stretch")
    st.subheader("PO drafts")
    pos = store.query("SELECT po_number, sku_id, quantity, client, status, ts, user, file_path, payload FROM po_drafts ORDER BY id DESC")
    if pos:
        st.dataframe(pd.DataFrame(pos).drop(columns=["payload"]), hide_index=True, width="stretch")
        pick = st.selectbox("View payload", [p["po_number"] for p in pos])
        st.json(j(next(p for p in pos if p["po_number"] == pick)["payload"]))
    else:
        st.caption("No PO drafts yet.")

elif page == "Data quality and runs":
    st.header("Data quality and runs")
    if not runs:
        st.info("No runs yet.")
    else:
        rdf = pd.DataFrame(runs)[["run_id", "started_at", "status", "trigger", "user", "as_of", "last_week",
                                  "duration_seconds", "n_recs", "n_exceptions", "message"]]
        st.dataframe(rdf, hide_index=True, width="stretch")
        pick = st.selectbox("Run detail", [r["run_id"] for r in runs])
        r = next(x for x in runs if x["run_id"] == pick)
        (st.error if r["status"] == "FAILED" else st.info)("Run %s: %s. %s" % (r["run_id"], r["status"], r["message"] or ""))
        fb = j(r["fallbacks"], [])
        if fb:
            st.write("**Fallbacks used:** " + ", ".join(fb))
        dq = pd.DataFrame(store.query("SELECT severity, code, count, detail, sku_id FROM data_quality_issues WHERE run_id=? ORDER BY "
                                      "CASE severity WHEN 'HARD_STOP' THEN 0 WHEN 'SOFT_FIX' THEN 1 WHEN 'FALLBACK' THEN 2 ELSE 3 END", (pick,)))
        st.subheader("Data-quality report")
        st.dataframe(dq, hide_index=True, width="stretch") if not dq.empty else st.caption("No issues recorded.")
        with st.expander("AI calls for this run"):
            ai = store.query("SELECT ts, batch, attempt, model, status, error FROM ai_calls WHERE run_id=?", (pick,))
            st.dataframe(pd.DataFrame(ai), hide_index=True) if ai else st.caption("No AI calls (rules-only run or no key).")
    with st.expander("Audit log (latest 200)"):
        st.dataframe(pd.DataFrame(store.query("SELECT ts, user, event_type, entity_type, entity_id, run_id, details FROM audit_log "
                                              "ORDER BY id DESC LIMIT 200")), hide_index=True, width="stretch")

elif page == "Impact":
    st.header("Impact: what the system can measure")
    base = cfg.app["baseline_case"]
    a, b = st.columns(2)
    with a:
        st.subheader("Baseline from the case")
        st.metric("Planning errors (stockouts + overstock)", "Rs %s lakh / quarter" % base["planning_error_cost_lakhs_per_quarter"])
        st.metric("Forecast cycle", "Monthly")
        st.caption(base["forecast_cycle"])
        st.metric("Manual data prep", "~%s days / month" % base["manual_prep_days_per_month"])
    with b:
        st.subheader("Measured by this system")
        if run:
            ok_runs = [r for r in good if r["duration_seconds"] is not None]
            st.metric("Cycle time (latest run)", "%.1f s" % run["duration_seconds"])
            st.metric("Forecast data age at run", "%s days (sales), %s days (inventory)" % (run["sales_age_days"], run["inventory_age_days"]))
            p1 = store.one("SELECT count(*) n FROM recommendations WHERE run_id=? AND priority='P1'", (run["run_id"],))["n"]
            st.metric("P1 stockout-risk flags (latest run)", p1)
            st.caption("Run cadence: twice a week (%s) versus monthly." % cfg.app["schedule"]["day_of_week"])
        else:
            st.info("No successful run yet.")
    st.subheader("Human decisions")
    d = pd.DataFrame(store.query("SELECT decision, reason_code FROM decisions"))
    if d.empty:
        st.caption("No decisions recorded yet.")
    else:
        n_ap, n_rj, n_ed = (int((d["decision"] == x).sum()) for x in ("APPROVE", "REJECT", "EDIT"))
        decided = n_ap + n_rj
        c1, c2, c3 = st.columns(3)
        c1.metric("Approval rate", "%.0f%%" % (100 * n_ap / decided) if decided else "n/a", "%d approved / %d rejected" % (n_ap, n_rj))
        c2.metric("Override rate", "%.0f%%" % (100 * (n_rj + n_ed) / max(decided, 1)), "%d rejects + %d quantity edits" % (n_rj, n_ed))
        c3.metric("Decisions logged", len(d))
        reasons = d[d["reason_code"].notna()]["reason_code"].value_counts()
        if not reasons.empty:
            st.write("Override reasons (the training data for the next phase):")
            st.bar_chart(reasons)
    st.caption("No savings figure is shown: the data has no prices or outcomes to measure one honestly.")
