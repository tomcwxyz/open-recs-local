# Plan

> Last updated: 2026-09-13  
> Status: Phase 12 — local ingest reliability and release hardening

## Objective

Open Recommendations is a local-first, open-source application for turning inquiry reports, reviews and evaluations into structured recommendations that can be tracked, searched and acted on. It should run reliably on a 16 GB Mac mini with no required cloud services, while using the same codebase and schema for multi-user hosted deployments.

The architecture remains: Next.js + TypeScript, Postgres + pgvector + tsvector, pg-boss worker jobs, provider abstractions for LLM/embedding/document parsing/storage/auth, and repository-layer authorisation.

## Canonical documents

- Original architecture: `docs/plans/2026-04-19-open-recs-local-design.md`
- Original implementation plan: `docs/plans/2026-04-19-open-recs-local-plan.md`
- 1.0 finish-line plan: `docs/plans/2026-07-07-finish-line-plan.md`
- **Active reliability roadmap:** `docs/plans/2026-09-13-local-ingest-reliability-roadmap.md`

## Current phase

### Phase 12 — Local ingest reliability

A real-world review of PDF -> parse -> extract -> embed on a 16 GB Mac mini found that failures were not simply a local-model-quality problem. The active roadmap therefore treats ingest as a whole system.

Immediate Tranche 1 work:

- [x] Fix Docker app/worker filesystem storage so both processes use `/data/uploads`.
- [x] Fix pipeline progress subscription to use the stable `sourceId` channel rather than the first pg-boss `jobId`.
- [x] Correct local env naming/topology documentation (`DOCLING_BASE_URL`, native vs container paths).
- [x] Run heavyweight Pass 1/Pass 2 LLM generations sequentially in `APP_MODE=local` to reduce Ollama contention and peak memory.
- [ ] Complete regression tests for the Tranche 1 runtime/config changes.
- [ ] Add parser abstraction above the historical `OcrProvider` naming.
- [ ] Add born-digital PDF text-layer fast path.
- [ ] Implement the advertised `tesseract-pdf` provider via OCRmyPDF/Tesseract.
- [ ] Add adaptive per-page OCR fallback.
- [ ] Keep Docling as an explicit high-fidelity/layout parser rather than the compulsory parser for every PDF.
- [ ] Replace first-30k-character recommendation fallback with page-aware extraction windows.
- [ ] Separate recommendation candidate identification from taxonomy/enrichment.
- [ ] Build a real-provider benchmark/smoke corpus and select local model defaults from measured recall/reliability.
- [ ] Add durable stage attempts and stage-specific retry/recovery.

## Parallel release hardening

The wider 1.0 review remains active alongside Phase 12:

- [ ] Load `react-pdf` client-only to remove the `DOMMatrix is not defined` hosted failure.
- [ ] Separate source access grants from ownership transfer and centralise source authorisation policies in repositories.
- [ ] Strengthen hosted Playwright assertions and test isolation.
- [ ] Require green local + hosted CI before release tags/releases.
- [ ] Bound/user-key hosted rate limiting and sanitise internal 500 details.
- [ ] Harden RAG prompts against instructions embedded inside uploaded documents.
- [ ] Add upload compensation/recovery for partial storage/database failures.
- [ ] Benchmark hybrid retrieval and revisit fixed candidate-pool limits as corpus size grows.
- [ ] Bring README/STATE/CLAUDE release state back in sync with the actual repository.

## Completed phase history

- [x] Phase 0 — Foundation
- [x] Phase 1 — Schema + provider skeleton
- [x] Docs — README + documentation site
- [x] Phase 2 — Core upload -> parse -> extract -> embed pipeline
- [x] Phase 3 — Hybrid/keyword/chat search surfaces
- [x] Phase 4 — UI shell and mode-aware feature gates
- [x] Phase 5 — Source viewer
- [x] Phase 6 — Recommendations UI
- [x] Phase 7 — Progress updates and status transitions
- [x] Phase 8 — Hosted-mode Better Auth/admin/ownership flow
- [x] Phase 9 — Analytics
- [x] Phase 10a — Pipeline performance (batch taxonomy, parallel cloud-era extraction, batch embed)
- [x] Phase 10b — UI enhancements
- [x] Phase 10c — generated tsvector columns + GIN indexes
- [x] Phase 11 PR1 — configurable-provider foundation
- [x] Phase 11 provider connection/model/dimension work substantially landed before 1.0
- [~] Phase 12 — local ingest reliability + release hardening **CURRENT**

## Decisions made

| Decision | Rationale | Date |
|---|---|---|
| Full-parity rebuild with dual local/hosted modes | OSS/local use should not require hosted auth or a separate fork | 2026-04-19 |
| Plain Postgres + pgvector + tsvector; no Supabase | One portable stack for local and hosted modes | 2026-04-19 |
| Better Auth hosted / system context local | One business-logic path with pluggable auth context | 2026-04-19 |
| Provider abstractions for LLM, embedding, parsing/OCR, storage, auth | Models/services are deployment choices rather than application architecture | 2026-04-19 |
| pg-boss instead of Redis/BullMQ | Postgres is already required; avoid another local service | 2026-04-19 |
| SSE via Postgres LISTEN/NOTIFY | Lightweight progress without another realtime substrate | 2026-04-19 |
| Canonical page-aware document representation | Downstream extraction/search should not care which parser produced content | 2026-04-19 |
| No Postgres RLS | Keep repository authorisation portable across local/hosted modes | 2026-04-19 |
| Local inference optimises peak memory before concurrency | Two simultaneous long-context generations are a poor default on a 16 GB Mac mini | 2026-09-13 |
| Text layer first, OCR only when needed | Most modern reports do not need expensive OCR; scanned/mixed pages still need a reliable fallback | 2026-09-13 |
| OCRmyPDF/Tesseract is the first adaptive OCR fallback to implement | Mature, lightweight and well suited to ordinary scanned text; Docling remains for layout fidelity | 2026-09-13 |
| Recommendation extraction becomes page-window based | Recommendations near the end of long reports must never be lost to prompt-head truncation | 2026-09-13 |
| Local default model will be selected by benchmark, not reputation | Pipeline shape materially changes which small model is sufficient | 2026-09-13 |

## Open questions

- [ ] PDF text-layer implementation: PDF.js (already a dependency) vs Poppler/pdftotext for the local parser fast path.
- [ ] Whether Apple Vision OCR should become a macOS-native optional provider after quality/packaging benchmarking.
- [ ] Exact page-window size/overlap for recommendation extraction after corpus benchmark.
- [ ] Qwen 3.5 4B vs 9B vs current Llama 3.1 8B as the recommended local extractor after Phase 12 benchmark.
- [ ] Whether sub-page chunks improve retrieval enough to justify splitting page embeddings.
- [ ] Whether to offer a v1 Supabase importer as a separate migration utility.

## Explicit non-goals

- Replacing Postgres/pg-boss/search architecture as part of ingest work.
- Introducing Redis solely for queues or rate limiting.
- Making Docling mandatory for all documents.
- Choosing a larger local model as a substitute for fixing truncation/provenance/concurrency problems.
- Kubernetes/multi-region/horizontal-scaling work before the single-node product is reliable.
