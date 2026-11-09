# Local Neo4j

The local database uses Neo4j Community Edition in Docker. Start Docker Desktop
or a compatible Docker daemon before running the commands below.

Create `.neo4j.local` in the repository root containing a JSON object with a
`password` string (at least eight characters). Use a password manager or private
secret input; do not commit or print the password. Set the file permissions to
`600`. The existing `*.local` ignore rule excludes this file from Git.

```sh
bun run db:up
bun run db:load
bun run web:local
```

Open http://127.0.0.1:8875 for Linchpin. Neo4j Browser is at
http://127.0.0.1:7474; the username is `neo4j` and the password is the one in
`.neo4j.local`. Both database ports bind only to loopback.

`db:load` replays the recorded evidence without Solana RPC reads, loads governance
cases first, then replaces the tokenomics namespace and checks query parity.
It is intended for this dedicated local database. The governance loader is
additive: changed snapshots may require a fresh database; see [neo4j.md](neo4j.md).

To enable live RPC reads using the existing external configuration while keeping
the database local:

```sh
bun --env-file="$HOME/.config/linchpin.env" run scripts/local-neo4j.ts web
```

The local wrapper overrides only the Neo4j connection variables. The existing
Aura configuration is preserved. Stop any previous app instance on port 8875
before starting the local one.

```sh
bun run db:status
bun run db:down
```

Stopping the stack preserves its named data and log volumes. Do not use
`docker compose down -v` unless you intend to delete the database. Changing the
password in the configuration does not change credentials in an existing volume;
change the database user's password first, then update the file.

The Compose project is named `linchpin-local` and pins the database image version.
The helper locates Docker on PATH or in the standard macOS Docker Desktop bundle.
It passes credentials through the process environment, not command-line arguments.
Avoid printing resolved Compose configuration or inspecting container environment
variables because they contain credentials.

## Moving to a server

Deploy the Bun backend and database on an always-on host. If the backend also
runs in Docker, connect it to the same private network and use the service name
`neo4j` instead of `127.0.0.1`. Keep credentials server-side and expose the app
through HTTPS. The current local web server binds to loopback; a containerized
deployment will need a configurable listen address. Add off-host backups and a
restore check before relying on the server. Persistent volumes are not backups.
Preserve recorded evidence independently so the product graph stays rebuildable.
