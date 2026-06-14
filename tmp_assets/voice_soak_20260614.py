import json
import time
import concurrent.futures
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://211-ai.com"
N = 10

stats = {k: [] for k in ["tts", "infer", "batch"]}


def call_form(path: str, payload: dict, timeout: int = 35) -> dict:
    started = time.time()
    req = urllib.request.Request(
        BASE + path,
        data=urllib.parse.urlencode(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            parsed = json.loads(body)
            return {
                "ok": True,
                "status": response.status,
                "elapsed": round(time.time() - started, 3),
                "result_path": ((parsed.get("latency") or {}).get("result_path")),
                "audio": bool(parsed.get("audioBase64")),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "status": exc.code,
            "elapsed": round(time.time() - started, 3),
            "result_path": None,
            "error": body[:120].replace("\n", " "),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": None,
            "elapsed": round(time.time() - started, 3),
            "result_path": None,
            "error": f"{type(exc).__name__}: {exc}",
        }


def call_batch(timeout: int = 35) -> dict:
    started = time.time()
    req = urllib.request.Request(
        BASE + "/voice/indextts/batch",
        data=json.dumps({"texts": ["soak-a", "soak-b"]}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            parsed = json.loads(body)
            return {
                "ok": True,
                "status": response.status,
                "elapsed": round(time.time() - started, 3),
                "result_path": ((parsed.get("latency") or {}).get("result_path")),
                "audio_list_len": len(parsed.get("audioBase64List") or []),
            }
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        return {
            "ok": False,
            "status": exc.code,
            "elapsed": round(time.time() - started, 3),
            "result_path": None,
            "error": body[:120].replace("\n", " "),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": None,
            "elapsed": round(time.time() - started, 3),
            "result_path": None,
            "error": f"{type(exc).__name__}: {exc}",
        }


def with_hard_timeout(fn, hard_timeout: int = 20) -> dict:
    started = time.time()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(fn)
    try:
        return future.result(timeout=hard_timeout)
    except concurrent.futures.TimeoutError:
        future.cancel()
        return {
            "ok": False,
            "status": None,
            "elapsed": round(time.time() - started, 3),
            "result_path": None,
            "error": f"hard-timeout-{hard_timeout}s",
        }
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def pct(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    k = (len(ordered) - 1) * fraction
    f = int(k)
    c = min(f + 1, len(ordered) - 1)
    if f == c:
        return round(ordered[f], 3)
    return round(ordered[f] + (ordered[c] - ordered[f]) * (k - f), 3)


for _ in range(3):
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=20) as response:
            print("warmup_health", response.status, flush=True)
            if response.status == 200:
                break
    except Exception as exc:
        print("warmup_health_err", type(exc).__name__, flush=True)

for i in range(1, N + 1):
    tts = with_hard_timeout(lambda: call_form("/voice/indextts/tts", {"text": f"soak-tts-{i}"}))
    infer = with_hard_timeout(lambda: call_form("/voice/indextts/infer", {"mode": "chat", "text": f"soak-infer-{i}"}))
    batch = with_hard_timeout(call_batch)

    stats["tts"].append(tts)
    stats["infer"].append(infer)
    stats["batch"].append(batch)

    print(
        "cycle",
        i,
        "tts",
        tts["status"],
        tts["elapsed"],
        tts.get("result_path"),
        "infer",
        infer["status"],
        infer["elapsed"],
        infer.get("result_path"),
        "batch",
        batch["status"],
        batch["elapsed"],
        batch.get("result_path"),
        "audio_list_len",
        batch.get("audio_list_len"),
        flush=True,
    )

summary = {}
for name, entries in stats.items():
    elapsed = [entry["elapsed"] for entry in entries]
    success = sum(1 for entry in entries if entry["ok"])
    path_counts = {}
    for entry in entries:
        rp = entry.get("result_path")
        path_counts[rp] = path_counts.get(rp, 0) + 1
    summary[name] = {
        "success": success,
        "total": len(entries),
        "p50": pct(elapsed, 0.5),
        "p95": pct(elapsed, 0.95),
        "max": max(elapsed) if elapsed else None,
        "result_path_counts": path_counts,
        "sample_failures": [entry for entry in entries if not entry["ok"]][:3],
    }

print("SOAK_SUMMARY_START", flush=True)
print(json.dumps(summary, indent=2), flush=True)
print("SOAK_SUMMARY_END", flush=True)
