# Revive consens-lock into the centralized lock server (leases + fencing tokens)

- The daemon now holds locks in its own process memory: leases with renewal,
  an expired-lease sweeper, and a server-side FIFO waiter queue with a bounded
  acquire timeout. A held lock no longer pins a database connection.
- Monotonic fencing epoch per lock name, persisted in `lock_epochs` on grant
  only, so a daemon restart cannot rewind the fencing sequence. Superseded
  holders are rejected by `renew`/`release` epoch checks and pushed a `lost`
  notification.
- Ownership is bound to the authenticated websocket transport; client-supplied
  owner ids are ignored.
- Shared-secret auth (`CONSENS_LOCK_AUTH_TOKEN`, constant-time compare) on the
  websocket handshake and the HTTP routes, fail closed when unconfigured.
- Wire protocol versioned (v2) with `correlationId` request/response
  correlation over the Velocious `lock` websocket connection.
- The old check-then-create race is gone: grants are a synchronous
  check-and-set in the daemon's event loop; concurrent obtains return `busy`.
- Adds Forgejo Actions CI (lint + tests for both packages), `docs/protocol.md`
  describing the protocol and the lease/fencing model.
