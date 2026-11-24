# Risk desk

A loopback-only dashboard of a book of positions: the policy verdict rule by rule, one dependency map per NEAR position with every node marked by what the policy says about it, one template sentence per rule that is not within policy, what changed since an earlier snapshot, and every unknown. A panel forwards a question to an IronClaw agent on the same machine, after a guard that stops any question holding a private value.

The desk computes nothing of its own. The verdict, the chains, the join and the changes are the answers of the functions the command line uses (`buildNearReview`, `joinPositions`, `watchPolicy`). Every view is a surface of the UI kit's catalog `linchpin.evidence.v1`, checked by the kit's validator before it is served, and drawn by the kit.

## Start

```sh
linchpin desk <policy> [--snapshot <id>] [--before <snapshot>] [--address <chain>:<account>]... [--positions <file>] [--port <n>]
```

It prints one line, `desk http://127.0.0.1:<port>/#token=<token>`; open that address. The default port is 7430. Loading takes as long as a policy review does, and longer with `--before`.

- The server binds `127.0.0.1` only. `--host` is refused.
- A launch that cannot be served prints `desk: <cause>` on stderr, exits 2 and binds no port: an unknown policy, an unknown snapshot, a book file the parser rejects, a malformed address, a port outside 1 to 65535.
- Each launch makes a fresh random token. Every route under `/api/desk/` needs it in the `x-desk-token` header, and answers 403 with an empty body without it, with another `Host`, or with another `Origin`.

## Where positions come from

| Source | When | Shown as |
|---|---|---|
| reader | each `--address`, and each address typed on the page | `reader`, with chain, block and endpoint host |
| book file | `--positions <file>`, read by `parseNearBook` | `manual` |
| synthetic book | neither flag is given: `fixtures/desk/book-synthetic.json` | `manual`; the page says "synthetic book" |

A NEAR position gets the full map. A position on another chain is listed with "no dependency review for this chain yet". An address on a chain without a reader is listed as "not read: no reader for this chain". A typed address is held in memory only: the desk writes no file, and no address reaches a log line or a view other than the positions view.

The address goes to the reader's RPC endpoint, whose host the page names, to read balances. It does not go to the agent.

## Routes

| Route | Answer |
|---|---|
| `GET /`, `/desk.js`, `/desk.css` | The page frame, its script, the kit stylesheet followed by the desk's layout rules. No token needed; no value of the book inside |
| `GET /api/desk/verdict` | The public verdict in canonical JSON, equal to `linchpin near policy <policy> --json --offline` |
| `GET /api/desk/surface/<view>` | The kit messages of `verdict`, `map`, `words`, `changes` or `unknowns`. A surface the validator refuses is not served: 500 with `{"error":"view-refused","codes":[...]}` |
| `GET /api/desk/positions` | The book, its sources, the reader's private receipts, and the positions as a kit surface |
| `POST /api/desk/addresses` | `{"address":"<chain>:<account>"}`; reads it and adds its positions |
| `GET /api/desk/agent` | Whether the agent panel is available, and why not |
| `POST /api/desk/ask` | `{"question": "..."}` or `{"explain":{"ruleId":"..."}}`, with an optional `previousResponseId`: a response id an earlier answer of this launch carried, else 400 `bad-request` |

## The views

Rows cite the receipts of the facts they rest on. A rule that evaluated no fact is a scope row, "policy evaluation; no fact evaluated". A sentence that states an absence ("No change recorded", "None recorded") is a coverage note of its result.

In the map every edge is one fact. A node carries a kit mark for the worst outcome among the rules that name it, and the surface carries the legend:

| Mark | Stands for |
|---|---|
| `attention` | outside-policy |
| `undetermined` | undetermined |
| `clear` | within-policy |
| `unmarked` | no-rule: no rule names the node |
| `changed` | a dependency change is recorded for the node since the `--before` snapshot |

A node takes one mark or a list (`GraphNode.mark` in `../ui/types.ts`), so a node can be `attention` and `changed`. The kit draws a mark as a word and a line pattern and gives it no meaning of its own. The position node is labelled "private: not sent to the agent" and has no edge: no fact names a position.

### Long tables and lists are folded

A table, a list of unknowns, or a node or edge list of a map with more than six rows (`FOLD_OVER_ROWS` in `chrome.ts`) is drawn inside a native `<details>` that starts closed. Its summary line names what is folded and counts the rows: `Rows`, or the kit's own `Nodes` and `Edges`. A click, Enter or Space opens it. Everything of six rows or fewer stays open: the verdict and its summary, the marks legend, each map's drawing with its marks, the coverage notes.

The fold is made on the page (`viewTree`), around the node the kit drew. The surfaces a route serves are unchanged, and a folded row keeps its basis, its observation and its evidence chip. Nothing is fetched on opening. A fold closes again when the views are redrawn, which happens after an address is read.

## The agent panel

