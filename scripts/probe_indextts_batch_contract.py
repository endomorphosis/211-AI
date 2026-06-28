#!/usr/bin/env python3
"""Probe the live IndexTTS contract, batch support, ZIP outputs, and throughput."""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import precompute_indextts_responses as precompute

DEFAULT_OUTPUT = precompute.REPO_ROOT / "tmp_assets/indextts-live-contract-probe.json"
DEFAULT_TEXTS = [
    "This is a short live contract probe for Abby.",
    "This is a second short live contract probe for Abby.",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-audio", type=Path, default=precompute.DEFAULT_REFERENCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--voice-description", default="Same as the voice reference")
    parser.add_argument(
        "--text",
        dest="texts",
        action="append",
        default=None,
        help="Probe text to synthesize. Repeat for multiple texts.",
    )
    parser.add_argument(
        "--benchmark-workers",
        type=int,
        action="append",
        default=None,
        help="Worker count(s) to benchmark for gen_single throughput. Repeat to test multiple levels.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=180.0,
        help="Timeout applied to live remote operations for this probe run.",
    )
    return parser.parse_args()


def summarize_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        summary: dict[str, Any] = {}
        for key in ("__type__", "path", "url", "name", "orig_name", "mime_type", "mimeType", "visible"):
            if key in value:
                summary[key] = value[key]
        if "value" in value:
            summary["value"] = summarize_value(value.get("value"))
        if not summary:
            summary["keys"] = sorted(str(key) for key in value.keys())[:10]
        return summary
    if isinstance(value, list):
        return [summarize_value(item) for item in value[:5]]
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)


def raw_post_json(url: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    headers = precompute.indextts_headers()
    headers["Content-Type"] = "application/json"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=precompute.indextts_timeout()) as response:
            text = response.read().decode("utf-8", errors="replace")
            return {
                "success": True,
                "status": int(response.status),
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "bodyPreview": text[:4000],
            }
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        return {
            "success": False,
            "status": int(exc.code),
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "errorType": type(exc).__name__,
            "bodyPreview": text[:4000],
        }
    except Exception as exc:
        return {
            "success": False,
            "status": None,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "errorType": type(exc).__name__,
            "error": str(exc),
        }


def queue_probe(label: str, fn_index: int, data: Sequence[Any]) -> dict[str, Any]:
    started = time.perf_counter()
    session_hash = uuid.uuid4().hex
    try:
        precompute.http_json(
            "POST",
            f"{precompute.indextts_base_url()}/gradio_api/queue/join",
            {"data": list(data), "fn_index": fn_index, "session_hash": session_hash},
        )
        result = precompute.wait_for_result(session_hash)
        outputs = precompute.gradio_output_values(result)
        generated_files = precompute.find_audio_references(outputs[1]) if len(outputs) >= 2 else []
        zip_ref = precompute.find_file_reference(outputs[2], suffixes=(".zip",)) if len(outputs) >= 3 else None
        zip_audio_count = None
        zip_fetch_error = None
        if zip_ref:
            try:
                archive, _mime_type = precompute.fetch_gradio_file(zip_ref)
                zip_audio_count = len(precompute.extract_audio_files_from_zip(archive))
            except Exception as exc:
                zip_fetch_error = f"{type(exc).__name__}: {exc}"
        batch_refs = precompute.batch_audio_references(result)
        return {
            "label": label,
            "success": True,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "outputCount": len(outputs),
            "outputsPreview": summarize_value(outputs[:3]),
            "generatedFileCount": len(generated_files),
            "batchAudioReferenceCount": len(batch_refs),
            "zipReturned": zip_ref is not None,
            "zipReference": summarize_value(zip_ref) if zip_ref else None,
            "zipAudioCount": zip_audio_count,
            "zipFetchError": zip_fetch_error,
        }
    except Exception as exc:
        return {
            "label": label,
            "success": False,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "errorType": type(exc).__name__,
            "error": str(exc),
        }


