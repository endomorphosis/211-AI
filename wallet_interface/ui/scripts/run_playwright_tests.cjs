#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

function run(command, args) {
  return spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

const args = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const pollingCheck = run("npm", ["run", "test:filecoin-polling"]);
if ((pollingCheck.status ?? 1) !== 0) {
  process.exit(pollingCheck.status ?? 1);
}

const hostDepsCheck = run("node", ["scripts/check_playwright_host_deps.cjs"]);
if ((hostDepsCheck.status ?? 1) !== 0) {
  process.exit(hostDepsCheck.status ?? 1);
}

const result = run("playwright", ["test", ...args]);

process.exit(result.status ?? 1);
