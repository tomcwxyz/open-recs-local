# Running locally

This guide covers the supported local topologies and, importantly, keeps native and container networking separate.

For the ingest reliability roadmap see [`docs/plans/2026-09-13-local-ingest-reliability-roadmap.md`](plans/2026-09-13-local-ingest-reliability-roadmap.md).

## What is being optimised for

The primary local target is a 16 GB Apple Silicon Mac mini. The app should remain usable without cloud dependencies, but local inference has different constraints from a hosted API: peak memory, model queueing and long-context generation matter more than shaving a few seconds off concurrent requests.

The current production pipeline is still:

```text
upload -> parse -> extract -> embed -> ready
```

The September 2026 roadmap is moving parsing towards a text-layer-first, OCR-when-needed approach. Until that lands, Docling remains the main real local parser. Note that the current Docling adapter deliberately disables Docling image OCR and table-structure extraction because both caused worker-pool instability on real mixed-layout/long PDFs. It is therefore best thought of as a PDF text/layout parser in the current release, not a guaranteed scanned-PDF OCR path.

---

## Prerequisites

- Docker Desktop on macOS/Windows, or Docker Engine 24+ on Linux.
- Node 20+ and pnpm 10.x.
- Ollama for local LLM/embedding inference.
- Enough disk for Postgres, optional Docling and local models.

Clone and install:

```bash
git clone https://github.com/tomcwxyz/open-recs-local.git
cd open-recs-local
pnpm install
cp .env.example .env
```

The default provider selection uses fake AI/OCR providers, which is useful for UI and queue development but does not test real document extraction.

---

# Topology A — native app + worker, Docker Postgres

This is the recommended development setup on a Mac mini. Next.js and the worker run directly on macOS, Ollama runs directly on macOS, and only Postgres (plus optional Docling) uses Docker.

## 1. Start Postgres

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
```

The bundled Postgres maps to host port `5434`, so the native connection string is:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5434/openrecs
```

## 2. Start Ollama

```bash
brew install ollama
ollama serve
```

In another terminal, install models. The historical default is Llama 3.1 8B for extraction and `nomic-embed-text` for embeddings:

```bash
ollama pull llama3.1:8b
ollama pull nomic-embed-text
ollama pull qwen2.5:0.5b
```

The current extractor can require more than the stock 4k context. If you use Llama 3.1, create the existing 12k profile:

```bash
ollama create llama3.1-extract -f - <<'EOF'
FROM llama3.1:8b
PARAMETER num_ctx 12288
EOF
```

For a 16 GB machine, prefer a single heavyweight generation at a time. A useful Ollama launch profile is:

```bash
OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 ollama serve
```

Model defaults are being re-benchmarked as part of the local-ingest roadmap; do not treat Llama 3.1 8B as a permanent architectural dependency.

## 3. Configure native providers

Use localhost addresses because the app and worker are running on the host:

```env
APP_MODE=local
DATABASE_URL=postgres://postgres:postgres@localhost:5434/openrecs

LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.1-extract
LLM_TIMEOUT_MS=180000

CHAT_PROVIDER=openai-compatible
CHAT_BASE_URL=http://localhost:11434/v1
CHAT_MODEL=qwen2.5:0.5b

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_MODEL=nomic-embed-text

STORAGE_PROVIDER=fs
STORAGE_FS_PATH=./.data/uploads
```

## 4. Optional Docling sidecar

Start Docling only, without starting a second copy of the app/worker:

```bash
docker compose -f docker-compose.yml -f docker-compose.docling.yml up -d postgres docling
```

Then configure the native worker to reach its published host port:

```env
OCR_PROVIDER=docling
DOCLING_BASE_URL=http://localhost:5001
```

Current behaviour: `do_ocr=false` and `do_table_structure=false` are sent by the adapter for reliability. Born-digital PDFs with a usable text layer work best. The adaptive Tesseract/OCRmyPDF fallback described in the roadmap is not implemented yet.

Without Docling, leave `OCR_PROVIDER=fake` only for deterministic development/tests; real PDF ingest requires a real parsing provider.

## 5. Run app and worker

Use two terminals:

```bash
pnpm dev
```

```bash
pnpm worker:dev
```

Both processes resolve `./.data/uploads` from the same repository working directory, so filesystem storage is shared.

---

# Topology B — containerised app + worker + Postgres

Use this when you want the runtime to match Docker deployment more closely.

```bash
docker compose up -d --build
```

`docker-compose.yml` deliberately overrides two host-oriented settings inside app/worker containers:

