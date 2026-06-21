"use strict";

/**
 * Messages tab UI
 * Depends on:
 *   - window.messagingClient   (MessagingClient instance, set by app.js)
 *   - window.voiceApp          (preload IPC bridge)
 *   - window.appFriends        (friends array, kept in sync by app.js)
 *   - window.appIdentity       (identity object, set by app.js)
 */

window.addEventListener("messagingReady", () => {
  initMessagesTab();
});

function initMessagesTab() {
  const mc       = window.messagingClient;
  const identity = window.appIdentity;
  const api      = window.voiceApp;

  let activeConvId = null;

  // Persisted set of favourited conversation IDs
  let favourites = new Set(JSON.parse(localStorage.getItem("fav_convs") ?? "[]"));

  function saveFavourites() {
    localStorage.setItem("fav_convs", JSON.stringify([...favourites]));
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const convListEl      = document.getElementById("convList");
  const msgListEl       = document.getElementById("msgList");
  const convHeaderName  = document.getElementById("convHeaderName");
  const convHeaderSub   = document.getElementById("convHeaderSub");
  const convHeaderActions = document.getElementById("convHeaderActions");
  const convHeader      = document.getElementById("convHeader");
  const convPlaceholder = document.getElementById("convPlaceholder");
  const composeBar      = document.getElementById("composeBar");
  const composeInput    = document.getElementById("composeInput");
  const sendMsgBtn      = document.getElementById("sendMsgBtn");
  const msgBadge        = document.getElementById("msgBadge");
  const favBtn          = document.getElementById("favBtn");
  const deleteConvBtn   = document.getElementById("deleteConvBtn");

  // Modals
  const dmModal      = document.getElementById("dmModal");
  const dmCodeInput  = document.getElementById("dmCodeInput");
  const dmModalError = document.getElementById("dmModalError");
  const dmCancelBtn  = document.getElementById("dmCancelBtn");
  const dmConfirmBtn = document.getElementById("dmConfirmBtn");

  const groupModal      = document.getElementById("groupModal");
  const groupNameInput  = document.getElementById("groupNameInput");
  const groupMemberList = document.getElementById("groupMemberList");
  const groupModalError = document.getElementById("groupModalError");
  const groupCancelBtn  = document.getElementById("groupCancelBtn");
  const groupConfirmBtn = document.getElementById("groupConfirmBtn");

  // ── Conversation list ──────────────────────────────────────────────────────

  function renderConvList() {
    convListEl.innerHTML = "";

    const convs = [...mc.conversations.values()].filter(c => c.meta);

    if (convs.length === 0) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.style.padding = "10px";
      hint.textContent = "No conversations yet.";
      convListEl.appendChild(hint);
      return;
    }

    // Sort: favourites first, then rooms, then by most recent message
    convs.sort((a, b) => {
      const aFav  = favourites.has(a.meta.id) ? 0 : 1;
      const bFav  = favourites.has(b.meta.id) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      if (a.meta.type === "room" && b.meta.type !== "room") return -1;
      if (b.meta.type === "room" && a.meta.type !== "room") return 1;
      const aLast = a.messages.at(-1)?.sentAt ?? 0;
      const bLast = b.messages.at(-1)?.sentAt ?? 0;
      return bLast - aLast;
    });

    for (const conv of convs) {
      const row = document.createElement("div");
      row.className = "conv-row" + (conv.meta.id === activeConvId ? " active" : "");
      row.dataset.id = conv.meta.id;

      // Favourite star
      if (favourites.has(conv.meta.id)) {
        const star = document.createElement("span");
        star.className = "conv-fav-star";
        star.textContent = "★";
        row.appendChild(star);
      }

      const icon = document.createElement("span");
      icon.className = "conv-type-icon";
      icon.textContent = conv.meta.type === "room"  ? "🔊"
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
    const otherCode = meta.members?.find(c => c !== identity.code);
    const friend    = (window.appFriends ?? []).find(f => f.code === otherCode);
    return friend?.displayName ?? otherCode ?? "DM";
  }

  // ── Open a conversation ────────────────────────────────────────────────────

  async function openConversation(convId) {
    activeConvId = convId;
    mc.markRead(convId);

    if (!mc.conversations.has(convId)) {
      mc.conversations.set(convId, { meta: null, messages: [] });
    }

    try { await mc.fetchHistory(convId); } catch {}

    const entry = mc.conversations.get(convId);
    if (entry && !entry.meta) {
      entry.meta = {
        id:      convId,
        type:    convId.startsWith("grp:")  ? "group"
               : convId.startsWith("room:") ? "room" : "dm",
        name:    "",
        members: [identity.code],
      };
    }

    renderConvList();
    renderMessages(convId);
    updateGlobalBadge();

    const meta = mc.conversations.get(convId)?.meta;
    if (meta) {
      convHeaderName.textContent    = getConvName(meta);
      convHeaderSub.textContent     = meta.type === "group"
        ? `${meta.members?.length ?? 0} members`
        : meta.type === "room" ? "Room chat" : "Direct message";
      convHeader.style.display      = "flex";
      convPlaceholder.style.display = "none";
      composeBar.style.display      = "flex";
      composeInput.focus();

      // Update header action buttons
      const isFav = favourites.has(convId);
      favBtn.textContent          = isFav ? "★ Unfavourite" : "☆ Favourite";
      favBtn.style.display        = meta.type !== "room" ? "inline-block" : "none";
      deleteConvBtn.style.display = meta.type !== "room" ? "inline-block" : "none";
      callBtn.style.display       = meta.type !== "room" ? "inline-block" : "none";
    }
  }

  // ── Favourite ──────────────────────────────────────────────────────────────

  favBtn.addEventListener("click", () => {
    if (!activeConvId) return;
    if (favourites.has(activeConvId)) {
      favourites.delete(activeConvId);
      favBtn.textContent = "☆ Favourite";
    } else {
      favourites.add(activeConvId);
      favBtn.textContent = "★ Unfavourite";
    }
    saveFavourites();
    renderConvList();
  });

  // ── Delete conversation ────────────────────────────────────────────────────

  deleteConvBtn.addEventListener("click", async () => {
    if (!activeConvId) return;
    if (!confirm("Remove this conversation? Messages will be lost.")) return;

    // Remove from server inbox list
    try {
      await fetch(
        `${mc.serverUrl}/inbox/${identity.code}/remove-conversation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: activeConvId }),
        }
      );
    } catch {}

    // Remove from local cache
    mc.conversations.delete(activeConvId);
    mc.unread.delete(activeConvId);
    favourites.delete(activeConvId);
    saveFavourites();

    // Reset UI
    activeConvId = null;
    convHeader.style.display      = "none";
    convPlaceholder.style.display = "block";
    composeBar.style.display      = "none";
    msgListEl.innerHTML = "";
    renderConvList();
    updateGlobalBadge();
  });

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
    // Deduplicate — don't add if already in the DOM
    if (document.querySelector(`[data-msgid="${msg.id}"]`)) return;

    const isOwn = msg.senderCode === identity.code;
    const row   = document.createElement("div");
    row.className = "msg-row" + (isOwn ? " own" : "");
    row.dataset.msgid = msg.id;

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
    const d     = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
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

    const conv = mc.conversations.get(activeConvId);

    if (conv?.meta?.type === "room" && window.voiceClientInstance) {
      // Room chat — optimistically show immediately, relay via voice WS
      const tempMsg = {
        id:             crypto.randomUUID(),
        conversationId: activeConvId,
        senderCode:     identity.code,
        senderName:     identity.displayName || "You",
        text,
        sentAt:         Date.now(),
      };
      if (conv) conv.messages.push(tempMsg);
      appendMessage(tempMsg);
      renderConvList();
      window.voiceClientInstance.sendRoomChat(text);
    } else {
      // DM / group — optimistically show immediately, then confirm via server
      const tempMsg = {
        id:             `pending-${Date.now()}`,
        conversationId: activeConvId,
        senderCode:     identity.code,
        senderName:     identity.displayName || "You",
        text,
        sentAt:         Date.now(),
      };
      if (conv) conv.messages.push(tempMsg);
      appendMessage(tempMsg);
      renderConvList();

      // Send to server (replaces temp message on next history fetch)
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
    // Don't show messages from ourselves (already shown optimistically)
    if (detail.message.senderCode === identity.code) return;
    renderConvList();
    updateGlobalBadge();
    if (detail.conversationId === activeConvId) {
      appendMessage(detail.message);
      mc.markRead(activeConvId);
      renderConvList();
      updateGlobalBadge();
    }
  });

  mc.addEventListener("messageSent", () => {
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

  mc.addEventListener("groupInvite", () => {
    renderConvList();
    updateGlobalBadge();
  });

  // ── Global unread badge ────────────────────────────────────────────────────

  function updateGlobalBadge() {
    const total = mc.getTotalUnread();
    msgBadge.textContent   = total > 99 ? "99+" : total;
    msgBadge.style.display = total > 0 ? "inline" : "none";
  }

  // ── New DM modal ───────────────────────────────────────────────────────────

  document.getElementById("newDmBtn").addEventListener("click", () => {
    dmCodeInput.value        = "";
    dmModalError.textContent = "";
    dmModal.style.display    = "flex";
    dmCodeInput.focus();
  });

  dmCodeInput.addEventListener("input", (e) => {
    let v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
    e.target.value = v;
  });

  dmCancelBtn.addEventListener("click", () => { dmModal.style.display = "none"; });
  dmConfirmBtn.addEventListener("click", async () => {
    const code = dmCodeInput.value.trim().toUpperCase();
    if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)) {
      dmModalError.textContent = "Invalid code format."; return;
    }
    if (code === identity.code) {
      dmModalError.textContent = "That's your own code."; return;
    }
    dmModal.style.display = "none";
    const convId = await mc.openDM(code, code);
    renderConvList();
    openConversation(convId);
  });

  // ── New Group modal ────────────────────────────────────────────────────────

  document.getElementById("newGroupBtn").addEventListener("click", () => {
    groupNameInput.value        = "";
    groupModalError.textContent = "";
    groupMemberList.innerHTML   = "";

    const friends = window.appFriends ?? [];
    if (!friends.length) {
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

  groupCancelBtn.addEventListener("click", () => { groupModal.style.display = "none"; });
  groupConfirmBtn.addEventListener("click", async () => {
    const name = groupNameInput.value.trim();
    if (!name) { groupModalError.textContent = "Enter a group name."; return; }
    const checked = [...groupMemberList.querySelectorAll("input:checked")].map(c => c.value);
    if (!checked.length) { groupModalError.textContent = "Select at least one friend."; return; }
    groupModal.style.display = "none";
    const convId = await mc.createGroup(name, checked);
    renderConvList();
    openConversation(convId);
  });

  // ── Call button ────────────────────────────────────────────────────────────

  const callBtn       = document.getElementById("callBtn");
  const callToast     = document.getElementById("callToast");
  const callToastFrom = document.getElementById("callToastFrom");
  const callAcceptBtn = document.getElementById("callAcceptBtn");
  const callDeclineBtn= document.getElementById("callDeclineBtn");

  let pendingCall = null; // { fromCode, fromName, roomId, convId }

  callBtn.addEventListener("click", async () => {
    const meta = mc.conversations.get(activeConvId)?.meta;
    if (!meta) return;

    // Generate a unique room ID for this call
    const roomId = `call-${crypto.randomUUID().slice(0, 8)}`;

    // Send invite to all other members
    for (const code of meta.members) {
      if (code === identity.code) continue;
      await mc.sendCallInvite(code, roomId, activeConvId);
    }

    // Join the room ourselves
    joinCallRoom(roomId);
  });

  // Incoming call invite
  mc.addEventListener("callInvite", ({ detail }) => {
    pendingCall = detail;
    callToastFrom.textContent = `${detail.fromName || detail.fromCode} is calling…`;
    callToast.style.display   = "block";

    // Auto-decline after 30s
    setTimeout(() => {
      if (pendingCall?.roomId === detail.roomId) {
        declineCall();
      }
    }, 30000);
  });

  mc.addEventListener("callAccepted", ({ detail }) => {
    // Other side accepted — they'll join the room themselves
  });

  mc.addEventListener("callDeclined", ({ detail }) => {
    // Show declined status briefly if we were the caller
    callBtn.textContent = "📞 Declined";
    setTimeout(() => { callBtn.textContent = "📞 Call"; }, 3000);
  });

  callAcceptBtn.addEventListener("click", async () => {
    if (!pendingCall) return;
    const { fromCode, roomId } = pendingCall;
    callToast.style.display = "none";
    await mc.sendCallAccept(fromCode, roomId);
    joinCallRoom(roomId);
    pendingCall = null;
  });

  callDeclineBtn.addEventListener("click", declineCall);

  function declineCall() {
    if (!pendingCall) return;
    mc.sendCallDecline(pendingCall.fromCode, pendingCall.roomId);
    callToast.style.display = "none";
    pendingCall = null;
  }

  function joinCallRoom(roomId) {
    // Switch to voice tab and pre-fill room name, then join
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelector('[data-tab="voice"]').classList.add("active");
    document.getElementById("tab-voice").classList.add("active");

    const roomInput = document.getElementById("roomInput");
    roomInput.value = roomId;
    document.getElementById("joinBtn").click();
  }

  // ── Expose for app.js ─────────────────────────────────────────────────────

  window.openConversation  = openConversation;
  window.renderConvList    = renderConvList;

  // Called by app.js when a friend is added — auto-open their DM
  window.autoOpenFriendDM  = async (friendCode) => {
    const convId = await mc.openDM(friendCode, friendCode);
    renderConvList();
    // Switch to messages tab
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    document.querySelector('[data-tab="messages"]').classList.add("active");
    document.getElementById("tab-messages").classList.add("active");
    openConversation(convId);
  };

  // ── Initial render ─────────────────────────────────────────────────────────
  mc.fetchConversations().then(() => renderConvList());
}
