# Linchpin agent answers

A question about a recorded protocol becomes a cited answer surface, drawn with the UI kit in `src/ui`. A model chooses how recorded rows are shown. It never writes a value: every value on a surface is bound from a row a retrieval tool returned, and the kit's validator checks the surface before it is sent.

The module serves the two protocols of the tokenomics registry, Marinade and Kamino, from their committed captures. It reads no chain and no graph database.

## Start the page

```sh
bun run src/answers/serve.ts [--port <n>] [--host 127.0.0.1|localhost]
```

It serves one page on `http://127.0.0.1:8791/` and binds the loopback address only. Any other host, or a port outside 1 to 65535, ends it with one line on stderr and exit code 2. The first start replays the recorded Marinade capture, which can take about half a minute; later starts read a local cache under `out/`.

Without a model the page still works: it lists the prepared answers, and a typed question gets the fixed surface "No model is configured on this machine".

| Variable | Use |
|---|---|
| `LINCHPIN_AGENT_MODEL` | The model id for typed questions. There is no default; without it no request leaves the machine |
| `ANTHROPIC_API_KEY` | Read at each model call, on the server only. Never logged, returned or put into an error |
| `LINCHPIN_AGENT_LOG` | The trace file. It must lie outside the repository, or the launcher refuses to start. Without it nothing is logged |
| `LINCHPIN_AGENT_EVAL_OUT` | Where `eval.ts` writes its report. Outside the repository |

## Routes

`createAnswersHandler(options)` returns `(request: Request) => Promise<Response>`. It answers 404 for every path but these two, so an application can hand its requests to it.

| Route | Reply |
|---|---|
| `POST /api/answers/ask`, body `{question, protocol, previous?}` | `application/x-ndjson`: three A2UI v0.9.1 messages, one per line, for the surface `answer` of the catalog `linchpin.evidence.v1`: `createSurface`, `updateDataModel` at `/`, `updateComponents` |
| `GET /api/answers/pinned` | `application/json`: `{label, protocols, answers}`, one answer per reference question with its id, question, protocol, label and the NDJSON of its reply |

Refusals are `{"error": "<code>"}`:

| Status | Code | When |
|---|---|---|
| 404 | `not-found` | Any other method or path |
| 403 | `cross-origin` | An `Origin` header that is not the request's own origin |
| 400 | `bad-request` | A body over 4096 bytes or not a JSON object; a key other than `question`, `protocol`, `previous`; a question that is not 1 to 600 characters after trimming; a protocol the backend does not serve; a `previous` that is not 64 lower-case hex characters |
| 422 | `private-content` | The question holds an address, or a number next to a registry token symbol. No tool and no model is called |
| 409 | `busy` | Another question is being answered |

An address is a run of 32 to 44 base58 characters. One that already appears in a loaded bundle may be named; the check asks the backend through `knownAddresses()`, which `BundleBackend` has. A backend without that method allows no address at all. `previous` is checked and otherwise unused.

A reply with status 200 is always a surface that passed the validator: the answer, the fixed refusal, or the fixed surface of a machine without a model.

## How an answer is made

1. **Tools.** The model may call four closed tools (`tools.ts`): `coverage`, `list_templates`, `run_template` and `list_views`. A call names the asked protocol, a template id and params that fit the template's schema. No tool takes a query, a label or a property name. A failure goes back as a code: `unknown-tool`, `invalid-params`, `unknown-template`, `tool-budget-exhausted`, `tool-failed`.
2. **Results.** Each successful `run_template` is a result `r1`, `r2`, and so on, in call order. The server writes the data model `{meta, results, coverage}` from them. The model sees each row cut to its key, kind, values, bases, block or slot, time and evidence ids.
3. **Answer.** The model replies with `{"components": [...]}` over the kit's twelve components, or with `{"view": "<id>", "results": ["r1"], "titles"?: {...}}` naming one of the kit's seven view templates, which the server expands with `instantiate`. The first two messages of the reply are the server's own in both cases.
4. **Gate.** `validateSurface` checks the three messages, with every evidence id of every result resolved through `backend.evidence`. A surface that fails gets one repair turn, which carries the rule codes and nothing of the refused surface. A second failure gives the fixed refusal: the header, one sentence and the codes.
5. **Limits** (`planner.ts`): six tool calls, eight model calls, sixty seconds. Past a limit the reply is the refusal with `model-budget-exhausted` or `deadline`; a seventh tool call is answered with `tool-budget-exhausted` and not run.

A view id outside the kit's seven is refused with `unknown-template`, a result id the tools did not return with `dangling-binding`, a shape the template does not take with `shape-not-accepted`.

## Retrieval

`retrieval.ts` is the seam: `RetrievalBackend` with `protocols`, `coverage`, `templates`, `run` and `evidence`. `bundle-backend.ts` implements it in memory as `bundle-local`.