```text
DATABASE_URL     -> postgresql://postgres:postgres@postgres:5432/openrecs
STORAGE_FS_PATH  -> /data/uploads
```

Both app and worker mount the same `uploads` named volume at `/data/uploads`. Do not replace that with `./.data/uploads` inside the containers: relative paths would resolve independently in each container and the worker would not see files written by the app.

When Ollama is running on the Mac host, containerised services should use Docker Desktop's host bridge:

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.1-extract

CHAT_PROVIDER=openai-compatible
CHAT_BASE_URL=http://host.docker.internal:11434/v1
CHAT_MODEL=qwen2.5:0.5b

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL=nomic-embed-text
```

To add the Docling sidecar:

```bash
docker compose -f docker-compose.yml -f docker-compose.docling.yml up -d --build
```

The override sets:

```text
OCR_PROVIDER=docling
DOCLING_BASE_URL=http://docling:5001
```

Do **not** also run `pnpm dev` on port 3000 unless you intentionally want a second app process.

---

# Fake-provider development

For UI, repository and queue work where real extraction quality is irrelevant:

```env
LLM_PROVIDER=fake
EMBEDDING_PROVIDER=fake
OCR_PROVIDER=fake
STORAGE_PROVIDER=fs
STORAGE_FS_PATH=./.data/uploads
```

Then:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed
pnpm worker:dev
pnpm dev
```

The fixture-backed pipeline is deterministic. It proves queue/persistence/UI wiring; it does **not** prove Docling/Ollama work on real reports.

---

# Provider checks

The admin provider settings surface can run lightweight connection probes. Interpret them correctly:

- LLM probe proves the model endpoint can answer a tiny generation request;
- embedding probe reports the returned vector dimension;
- Docling probe checks `/health` only.

Those probes are not substitutes for a real PDF -> parser -> structured extraction -> embedding smoke test. A real-provider smoke profile is part of the reliability roadmap.

---

# Troubleshooting the ingest pipeline

## Upload succeeds but parse immediately fails with `fs storage: key not found`

Check whether app and worker share the same storage path.

Native processes should both use:

```env
STORAGE_FS_PATH=./.data/uploads
```

Containerised app/worker should both show:

```text
STORAGE_FS_PATH=/data/uploads
```

The compose file now enforces the container path.

## Upload row appears but live progress looks stuck

Pipeline events are keyed by `sourceId`, because parse/extract/embed are separate pg-boss jobs. The UI should subscribe to `/api/jobs/{sourceId}/stream`. Older builds incorrectly subscribed using only the first queue job id.

## Source fails during parsing

Inspect worker logs first. Current Docling failure classes include:

- service unreachable;
- worker-pool crash / truncated response;
- unsupported/malformed PDF;
- page-range conversion failure.

The current adapter chunks long PDFs at 50 pages and disables OCR/table structure because those settings were observed to improve stability. If the PDF is scanned with no useful text layer, the present Docling profile may not be sufficient.

## Source fails during extraction

Check:

- the configured model exists in Ollama;
- the worker can reach `LLM_BASE_URL`;
- context is sufficient for the current extraction prompt;
- timeout is long enough for local inference;
- Ollama is not trying to service multiple heavyweight requests concurrently.

The September reliability work is changing local mode to favour sequential extraction and then replacing long full-document prompts with small page-aware windows.

## Source fails during embedding

The database schema currently expects 768-dimensional vectors. `nomic-embed-text` is the tested local option. The adapter also truncates page text before embedding to avoid local model context overflows on dense markdown tables.

---

# Verification

After code changes:

```bash
pnpm verify
```

For deterministic local browser coverage:

```bash
pnpm test:e2e:local
```

Remember that the standard local E2E uses fake parser/LLM/embedding providers for the ingest portion. Real-provider smoke tests are intentionally being added as a separate profile so failures in external local runtimes are visible rather than hidden behind fixtures.

---

# Hosted mode

Hosted mode uses the same schema and pipeline but adds Better Auth, provider configuration, ownership/access controls and email delivery.

Minimum hosted configuration includes:

```env
APP_MODE=hosted
BETTER_AUTH_SECRET=<32+ random chars>
BETTER_AUTH_URL=https://your.app.example
FILE_TOKEN_SECRET=<32+ random chars>
PROVIDER_SECRET_KEY=<32+ random chars>

EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
RESEND_FROM=noreply@your.domain
```

The local-ingest roadmap does not change the one-codebase principle. Parser, model and storage choices remain provider concerns rather than separate application forks.
