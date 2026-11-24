# Recorded NEAR evidence with a bounded model loop

This local service answers three structured public requests: control of a registered subject, preflight of a recorded action under a server policy, and a server policy's verdict. The existing read-only tools compute the authoritative result before the model runs. The model selects a view over server-owned evidence; it cannot change an action, policy gate or fact.

```sh
bun run src/near/agent/serve.ts --port 8792
bun run linchpin near ask --kind control --subject intents.near --offline --json
bun run linchpin near ask --kind preflight --action '{"kind":"contract-call","receiver":"contract.main.burrow.near"}' --policy quantrin-near-v1 --offline
bun run linchpin near ask --kind policy --policy quantrin-near-v1 --offline
```

The listener binds to `127.0.0.1` only. The page, script and unchanged evidence-kit stylesheet come from that origin. Prepared answers require no key or remote connection and carry the label **Composed by a fixed script over recorded evidence, not by a model**. The offline form uses the three prepared examples, including the recorded closed preflight. It does not execute that action. The subject selector applies to live control requests; prepared control always names its fixed example.

For a live model, provide `NEARAI_API_KEY` in the operator's environment. The adapter reads it at call time and uses only `https://cloud-api.near.ai/v1`, model `z-ai/glm-5.3-flash`, temperature zero, low reasoning and 1,200 output tokens. It reads no other application's credentials and performs no login. Missing configuration yields `model-not-configured` and the page offers prepared evidence. Errors expose fixed codes, with no provider error text or credential.

Limits per ask: six tool attempts including the seed, eight model calls including one possible surface repair, ninety seconds, twelve projected facts per tool, and 32 KiB per forwarded tool envelope. Truncation is visible as partial coverage. Invalid requests are rejected before request-specific tool or model calls. Inputs accept no free-text question, method, owner, quantity, private position, policy path or previous conversation.

`ask(input, {context, model?, signal?, clock?, fetch?, nonce?})` and `createNearAgentHandler(options)` are the library boundaries. `createNearContext()` loads recorded public snapshots, server policies and existing libraries, then checks warmed readiness. Dependency injection supports offline verification with `ScriptedModel`. `POST /api/near-agent/ask` returns `{kind, authoritative, messages, model, attestation, responseBinding, codes, usage}`. `GET /api/near-agent/prepared` returns the three fixed examples. The handler has no listener. The page validates the three evidence-kit messages before mounting them.

Every model-visible fact value passes through a typed review envelope and `projectForModel`; the tool layer also uses `publicEvidenceStore`, `projectPublic` and `assertPublicResponse`. The unmodified authoritative result stays beside the model's view. Unknowns and coverage gaps remain visible regardless of the selected template. Facts show basis, status, observation and receipts. Missing historical evidence stays unknown.

A fresh model report is captured before the first live completion. **Hardware attestation is `not-checked`** for a matching captured report, or `unavailable` on failure. The service does not verify the hardware trust chain. Reply signatures are checked over exact request and response bytes against a unique key in that pre-completion report. A matching signature is labelled **`valid-under-unverified-key`**; other states are `invalid` and `unavailable`. This is not proof of hardware trust, confidentiality or a privacy track. Captured API metadata has its own source, observation time and byte-hash receipt.

No signing, funds movement, swap, private book, executor, chain-write tool or automatic transcript persistence is provided. Raw model bytes and reasoning stay in memory. The optional `onWire` library hook is for an explicit local operator probe; applications that supply it own any resulting capture. Token counts are provider values or `null`.

Text CLI exits: `0` for a composed model answer, `3` for missing configuration or labelled offline preparation, `2` for invalid input or refusal. A policy gate is response data and is independent of command success. `--json` emits the same core response. CLI flags are closed; `--snapshot` selects an existing recorded snapshot. Launcher ports must be 1–65535; internal programmatic servers can use port zero for a loopback test.
