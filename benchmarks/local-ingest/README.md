# Local ingest benchmark

This directory contains the repeatable Tranche 4 benchmark for the real local ingest path.

The checked-in `corpus.fixture.json` is only a sanity fixture. Real/client PDFs and their hand-labelled gold recommendations should live in a local manifest that is ignored by git.

## What the benchmark measures

For each case and model it records:

- parser page count, OCR fallback, sparse pages and phrases recovered;
- recommendation recall, precision/false positives and F1 against the gold set;
- page-anchor accuracy;
- logical structured-output call validity and timeout failures;
- wall-clock time for parse, metadata, candidate extraction, enrichment and embeddings;
- approximate peak RSS for the benchmark Node process and Ollama processes;
- total time for the direct parse -> extract -> embed path.

The RSS figures are useful comparison signals on the target Mac, not whole-system memory accounting. They deliberately do not claim to capture every transient Poppler/Tesseract child process.

## Install local parser dependencies

macOS:

```bash
brew install poppler ocrmypdf
pdftotext -v
ocrmypdf --version
tesseract --version
```

Ollama should be started with the low-contention profile used by the roadmap:

```bash
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_FLASH_ATTENTION=1 \
ollama serve
```

## 1. Real parser smoke

Born-digital sanity check:

```bash
pnpm smoke:parser:real
```

For a scanned PDF, require that the adaptive OCR path actually ran:

```bash
pnpm smoke:parser:real -- --pdf /path/to/scanned-report.pdf --expect "known phrase" --require-ocr
```

## 2. Real structured-output probe

Use the same candidate schema and prompt as extraction:

```bash
pnpm smoke:ollama:real -- --model llama3.1:8b
```

The command fails if the model cannot produce a valid recommendation object with the explicit page provenance.

## 3. Corpus benchmark

Set an embedding model that returns 768-dimensional vectors, matching the database schema:

```bash
export BENCHMARK_EMBEDDING_MODEL=nomic-embed-text
```

Run one model:

```bash
pnpm benchmark:local-ingest -- --model llama3.1:8b
```

Run several models sequentially:

```bash
pnpm benchmark:local-ingest -- \
  --models llama3.1:8b,qwen3.5:4b,qwen3.5:9b \
  --manifest benchmarks/local-ingest/corpus.local.json
```

Useful tuning flags:

```text
--case case-a,case-b
--window-pages 6
--window-chars 12000
--overlap-pages 1
--timeout-ms 120000
--match-threshold 0.46
--embedding-model <model>
--embedding-base-url http://localhost:11434/v1
--skip-embeddings
--output benchmarks/local-ingest/results/my-run.json
```

Results are written under `benchmarks/local-ingest/results/` by default and are ignored by git.

## 4. Full local-stack smoke

This is the release-oriented check. It starts a disposable pgvector Postgres container and temporary filesystem storage, then runs the actual parse, extract and embed handlers with the real configured providers. The database and files are destroyed afterwards.

Example:

```bash
LLM_PROVIDER=openai-compatible \
LLM_BASE_URL=http://localhost:11434/v1 \
LLM_MODEL=llama3.1:8b \
EMBEDDING_PROVIDER=openai-compatible \
EMBEDDING_BASE_URL=http://localhost:11434/v1 \
EMBEDDING_MODEL=nomic-embed-text \
OCR_PROVIDER=tesseract-pdf \
pnpm smoke:local-stack:real
```

You can override the main inputs without editing `.env`:

```bash
pnpm smoke:local-stack:real -- \
  --pdf /path/to/report.pdf \
  --model llama3.1:8b \
  --base-url http://localhost:11434/v1 \
  --embedding-model nomic-embed-text \
  --embedding-base-url http://localhost:11434/v1
```

This deliberately bypasses pg-boss scheduling and invokes the real handlers directly. Existing local/hosted E2E covers queue plumbing; this command isolates the expensive real parser/LLM/embedding path while still proving the source reaches `ready` in the real schema.

## Building the real corpus

Create `benchmarks/local-ingest/corpus.local.json`. It is ignored by git. PDF paths are resolved relative to the manifest.

Aim for at least one case in every roadmap category:

- `short-born-digital`
- `long-born-digital`
- `scanned`
- `multi-column`
- `table-heavy`
- `no-recommendations`
- `implicit-scattered`

Example entry:

```json
{
  "id": "long-report-late-recs",
  "label": "Long report with recommendations near the end",
  "pdf": "private/long-report.pdf",
  "category": "long-born-digital",
  "expected_phrases": ["a phrase from a late page"],
  "gold": [
    {
      "id": "rec-1",
      "title": "Hand-labelled recommendation title",
      "body": "Enough canonical wording to make lexical matching robust.",
      "page_start": 118,
      "page_end": 119
    }
  ]
}
```

Gold bodies are optional; titles are required. The scorer uses deterministic token overlap rather than another model, so changing the model under test cannot silently change the judge.
