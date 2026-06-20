#!/usr/bin/env node
/**
 * release.js — one-command release script
 *
 * Usage:
 *   node release.js patch    → 1.0.0 → 1.0.1
 *   node release.js minor    → 1.0.0 → 1.1.0
 *   node release.js major    → 1.0.0 → 2.0.0
 *
 * What it does:
 *   1. Bumps the version in app/package.json
 *   2. Commits + tags in git
 *   3. Builds the Windows installer
 *   4. Pushes the commit + tag to GitHub
 *   5. Creates a GitHub release and uploads the installer
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: "inherit" });
}

function step(msg) {
  console.log(`\n${"─".repeat(60)}\n  ${msg}\n${"─".repeat(60)}`);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT     = path.resolve(__dirname);
const APP_DIR  = path.join(ROOT, "app");
const PKG_FILE = path.join(APP_DIR, "package.json");
const DIST_DIR = path.join(APP_DIR, "dist");

// ── Validate args ─────────────────────────────────────────────────────────────

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: node release.js <patch|minor|major>");
  process.exit(1);
}

// ── Commit any pending changes first ──────────────────────────────────────────

step("Checking for uncommitted changes");
const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
if (dirty) {
  console.log("Uncommitted changes found — committing them now:");
  console.log(dirty);
  run("git add -A");
  run(`git commit -m "chore: pre-release changes"`);
}

// ── Bump version ──────────────────────────────────────────────────────────────

step(`Bumping ${bump} version`);
// npm version also creates a git commit + tag automatically
run(`npm version ${bump} --no-git-tag-version`, APP_DIR);

// Read the new version back
const pkg     = JSON.parse(fs.readFileSync(PKG_FILE, "utf8"));
const version = pkg.version;
const tag     = `v${version}`;
console.log(`New version: ${version}`);

// ── Commit + tag ──────────────────────────────────────────────────────────────

step("Committing version bump");
run(`git add app/package.json app/package-lock.json`);
run(`git commit -m "chore: release ${tag}"`);
run(`git tag ${tag}`);

// ── Build ─────────────────────────────────────────────────────────────────────

step("Building Windows installer");
run("npm run build", APP_DIR);

// electron-builder names the file with spaces ("Voice Chat Setup x.x.x.exe")
// but latest.yml references it with hyphens ("Voice-Chat-Setup-x.x.x.exe").
// We rename to match so electron-updater can download it correctly.
const exeSpaced    = path.join(DIST_DIR, `Voice Chat Setup ${version}.exe`);
const exeHyphens   = path.join(DIST_DIR, `Voice-Chat-Setup-${version}.exe`);
const bmSpaced     = `${exeSpaced}.blockmap`;
const bmHyphens    = `${exeHyphens}.blockmap`;

if (!fs.existsSync(exeSpaced)) {
  console.error(`Build output not found: ${exeSpaced}`);
  console.error("The build may have failed. Check the output above.");
  process.exit(1);
}

// Rename to hyphenated form
fs.renameSync(exeSpaced, exeHyphens);
if (fs.existsSync(bmSpaced)) fs.renameSync(bmSpaced, bmHyphens);

const exePath      = exeHyphens;
const blockmapPath = bmHyphens;
const latestYml    = path.join(DIST_DIR, "latest.yml");

const sizeMB = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`Built: Voice-Chat-Setup-${version}.exe (${sizeMB} MB)`);

// ── Push ──────────────────────────────────────────────────────────────────────

step("Pushing to GitHub");
run("git push --follow-tags");

// ── Create GitHub release ─────────────────────────────────────────────────────

step("Creating GitHub release");

// Build file list — include blockmap and latest.yml if present (needed for auto-updater)
const releaseFiles = [`"${exePath}"`];
if (fs.existsSync(blockmapPath)) releaseFiles.push(`"${blockmapPath}"`);
if (fs.existsSync(latestYml))    releaseFiles.push(`"${latestYml}"`);

// Check if release already exists and delete it first (can happen if a previous run partially succeeded)
try {
  execSync(`gh release view ${tag} --repo Dersmoo/voice-chat`, { cwd: ROOT, stdio: "pipe" });
  console.log(`Release ${tag} already exists — deleting and recreating...`);
  execSync(`gh release delete ${tag} --repo Dersmoo/voice-chat --yes`, { cwd: ROOT, stdio: "inherit" });
} catch {
  // Release doesn't exist yet, that's fine
}

run(
  `gh release create ${tag} ${releaseFiles.join(" ")} ` +
  `--title "Voice Chat ${tag}" ` +
  `--notes "Release ${tag}" ` +
  `--latest ` +
  `--repo Dersmoo/voice-chat`
);

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`\n✓ Released ${tag} — https://github.com/Dersmoo/voice-chat/releases/tag/${tag}\n`);
