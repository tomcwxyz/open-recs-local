# Running locally

This guide covers the supported local topologies and keeps native and container networking separate.

For the ingest reliability roadmap see [`docs/plans/2026-09-13-local-ingest-reliability-roadmap.md`](plans/2026-09-13-local-ingest-reliability-roadmap.md).

## What is being optimised for

The primary local target is a 16 GB Apple Silicon Mac mini. The app should remain useful without cloud dependencies, but local inference has different constraints from a hosted API: peak memory, model queueing and long-context generation matter more than shaving a few seconds off concurrent requests.

The pipeline is:

```text
upload -> parse -> find recommendation candidates -> enrich -> embed -> ready
```

For newly parsed real PDFs the extraction stage is page-aware. Recommendation detection uses bounded overlapping page windows with explicit `[PAGE N]` markers, deduplicates candidates, then classifies/tag them separately. This avoids the previous first-30k-character fallback and keeps the taxonomy schema out of the most recall-sensitive model calls.

For native local PDF parsing, the recommended baseline is now **text layer first, OCR when needed**:

```text
PDF
  -> pdftotext (Poppler), page by page
  -> if every page has useful text: continue immediately
  -> if pages are sparse/scanned: OCRmyPDF --skip-text (Tesseract)
  -> pdftotext again
  -> page-aware extraction
```

Docling remains available as an explicit alternative when its richer layout behaviour is useful. The current Docling adapter still disables Docling image OCR and table-structure extraction because both caused worker-pool instability on real mixed-layout/long PDFs; it should not be treated as the default scanned-PDF OCR path.

---

## Prerequisites

- Docker Desktop on macOS/Windows, or Docker Engine 24+ on Linux.
- Node 20+ and pnpm 10.x.
- Ollama for local LLM/embedding inference.
- Enough disk for Postgres, local models and temporary OCR files.

Clone and install:

```bash
git clone https://github.com/tomcwxyz/open-recs-local.git
cd open-recs-local
pnpm install
cp .env.example .env
```

The default provider selection uses fake AI/parser providers, which is useful for UI and queue development but does not test real document extraction.

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

## 2. Install the native PDF parser/OCR tools

On macOS:

```bash
brew install poppler ocrmypdf
```

The `tesseract-pdf` provider expects these commands on `PATH`:

```bash
pdftotext -v
ocrmypdf --version
tesseract --version
```

`pdftotext` handles ordinary born-digital PDFs without invoking OCR. If any extracted page is effectively blank/sparse, the provider runs OCRmyPDF with `--skip-text`; pages with existing text are preserved and pages without useful text are OCRed by Tesseract. Temporary input/output PDFs are deleted after each parse, including failure paths.

Configure:

```env
OCR_PROVIDER=tesseract-pdf
```

At present this provider is intended for the **native worker** topology. The project Docker image is Alpine-based and does not yet bundle Poppler/OCRmyPDF/Tesseract, so do not select `tesseract-pdf` inside the containerised worker unless you build an image that installs those tools.

## 3. Start Ollama

```bash
brew install ollama
ollama serve
```

In another terminal, install models. The historical extraction baseline is Llama 3.1 8B and the embedding baseline is `nomic-embed-text`:

```bash
ollama pull llama3.1:8b
ollama pull nomic-embed-text
ollama pull qwen2.5:0.5b
```

The current extractor uses bounded page windows, but dense tables can still tokenise much more heavily than prose. If you use Llama 3.1, keep the existing 12k extraction profile:

```bash
ollama create llama3.1-extract -f - <<'EOF'
FROM llama3.1:8b
PARAMETER num_ctx 12288
EOF
```

For a 16 GB machine, prefer one heavyweight generation at a time:

```bash
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_FLASH_ATTENTION=1 \
ollama serve
```

`OLLAMA_KV_CACHE_TYPE=q8_0` is worth benchmarking if context memory remains the bottleneck, but it is not required by the application.

Model defaults are being benchmarked separately. Do not treat Llama 3.1 8B as a permanent architectural dependency.

## 4. Configure native providers

Use localhost addresses because the app and worker are running on the host:

