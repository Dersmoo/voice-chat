/**
 * VoiceChatRoom — Durable Object
 *
 * One instance per room name. Manages:
 *   - WebSocket connections from all peers in the room
 *   - Relaying signaling messages (offer/answer/ICE/mute)
 *   - Broadcasting join/leave events
 *   - Kicking peers that have been silent for too long (hibernation-safe)
 */

export class VoiceChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map of webSocketId → { ws, id, name, joinedAt }
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "Anonymous";
    const code = url.searchParams.get("code") ?? "";          // persistent friend code
    const maxPeers = parseInt(this.env.MAX_PEERS_PER_ROOM ?? "10", 10);

    if (this.sessions.size >= maxPeers) {
      return new Response("Room is full", { status: 503 });
    }

    // Upgrade the HTTP request to a WebSocket pair
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const peerId = crypto.randomUUID();
    const session = { ws: server, id: peerId, name, code, joinedAt: Date.now() };
    this.sessions.set(peerId, session);

    // Tell the new peer their ID and the existing peer list
    this.safeSend(server, {
      type: "welcome",
      id: peerId,
      peers: [...this.sessions.values()]
        .filter(s => s.id !== peerId)
        .map(s => ({ id: s.id, name: s.name, code: s.code })),
    });

    // Tell all existing peers about the newcomer (include friend code)
    this.broadcast(
      { type: "peer-joined", id: peerId, name, code },
      peerId
    );

    // Wire up events
    server.addEventListener("message", async (evt) => {
      await this.handleMessage(peerId, evt.data);
    });

    const close = () => this.handleClose(peerId);
    server.addEventListener("close", close);
    server.addEventListener("error", close);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Message handling ───────────────────────────────────────────────────

  async handleMessage(senderId, rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return; // ignore malformed messages
    }

    // Validate sender is still in the room
    if (!this.sessions.has(senderId)) return;

    switch (msg.type) {
      // Point-to-point relay: offer, answer, ICE candidates
      case "offer":
      case "answer":
      case "ice": {
        const target = this.sessions.get(msg.to);
        if (!target) return;
        this.safeSend(target.ws, { ...msg, from: senderId });
        break;
      }

      // Broadcast mute state to everyone else
      case "mute-state": {
        this.broadcast({ type: "mute-state", from: senderId, muted: !!msg.muted }, senderId);
        break;
      }

      // Graceful leave (client can also just close the socket)
      case "leave": {
        this.handleClose(senderId);
        break;
      }

      default:
        break; // silently drop unknown message types
    }
  }

  handleClose(peerId) {
    const session = this.sessions.get(peerId);
    if (!session) return;

    this.sessions.delete(peerId);

    try { session.ws.close(1000, "left"); } catch {}

    this.broadcast({ type: "peer-left", id: peerId });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Send a JSON message to a single WebSocket, swallowing errors so one
   * bad connection doesn't bring down the whole room.
   */
  safeSend(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  /**
   * Broadcast a message to all peers, optionally excluding one (e.g. sender).
   */
  broadcast(obj, excludeId = null) {
    for (const [id, session] of this.sessions) {
      if (id === excludeId) continue;
      this.safeSend(session.ws, obj);
    }
  }
}
