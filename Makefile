.PHONY: backend-install backend-train backend-export-static backend-test backend-run frontend-install frontend-build frontend-run frontend-test test

backend-install:
	cd backend && python3 -m pip install -r requirements-dev.txt

backend-train:
	cd backend && python3 -m app.ml.train

backend-export-static:
	cd backend && python3 -m app.ml.export_static_recommendations

backend-test:
	cd backend && python3 -m pytest

backend-run:
	cd backend && python3 -m uvicorn app.main:app --reload --port 8000

frontend-install:
	cd frontend && npm install

frontend-build:
	cd frontend && npm run build

frontend-run:
	cd frontend && npm run dev

frontend-test:
	cd frontend && npm run test:e2e

test: backend-install backend-train backend-export-static backend-test frontend-install frontend-build frontend-test
