#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_HINTS = [
  {
    packages: ["libnspr4", "libnss3"],
    soname: "libnspr4.so",
  },
  {
    packages: ["libnspr4", "libnss3"],
    soname: "libnss3.so",
  },
  {
    packages: ["libnspr4", "libnss3"],
    soname: "libnssutil3.so",
  },
  {
    packages: ["libgtk-4-1", "libavif13", "gstreamer1.0-plugins-bad"],
    soname: "libgtk-4.so.1",
  },
  {
    packages: ["libgtk-4-1", "libavif13", "gstreamer1.0-plugins-bad"],
    soname: "libavif.so.13",
  },
  {
    packages: ["libgtk-4-1", "libavif13", "gstreamer1.0-plugins-bad"],
    soname: "libgstcodecparsers-1.0.so.0",
  },
];

const BROWSER_CHECKS = [
  {
    browser: "Chromium",
    installCommand: "npx playwright install chromium",
    prefixes: ["chromium_headless_shell-", "chromium-"],
    relativePaths: [
      ["chrome-headless-shell-linux64", "chrome-headless-shell"],
      ["chrome-linux64", "chrome"],
    ],
    resolveEnv: () => ({}),
  },
  {
    browser: "WebKit",
    installCommand: "npx playwright install webkit",
    prefixes: ["webkit-"],
    relativePaths: [
      ["minibrowser-gtk", "bin", "MiniBrowser"],
      ["minibrowser-wpe", "bin", "MiniBrowser"],
    ],
    resolveEnv: (executable) => {
      const bundleRoot = path.resolve(path.dirname(executable), "..");
      const libraryPaths = [path.join(bundleRoot, "lib"), path.join(bundleRoot, "sys", "lib")];
      const existing = (process.env.LD_LIBRARY_PATH || "").trim();
      return {
        LD_LIBRARY_PATH: existing ? `${libraryPaths.join(":")}:${existing}` : libraryPaths.join(":"),
      };
    },
  },
];

if (process.platform !== "linux" || process.env.PLAYWRIGHT_SKIP_HOST_DEPS_CHECK === "1") {
  process.exit(0);
}

const packageHints = new Map(PACKAGE_HINTS.map((entry) => [entry.soname, entry.packages]));
const browserRoot = resolveBrowserRoot();
const failures = [];

for (const check of BROWSER_CHECKS) {
  const executable = resolveBrowserExecutable(browserRoot, check);
  if (!executable) {
    failures.push({
      browser: check.browser,
      installCommand: check.installCommand,
      type: "missing-browser",
    });
    continue;
  }

  const missingLibraries = inspectMissingLibraries(executable, check.resolveEnv(executable));
  if (missingLibraries.error) {
    process.stderr.write(`Skipping Playwright host dependency preflight because ${missingLibraries.error}.\n`);
    process.exit(0);
  }
  if (!missingLibraries.sonames.length) continue;

  const packages = new Set();
  for (const soname of missingLibraries.sonames) {
    for (const pkg of packageHints.get(soname) || []) packages.add(pkg);
  }
  failures.push({
    browser: check.browser,
    executable,
    packages: Array.from(packages),
    sonames: missingLibraries.sonames,
    type: "missing-libraries",
  });
}

if (!failures.length) {
  process.exit(0);
}

process.stderr.write("Playwright host dependency preflight failed on Linux.\n\n");
for (const failure of failures) {
  if (failure.type === "missing-browser") {
    process.stderr.write(`- ${failure.browser} browser bundle is not installed under ${browserRoot}\n`);
    process.stderr.write(`  Install with: ${failure.installCommand}\n`);
    continue;
  }

  process.stderr.write(`- ${failure.browser} executable: ${failure.executable}\n`);
  process.stderr.write(`  Missing shared libraries: ${failure.sonames.join(", ")}\n`);
  if (failure.packages.length) {
    process.stderr.write(`  Ubuntu packages: ${failure.packages.join(" ")}\n`);
  }
}

process.stderr.write("\nIf the browser bundles themselves are missing, run `npx playwright install chromium webkit`.\n");
process.stderr.write("\nRun `npx playwright install-deps --dry-run chromium webkit` to inspect the full apt command for this host.\n");
process.stderr.write("Browserless checks are still available via `npm run test:filecoin-polling`.\n");
process.stderr.write("Containerized Playwright is available via `npm run test:container -- <playwright args>` or `npm run test:smoke:container`.\n");
process.stderr.write("You can run this preflight directly with `npm run doctor:playwright`.\n");
process.stderr.write("The manual retry harness remains available via `npm run mock:filecoin-retry`.\n");
process.stderr.write("Set PLAYWRIGHT_SKIP_HOST_DEPS_CHECK=1 only if you intentionally want to bypass this guard.\n");

process.exit(1);

function resolveBrowserRoot() {
  const configured = (process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim();
  if (configured && configured !== "0") {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

function resolveBrowserExecutable(browserRoot, check) {
  const directories = listMatchingDirectories(browserRoot, check.prefixes);
  for (const directory of directories) {
    for (const relativePath of check.relativePaths) {
      const candidate = path.join(browserRoot, directory, ...relativePath);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function listMatchingDirectories(browserRoot, prefixes) {
  try {
    return fs
      .readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix)))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function inspectMissingLibraries(executable, extraEnv) {
  const result = spawnSync("ldd", [executable], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    return { error: "ldd is unavailable", sonames: [] };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const sonames = Array.from(
    new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*(\S+)\s+=>\s+not found\s*$/))
        .filter(Boolean)
        .map((match) => match[1])
    )
  );
  return { sonames };
}