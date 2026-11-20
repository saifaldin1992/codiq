/**
 * POS-offline v1 — the till's enqueue-then-send queue (IndexedDB, zero deps).
 *
 * Money rules this module is built around:
 * - The payload persisted at enqueue is resent VERBATIM. The server fingerprint
 *   hashes lines in array order + discountIqd + totalIqd, so rebuilding or
 *   reordering at flush time turns an honest retry into a terminal 409
 *   TICKET_REUSED. Only deviceReportedAt/customerName are excluded from the
 *   fingerprint — nothing else may vary between attempts.
 * - The flush is a strictly-sequential FIFO singleton. Arrival order decides
 *   shortfall attribution server-side, and parallel flushes of overlapping
 *   variants contend inside Serializable transactions.
 * - Session-family refusals PAUSE the whole queue behind a re-login banner;
 *   they never dead-letter a ticket — «discard on any 4xx» deletes real money.
 * - Offline is a CONCLUSION from fetch failure (plus a ~4s abort), never from
 *   navigator.onLine: a dead server answers connection-refused with onLine
 *   still true. The 'online' event is a hint that triggers a flush, nothing more.
 * - A lost STATE write after a successful enqueue is replay-safe: a rebooted
 *   till re-sends the ticket and the server answers 200 replayed:true. A lost
 *   ENQUEUE write is not — the caller must show the hard failure to the cashier.
 */

export type QueueShortfall = { variantId: string; shortfallQty: number };
export type QueueResult = { orderNumber: string; replayed: boolean; shortfalls: QueueShortfall[] };
export type QueueLineLabel = { variantId: string; label: string };
export type QueueRecordState = "pending" | "failed" | "confirmed";

export type QueueRecord = {
  ticketId: string;
  deviceId: string;
  /** The exact serialized POST /pos/tickets body — resent verbatim on retry. */
  payload: string;
  state: QueueRecordState;
  createdAt: number;
  attempts: number;
  lastError: { code: string; message: string } | null;
  labels: QueueLineLabel[];
  totalIqd: number;
  changeDue: number;
  result: QueueResult | null;
};

/** revoked/gone halt everything for the CURRENT device; session pauses until re-login. */
export type QueueHalt = null | "session" | "revoked" | "gone";

export type QueueSnapshot = {
  /** FIFO order — createdAt ascending. */
  records: QueueRecord[];
  pending: number;
  failed: number;
  confirmed: number;
  flushing: boolean;
  offline: boolean;
  halt: QueueHalt;
};

export type ConfirmOutcome =
  | { kind: "unsaved" }
  | { kind: "confirmed"; result: QueueResult }
  | { kind: "queued" }
  | { kind: "rejected"; message: string }
  | { kind: "revoked" };

type AttemptOutcome =
  | { kind: "success"; result: QueueResult }
  | { kind: "network" }
  | { kind: "http"; status: number; code: string; message: string };

const DB_VERSION = 1;
const FETCH_TIMEOUT_MS = 4000;
const CONFIRM_WAIT_MS = 4200;
const BACKOFF_MS = [5000, 10000, 30000, 60000];
const CONFIRMED_KEPT = 50;

// ------------------------------------------------------------------ IndexedDB
// Hand-rolled wrapper: the repo carries no idb/dexie/localforage and a
// one-route queue does not earn the dependency.

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("idb request failed"));
  });
}

function openTillDb(slug: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const open = indexedDB.open(`codiq-till:${slug}`, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "ticketId" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("idb open failed"));
    open.onblocked = () => reject(new Error("idb open blocked"));
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown, key?: string): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  const request = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
  return requestPromise(request).then(() => undefined);
}

/**
 * MONEY writes resolve at transaction COMMIT, not request success: IndexedDB
 * can still abort after onsuccess (quota or I/O surfacing at commit), and a
 * sale reported saved on a write that never hit disk dies silently on the
 * next reload — the exact failure the hard red banner exists for. The kv
 * conveniences keep the cheaper request idiom.
 */
function idbPutDurable(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("idb tx aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("idb tx failed"));
  });
}

function idbGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return requestPromise(db.transaction(store, "readonly").objectStore(store).get(key));
}

function idbGetAll(db: IDBDatabase, store: string): Promise<unknown[]> {
  return requestPromise(db.transaction(store, "readonly").objectStore(store).getAll());
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return requestPromise(db.transaction(store, "readwrite").objectStore(store).delete(key)).then(() => undefined);
}

// -------------------------------------------------------------- classification

const SESSION_CODES = ["MISSING_SESSION", "STAFF_ACCESS_REVOKED", "STAFF_PERMISSION_DENIED", "STORE_BOUNDARY_DENIED", "CSRF_ORIGIN_DENIED"];

function classifyHttp(status: number, code: string): "session" | "revoked" | "gone" | "dead" | "retry" {
  if (SESSION_CODES.indexOf(code) !== -1) return "session";
  if (code === "DEVICE_REVOKED") return "revoked";
  if (status === 404) return "gone";
  // An unrecognized 401/403 is still the auth family: pausing keeps the money;
  // dead-lettering on a guess deletes it.
  if (status === 401 || status === 403) return "session";
  // Deterministic refusals — retrying forever is the poison-ticket loop the
  // server's pre-transaction 422s exist to prevent.
  if (status === 409 || status === 422) return "dead";
  return "retry";
}

function isQueueRecord(value: unknown): value is QueueRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as QueueRecord;
  return typeof record.ticketId === "string"
    && typeof record.deviceId === "string"
    && typeof record.payload === "string"
    && (record.state === "pending" || record.state === "failed" || record.state === "confirmed")
    && typeof record.createdAt === "number";
}

// -------------------------------------------------------------------- engine

class TillQueue {
  private readonly slug: string;
  private readonly url: string;
  private db: IDBDatabase | null = null;
  private ready: Promise<void> | null = null;
  private records: QueueRecord[] = [];
  private listeners: (() => void)[] = [];
  private flushing = false;
  private offline = false;
  private halt: QueueHalt = null;
  private activeDeviceId: string | null = null;
  private backoffStep = 0;
  private timer: number | null = null;
  private snapshot: QueueSnapshot;

