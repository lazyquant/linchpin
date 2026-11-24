# UI kit

One component catalog, one renderer, one validator and one look for every Linchpin surface. The wire format is A2UI v0.9.1 with the catalog `linchpin.evidence.v1`. The kit draws what it is given: it reads no chain, calls no model and holds no protocol knowledge. It has no dependency and imports only types from `../engine/contracts`.

## From facts to a page

```ts
import { factsToResult } from "./adapters";
import { instantiate } from "./templates";
import { receiptResolver } from "./validate";
import { standalonePage } from "./page";

const { result } = factsToResult(facts, receipts, { id: "roles", shape: "table" });
const messages = instantiate("subject-panel", { surfaceId: "panel", meta: { subjectId, snapshotIds }, results: [result] });
const html = standalonePage(messages, { title: "Panel", lang: "en", resolveEvidence: receiptResolver(receipts.map((r) => r.id)) });
```

`standalonePage` validates first and throws `UiRejected("invalid-surface", codes)` for a surface that fails. For a live page use `validateSurface`, then `interpret` and `mount`; for a string use `interpret` and `treeToHtml`.

## Files

| File | Holds |
|---|---|
| `types.ts` | Result rows, messages, the drawn tree, the validator's result, `UiRejected` |
| `catalog.ts` | `CATALOG`, `catalogJson()`: twelve components and their props |
| `messages.ts` | Message builders, JSON pointers, the reading of a message list |
| `adapters.ts` | `factsToResult`, `graphResult`: engine facts to results |
| `templates.ts` | `VIEW_TEMPLATES`, `listViewTemplates()`, `instantiate()` |
| `validate.ts` | `validateSurface`, `receiptResolver` |
| `interpret.ts` | `interpret`: messages to a tree of plain objects |
| `html.ts`, `mount.ts` | The tree as an HTML string, or as elements on a live page |
| `page.ts` | `standalonePage`, `KIT_CSS` |
| `graph-layout.ts` | `layoutGraph`: a deterministic layered layout, at most 60 nodes |
| `strings.ts` | Every kit string, the class names, the word lists, the contrast pairs |
| `kit.css` | The stylesheet: light and dark, no font file, no remote reference |
| `gallery.ts`, `gallery-data.json` | The gallery and the recorded rows it draws |

## What a value component always draws

For every row: its values, each basis as a word, its block or slot (else its time, else "not recorded"), and an evidence chip listing its evidence ids, or the words "no evidence". A `scope` row shows "Linchpin scope: <source>; not evidence" instead. An `unknown` row and a value equal to `unknown` are hatched; `none` is a different word with a different mark. No prop switches any of this off. The kit builds no link and takes no action, URL or handler from data.

## Validator rules

Where two rules would fire on one prop, the more specific one alone reports (V13 before V2, V15 before V7 to V9, V14 before V5).

| Rule | Code | Refuses |
|---|---|---|
| V1 | `schema` | A message list that is not well formed: version, exactly one message per entry, surface id, catalog id |
| V2 | `unknown-component` | A component or a prop outside the catalog; a required prop missing |
| V3 | `literal-value` | A literal where a binding is required |
| V4 | `dangling-binding` | A binding that names nothing, the wrong place, or a result the component does not accept |
| V5 | `uncited-row` | A bound row with no evidence id or no basis; a scope row with no source |
| V6 | `unresolved-evidence` | An evidence id the caller's resolver reports missing |
| V7 | `advice-word` | Literal text with an advice or absence word |
| V8 | `number-in-text` | Literal text with a digit |
| V9 | `text-too-long` | `Note.text` over 280 or `FactTable.title` over 80 characters |
| V10 | `missing-coverage-note` | A result that is not mapped, or partly mapped, and not shown as such |
| V11 | `not-mapped-as-fact` | A not-mapped result bound to a value component |
| V12 | `structure` | No `root`, a duplicate id, a missing child, a cycle, over 60 components, two surfaces |
| V13 | `forbidden-action` | Any `action` prop |
| V14 | `edge-without-fact` | A graph edge with no basis or no evidence |
| V15 | `section-title` | A `Section.title` that is not a short plain title |

V1 is a structural check written by hand; it is not a validation against the official A2UI JSON Schema.

## Gallery

```sh
bun run src/ui/gallery.ts build [--out <dir>]
```

Writes `<dir>/gallery.html` (default `dist/ui-gallery`): every component in every state, in light and in dark, and one full subject panel. The file is self-contained and makes no request. Its rows are in `gallery-data.json`, copied unchanged from a recorded snapshot; a specimen that alters or invents rows says so in its caption.

