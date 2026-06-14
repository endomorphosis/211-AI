#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
import uuid


def _request(
    method: str,
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20.0,
) -> tuple[int, bytes, dict[str, str]]:
    request = urllib_request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib_request.urlopen(request, timeout=timeout) as response:
            body = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
            return response.getcode(), body, response_headers
    except urllib_error.HTTPError as exc:
        body = exc.read()
        raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {body.decode('utf-8', 'replace')}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError(f"{method} {url} failed: {exc.reason}") from exc


def _json_request(method: str, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    status, body, response_headers = _request(method, url, data=data, headers=headers)
    if status < 200 or status >= 300:
        raise RuntimeError(f"{method} {url} returned unexpected status {status}")
    content_type = response_headers.get("content-type", "")
    if "application/json" not in content_type:
        raise RuntimeError(f"{method} {url} returned non-JSON content-type: {content_type}")
    return json.loads(body.decode("utf-8"))


def _form_request(url: str, payload: dict[str, str]) -> dict[str, Any]:
    data = urllib_parse.urlencode(payload).encode("utf-8")
    return _json_request_with_bytes("POST", url, data, "application/x-www-form-urlencoded")


def _json_request_with_bytes(method: str, url: str, data: bytes, content_type: str) -> dict[str, Any]:
    status, body, response_headers = _request(
        method,
        url,
        data=data,
        headers={"Accept": "application/json", "Content-Type": content_type},
    )
    if status < 200 or status >= 300:
        raise RuntimeError(f"{method} {url} returned unexpected status {status}")
    content_type_header = response_headers.get("content-type", "")
    if "application/json" not in content_type_header:
        raise RuntimeError(f"{method} {url} returned non-JSON content-type: {content_type_header}")
    return json.loads(body.decode("utf-8"))


def _multipart_request(
    url: str,
    *,
    fields: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
) -> dict[str, Any]:
    boundary = f"----abby-smoke-{uuid.uuid4().hex}"
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(value.encode("utf-8"))
        body.extend(b"\r\n")
    for name, (filename, payload, mime_type) in files.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode("utf-8")
        )
        body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"))
        body.extend(payload)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))
    return _json_request_with_bytes("POST", url, bytes(body), f"multipart/form-data; boundary={boundary}")


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _log(step: str, detail: str) -> None:
    print(f"[ok] {step}: {detail}")


def _wait_for_json_request(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    attempts: int = 12,
    delay_seconds: float = 1.0,
) -> dict[str, Any]:
    last_error: RuntimeError | None = None
    for attempt in range(attempts):
        try:
            return _json_request(method, url, payload)
        except RuntimeError as exc:
            last_error = exc
            if attempt == attempts - 1:
                break
            time.sleep(delay_seconds)
    if last_error is None:
        raise RuntimeError(f"{method} {url} failed before a request was attempted")
    raise last_error


