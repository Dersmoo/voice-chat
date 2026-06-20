/**
 * UserInbox — Durable Object
 *
 * One instance per user (keyed by their friend code).
 * Responsibilities:
 *   - Holds the user's live WebSocket presence connection
 *   - Receives delivered messages from Conversation objects
 *   - Queues messages for offline users and flushes on reconnect
 *   - Stores the user's conversation list
 */

export class UserInbox {
  constructor(state, env) {
    this.state  = state;
    this.env    = env;
    this.socket = null; // active WebSocket, if connected
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.pathname.split("/").pop();

    // WebSocket presence connection from the app
    if (action === "connect") {
      return this.handleConnect(request);
    }

    switch (action) {
      case "deliver":      return this.handleDeliver(request);
      case "group-invite": return this.handleGroupInvite(request);
      case "conversations":return this.handleConversations(request);
      case "add-conversation":      return this.handleAddConversation(request);
      case "remove-conversation":   return this.handleRemoveConversation(request);
      case "friend-request":        return this.handleFriendRequest(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── Presence WebSocket ─────────────────────────────────────────────────────

  async handleConnect(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    // Replace any existing socket
    if (this.socket) {
      try { this.socket.close(1000, "replaced"); } catch {}
    }
    this.socket = server;

    // Flush any queued (offline) messages on connect
    await this.flushQueue(server);

    server.addEventListener("message", async (evt) => {
      // The app can send a ping to keep the connection alive
      const msg = JSON.parse(evt.data);
      if (msg.type === "ping") {
        this.safeSend(server, { type: "pong" });
      }
    });

    const cleanup = () => {
      if (this.socket === server) this.socket = null;
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Deliver a message (called by Conversation DO) ─────────────────────────

  async handleDeliver(request) {
    const { message } = await request.json();

    if (this.socket) {
      // User is online — deliver immediately
      this.safeSend(this.socket, { type: "message", message });
    } else {
      // User is offline — queue it
      const queueKey = `queue:${message.sentAt}:${message.id}`;
      await this.state.storage.put(queueKey, message);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Group invite notification ──────────────────────────────────────────────

  async handleGroupInvite(request) {
    const body = await request.json();

    // Store conversation in user's list
    await this.addConversationToList(body.conversation);

    // Notify live socket if connected
    if (this.socket) {
      this.safeSend(this.socket, {
        type: "group-invite",
        conversation: body.conversation,
        invitedBy: body.invitedBy,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Conversation list ──────────────────────────────────────────────────────

  async handleConversations(request) {
    const convos = await this.state.storage.get("conversations") ?? [];
    return new Response(JSON.stringify({ conversations: convos }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async handleAddConversation(request) {
    const body = await request.json();
    await this.addConversationToList(body.conversation);
    // Notify live socket if connected so the other side sees the DM immediately
    if (this.socket) {
      this.safeSend(this.socket, {
        type:         "conversation-added",
        conversation: body.conversation,
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async addConversationToList(conversation) {
    const convos = await this.state.storage.get("conversations") ?? [];
    if (!convos.find(c => c.id === conversation.id)) {
      convos.push({
        id:      conversation.id,
        type:    conversation.type,
        name:    conversation.name,
        members: conversation.members,
      });
      await this.state.storage.put("conversations", convos);
    }
  }

  async handleFriendRequest(request) {
    const body = await request.json();
    const msg  = { type: "friend-request", code: body.code, displayName: body.displayName, sentAt: body.sentAt };
    if (this.socket) {
      this.safeSend(this.socket, msg);
    } else {
      // Queue it like a regular message so offline users get it on reconnect
      const key = `queue:${body.sentAt}:fr:${body.code}`;
      await this.state.storage.put(key, msg);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async handleRemoveConversation(request) {
    const { conversationId } = await request.json();
    const convos = await this.state.storage.get("conversations") ?? [];
    const updated = convos.filter(c => c.id !== conversationId);
    await this.state.storage.put("conversations", updated);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── Flush queued messages to a newly connected socket ─────────────────────

  async flushQueue(socket) {
    const queued = await this.state.storage.list({ prefix: "queue:" });
    if (queued.size === 0) return;

    const keys = [...queued.keys()].sort();
    for (const key of keys) {
      const msg = queued.get(key);
      this.safeSend(socket, { type: "message", message: msg });
    }

    // Clear the queue
    await this.state.storage.delete(keys);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  safeSend(socket, obj) {
    try { socket.send(JSON.stringify(obj)); } catch {}
  }
}