## The second catalog: `linchpin.evidence.v2`

A surface names one catalog in its `createSurface` message. The first catalog, its seven templates and its gallery are unchanged, and a surface that names it is validated and drawn exactly as before. A surface that names `linchpin.evidence.v2` may also use twelve more components.

| File | Holds |
|---|---|
| `catalog-v2.ts` | `CATALOG_V2`, `catalogJsonV2()`: the twelve components of the first catalog and twelve more |
| `templates-v2.ts` | `VIEW_TEMPLATES_V2`, `listViewTemplatesV2()`, `instantiateV2()`: `answer-panel`, `protocol-overview`, `protocol-control`, `protocol-unknowns`, `position-sheet`, `graph-explorer` |
| `explorer-model.ts` | `explorerModel(result, { focus, steps, layers, expanded })`: what an explorer draws. Pure |
| `explorer-draw.ts` | `drawExplorer(model)`: one SVG and the same nodes, groups and edges as text. It reads the model and nothing else, so another drawing layer can replace it |
| `gallery-v2.ts`, `gallery-v2-data.json` | The gallery of the new components and the recorded rows it draws |

| Component | Binds | Draws |
|---|---|---|
| `GraphExplorer` | `result` (graph); literals `focus`, `steps`, `layers`, `expanded` | The neighbourhood of a focus, folded where a relation has more than six neighbours, or a small graph whole |
| `FactCard` | `fact`: `/results/<id>/rows/<n>` | One row in full |
| `ReceiptCard` | `receipt`: `/receipts/<id>` | One receipt, field by field |
| `AnswerPath` | `result` (path) | A value path by stage and as a list |
| `FindingList`, `ClaimCheck` | `result` (table) | Findings with status; claims beside what the chain shows |
| `ChangeList` | `result` (changes) | Both sides of each change, each with its own citation, or the reason a side is absent |
| `PositionList` | `result` (table) | Positions of one read; the basis reads "basis not stated by the reader" |
| `CaptureList` | `captures`: `/meta/captures` | The captures on record for a subject |
| `GapList` | `result` (unknowns) | Named gaps, each with a reason word and the source of the statement |
| `QueryTrace` | `trace`: `/meta/trace` | How an answer was produced |
| `Disclosure` | literal `title`; `count`: `/results/<id>/total`; children | A closed section with the number of rows inside |

Additions to the result model, all optional: a node's `kind`, `kindBasis` and `name`; an edge's `layer`, and an end that is the literal `none` or `unknown`; a result's `total` and `constructed`; a row's `constructed`, `source` and `reason`; the row kind `reader`; the shape `changes`; `/receipts/<id>`, `/meta/captures` and `/meta/trace` in the data model. With a numeric `total`, a result says "<shown> of <total>". An evidence chip of the second catalog draws at most 64 ids and says how many more are cited; the validator still resolves every id.

Rules for a surface of the second catalog, after V1 to V15:

| Rule | Code | Refuses |
|---|---|---|
| V16 | `uncited-receipt` | A bound receipt without source, response sha256 or privacy, or whose id the resolver does not know (reported alone, not as V6) |
| V17 | `change-side` | A side of a change with neither a citation nor a reason for its absence; a changes result that names fewer than two captures |
| V18 | `reader-row` | A `PositionList` row that is not a reader row with evidence, a source and the source of its join |
| V19 | `constructed-unmarked` | A constructed row, capture, receipt or result on a surface whose meta does not say constructed |
| V20 | `count-mismatch` | A `Disclosure.count` or a `total` that differs from the rows it stands for; a cut result without a total |
| V21 | `gap-without-reason` | A `GapList` row without one of the four reason words, or a scope row of it without a source |
| V22 | `claimed-amount` | A path link that is claimed only and carries an amount |
| V23 | `trace-incomplete` | A trace without template, outcome or rows returned |

A row of kind `reader` cites receipts and a source and may have no basis; on a surface of the first catalog the kind stays unknown.

`mount(tree, element, { onSelect })` makes evidence ids and the nodes, edges and groups of an explorer focusable; Enter, Space or a click calls `onSelect(kind, id)`. The handler comes from the page's code. Without the option the output is as before.

```sh
bun run src/ui/gallery-v2.ts build [--out <dir>]
```

Writes `<dir>/gallery-v2.html` (default `dist/ui-gallery`).
