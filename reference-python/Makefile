PY := .venv/bin/python
PIP := .venv/bin/pip

.PHONY: setup test run-pipeline run-pipeline-ai dashboard scale-data run-scale schedule

setup:
	python3 -m venv .venv
	$(PIP) install -q --upgrade pip
	$(PIP) install -q -r requirements.txt
	$(PIP) install -q -e .
	@test -f .env || cp .env.example .env
	@echo "Setup done. Put GEMINI_API_KEY in .env to enable AI notes."

test:
	$(PY) -m pytest -q

# Seed data, rules only (reproduces the RUBRIC 10b golden table)
run-pipeline:
	$(PY) -m freshroots run --no-ai

# Seed data with Gemini (needs GEMINI_API_KEY)
run-pipeline-ai:
	$(PY) -m freshroots run

dashboard:
	.venv/bin/streamlit run src/freshroots/dashboard/app.py

scale-data:
	$(PY) scripts/generate_scale_data.py --out data_scale

run-scale: scale-data
	$(PY) -m freshroots --db out/scale.db run --no-ai --data-dir data_scale

schedule:
	$(PY) -m freshroots schedule
