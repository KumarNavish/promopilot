# PromoPilot

PromoPilot is a production-oriented interactive demo for counterfactual discount optimization with multi-level treatments.

## What it demonstrates

- Multi-level treatment policy optimization over discount levels `{0, 5, 10, 15, 20}`
- Naive observed-outcome policy vs doubly robust (AIPW) counterfactual policy
- Segment-level recommendations with dose-response visualization
- Fast API inference from precomputed artifacts

## Monorepo layout

- `backend/`: FastAPI app + synthetic data generator + training pipeline + tests
- `frontend/`: Vite + React + TypeScript single-page demo + Playwright e2e
- `Dockerfile` / `docker-compose.yml`: single-container deployment
- `.github/workflows/pages.yml`: GitHub Pages deployment (static frontend mode)

## Local development

### Backend

```bash
cd /Users/kumar0002/Documents/New project/promopilot/backend
python3 -m pip install -r requirements-dev.txt
python3 -m app.ml.train
python3 -m uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd /Users/kumar0002/Documents/New project/promopilot/frontend
npm install
npm run dev
```

Frontend dev server proxies `/api` to `http://localhost:8000`.

## GitHub Pages deployment

This repo includes a static fallback bundle so the demo can run on GitHub Pages without a backend server.

- Static bundle generator: `python3 -m app.ml.export_static_recommendations`
- Workflow: `.github/workflows/pages.yml`
- Expected URL format: `https://<github-user>.github.io/<repo-name>/`

Once pushed to the `main` branch, GitHub Actions will build and deploy the frontend to Pages.

## Production-style container

```bash
cd /Users/kumar0002/Documents/New project/promopilot
docker compose up --build
```

App is served at [http://localhost:8080](http://localhost:8080).

## Testing

```bash
cd /Users/kumar0002/Documents/New project/promopilot
make test
```

This runs:
- backend unit tests (`pytest`)
- static recommendation bundle export for Pages
- frontend e2e (`playwright`)

## API summary

- `GET /healthz`
- `GET /api/v1/metadata`
- `POST /api/v1/recommend`

`POST /api/v1/recommend` request body:

```json
{
  "objective": "bookings",
  "max_discount_pct": 15,
  "segment_by": "loyalty_tier",
  "method": "dr"
}
```
