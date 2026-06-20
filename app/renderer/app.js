"use strict";

/**
 * Renderer process entry point.
 * Wires up all UI interactions and bridges them to VoiceClient + the main
 * process (via window.voiceApp exposed by preload.js).
 */

import { VoiceClient }     from "../src/voiceClient.js";
import { MessagingClient } from "../src/messagingClient.js";

const api       = window.voiceApp;
const client    = new VoiceClient();
const messaging = new MessagingClient();

// Expose for messages.js
window.messagingClient    = messaging;
window.voiceClientInstance = client;

// ── App state ─────────────────────────────────────────────────────────────────

let identity  = null;
let friends   = [];
let settings  = null;

// Map of sessionId → { name, code, muted }  — peers currently in the room
const activePeers = new Map();

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  [identity, friends, settings] = await Promise.all([
    api.getIdentity(),
    api.listFriends(),
    api.getSettings(),
  ]);

  // Expose for messages.js
  window.appIdentity = identity;
  window.appFriends  = friends;

  // Prompt for display name on first launch
  if (!identity.displayName) {
    document.getElementById("tab-settings").classList.add("active");
    document.querySelector('[data-tab="settings"]').classList.add("active");
    document.getElementById("tab-voice").classList.remove("active");
    document.querySelector('[data-tab="voice"]').classList.remove("active");
  }

  populateSettings();
  renderFriendList();

  document.getElementById("myCode").textContent = identity.code;
  document.getElementById("displayNameInput").value = identity.displayName;

  // Show version in titlebar
  const version = await api.getVersion();
  document.getElementById("appVersion").textContent = `v${version}`;

  // Start messaging/presence connection
  if (identity.code && settings.serverUrl) {
    await messaging.start({
      serverUrl:   settings.serverUrl,
      friendCode:  identity.code,
      displayName: identity.displayName || "Anonymous",
    });
  }

  // Signal messages.js that everything is ready
  window.dispatchEvent(new Event("messagingReady"));
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ── Titlebar ──────────────────────────────────────────────────────────────────

document.getElementById("btnMinimize").addEventListener("click", () => api.minimize());
document.getElementById("btnHide").addEventListener("click",     () => api.hide());

// ── Voice tab ─────────────────────────────────────────────────────────────────

const joinBtn    = document.getElementById("joinBtn");
const leaveBtn   = document.getElementById("leaveBtn");
const muteBtn    = document.getElementById("muteBtn");
const roomInput  = document.getElementById("roomInput");
const joinPanel  = document.getElementById("joinPanel");
const roomPanel  = document.getElementById("roomPanel");
const roomNameEl = document.getElementById("roomName");
const statusEl   = document.getElementById("statusBar");

joinBtn.addEventListener("click", async () => {
  const room = roomInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "general";
  const name = identity.displayName || "Anonymous";

  joinBtn.disabled = true;
  statusEl.textContent = "Connecting…";

  try {
    await client.connect({
      serverUrl:   settings.serverUrl,
      roomId:      room,
      displayName: name,
      friendCode:  identity.code,
      pushToTalk:  settings.pushToTalk,
      audioInputId: settings.audioInputId ?? null,
    });
  } catch (err) {
    statusEl.textContent = "Failed: " + err.message;
    joinBtn.disabled = false;
  }
});

leaveBtn.addEventListener("click", async () => {
  await client.disconnect();
});

muteBtn.addEventListener("click", () => {
  client.setMute(!client.muted);
});

// Push-to-talk global key (V)
document.addEventListener("keydown", (e) => {
  if (e.code === "KeyV" && !e.repeat && settings?.pushToTalk) {
    client.pttDown();
    updateMuteButton(false);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "KeyV" && settings?.pushToTalk) {
    client.pttUp();
    updateMuteButton(true);
  }
});

// ── VoiceClient events ────────────────────────────────────────────────────────

client.addEventListener("roomChat", ({ detail }) => {
  messaging.receiveRoomMessage(detail);
  if (window.renderConvList) window.renderConvList();
});

client.addEventListener("connected", () => {
  const room = roomInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "general";

  // Create ephemeral room conversation in messaging client
  const convId = `room:${room}`;
  if (!messaging.conversations.has(convId)) {
    messaging.conversations.set(convId, {
      meta: { id: convId, type: "room", name: `# ${room}`, members: [] },
      messages: [],
    });
  }
  if (window.renderConvList) window.renderConvList();
  joinPanel.style.display  = "none";
  roomPanel.style.display  = "flex";
  roomNameEl.textContent   = "# " + room;
  statusEl.textContent     = "Connected";
  joinBtn.disabled         = false;

  // Add self to peer list
  addPeerRow("__self__", identity.displayName || "You", identity.code, false);
  log("Joined room");
});