`POST <base>/api/v1/responses` with the bearer token, where `<base>` is `LINCHPIN_IRONCLAW_URL` (default `http://127.0.0.1:3000`, loopback HTTP only) and the token is `LINCHPIN_IRONCLAW_TOKEN`, read at call time. The body is exactly `{"model": "default", "input": <question>, "stream": false}`, plus `"previous_response_id"` for a follow-up; IronClaw 1.4.1 refuses a body without `model` (400), and `"default"` routes to the provider configured in IronClaw. The answer text is read from `output[].content[]` items of type `output_text`, else from a top-level `output_text`; tool calls are the `output[]` items whose type ends in `_call`.

**Checked against IronClaw 1.4.1 on 2026-11-13** (`docs/validation/2026-11-12-risk-desk-v2.md`, "IronClaw session"). A turn that completes with `"status": "failed"`, a non-2xx answer other than 401 (which shows `unauthorized`), or an answer in another form shows the `upstream` error and no text. IronClaw fails a turn when its agent reaches a tool behind an authentication gate (as the installed Linchpin extension is): that question then shows `upstream`.

- Before a question leaves, the guard compares it with every address given, and every position's id, quantity and owner suffix. A match answers 422 and nothing is sent. "Explain further" sends a question the desk writes from the rule id and the rule's public subjects.
- The guard reads a quantity by its digits, not by its value. A number in the question is a stretch of digits with the spaces, punctuation and symbols between them, and the `e` of a power of ten; a digit of any script counts as 0 to 9, and a letter ends the number. The question is stopped when the digits of one number, read in a row, contain the quantity's significant digits (its digits without the decimal mark, leading zeros and trailing zeros: `12505` for 1250.5, `5` for 0.5 and for 500). So 1250.5 is stopped as `1,250.5`, `1250 .5`, `1.2505 × 10³`, `١٢٥٠٫٥`, and also as `12505` or `125.05`, which are other values. A held quantity with one significant digit stops every question that has that digit in a number, a date or an id.
- A follow-up carries a `previousResponseId`. The server accepts it only when it is a response id IronClaw returned to this server since the launch; it keeps the last 64 in memory. Any other value, and an id that is not 1 to 128 letters, digits, `_` or `-`, answers 400 `bad-request` and nothing is sent. An accepted id is not compared with the guard: it came from IronClaw, not from the page, and a real id usually holds digits a held quantity has. The question of a follow-up is guarded like any other. A response id of another form is not kept, so the answer after it cannot be followed up.
- The page holds the id of the last answer and sends it with the next question. That id goes stale when the desk is restarted while the page stays open, or once 64 later answers have pushed it out of the server's list. The follow-up that carries a stale id answers 400 and is shown as a failure; the page does not send it again. The page then drops the id (`nextPreviousResponseId` in `followup.ts`), so the next question starts a new conversation, without a reload. The server gives the same 400 for any request it refuses, so a follow-up refused for another cause, such as a question over 4000 characters, also drops the id. A question the guard stops (422) and an agent failure keep it.
- **Limit of the guard.** It does not stop a quantity written with a vulgar fraction (`1250½`), in words ("twelve hundred and fifty point five"), in numerals that are not decimal digits (Roman numerals, circled digits Unicode does not map to a digit), or with a letter between its digits. It compares text and does not understand the question.
- The answer is shown as text under "unchecked summary". A fact or receipt id in it is a reference only when it resolves in the loaded snapshots; otherwise it is struck through with "not in this snapshot".
- Without a token, or with a base that is not loopback, the panel shows "IronClaw panel: not demonstrated" and the reason; the other routes are unaffected.

## Files

| File | Holds |
|---|---|
| `cli.ts` | `runDeskCommand`: arguments, refusals, the printed address |
| `state.ts` | `loadDeskState`, `readAddress`: policy, snapshots, review, positions and their sources |
| `surfaces.ts` | `buildSurface`, `serveSurface`, `MARK_OF_OUTCOME`: the five views and the positions view as kit messages |
| `sentences.ts` | `SENTENCE_TEMPLATES`, `sentenceFor`: plain words per rule kind and outcome |
| `server.ts` | `startDesk`: the loopback server, the token guard, the routes |
| `guard.ts` | `guardTerms`, `guardHit`: the outgoing guard |
| `ironclaw.ts` | `agentConfig`, `askIronclaw`: the one outgoing agent call |
| `answer.ts` | `answerSegments`: an answer cut into text and ids |
| `followup.ts` | `nextPreviousResponseId`: which response id the page's next question carries |
| `chrome.ts` | The page frame, the source line, the fold around a long table or list (`viewTree`, `FOLD_OVER_ROWS`) and the agent panel as trees for the kit's `mount` |
| `page.ts`, `client.ts`, `desk.css` | The served document, the page script, the layout of the regions |
| `strings.ts` | Every fixed label |
