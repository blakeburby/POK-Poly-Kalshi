export type SignalsChangeListener = () => void;

/**
 * Tiny synchronous pub/sub that pushes the dashboard ledger forward the instant a REAL trade is written.
 *
 * The scanner calls notifyChanged() right after persisting a real attempt (an exec-group signal); each open
 * realtime stream subscribes and, on notify, refetches + ships the new ledger row immediately instead of
 * waiting for its TTL-bounded poll. Real attempts are sparse (~79/day) while skipped scans (~130k/day) never
 * call this, so the fan-out is negligible and the freshness floor drops to ~network RTT.
 *
 * Pure + dependency-free so both the trading path (writer) and the dashboard transport (readers) can depend
 * on it without coupling. A throwing listener can never break delivery to the others, nor block the caller.
 */
export class DashboardSignalsNotifier {
  private readonly listeners = new Set<SignalsChangeListener>();

  /** Register a listener; returns an idempotent unsubscribe. */
  subscribe(listener: SignalsChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fire every listener. Synchronous + isolated: one listener's throw is swallowed, not propagated. */
  notifyChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A subscriber (one SSE stream) must never break delivery to the others or stall the writer.
      }
    }
  }

  /** Live subscriber count — for diagnostics/tests only. */
  get subscriberCount(): number {
    return this.listeners.size;
  }
}
