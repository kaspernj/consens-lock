// @ts-check

/**
 * @typedef {object} LockHolder
 * @property {string} epochSource - Authority that minted this epoch.
 * @property {number} epoch - Monotonic fencing epoch for the lock name.
 * @property {string} holderId - Server-minted identity of the current lease holder.
 * @property {Date} leaseExpiresAt - When this lease expires without a renewal.
 * @property {string} name - Lock name.
 */
/**
 * @typedef {object} GrantResult
 * @property {number} [epoch] - Fencing epoch when granted.
 * @property {string} holderId - Holder the decision concerns.
 * @property {Date} [leaseExpiresAt] - Lease expiry when granted.
 * @property {string} name - Lock name.
 * @property {string} [ownerId] - Current holder when the name is busy.
 * @property {"acquired" | "already-held" | "busy" | "timeout"} status - Decision outcome.
 */
/**
 * @typedef {object} WaiterEntry
 * @property {number} deadlineAt - Absolute ms timestamp the waiter gives up at.
 * @property {number} enqueuedAt - When the waiter joined the FIFO queue.
 * @property {string} holderId - Server-minted identity waiting for the name.
 * @property {(result: GrantResult) => void} resolve - Completes the acquire request.
 * @property {ReturnType<typeof setTimeout>} timerId - Deadline timer for this waiter.
 */

/**
 * In-memory authority for the centralized lock server (STC-210 design §6-§8).
 *
 * All grant decisions happen synchronously in this class inside the daemon's
 * single event loop: the check-and-set has no `await` between reading
 * `#holders` and writing it, so two concurrent obtains can never both be
 * granted. This is what makes the old check-then-create race impossible.
 *
 * Locks are leases, not rows: a killed holder is reclaimed either by the
 * transport close (`releaseAllForHolder`) or by lease expiry in the sweeper,
 * and every grant bumps a monotonic per-name fencing epoch so a superseded
 * holder's writes can be rejected.
 */
export default class LockAuthority {
  /**
   * Runs constructor.
   * @param {object} args - Options.
   * @param {(name: string, epoch: number) => Promise<void>} [args.persistEpoch] - Durable epoch mirror, written on grant only.
   * @param {number} args.leaseMs - Lease duration for a granted lock.
   * @param {number} args.sweepIntervalMs - Interval between lease-expiry sweeps.
   */
  constructor({ leaseMs, persistEpoch, sweepIntervalMs }) {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive integer");
    if (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs <= 0) throw new Error("sweepIntervalMs must be a positive integer");

    this.leaseMs = leaseMs;
    this.persistEpoch = persistEpoch;
    this.sweepIntervalMs = sweepIntervalMs;
    /** @type {Map<string, LockHolder>} */
    this._holders = new Map();
    /** @type {Map<string, WaiterEntry[]>} */
    this._waiters = new Map();
    /** @type {Map<string, number>} */
    this._epochs = new Map();
    /** @type {Map<string, (name: string, epoch: number) => void>} */
    this._lostNotifiers = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._sweepTimer = null;
  }

  /** @type {Promise<void>} */
  #pendingPersist = Promise.resolve();

  /**
   * Starts the expired-lease sweeper. Runs until `stop()`.
   * @returns {void} - No return value.
   */
  start() {
    if (this._sweepTimer) return;

    this._sweepTimer = setInterval(() => {
      this.sweepExpiredLeases();
    }, this.sweepIntervalMs);

    // The sweeper must never keep the daemon's event loop alive on its own.
    this._sweepTimer.unref?.();
  }

