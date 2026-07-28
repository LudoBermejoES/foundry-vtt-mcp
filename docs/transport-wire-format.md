# The bridge wire format

The encoding a request and a response travel in between the MCP server and the Foundry module, how the
two sides agree on it, and what happens when a message is still too large for one wire frame.

This is **system-agnostic**: all 91 `foundryClient.query` call sites under
`packages/mcp-server/src/tools/` depend on it, across D&D 5e, PF2e, DSA5, WFRP4e and World of Darkness.
It is the one live description — `docs/spec-wod-actor-io-improvements.md` §8 describes the superseded
behaviour and says so.

Source of truth in code: `packages/mcp-server/src/wire-format.ts` and
`packages/foundry-module/src/wire-format.ts`.

---

## 1. The format

Every `mcp-query` (server → Foundry) and `mcp-response` (Foundry → server) travels **gzip-compressed,
base64-encoded, inside a text envelope**:

```json
{
  "type": "compressed-message",
  "encoding": "gzip",
  "originalType": "mcp-query",
  "originalId": "query-42",
  "payload": "<base64 of gzip of the serialized original message>"
}
```

A receiver routes on `message.type` — the same switch that already separates `chunked-message`,
`mcp-query`, `mcp-response`, `ping` and `job-completed`. It never sniffs the payload bytes and never
branches on `typeof event.data`.

- **`originalId` is load-bearing.** It is the id of the request the wrapped message belongs to, so a
  decode failure can be answered _against that request_ instead of dropped. A dropped failure costs the
  caller its whole deadline and is then reported as a timeout, which points at the wrong subsystem.
- **gzip, not deflate.** The three measure within 12–18 bytes of each other on every real payload, so
  this is not about ratio: gzip has a self-identifying 2-byte magic (`1f 8b`), is the name an operator
  recognises in a log line, and is spelled identically by Node's `zlib.gzipSync` and the browser's
  `CompressionStream('gzip')`.
- **Text, not binary frames.** Binary would save the 33% base64 overhead but adds a _second_
  discrimination axis on top of the `type` switch (three receive paths assume `JSON.parse(event.data)`
  unconditionally), needs binary-mode configuration on two transports, and would not compose with the
  string fragmenter. Net wire reduction after base64 is still **6.5x–7.5x** on real actor payloads.

### Always on, never size-triggered

There is **no size threshold**. A size-triggered scheme would leave both sides needing the
discriminator logic anyway while confining it to the branch that fires only on large payloads — the
least-exercised and most load-bearing path — and would add a "compress above N bytes" constant to pick,
defend and mirror across two packages.

### The forced-plain set, enumerated by `type` and justified by measurement

| stays plain                                                                 | why                                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| the capability handshake (`foundry-mcp-bridge.ping` query and its response) | **forced** — it is how each side discovers whether the peer speaks compression, so it cannot ride inside the encoding it negotiates |
| transport liveness (`ping` / `pong`)                                        | tiny, unsolicited                                                                                                                   |
| unsolicited status emissions (`bridge-status`, anything via `emitToServer`) | tiny, sync-emitted, nothing waits on them                                                                                           |
| framing envelopes (`chunked-message`)                                       | the header must be readable in order to reassemble the payload riding inside it                                                     |

Because only `mcp-query` and `mcp-response` are compressible, the rule is a whitelist: everything else
is plain by construction.

**This is a measurement, not a preference.** Compression makes messages of this size _bigger_:

| message                                   | plain | compressed + base64, enveloped |
| ----------------------------------------- | ----- | ------------------------------ |
| `mcp-query` for `foundry-mcp-bridge.ping` | 79 B  | 234 B                          |
| transport `pong`                          | 79 B  | 225 B                          |

Adding an entry to the set requires the same evidence. `wire-format.test.ts` asserts the inequality, so
a later change cannot quietly compress the handshake.

---

## 2. Negotiation, and its per-connection lifetime

The negotiation is the whole safety story: because compression is the _format_ rather than an
occasional mode, a sender that compresses to a peer which cannot decompress breaks **every** message,
not only large ones.

1. **The module advertises `transport.compression.gzip`** in the `ping` capability list
   (`queries.ts`) — and **only when the primitive is actually present**
   (`typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'`). The
   advertisement _is_ the feature detection, so there is no browser-version table to maintain and an
   engine without the primitive is simply never sent compressed traffic.
2. **The server pings once on connect** and caches `pong.capabilities` **per connection**
   (`FoundryConnector.negotiateCapabilities`, triggered from the WebRTC data channel opening or from
   the WebSocket connection event). Nothing pinged on connect before this change: `FoundryClient.ping()`
   existed with no caller at establishment, and the import tool's dry-run gate pinged ad hoc per call.
