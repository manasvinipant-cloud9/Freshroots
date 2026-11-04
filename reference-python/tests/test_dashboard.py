from streamlit.testing.v1 import AppTest

from freshroots import decisions, po
from freshroots.pipeline import run_pipeline
from freshroots.store import Store

APP = "src/freshroots/dashboard/app.py"


def test_dashboard_renders_all_pages(cfg, monkeypatch):
    monkeypatch.setenv("FRESHROOTS_DB", str(cfg.db_path))
    store = Store(cfg.db_path)
    rid = run_pipeline(cfg, store, use_ai=False)["run_id"]
    rec = [r for r in store.recommendations(rid) if r["sku_id"] == "SKU001"][0]
    decisions.approve(store, [rec["rec_id"]], "raghav", po.DryRunZohoClient(cfg.po_drafts_dir))
    at = AppTest.from_file(APP, default_timeout=60).run()
    assert not at.exception
    for page in ["Recommended actions", "Exceptions queue", "Status and POs", "Data quality and runs", "Impact"]:
        at.sidebar.radio[0].set_value(page).run()
        assert not at.exception, page
    assert any("Kill switch" in s.value or "KILL SWITCH" in s.value for s in list(at.success) + list(at.error))


def test_dashboard_empty_db(cfg, monkeypatch):
    monkeypatch.setenv("FRESHROOTS_DB", str(cfg.db_path))
    at = AppTest.from_file(APP, default_timeout=60).run()
    assert not at.exception