  /**
   * Stops the sweeper and fails every queued waiter.
   * @returns {void} - No return value.
   */
  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }

    for (const waiters of this._waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timerId);
        waiter.resolve({ holderId: waiter.holderId, name: waiter.name ?? "", status: "timeout" });
      }
    }

    this._waiters.clear();
  }

  /**
   * Registers the per-holder push used to tell a holder it was fenced.
   * @param {string} holderId - Server-minted holder identity.
   * @param {(name: string, epoch: number) => void} notifyLost - Push invoked when this holder loses a lease.
   * @returns {void} - No return value.
   */
  registerHolder(holderId, notifyLost) {
    this._lostNotifiers.set(holderId, notifyLost);
  }

  /**
   * Removes a holder's lost-notifier (transport teardown).
   * @param {string} holderId - Server-minted holder identity.
   * @returns {void} - No return value.
   */
  unregisterHolder(holderId) {
    this._lostNotifiers.delete(holderId);
  }

  /**
   * Runs the current fencing epoch for a name, without granting anything.
   * @param {string} name - Lock name.
   * @returns {number} - Current epoch (0 when the name was never granted).
   */
  currentEpoch(name) {
    return this._epochs.get(name) ?? 0;
  }

  /**
   * Seeds a persisted epoch at boot so a daemon restart cannot rewind the
   * fencing sequence. Only raises the value; never lowers it.
   * @param {string} name - Lock name.
   * @param {number} epoch - Persisted epoch from the durable mirror.
   * @returns {void} - No return value.
   */
  seedEpoch(name, epoch) {
    if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`Invalid persisted epoch for lock '${name}'`);

    if ((this._epochs.get(name) ?? 0) < epoch) {
      this._epochs.set(name, epoch);
    }
  }

  /**
   * Grants immediately when free, otherwise returns `busy` (maps to
   * `withAdvisoryLockOrFail`). Never queues.
   * @param {object} args - Request.
   * @param {string} args.holderId - Server-minted holder identity.
   * @param {string} args.name - Lock name.
   * @returns {GrantResult} - Decision.
   */
  tryAcquire({ holderId, name }) {
    const existingHolder = this._holders.get(name);

    if (existingHolder) {
      if (existingHolder.holderId === holderId) {
        return { epoch: existingHolder.epoch, holderId, leaseExpiresAt: existingHolder.leaseExpiresAt, name, status: "already-held" };
      }

      return { holderId, name, ownerId: existingHolder.holderId, status: "busy" };
    }

    return this.#grant(name, holderId);
  }

  /**
   * Waits in the server-side FIFO queue for the name until `deadlineAt`
   * (maps to `withAdvisoryLock`). Absolute deadlines keep the remaining
   * budget across client reconnects.
   * @param {object} args - Request.
   * @param {string} args.holderId - Server-minted holder identity.
   * @param {number} args.deadlineAt - Absolute ms timestamp to give up at.
   * @param {string} args.name - Lock name.
   * @returns {Promise<GrantResult>} - Resolves on grant, already-held, or timeout.
   */
  acquire({ deadlineAt, holderId, name }) {
    const existingHolder = this._holders.get(name);

    if (existingHolder) {
      if (existingHolder.holderId === holderId) {
        return Promise.resolve({ epoch: existingHolder.epoch, holderId, leaseExpiresAt: existingHolder.leaseExpiresAt, name, status: "already-held" });
      }

      if (deadlineAt <= Date.now()) {
        return Promise.resolve({ holderId, name, ownerId: existingHolder.holderId, status: "timeout" });
      }

      return new Promise((resolve) => {
        const timerId = setTimeout(() => {
          this.#removeWaiter(name, holderId);
          resolve({ holderId, name, status: "timeout" });
        }, Math.max(1, deadlineAt - Date.now()));

        timerId.unref?.();

        const queue = this._waiters.get(name) || [];
        const waiters = queue.map((waiter) => ({ ...waiter }));

        waiters.push({ deadlineAt, enqueuedAt: Date.now(), holderId, name, resolve, timerId });
        this._waiters.set(name, waiters);
      });
    }

    return Promise.resolve(this.#grant(name, holderId));
  }

  /**
   * Renews a lease, with the fencing check: a stale epoch loses the lock.
   * @param {object} args - Request.
   * @param {number} args.epoch - Epoch the holder believes it holds.
   * @param {string} args.holderId - Server-minted holder identity.
   * @param {string} args.name - Lock name.
   * @returns {{currentEpoch?: number, epoch?: number, leaseExpiresAt?: Date, status: "renewed" | "lost" | "not-found"}} - Decision.
   */
  renew({ epoch, holderId, name }) {
    const existingHolder = this._holders.get(name);

    if (!existingHolder) return { status: "not-found" };

    if (existingHolder.holderId !== holderId || existingHolder.epoch !== epoch) {
      return { currentEpoch: existingHolder.epoch, status: "lost" };
    }

    existingHolder.leaseExpiresAt = new Date(Date.now() + this.leaseMs);

    return { epoch: existingHolder.epoch, leaseExpiresAt: existingHolder.leaseExpiresAt, status: "renewed" };
  }

  /**
   * Releases a lease and hands the name to the next FIFO waiter.
   * @param {object} args - Request.
   * @param {number} [args.epoch] - Epoch the holder believes it holds.
   * @param {string} args.holderId - Server-minted holder identity.
   * @param {string} args.name - Lock name.
   * @returns {{currentEpoch?: number, status: "released" | "not-holder" | "not-found"}} - Decision.
   */
  release({ epoch, holderId, name }) {
    const existingHolder = this._holders.get(name);

    if (!existingHolder) return { status: "not-found" };

    if (existingHolder.holderId !== holderId) {
      return { currentEpoch: existingHolder.epoch, status: "not-holder" };
    }

    if (epoch !== undefined && existingHolder.epoch !== epoch) {
      return { currentEpoch: existingHolder.epoch, status: "not-holder" };
    }

    this._holders.delete(name);
    this.#drainWaiter(name);

    return { status: "released" };
  }

  /**
   * Releases every lease owned by a holder (transport close backstop).
   * @param {string} holderId - Server-minted holder identity.
   * @returns {string[]} - Names that were released.
   */
  releaseAllForHolder(holderId) {
    const releasedNames = [];

    for (const [name, holder] of [...this._holders.entries()]) {
      if (holder.holderId !== holderId) continue;

      this._holders.delete(name);
      releasedNames.push(name);
      this.#drainWaiter(name);
    }

    for (const [name, waiters] of [...this._waiters.entries()]) {
      if (waiters.some((waiter) => waiter.holderId === holderId)) {
        this.#removeWaiter(name, holderId);
      }
    }

    return releasedNames;
  }

  /**
   * Runs who holds a name (diagnostics).
   * @param {string} name - Lock name.
   * @returns {{epoch: number, holderId: string, leaseExpiresAt: Date, name: string} | null} - Current holder, or null.
   */
  whoHolds(name) {
    const holder = this._holders.get(name);

    if (!holder) return null;

    return { epoch: holder.epoch, holderId: holder.holderId, leaseExpiresAt: holder.leaseExpiresAt, name };
  }

  /**
   * Runs all live holders with their waiter counts (feeds the client status surface).
   * @returns {{epoch: number, holderId: string, leaseExpiresAt: Date, name: string, waiterCount: number}[]} - Live holders.
   */
  list() {
    return [...this._holders.values()].map((holder) => ({
      epoch: holder.epoch,
      holderId: holder.holderId,
      leaseExpiresAt: holder.leaseExpiresAt,
      name: holder.name,
      waiterCount: this._waiters.get(holder.name)?.length ?? 0
    }));
  }

  /**
   * Expires leases that passed their deadline without a renewal, wakes each
   * name's waiter queue, and notifies the dead holder it was fenced.
   * @returns {string[]} - Names reclaimed by the sweep.
   */
  sweepExpiredLeases() {
    const now = Date.now();
    const sweptNames = [];

    for (const [name, holder] of [...this._holders.entries()]) {
      if (holder.leaseExpiresAt.getTime() > now) continue;

      this._holders.delete(name);
      sweptNames.push(name);
      this.#notifyLost(holder.holderId, name, holder.epoch);
      this.#drainWaiter(name);
    }

    return sweptNames;
  }

  /**
   * Grants a name to a holder: bump the monotonic epoch, install the lease,
   * and mirror the epoch durably. The check-and-set itself is synchronous so
   * no other grant can interleave with it.
   * @param {string} name - Lock name.
   * @param {string} holderId - Server-minted holder identity.
   * @returns {GrantResult} - Grant decision.
   */
  #grant(name, holderId) {
    const epoch = (this._epochs.get(name) ?? 0) + 1;
    const leaseExpiresAt = new Date(Date.now() + this.leaseMs);

    this._epochs.set(name, epoch);
    this._holders.set(name, { epoch, holderId, leaseExpiresAt, name });

    if (this.persistEpoch) {
      // Chain the durable mirror write so it stays ordered per grant and can
      // be awaited by the request handler before responding. The in-memory
      // epoch is the authority; a failed mirror must not fail the grant, but
      // it is surfaced so operators can see it.
      this.#pendingPersist = this.#pendingPersist.then(async () => {
        try {
          await this.persistEpoch(name, epoch);
        } catch {
          this.#reportPersistFailure(name, epoch);
        }
      });
    }

    return { epoch, holderId, leaseExpiresAt, name, status: "acquired" };
  }

  /**
   * Awaits all chained durable-epoch writes issued so far. Request handlers
   * call this before responding so the mirror write completes inside the
   * request's connection scope instead of racing transport/test teardown.
   * @returns {Promise<void>} - Resolves when the epoch mirror is up to date.
   */
  async flushEpochWrites() {
    await this.#pendingPersist;
  }

  /**
   * Reports a durable-epoch mirror failure on the process error channel.
   * @param {string} name - Lock name.
   * @param {number} epoch - Epoch that failed to persist.
   * @returns {void} - No return value.
   */
  #reportPersistFailure(name, epoch) {
    process.emitWarning(`Failed to persist fencing epoch for lock '${name}' at epoch ${epoch}`, "LockEpochPersistFailure");
  }

  /**
   * Hands a released/expired name to the oldest waiter, honouring its own
   * deadline (an already-expired waiter is dropped, not granted).
   * @param {string} name - Lock name.
   * @returns {void} - No return value.
   */
  #drainWaiter(name) {
    const queue = this._waiters.get(name);

    if (!queue || queue.length === 0) return;

    const nextWaiter = queue.shift();

    if (queue.length === 0) {
      this._waiters.delete(name);
    }

    clearTimeout(nextWaiter.timerId);

    if (nextWaiter.deadlineAt <= Date.now()) {
      this.#drainWaiter(name);
      nextWaiter.resolve({ holderId: nextWaiter.holderId, name, status: "timeout" });
      return;
    }

    const grant = this.#grant(name, nextWaiter.holderId);

    nextWaiter.resolve({ ...grant, name });
  }

  /**
   * Removes one waiter from a name's queue (deadline or disconnect).
   * @param {string} name - Lock name.
   * @param {string} holderId - Server-minted holder identity.
   * @returns {void} - No return value.
   */
  #removeWaiter(name, holderId) {
    const queue = this._waiters.get(name);

    if (!queue) return;

    const remainingWaiters = [];

    for (const waiter of queue) {
      if (waiter.holderId === holderId) {
        clearTimeout(waiter.timerId);
        waiter.resolve({ holderId: waiter.holderId, name, status: "timeout" });
        continue;
      }

      remainingWaiters.push(waiter);
    }

    if (remainingWaiters.length === 0) {
      this._waiters.delete(name);
      return;
    }

    this._waiters.set(name, remainingWaiters);
  }

  /**
   * Pushes a `lost` notification to a holder that was fenced.
   * @param {string} holderId - Server-minted holder identity.
   * @param {string} name - Lock name.
   * @param {number} epoch - Epoch the holder lost.
   * @returns {void} - No return value.
   */
  #notifyLost(holderId, name, epoch) {
    const notifyLost = this._lostNotifiers.get(holderId);

    if (!notifyLost) return;

    try {
      notifyLost(name, epoch);
    } catch {
      // A dead transport cannot receive the push; the lease is already gone.
    }
  }
}
