# Agent Note: Vision capability seam (`ctx.vision`)

Status: implemented

English | [中文](2026-08-23-vision-capability-seam.zh.md)

Image understanding follows the three-role capability seam: `@deepseek-ai/dsh-vision` is the Service Definition (the `VisionProvider` registry and order-independent `understand()` selection); `@deepseek-ai/dsh-vision-openai` is the Provider (multimodal `chat/completions`, credential-bearing requests refuse redirects); `@deepseek-ai/dsh-tool-vision` is the Consumer (the model-facing `understand_image` tool).

## What was given up

- Local image paths are recognized by extension only (PNG/JPEG/WebP/GIF) before base64 encoding into a data URI; the bytes are not magic-validated, so a mislabeled file reaches the provider as-is.
- Provider response bodies are read into memory whole; the seam bounds only the final rendered text via `maxOutputChars`, not the raw response bytes.

## Required verification

- `packages/vision/vision/tests/vision.spec.ts` — provider registration/disposal, duplicate rejection, selection semantics, and `maxOutputChars` truncation.
- `packages/vision/vision-openai/tests/provider.spec.ts` — multimodal request shape, redirect refusal (target never contacted), and HTTP/JSON/content failure paths.
- `packages/vision/tool-vision/tests/understand.spec.ts` — tool registration, the `ctx.vision` execution wiring, and local-path → data URI resolution through the optional `ctx.fs`.
- `packages/vision/tool-vision/tests/loader-composition.spec.ts` — the REAL-composition tier: the three plugins boot from a test-only `cordis.yml` through the real Loader + Include, the external vision HTTP call is mocked, and `understand_image` answers a data-URI image and refuses a local path without a filesystem.