client.addEventListener("disconnected", () => {
  roomPanel.style.display = "none";
  joinPanel.style.display = "flex";
  activePeers.clear();
  document.getElementById("peerList").innerHTML = "";
  document.getElementById("log").innerHTML = "";
  statusEl.textContent = "";
  log("Left room");
});

client.addEventListener("micError", ({ detail }) => {
  statusEl.textContent = "Mic error: " + detail.message;
  joinBtn.disabled = false;
});

client.addEventListener("peerJoined", async ({ detail }) => {
  activePeers.set(detail.id, { name: detail.name, code: detail.code, muted: false });
  addPeerRow(detail.id, detail.name, detail.code, false);
  log(detail.name + " joined");

  // If this peer is in our friend list, sync their stored nickname to their
  // current display name so the friend list stays up to date automatically.
  if (detail.code) {
    const match = friends.find(f => f.code === detail.code);
    if (match && match.displayName !== detail.name) {
      friends = await api.renameFriend(detail.code, detail.name);
      renderFriendList();
    }
  }
});

client.addEventListener("peerLeft", ({ detail }) => {
  const peer = activePeers.get(detail.id);
  if (peer) log(peer.name + " left");
  activePeers.delete(detail.id);
  document.getElementById("peer-" + CSS.escape(detail.id))?.remove();
});

client.addEventListener("peerMuteChanged", ({ detail }) => {
  const peer = activePeers.get(detail.id);
  if (peer) peer.muted = detail.muted;
  const dot = document.querySelector(`#peer-${CSS.escape(detail.id)} .peer-dot`);
  if (dot) dot.classList.toggle("muted", detail.muted);
});

client.addEventListener("peerAudioAttached", async ({ detail }) => {
  const state = client.peers.get(detail.id);
  if (!state?.audioEl) return;

  // Apply saved output volume
  const vol = (settings.outputVolume ?? 100) / 100;
  state.audioEl.volume = Math.min(vol, 1);

  // Apply saved output device
  const deviceId = settings.audioOutputId;
  if (deviceId && state.audioEl.setSinkId) {
    try { await state.audioEl.setSinkId(deviceId); } catch {}
  }
});

client.addEventListener("error", ({ detail }) => {
  log("Error: " + detail.message);
});

client.addEventListener("muteChanged", ({ detail }) => {
  updateMuteButton(detail.muted);
});

// ── Peer list helpers ─────────────────────────────────────────────────────────

function isFriend(code) {
  return !!code && friends.some(f => f.code === code);
}

function addPeerRow(sessionId, name, code, muted) {
  const existing = document.getElementById("peer-" + sessionId);
  if (existing) existing.remove();

  const row = document.createElement("div");
  row.className = "peer-row" + (isFriend(code) ? " is-friend" : "");
  row.id = "peer-" + sessionId;

  const dot = document.createElement("span");
  dot.className = "peer-dot" + (muted ? " muted" : "");

  const nameEl = document.createElement("span");
  nameEl.className = "peer-name";
  nameEl.textContent = name;

  row.appendChild(dot);
  row.appendChild(nameEl);

  if (isFriend(code)) {
    const badge = document.createElement("span");
    badge.className = "peer-badge";
    badge.textContent = "friend";
    row.appendChild(badge);
  }

  document.getElementById("peerList").appendChild(row);
}

function updateMuteButton(muted) {
  document.getElementById("muteIcon").textContent  = muted ? "🔇" : "🎙";
  document.getElementById("muteLabel").textContent = muted ? "Unmute" : "Muted";
  muteBtn.classList.toggle("active", muted);
}

// ── Friends tab ───────────────────────────────────────────────────────────────

document.getElementById("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(identity.code).catch(() => {});
  document.getElementById("copyCodeBtn").textContent = "Copied!";
  setTimeout(() => (document.getElementById("copyCodeBtn").textContent = "Copy"), 1500);
});

