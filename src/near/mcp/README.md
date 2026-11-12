# NEAR evidence endpoint

Run `bun run linchpin near serve --port 8787 --access-log <private-file>` with
LINCHPIN_MCP_TOKEN supplied through the environment (at least 32 characters).
The listener binds only to loopback. POST JSON-RPC 2.0 to /mcp. A separately
configured HTTPS gateway can forward to this listener. No gateway address or
credential value belongs in this tree.

Supported methods: initialize, ping, tools/list and tools/call. The tool list has
eight read-only entries. Snapshot data is loaded at startup. The optional server
flag `--live <snapshot-id>` records a capture before serving; tools cannot capture.
Missing evidence remains explicit. The service does not load a position book.

Calls are bounded to 200 results, four hops, five seconds and 64 KiB request bodies.
Requests above result or hop bounds are clamped with a visible truncated flag.
Authorization failures return an empty 401 response. Private facts and receipts
are removed before serialization, and position fields are rejected at the boundary.
The access log contains method names, status, timing and body hashes only.