3. **The cache is discarded on disconnect** — WebRTC data-channel close, WebSocket close, a new
   WebRTC peer, and connector shutdown all call `invalidatePeerCapabilities`. The peer behind a
   reconnect may be a different module version; after a world reload it usually is.
4. **A handshake that fails or times out is not an error condition.** It leaves the capability
   unobserved and the server on plain JSON — which is exactly the behaviour before this change.
5. **Responses need no negotiation of their own: the module answers in kind.** A response is
   compressed **if and only if** the request it answers arrived compressed. The request is itself proof
   the peer speaks compression, so there is no server→module advertisement to invent and the two
   directions cannot disagree.
6. **A receiver accepts both encodings at all times**, regardless of what it sends — it does not
   control its peer's version.

### The four states, all tested

`packages/mcp-server/src/transport-negotiation.test.ts` wires the real `FoundryConnector` +
`WebRTCPeer` to the real `SocketBridge` + `WebRTCConnection` over a loopback channel pair and asserts:

| server                 | module           | result                                                      |
| ---------------------- | ---------------- | ----------------------------------------------------------- |
| new                    | new (advertises) | compressed both ways                                        |
| new                    | old (silent)     | **plain both ways** — today's behaviour                     |
| old (never compresses) | new              | **plain both ways** — safe by construction, asserted anyway |
| reconnect              |                  | capability discarded, then re-negotiated from scratch       |

**The plain path is permanent and tested, not transitional.** It is the behaviour for an older module
and for a runtime without the primitive, indefinitely.

---

## 3. Bounded decompression

`DecompressionStream` and `zlib` impose no size limit of their own, so a small payload that costs an
attacker nothing can expand without bound on the receiver. Both receivers enforce
`WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES` (**8 MiB**) **while output is being read**, never after
materialising it, and dispatch nothing partially decompressed — so no world write can be driven by a
truncated payload. A refusal answers the originating request naming the bound.

Why 8 MiB: 4x the default staged-document gate (`wod.importMaxBytes`, 2 MiB) so every legitimate import
fits with headroom; 128x one frame, an order of magnitude above the 6.9x–12.5x measured on real actor
documents; and 6x _tighter_ than the memory a chunk-bombed message may already claim
(`MAX_CHUNKS_PER_MESSAGE * CHUNK_SIZE` = 50 MB), so it does not loosen the transport's existing
exposure. An operator who raises `WOD_IMPORT_MAX_BYTES` beyond 8 MiB must raise this too.

This is the direct analogue of the existing chunk-bomb guard, which exists for the same class of attack.

---

## 4. An undeliverable send fails its query immediately

`WebRTCPeer.sendMessage` **throws** when the transport refuses or the channel is closed, and
`FoundryConnector.query` clears the timeout, drops the pending entry, and rejects at once with an error
naming the transport, the byte size and the reason.

It used to log and return, so an undeliverable message surfaced a full deadline later as
`Query timeout: foundry-mcp-bridge.importActors` — for a message that never left the process. With no
application-level size check in front of the send any more, **this is the only mechanism that
distinguishes "could not send" from "sent and never answered"**, and the two need opposite recovery:
the first means the world was not written and a retry has nothing to reconcile; the second means the
write may have been applied, because a timed-out query is not cancelled Foundry-side.

Unsolicited internal notices (chunk-reassembly errors, chunk-timeout notices) use `trySendMessage`,
which never throws — they run inside an event handler or a timer where there is no caller to reject.

---

## 5. Sizes are measured in bytes

Serialized size is a **byte** quantity. The module's outbound fragmenter used to compare
`json.length` — UTF-16 code units — against SCTP's byte limit, so a check written to keep a message
under 64 KiB could not detect the case it existed for (this corpus is Spanish: one accented character
is 2 bytes, an emoji 4). It now measures UTF-8 bytes and cuts fragments on **code-point boundaries**,
so each fragment is a well-formed string and `fragments.join('')` reproduces the input exactly.

On the compressed path the defect cannot recur: gzip consumes an encoded byte buffer, so byte length is
the only quantity available.

---

## 6. The residual ceiling, and the refusal that names it

**Compression raises the bound; it does not remove it.** Already-compressed content does not compress:
an actor document carrying a 117,928-byte WebP as an embedded `data:` URI on both `img` and
`prototypeToken.texture.src` measures **369,259 bytes of JSON and ~246,000 compressed — 1.5x**, about
five frames once base64-enveloped. Ordinary actor documents measure 6.9x–12.5x.

**That spread is why the guard measures and never predicts.** `worldofdarkness-import-actor` asks the
transport for the size of the message it would _actually_ send
(`FoundryClient.measureQueryWireBytes` → the same encoder that does the sending) and refuses before
transmitting or writing anything when it exceeds one frame, naming the uncompressed size, the
compressed size, the bound, and the remedy: **sync the image to the Foundry server and repoint `img` /
`prototypeToken.texture.src`**, which the importer's avatar-preservation requirement mandates anyway.