  constructor(slug: string) {
    this.slug = slug;
    this.url = `/api/merchant/stores/${encodeURIComponent(slug)}/pos/tickets`;
    this.snapshot = { records: [], pending: 0, failed: 0, confirmed: 0, flushing: false, offline: false, halt: null };
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.resetBackoff();
        this.triggerFlush();
      });
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  };

  getSnapshot = (): QueueSnapshot => this.snapshot;

  /** Idempotent; re-invocations (remounts) just re-trigger a flush. */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.load();
      return this.ready;
    }
    this.triggerFlush();
    return this.ready;
  }

  /** The current pairing decides whether a 403/404 halts or dead-letters. */
  setActiveDevice(deviceId: string | null): void {
    if (this.activeDeviceId === deviceId) return;
    this.activeDeviceId = deviceId;
    // A halt raised by a PREVIOUS pairing's ticket must not outlive re-pairing:
    // that ticket can never sync (revocation is permanent) and would otherwise
    // hold the new device's queue hostage at the head.
    if (deviceId && (this.halt === "revoked" || this.halt === "gone")) {
      const head = this.nextPending();
      if (head && head.deviceId !== deviceId) this.halt = null;
    }
    this.emit();
    this.triggerFlush();
  }

  /** Clears a revoked/gone halt after the cashier re-pairs («تحديث الأجهزة»). */
  resetHalt(): void {
    if (this.halt === null) return;
    this.halt = null;
    this.resetBackoff();
    this.emit();
  }

  /**
   * ENQUEUE-THEN-SEND. With no other pending work the immediate attempt keeps
   * today's online behavior: an HTTP refusal of the just-rung sale (cart still
   * on screen, nothing owed) removes the record and surfaces to the panel;
   * only NETWORK failure classifies as offline and leaves the sale queued.
   */
  async confirmEnqueue(record: QueueRecord): Promise<ConfirmOutcome> {
    await this.init();
    const otherPending = this.records.filter((entry) => entry.ticketId !== record.ticketId && entry.state === "pending").length;
    const saved = await this.enqueue(record);
    if (!saved) return { kind: "unsaved" };

    if (otherPending === 0 && this.halt === null && !this.flushing) {
      this.flushing = true;
      this.emit();
      try {
        const outcome = await this.attempt(record);
        if (outcome.kind === "success") {
          record.state = "confirmed";
          record.result = outcome.result;
          record.lastError = null;
          this.offline = false;
          this.resetBackoff();
          await this.persist(record);
          await this.pruneConfirmed();
          return { kind: "confirmed", result: outcome.result };
        }
        if (outcome.kind === "network") {
          this.offline = true;
          this.scheduleRetry();
          return { kind: "queued" };
        }
        this.offline = false;
        // Same classification as the background flush — the session family
        // (and a 404'd route) is about the CALLER, not the ticket: cash has
        // already changed hands, so the record stays pending behind the same
        // halt the flush would raise. The direct path deleting what the flush
        // keeps was a money-losing asymmetry. Removal stays blessed only for
        // the deterministic refusals: a revoked device and the terminal 422s
        // ("the server refused; nothing is owed").
        const verdict = classifyHttp(outcome.status, outcome.code);
        if (verdict === "session" || verdict === "gone") {
          this.halt = verdict;
          return { kind: "queued" };
        }
        if (verdict === "retry") {
          this.scheduleRetry();
          return { kind: "queued" };
        }
        await this.remove(record.ticketId);
        if (verdict === "revoked") return { kind: "revoked" };
        return { kind: "rejected", message: outcome.message };
      } finally {
        this.flushing = false;
        this.emit();
      }
    }

    // Older tickets go first (FIFO decides shortfall attribution); the confirm
    // click waits a bounded moment, then hands the cashier the pending card.
    this.triggerFlush();
    const settled = await this.waitForSettle(record.ticketId, CONFIRM_WAIT_MS);
    if (settled && settled.state === "confirmed" && settled.result) return { kind: "confirmed", result: settled.result };
    return { kind: "queued" };
  }

  /** Failed → pending again (VARIANT_NOT_FOUND un-poisons via restore-from-trash). */
  async retryTicket(ticketId: string): Promise<void> {
    const record = this.findRecord(ticketId);
    if (!record || record.state !== "failed") return;
    record.state = "pending";
    await this.persist(record);
    this.emit();
    this.resetBackoff();
    this.triggerFlush();
  }

  // ------------------------------------------------------------------- kv

  async saveCatalog<P>(products: P[]): Promise<void> {
    try {
      await this.init();
      if (this.db) await idbPut(this.db, "kv", { products, fetchedAt: Date.now() }, "catalog");
    } catch { /* convenience — the live catalog is still on screen */ }
  }

  async loadCatalog<P>(): Promise<{ products: P[]; fetchedAt: number } | null> {
    try {
      await this.init();
      if (!this.db) return null;
      const value = (await idbGet(this.db, "kv", "catalog")) as { products?: P[]; fetchedAt?: number } | undefined;
      if (!value || !Array.isArray(value.products) || typeof value.fetchedAt !== "number") return null;
      return { products: value.products, fetchedAt: value.fetchedAt };
    } catch {
      return null;
    }
  }

  /** Mirrors the optimistic post-sale decrement so consecutive offline sales see declining numbers. */
  async mirrorStockSold(sold: { variantId: string; quantity: number }[]): Promise<void> {
    try {
      await this.init();
      if (!this.db) return;
      const value = (await idbGet(this.db, "kv", "catalog")) as
        | { products?: { variants?: { id: string; stockQuantity: number }[] }[]; fetchedAt?: number }
        | undefined;
      if (!value || !Array.isArray(value.products)) return;
      for (const product of value.products) {
        if (!Array.isArray(product.variants)) continue;
        for (const variant of product.variants) {
          let quantity = 0;
          for (const line of sold) {
            if (line.variantId === variant.id) quantity += line.quantity;
          }
          if (quantity > 0) variant.stockQuantity = Math.max(0, variant.stockQuantity - quantity);
        }
      }
      await idbPut(this.db, "kv", value, "catalog");
    } catch { /* convenience */ }
  }

  async saveDevice<D>(device: D): Promise<void> {
    try {
      await this.init();
      if (this.db) await idbPut(this.db, "kv", device, "device");
    } catch { /* convenience — pairing stays online-only on first boot */ }
  }

  async loadDevice<D>(): Promise<D | null> {
    try {
      await this.init();
      if (!this.db) return null;
      const value = (await idbGet(this.db, "kv", "device")) as D | undefined;
      return value ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- internals

  private async load(): Promise<void> {
    try {
      this.db = await openTillDb(this.slug);
      const rows = await idbGetAll(this.db, "queue");
      this.records = rows.filter(isQueueRecord);
      this.sortRecords();
    } catch {
      this.db = null;
    }
    this.emit();
    this.triggerFlush();
  }

  private async enqueue(record: QueueRecord): Promise<boolean> {
    try {
      await this.init();
      if (!this.db) return false;
      await idbPutDurable(this.db, "queue", record);
    } catch {
      return false;
    }
    this.records = this.records.filter((entry) => entry.ticketId !== record.ticketId);
    this.records.push(record);
    this.sortRecords();
    this.emit();
    return true;
  }

  private triggerFlush(): void {
    // A session pause re-tries on every trigger (mount, enqueue, 'online'):
    // after re-login one request drains the queue, and while the session is
    // still dead a single refusal re-pauses it. Revoked/gone stay halted until
    // resetHalt/setActiveDevice decide otherwise.
    if (this.halt === "session") this.halt = null;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.halt !== null) return;
    this.flushing = true;
    this.emit();
    try {
      for (;;) {
        if (this.halt !== null) break;
        const next = this.nextPending();
        if (!next) break;
        const outcome = await this.attempt(next);
        if (outcome.kind === "success") {
          next.state = "confirmed";
          next.result = outcome.result;
          next.lastError = null;
          this.offline = false;
          this.resetBackoff();
          await this.persist(next);
          await this.pruneConfirmed();
          this.emit();
          continue;
        }
        if (outcome.kind === "network") {
          this.offline = true;
          this.scheduleRetry();
          break;
        }
        this.offline = false;
        const verdict = classifyHttp(outcome.status, outcome.code);
        if (verdict === "retry") {
          this.scheduleRetry();
          break;
        }
        if (verdict === "session") {
          this.halt = "session";
          break;
        }
        if (verdict === "revoked" || verdict === "gone") {
          next.lastError = { code: outcome.code, message: outcome.message };
          // A ticket from a PREVIOUS pairing can never sync — revocation is
          // permanent — and pending at the head it would block the new
          // device's queue forever. It dead-letters LOUDLY (the drawer keeps
          // its lines and totals for the manager to re-ring); a refusal of
          // the CURRENT device halts everything, remainder kept pending.
          if (this.activeDeviceId && next.deviceId !== this.activeDeviceId) {
            next.state = "failed";
            await this.persist(next);
            this.emit();
            continue;
          }
          this.halt = verdict;
          await this.persist(next);
          break;
        }
        next.state = "failed";
        next.lastError = { code: outcome.code, message: outcome.message };
        await this.persist(next);
        this.emit();
      }
    } finally {
      this.flushing = false;
      this.emit();
    }
  }

  private async attempt(record: QueueRecord): Promise<AttemptOutcome> {
    record.attempts += 1;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: record.payload,
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) {
        // HTTP 200 (replayed:true) and 201 are BOTH success — the replay path
        // exists precisely for a committed sale whose response was lost.
        const body = payload as { order?: { orderNumber?: string }; replayed?: boolean; shortfalls?: QueueShortfall[] } | null;
        const orderNumber = body?.order?.orderNumber;
        if (typeof orderNumber !== "string") return { kind: "network" };
        return {
          kind: "success",
          result: { orderNumber, replayed: body?.replayed === true, shortfalls: body?.shortfalls ?? [] },
        };
      }
      if (response.status >= 500) return { kind: "network" };
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      return {
        kind: "http",
        status: response.status,
        code: typeof error?.code === "string" ? error.code : "",
        message: typeof error?.message === "string" && error.message ? error.message : "تعذر إتمام العملية.",
      };
    } catch {
      // Abort (~4s) and TypeError both mean the server is unreachable — the
      // 'offline' conclusion. Aborting a request the server still completes is
      // safe: the retry replays the same ticketId and gets 200 replayed:true.
      return { kind: "network" };
    } finally {
      window.clearTimeout(timer);
    }
  }

  private scheduleRetry(): void {
    if (this.timer !== null || this.halt !== null) return;
    const delay = BACKOFF_MS[Math.min(this.backoffStep, BACKOFF_MS.length - 1)]!;
    this.backoffStep += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private resetBackoff(): void {
    this.backoffStep = 0;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async persist(record: QueueRecord): Promise<void> {
    // A lost state write is replay-safe (see module header) — never a banner.
    try {
      if (this.db) await idbPut(this.db, "queue", record);
    } catch { /* replay-safe */ }
  }

  private async remove(ticketId: string): Promise<void> {
    try {
      if (this.db) await idbDelete(this.db, "queue", ticketId);
    } catch { /* a ghost row only replays a refusal, never a sale */ }
    this.records = this.records.filter((entry) => entry.ticketId !== ticketId);
    this.emit();
  }

  private async pruneConfirmed(): Promise<void> {
    const confirmed = this.records
      .filter((entry) => entry.state === "confirmed")
      .sort((a, b) => b.createdAt - a.createdAt);
    const excess = confirmed.slice(CONFIRMED_KEPT);
    if (excess.length === 0) return;
    const excessIds: string[] = [];
    for (const entry of excess) {
      excessIds.push(entry.ticketId);
      try {
        if (this.db) await idbDelete(this.db, "queue", entry.ticketId);
      } catch { /* convenience */ }
    }
    this.records = this.records.filter((entry) => excessIds.indexOf(entry.ticketId) === -1);
  }

  private waitForSettle(ticketId: string, ms: number): Promise<QueueRecord | null> {
    return new Promise<QueueRecord | null>((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let timer = 0;
      const finish = (record: QueueRecord | null) => {
        if (done) return;
        done = true;
        if (unsubscribe) unsubscribe();
        window.clearTimeout(timer);
        resolve(record);
      };
      const check = () => {
        const record = this.findRecord(ticketId);
        if (!record || record.state !== "pending") finish(record ?? null);
      };
      unsubscribe = this.subscribe(check);
      timer = window.setTimeout(() => finish(this.findRecord(ticketId)), ms);
      check();
    });
  }

  private findRecord(ticketId: string): QueueRecord | null {
    for (const record of this.records) {
      if (record.ticketId === ticketId) return record;
    }
    return null;
  }

  private nextPending(): QueueRecord | null {
    for (const record of this.records) {
      if (record.state === "pending") return record;
    }
    return null;
  }

  private sortRecords(): void {
    this.records.sort((a, b) => a.createdAt - b.createdAt);
  }

  private emit(): void {
    let pending = 0;
    let failed = 0;
    let confirmed = 0;
    for (const record of this.records) {
      if (record.state === "pending") pending += 1;
      else if (record.state === "failed") failed += 1;
      else confirmed += 1;
    }
    this.snapshot = {
      records: this.records.slice(),
      pending,
      failed,
      confirmed,
      flushing: this.flushing,
      offline: this.offline,
      halt: this.halt,
    };
    for (const listener of this.listeners.slice()) listener();
  }
}

export type { TillQueue };

const engines: { slug: string; engine: TillQueue }[] = [];

/** One engine per store slug — the singleton that keeps the flush sequential. */
export function getTillQueue(slug: string): TillQueue {
  for (const entry of engines) {
    if (entry.slug === slug) return entry.engine;
  }
  const engine = new TillQueue(slug);
  engines.push({ slug, engine });
  return engine;
}
