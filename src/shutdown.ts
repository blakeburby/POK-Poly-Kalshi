export type ShutdownCleanup = () => Promise<void> | void;

export function createIdempotentShutdown(cleanup: ShutdownCleanup): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (!shutdownPromise) shutdownPromise = Promise.resolve().then(cleanup);
    return shutdownPromise;
  };
}