document.getElementById("addFriendBtn").addEventListener("click", async () => {
  const rawCode = document.getElementById("addCodeInput").value.trim().toUpperCase();
  const name    = document.getElementById("addNameInput").value.trim();
  const errEl   = document.getElementById("addFriendError");

  errEl.textContent = "";

  const result = await api.addFriend(rawCode, name);
  if (result.error) {
    errEl.textContent = result.error;
    return;
  }

  friends = await api.listFriends();
  window.appFriends = friends;
  renderFriendList();
  document.getElementById("addCodeInput").value = "";
  document.getElementById("addNameInput").value = "";

  // Auto-open a DM with the new friend
  if (window.autoOpenFriendDM) {
    window.autoOpenFriendDM(rawCode);
  }
});

// Format code input as user types (auto-insert dash)
document.getElementById("addCodeInput").addEventListener("input", (e) => {
  let v = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
  e.target.value = v;
});

function renderFriendList() {
  const list = document.getElementById("friendList");
  list.innerHTML = "";

  if (!friends.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No friends added yet.";
    list.appendChild(empty);
    return;
  }

  for (const f of friends) {
    const row = document.createElement("div");
    row.className = "friend-row";

    const nameEl = document.createElement("span");
    nameEl.className = "friend-name";
    nameEl.textContent = f.displayName;

    const codeEl = document.createElement("span");
    codeEl.className = "friend-code";
    codeEl.textContent = f.code;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove friend";
    removeBtn.addEventListener("click", async () => {
      friends = await api.removeFriend(f.code);
      renderFriendList();
    });

    row.appendChild(nameEl);
    row.appendChild(codeEl);
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
}

// ── Settings tab ──────────────────────────────────────────────────────────────

function populateSettings() {
  document.getElementById("serverUrlInput").value      = settings.serverUrl;
  document.getElementById("socksInput").value          = settings.socksProxy ?? "";
  document.getElementById("startMinimizedChk").checked = settings.startMinimized;
  document.getElementById("pushToTalkChk").checked     = settings.pushToTalk;
  document.getElementById("autoUpdateChk").checked     = settings.autoUpdate ?? true;

  // Audio
  const micVol = settings.micVolume ?? 100;
  const outVol = settings.outputVolume ?? 100;
  micVolumeSlider.value    = micVol;
  micVolumeLabel.textContent = micVol + "%";
  outputVolumeSlider.value = outVol;
  outputVolumeLabel.textContent = outVol + "%";
  applyOutputVolume(outVol);
}

document.getElementById("saveNameBtn").addEventListener("click", async () => {
  const name = document.getElementById("displayNameInput").value.trim();
  identity = await api.setDisplayName(name);
});

document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
  const patch = {
    serverUrl:      document.getElementById("serverUrlInput").value.trim() || "https://voice.dercraftia.com",
    socksProxy:     document.getElementById("socksInput").value.trim(),
    startMinimized: document.getElementById("startMinimizedChk").checked,
    pushToTalk:     document.getElementById("pushToTalkChk").checked,
    autoUpdate:     document.getElementById("autoUpdateChk").checked,
    audioInputId:   audioInputSelect.value,
    audioOutputId:  audioOutputSelect.value,
    micVolume:      parseInt(micVolumeSlider.value),
    outputVolume:   parseInt(outputVolumeSlider.value),
  };
  settings = await api.saveSettings(patch);
  populateSettings();

  const saved = document.getElementById("settingsSaved");
  saved.style.display = "block";
  setTimeout(() => (saved.style.display = "none"), 2000);
});

// ── Audio settings ────────────────────────────────────────────────────────────

const audioInputSelect   = document.getElementById("audioInputSelect");
const audioOutputSelect  = document.getElementById("audioOutputSelect");
const micVolumeSlider    = document.getElementById("micVolumeSlider");
const micVolumeLabel     = document.getElementById("micVolumeLabel");
const outputVolumeSlider = document.getElementById("outputVolumeSlider");
const outputVolumeLabel  = document.getElementById("outputVolumeLabel");
const testAudioBtn       = document.getElementById("testAudioBtn");
const audioTestStatus    = document.getElementById("audioTestStatus");

// AudioContext for mic gain
let audioCtx    = null;
let gainNode    = null;
let sourceNode  = null;

