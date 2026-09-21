# Agent Note: ia-tool renders surface canonical results

Status: implemented

English | [中文](2026-09-07-ia-tool-renders-surface-results.zh.md)

## Problem

The four data tools of `tool-ia` declare per-action canonical output digests — trace node ids, links, three-level impact lists, matrix rows, gate lists, request outcomes, knowledge hits, records, readiness, and project snapshots — but every `render` replaced that digest with a fixed `done.` text. The model never saw the node id its own `ia_trace record` call had just issued, so the next `ia_trace link` could not target it (`unknown trace node`); gate lists, request outcomes, search hits, and project state were equally invisible, while the tool schemas and package READMEs promised exactly the information the renders discarded.

## Decision

Each data tool now renders its canonical digest as plain-text lines through one shared `textBlock` helper, and each render stays a pure function of the validated canonical value:

- `ia_trace` renders the issued node id and kind on `record`, the edge on `link`, the changed/direct/indirect/potential id lists on `change` and `impact`, and one matrix row per requirement with its implementation and test ids plus the coverage verdict.
- `ia_gate` renders every registered gate with its pending count and latest decision, and one request's decided or pending outcome with the pending note.
- `ia_knowledge` renders search hits with entry id, library, title, source/version citation, review status, and matched terms, plus the `degraded` cold-start flag; `record` renders the new entry id with its review status; `readiness` renders per-library counts and gaps.
- `ia_project` renders the project id and template with one stage line each (state, attempts, verifiers, gate status, reports, escalation, instruction), the project list, the submitted stage, and the audit package per stage with its gate decisions.

The canonical digests are unchanged: they remain lossless JSON for structured consumers, and only the presentation projection changed.

## Alternatives considered

**Dump the canonical digest as JSON text.** Rejected: the digests already reach code consumers as structured values; the model needs the operative fields — the issued node id, the pending verdict — in a compact stable form, not a serialization that re-lists everything and spends tokens.

**Change the output schema instead of the render.** Rejected: the digests are correct and already match the tool descriptions and READMEs; the defect was the presentation projection discarding them, which is exactly the `render` hook's contract.

**Reuse the `ia_verify` one-line style verbatim.** Rejected: verification reports are single-faceted, while the data tools return multi-row structures (gates, matrix rows, stages) that stay readable only as one line per row.

## Consequences

The model can complete the loop the schemas describe: record a node and immediately link it by its rendered id, read a gate request's outcome without inspecting snapshots on disk, and see project state after every `init`/`advance`/`submit`. Renders are deterministic plain text, so replay and snapshots stay stable. A tool action added later without a render arm now surfaces `unhandled render action` instead of silently reporting success. The Loader-composition test pins the rendered text for record/link/matrix, gate list and the pending request, knowledge record/search/readiness, and project init/status/list/export.

## Related

- [Industrial automation closed-loop family](../architecture/2026-09-05-industrial-automation-closed-loop-family.md)