def run_smoke(base_url: str) -> None:
    base_url = base_url.rstrip("/")
    configured_mock_voice_reply = str(os.getenv("IPFS_DATASETS_VOICE_MOCK_REPLY_TEXT") or "").strip()

    health = _wait_for_json_request("GET", f"{base_url}/health")
    _expect(bool(health), "GET /health returned an empty payload")
    _log("health", json.dumps(health, sort_keys=True))

    messaging_health = _wait_for_json_request("GET", f"{base_url}/messaging/health")
    _expect(bool(messaging_health), "GET /messaging/health returned an empty payload")
    _log("messaging health", json.dumps(messaging_health, sort_keys=True))

    owner_did = f"did:key:smoke-owner-{uuid.uuid4().hex[:12]}"
    wallet = _json_request("POST", f"{base_url}/wallets", {"owner_did": owner_did})
    wallet_id = str(wallet["wallet_id"])
    _log("wallet", wallet_id)

    location = _json_request(
        "POST",
        f"{base_url}/wallets/{wallet_id}/locations",
        {
            "actor_did": owner_did,
            "lat": 45.515232,
            "lon": -122.678385,
        },
    )
    location_record_id = str(location["record_id"])
    _log("location", location_record_id)

    delegate_did = f"did:key:smoke-delegate-{uuid.uuid4().hex[:12]}"
    grant = _json_request(
        "POST",
        f"{base_url}/wallets/{wallet_id}/locations/{location_record_id}/region-proof-grants",
        {
            "issuer_did": owner_did,
            "audience_did": delegate_did,
        },
    )
    proof = _json_request(
        "POST",
        f"{base_url}/wallets/{wallet_id}/locations/{location_record_id}/region-proofs",
        {
            "actor_did": delegate_did,
            "grant_id": grant["grant_id"],
            "region_id": "multnomah_county",
        },
    )
    _expect(proof.get("verification_status") == "verified", "region proof was not verified")
    _log("region proof", str(proof["proof_id"]))

    proof_list = _json_request("GET", f"{base_url}/wallets/{wallet_id}/proofs")
    proof_ids = [item["proof_id"] for item in proof_list.get("proofs", [])]
    _expect(proof["proof_id"] in proof_ids, "GET /wallets/{wallet_id}/proofs did not include the created proof")
    _log("proof list", json.dumps(proof_ids))

    upload_bytes = b"proof-bundle-smoke"
    upload = _multipart_request(
        f"{base_url}/filecoin-upload",
        fields={
            "metadata": json.dumps(
                {
                    "walletId": wallet_id,
                    "sha256": hashlib.sha256(upload_bytes).hexdigest(),
                }
            )
        },
        files={"file": ("proofs.json", upload_bytes, "application/json")},
    )
    request_id = str(upload["requestId"])
    _expect(bool(upload.get("ipfsCid")), "/filecoin-upload did not return an ipfsCid")
    _expect(upload.get("filecoinPinStatus") == "queued", "/filecoin-upload did not return queued pin status")
    _log("filecoin upload", f"cid={upload['ipfsCid']} request_id={request_id}")

    upload_status = _json_request("GET", f"{base_url}/filecoin-upload/status/{request_id}")
    _expect(upload_status.get("requestId") == request_id, "/filecoin-upload/status returned the wrong requestId")
    _log("filecoin status", json.dumps(upload_status, sort_keys=True))

    sms = _json_request(
        "POST",
        f"{base_url}/messaging/messages/sms/outbound",
        {
            "to_phone": "503-555-0199",
            "message": "Smoke test check-in reminder",
            "wallet_id": wallet_id,
        },
    )
    _expect(sms.get("provider_status") == "queued", "SMS outbound route did not queue the message")
    _log("sms", str(sms.get("provider_message_id") or sms.get("message", {}).get("message_id") or "queued"))

    email = _json_request(
        "POST",
        f"{base_url}/messaging/messages/email/outbound",
        {
            "to_email": "abby@example.org",
            "subject": "Smoke test dead drop bundle",
            "body": "Please review the attached smoke test bundle.",
            "from_email": "abby@example.org",
            "wallet_id": wallet_id,
        },
    )
    _expect(email.get("provider_status") == "queued", "Email outbound route did not queue the message")
    _log("email", str(email.get("provider_message_id") or "queued"))

    call = _json_request(
        "POST",
        f"{base_url}/messaging/messages/calls/outbound",
        {
            "to_phone": "503-555-0101",
            "script": "This is a smoke test call from 211 AI.",
            "wallet_id": wallet_id,
        },
    )
    _expect(call.get("provider_status") == "queued", "Call outbound route did not queue the call")
    _log("call", str(call.get("provider_call_id") or call.get("provider_message_id") or "queued"))

    tts = _form_request(f"{base_url}/messaging/voice/tts", {"text": "Smoke test voice reply."})
    _expect(tts.get("text") == "Smoke test voice reply.", "/messaging/voice/tts returned unexpected text")
    _log("voice tts", json.dumps(tts, sort_keys=True))

    infer = _multipart_request(
        f"{base_url}/messaging/voice/infer",
        fields={
            "text": "Where can I find shelter tonight?",
            "userPrompt": "Where can I find shelter tonight?",
            "fallbackText": "I can help you find shelter tonight.",
        },
        files={"audio": ("input.wav", b"RIFFmockWAVE", "audio/wav")},
    )
    infer_text = str(infer.get("text", ""))
    if configured_mock_voice_reply:
        _expect(infer_text == configured_mock_voice_reply, "/messaging/voice/infer returned unexpected configured mock text")
    else:
        _expect("Where can I find shelter tonight?" in infer_text, "/messaging/voice/infer returned unexpected text")
    _log("voice infer", json.dumps(infer, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke test the local mock 211 AI compose stack.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080", help="Public base URL for the bundled stack.")
    args = parser.parse_args(argv)

    try:
        run_smoke(args.base_url)
    except Exception as exc:  # pragma: no cover - CLI failure path
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print("[ok] smoke test complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())