"use strict";

/**
 * Messages tab UI
 * Depends on:
 *   - window.messagingClient  (MessagingClient instance, set by app.js)
 *   - window.voiceApp         (preload IPC bridge)
 *   - window.appFriends       (friends array, kept in sync by app.js)
 *   - window.appIdentity      (identity object, set by app.js)
 */

// Wait for app.js to finish booting before we wire up
window.addEventListener("messagingReady", () => {
  initMessagesTab();
});

function initMessagesTab() {
  const mc       = window.messagingClient;
  const identity = window.appIdentity;

  let activeConvId = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const convListEl      = document.getElementById("convList");
  const msgListEl       = document.getElementById("msgList");
  const convHeaderName  = document.getElementById("convHeaderName");
  const convHeaderSub   = document.getElementById("convHeaderSub");
  const convHeader      = document.getElementById("convHeader");
  const convPlaceholder = document.getElementById("convPlaceholder");
  const composeBar      = document.getElementById("composeBar");
  const composeInput    = document.getElementById("composeInput");
  const sendMsgBtn      = document.getElementById("sendMsgBtn");
  const msgBadge        = document.getElementById("msgBadge");

  // Modals
  const dmModal        = document.getElementById("dmModal");
  const dmCodeInput    = document.getElementById("dmCodeInput");
  const dmModalError   = document.getElementById("dmModalError");
  const dmCancelBtn    = document.getElementById("dmCancelBtn");
  const dmConfirmBtn   = document.getElementById("dmConfirmBtn");

  const groupModal       = document.getElementById("groupModal");
  const groupNameInput   = document.getElementById("groupNameInput");
  const groupMemberList  = document.getElementById("groupMemberList");
  const groupModalError  = document.getElementById("groupModalError");
  const groupCancelBtn   = document.getElementById("groupCancelBtn");
  const groupConfirmBtn  = document.getElementById("groupConfirmBtn");

  // ── Conversation list ──────────────────────────────────────────────────────

  function renderConvList() {
    convListEl.innerHTML = "";

    const convs = [...mc.conversations.values()];
    if (convs.length === 0) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.style.padding = "10px";
      hint.textContent = "No conversations yet.";
      convListEl.appendChild(hint);
      return;
    }

    // Sort: rooms first, then by most recent message
    convs.sort((a, b) => {
      if (a.meta?.type === "room" && b.meta?.type !== "room") return -1;
      if (b.meta?.type === "room" && a.meta?.type !== "room") return 1;
      const aLast = a.messages.at(-1)?.sentAt ?? 0;
      const bLast = b.messages.at(-1)?.sentAt ?? 0;
      return bLast - aLast;
    });

    for (const conv of convs) {
      if (!conv.meta) continue;
      const row     = document.createElement("div");
      row.className = "conv-row" + (conv.meta.id === activeConvId ? " active" : "");
      row.dataset.id = conv.meta.id;

      const icon = document.createElement("span");
      icon.className = "conv-type-icon";
      icon.textContent = conv.meta.type === "room" ? "🔊"
                       : conv.meta.type === "group" ? "👥" : "💬";

      const name = document.createElement("span");
      name.className = "conv-row-name";
      name.textContent = getConvName(conv.meta);

      row.appendChild(icon);
      row.appendChild(name);

      const unread = mc.unread.get(conv.meta.id) ?? 0;
      if (unread > 0) {
        const badge = document.createElement("span");
        badge.className = "conv-unread";
        badge.textContent = unread > 99 ? "99+" : unread;
        row.appendChild(badge);
      }

      row.addEventListener("click", () => openConversation(conv.meta.id));
      convListEl.appendChild(row);
    }
  }

  function getConvName(meta) {
    if (meta.type === "room")  return meta.name;
    if (meta.type === "group") return meta.name || "Group";
    // DM — show the other person's name
    const otherCode = meta.members.find(c => c !== identity.code);
    const friend    = (window.appFriends ?? []).find(f => f.code === otherCode);
    return friend?.displayName ?? otherCode ?? "DM";
  }

  // ── Open a conversation ────────────────────────────────────────────────────

  async function openConversation(convId) {
    activeConvId = convId;
    mc.markRead(convId);

    // Fetch history if we have < 50 messages cached
    const cached = mc.conversations.get(convId);
    if (!cached || cached.messages.length < 50) {
      await mc.fetchHistory(convId);
    }

    renderConvList();
    renderMessages(convId);
    updateGlobalBadge();

    const meta = mc.conversations.get(convId)?.meta;
    if (meta) {
      convHeaderName.textContent = getConvName(meta);
      convHeaderSub.textContent  = meta.type === "group"
        ? `${meta.members.length} members`
        : meta.type === "room" ? "Room chat" : "Direct message";
      convHeader.style.display  = "flex";
      convPlaceholder.style.display = "none";
      composeBar.style.display  = "flex";
      composeInput.focus();
    }
  }

  // ── Render messages ────────────────────────────────────────────────────────

  function renderMessages(convId) {
    msgListEl.innerHTML = "";
    const conv = mc.conversations.get(convId);
    if (!conv) return;

    for (const msg of conv.messages) {
      appendMessage(msg, false);
    }
    scrollToBottom();
  }

  function appendMessage(msg, scroll = true) {
    const isOwn = msg.senderCode === identity.code;
    const row   = document.createElement("div");
    row.className = "msg-row" + (isOwn ? " own" : "");
    row.dataset.id = msg.id;

    const meta = document.createElement("div");
    meta.className = "msg-meta";

    if (!isOwn) {
      const sender = document.createElement("span");
      sender.className = "msg-sender";
      sender.textContent = msg.senderName ?? msg.senderCode;
      meta.appendChild(sender);
    }

    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTime(msg.sentAt);
    meta.appendChild(time);

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = msg.text;

    row.appendChild(meta);
    row.appendChild(bubble);
    msgListEl.appendChild(row);

    if (scroll) scrollToBottom();
  }

  function scrollToBottom() {
    msgListEl.scrollTop = msgListEl.scrollHeight;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" })
         + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  async function sendMessage() {
    const text = composeInput.value.trim();
    if (!text || !activeConvId) return;

    composeInput.value = "";

    // Room chat goes through voice WebSocket
    const conv = mc.conversations.get(activeConvId);
    if (conv?.meta?.type === "room" && window.voiceClientInstance) {
      window.voiceClientInstance.sendRoomChat(text);
    } else {
      await mc.sendMessage(activeConvId, text);
    }
  }

  sendMsgBtn.addEventListener("click", sendMessage);
  composeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── MessagingClient events ─────────────────────────────────────────────────

  mc.addEventListener("message", ({ detail }) => {
    renderConvList();
    updateGlobalBadge();
    if (detail.conversationId === activeConvId) {
      appendMessage(detail.message);
      mc.markRead(activeConvId);
      renderConvList();
      updateGlobalBadge();
    }
  });

  mc.addEventListener("messageSent", ({ detail }) => {
    if (detail.conversationId === activeConvId) {
      appendMessage(detail.message);
    }
    renderConvList();
  });

  mc.addEventListener("conversationsLoaded", () => {
    renderConvList();
    updateGlobalBadge();
  });

  mc.addEventListener("unreadChanged", () => {
    updateGlobalBadge();
    renderConvList();
  });

  mc.addEventListener("groupInvite", ({ detail }) => {
    renderConvList();
    updateGlobalBadge();
  });

  // ── Global unread badge on tab ─────────────────────────────────────────────

  function updateGlobalBadge() {
    const total = mc.getTotalUnread();
    msgBadge.textContent    = total > 99 ? "99+" : total;
    msgBadge.style.display  = total > 0 ? "inline" : "none";
  }

  // ── New DM modal ───────────────────────────────────────────────────────────

  document.getElementById("newDmBtn").addEventListener("click", () => {
    dmCodeInput.value    = "";
    dmModalError.textContent = "";
    dmModal.style.display = "flex";
    dmCodeInput.focus();
  });

  dmCodeInput.addEventListener("input", (e) => {
    let v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
    e.target.value = v;
  });

  dmCancelBtn.addEventListener("click",  () => { dmModal.style.display = "none"; });
  dmConfirmBtn.addEventListener("click", async () => {
    const code = dmCodeInput.value.trim().toUpperCase();
    if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)) {
      dmModalError.textContent = "Invalid code format.";
      return;
    }
    if (code === identity.code) {
      dmModalError.textContent = "That's your own code.";
      return;
    }
    dmModal.style.display = "none";
    const convId = await mc.openDM(code, code);
    renderConvList();
    openConversation(convId);
  });

  // ── New Group modal ────────────────────────────────────────────────────────

  document.getElementById("newGroupBtn").addEventListener("click", () => {
    groupNameInput.value       = "";
    groupModalError.textContent = "";
    groupMemberList.innerHTML  = "";

    // Populate friend checkboxes
    const friends = window.appFriends ?? [];
    if (friends.length === 0) {
      groupMemberList.innerHTML = '<div class="hint">Add friends first.</div>';
    } else {
      for (const f of friends) {
        const label = document.createElement("label");
        label.className = "member-check";
        const chk = document.createElement("input");
        chk.type  = "checkbox";
        chk.value = f.code;
        label.appendChild(chk);
        label.appendChild(document.createTextNode(f.displayName || f.code));
        groupMemberList.appendChild(label);
      }
    }

    groupModal.style.display = "flex";
    groupNameInput.focus();
  });

  groupCancelBtn.addEventListener("click",  () => { groupModal.style.display = "none"; });
  groupConfirmBtn.addEventListener("click", async () => {
    const name = groupNameInput.value.trim();
    if (!name) { groupModalError.textContent = "Enter a group name."; return; }

    const checked = [...groupMemberList.querySelectorAll("input:checked")].map(c => c.value);
    if (checked.length === 0) { groupModalError.textContent = "Select at least one friend."; return; }

    groupModal.style.display = "none";
    const convId = await mc.createGroup(name, checked);
    renderConvList();
    openConversation(convId);
  });

  // ── Expose openConversation for app.js (room chat integration) ─────────────
  window.openConversation = openConversation;
  window.renderConvList   = renderConvList;

  // ── Initial render ─────────────────────────────────────────────────────────
  mc.fetchConversations().then(() => renderConvList());
}
