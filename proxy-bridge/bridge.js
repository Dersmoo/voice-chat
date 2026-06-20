#!/usr/bin/env node
/**
 * Voice Chat — SOCKS Proxy Bridge
 *
 * Runs a local HTTP + WebSocket proxy server that forwards all traffic to the
 * Cloudflare worker through a SOCKS4/5 proxy.  Useful when your network
 * blocks direct connections or you want to route through Tor / a VPN's
 * SOCKS endpoint.
 *
 * Usage:
 *   node bridge.js \
 *     --socks socks5://user:pass@127.0.0.1:1080 \
 *     --remote https://voice-chat.<your-subdomain>.workers.dev \
 *     --port 8080
 *
 * Then open  http://localhost:8080  in your browser instead of the
 * Cloudflare URL.
 *
 * Options:
 *   --socks   <url>   SOCKS proxy URL  (required)
 *                     Examples:
 *                       socks5://127.0.0.1:1080         (no auth)
 *                       socks5://user:pass@host:1080
 *                       socks4://127.0.0.1:1080
 *                       socks5h://127.0.0.1:9050        (Tor, remote DNS)
 *   --remote  <url>   Cloudflare worker URL (required)
 *   --port    <num>   Local listen port  (default 8080)
 */

"use strict";

const http          = require("http");
const https         = require("https");
const net           = require("net");
const url           = require("url");
const WebSocket     = require("ws");
const { SocksProxyAgent } = require("socks-proxy-agent");

// ── Parse CLI arguments ──────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const SOCKS_URL  = args["--socks"];
const REMOTE_URL = args["--remote"];
const LOCAL_PORT = parseInt(args["--port"] ?? "8080", 10);

if (!SOCKS_URL || !REMOTE_URL) {
  console.error(
    "Usage: node bridge.js --socks <socks5://...> --remote <https://...> [--port 8080]"
  );
  process.exit(1);
}

const remoteOrigin = REMOTE_URL.replace(/\/$/, "");
const remoteHostname = new URL(remoteOrigin).hostname;

console.log(`[bridge] SOCKS proxy : ${SOCKS_URL}`);
console.log(`[bridge] Remote      : ${remoteOrigin}`);
console.log(`[bridge] Listening   : http://localhost:${LOCAL_PORT}`);

// ── Create shared SOCKS agent (reused for all outbound connections) ───────────

function makeAgent(targetUrl) {
  return new SocksProxyAgent(SOCKS_URL, {
    // Prevent the agent from reusing sockets across requests
    keepAlive: false,
  });
}

// ── HTTP proxy server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Rewrite the request path to the remote worker
  const targetUrl = remoteOrigin + req.url;
  const parsedTarget = new URL(targetUrl);

  const isHttps = parsedTarget.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = makeAgent(targetUrl);

  const options = {
    hostname : parsedTarget.hostname,
    port     : parsedTarget.port || (isHttps ? 443 : 80),
    path     : parsedTarget.pathname + parsedTarget.search,
    method   : req.method,
    headers  : {
      ...req.headers,
      host: parsedTarget.hostname,
    },
    agent,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error("[bridge] HTTP proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway — " + err.message);
    }
  });

  req.pipe(proxyReq);
});

// ── WebSocket proxy ───────────────────────────────────────────────────────────
//
// The browser connects to ws://localhost:PORT/room/:id/ws
// We upgrade that to wss://REMOTE/room/:id/ws through the SOCKS proxy.

const wss = new WebSocket.Server({ server });

wss.on("connection", (clientWs, req) => {
  // Build the remote WebSocket URL
  const remotePath = req.url; // e.g. /room/hangout/ws?name=Alice
  const remoteWsUrl = remoteOrigin
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    + remotePath;

  console.log(`[bridge] WS  ${req.socket.remoteAddress} → ${remoteWsUrl}`);

  const agent = makeAgent(remoteWsUrl);

  const remoteWs = new WebSocket(remoteWsUrl, {
    agent,
    headers: {
      // Forward original headers (minus Host, which WebSocket sets itself)
      ...Object.fromEntries(
        Object.entries(req.headers).filter(
          ([k]) => !["host", "upgrade", "connection"].includes(k.toLowerCase())
        )
      ),
    },
  });

  // Pipe messages in both directions
  clientWs.on("message", (data, isBinary) => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(data, { binary: isBinary });
    }
  });

  remoteWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // Relay close and errors
  clientWs.on("close", (code, reason) => {
    if (remoteWs.readyState === WebSocket.OPEN) remoteWs.close(code, reason);
  });

  remoteWs.on("close", (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
  });

  clientWs.on("error", (err) => {
    console.error("[bridge] Client WS error:", err.message);
    remoteWs.terminate();
  });

  remoteWs.on("error", (err) => {
    console.error("[bridge] Remote WS error:", err.message);
    clientWs.terminate();
  });
});

// ── Start listening ───────────────────────────────────────────────────────────

server.listen(LOCAL_PORT, "127.0.0.1", () => {
  console.log(`\n[bridge] Ready — open http://localhost:${LOCAL_PORT} in your browser\n`);
});

server.on("error", (err) => {
  console.error("[bridge] Server error:", err.message);
  process.exit(1);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    result[argv[i]] = argv[i + 1];
  }
  return result;
}
