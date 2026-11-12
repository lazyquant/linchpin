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
