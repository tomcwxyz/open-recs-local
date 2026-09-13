# Local ingest reliability roadmap

> Date: 2026-09-13  
> Status: active — Tranches 1–3 implemented in PR #24; real-provider benchmarking and recovery are next  
> Primary target: reliable end-to-end ingest on a 16 GB Apple Silicon Mac mini

## Why this exists

The application architecture is sound, but the local ingest path accumulated several workarounds that made the real workflow less reliable than the fake-provider test suite suggested. The local path could fail for reasons that had nothing to do with recommendation quality: app/worker storage visibility, progress-channel wiring, Docling worker instability, long-context structured generation, and local model contention.

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

Docling remains available for documents where layout fidelity is worth the extra cost, but is no longer intended to be the compulsory first step for every local PDF.

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

These were release blockers because they could make a healthy pipeline appear broken or stop it before parser/LLM work began.

### A1. Shared filesystem path in Docker — implemented

Compose now overrides `STORAGE_FS_PATH=/data/uploads` for both app and worker while native development retains `./.data/uploads`. The topology distinction is documented explicitly.

**Remaining acceptance:** add/retain an integration-level proof that a file written by the app-side storage provider is readable by the worker-side provider in the container topology.

### A2. Pipeline progress channel identity — implemented

Handlers emit progress keyed by `sourceId`; the upload UI now subscribes with the same stable source pipeline identity instead of the initial pg-boss job id. This allows parse -> extract -> embed to remain on one stream.

**Later cleanup:** rename `/api/jobs/{sourceId}/stream` to a pipeline/source-oriented route while keeping compatibility if useful.

### A3. Local configuration drift — implemented

`DOCLING_BASE_URL` is now consistent across code/env/docs. Native and container topologies are documented separately, and the runbook no longer starts overlapping native/container app stacks.

**Remaining improvement:** provider diagnostics should eventually expose effective provider/model/base URL and meaningful real parsing/structured-output probes, not only lightweight connectivity checks.

### A4. Local LLM concurrency and deadlines — implemented

Local extraction now runs heavyweight stages sequentially. Structured extraction defaults to temperature `0`, and every primary/fallback attempt receives its own bounded timeout rather than sharing a single expiring deadline. Hosted mode can still overlap independent work where that is useful.

The recommended Mac mini Ollama profile is:

```bash
OLLAMA_NUM_PARALLEL=1 \
OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_FLASH_ATTENTION=1 \
ollama serve
```

**Remaining acceptance:** exercise repeated real-source runs on the target machine and record duration/memory rather than relying only on fake-provider CI.

---

## Phase B — replace compulsory Docling with adaptive parsing

### B1. Page-aware parser contract — implemented

A `DocumentParser` contract now sits at the ingest boundary. `OcrProvider` remains a compatibility alias while config/admin surfaces still use `OCR_PROVIDER`, avoiding a flag-day rename.

`ParsedDocument` remains the canonical downstream shape: document markdown, ordered pages, page number, markdown/text, image refs and parser metadata.

### B2. Fast path: existing PDF text layer — implemented

The native `tesseract-pdf` provider first uses Poppler `pdftotext` page by page. It records page numbers and applies a conservative text-quality gate. Born-digital PDFs with usable text return immediately without OCR.

### B3. OCR fallback only for pages that need it — implemented, benchmark pending

`tesseract-pdf` is now a real provider backed by OCRmyPDF/Tesseract rather than an advertised-but-unwired option.

Current strategy:

- extract the existing text layer with Poppler;
- identify sparse pages deterministically;
- call OCRmyPDF with `--pages <sparse pages>` and `--force-ocr` so a tiny/broken existing text layer does not suppress OCR;
- use `--output-type pdf --optimize 0` so unselected pages change as little as possible;
- default OCRmyPDF to one worker on the 16 GB target;
- extract the repaired PDF with Poppler again;
- record both the pages selected for OCR and any pages that remain sparse after OCR.

The native macOS install path is `brew install poppler ocrmypdf`. Apple Vision/OcrMac remains a possible benchmark candidate, not a dependency.

### B4. Keep Docling as a fidelity provider — partially implemented

Docling remains available explicitly. The adapter already uses conservative 50-page chunking, image placeholders, `do_ocr=false` and `do_table_structure=false` after real mixed-layout reports crashed the worker pool. A per-chunk HTTP timeout is now implemented.

Still to do:

- benchmark whether 50-page chunks remain appropriate on 16 GB hardware;
- add explicit parser presets/modes such as `adaptive` and `docling-high-fidelity` if the benchmark justifies them;
- surface fidelity/OCR/table settings in diagnostics;
- pin/test a Docling image version rather than relying indefinitely on a floating image.

**Phase B acceptance status:** code paths now exist for digital, scanned and mixed PDFs without making Docling compulsory. Real-corpus validation is the remaining gate.

---

## Phase C — redesign recommendation extraction for local models

### C1. Stop full-document head truncation — implemented for newly parsed real sources

Real sources with `source_pages` no longer depend on the first 30,000 characters. The old combined path is retained only for fixture-backed fake-provider tests and legacy sources without page rows.

### C2. Improve deterministic candidate discovery — implemented as a secondary/legacy aid

Section recognition now handles H1-H3 headings, key recommendations, recommendations for named audiences, numbered recommendations, actions, action plans, priorities, next steps, commitments and conclusions-and-recommendations. Generic `Summary` and plain `Conclusions` no longer cause false positive recommendation-section mode.

