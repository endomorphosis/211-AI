# Wallet File Storage With IPFS/Filecoin

The Abby UI can run on GitHub Pages, but Filecoin/Synapse credentials must not
be bundled into the static site. Configure the browser with a backend upload
endpoint and keep Filecoin private keys, GitHub secrets, pinning credentials,
and payment credentials on that backend.

## Browser Configuration

The wallet screen reads the upload endpoint from either a Vite build variable or
runtime local storage:

```bash
VITE_FILECOIN_STORAGE_UPLOAD_URL=https://api.example.org/wallet/filecoin/upload
```

Runtime config for a deployed static site:

```js
localStorage.setItem(
  "abby-filecoin-storage-config",
  JSON.stringify({ uploadUrl: "https://api.example.org/wallet/filecoin/upload" })
);
```

The browser sends:

- `multipart/form-data` with `file` and `metadata` when the user selects a new
  wallet file.
- `application/json` with `walletId`, `recordId`, and sharing metadata when a
  backend needs to upload an existing wallet record.

The backend should return any of these fields when available:

```json
{
  "ipfsCid": "bafy...",
  "filecoinPieceCid": "baga...",
  "filecoinDealId": "123",
  "provider": "ipfs-filecoin",
  "message": "Stored on Filecoin"
}
```

## Backend Shape

Use a serverless function or API service. Keep these values in backend
environment variables or GitHub Actions secrets:

- `FILECOIN_PRIVATE_KEY`
- `FILECOIN_NETWORK`
- `FILECOIN_RPC_URL`
- pinning-provider tokens, if the backend pins before Synapse storage

The current Filecoin Onchain Cloud docs install the TypeScript SDK with:

```bash
npm install @filoz/synapse-sdk viem
```

Backend sketch:

```ts
import { Synapse, mainnet } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";

const synapse = Synapse.create({
  account: privateKeyToAccount(process.env.FILECOIN_PRIVATE_KEY as `0x${string}`),
  chain: mainnet,
  source: "abby-wallet"
});

export async function storeWalletBytes(bytes: Uint8Array) {
  await synapse.storage.prepare({ dataSize: BigInt(bytes.byteLength) });
  return synapse.storage.upload(bytes);
}
```

GitHub Pages can host the UI. It cannot safely hold `FILECOIN_PRIVATE_KEY`, so
credentialed storage needs GitHub Actions, a serverless function, or another
backend boundary.
