# EdgeAlign-DR

EdgeAlign-DR is a production-style interactive demo for **multi-level counterfactual policy optimization** on on-device AI guardrails.

## What it demonstrates

- Multi-level treatments over guardrail policy levels `{0,1,2,3,4}`
- Naive logged-outcome policy vs doubly robust (AIPW) policy
- Confounded synthetic logs where risky prompts are non-randomly assigned stricter policies
- Fast API inference from precomputed artifacts
- Minimal decision UI with one recommendation line, three KPI numbers, and one export action

## Monorepo layout

- `/Users/kumar0002/Documents/New project/promopilot/backend`: FastAPI app + synthetic data + training + tests
- `/Users/kumar0002/Documents/New project/promopilot/frontend`: Vite + React + TypeScript UI + Playwright e2e
- `/Users/kumar0002/Documents/New project/promopilot/Dockerfile`, `/Users/kumar0002/Documents/New project/promopilot/docker-compose.yml`: single-container deployment
- `/Users/kumar0002/Documents/New project/promopilot/.github/workflows/pages.yml`: static GitHub Pages deployment

## Local development

### Backend

```bash
cd /Users/kumar0002/Documents/New project/promopilot/backend
python3 -m pip install -r requirements-dev.txt
python3 -m app.ml.train
python3 -m app.ml.export_static_recommendations
python3 -m uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd /Users/kumar0002/Documents/New project/promopilot/frontend
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

```bash
cd /Users/kumar0002/Documents/New project/promopilot
make test
```

This runs backend unit tests, static bundle export, frontend build, and frontend e2e.

## Production-style container

```bash
cd /Users/kumar0002/Documents/New project/promopilot
docker compose up --build
```

App serves at [http://localhost:8080](http://localhost:8080).
