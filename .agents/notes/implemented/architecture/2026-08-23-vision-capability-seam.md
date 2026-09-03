# Agent Note: Vision capability seam (`ctx.vision`)

Status: implemented

English | [中文](2026-08-23-vision-capability-seam.zh.md)

## Problem

The harness has no image-understanding surface: a model cannot ask what an image contains. Image understanding has three owners — the model needs a stable tool schema, the harness needs provider selection and normalized results, and a provider needs multimodal request and response handling. Folding the tool against one concrete provider endpoint would bind the model-visible schema to that endpoint.

## Decision

Image understanding follows the three-role capability seam: `@deepseek-ai/dsh-vision` is the Service Definition (the `VisionProvider` registry and order-independent `understand()` selection); `@deepseek-ai/dsh-vision-openai` is the Provider (multimodal `chat/completions`, credential-bearing requests refuse redirects); `@deepseek-ai/dsh-tool-vision` is the Consumer (the model-facing `understand_image` tool).

## What was given up

- Local image paths are recognized by extension only (PNG/JPEG/WebP/GIF) before base64 encoding into a data URI; the bytes are not magic-validated, so a mislabeled file reaches the provider as-is.
- Provider response bodies are read into memory whole; the seam bounds only the final rendered text via `maxOutputChars`, not the raw response bytes.

## Alternatives considered

**Fold image understanding into the web seam (`ctx.web`).** The web seam's request/result vocabulary is search and fetch over HTTP; vision needs multimodal `chat/completions` payloads and image-aware providers. Reusing `ctx.web` would widen its contract for a payload shape one capability needs.

**Register the tool directly against the OpenAI provider (no seam).** A tool bound to one provider endpoint pins the model-visible schema to that endpoint and duplicates selection and availability handling per integration; the seam keeps the schema stable while providers plug in behind `ctx.vision`.

**Reuse `read_image` from `dsh-tool-fs`.** `read_image` is attachment-scoped and executes only when the routed model declares image input; `understand_image` takes explicit URL, data URI, or local-path references and needs no attachment storage, so the two tools serve different call shapes.

## Required verification

- `packages/vision/vision/tests/vision.spec.ts` — provider registration/disposal, duplicate rejection, selection semantics, and `maxOutputChars` truncation.
- `packages/vision/vision-openai/tests/provider.spec.ts` — multimodal request shape, redirect refusal (target never contacted), and HTTP/JSON/content failure paths.
- `packages/vision/tool-vision/tests/understand.spec.ts` — tool registration, the `ctx.vision` execution wiring, and local-path → data URI resolution through the optional `ctx.fs`.
- `packages/vision/tool-vision/tests/loader-composition.spec.ts` — the REAL-composition tier: the three plugins boot from a test-only `cordis.yml` through the real Loader + Include, the external vision HTTP call is mocked, and `understand_image` answers a data-URI image and refuses a local path without a filesystem.

## Consequences

The harness gains a model-facing `understand_image` tool behind an order-independent provider registry: new providers plug in without changing the tool schema, and selection failures are typed `VisionError`s the model can route on. The cost is the two bounds above — mislabeled files and oversized responses pass through to the provider and to memory, respectively.
