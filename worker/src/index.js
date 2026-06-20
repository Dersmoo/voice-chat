/**
 * Voice Chat — Cloudflare Worker entry point
 *
 * This worker is the signaling backend for the desktop app only.
 * There is no web client — all connections come from the Electron app.
 *
 * Routes:
 *   GET  /health               → simple health check (for monitoring)
 *   GET  /turn-credentials     → returns ephemeral TURN credentials
 *   GET  /room/:roomId/ws      → WebSocket upgrade → Durable Object
 *   *    everything else       → 404
 */

import { VoiceChatRoom } from "./room.js";
export { VoiceChatRoom };

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // TURN credentials — app fetches this before initiating WebRTC
    if (path === "/turn-credentials") {
      return handleTurnCredentials(request, env);
    }

    // WebSocket signaling — route to Durable Object by room ID
    const roomMatch = path.match(/^\/room\/([a-zA-Z0-9_-]{1,64})\/ws$/);
    if (roomMatch) {
      return handleRoomWebSocket(request, env, roomMatch[1]);
    }

    // Everything else gets a 404 — no web client served here
    return new Response("Not found", { status: 404 });
  },
};

// ── TURN credentials ──────────────────────────────────────────────────────────

async function handleTurnCredentials(request, env) {
  const appId  = env.TURN_APP_ID;
  const secret = env.TURN_APP_SECRET;

  if (!appId || !secret) {
    return new Response(JSON.stringify({ iceServers: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${appId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );

    if (!resp.ok) throw new Error(`TURN API error: ${resp.status}`);

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed to fetch TURN credentials:", err);
    return new Response(JSON.stringify({ iceServers: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── WebSocket → Durable Object ────────────────────────────────────────────────

async function handleRoomWebSocket(request, env, roomId) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const id   = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id);
  return stub.fetch(request);
}
