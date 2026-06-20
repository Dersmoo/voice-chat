"use strict";

/**
 * MessagingClient
 *
 * Manages:
 *   - Persistent presence WebSocket to the user's UserInbox DO
 *   - Sending/receiving DMs and group messages
 *   - Room chat (ephemeral, over the voice WebSocket)
 *   - Conversation and message caching in memory
 *   - Auto-reconnect with exponential backoff
 */

export class MessagingClient extends EventTarget {
  constructor() {
    super();
    this.serverUrl    = null;
    this.myCode       = null;
    this.myName       = null;
    this.ws           = null;
    this.connected    = false;
    this._reconnectTimer  = null;
    this._reconnectDelay  = 2000;
    this._pingInterval    = null;
    this._destroyed       = false;

    // In-memory cache
    // Map of conversationId → { meta, messages: [] }
    this.conversations = new Map();
    // Map of conversationId → unread count
    this.unread = new Map();
  }

  // ── Connect ────────────────────────────────────────────────────────────────

  async start({ serverUrl, friendCode, displayName }) {
    this.serverUrl = serverUrl;
    this.myCode    = friendCode;
    this.myName    = displayName;
    this._destroyed = false;
    this._connect();
  }

  stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingInterval);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.connected = false;
  }

  _connect() {
    if (this._destroyed) return;

    const wsBase = this.serverUrl.replace(/^http/, "ws");
    const wsUrl  = `${wsBase}/inbox/${this.myCode}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this._reconnectDelay = 2000;
      this._emit("presenceConnected");
      this._startPing();
    };

    this.ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingInterval);
      this._emit("presenceDisconnected");
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, handles reconnect
    };

    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        this._handleIncoming(data);
      } catch {}
    };
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 30000);
      this._connect();
    }, this._reconnectDelay);
  }

  _startPing() {
    clearInterval(this._pingInterval);
    this._pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  }

  // ── Incoming messages ──────────────────────────────────────────────────────

  _handleIncoming(data) {
    switch (data.type) {
      case "pong":
        break;

      case "message": {
        const msg   = data.message;
        const convId = msg.conversationId;

        // Cache the message
        if (!this.conversations.has(convId)) {
          this.conversations.set(convId, { meta: null, messages: [] });
        }
        this.conversations.get(convId).messages.push(msg);

        // Increment unread
        const cur = this.unread.get(convId) ?? 0;
        this.unread.set(convId, cur + 1);

        this._emit("message", { message: msg, conversationId: convId });
        this._emit("unreadChanged", { conversationId: convId, count: cur + 1 });
        break;
      }

      case "group-invite": {
        const conv = data.conversation;
        if (!this.conversations.has(conv.id)) {
          this.conversations.set(conv.id, { meta: conv, messages: [] });
        } else {
          this.conversations.get(conv.id).meta = conv;
        }
        this._emit("groupInvite", { conversation: conv, invitedBy: data.invitedBy });
        break;
      }
    }
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  /**
   * Fetch the user's conversation list from the server and merge with cache.
   */
  async fetchConversations() {
    try {
      const res   = await fetch(`${this.serverUrl}/inbox/${this.myCode}/conversations`);
      const data  = await res.json();
      for (const conv of data.conversations ?? []) {
        if (!this.conversations.has(conv.id)) {
          this.conversations.set(conv.id, { meta: conv, messages: [] });
        } else {
          this.conversations.get(conv.id).meta = conv;
        }
      }
      this._emit("conversationsLoaded");
    } catch (err) {
      console.error("fetchConversations error:", err);
    }
  }

  /**
   * Open (or create) a DM with another user by their friend code.
   */
  async openDM(theirCode, theirName) {
    // Deterministic ID — sort codes so both sides get the same ID
    const parts  = [this.myCode, theirCode].sort();
    const convId = `dm:${parts[0]}:${parts[1]}`;

    // Init on server (idempotent)
    await fetch(`${this.serverUrl}/conversation/${encodeURIComponent(convId)}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id:        convId,
        type:      "dm",
        name:      "",
        members:   parts,
        createdBy: this.myCode,
      }),
    });

    // Register in both inboxes
    const meta = { id: convId, type: "dm", name: "", members: parts };
    for (const code of parts) {
      await fetch(`${this.serverUrl}/inbox/${code}/add-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: meta }),
      }).catch(() => {});
    }

    if (!this.conversations.has(convId)) {
      this.conversations.set(convId, { meta, messages: [] });
    }

    return convId;
  }

  /**
   * Create a new group chat.
   */
  async createGroup(name, memberCodes) {
    const convId  = `grp:${crypto.randomUUID()}`;
    const members = [this.myCode, ...memberCodes.filter(c => c !== this.myCode)];

    await fetch(`${this.serverUrl}/conversation/${encodeURIComponent(convId)}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id:        convId,
        type:      "group",
        name:      name.trim().slice(0, 64),
        members,
        createdBy: this.myCode,
      }),
    });

    const meta = { id: convId, type: "group", name, members };

    // Add to all members' inboxes
    for (const code of members) {
      await fetch(`${this.serverUrl}/inbox/${code}/add-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: meta }),
      }).catch(() => {});
    }

    // Invite non-self members via group-invite notification
    for (const code of members) {
      if (code === this.myCode) continue;
      await fetch(`${this.serverUrl}/conversation/${encodeURIComponent(convId)}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, invitedBy: this.myCode }),
      }).catch(() => {});
    }

    this.conversations.set(convId, { meta, messages: [] });
    this._emit("conversationsLoaded");
    return convId;
  }

  /**
   * Fetch message history for a conversation.
   */
  async fetchHistory(convId, before = null) {
    const params = new URLSearchParams({ limit: "50" });
    if (before) params.set("before", before);

    const res  = await fetch(
      `${this.serverUrl}/conversation/${encodeURIComponent(convId)}/history?${params}`
    );
    const data = await res.json();

    const cached = this.conversations.get(convId);
    if (cached) {
      // Prepend fetched messages (they are older)
      const existing = new Set(cached.messages.map(m => m.id));
      const fresh    = data.messages.filter(m => !existing.has(m.id));
      cached.messages = [...fresh, ...cached.messages];
      if (data.meta && !cached.meta) cached.meta = data.meta;
    } else {
      this.conversations.set(convId, { meta: data.meta, messages: data.messages });
    }

    return data.messages;
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  async sendMessage(convId, text) {
    if (!text.trim()) return;

    const res = await fetch(
      `${this.serverUrl}/conversation/${encodeURIComponent(convId)}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderCode: this.myCode,
          senderName: this.myName,
          text:       text.trim(),
        }),
      }
    );

    const data = await res.json();
    if (data.message) {
      // Add own message to local cache
      const cached = this.conversations.get(convId);
      if (cached) cached.messages.push(data.message);
      this._emit("messageSent", { message: data.message, conversationId: convId });
    }
    return data;
  }

  // ── Unread ─────────────────────────────────────────────────────────────────

  markRead(convId) {
    this.unread.set(convId, 0);
    this._emit("unreadChanged", { conversationId: convId, count: 0 });
  }

  getTotalUnread() {
    let total = 0;
    for (const count of this.unread.values()) total += count;
    return total;
  }

  // ── Room chat (ephemeral, over voice WebSocket) ────────────────────────────

  /**
   * Called by voiceClient when a room-chat message is received.
   */
  receiveRoomMessage(msg) {
    const convId = `room:${msg.roomId}`;
    if (!this.conversations.has(convId)) {
      this.conversations.set(convId, {
        meta: { id: convId, type: "room", name: `# ${msg.roomId}`, members: [] },
        messages: [],
      });
    }
    this.conversations.get(convId).messages.push(msg);

    const cur = this.unread.get(convId) ?? 0;
    this.unread.set(convId, cur + 1);

    this._emit("message", { message: msg, conversationId: convId });
    this._emit("unreadChanged", { conversationId: convId, count: cur + 1 });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _emit(eventName, detail = {}) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}
