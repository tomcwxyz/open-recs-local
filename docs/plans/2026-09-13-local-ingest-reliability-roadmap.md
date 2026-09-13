# Local ingest reliability roadmap

> Date: 2026-09-13  
> Status: active  
> Primary target: reliable end-to-end ingest on a 16 GB Apple Silicon Mac mini

## Why this exists

The application architecture is sound, but the local ingest path has accumulated several workarounds that make the real workflow less reliable than the fake-provider test suite suggests. The current local path can fail for reasons that have nothing to do with recommendation quality: app/worker storage visibility, progress-channel wiring, Docling worker instability, long-context structured generation, and local model contention.

This roadmap treats local ingest as a system rather than a model-selection problem.

The target is a boring, inspectable pipeline where each stage can be retried independently and where failures are obvious:

```text
PDF
  -> text-layer extraction
  -> OCR only where needed
  -> page-aware canonical document
  -> recommendation candidate extraction in small windows
  -> metadata/taxonomy enrichment
  -> recommendation persistence
  -> embeddings
  -> ready
```

Docling remains available for documents where layout fidelity is worth the extra cost, but should not be the compulsory first step for every PDF.

## Guiding principles

1. **Prefer the cheapest deterministic operation first.** Use the PDF text layer before OCR, and OCR only pages that need it.
2. **Preserve provenance from the start.** Page numbers must survive parsing and be supplied explicitly to extraction rather than inferred later.
3. **Optimise for peak memory, not only wall-clock time.** Local Apple Silicon should favour sequential heavyweight work over parallel model calls.
4. **Keep stages independently observable and retryable.** A failed extraction should not require re-running OCR; a failed embedding job should not re-run extraction.
5. **Treat models as providers, not architecture.** Model benchmarking should happen after pipeline correctness and observability are fixed.
6. **Test the real local stack.** Fake-provider E2E remains useful, but a separate real-provider smoke/benchmark suite is required.
7. **Do not re-architect the rest of the application.** Keep Postgres, pg-boss, provider interfaces, canonical markdown/pages, repository layer and search architecture.

---

## Phase A — deterministic reliability fixes

These are release blockers because they can make a healthy pipeline appear broken or can stop it before OCR/LLM work begins.

### A1. Shared filesystem path in Docker

Current compose mounts the shared upload volume at `/data/uploads`, while the default env points `STORAGE_FS_PATH` at `./.data/uploads`. In separate app/worker containers that resolves to separate container filesystems.

**Implement:**

- override `STORAGE_FS_PATH=/data/uploads` for both app and worker in `docker-compose.yml`;
- keep `./.data/uploads` as the correct native-development default;
- document the distinction explicitly;
- add a compose-level or integration regression test proving the worker can read a file written by the app-side storage provider.

**Exit criterion:** a PDF uploaded by the app container is readable by the worker container without relying on host bind mounts.

### A2. Pipeline progress channel identity

Handlers intentionally emit progress keyed by `sourceId`, while the upload UI currently subscribes with the initial pg-boss `jobId`. Later stages also have different job IDs, so the source is the only stable pipeline identity.

**Implement:**

- make the upload UI subscribe to `/api/jobs/{sourceId}/stream`;
- rename internal variables/comments from `jobId` to `channelId` where practical;
- add a UI/unit test covering source-id subscription;
- longer term rename the route to `/api/pipeline/{sourceId}/stream` while keeping compatibility if needed.

**Exit criterion:** parse -> extract -> embed progress is visible in one uninterrupted stream.

### A3. Local configuration drift

Current docs and env examples have drifted (`DOCLING_URL` vs `DOCLING_BASE_URL`, mixed native/Docker instructions, claims that OCR/table extraction are enabled when the adapter disables both).

**Implement:**

- standardise on `DOCLING_BASE_URL`;
- update `.env.example`, README and `docs/running-locally.md`;
- document two supported local topologies clearly:
  - native app/worker + native Ollama + optional OCR service;
  - Docker app/worker/Postgres + host Ollama + optional OCR sidecar;
- make provider diagnostics show the effective provider/base URL/model and whether app/worker can reach it.

**Exit criterion:** copying the documented setup produces the same topology the docs describe.

### A4. Local LLM concurrency and deadlines

Pass 1 metadata and Pass 2 recommendation extraction currently run concurrently. That is useful for cloud APIs but a poor default on 16 GB local hardware because it increases Ollama queueing/peak memory while both requests share tight deadlines.

**Implement:**

- run heavyweight extract calls sequentially in `APP_MODE=local`;
- retain parallel execution for hosted/cloud deployments initially;
- record stage durations and provider/model names;
- revisit timeout semantics so a fallback generation receives its own bounded attempt budget rather than consuming the remainder of one shared deadline;
- recommend `OLLAMA_NUM_PARALLEL=1` for the local profile.

