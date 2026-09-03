# @deepseek-ai/dsh-tool-spec-loop

Model-facing `spec_loop` tool over the [`dsh-spec-loop`](../spec-loop/README.md) engine and adapter seam. One call runs the complete deterministic parameter-search loop: multi-model generation fallback, envelope and validation gating, monotonic repair, failure classification, and cost caps. The engine owns loop bookkeeping; this package owns generation, deployment ceilings, and the model-facing surface.

## Configuration

All fields live under the `tool-spec-loop` entry `config`; `models` is required.

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `models` | — (required) | Ordered `{ provider, model }` fallback chain for candidate generation; a later entry runs only after every earlier one failed |
| `maxIterations` | 256 | Deployment ceiling for one run's iteration count |
| `maxWallClockMs` | 3_600_000 | Deployment ceiling for one run's wall-clock budget |
| `maxTokens` | 200_000 | Deployment ceiling for one run's billed generation tokens |
| `maxGenerationTokens` | 4096 | Output cap for one generation call |
| `maxHistoryRecords` | 16 | Prior iteration records embedded in the next generation prompt |
| `maxParamsChars` | 2048 | Serialized-character cap for one embedded record's params |
| `maxResultChars` | 16_384 | Rendered-report character cap |

Spec budgets that exceed a deployment ceiling fail the call with `INVALID_SPEC` before any work starts. The tool resolves the adapter through `ctx.get('specLoopAdapter')` and fails the call when no provider is mounted. It requires no calling agent; a calling agent's session id is forwarded to generation requests for replay routing.

## Model Experience

### System prompt section

#### What the model sees

A fixed usage-policy section, registered once per composition with the following verbatim text:

##### Verbatim usage-policy section

```markdown
Use the spec_loop tool only for iterative parameter search against a spec contract evaluated by a mounted spec-loop adapter. One call runs the whole deterministic loop: multi-model generation, validation, monotonic repair, and cost caps are enforced inside the tool. You select the spec and act on the returned report; prefer it over repeated manual trial when numeric assertions exist.
```

#### Token effect

Fixed — the section is assembled once into every system prompt of the composition; it carries no data-dependent content.

#### KV Cache effect

Append-only and prefix-stable — the section text never changes at runtime, so it does not invalidate an already-reusable prompt prefix.

### spec_loop tool schema

#### What the model sees

The `spec_loop` tool schema and description in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-spec-loop). Deltas absent there: `spec` carries the whole contract as one JSON value (`objective`, `assertions`, `budgets`, `repair`, optional `envelope` and `description`); `initialParams` optionally names a starting candidate evaluated before any generation; the result is the complete run report (per-iteration verdicts S0–S3, best accepted parameters, cost totals) rendered as a bounded text summary.

#### Token effect

Conditional — the schema text is a fixed per-composition cost; each call additionally pays the rendered report bounded by `maxResultChars`.

#### KV Cache effect

Append-only — the schema contributes a fixed stable prefix; it does not invalidate an already-reusable prompt prefix.

### Generation requests

#### What the model sees

Each candidate proposal is an independent model request built from the spec, the current iteration number, and the bounded history. The system slot is the following verbatim text; the user slot is data-dependent (spec description, objective, assertions, envelope, repair margin, prior records each truncated by `maxParamsChars`).

##### Verbatim generation system text

```markdown
You propose parameter sets for a deterministic spec loop over engineering software. Respond with exactly one JSON object whose keys are the parameter names and whose values are numbers, booleans, strings, or nested objects — no prose, no markdown, no explanation.
```

#### Token effect

Capped — every call is limited to `maxGenerationTokens` output, at most `maxIterations` calls per run, and a run's total billed tokens are limited to the spec `budgets.maxTokens` tightened by the `maxTokens` ceiling.

#### KV Cache effect

Independent — generation requests are separate model conversations; they never share or replace the calling session's prompt prefix.

## Known Limitations and Deferred Work

- **No named spec registry** — the spec contract is passed inline on every call; a durable registry with revisioned specs is not implemented.
- **No mid-run approval** — envelope violations are classified S1 and never reach the software, but escalating a proposal that approaches the envelope to a human for approval is a shell-level policy the tool does not implement.
- **No replay mode** — the engine replays compositionally (a scripted generator feeding logged proposals), but the tool offers no replay executor for a logged run.
- **Bounded generation history** — prompts embed only the last `maxHistoryRecords` records, so a very long run's earliest context is dropped from later generations.
- **No persistent daily budget** — cost caps are per-run; a cross-run daily ledger needs a persistence seam.