This detector is not the gate for the real page-aware path; page windows scan the whole source.

### C3. Page-window extraction — implemented

Real parsed sources are split into bounded ordered windows with explicit page markers:

```text
[PAGE 17]
...
[PAGE 18]
...
```

Current defaults are six pages / ~12,000 characters, one-page overlap. Pathological single pages are split into overlapping character fragments rather than losing their tail. Page anchors are validated against the actual pages present in the window.

### C4. Separate identification from enrichment — implemented

The real path is now:

1. **candidate extraction** — title/body/page span only;
2. **deduplication** — normalised title + body across overlapping windows;
3. **enrichment** — taxonomy, audience, purpose, location, priority, organisation, confidence in batches of eight;
4. **source metadata** — independent source-level pass.

Enrichment joins back by deterministic `candidate_index` and cannot rewrite candidate title/body/page provenance. Missing enrichment keeps the recommendation and marks it low-confidence/untagged for later review instead of silently dropping it.

### C5. Better structured-output handling — partially implemented

Implemented:

- temperature `0` default for structured extraction;
- schema validation through the provider boundary;
- fresh bounded timeout for every schema/JSON fallback attempt;
- uploaded/document text explicitly treated as untrusted source material in metadata, candidate and enrichment prompts;
- page-window and enrichment progress is surfaced separately.

Still to do:

- persist actionable structured-output validation/failure details;
- retry only the failed chunk/pass instead of re-running the whole `source.extract` job;
- optionally retain raw local debug model responses behind an explicit safe/debug setting.

**Phase C acceptance status:** the architecture is in place. The real-report benchmark must now determine recall, false positives, page accuracy, window size and model choice.

---

## Phase D — local model and embedding benchmark

Do this now that Phases A-C have removed most avoidable pipeline noise.

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
- text/OCR quality including `remainingSparsePageNumbers`;
- total time-to-ready.

Use benchmark data to set the default local model, prompt/window sizes and parser strategy. Do not choose defaults by model reputation alone.

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
- candidate extraction only;
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

Keep the deterministic fake-provider suite, but add a separate opt-in/local profile.

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

These should continue alongside the ingest work, but should not distract from the real-provider benchmark and recovery work.

## Release correctness

- [x] fix react-pdf server evaluation (`DOMMatrix is not defined`) with client-only dynamic loading;
- [ ] repair access-vs-ownership semantics for private sources; approval should grant access rather than unexpectedly transfer ownership;
- [ ] centralise source read/edit authorisation in repository policy functions;
- [ ] strengthen hosted E2E assertions and isolate retries/state;
- [ ] require green local + hosted CI before release/tagging;
- [ ] update stale README/PLAN/STATE/CLAUDE release state.

## Hosted hardening

- [ ] bounded/user-aware rate limiting for expensive endpoints;
- [ ] do not trust arbitrary forwarded IP headers outside known proxy topology;
- [ ] sanitise 500 responses instead of exposing provider/database details;
- [x] harden extraction prompts against instructions inside uploaded documents;
- [ ] add upload compensation/failed-stage cleanup;
- [ ] improve provider connection tests and embedding dimension validation.

## Search and product quality

- [ ] benchmark hybrid retrieval on a realistic corpus;
- [ ] make RRF candidate pool scale with requested result depth instead of a fixed 100 forever;
- [ ] document English-only FTS or add language configuration when needed;
- [ ] revisit network visualisation only after ingest/search quality is measurable.

---

# Implementation order

## Tranche 1 — deterministic local reliability

- [x] A1 shared Docker storage path
- [x] A2 source-id SSE subscription
- [x] A3 config/docs corrections
- [x] A4 sequential heavyweight LLM extraction in local mode
- [x] regression/unit coverage for the above

## Tranche 2 — adaptive parsing

- [x] parser abstraction above OCR provider
- [x] text-layer-first Poppler parser
- [x] implement `tesseract-pdf` via OCRmyPDF/Tesseract
- [x] targeted sparse-page OCR decision + page selection
- [x] Docling request timeout
- [ ] benchmark Docling chunk size and add explicit fidelity presets if justified
- [ ] pin/test Docling image version

## Tranche 3 — local-model-friendly extraction

- [x] page-aware extraction windows
- [x] expanded candidate/section detection
- [x] candidate/enrichment split
- [x] deduplication across overlapping windows
- [x] page-provenance validation/tests
- [x] temperature-zero structured extraction + independent fallback deadlines
- [x] prompt-injection guard for untrusted document/candidate text

## Tranche 4 — next: benchmark and real-stack acceptance

- [ ] benchmark harness + real report corpus manifest
- [ ] real parser smoke test (Poppler + OCRmyPDF/Tesseract)
- [ ] real Ollama structured-output smoke test
- [ ] end-to-end real local-stack command
- [ ] compare Llama 3.1 8B / Qwen 3.5 4B / Qwen 3.5 9B
- [ ] choose local default model from evidence
- [ ] tune context/window/timeouts/embedding batch sizes

## Tranche 5 — recovery and release readiness

- [ ] durable stage attempts + stage timings/provider metadata
- [ ] stage-specific retries (parse/candidate/enrichment/embed)
- [ ] actionable failure taxonomy/UI
- [ ] local release checklist
- [ ] resolve hosted access/ownership semantics and restore fully green hosted E2E

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
