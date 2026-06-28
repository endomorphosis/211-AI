#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { version } = require("@playwright/test/package.json");

const args = process.argv.slice(2).filter((arg) => arg !== "--runInBand");
const workspaceDir = process.cwd();
const image = process.env.PLAYWRIGHT_DOCKER_IMAGE || `mcr.microsoft.com/playwright:v${version}-noble`;
const shellCommand = [
  'mkdir -p "$HOME"',
  "npm run test:filecoin-polling",
  `npx playwright test${args.length ? ` ${args.map(shellQuote).join(" ")}` : ""}`,
].join(" && ");

const dockerArgs = [
  "run",
  "--rm",
  "--init",
  "-v",
  `${workspaceDir}:/work`,
  "-w",
  "/work",
  "-e",
  "HOME=/tmp/playwright-home",
  "-e",
  "PLAYWRIGHT_SKIP_HOST_DEPS_CHECK=1",
];

if (process.env.CI) {
  dockerArgs.push("-e", `CI=${process.env.CI}`);
}

if (typeof process.getuid === "function" && typeof process.getgid === "function") {
  dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
}

dockerArgs.push(image, "bash", "-lc", shellCommand);

const result = spawnSync("docker", dockerArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});

process.exit(result.status ?? 1);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}