import type { Server } from "node:http";

export interface GracefulCloseOptions {
  /** ms to wait before forcibly closing every connection, including active ones. Default 10_000. */
  forceCloseAfterMs?: number;
}

/// Resolves once `server` has stopped accepting new connections and every
/// socket it held has closed. `server.close()`'s callback alone only fires
/// once every open socket closes on its own. On Node 20+ (confirmed against
/// Node's own source: `_http_server.js`'s `httpServerPreClose`), close()
/// already destroys idle keep-alive sockets itself — the explicit
/// closeIdleConnections() call below is now belt-and-suspenders for that
/// case, kept for defensiveness (older/different runtimes) rather than
/// because it's load-bearing here. What close() and closeIdleConnections()
/// both deliberately never touch is a socket that's still *active* — a
/// genuinely slow or stuck in-flight request, which is exactly the case a
/// client holding a connection open across a redeploy can produce. Without
/// forceCloseAfterMs, that case hangs until whatever hard-exit fallback the
/// caller has (30s in this app) fires; this fallback shortens that
/// meaningfully by forcing every remaining connection closed, including
/// active ones, once it elapses.
export function closeServerGracefully(server: Server, options: GracefulCloseOptions = {}): Promise<void> {
  const { forceCloseAfterMs = 10_000 } = options;

  return new Promise((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
    }, forceCloseAfterMs);
    forceCloseTimer.unref();

    server.close((err) => {
      clearTimeout(forceCloseTimer);
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });

    server.closeIdleConnections();
  });
}
