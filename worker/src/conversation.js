/**
 * Conversation — Durable Object
 *
 * One instance per conversation (DM or group chat).
 * Stores message history and member list.
 * Fans out new messages to each member's UserInbox.
 *
 * Conversation IDs:
 *   DM:    "dm:AAAA-1111:BBBB-2222"  (codes sorted alphabetically)
 *   Group: "grp:<uuid>"
 */

export class Conversation {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.pathname.split("/").pop();

    switch (action) {
      case "init":    return this.handleInit(request);
      case "send":    return this.handleSend(request);
      case "history": return this.handleHistory(request);
      case "info":    return this.handleInfo(request);
      case "invite":  return this.handleInvite(request);
      case "leave":   return this.handleLeave(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // ── Init — called when a DM or group is first created ─────────────────────

  async handleInit(request) {
    const body = await request.json();
    // Only write if not already initialised
    const existing = await this.state.storage.get("meta");
    if (!existing) {
      const meta = {
        id:        body.id,
        type:      body.type,        // "dm" | "group"
        name:      body.name ?? "",  // group name; empty for DMs
        members:   body.members,     // array of friend codes
        createdAt: Date.now(),
        createdBy: body.createdBy,
      };
      await this.state.storage.put("meta", meta);
    }
    return json({ ok: true });
  }

  // ── Send a message ─────────────────────────────────────────────────────────

  async handleSend(request) {
    const body = await request.json();
    const meta = await this.state.storage.get("meta");
    if (!meta) return json({ error: "Conversation not initialised" }, 400);

    // Validate sender is a member
    if (!meta.members.includes(body.senderCode)) {
      return json({ error: "Not a member of this conversation" }, 403);
    }

    const msg = {
      id:          crypto.randomUUID(),
      conversationId: meta.id,
      senderCode:  body.senderCode,
      senderName:  body.senderName,
      text:        body.text.slice(0, 2000), // cap message length
      sentAt:      Date.now(),
    };

    // Store message — key by timestamp+id for ordered retrieval
    const msgKey = `msg:${msg.sentAt}:${msg.id}`;
    await this.state.storage.put(msgKey, msg);

    // Enforce 500-message cap per conversation
    await this.pruneMessages();

    // Fan out to each member's inbox
    for (const memberCode of meta.members) {
      if (memberCode === body.senderCode) continue; // don't deliver to self
      try {
        const inboxId   = this.env.INBOXES.idFromName(memberCode);
        const inboxStub = this.env.INBOXES.get(inboxId);
        await inboxStub.fetch(new Request(
          `https://inbox/deliver`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: msg }),
          }
        ));
      } catch (err) {
        console.error(`Failed to deliver to ${memberCode}:`, err);
      }
    }

    return json({ ok: true, message: msg });
  }

  // ── Fetch message history ──────────────────────────────────────────────────

  async handleHistory(request) {
    const url    = new URL(request.url);
    const before = url.searchParams.get("before"); // timestamp cursor
    const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);

    const meta = await this.state.storage.get("meta");
    if (!meta) return json({ messages: [], meta: null });

    // List message keys in reverse order
    const opts = { prefix: "msg:", reverse: true, limit };
    if (before) opts.end = `msg:${before}:`;
    const entries = await this.state.storage.list(opts);

    const messages = [];
    for (const [, msg] of entries) {
      messages.push(msg);
    }

    return json({ messages: messages.reverse(), meta });
  }

  // ── Get conversation info ──────────────────────────────────────────────────

  async handleInfo(request) {
    const meta = await this.state.storage.get("meta");
    return json({ meta: meta ?? null });
  }

  // ── Invite a new member (groups only) ─────────────────────────────────────

  async handleInvite(request) {
    const body = await request.json();
    const meta = await this.state.storage.get("meta");
    if (!meta) return json({ error: "Not found" }, 404);
    if (meta.type !== "group") return json({ error: "Cannot invite to a DM" }, 400);
    if (meta.members.includes(body.code)) return json({ ok: true }); // already a member

    meta.members.push(body.code);
    await this.state.storage.put("meta", meta);

    // Notify the new member's inbox
    try {
      const inboxId   = this.env.INBOXES.idFromName(body.code);
      const inboxStub = this.env.INBOXES.get(inboxId);
      await inboxStub.fetch(new Request(
        `https://inbox/group-invite`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation: meta, invitedBy: body.invitedBy }),
        }
      ));
    } catch {}

    return json({ ok: true, members: meta.members });
  }

  // ── Leave (groups only — DMs are just abandoned) ───────────────────────────

  async handleLeave(request) {
    const body = await request.json();
    const meta = await this.state.storage.get("meta");
    if (!meta) return json({ error: "Not found" }, 404);

    meta.members = meta.members.filter(m => m !== body.code);
    await this.state.storage.put("meta", meta);
    return json({ ok: true });
  }

  // ── Prune to 500 messages ──────────────────────────────────────────────────

  async pruneMessages() {
    const all = await this.state.storage.list({ prefix: "msg:" });
    if (all.size <= 500) return;

    // Delete oldest messages beyond the cap
    const keys    = [...all.keys()].sort();
    const toDelete = keys.slice(0, all.size - 500);
    await this.state.storage.delete(toDelete);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
