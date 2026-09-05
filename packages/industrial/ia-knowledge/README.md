# @deepseek-ai/dsh-ia-knowledge

English | [中文](README.zh.md)

The standards/templates/cases knowledge libraries (§6.2) with the learning sink (§4.3). Every entry carries a mandatory source and version citation; retrieval is deterministic keyword matching with bounded results, so hits are reproducible and attributable. Records from the learning sink enter `pending-review` and wait for a human approval — the quality gate the architecture demands.

## Configuration

| key | meaning |
|---|---|
| `minTemplates` | Cold-start minimum template scale, default 20 (§6.2). |
| `minCases` | Cold-start minimum case scale, default 30 (§6.2). |
| `maxSearchResults` | Retrieval result cap, default 10. |

Non-positive integers fail at load.

## Service API

`ctx.iaKnowledge`:

- `record({ library, title, content, tags?, source, version, recordedBy, reviewStatus })` — record one entry; duplicate title+content pairs in one library throw `DuplicateKnowledgeEntryError`, and missing citations throw `MissingCitationError`.
- `approveEntry(id)` — the human approval path; entries approve exactly once.
- `entriesList(library)` — all entries of one library.
- `libraries()` — the three closed library kinds, in canonical order.
- `search(library, query)` — every whitespace-separated term must match; hits are ranked by match count, capped, and always carry their citations.
- `readiness()` — the cold-start snapshot: per-library counts plus the gaps below the configured minima.

Search results flag `degraded: true` while the libraries are below their minimum scale — the architecture's explicit pure-generation marker (§6.2). The invariant companion proves the citation contract after every mutation.

## Model Experience

Indirectly, through dsh-tool-ia's `ia_knowledge` tool, which is the only model-facing surface that renders these libraries.

#### KV Cache effect

Independent. The libraries keep no request-scoped state and register no prompt or tool schema; entry text enters requests only as `ia_knowledge` tool results.

## Known Limitations and Deferred Work

- **In-memory libraries** — entries live for the service lifetime; a file-backed or storage-domain-backed library with human-editable seed files is deferred.
- **Keyword retrieval, not embeddings** — deterministic substring matching is the honest cold-start RAG; semantic retrieval is deferred to a vector backend.
- **Approval is service-only** — `approveEntry` is a service API for future human commands/UI; no model-facing tool exposes it.
