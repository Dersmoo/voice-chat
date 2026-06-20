"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

// ── Paths ─────────────────────────────────────────────────────────────────────

const USER_DATA  = app.getPath("userData");
const IDENTITY_FILE = path.join(USER_DATA, "identity.json");
const FRIENDS_FILE  = path.join(USER_DATA, "friends.json");
const SETTINGS_FILE = path.join(USER_DATA, "settings.json");

// ── Identity ──────────────────────────────────────────────────────────────────
// Generated once on first launch, persisted forever.
// The "friend code" is derived from the UUID so it's short and shareable.

function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  }

  const uuid = crypto.randomUUID();                   // e.g. "a3f2..."
  const code = uuidToFriendCode(uuid);                // e.g. "A3F2-XK9B"
  const identity = { uuid, code, displayName: "" };

  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  return identity;
}

/**
 * Turns the first 8 hex chars of a UUID into a readable 8-char code split in
 * two groups of 4, e.g. "A3F2-XK9B".  Uses base-36 digits (0-9 + A-Z) so
 * it's unambiguous to read aloud or type.
 */
function uuidToFriendCode(uuid) {
  const hex = uuid.replace(/-/g, "").slice(0, 10);
  const n   = BigInt("0x" + hex);
  const s   = n.toString(36).toUpperCase().padStart(8, "0").slice(0, 8);
  return s.slice(0, 4) + "-" + s.slice(4);
}

// ── Friends store ─────────────────────────────────────────────────────────────
// Array of { uuid, code, displayName, addedAt }

function loadFriends() {
  if (fs.existsSync(FRIENDS_FILE)) {
    try { return JSON.parse(fs.readFileSync(FRIENDS_FILE, "utf8")); } catch {}
  }
  return [];
}

function saveFriends(friends) {
  fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friends, null, 2));
}

// ── Settings store ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  serverUrl:      "https://voice.dercraftia.com",
  socksProxy:     "",
  startMinimized: false,
  pushToTalk:     false,
  autoUpdate:     true,   // check for updates on launch by default
};

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    } catch {}
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ── App state ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray       = null;
let identity   = loadOrCreateIdentity();
let friends    = loadFriends();
let settings   = loadSettings();

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  440,
    height: 680,
    minWidth:  380,
    minHeight: 520,
    frame: false,           // custom titlebar in renderer
    backgroundColor: "#111111",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: !settings.startMinimized,
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", (e) => {
    // Minimize to tray instead of quitting
    e.preventDefault();
    mainWindow.hide();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray.ico");
  // Fall back to a blank image if the icon file isn't present yet
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(img);
  tray.setToolTip("Voice Chat");

  const menu = Menu.buildFromTemplate([
    { label: "Open",  click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit",  click: () => { app.exit(0); } },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", () => { mainWindow.show(); mainWindow.focus(); });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Identity
ipcMain.handle("identity:get", () => identity);

ipcMain.handle("identity:setName", (_, name) => {
  identity.displayName = name.trim().slice(0, 32) || "Anonymous";
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  return identity;
});

// Friends
ipcMain.handle("friends:list", () => friends);

ipcMain.handle("friends:add", (_, { code, displayName }) => {
  // Validate format  XXXX-XXXX  (base36 uppercase)
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)) {
    return { error: "Invalid friend code format. Expected XXXX-XXXX." };
  }
  if (code === identity.code) {
    return { error: "That's your own friend code." };
  }
  if (friends.some(f => f.code === code)) {
    return { error: "Already in your friend list." };
  }

  const friend = {
    code,
    displayName: displayName?.trim().slice(0, 32) || code,
    addedAt: Date.now(),
  };
  friends.push(friend);
  saveFriends(friends);
  return { friend };
});

ipcMain.handle("friends:remove", (_, code) => {
  friends = friends.filter(f => f.code !== code);
  saveFriends(friends);
  return friends;
});

ipcMain.handle("friends:rename", (_, { code, displayName }) => {
  const f = friends.find(f => f.code === code);
  if (f) {
    f.displayName = displayName.trim().slice(0, 32) || code;
    saveFriends(friends);
  }
  return friends;
});

// Settings
ipcMain.handle("settings:get", () => settings);

ipcMain.handle("settings:save", (_, patch) => {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  return settings;
});

// Window controls (custom titlebar)
ipcMain.on("window:minimize",  () => mainWindow.minimize());
ipcMain.on("window:hide",      () => mainWindow.hide());
ipcMain.on("window:maximize",  () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});

// App version
ipcMain.handle("app:version", () => app.getVersion());

// Open external links safely
ipcMain.on("shell:openExternal", (_, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Don't check in dev mode (no published version to compare against)
  if (!app.isPackaged) return;

  autoUpdater.autoDownload         = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // For public repos electron-updater can still hit unauthenticated rate limits.
  // We store an optional GH token in user data — fine-grained, contents:read scope.
  const tokenFile = path.join(USER_DATA, "gh_token.txt");
  if (fs.existsSync(tokenFile)) {
    process.env.GH_TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
  }

  autoUpdater.setFeedURL({
    provider:    "github",
    owner:       "Dersmoo",
    repo:        "voice-chat",
    releaseType: "release",
  });

  autoUpdater.on("update-available", (info) => {
    // Tell the renderer an update is available
    if (mainWindow) {
      mainWindow.webContents.send("update:available", {
        version: info.version,
        releaseNotes: info.releaseNotes ?? "",
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (mainWindow) mainWindow.webContents.send("update:notAvailable");
  });

  autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send("update:progress", {
        percent: Math.round(progress.percent),
      });
    }
  });

  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.webContents.send("update:downloaded");
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err.message);
    if (mainWindow) mainWindow.webContents.send("update:error", { message: err.message });
  });
}

// IPC — renderer can trigger update actions
ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) return { error: "Not available in dev mode" };
  try { await autoUpdater.checkForUpdates(); } catch (e) { return { error: e.message }; }
});

ipcMain.handle("update:download", async () => {
  try { await autoUpdater.downloadUpdate(); } catch (e) { return { error: e.message }; }
});

ipcMain.on("update:install", () => {
  autoUpdater.quitAndInstall(false, true);
});

// ── Electron lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();

  // Check for updates on launch if the user has it enabled
  if (settings.autoUpdate && app.isPackaged) {
    // Small delay so the window is visible first
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  }
});

app.on("window-all-closed", (e) => {
  // Keep the app alive in the tray on Windows
  e.preventDefault();
});
