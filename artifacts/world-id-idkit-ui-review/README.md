# World ID IDKit UI Review

This directory stores the World ID accessibility, fallback, responsive layout,
and no-leak evidence for `WORLDID-183`.

Run:

```bash
npm --prefix wallet_interface/ui test -- tests/world-id-ux.spec.ts
```

The spec writes desktop/mobile screenshots into this directory and validates
`review-matrix.json` against the expected World ID workflow surfaces.
