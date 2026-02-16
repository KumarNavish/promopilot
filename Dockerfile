FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim AS backend-runtime
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV APP_ENV=prod
ENV ARTIFACT_DIR=/app/artifacts
WORKDIR /app

COPY backend/requirements.txt backend/requirements-dev.txt ./backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
COPY backend/app ./app
RUN python -m app.ml.train --artifact-dir /app/artifacts --rows 60000 --seed 7 --artifact-version 2026-02-16

COPY --from=frontend-builder /build/frontend/dist /app/app/static

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
