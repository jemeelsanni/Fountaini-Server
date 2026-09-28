// Diagnostic instrumentation for tracking down transport-level test flakes
// (hard timeouts, "socket hang up", "Parse Error: Expected HTTP/", or a
// response body that doesn't belong to the request that got it). NOT part
// of the shipped test suite — loaded only when FLAKE_DIAGNOSTICS=1, via a
// conditional dynamic import in vitest.setup.ts. A no-op otherwise.
//
// This is what found the root cause documented in docs/concurrency.md's
// "2026-09-28 — Root cause found and fixed" entry: read that first if a
// similar symptom shows up again, since it explains what this instrument
// actually revealed and how the evidence below maps onto it.
//
// Patches:
//   1. http.Server listen/close/connection lifecycle — to see whether a
//      client's connection ever gets orphaned (its own 'connect' fires but
//      the corresponding server never gets a 'connection' event).
//   2. http.ServerResponse.end/writeHead — to catch a SECOND completion of
//      an already-finished response in the act, with both call stacks
//      (DOUBLE_END_DETECTED / WRITEHEAD_AFTER_HEADERS_SENT).
//   3. Every response's declared Content-Length vs the bytes actually
//      written (server side) / read (client side), logged unconditionally
//      for every request in every run — not just on failure — so a short,
//      long, or substituted body shows up directly without needing to
//      already suspect which request will fail.
//   4. Raw socket bytes on both the server's accepted connections and the
//      client sockets http.request() ends up using (via the request's own
//      'socket' event — net.connect/net.createConnection turned out NOT to
//      be reliable hooks: Node's internal http.Agent goes through internal
//      bindings that bypass the public net.* facade entirely, confirmed
//      empirically against a full 578-test run). Ring-buffered per
//      connection, auto-dumped the moment something anomalous is observed.

import http from "node:http";
import { appendFileSync } from "node:fs";

const LOG_PATH = process.env.FLAKE_LOG_PATH ?? "/tmp/flake-diagnostics.log";

function log(entry) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + "\n");
  } catch {
    // never let logging itself break a test run
  }
}

log({ kind: "instrumentation_loaded" });

// ---------------------------------------------------------------------------
// Ring buffers: every recent connection's last N chunks, both directions.
// ---------------------------------------------------------------------------

const RING_SIZE = 20;
const socketRings = new Map(); // id -> [{t, dir, len, hex, ascii}]

function pushRing(id, dir, chunk) {
  if (!socketRings.has(id)) socketRings.set(id, []);
  const ring = socketRings.get(id);
  ring.push({
    t: Date.now(),
    dir,
    len: chunk.length,
    hex: chunk.subarray(0, 300).toString("hex"),
    ascii: chunk.subarray(0, 300).toString("latin1").replace(/[^\x20-\x7e]/g, "."),
  });
  if (ring.length > RING_SIZE) ring.shift();
}

function dumpAllRings(reason) {
  const now = Date.now();
  for (const [key, ring] of socketRings) {
    // Only dump rings with activity in the last 3s — old, long-finished
    // connections from earlier in the same file aren't relevant to a
    // failure happening now, and would just bloat the log.
    if (ring.length === 0 || now - ring[ring.length - 1].t > 3000) continue;
    log({ kind: "ring_dump", reason, id: key, ring });
  }
}
globalThis.__flakeDumpRings = dumpAllRings;

// ---------------------------------------------------------------------------
// 1. Server lifecycle + server-side socket bytes
// ---------------------------------------------------------------------------

let serverCounter = 0;
const serverIds = new WeakMap();

const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const id = ++serverCounter;
  serverIds.set(this, id);
  this.once("listening", () => {
    const addr = this.address();
    const port = addr && typeof addr === "object" ? addr.port : addr;
    log({ kind: "server_listening", serverId: id, port });
  });
  return originalListen.apply(this, args);
};

const originalClose = http.Server.prototype.close;
http.Server.prototype.close = function (callback) {
  const id = serverIds.get(this);
  const addr = this.address();
  const port = addr && typeof addr === "object" ? addr.port : undefined;
  const calledAt = Date.now();
  log({ kind: "server_close_called", serverId: id, port });
  return originalClose.call(this, (err) => {
    log({ kind: "server_close_completed", serverId: id, port, ms: Date.now() - calledAt, err: err?.message });
    if (callback) callback(err);
  });
};

let connectionCounter = 0;
const socketConnIds = new WeakMap();

const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === "connection") {
    const serverId = serverIds.get(this);
    const socket = args[0];
    const connId = ++connectionCounter;
    socketConnIds.set(socket, connId);
    log({
      kind: "connection_accepted",
      serverId,
      connId,
      remotePort: socket.remotePort,
      localPort: socket.localPort,
    });

    const origWrite = socket.write.bind(socket);
    socket.write = (chunk, ...rest) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
      pushRing(`server:${connId}`, "server->client", buf);
      return origWrite(chunk, ...rest);
    };
    socket.on("data", (chunk) => {
      pushRing(`server:${connId}`, "client->server", chunk);
    });
    socket.once("close", (hadError) => {
      log({ kind: "connection_closed_serverside", serverId, connId, hadError });
    });
  }
  return originalEmit.apply(this, [event, ...args]);
};

// ---------------------------------------------------------------------------
// 2 + 3 (server side). Double-response detection + Content-Length accounting
// ---------------------------------------------------------------------------

const respState = new WeakMap();
const respBytesWritten = new WeakMap();

const originalResWrite = http.ServerResponse.prototype.write;
http.ServerResponse.prototype.write = function (chunk, ...rest) {
  if (chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof rest[0] === "string" ? rest[0] : undefined);
    respBytesWritten.set(this, (respBytesWritten.get(this) ?? 0) + buf.length);
  }
  return originalResWrite.apply(this, [chunk, ...rest]);
};

