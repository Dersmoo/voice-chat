# Voice Chat

Private voice chat app for you and your friends. Built on Cloudflare Workers + Electron.

## How it works

The Cloudflare Worker running at `voice.dercraftia.com` acts as a signaling server only — it never touches audio. When two users join the same room, the Worker relays the WebRTC handshake between their apps, then audio flows directly peer-to-peer. If a peer is behind a strict firewall, Cloudflare Realtime TURN relays the audio.

```
App (you) ──┐
            ├── WebSocket ──► voice.dercraftia.com (signaling)
App (friend)┘                       │
                                    │ relays offer/answer/ICE
                                    ▼
                     Peer-to-peer WebRTC audio
```

---

## For users

Download the latest installer from [Releases](https://github.com/Dersmoo/voice-chat/releases), run it, and you're done. No Node.js or any other software required.

On first launch:
1. Set your display name in the **Settings** tab
2. Share your **friend code** (shown on the Friends tab) with friends so they can identify you in rooms
3. Enter a room name and hit **Join**
4. Everyone who joins the same room name connects automatically

### Friend codes

Every install generates a permanent `XXXX-XXXX` code. Go to the **Friends** tab, share your code, and paste your friends' codes in. When a friend is in the same room their row gets an orange border and a **friend** badge. Their nickname syncs automatically to whatever display name they're using.

### Push-to-talk

Enable in **Settings → Push-to-talk**. Hold **V** to speak, release to mute.

### Updates

The app checks for updates on launch by default. When one is available it downloads in the background — you'll see a **Restart & install** button in Settings when it's ready. You can disable auto-update checks in Settings if you prefer.

---

## For developers

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — installed automatically via `npm install` in the worker folder
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with `dercraftia.com` on it
- [GitHub CLI](https://cli.github.com/) (`gh`) for releases

### Project structure

```
Voice Chat/
├── worker/                  Cloudflare Worker — signaling backend
│   ├── wrangler.toml        Deployment config + env vars
│   ├── package.json
│   └── src/
│       ├── index.js         Request router (WebSocket, TURN, health)
│       └── room.js          Durable Object — one per room
│
├── app/                     Windows desktop app (Electron)
│   ├── main.js              Main process — identity, friends, settings, tray, updater
│   ├── preload.js           Secure IPC bridge (contextBridge)
│   ├── package.json
│   ├── assets/
│   │   ├── icon.ico         App icon (16/32/48/256px)
│   │   ├── tray.ico         Tray icon (16/32px)
│   │   └── gen_icons.py     Regenerate icons (Python, no deps)
│   ├── src/
│   │   └── voiceClient.js   WebRTC + WebSocket voice engine
│   └── renderer/
│       ├── index.html       App shell (3 tabs: Voice, Friends, Settings)
│       ├── style.css        Dark theme
│       └── app.js           UI logic
│
├── proxy-bridge/            Optional SOCKS proxy bridge
│   ├── package.json
│   └── bridge.js
│
├── release.js               One-command release script
└── README.md
```

### Deploy the Worker

```cmd
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

The Worker binds to `voice.dercraftia.com` via the route in `wrangler.toml`. It serves no web UI — only the app can connect.

#### Enable TURN (optional)

Without TURN, peers connect directly (works on most home networks). With TURN, connections work reliably even behind strict firewalls.

1. Go to [Cloudflare Dashboard → Realtime](https://dash.cloudflare.com/?to=/:account/realtime)
2. Create an app, copy the **App ID** and **Secret Key**
3. Set them in `worker/wrangler.toml`:
   ```toml
   [vars]
   TURN_APP_ID     = "your-app-id"
   TURN_APP_SECRET = "your-secret-key"
   ```
4. Redeploy: `npx wrangler deploy`

### Run the app in dev mode

```cmd
cd app
npm install
npm start
```

### Release a new version

```cmd
node release.js patch    # bug fix  → 1.0.1
node release.js minor    # feature  → 1.1.0
node release.js major    # breaking → 2.0.0
```

This will:
1. Commit any pending changes
2. Bump the version in `package.json`
3. Build the Windows installer
4. Push the git tag to GitHub
5. Create a GitHub Release with the installer attached

Installed apps will detect the new release on next launch and offer to update.

### SOCKS proxy bridge

For users behind restrictive networks that block WebSockets. Tunnels the signaling connection through any SOCKS4/5 proxy — Tor, a VPN endpoint, etc.

```cmd
cd proxy-bridge
npm install
node bridge.js --socks socks5://127.0.0.1:1080 --remote https://voice.dercraftia.com
```

Open the app and change the server URL in Settings to `http://localhost:8080`. Only the signaling is proxied — audio is still peer-to-peer.

### Worker configuration

| Variable | Default | Description |
|---|---|---|
| `TURN_APP_ID` | `""` | Cloudflare Realtime App ID |
| `TURN_APP_SECRET` | `""` | Cloudflare Realtime secret key |
| `MAX_PEERS_PER_ROOM` | `"10"` | Max simultaneous peers per room |