```env
APP_MODE=local
DATABASE_URL=postgres://postgres:postgres@localhost:5434/openrecs

OCR_PROVIDER=tesseract-pdf

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

Structured extraction defaults to temperature `0`. In local mode metadata, recommendation windows and enrichment batches are run sequentially so queued Ollama requests do not compete for the same 16 GB memory budget. Each structured attempt has its own bounded timeout; a failed schema-mode request no longer consumes the deadline of its JSON fallback.

## 5. Optional Docling sidecar

Start Docling only, without starting a second copy of the app/worker:

```bash
docker compose -f docker-compose.yml -f docker-compose.docling.yml up -d postgres docling
```

Then point the native worker at its published host port:

```env
OCR_PROVIDER=docling
DOCLING_BASE_URL=http://localhost:5001
```

Current Docling behaviour:

- long PDFs are requested in 50-page chunks;
- each chunk has a five-minute HTTP deadline;
- `do_ocr=false`;
- `do_table_structure=false`;
- images are placeholders rather than embedded base64 blobs.

This is intentionally conservative after real mixed-layout PDFs crashed the Docling worker pool. Born-digital PDFs with a useful text layer are the best fit for this profile. Use `tesseract-pdf` for a predictable scanned/mixed-document fallback on the native Mac worker.

## 6. Run app and worker

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

For a fully containerised real-parser setup today, use the Docling override:

```bash
docker compose -f docker-compose.yml -f docker-compose.docling.yml up -d --build
```

It sets:

```text
OCR_PROVIDER=docling
DOCLING_BASE_URL=http://docling:5001
```

The base app/worker image does **not** currently contain the native `tesseract-pdf` command-line dependencies. Packaging those into a portable worker image is a separate deployment task; it should not block the native Mac mini path.

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

The fixture-backed pipeline is deterministic. It proves queue/persistence/UI wiring; it does **not** prove Poppler/OCRmyPDF/Docling/Ollama work on real reports.

---

# Provider checks

The admin provider settings surface runs lightweight connection probes. Interpret them correctly:

- an LLM probe proves the endpoint can answer a tiny generation request, not that it can reliably return the full recommendation schemas;
- an embedding probe reports the returned vector dimension;
- the Docling probe checks `/health` only;
- the `tesseract-pdf` provider is exercised by parsing a PDF, not by a remote health endpoint.

These probes are not substitutes for a real PDF -> parser -> candidate extraction -> enrichment -> embedding smoke test. A real-provider benchmark/smoke profile remains part of the reliability roadmap.

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

The compose file enforces the container path.

## Upload row appears but live progress looks stuck

Pipeline events are keyed by `sourceId`, because parse/extract/embed are separate pg-boss jobs. The UI should subscribe to `/api/jobs/{sourceId}/stream`. Older builds incorrectly subscribed using only the first queue job id.

## `tesseract-pdf` fails during parsing

Check the command-line dependencies from the **same shell/environment that launches the worker**:

```bash
which pdftotext
which ocrmypdf
which tesseract
pdftotext -v
ocrmypdf --version
```

Typical failure classes are a missing command on `PATH`, malformed/encrypted PDF, an OCRmyPDF/Tesseract failure, or a command exceeding the 15-minute per-command deadline. The worker error should identify which command failed.

A born-digital PDF should normally run `pdftotext` only. A mixed/scanned PDF should run `pdftotext`, then OCRmyPDF, then `pdftotext` on the repaired/OCRed output.

## Docling source fails during parsing

Current Docling failure classes include:

- service unreachable;
- per-chunk timeout;
- worker-pool crash / truncated response;
- unsupported/malformed PDF;
- page-range conversion failure.

The conservative adapter chunks long PDFs and disables Docling OCR/table structure for stability. If the PDF is scanned with no useful text layer, use `tesseract-pdf` in the native topology rather than expecting this Docling profile to recover it.

## Source fails during extraction

Check:

- the configured model exists in Ollama;
- the worker can reach `LLM_BASE_URL`;
- the model context can accommodate a ~12k-character page window plus prompt/output;
- `LLM_TIMEOUT_MS` is appropriate for the machine/model;
- Ollama is not servicing multiple heavyweight requests concurrently.

The real path now reports progress separately for recommendation-window scanning and classification batches. A failure message should therefore make it much clearer which phase failed.

## Source fails during embedding

The database schema currently expects 768-dimensional vectors. `nomic-embed-text` is the tested local option. The adapter truncates page text before embedding to avoid local model context overflows on dense markdown tables.

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

Remember that the standard local E2E uses fake parser/LLM/embedding providers for the ingest portion. It is deliberately a queue/persistence/UI test, not a real local-model benchmark.

The next acceptance layer is a real-provider smoke/benchmark corpus containing at least:

- an ordinary born-digital report;
- a long report with recommendations near the end;
- a scanned PDF;
- a multi-column report;
- a table-heavy report.

Record parse quality, expected recommendation recall, page provenance, schema-valid rate, stage timings and failure mode rather than treating “job reached ready” as sufficient.

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

The local-ingest work does not change the one-codebase principle. Parser, model and storage choices remain provider concerns rather than separate application forks.
