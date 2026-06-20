"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceApp", {

  // ── Identity ──────────────────────────────────────────────────────────────
  getIdentity:     ()           => ipcRenderer.invoke("identity:get"),
  setDisplayName:  (name)       => ipcRenderer.invoke("identity:setName", name),

  // ── Friends ───────────────────────────────────────────────────────────────
  listFriends:     ()                       => ipcRenderer.invoke("friends:list"),
  addFriend:       (code, displayName)      => ipcRenderer.invoke("friends:add", { code, displayName }),
  removeFriend:    (code)                   => ipcRenderer.invoke("friends:remove", code),
  renameFriend:    (code, displayName)      => ipcRenderer.invoke("friends:rename", { code, displayName }),

  // ── Friend requests ───────────────────────────────────────────────────────
  listRequests:        ()                          => ipcRenderer.invoke("friends:requests:list"),
  incomingRequest:     (code, displayName, sentAt) => ipcRenderer.invoke("friends:request:incoming", { code, displayName, sentAt }),
  acceptRequest:       (code)                      => ipcRenderer.invoke("friends:request:accept", code),
  declineRequest:      (code)                      => ipcRenderer.invoke("friends:request:decline", code),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings:     ()      => ipcRenderer.invoke("settings:get"),
  saveSettings:    (patch) => ipcRenderer.invoke("settings:save", patch),

  // ── Updates ───────────────────────────────────────────────────────────────
  checkForUpdate:   ()  => ipcRenderer.invoke("update:check"),
  downloadUpdate:   ()  => ipcRenderer.invoke("update:download"),
  installUpdate:    ()  => ipcRenderer.send("update:install"),
  onUpdateAvailable:  (cb) => ipcRenderer.on("update:available",    (_, d) => cb(d)),
  onUpdateProgress:   (cb) => ipcRenderer.on("update:progress",     (_, d) => cb(d)),
  onUpdateDownloaded: (cb) => ipcRenderer.on("update:downloaded",   ()     => cb()),
  onUpdateError:      (cb) => ipcRenderer.on("update:error",        (_, d) => cb(d)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on("update:notAvailable", ()   => cb()),

  // ── Window controls ───────────────────────────────────────────────────────
  minimize:   () => ipcRenderer.send("window:minimize"),
  hide:       () => ipcRenderer.send("window:hide"),
  maximize:   () => ipcRenderer.send("window:maximize"),

  // ── Misc ──────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send("shell:openExternal", url),
  getVersion:   ()    => ipcRenderer.invoke("app:version"),
});