**Exit criterion:** one real local source can complete extraction repeatedly without contention-induced timeout/hang behaviour.

---

## Phase B — replace compulsory Docling with adaptive parsing

### B1. Introduce a page-aware parser contract

The existing `OcrProvider` name is too narrow for a parser that may simply extract a text layer.

Do not break callers immediately. Introduce a document parser service above OCR providers:

```ts
interface DocumentParser {
  parseDocument(input): Promise<ParsedDocument>;
}
```

`ParsedDocument` remains the canonical downstream shape: document markdown, ordered pages, page number, markdown/text, image refs and parser metadata.

### B2. Fast path: existing PDF text layer

Add a lightweight local parser using a mature PDF text extractor (benchmark PDF.js already in the dependency graph vs Poppler/pdftotext).

For each page collect:

- extracted text/markdown;
- page number;
- character/word count;
- basic quality signals (empty/sparse page, high replacement-character rate, implausible glyph stream).

### B3. OCR fallback only for pages that need it

Implement the currently-advertised `tesseract-pdf` path properly, preferably via OCRmyPDF/Tesseract rather than invoking Tesseract directly on PDFs.

Strategy:

- digital pages: use text-layer output;
- empty/sparse pages: OCR;
- optionally OCR the whole document when the majority of pages are scanned;
- preserve page numbering when combining outputs.

On macOS, separately benchmark Apple Vision OCR as a potential native provider. Keep it optional until quality and packaging are understood.

### B4. Keep Docling as a fidelity provider

Docling should remain available for documents where tables/layout/reading order materially matter.

Tasks:

- add explicit modes/presets (`fast`, `adaptive`, `docling-high-fidelity`);
- add a per-request timeout to Docling calls;
- reduce chunk size if benchmarking shows 50-page chunks remain unstable on 16 GB hardware;
- surface whether OCR/table recognition is enabled rather than describing all Docling runs as OCR;
- do not silently fall back from a high-fidelity request without recording the fallback.

**Exit criterion for Phase B:** digital, scanned and mixed PDFs all produce page-aware canonical content without requiring full Docling for ordinary digital reports.

---

## Phase C — redesign recommendation extraction for local models

The current fallback sends up to 30,000 characters from the start of the document when recommendation headings are not detected. This can never find recommendations near the end of a long report.

### C1. Stop full-document head truncation

Replace the first-30k fallback with page/chunk processing. Never discard the tail of a document solely because it exceeds one prompt budget.

### C2. Improve deterministic candidate discovery

Broaden recommendation-section recognition to handle:

- H1/H2/H3 headings;
- `Recommendations for ...`;
- `Key recommendations`;
- numbered `Recommendation 1`, `Recommendation 2`, etc.;
- `Actions`, `Priorities`, `Next steps`, commitments and conclusions/recommendations;
- common table/list presentations.

Use this only to prioritise likely pages, not as the sole gate for extraction.

### C3. Page-window extraction

Feed small ordered windows to the model, for example 4-8 pages at a time, with explicit markers:

```text
[PAGE 17]
...
[PAGE 18]
...
```

Return recommendation candidates with source page spans. Overlap adjacent windows by one page and deduplicate candidates afterwards.

### C4. Separate identification from enrichment

The model currently has to identify recommendations and simultaneously produce multiple taxonomy axes, timescale, target organisation, notes, confidence and page anchors.

Split this into:

1. **candidate extraction** — title/body/page span;
2. **enrichment** — taxonomy, audience, purpose, location, priority, organisation, confidence;
3. **source metadata** — independent source-level pass.

This reduces structured-output complexity and makes small local models more viable.

### C5. Better structured-output handling

- temperature 0 for extraction/enrichment;
- validate every response;
- store actionable validation errors;
- retry only the failed chunk/pass rather than the whole source;
- retain raw model response in debug mode (content-safe/local only) to diagnose schema failures.

**Exit criterion:** long reports can yield recommendations from any page, with reliable page provenance, using bounded local prompts.

---

## Phase D — local model and embedding benchmark

Do this after Phases A-C so models are compared against a sane workload.

Benchmark at least:

- current Llama 3.1 8B extract profile;
- Qwen 3.5 4B;
- Qwen 3.5 9B;
- any subsequently compelling small structured-output model.

Corpus should include at least:

1. short born-digital report;
2. 100+ page born-digital report with recommendations near the end;
3. scanned report;
4. multi-column report;
5. table-heavy report;
6. report with no recommendations;
7. report with implicit/scattered recommendations.

Measure:

