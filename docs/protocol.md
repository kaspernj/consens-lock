# Consens Lock server protocol (v2)

The centralized advisory-lock daemon for the Velocious advisory-lock backend
chain (tier (b) of `velocious/docs/advisory-lock-backends.md`). It holds and
remembers locks **in its own process memory** — a held lock never pins a
database connection. SQLite is the daemon's own store and is used only for the
durable fencing-epoch mirror, written on grant only.

## Transport

Velocious websocket (`/websocket`), 1:1 connection role `lock`
(`configuration.registerWebsocketConnection("lock", LockConnection)`).
All messages are JSON objects on that connection. Requests carry a
client-generated `correlationId`; every response echoes it.

Handshake: the client opens the connection with
`params: {authToken, protocolVersion: 2}`. The server verifies auth **first**
(fail closed), checks the protocol version, mints a server-side `holderId`,
and replies `{type: "hello-ack", protocolVersion, leaseMs}`.

## Auth

Shared secret via `CONSENS_LOCK_AUTH_TOKEN`. Comparison is constant-time.
**Fail closed:** with no configured token the daemon refuses every connection
and every HTTP route. HTTP routes take `Authorization: Bearer <token>`.

## Messages

| Request | Response | Notes |
|---|---|---|
| `acquire {name, timeoutMs}` | `acquired {epoch, leaseExpiresAt}` / `timeout` | Server-side FIFO waiter queue; `timeoutMs` bounds the wait. The response is pushed when the grant settles (the socket stays usable while queued). |
| `try-acquire {name}` | `acquired {epoch, leaseExpiresAt}` / `busy {ownerId}` | Maps to `withAdvisoryLockOrFail`. |
| `renew {name, epoch}` | `renewed {leaseExpiresAt}` / `lost {currentEpoch}` / `not-found` | Renewal with fencing check. |
| `release {name, epoch?}` | `released` / `not-holder {currentEpoch}` / `not-found` | Idempotent; `not-holder` after an epoch bump is expected. |
| `who-holds {name}` | `{holder} \| {holder: null}` | Diagnostics. |
| `list` | `{holders: [{name, holderId, epoch, leaseExpiresAt, waiterCount}]}` | Feeds the client status surface. |

Asynchronous push: `lost {name, epoch}` — sent when a lease expires or is
otherwise fenced, so a holder learns without waiting for its next renew.

## Ownership

`holderId` is minted by the server at connection open and bound to the
transport. Client-supplied owner ids are ignored entirely: a client can only
renew/release locks held by its own connection. A transport close
(`connection-close`, socket close, or grace expiry) releases every lease of
that connection immediately.

## Leases

- `leaseMs` (default 30 000, `CONSENS_LOCK_LEASE_MS`) per grant.
- The client renews every third of the lease (`renew` request).
- Dead-holder detection is **both** mechanisms: TCP/connection close
  (immediate) and lease expiry without renewal (sweeper, backstop for
  half-open connections). `CONSENS_LOCK_SWEEP_INTERVAL_MS` sets the sweep
  interval.
- The Velocious websocket session grace window is set to 2 seconds on this
  daemon so a dropped transport tears down fast instead of parking resumable
  sessions for five minutes.

## Fencing tokens

Every grant bumps a **monotonic epoch per lock name** (persisted in the
`lock_epochs` table on grant only, so a daemon restart cannot rewind it).
`renew`/`release` must present the holder's epoch; a stale epoch returns
`lost`/`not-holder`. A superseded holder must treat its critical section as
compromised — the framework contract is: the server guarantees at most one
*lease holder*; the application guarantees at most one *effective writer* by
honouring the epoch (e.g. an `UPDATE ... WHERE lock_epoch = :epoch` guard).

## Concurrency contract

All grant decisions run synchronously in the daemon's single event loop: the
check-and-set on the holder map has no `await` between read and write, so two
concurrent obtains can never both be granted — the second gets `busy`. The old
check-then-create race (find-then-create against the unique index) is gone:
the in-memory map is the authority.

## HTTP compatibility surface

`POST /locks/obtain`, `POST /locks/release` and `GET /locks/status` remain for
legacy clients, now bearer-authenticated and ignoring client-supplied
`ownerId`. HTTP obtains get a one-shot holder id and are reclaimed by the
lease sweeper; the websocket connection is the intended surface for real
holds.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3006` | Bind address. |
| `CONSENS_LOCK_AUTH_TOKEN` | unset (fail closed) | Shared secret. |
| `CONSENS_LOCK_LEASE_MS` | 30000 | Lease duration. |
| `CONSENS_LOCK_RENEW_INTERVAL_MS` | 10000 | Client renewal suggestion (advertised via `hello-ack.leaseMs`). |
| `CONSENS_LOCK_SWEEP_INTERVAL_MS` | 200 | Expired-lease sweep interval. |
