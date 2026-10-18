# EdgeAlign-DR

EdgeAlign-DR is a production-style interactive demo for **multi-level counterfactual policy optimization** on on-device AI guardrails.

## What it demonstrates

- Multi-level treatments over guardrail policy levels `{0,1,2,3,4}`
- Naive logged-outcome policy vs doubly robust (AIPW) policy
- Confounded synthetic logs where risky prompts are non-randomly assigned stricter policies
- Fast API inference from precomputed artifacts
- Minimal decision UI with one recommendation line, three KPI numbers, and one export action

## Monorepo layout

- `backend`: FastAPI app + synthetic data + training + tests
- `frontend`: Vite + React + TypeScript UI + Playwright e2e
- `Dockerfile`, `docker-compose.yml`: single-container deployment
- `.github/workflows/pages.yml`: static GitHub Pages deployment

## Local development

Run each command block from the repository root in a separate terminal.

### Backend

```bash
cd backend
python3 -m pip install -r requirements-dev.txt
python3 -m app.ml.train
python3 -m app.ml.export_static_recommendations
python3 -m uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend proxies `/api` to `http://localhost:8000`.

## API

- `GET /healthz`
- `GET /api/v1/metadata`
- `POST /api/v1/recommend`

Example request:

```json
{
  "objective": "task_success",
  "max_policy_level": 3,
  "segment_by": "prompt_risk",
  "method": "dr"
}
```

## Build and test

From the repository root:

```bash
make test
```

This installs dependencies, trains the synthetic model, exports the static bundle,
runs backend unit tests, builds the frontend, and runs frontend e2e checks.
For a focused regression, use the corresponding target in `Makefile`.

## Production-style container

From the repository root:

```bash
docker compose up --build
```

App serves at [http://localhost:8080](http://localhost:8080).
