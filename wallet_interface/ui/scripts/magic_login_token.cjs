#!/usr/bin/env node

const crypto = require("node:crypto");

const DEFAULT_TTL_SECONDS = 10 * 60;
const DEFAULT_PARAM = "abbyLogin";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  MAGIC_LOGIN_SECRET=... node scripts/magic_login_token.cjs issue --contact user@example.org [--portal client|provider] [--base-url https://211-ai.github.io/] [--ttl-seconds 600]
  MAGIC_LOGIN_SECRET=... node scripts/magic_login_token.cjs verify --token TOKEN [--otp 123456]
  MAGIC_LOGIN_SECRET=... node scripts/magic_login_token.cjs verify --url MAGIC_LINK [--otp 123456]

Commands:
  issue   Create a signed magic-link token and matching one-time pad code.
  verify  Verify token signature, expiry, and optionally the one-time pad code.

Required:
  --secret VALUE or MAGIC_LOGIN_SECRET. Keep this out of browser bundles and static files.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const command = argv[2];
  const options = {};
  for (let index = 3; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") usage(0);
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function requireOption(options, key, envKey) {
  const value = options[key] ?? (envKey ? process.env[envKey] : undefined);
  if (!value) {
    throw new Error(`Missing --${key}${envKey ? ` or ${envKey}` : ""}`);
  }
  return value;
}

function normalizeContact(value) {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/[^\d+]/g, "");
}

function assertPortal(value) {
  if (value !== "client" && value !== "provider") {
    throw new Error("--portal must be client or provider");
  }
  return value;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hmacBase64Url(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function randomDigits(length) {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += String(crypto.randomInt(0, 10));
  }
  return output;
}

function signToken(secret, payload) {
  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = base64UrlEncode(payloadJson);
  const signature = hmacBase64Url(secret, `abby-login-token-v1.${payloadEncoded}`);
  return `${payloadEncoded}.${signature}`;
}

function parseAndVerifyToken(secret, token) {
  const [payloadEncoded, signature, extra] = token.split(".");
  if (!payloadEncoded || !signature || extra) {
    throw new Error("Token must have payload.signature format");
  }

  const expected = hmacBase64Url(secret, `abby-login-token-v1.${payloadEncoded}`);
  if (!timingSafeEqualString(signature, expected)) {
    throw new Error("Token signature is invalid");
  }

  const payload = JSON.parse(base64UrlDecode(payloadEncoded));
  if (
    payload?.v !== 1 ||
    (payload.portal !== "client" && payload.portal !== "provider") ||
    typeof payload.contact !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.nonce !== "string" ||
    typeof payload.otpSalt !== "string" ||
    typeof payload.otpDigest !== "string"
  ) {
    throw new Error("Token payload is malformed");
  }

  const now = Date.now();
  if (payload.issuedAt > now + 5 * 60 * 1000) {
    throw new Error("Token was issued in the future");
  }
  if (payload.expiresAt <= now) {
    throw new Error("Token is expired");
  }

  return payload;
}

function tokenFromUrl(urlValue, param = DEFAULT_PARAM) {
  const url = new URL(urlValue);
  const token = url.searchParams.get(param);
  if (!token) {
    throw new Error(`URL is missing ${param}`);
  }
  return token;
}

function issue(options) {
  const secret = requireOption(options, "secret", "MAGIC_LOGIN_SECRET");
  const contact = normalizeContact(requireOption(options, "contact"));
  const portal = assertPortal(options.portal ?? "client");
  const ttlSeconds = Number(options["ttl-seconds"] ?? DEFAULT_TTL_SECONDS);
  const baseUrl = options["base-url"] ?? "https://211-ai.github.io/";
  const oneTimePad = randomDigits(Number(options["otp-digits"] ?? 6));
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlSeconds * 1000;
  const otpSalt = crypto.randomBytes(16).toString("base64url");
  const payload = {
    v: 1,
    portal,
    contact,
    issuedAt,
    expiresAt,
    nonce: crypto.randomBytes(16).toString("base64url"),
    otpSalt,
    otpDigest: hmacBase64Url(secret, `abby-login-otp-v1.${otpSalt}.${oneTimePad}`)
  };
  const token = signToken(secret, payload);
  const magicLink = new URL(baseUrl);
  magicLink.searchParams.set(options.param ?? DEFAULT_PARAM, token);
  if (!magicLink.hash) {
    magicLink.hash = "#/";
  }

  return {
    portal,
    contact,
    oneTimePad,
    token,
    magicLink: magicLink.toString(),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function verify(options) {
  const secret = requireOption(options, "secret", "MAGIC_LOGIN_SECRET");
  const token = options.token ?? tokenFromUrl(requireOption(options, "url"), options.param ?? DEFAULT_PARAM);
  const payload = parseAndVerifyToken(secret, token);
  const output = {
    valid: true,
    portal: payload.portal,
    contact: payload.contact,
    issuedAt: new Date(payload.issuedAt).toISOString(),
    expiresAt: new Date(payload.expiresAt).toISOString(),
    nonce: payload.nonce
  };

  if (options.otp) {
    const expected = hmacBase64Url(secret, `abby-login-otp-v1.${payload.otpSalt}.${options.otp}`);
    output.otpValid = timingSafeEqualString(expected, payload.otpDigest);
    if (!output.otpValid) {
      throw new Error("One-time pad code is invalid");
    }
  }

  return output;
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv);
    if (!command || command === "--help" || command === "-h") usage(0);
    const result = command === "issue" ? issue(options) : command === "verify" ? verify(options) : null;
    if (!result) {
      throw new Error(`Unknown command: ${command}`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