- **Section templates** `section-path`, `section-control`, `section-offsets`, `section-parameters`, `section-programs`, `section-participation`, `section-holders`, `section-flows`, `section-claims`. One optional param, `subject` (at most 120 characters), keeps the rows whose named columns contain it, in any case. A row key is `<section>:<list>:<id>`.
- **`unknowns`**: the open unknowns, the unresolved statements and the unresolved claims.
- **Graph templates**, one per graph query of the protocol. Row values are the local query runner's, in its order. A row that walks several relationships lists the bases of each in traversal order and the union of their evidence ids.

A row keeps the provenance of its source: `bases`, `evidenceIds`, the slot as `blockOrSlot`, and `asOf`. A section that is not ready returns `coverage: "not-mapped"`, the recorded notes verbatim and one `coverage` row, never zero rows that would read as "nothing there". A ready section carries its recorded notes as `coverageNotes` too. `run` sets the placeholder result id `r0`; the tool layer numbers the results of an answer.

`snapshotId(bundle)` is the sha256 of the canonical bundle with the four fields that follow the machine's graph database settings set to their unconfigured values, so the same capture has the same id on every machine.

## Prepared answers

`pinned.ts` holds the reference questions (`GOLDEN`, K1 to K9 for Kamino and M1 to M9 for Marinade) with the fixed script that answers each, and `pinnedAnswers(backend)` runs them. Every prepared answer carries the label "Composed by a fixed script over recorded evidence, not by a model". A script holds tool calls and a surface and no value.

```sh
bun run src/answers/eval.ts --dry-run   # lists the questions; no request, no bundle
bun run src/answers/eval.ts             # answers them with the configured model and writes a report
```

The report says how each answer ended and which row keys it cites, beside the keys the script cites. It sets no pass mark.

## Files

| File | Holds |
|---|---|
| `retrieval.ts` | The retrieval types, `RetrievalBackend`, `RetrievalError`, `MECHANICS`, `paramsMatch` |
| `bundle-backend.ts` | `BundleBackend`, `bundleSource`, `loadBundleBackend`, `templatesSha256`, `snapshotId` |
| `tools.ts` | `TOOL_SPECS`, `ToolSession` |
| `prompt.ts` | `PROMPT_RULES`, `SYSTEM_PROMPT` (the rules, then `catalogJson()`), `PROMPT_SHA256` |
| `compose.ts` | The data model, `toNdjson`, the gate, `refusalSurface`, `noModelSurface`, `REPLY_STRINGS` |
| `planner.ts` | `PlannerModel`, `ScriptedModel`, `ReplayModel`, `answerQuestion` |
| `anthropic.ts` | `anthropicModelFromEnv`: the adapter for Anthropic's Messages API |
| `golden.ts`, `pinned.ts` | The reference questions and their scripts; `goldenModel`, `pinnedAnswers` |
| `handler.ts` | `createAnswersHandler`, the request checks, the answer cache |
| `log.ts` | `cacheKey`, `normaliseQuestion`, the trace line |
| `serve.ts`, `web/` | The launcher, the page document, its layout and its script |
| `eval.ts` | The reference questions against a configured model |

## Models in tests

`ScriptedModel` plays a fixed script: turn n on its n-th call, with tool call ids `t1`, `t2`, and so on. It keeps a copy of every request in `requests` and of every reply in `replies`; `beforeTurn(index)` is called with the turn's position counted from zero. `ReplayModel` returns the recorded reply whose `requestSha256` equals `requestSha256(request)`.

## The cache and the trace

An answer is cached in memory under `cacheKey`: the sha256 of the canonical object of the normalised question, the protocol, the snapshot ids, the backend's id, version and template hash, the catalog id, the prompt hash and the model id. Only answers and repaired answers are cached. A cached reply keeps the header wording of the question that first produced it.

With `logPath`, each ask appends one JSON line: `answerId`, `cacheKey`, `question` (normalised), `protocol`, `tools`, `templateIds`, `results` (ids and row counts), `codes`, `modelId`, `modelCalls`, `inputTokens`, `outputTokens`, `latencyMs`. A refused request is not logged.

## The page

`web/page.ts` is a fixed document: the kit stylesheet, the layout of a question box, the prepared questions and one answer region, and one script. `web/client.ts` checks each reply with the kit's validator, reads it with `interpret` and draws it with `mount`; the server has already resolved the evidence ids. Text reaches the page as text only. The page loads nothing from another origin, and the launcher sends a content security policy that allows its own script, its one style element and connections to its own origin.

## What it does not do

- It answers for the two registry protocols only, from recorded captures. It does not refresh from chain.
- It takes no position, address or amount of a user.
- The page has no drill-down from an evidence id to its record; a surface lists the ids.
- `ControlChain` draws the columns `target`, `instruction`, `role`, `authority`, `controller` and `threshold`. A chain-shaped graph template that lacks one of them draws that step as "not mapped" there; `FactTable` draws every column.
