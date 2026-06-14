# Magic Login With GitHub Pages

GitHub Pages can host the Abby UI, but it cannot securely run the production
login signer by itself. A public static bundle cannot keep a signing secret,
send email/SMS, rate-limit requests, or mark one-time tokens as used.

Use GitHub Pages for the frontend and put the login issuer/verifier behind a
small API endpoint, such as Cloudflare Workers, Netlify Functions, Vercel
Functions, AWS Lambda, or a small FastAPI service. Store `MAGIC_LOGIN_SECRET`
and email/SMS provider credentials in that backend environment, never in
`VITE_*` variables or checked-in files.

## Local Token Utility

The repo includes a dependency-free HMAC utility:

```bash
cd wallet_interface/ui
MAGIC_LOGIN_SECRET="$(openssl rand -base64 32)" npm --silent run auth:magic -- issue \
  --contact client@example.org \
  --portal client \
  --base-url https://211-ai.github.io/
```

It returns JSON containing:

- `oneTimePad`: the code to send by email/SMS.
- `magicLink`: the signed login link to send by email.
- `token`: the signed token that a backend verifier can check.

Verify a magic link:

```bash
MAGIC_LOGIN_SECRET="same-secret" npm --silent run auth:magic -- verify --url "https://211-ai.github.io/?abbyLogin=..."
```

Verify an OTP challenge:

```bash
MAGIC_LOGIN_SECRET="same-secret" npm --silent run auth:magic -- verify --token "payload.signature" --otp 123456
```

## Production Shape

Recommended endpoints:

- `POST /auth/request`: accepts `{ "portal": "client", "contact": "..." }`,
  creates a signed token plus OTP, sends email/SMS, and returns only a safe
  challenge identifier or delivery status to the browser.
- `POST /auth/verify`: accepts `{ "token": "...", "otp": "123456" }` or a
  magic-link token, verifies the HMAC and expiry, then returns an app session.

The token utility is stateless for the signature and OTP hash. For production,
add backend storage for rate limits and replay protection, such as a KV record
for used token nonces until token expiry.
