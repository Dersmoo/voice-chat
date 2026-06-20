"use strict";

/**
 * VoiceClient
 *
 * Handles:
 *  - WebSocket signaling connection to the Cloudflare Worker
 *  - WebRTC peer connections (one per remote peer)
 *  - Local microphone capture
 *  - Mute / push-to-talk
 *  - Emits events the UI can listen to
 */

export class VoiceClient extends EventTarget {
  constructor() {
    super();
    this.ws         = null;
    this.myId       = null;       // server-assigned UUID for this session
    this.myCode     = null;       // persistent friend code passed in on connect
    this.myName     = null;
    this.roomId     = null;
    this.peers      = new Map();  // sessionId → PeerState
    this.localStream = null;
    this.iceServers  = [];
    this._muted      = false;
    this._pushToTalk = false;
    this._pttActive  = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get muted() { return this._muted; }

  /**
   * Connect to a room.
   * @param {object} opts
   * @param {string} opts.serverUrl   e.g. "https://voice.dercraftia.com"
   * @param {string} opts.roomId
   * @param {string} opts.displayName
   * @param {string} opts.friendCode  persistent identity code
   * @param {boolean} [opts.pushToTalk]
   * @param {string}  [opts.socksProxy]  ignored in renderer (bridge handles it)
   */
  async connect({ serverUrl, roomId, displayName, friendCode, pushToTalk = false }) {
    if (this.ws) await this.disconnect();

    this.roomId      = roomId;
    this.myName      = displayName;
    this.myCode      = friendCode;
    this._pushToTalk = pushToTalk;
    this._muted      = pushToTalk; // start muted if PTT

    // 1. Fetch TURN credentials
    try {
      const res = await fetch(`${serverUrl}/turn-credentials`);
      const data = await res.json();
      this.iceServers = data.iceServers ?? [];
    } catch {
      this.iceServers = [];
    }
    this.iceServers.push({ urls: "stun:stun.cloudflare.com:3478" });

    // 2. Start microphone
    await this._startMic();

    // 3. Open signaling WebSocket
    const wsBase = serverUrl.replace(/^http/, "ws");
    const wsUrl  = `${wsBase}/room/${encodeURIComponent(roomId)}/ws`
                 + `?name=${encodeURIComponent(displayName)}`
                 + `&code=${encodeURIComponent(friendCode)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen    = ()    => this._emit("connected");
    this.ws.onclose   = ()    => this._onDisconnect();
    this.ws.onerror   = (e)   => this._emit("error", { message: e.message ?? "WebSocket error" });
    this.ws.onmessage = (evt) => this._handleSignal(JSON.parse(evt.data));
  }

  async disconnect() {
    this._send({ type: "leave" });
    this._cleanup();
  }

  sendRoomChat(text) {
    if (!text.trim()) return;
    this._send({
      type:   "room-chat",
      text:   text.trim().slice(0, 2000),
      sentAt: Date.now(),
    });
  }

  setMute(muted) {
    this._muted = muted;
    this._applyMute();
    this._send({ type: "mute-state", muted });
    this._emit("muteChanged", { muted });
  }

  /** Push-to-talk key down */
  pttDown() {
    if (!this._pushToTalk) return;
    this._pttActive = true;
    this._applyMute();
  }

  /** Push-to-talk key up */
  pttUp() {
    if (!this._pushToTalk) return;
    this._pttActive = false;
    this._applyMute();
  }

  // ── Signaling ──────────────────────────────────────────────────────────────

  _handleSignal(msg) {
    switch (msg.type) {
      case "welcome":
        this.myId = msg.id;
        this._emit("ready", { id: msg.id });
        // Existing peers — we'll receive peer-joined for each
        break;

      case "peer-joined":
        this._emit("peerJoined", { id: msg.id, name: msg.name, code: msg.code });
        if (this.myId < msg.id) {
          this._createOffer(msg.id);
        }
        break;

      case "peer-left":
        this._closePeer(msg.id);
        this._emit("peerLeft", { id: msg.id });
        break;

      case "offer":
        this._handleOffer(msg);
        break;

      case "answer":
        this._handleAnswer(msg);
        break;

      case "ice":
        this._handleIce(msg);
        break;

      case "mute-state":
        this._emit("peerMuteChanged", { id: msg.from, muted: msg.muted });
        break;

      case "speaking":
        this._emit("peerSpeaking", { id: msg.from, speaking: msg.speaking });
        break;

      case "room-chat":
        this._emit("roomChat", {
          id:       msg.id,
          roomId:   this.roomId,
          from:     msg.from,
          name:     msg.name,
          text:     msg.text,
          sentAt:   msg.sentAt,
          conversationId: `room:${this.roomId}`,
        });
        break;
    }
  }

  // ── WebRTC ─────────────────────────────────────────────────────────────────

  _makePeerConnection(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId).pc;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    this.peers.set(peerId, { pc, audioEl: null, gainNode: null });

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._send({ type: "ice", to: peerId, candidate });
    };

    pc.ontrack = ({ streams }) => {
      const state = this.peers.get(peerId);
      if (!state) return;

      // Create an Audio element for this peer's stream
      if (!state.audioEl) {
        const audio = new Audio();
        audio.autoplay = true;
        state.audioEl = audio;
      }
      state.audioEl.srcObject = streams[0];
      this._emit("peerAudioAttached", { id: peerId });
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._emit("peerConnectionState", { id: peerId, state: s });
      if (["disconnected", "failed", "closed"].includes(s)) {
        this._closePeer(peerId);
        this._emit("peerLeft", { id: peerId });
      }
    };

    return pc;
  }

  async _createOffer(peerId) {
    const pc    = this._makePeerConnection(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._send({ type: "offer", to: peerId, sdp: offer.sdp });
  }

  async _handleOffer(msg) {
    const pc = this._makePeerConnection(msg.from);
    await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: "answer", to: msg.from, sdp: answer.sdp });
  }

  async _handleAnswer(msg) {
    const state = this.peers.get(msg.from);
    if (state) await state.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  }

  async _handleIce(msg) {
    const state = this.peers.get(msg.from);
    if (state) {
      try { await state.pc.addIceCandidate(msg.candidate); } catch {}
    }
  }

  _closePeer(peerId) {
    const state = this.peers.get(peerId);
    if (!state) return;
    try { state.pc.close(); } catch {}
    if (state.audioEl) state.audioEl.srcObject = null;
    this.peers.delete(peerId);
  }

  // ── Microphone ─────────────────────────────────────────────────────────────

  async _startMic() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate: 48000,
        },
        video: false,
      });
      this._applyMute();
      this._emit("micReady");
    } catch (err) {
      this._emit("micError", { message: err.message });
      throw err;
    }
  }

  _applyMute() {
    if (!this.localStream) return;
    // In PTT mode: unmuted only while key is held
    const enabled = this._pushToTalk ? this._pttActive : !this._muted;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  _onDisconnect() {
    this._cleanup();
    this._emit("disconnected");
  }

  _cleanup() {
    for (const [id] of this.peers) this._closePeer(id);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.myId = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _emit(eventName, detail = {}) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));
  }
}
