# Linchpin extension

Target client: IronClaw 1.4.1. This version is the package compatibility target;
the 2026-11-11 session established extension activation. The skill and routine frontmatter
remain configuration pending client validation.

Import the linchpin directory through the WebUI Extensions page, or copy it to
`~/.ironclaw/reborn/local-dev/system/extensions/linchpin/`, then run:

```sh
ironclaw --version
ironclaw extension search
ironclaw extension install linchpin
ironclaw skills list
```

Set the HTTPS server address only in the installed local manifest. The shipped
address is a placeholder. choose the bearer-token option in extension setup and enter the
credential in the client prompt. No credential value belongs in the manifest.
The manifest declares the network and use_secret effects for authenticated MCP access.

Install the skill and routine through the client's corresponding import surface.
Confirm the skill appears in the skill list before using the routine. Start with
extension discovery, which needs no model. Record the dated discovery result
separately from a session involving a model.

## Measured data path

IronClaw: not demonstrated

On 2026-11-11, IronClaw 1.4.1 installed and activated the package and listed its 8 tools.
Agent-time tool calls failed because IronClaw did not send the bearer token, even after its auth gate accepted it.
No tool result reached the agent, and the package ships as untested configuration.
The provider and model of that session are in the private validation record.
Attestation check: not performed.
Position-field canary: local server verification only; no client session measured.
No claim of confidential inference follows from this package.

The private validation record supplies the client version, provider and model,
attestation result, canary result, and access-log hashes. This remains untested client
configuration. The privacy track requires the measured private-inference path.
