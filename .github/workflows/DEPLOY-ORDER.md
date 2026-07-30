# There is deliberately NO deploy workflow in this directory

This file is not a workflow. GitHub Actions only reads `*.yml`/`*.yaml` here, so this
document cannot run anything — which is the point. It records **why** shipping this
repository is manual, and what any future automation would have to guarantee before it
is allowed to exist.

## The constraint

Shipping this project to a live Foundry host is **two stages, and the order is
load-bearing**:

1. **The Foundry module first** — rsync `packages/foundry-module`, then have the **GM
   reload the world**. A Foundry _server_ restart is not enough: the module is
   browser-side code. Then confirm the module version and its
   `transport.compression.gzip` capability via `foundry-mcp-bridge.ping`.
2. **Only then the server** — whose compiled handler lands in **`backend.bundle.cjs`**,
   not `index.bundle.cjs`.

Reversed, you get a server that compresses into a module that cannot decompress. That
breaks **every** message on the bridge, not just large ones, because compression is
negotiated per connection and then used for all traffic. The opposite order is safe by
construction: a new module against an old server never sees compressed traffic, so it
never answers compressed.

Full detail: `docs/transport-wire-format.md` §8, and `docs/foundry-import.md` in the
mago20 superproject.

## Why it is not automated

Stage 1 contains a step no workflow can perform: **a human GM reloading the world**.
An automated pipeline would either skip it — shipping a module that is on disk but not
loaded in any browser, while stage 2 proceeds and breaks the bridge — or fake it with a
sleep, which is the same bug with a delay in front of it.

A half-safe automation here is worse than a manual checklist, because it converts an
ordering mistake from "something an operator can notice" into "something that happens on
every push".

## If you automate it anyway

Then it must, at minimum:

- be **two separate jobs** with `needs:`, module before server, never a matrix and never
  parallel;
- **gate stage 2 on a measured fact**, not on stage 1's exit code: query
  `foundry-mcp-bridge.ping` and require the deployed module version _and_
  `transport.compression.gzip` to be the ones just shipped, with a bounded timeout, and
  fail if they are not;
- treat a failure to confirm as **do not ship the server** — an un-upgraded bridge is
  working software; a mismatched pair is not;
- be `workflow_dispatch`-only, never `on: push`.

## Related hazard on the same host, already fixed elsewhere

`wod20-compendium-es` deploys LevelDB compendium packs to the same Foundry server and had
the mirror-image problem: an unguarded `on: push` rsync into a **running** Foundry, which
silently corrupts the packs. That workflow now stops Foundry, **verifies it is down
against `ps` and port 30000** (pm2's exit code is explicitly not trusted), rsyncs, and only
then restarts and verifies. See `wod20-compendium-es/.github/workflows/deploy.yml` and
`.github/scripts/foundry-deploy-lib.sh` for the pattern to copy if this repo ever does get
a deploy workflow.
