/**
 * Voice Chat — Cloudflare Worker entry point
 *
 * This worker is the signaling + messaging backend for the desktop app only.
 * There is no web client — all connections come from the Electron app.
 *
 * Routes:
 *   GET  /health                        → health check
 *   GET  /turn-credentials              → ephemeral TURN credentials
 *   GET  /room/:roomId/ws               → voice room WebSocket (Durable Object)
 *   GET  /inbox/:code/ws                → presence WebSocket (UserInbox DO)
 *   GET  /inbox/:code/conversations     → list user's conversations
 *   POST /inbox/:code/add-conversation  → add conversation to user's list
 *   POST /conversation/:id/init         → create/init a conversation
 *   POST /conversation/:id/send         → send a message
 *   GET  /conversation/:id/history      → fetch message history
 *   GET  /conversation/:id/info         → get conversation metadata
 *   POST /conversation/:id/invite       → invite a member (groups)
 *   POST /conversation/:id/leave        → leave a group
 *   *    everything else                → 404
 */

import { VoiceChatRoom } from "./room.js";
import { UserInbox }     from "./inbox.js";
import { Conversation }  from "./conversation.js";

export { VoiceChatRoom, UserInbox, Conversation };

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Health ───────────────────────────────────────────────────────────────
    if (path === "/health") {
      return json({ status: "ok" });
    }

    // ── TURN ─────────────────────────────────────────────────────────────────
    if (path === "/turn-credentials") {
      return handleTurnCredentials(request, env);
    }

    // ── Voice room WebSocket ─────────────────────────────────────────────────
    const roomMatch = path.match(/^\/room\/([a-zA-Z0-9_-]{1,64})\/ws$/);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const id   = env.ROOMS.idFromName(roomMatch[1]);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // ── Inbox — presence WebSocket ───────────────────────────────────────────
    const inboxWsMatch = path.match(/^\/inbox\/([A-Z0-9]{4}-[A-Z0-9]{4})\/ws$/);
    if (inboxWsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      return routeInbox(env, inboxWsMatch[1], "connect", request);
    }

    // ── Inbox — REST ─────────────────────────────────────────────────────────
    const inboxMatch = path.match(/^\/inbox\/([A-Z0-9]{4}-[A-Z0-9]{4})\/(.+)$/);
    if (inboxMatch) {
      return routeInbox(env, inboxMatch[1], inboxMatch[2], request);
    }

    // ── Conversation ─────────────────────────────────────────────────────────
    const convoMatch = path.match(/^\/conversation\/([a-zA-Z0-9_:.-]{1,128})\/(.+)$/);
    if (convoMatch) {
      return routeConversation(env, convoMatch[1], convoMatch[2], request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Route helpers ─────────────────────────────────────────────────────────────

function routeInbox(env, code, action, request) {
  const id   = env.INBOXES.idFromName(code);
  const stub = env.INBOXES.get(id);
  const url  = new URL(request.url);
  url.pathname = `/inbox/${action}`;
  return stub.fetch(new Request(url.toString(), request));
}

function routeConversation(env, convId, action, request) {
  // Sanitise convId to be safe as a DO name
  const safeName = convId.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 128);
  const id       = env.CONVERSATIONS.idFromName(safeName);
  const stub     = env.CONVERSATIONS.get(id);
  const url      = new URL(request.url);
  url.pathname   = `/conversation/${action}`;
  return stub.fetch(new Request(url.toString(), request));
}

// ── TURN credentials ──────────────────────────────────────────────────────────

async function handleTurnCredentials(request, env) {
  const appId  = env.TURN_APP_ID;
  const secret = env.TURN_APP_SECRET;

  if (!appId || !secret) {
    return json({ iceServers: [] });
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
    return json(await resp.json());
  } catch (err) {
    console.error("TURN error:", err);
    return json({ iceServers: [] });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