@contextlib.contextmanager
def temporary_env(updates: Mapping[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def benchmark_synthesize_batch(
    label: str,
    texts: Sequence[str],
    config: Mapping[str, Any],
    single_fn_index: int,
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    parallel_workers: int,
    batch_enabled: bool,
    require_batch: bool,
) -> dict[str, Any]:
    env_updates = {
        "WALLET_INDEXTTS_BATCH_ENABLED": "1" if batch_enabled else "0",
        "WALLET_INDEXTTS_REQUIRE_BATCH": "1" if require_batch else "0",
    }
    started = time.perf_counter()
    try:
        with temporary_env(env_updates):
            results = precompute.synthesize_batch(
                texts,
                config,
                single_fn_index,
                reference_audio,
                voice_description,
                parallel_workers=parallel_workers,
            )
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        batch_modes = sorted({str(item.get("batchMode") or "") for item in results})
        fallback_reasons = sorted(
            {
                str(item.get("batchFallbackReason") or "")
                for item in results
                if str(item.get("batchFallbackReason") or "")
            }
        )
        throughput = round(len(results) / max(elapsed_ms / 1000.0, 0.001), 3)
        return {
            "label": label,
            "success": True,
            "elapsedMs": elapsed_ms,
            "itemCount": len(results),
            "throughputItemsPerSecond": throughput,
            "parallelWorkers": parallel_workers,
            "batchEnabled": batch_enabled,
            "requireBatch": require_batch,
            "batchModes": batch_modes,
            "fallbackReasons": fallback_reasons,
            "itemLatencyMs": [int(item.get("latencyMs") or 0) for item in results],
            "batchLatencyMs": sorted({int(item.get("batchLatencyMs") or 0) for item in results if item.get("batchLatencyMs") is not None}),
        }
    except Exception as exc:
        return {
            "label": label,
            "success": False,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "parallelWorkers": parallel_workers,
            "batchEnabled": batch_enabled,
            "requireBatch": require_batch,
            "errorType": type(exc).__name__,
            "error": str(exc),
        }


def benchmark_parallel_gen_single(
    label: str,
    texts: Sequence[str],
    config: Mapping[str, Any],
    single_fn_index: int,
    reference_audio: Mapping[str, Any],
    voice_description: str,
    *,
    parallel_workers: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        if parallel_workers <= 1:
            results = [precompute.synthesize(text, config, single_fn_index, reference_audio, voice_description) for text in texts]
            batch_modes = ["sequential"]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(parallel_workers, len(texts))) as executor:
                futures = [
                    executor.submit(precompute.synthesize, text, config, single_fn_index, reference_audio, voice_description)
                    for text in texts
                ]
                results = [future.result() for future in futures]
            batch_modes = ["parallel"]
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        throughput = round(len(results) / max(elapsed_ms / 1000.0, 0.001), 3)
        return {
            "label": label,
            "success": True,
            "elapsedMs": elapsed_ms,
            "itemCount": len(results),
            "parallelWorkers": parallel_workers,
            "batchModes": batch_modes,
            "throughputItemsPerSecond": throughput,
            "itemLatencyMs": [int(item.get("latencyMs") or 0) for item in results],
        }
    except Exception as exc:
        return {
            "label": label,
            "success": False,
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "parallelWorkers": parallel_workers,
            "errorType": type(exc).__name__,
            "error": str(exc),
        }


def main() -> None:
    args = parse_args()
    os.environ.setdefault("WALLET_INDEXTTS_TIMEOUT_SECONDS", str(max(30.0, float(args.timeout_seconds))))
    texts = [text.strip() for text in (args.texts or DEFAULT_TEXTS) if str(text).strip()]
    if len(texts) < 2:
        raise ValueError("Provide at least two non-empty probe texts.")
    benchmark_workers = sorted({max(1, int(value)) for value in (args.benchmark_workers or [1, 2])})

    precompute.load_secret_env()
    config = precompute.indextts_config()
    info = precompute.http_json("GET", f"{precompute.indextts_base_url()}/gradio_api/info")
    single_fn_index = precompute.indextts_fn_index(config)
    contract = precompute.indextts_contract_summary(config, single_fn_index)
    reference_audio = precompute.upload_reference(args.reference_audio)
    single_input_count = precompute.lookup_dependency_input_count(config, single_fn_index)

    hidden_batch_payload = {
        "data": precompute.batch_request_data(
            texts,
            reference_audio,
            args.voice_description,
            input_count=max(25, int(contract.get("batchInputCount") or 25)),
        )
    }
    hidden_batch_routes = {
        "run": raw_post_json(f"{precompute.indextts_base_url()}/gradio_api/run/gen_batch", hidden_batch_payload),
        "call": raw_post_json(f"{precompute.indextts_base_url()}/gradio_api/call/gen_batch", hidden_batch_payload),
    }

    queue_probes: dict[str, Any] = {
        "genSingleSingle": queue_probe(
            "genSingleSingle",
            single_fn_index,
            precompute.request_data(texts[0], reference_audio, args.voice_description, input_count=single_input_count),
        ),
        "genSingleMultiText": queue_probe(
            "genSingleMultiText",
            single_fn_index,
            precompute.batch_request_data(texts, reference_audio, args.voice_description, input_count=single_input_count),
        ),
    }
    batch_fn_index = contract.get("batchFnIndex")
    if isinstance(batch_fn_index, int):
        queue_probes["genBatchQueue"] = queue_probe(
            "genBatchQueue",
            batch_fn_index,
            precompute.batch_request_data(
                texts,
                reference_audio,
                args.voice_description,
                input_count=precompute.lookup_dependency_input_count(config, batch_fn_index),
            ),
        )
    else:
        queue_probes["genBatchQueue"] = {
            "label": "genBatchQueue",
            "success": False,
            "skipped": True,
            "reason": contract.get("deploymentDriftReason") or "Batch endpoint is not registered in the live config.",
        }

    throughput: dict[str, Any] = {"parallelGenSingle": []}
    for workers in benchmark_workers:
        throughput["parallelGenSingle"].append(
            benchmark_parallel_gen_single(
                f"parallelGenSingle-{workers}",
                texts,
                config,
                single_fn_index,
                reference_audio,
                args.voice_description,
                parallel_workers=workers,
            )
        )
    throughput["batchEndpoint"] = benchmark_synthesize_batch(
        "batchEndpoint",
        texts,
        config,
        single_fn_index,
        reference_audio,
        args.voice_description,
        parallel_workers=max(benchmark_workers),
        batch_enabled=True,
        require_batch=True,
    )

    successful_parallel = [item for item in throughput["parallelGenSingle"] if item.get("success")]
    best_parallel = max(successful_parallel, key=lambda item: float(item.get("throughputItemsPerSecond") or 0.0)) if successful_parallel else None
    batch_success = throughput["batchEndpoint"] if throughput["batchEndpoint"].get("success") else None
    zip_observed = any(bool((probe or {}).get("zipReturned")) for probe in queue_probes.values() if isinstance(probe, Mapping))
    batch_endpoint_usable = bool(
        (queue_probes.get("genBatchQueue") or {}).get("success") or hidden_batch_routes["run"].get("success") or hidden_batch_routes["call"].get("success")
    )
    throughput_comparison = None
    if batch_success and best_parallel:
        throughput_comparison = {
            "batchItemsPerSecond": batch_success.get("throughputItemsPerSecond"),
            "bestParallelItemsPerSecond": best_parallel.get("throughputItemsPerSecond"),
            "batchFasterThanBestParallel": float(batch_success.get("throughputItemsPerSecond") or 0.0)
            > float(best_parallel.get("throughputItemsPerSecond") or 0.0),
        }

    conclusions = {
        "batchEndpointUsable": batch_endpoint_usable,
        "zipFilesObserved": zip_observed,
        "batchMoreThroughputThanParallelGenSingle": throughput_comparison["batchFasterThanBestParallel"] if throughput_comparison else None,
        "recommendedMode": contract.get("recommendedMode"),
        "proofSummary": (
            "The live Space registered gen_batch and returned multi-file batch outputs."
            if batch_endpoint_usable
            else "The live Space does not expose a usable gen_batch contract; the best available measured path is parallel gen_single."
        ),
    }

    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "spaceUrl": precompute.indextts_base_url(),
        "auth": precompute.describe_indextts_auth(),
        "referenceAudio": str(args.reference_audio),
        "probeTexts": texts,
        "contract": contract,
        "namedEndpoints": sorted((info.get("named_endpoints") or {}).keys()),
        "hiddenBatchRoutes": hidden_batch_routes,
        "queueProbes": queue_probes,
        "throughput": throughput,
        "throughputComparison": throughput_comparison,
        "conclusions": conclusions,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "conclusions": conclusions, "throughputComparison": throughput_comparison}, indent=2))


if __name__ == "__main__":
    main()