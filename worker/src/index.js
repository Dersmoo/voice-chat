/**
 * Voice Chat — Cloudflare Worker entry point
 *
 * Routes:
 *   GET  /                     → serves the client HTML
 *   GET  /room/:roomId/ws      → WebSocket upgrade → Durable Object
 *   GET  /turn-credentials     → returns ephemeral TURN credentials
 *   GET  /health               → simple health check
 */

import { VoiceChatRoom } from "./room.js";
export { VoiceChatRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // TURN credential endpoint — clients fetch this before initiating WebRTC
    if (path === "/turn-credentials") {
      return handleTurnCredentials(request, env);
    }

    // WebSocket signaling — route to Durable Object by room ID
    const roomMatch = path.match(/^\/room\/([a-zA-Z0-9_-]{1,64})\/ws$/);
    if (roomMatch) {
      return handleRoomWebSocket(request, env, roomMatch[1]);
    }

    // Serve the client for any other path
    return serveClient(request, env);
  },
};

// ---------------------------------------------------------------------------
// TURN credentials
// ---------------------------------------------------------------------------

async function handleTurnCredentials(request, env) {
  // Add CORS headers so the browser client can fetch from a different origin
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const appId = env.TURN_APP_ID;
  const secret = env.TURN_APP_SECRET;

  if (!appId || !secret) {
    // No TURN configured — return empty so peer-to-peer is still attempted
    return new Response(JSON.stringify({ iceServers: [] }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Generate short-lived credentials using Cloudflare Realtime TURN REST API
  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${appId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }), // 24 hours
      }
    );

    if (!resp.ok) {
      throw new Error(`TURN API error: ${resp.status}`);
    }

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("Failed to fetch TURN credentials:", err);
    return new Response(JSON.stringify({ iceServers: [] }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}

// ---------------------------------------------------------------------------
// Route WebSocket to the correct Durable Object (one per room)
// ---------------------------------------------------------------------------

async function handleRoomWebSocket(request, env, roomId) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  const id = env.ROOMS.idFromName(roomId);
  const stub = env.ROOMS.get(id);
  return stub.fetch(request);
}

// ---------------------------------------------------------------------------
// Inline client HTML — served directly from the worker so there's no
// separate hosting step. In production you might want Cloudflare Pages.
// ---------------------------------------------------------------------------

function serveClient(request, env) {
  // Read the room from the URL or let the user enter one
  const url = new URL(request.url);
  const workerOrigin = url.origin;

  const html = buildClientHTML(workerOrigin);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildClientHTML(workerOrigin) {
  // Inlined so the worker is fully self-contained
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voice Chat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #111;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 2rem 1rem;
      gap: 1.5rem;
    }
    h1 { font-size: 1.8rem; color: #f97316; }
    .card {
      background: #1e1e1e;
      border-radius: 12px;
      padding: 1.5rem;
      width: 100%;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      background: #2a2a2a;
      border: 1px solid #444;
      border-radius: 8px;
      color: #e0e0e0;
      padding: 0.6rem 0.9rem;
      font-size: 1rem;
      width: 100%;
    }
    button {
      background: #f97316;
      border: none;
      border-radius: 8px;
      color: #111;
      cursor: pointer;
      font-size: 1rem;
      font-weight: 600;
      padding: 0.65rem 1.2rem;
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.secondary { background: #333; color: #e0e0e0; }
    .peers { display: flex; flex-wrap: wrap; gap: 0.75rem; }
    .peer {
      background: #2a2a2a;
      border-radius: 8px;
      padding: 0.5rem 0.9rem;
      font-size: 0.9rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .peer .dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #22c55e;
    }
    .peer .dot.muted { background: #ef4444; }
    #log {
      font-size: 0.8rem;
      color: #777;
      max-height: 120px;
      overflow-y: auto;
      background: #161616;
      border-radius: 6px;
      padding: 0.5rem;
    }
    .row { display: flex; gap: 0.75rem; }
    .row input { flex: 1; }
    #status { font-size: 0.85rem; color: #aaa; }
  </style>
</head>
<body>
  <h1>🎙 Voice Chat</h1>

  <div class="card" id="joinCard">
    <label for="roomInput">Room name</label>
    <div class="row">
      <input id="roomInput" type="text" placeholder="e.g. hangout" maxlength="64" />
      <button id="joinBtn">Join</button>
    </div>
    <label for="nameInput">Your display name</label>
    <input id="nameInput" type="text" placeholder="e.g. Alice" maxlength="32" />
  </div>

  <div class="card" id="roomCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span id="roomTitle" style="font-weight:600;color:#f97316"></span>
      <button class="secondary" id="leaveBtn">Leave</button>
    </div>
    <div id="status">Connecting…</div>
    <div class="peers" id="peerList"></div>
    <div style="display:flex;gap:0.75rem">
      <button id="muteBtn">Mute</button>
    </div>
    <div id="log"></div>
  </div>

  <script>
    const WORKER_ORIGIN = ${JSON.stringify(workerOrigin)};

    // ── State ──────────────────────────────────────────────────────────────
    let ws = null;
    let localStream = null;
    let myId = null;
    let myName = "";
    let isMuted = false;
    const peers = {};        // peerId → { pc, name, audioEl }
    let iceServers = [];

    // ── DOM ────────────────────────────────────────────────────────────────
    const joinCard   = document.getElementById("joinCard");
    const roomCard   = document.getElementById("roomCard");
    const joinBtn    = document.getElementById("joinBtn");
    const leaveBtn   = document.getElementById("leaveBtn");
    const muteBtn    = document.getElementById("muteBtn");
    const roomInput  = document.getElementById("roomInput");
    const nameInput  = document.getElementById("nameInput");
    const roomTitle  = document.getElementById("roomTitle");
    const statusEl   = document.getElementById("status");
    const peerListEl = document.getElementById("peerList");
    const logEl      = document.getElementById("log");

    function log(msg) {
      const line = document.createElement("div");
      line.textContent = new Date().toLocaleTimeString() + " " + msg;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    // ── Join / Leave ───────────────────────────────────────────────────────
    joinBtn.addEventListener("click", async () => {
      const room = roomInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "general";
      myName = nameInput.value.trim() || "Anonymous";

      // Fetch TURN credentials first
      try {
        const res = await fetch(WORKER_ORIGIN + "/turn-credentials");
        const data = await res.json();
        iceServers = data.iceServers ?? [];
      } catch {
        iceServers = [];
      }
      // Always add a public STUN fallback
      iceServers.push({ urls: "stun:stun.cloudflare.com:3478" });

      joinCard.style.display = "none";
      roomCard.style.display = "flex";
      roomTitle.textContent = "# " + room;

      connectToRoom(room);
    });

    leaveBtn.addEventListener("click", () => {
      cleanup();
      roomCard.style.display = "none";
      joinCard.style.display = "flex";
    });

    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      if (localStream) {
        localStream.getAudioTracks().forEach(t => (t.enabled = !isMuted));
      }
      muteBtn.textContent = isMuted ? "Unmute" : "Mute";
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "mute-state", muted: isMuted }));
      }
      updatePeerUI(myId, { muted: isMuted });
    });

    // ── WebSocket signaling ────────────────────────────────────────────────
    function connectToRoom(room) {
      const wsUrl = WORKER_ORIGIN.replace(/^http/, "ws") + "/room/" + room + "/ws?name=" + encodeURIComponent(myName);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusEl.textContent = "Connected";
        log("Joined room");
        startLocalAudio();
      };

      ws.onclose = () => {
        statusEl.textContent = "Disconnected";
        log("Disconnected from server");
      };

      ws.onerror = (e) => {
        log("WebSocket error: " + e.message);
      };

      ws.onmessage = async (evt) => {
        const msg = JSON.parse(evt.data);
        await handleSignal(msg);
      };
    }

    async function handleSignal(msg) {
      switch (msg.type) {
        case "welcome":
          myId = msg.id;
          log("You are: " + myId.slice(0, 8));
          // We'll receive "peer-joined" for each existing peer
          break;

        case "peer-joined": {
          log(msg.name + " joined");
          addPeerUI(msg.id, msg.name);
          // Initiator = lower ID to avoid both sides creating offers
          if (myId < msg.id) {
            await createOffer(msg.id);
          }
          break;
        }

        case "peer-left": {
          log((peers[msg.id]?.name ?? msg.id) + " left");
          closePeer(msg.id);
          break;
        }

        case "offer": {
          const pc = await getOrCreatePeerConnection(msg.from, msg.name);
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: "answer", to: msg.from, sdp: answer.sdp });
          break;
        }

        case "answer": {
          const p = peers[msg.from];
          if (p) await p.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          break;
        }

        case "ice": {
          const p = peers[msg.from];
          if (p) await p.pc.addIceCandidate(msg.candidate);
          break;
        }

        case "mute-state": {
          updatePeerUI(msg.from, { muted: msg.muted });
          break;
        }
      }
    }

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      }
    }

    // ── Local audio ────────────────────────────────────────────────────────
    async function startLocalAudio() {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 48000,
          },
          video: false,
        });
        log("Microphone acquired");
        addPeerUI(myId, myName + " (you)");
      } catch (err) {
        log("Mic error: " + err.message);
        statusEl.textContent = "No microphone access";
      }
    }

    // ── Peer connections ───────────────────────────────────────────────────
    async function getOrCreatePeerConnection(peerId, peerName) {
      if (peers[peerId]) return peers[peerId].pc;

      const pc = new RTCPeerConnection({ iceServers });
      peers[peerId] = { pc, name: peerName ?? peerId, audioEl: null };

      // Add local tracks
      if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          send({ type: "ice", to: peerId, candidate });
        }
      };

      pc.ontrack = ({ streams }) => {
        if (!peers[peerId].audioEl) {
          const audio = new Audio();
          audio.autoplay = true;
          peers[peerId].audioEl = audio;
        }
        peers[peerId].audioEl.srcObject = streams[0];
      };

      pc.onconnectionstatechange = () => {
        log(peerName + ": " + pc.connectionState);
        if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
          closePeer(peerId);
        }
      };

      addPeerUI(peerId, peerName);
      return pc;
    }

    async function createOffer(peerId) {
      const pc = await getOrCreatePeerConnection(peerId, peers[peerId]?.name ?? peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: "offer", to: peerId, sdp: offer.sdp });
    }

    function closePeer(peerId) {
      const p = peers[peerId];
      if (!p) return;
      p.pc.close();
      if (p.audioEl) p.audioEl.srcObject = null;
      delete peers[peerId];
      removePeerUI(peerId);
    }

    // ── Peer UI helpers ────────────────────────────────────────────────────
    function addPeerUI(id, name) {
      removePeerUI(id);
      const el = document.createElement("div");
      el.className = "peer";
      el.id = "peer-" + id;
      el.innerHTML = '<span class="dot"></span><span>' + escapeHtml(name) + '</span>';
      peerListEl.appendChild(el);
    }

    function updatePeerUI(id, { muted }) {
      const el = document.getElementById("peer-" + id);
      if (!el) return;
      el.querySelector(".dot").classList.toggle("muted", muted);
    }

    function removePeerUI(id) {
      document.getElementById("peer-" + id)?.remove();
    }

    function escapeHtml(s) {
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    // ── Cleanup ────────────────────────────────────────────────────────────
    function cleanup() {
      Object.keys(peers).forEach(closePeer);
      if (ws) { ws.close(); ws = null; }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      peerListEl.innerHTML = "";
      logEl.innerHTML = "";
      myId = null;
    }
  </script>
</body>
</html>`;
}
