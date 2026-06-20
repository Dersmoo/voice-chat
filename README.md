# Voice Chat

Small voice chat infrastructure for you and your friends, running on Cloudflare Workers + Durable Objects.

## Architecture

```
Browser A ──┐
            ├── WebSocket ──► Cloudflare Worker (signaling)
Browser B ──┘                       │ (Durable Object per room)
                                    │
                    ┌───────────────┘
                    │  relay offer / answer / ICE candidates
                    ▼
         Peer-to-peer WebRTC audio (direct or via TURN)
```

- **Signaling** — Cloudflare Worker + Durable Objects.  One Durable Object per room relays WebRTC signaling messages (offer/answer/ICE) and broadcasts join/leave events.
- **Media** — Direct peer-to-peer WebRTC audio.  If peers are behind NAT, Cloudflare Realtime TURN relays the media.
- **SOCKS proxy bridge** — A local Node.js bridge that tunnels the WebSocket signaling (and HTTP) through any SOCKS4/5 proxy.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- (Optional) A **Cloudflare Realtime** app for TURN support — see below

---

## 1. Deploy the Cloudflare Worker

```bash
cd worker
npm install
wrangler login          # authenticate with Cloudflare
wrangler deploy         # deploys to voice.dercraftia.com
```

Open **https://voice.dercraftia.com** in your browser.  Share the link with friends.

### Enable TURN (optional but recommended for NAT traversal)

1. Go to [Cloudflare Dashboard → Realtime](https://dash.cloudflare.com/?to=/:account/realtime)
2. Create a new app — copy the **App ID** and **Secret Key**
3. Set them in `wrangler.toml`:
   ```toml
   [vars]
   TURN_APP_ID     = "your-app-id"
   TURN_APP_SECRET = "your-secret-key"
   ```
4. Redeploy: `wrangler deploy`

Without TURN, peers connect directly (works on most home networks).  With TURN, it works reliably even behind strict firewalls.

### Local development

```bash
wrangler dev            # runs at http://localhost:8787
```

---

## 2. Run / build the desktop app

```bash
cd app
npm install
npm start          # run in dev mode
npm run build      # build a Windows installer (.exe) into dist/
```

On first launch the app generates your persistent identity and friend code, stored in `%APPDATA%\voice-chat-app\`.

### Friend codes

Every user gets a permanent 8-character code like `A3F2-XK9B` shown on the **Friends** tab.

- Share your code with a friend
- They paste it into **Add friend** with a nickname
- When they're in the same room as you, their peer row shows a **friend** badge and an orange border so you can instantly identify them

### Push-to-talk

Enable in **Settings → Push-to-talk**. Hold **V** to speak; release to mute.

---

## 3. Using the voice chat

1. Open the worker URL
2. Enter a **room name** (any word — friends who enter the same name join the same room)
3. Enter your display name
4. Click **Join** — your browser will ask for microphone permission
5. Everyone in the same room connects peer-to-peer automatically
6. Use the **Mute** button to toggle your mic; others see your mute state in real time
7. Click **Leave** when done

Up to **10 peers** per room by default.  Change `MAX_PEERS_PER_ROOM` in `wrangler.toml` to increase it.

---

## 4. SOCKS proxy bridge

Use this when:
- You're behind a restrictive network that blocks WebSockets
- You want to route through Tor, a VPN's SOCKS endpoint, or a private proxy

### Setup

```bash
cd proxy-bridge
npm install
```

### Run

```bash
node bridge.js \
  --socks  socks5://127.0.0.1:1080 \
  --remote https://voice.dercraftia.com \
  --port   8080
```

Then open `http://localhost:8080` instead of `https://voice.dercraftia.com`.

### SOCKS URL formats

| Format | Description |
|--------|-------------|
| `socks5://host:port` | SOCKS5, no authentication |
| `socks5://user:pass@host:port` | SOCKS5 with username/password |
| `socks4://host:port` | SOCKS4 |
| `socks5h://127.0.0.1:9050` | SOCKS5 with remote DNS (Tor) |

### Tor example

```bash
# Start Tor Browser (exposes SOCKS5 on port 9150) or the Tor daemon (port 9050)
node bridge.js \
  --socks  socks5h://127.0.0.1:9050 \
  --remote https://voice.dercraftia.com \
  --port   8080
```

> Note: WebRTC media (audio packets) goes peer-to-peer between browsers and does **not** pass through the bridge.  Only the signaling WebSocket connection is proxied.  If you need the media itself to go through the proxy, you would need a TURN server on the same network — which is what the Cloudflare Realtime TURN service handles.

---

## Project structure

```
Voice Chat/
├── worker/                  Cloudflare Worker (signaling server)
│   ├── wrangler.toml
│   ├── package.json
│   └── src/
│       ├── index.js         Request router + TURN credential endpoint
│       └── room.js          Durable Object — room signaling logic
│
├── app/                     Windows desktop app (Electron)
│   ├── main.js              Main process — identity, friends, settings, tray
│   ├── preload.js           Secure IPC bridge
│   ├── package.json
│   ├── assets/              icon.ico + tray.ico (add your own)
│   ├── src/
│   │   └── voiceClient.js   WebRTC + WebSocket voice logic
│   └── renderer/
│       ├── index.html       App shell
│       ├── style.css        Dark theme UI
│       └── app.js           UI logic / event wiring
│
├── proxy-bridge/            SOCKS proxy bridge (Node.js CLI)
│   ├── package.json
│   └── bridge.js
│
└── README.md
```

---

## Configuration reference

### wrangler.toml

| Variable | Default | Description |
|----------|---------|-------------|
| `TURN_APP_ID` | `""` | Cloudflare Realtime App ID (optional) |
| `TURN_APP_SECRET` | `""` | Cloudflare Realtime secret key (optional) |
| `MAX_PEERS_PER_ROOM` | `"10"` | Hard cap on simultaneous peers per room |

### bridge.js CLI flags

| Flag | Required | Description |
|------|----------|-------------|
| `--socks` | Yes | SOCKS proxy URL |
| `--remote` | Yes | Cloudflare worker HTTPS URL |
| `--port` | No (default 8080) | Local HTTP port to listen on |
