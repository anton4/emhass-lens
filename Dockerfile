# EMHASS Lens: one image with the FastAPI backend and the built React UI.
# Built per architecture by .github/workflows/addon-image.yml (context: repo root), or by the
# Supervisor from the folder that scripts/make-local-addon.sh assembles.

# --- Stage 1: build the UI ---------------------------------------------------------------------
FROM node:26-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Version shown in the UI header (after npm ci, so a new version keeps the dependency layer cached)
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}
RUN npm run build

# --- Stage 2: backend + built UI ------------------------------------------------------------------
FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.21 /uv /bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:${PATH}"
WORKDIR /app

# Dependencies first (cached until uv.lock changes), then the App itself
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/emhass_lens ./emhass_lens
RUN uv sync --frozen --no-dev

COPY --from=ui /ui/dist ./static

# Declared last, so a new version doesn't invalidate the cached layers above
ARG BUILD_VERSION=dev
ENV EMHASS_LENS_VERSION=${BUILD_VERSION} \
    EMHASS_LENS_STATIC_DIR=/app/static

EXPOSE 8099
CMD ["python", "-m", "emhass_lens"]