async function populateAudioDevices() {
  // Need permission first so labels are populated
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch {}

  const devices = await navigator.mediaDevices.enumerateDevices();

  audioInputSelect.innerHTML  = "";
  audioOutputSelect.innerHTML = "";

  const inputs  = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");

  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value       = d.deviceId;
    opt.textContent = d.label || `Microphone ${audioInputSelect.length + 1}`;
    if (d.deviceId === (settings.audioInputId ?? "default")) opt.selected = true;
    audioInputSelect.appendChild(opt);
  }

  for (const d of outputs) {
    const opt = document.createElement("option");
    opt.value       = d.deviceId;
    opt.textContent = d.label || `Speaker ${audioOutputSelect.length + 1}`;
    if (d.deviceId === (settings.audioOutputId ?? "default")) opt.selected = true;
    audioOutputSelect.appendChild(opt);
  }
}

function applyMicGain(value) {
  // value = 0–200, 100 = unity gain
  if (gainNode) gainNode.gain.value = value / 100;
}

function applyOutputVolume(value) {
  // Apply to all active peer audio elements
  const vol = value / 100;
  for (const [, state] of client.peers) {
    if (state.audioEl) state.audioEl.volume = Math.min(vol, 1);
  }
  // Store for new peers to pick up
  window._outputVolume = vol;
}

micVolumeSlider.addEventListener("input", () => {
  const v = parseInt(micVolumeSlider.value);
  micVolumeLabel.textContent = v + "%";
  applyMicGain(v);
});

outputVolumeSlider.addEventListener("input", () => {
  const v = parseInt(outputVolumeSlider.value);
  outputVolumeLabel.textContent = v + "%";
  applyOutputVolume(v);
});

audioInputSelect.addEventListener("change", () => {
  // Restart mic with new device if currently connected
  if (client.localStream) {
    client.localStream.getTracks().forEach(t => t.stop());
    navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:         { exact: audioInputSelect.value },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      }
    }).then(stream => {
      client.localStream = stream;
      applyMicGain(parseInt(micVolumeSlider.value));
      // Replace tracks in all peer connections
      for (const [, state] of client.peers) {
        const sender = state.pc.getSenders().find(s => s.track?.kind === "audio");
        if (sender) sender.replaceTrack(stream.getAudioTracks()[0]);
      }
    }).catch(() => {});
  }
});

audioOutputSelect.addEventListener("change", async () => {
  // setSinkId is supported in Electron
  for (const [, state] of client.peers) {
    if (state.audioEl?.setSinkId) {
      try { await state.audioEl.setSinkId(audioOutputSelect.value); } catch {}
    }
  }
});

// Test output — play a short 440Hz tone
testAudioBtn.addEventListener("click", () => {
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value     = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => ctx.close();
    audioTestStatus.textContent = "Playing test tone…";
    setTimeout(() => { audioTestStatus.textContent = ""; }, 1200);
  } catch (e) {
    audioTestStatus.textContent = "Error: " + e.message;
  }
});

// Populate on settings tab open
document.querySelector('[data-tab="settings"]').addEventListener("click", populateAudioDevices);

// Also watch for device changes (plugging in headphones etc.)
navigator.mediaDevices.addEventListener("devicechange", populateAudioDevices);

const updateStatusEl   = document.getElementById("updateStatus");
const updateProgressEl = document.getElementById("updateProgress");
const updateBarEl      = document.getElementById("updateProgressBar");
const installBtn       = document.getElementById("installUpdateBtn");
const checkBtn         = document.getElementById("checkUpdateBtn");

checkBtn.addEventListener("click", async () => {
  updateStatusEl.textContent = "Checking…";
  await api.checkForUpdate();
});

installBtn.addEventListener("click", () => {
  api.installUpdate();
});

api.onUpdateAvailable(({ version }) => {
  updateStatusEl.textContent = `Version ${version} available — downloading…`;
  updateProgressEl.style.display = "block";
  api.downloadUpdate();
});

api.onUpdateProgress(({ percent }) => {
  updateBarEl.style.width = percent + "%";
  updateStatusEl.textContent = `Downloading… ${percent}%`;
});

api.onUpdateDownloaded(() => {
  updateProgressEl.style.display = "none";
  updateStatusEl.textContent = "Update ready. Restart to install.";
  installBtn.style.display = "inline-block";
});

api.onUpdateNotAvailable(() => {
  updateStatusEl.textContent = "You're on the latest version.";
});

api.onUpdateError(({ message }) => {
  updateStatusEl.textContent = "Update error: " + message;
});

// ── Activity log ──────────────────────────────────────────────────────────────

function log(msg) {
  const logEl = document.getElementById("log");
  const line  = document.createElement("div");
  line.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                   + "  " + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot();