const originalEnd = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...args) {
  const existing = respState.get(this);
  const stack = new Error().stack ?? "";
  const req = this.req;
  if (existing) {
    log({
      kind: "DOUBLE_END_DETECTED",
      url: req?.url,
      method: req?.method,
      statusCodeFirst: existing.statusCode,
      statusCodeSecond: this.statusCode,
      firstStack: existing.stack,
      secondStack: stack,
      msBetween: Date.now() - existing.t,
    });
    dumpAllRings("double_end");
  } else {
    respState.set(this, { t: Date.now(), stack, statusCode: this.statusCode });
  }

  // Unconditional (not just on error) — every response's declared
  // Content-Length vs the bytes this process actually pushed onto the
  // socket, so a short/long write shows up directly without needing to
  // already suspect this specific request. `end(chunk)` can itself carry
  // the final body chunk, which write() never saw — count it too.
  const chunk0 = args[0];
  if (chunk0 && typeof chunk0 !== "function") {
    const buf = Buffer.isBuffer(chunk0) ? chunk0 : Buffer.from(chunk0, typeof args[1] === "string" ? args[1] : undefined);
    respBytesWritten.set(this, (respBytesWritten.get(this) ?? 0) + buf.length);
  }
  const declared = this.getHeader ? this.getHeader("content-length") : undefined;
  const written = respBytesWritten.get(this) ?? 0;
  const connId = socketConnIds.get(this.socket);
  log({
    kind: "server_response_summary",
    connId,
    method: req?.method,
    url: req?.url,
    statusCode: this.statusCode,
    declaredContentLength: declared === undefined ? null : Number(declared),
    bytesWritten: written,
    lengthMismatch: declared !== undefined && Number(declared) !== written,
  });

  return originalEnd.apply(this, args);
};

const originalWriteHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (...args) {
  if (this.headersSent) {
    log({
      kind: "WRITEHEAD_AFTER_HEADERS_SENT",
      url: this.req?.url,
      method: this.req?.method,
      stack: new Error().stack ?? "",
    });
    dumpAllRings("writehead_after_sent");
  }
  return originalWriteHead.apply(this, args);
};

// ---------------------------------------------------------------------------
// 4. Client-side socket bytes + errors (this is where a Parse Error shows up)
// ---------------------------------------------------------------------------

let clientSocketCounter = 0;

const originalRequest = http.request;
http.request = function (...args) {
  const req = originalRequest.apply(http, args);
  const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.path;
  const reqMethod = typeof args[0] === "object" ? args[0]?.method : undefined;

  req.on("socket", (socket) => {
    const id = ++clientSocketCounter;
    log({
      kind: "client_socket_assigned",
      clientSocketId: id,
      reused: socket._httpMessage !== req || socket.__flakeSeen === true,
      localPort: socket.localPort,
      remotePort: socket.remotePort,
      connecting: socket.connecting,
      url: reqUrl,
      method: reqMethod,
    });
    socket.__flakeSeen = true;

    if (!socket.__flakeInstrumented) {
      socket.__flakeInstrumented = true;
      socket.on("connect", () => {
        log({ kind: "client_socket_connected", clientSocketId: id, localPort: socket.localPort, remotePort: socket.remotePort });
      });
      const origWrite = socket.write.bind(socket);
      socket.write = (chunk, ...rest) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
        pushRing(`client:${id}`, "client->server", buf);
        return origWrite(chunk, ...rest);
      };
      socket.on("data", (chunk) => {
        pushRing(`client:${id}`, "server->client", chunk);
      });
      socket.on("error", (err) => {
        log({
          kind: "client_socket_error",
          clientSocketId: id,
          localPort: socket.localPort,
          remotePort: socket.remotePort,
          err: err.message,
          code: err.code,
        });
        dumpAllRings(`client_socket_error:${id}`);
      });
      socket.on("close", (hadError) => {
        log({ kind: "client_socket_closed", clientSocketId: id, localPort: socket.localPort, hadError });
      });
    }
  });

  // Write-state: did the request actually finish being flushed to the
  // socket, and did a response ever start arriving? These answer "was the
  // request written and unanswered, or did it never leave" directly,
  // instead of inferring it from timing.
  let requestFinished = false;
  let responseStarted = false;
  req.on("finish", () => {
    requestFinished = true;
  });

  req.on("response", (res) => {
    responseStarted = true;
    const declared = res.headers["content-length"];
    let bytesRead = 0;
    res.on("data", (chunk) => {
      bytesRead += chunk.length;
    });
    res.on("end", () => {
      // Unconditional, every response — Content-Length vs bytes actually
      // read on the client side, so a short or long read shows up directly
      // even for a request that never throws at the transport level (a
      // well-formed response with the WRONG content, e.g. a foreign body,
      // won't trip this if its length happens to match — but a truncated
      // or padded one will).
      log({
        kind: "client_response_summary",
        url: reqUrl,
        method: reqMethod,
        status: res.statusCode,
        declaredContentLength: declared === undefined ? null : Number(declared),
        bytesRead,
        lengthMismatch: declared !== undefined && Number(declared) !== bytesRead,
      });
    });
  });

  req.on("error", (err) => {
    const sock = req.socket;
    log({
      kind: "client_request_error",
      err: err.message,
      code: err.code,
      url: reqUrl,
      method: reqMethod,
      localPort: sock?.localPort,
      remotePort: sock?.remotePort,
      socketDestroyed: sock?.destroyed,
      requestFinished,
      responseStarted,
    });
    dumpAllRings(`client_request_error`);
  });
  return req;
};
