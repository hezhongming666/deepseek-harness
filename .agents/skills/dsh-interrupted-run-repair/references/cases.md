# Residue cases

Each case is a residue class the tool detects and repairs, paired with the fixture the self-test builds for it. The motivating cases were observed while reviewing an external Python collection pipeline read-only — a scheduled tick that appends samples, an independent close task that aggregates them, a lock, and a marker file — and are reproduced here synthetically; no external file is read at run time.

## Cases

| Case (self-test name) | Residue | Finding | Repair | Why a plain re-run fails |
|---|---|---|---|---|
| `partial-jsonl` | `{"code":"C","at":` as the final line | `PARTIAL_LAST_LINE`, `BAD_JSONL_LINE` | `TRUNCATE_PARTIAL_TAIL` (tier 1) | The appender tolerates the bad line and appends normally, so the re-run looks successful — while the aggregator that parses the whole file raises on that line every time, so the artifact never completes. |
| `no-newline` | A complete record with its terminating newline lost | `MISSING_FINAL_NEWLINE` | `APPEND_FINAL_NEWLINE` (tier 1) | The next append concatenates onto the record, producing `{...}{...}`, which invalidates both records. Terminating the record drops no data; truncating it would. |
| `concatenated` | Two records on one line from an earlier append | `BAD_JSONL_LINE` | `QUARANTINE_LINES` (tier 2) | The corrupted line is invisible to the deduplicating reader, so the re-run re-appends the records it cannot see and hides the damage. |
| `csv` | A panel row cut mid-field, with its date already written | `PARTIAL_LAST_LINE`, `BAD_CSV_ROW` | `TRUNCATE_PARTIAL_TAIL`, `QUARANTINE_LINES` (tier 2) | Readers that test "is this day already recorded" by the first field find the truncated row present and skip it, so the day stays permanently short with no error. |
| `empty-marker` | A zero-byte completion marker | `EMPTY_MARKER` | `QUARANTINE_FILE` (tier 1) | Reader checks test existence only, so an empty marker means "finished"; the producer is never asked to redo the work. |
| `json` | A manifest truncated by a non-atomic `truncate` + `write` | `UNPARSEABLE_JSON` | `QUARANTINE_FILE` (tier 1) | A reader that swallows the parse error and falls back to an empty document silently drops every earlier day it used to hold. |
| `stale-lock` | A lock whose holder pid is gone | `STALE_LOCK` | `CLEAR_STALE_LOCK` (tier 1) | Every later run fails loud on the lock with no way forward; the pid check is what makes clearing safe. |
| `duplicate` | The same record twice after a re-run | `DUPLICATE_KEY` | `DEDUP` (tier 3) | Sample counts inflate past a threshold, so a day qualifies on rows that describe fewer distinct observations. |
| `multibyte` | A Chinese text field cut mid-character | `UNDECODABLE_BYTES`, `PARTIAL_LAST_LINE` | `TRUNCATE_PARTIAL_TAIL` (tier 1) | A strict UTF-8 read raises rather than reporting a line number, so the failure names no location to repair. |
| `live-lock` | A lock held by a running process | `LIVE_LOCK` | none | Not repairable by design: clearing it would break the single-writer discipline the lock exists to enforce. |
| `orphan-temp` | A `*.tmp` sidecar beside an intact target | none | none | An interrupted atomic write leaves a temp file that is already harmless once the target is intact; deleting it needs no special handling. |
| `path escape` | A contract naming `../outside.jsonl` | contract error, exit 2 | none | Repair must not be reachable outside the run's own tree. |

## Deriving a contract

List what the run claims to produce, and the kind that decides what a whole record is. Two fields carry most of the value:

- `role: completion-marker` names the artifact whose *existence* other code treats as "the run finished". Without it, an empty marker reads as a healthy artifact.
- `required: true` turns a missing artifact into a reported incompleteness instead of silence.

Add `unique_key` where the producer deduplicates on read, because a corrupt line defeats that deduplication and the re-run appends what it cannot see.

## Out of scope

Repair here is byte- and record-level, and deliberately stops where judgement would be guessing:

- **A torn write the file system never made durable** cannot be detected from the artifact; if the write never landed, the file is simply older than expected, which only mtimes show.
- **Lost updates from two concurrent writers** need a lock in the producer, not a repair: both writers succeed, and the surviving file is a valid subset.
- **A reader that swallows corruption and resets state** is a producer defect. `manifest.json` above is the example: quarantining the truncated file stops the loss, but the reset-on-parse-error path in the reader is what drops history, and it must fail loud instead.
- **Truncated binary formats** need the format's own recovery, because line and document boundaries are not observable.
- **Reconstructing dropped records** is out of scope by design: tier 2 and tier 3 archives are evidence for the operator, not a restore path.
