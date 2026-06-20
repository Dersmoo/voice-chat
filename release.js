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

// ── Make sure working tree is clean ───────────────────────────────────────────

step("Checking git status");
const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
if (dirty) {
  console.error("Working tree has uncommitted changes. Commit or stash them first.");
  process.exit(1);
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

// Find the installer — it'll be named with the new version
const exeName = `Voice Chat Setup ${version}.exe`;
const exePath = path.join(DIST_DIR, exeName);

if (!fs.existsSync(exePath)) {
  console.error(`Build output not found: ${exePath}`);
  console.error("The build may have failed. Check the output above.");
  process.exit(1);
}

const sizeMB = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`Built: ${exeName} (${sizeMB} MB)`);

// ── Push ──────────────────────────────────────────────────────────────────────

step("Pushing to GitHub");
run("git push --follow-tags");

// ── Create GitHub release ─────────────────────────────────────────────────────

step("Creating GitHub release");
run(
  `gh release create ${tag} "${exePath}" ` +
  `--title "Voice Chat ${tag}" ` +
  `--notes "Release ${tag}" ` +
  `--latest`
);

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`\n✓ Released ${tag} — https://github.com/Dersmoo/voice-chat/releases/tag/${tag}\n`);