Effective capacity at the measured 8–10x on actor JSON is roughly **400 KB of actor JSON per frame** —
an **observation**, never a guarantee code or callers may rely on.

### What binds, and where

| gate                                  | value                                      | where                                         |
| ------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| one frame (compressed + base64)       | 65,536 B                                   | `WEBRTC_CONSTANTS.MAX_MESSAGE_SIZE`           |
| fragment threshold (Foundry → server) | 51,200 B                                   | `WEBRTC_CONSTANTS.CHUNK_SIZE`                 |
| max decompressed size                 | 8 MiB                                      | `WEBRTC_CONSTANTS.MAX_DECOMPRESSED_BYTES`     |
| one staged document file              | 2 MiB default (max 32 MiB)                 | `wod.importMaxBytes` / `WOD_IMPORT_MAX_BYTES` |
| per-query **work** budget             | 51,200 B of _uncompressed_ JSON, max 1 MiB | `chunkBytes`                                  |

Each constant has **exactly one declaration per package** — `WEBRTC_CONSTANTS` in
`packages/mcp-server/src/config.ts` and a mirror in `packages/foundry-module/src/constants.ts` — and a
test asserts the two are equal, naming both files in the failure message. A comment is not a mechanism.
Importing `@foundry-mcp/shared` is not available: the Foundry module is browser-loaded ESM
(`module.json` `"esmodules"`) built by plain `tsc` with no bundler, so a bare specifier would not
resolve at runtime.

---

## 7. Deferred: fragmenting the server → Foundry direction

Fragmentation in this repo is **one-directional**: the module splits and the server reassembles; the
server → Foundry path does neither, and **the module has no reassembler at all**.

**The design, recorded so it is not re-derived: `compress → serialize → fragment if still over`, in
that order.** Compressing first is what makes fragmentation almost never fire; fragmenting first would
compress each fragment independently for a worse ratio, and the fragment count is not knowable until
after compression. Because the fragmenter splits the _final serialized message_, it stays agnostic to
what is inside — which is why the base64 **text** envelope matters.

**Why it is deferred rather than built:** compression clears every realistic actor with ~4x headroom,
and the expensive half of the work is a reassembler that does not exist. Building both in one change
buys nothing measurable and doubles the surface deployed in a single world-reload window.

**Trigger to build it:** a payload legitimately over one frame _after_ compression whose content cannot
be de-embedded — a genuine >400 KB actor, or a batch that must travel as one query. Nothing measured so
far reaches it.

### Not this: "import a zip archive of several actor files"

"Zip" in this document means **compression** — a byte stream smaller than its input. Actual **ZIP is an
archive container** (member headers plus a central directory), the wrong primitive for a single wire
message. **Importing a zip archive containing several actor JSON files is a different feature**: batch
_intake_, a sibling of the import tool's `actorPaths` staged files, with nothing to do with this
transport encoding. Recorded so the two stay distinguishable.

---

## 8. Deploy order is load-bearing

**The module ships first, then the server.**

1. Build and rsync the Foundry module, then have the **GM reload the world** (a Foundry server restart
   is not enough — the module is browser-side code).
2. Confirm the module version and `transport.compression.gzip` via `foundry-mcp-bridge.ping`.
3. Only then deploy the server. The compiled server handler lands in **`backend.bundle.cjs`**, not
   `index.bundle.cjs`.

Out of order gives a server compressing into a module that cannot decompress — worse than not shipping
at all. A new module against an old server is safe by construction: the old server never sends
compressed traffic, so the module never answers compressed.

---

## 9. Where the measurements live

- `packages/mcp-server/src/wire-format.test.ts` — the codec, the plain-set inequality, the bomb bound,
  the constants-equality mechanism, and the incompressible case.
- `packages/mcp-server/src/wire-format.corpus.test.ts` — the ratios over the **real** committed WoD
  corpus (49 splat scaffolds, 12 real exports, a Salvador-class ~97 KB document, the six-actor batch).
  Synthetic JSON compresses unrealistically well, so the corpus is real data; it lives in the sibling
  `wod20-char` submodule of the mago20 monorepo, so these tests skip (loudly) in a standalone clone of
  this repository and run in full inside the monorepo.
- `packages/mcp-server/src/transport-negotiation.test.ts` — the four-state matrix and the fail-fast send.
- `packages/foundry-module/src/wire-format.test.ts`,
  `packages/foundry-module/src/webrtc-connection.test.ts` — the module codec against the real browser
  primitives, and the byte-accurate fragmenter.
