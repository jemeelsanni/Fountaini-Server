import http from "node:http";
import { describe, expect, it } from "vitest";
import { closeServerGracefully } from "./gracefulShutdown.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected server to listen on a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

describe("closeServerGracefully", () => {
  // Node's own http.Server.close() has closed idle keep-alive connections
  // on its own since Node 20 (internally, close() already calls
  // closeIdleConnections() as part of its "preClose" step — verified
  // directly against Node's source and empirically: an idle keep-alive
  // socket left open here resolves close() in ~0ms with no code of ours
  // involved at all). So an idle connection can't be used to prove this
  // fix does anything on the Node versions this project targets — the
  // request below is deliberately never finished by the handler, keeping
  // its connection genuinely *active* (in-flight), which close() and
  // closeIdleConnections() both explicitly leave alone. Only the
  // forceCloseAfterMs fallback's closeAllConnections() call touches it —
  // confirmed by first running this same scenario with that fallback
  // removed, where it hangs indefinitely (verified locally; not asserted
  // here since there's no bound to safely test "never resolves" against).
  it("resolves via the force-close fallback with a stuck in-flight keep-alive connection", async () => {
    const server = http.createServer((_req, _res) => {
      // Deliberately never calls res.end() — simulates a stuck/slow
      // in-flight request, the one case close()'s own idle-connection
      // handling explicitly does not touch.
    });
    const port = await listen(server);

    const agent = new http.Agent({ keepAlive: true });
    const req = http.request({ host: "127.0.0.1", port, path: "/", agent });
    req.end();
    await new Promise<void>((resolve, reject) => {
      req.on("response", (res) => {
        res.resume();
        resolve();
      });
      req.on("error", reject);
      // Fall back to a short wait if the server never even gets to send
      // response headers — the request still reached the server and is
      // in flight either way, which is all this test needs.
      setTimeout(resolve, 100);
    });

    const start = Date.now();
    await closeServerGracefully(server, { forceCloseAfterMs: 300 });
    const elapsedMs = Date.now() - start;

    // Resolves close to forceCloseAfterMs (the fallback firing), not
    // instantly and not anywhere near the old 30s hard-exit ceiling this
    // fallback sits in front of.
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(elapsedMs).toBeLessThan(1_000);

    agent.destroy();
  }, 8_000);
});