- recommendation recall against hand-labelled gold set;
- false positives;
- page-anchor accuracy;
- structured-output validity rate;
- wall-clock per stage;
- peak memory;
- retries/timeouts;
- OCR/text quality;
- total time-to-ready.

Use benchmark data to set the default local model, prompt/window sizes and OCR strategy. Do not choose defaults by model reputation alone.

---

## Phase E — observability and recovery

### E1. Persist pipeline stage attempts

Add durable stage state rather than only a single `sources.status` value. At minimum retain:

- current stage;
- started/finished timestamps;
- attempt number;
- provider + model/parser;
- duration;
- last error category/message;
- whether retry is safe.

### E2. Stage-specific retry

Support retry actions for:

- parse only;
- extraction only;
- enrichment only;
- embedding only;
- full reprocess when explicitly requested.

### E3. Better failure taxonomy

Classify failures such as:

- storage unreadable;
- parser unavailable;
- parser timeout/crash;
- no usable text;
- model unavailable;
- model timeout;
- invalid structured output;
- embedding dimension/context error;
- database persistence error.

The UI should say which stage failed and what to do next.

---

## Phase F — real-provider testing

Keep the deterministic fake-provider suite, but add a separate opt-in/local CI profile.

### F1. Real parser smoke tests

Run representative fixture PDFs through the actual parser/OCR process and assert page count, non-empty text and known phrases.

### F2. Real Ollama structured-output smoke test

The current connection test asks for a trivial one-word completion. Add a structured-output probe using a small schema representative of extraction.

### F3. Full local-stack smoke test

A marked/optional test should run:

```text
real PDF -> real parser -> real local LLM -> real embedding model -> ready
```

It does not need to be part of every PR CI run, but should gate local release candidates and be easy to run on the Mac mini.

---

# Parallel release-quality work from the wider repo review

These should continue alongside the ingest work, but not distract from Phases A-C.

## Release correctness

- fix react-pdf server evaluation (`DOMMatrix is not defined`) with client-only dynamic loading;
- repair access-vs-ownership semantics for private sources; approval should grant access rather than unexpectedly transfer ownership;
- centralise source read/edit authorisation in repository policy functions;
- strengthen hosted E2E assertions and isolate retries/state;
- require green local + hosted CI before release/tagging;
- update stale README/PLAN/STATE/CLAUDE release state.

## Hosted hardening

- bounded/user-aware rate limiting for expensive endpoints;
- do not trust arbitrary forwarded IP headers outside known proxy topology;
- sanitise 500 responses instead of exposing provider/database details;
- harden RAG prompts against instructions inside uploaded documents;
- add upload compensation/failed-stage cleanup;
- improve provider connection tests and embedding dimension validation.

## Search and product quality

- benchmark hybrid retrieval on a realistic corpus;
- make RRF candidate pool scale with requested result depth instead of a fixed 100 forever;
- document English-only FTS or add language configuration when needed;
- revisit network visualisation only after ingest/search quality is measurable.

---

# Implementation order

## Tranche 1 — now

- [ ] A1 shared Docker storage path
- [ ] A2 source-id SSE subscription
- [ ] A3 config/docs corrections
- [ ] A4 sequential heavyweight LLM extraction in local mode
- [ ] tests for the above

## Tranche 2

- [ ] parser abstraction above OCR provider
- [ ] text-layer parser
- [ ] implement `tesseract-pdf` via OCRmyPDF/Tesseract
- [ ] adaptive page-level OCR decision
- [ ] Docling timeout/fidelity mode

## Tranche 3

- [ ] page-aware extraction windows
- [ ] expanded candidate/section detection
- [ ] candidate/enrichment split
- [ ] deduplication across overlapping windows
- [ ] page-provenance tests

## Tranche 4

- [ ] benchmark harness + real report corpus
- [ ] choose local default model from evidence
- [ ] tune context/window/timeouts/embedding batch sizes

## Tranche 5

- [ ] durable stage attempts + retry UI
- [ ] real-provider smoke profile
- [ ] local release checklist

---

# Definition of done

The local ingest work is complete when, on the target 16 GB Mac mini:

- a born-digital report reliably reaches `ready` without Docling;
- a scanned report reliably reaches `ready` using OCR fallback;
- a mixed report OCRs only pages that need it;
- a 100+ page report can extract recommendations from late pages without whole-document truncation;
- model calls do not contend in a way that causes routine timeouts;
- every recommendation has trustworthy page provenance where the source provides it;
- the UI shows the real current stage and actionable failure reason;
- failed stages can be retried without repeating successful expensive stages;
- a real-provider smoke suite reproduces the target configuration;
- benchmark results, not assumptions, determine the recommended local model.
