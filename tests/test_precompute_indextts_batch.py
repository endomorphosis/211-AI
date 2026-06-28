from __future__ import annotations

import io
import zipfile
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace

from scripts import precompute_indextts_responses as precompute


def test_indextts_batch_fn_index_discovers_configured_api(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_API_NAME", "gen_batch")

    assert precompute.indextts_batch_fn_index({"dependencies": [{"id": 6, "api_name": "/gen_single"}, {"id": 9, "api_name": "/gen_batch"}]}) == 9


def test_batch_request_data_supports_template(monkeypatch) -> None:
    reference = {"path": "/tmp/ref.wav", "meta": {"_type": "gradio.FileData"}}
    monkeypatch.setenv(
        "WALLET_INDEXTTS_BATCH_DATA_TEMPLATE",
        '[{reference_audio}, {texts}, {voice_description}]',
    )

    assert precompute.batch_request_data(["one", "two"], reference, "Same voice") == [reference, ["one", "two"], "Same voice"]


def test_batch_request_data_default_matches_indextts_gradio_schema(monkeypatch) -> None:
    monkeypatch.delenv("WALLET_INDEXTTS_BATCH_DATA_TEMPLATE", raising=False)
    reference = {"path": "/tmp/ref.wav", "meta": {"_type": "gradio.FileData"}}

    data = precompute.batch_request_data(["one", "two"], reference, "Same voice")

    assert len(data) == 25
    assert data[0] == "Same as the voice reference"
    assert data[1] == reference
    assert data[2] == '["one", "two"]'
    assert data[13] == "Same voice"
    assert data[16] == 2


def test_request_data_defaults_to_legacy_single_contract() -> None:
    reference = {"path": "/tmp/ref.wav", "meta": {"_type": "gradio.FileData"}}

    data = precompute.request_data("one", reference, "Same voice")

    assert len(data) == 24
    assert data[2] == "one"
    assert data[13] == "Same voice"
    assert data[16] is True


def test_request_data_supports_new_segments_bucket_contract() -> None:
    reference = {"path": "/tmp/ref.wav", "meta": {"_type": "gradio.FileData"}}

    data = precompute.request_data("one", reference, "Same voice", input_count=25)

    assert len(data) == 25
    assert data[16] == 0
    assert data[17] is True


def test_batch_request_data_supports_legacy_batch_contract() -> None:
    reference = {"path": "/tmp/ref.wav", "meta": {"_type": "gradio.FileData"}}

    data = precompute.batch_request_data(["one", "two"], reference, "Same voice", input_count=24)

    assert len(data) == 24
    assert data[2] == '["one", "two"]'
    assert data[16] is True


def test_lookup_dependency_input_count_reads_dependency_inputs() -> None:
    assert precompute.lookup_dependency_input_count(
        {"dependencies": [{"id": 6, "api_name": "/gen_single", "inputs": list(range(25))}]},
        6,
    ) == 25


def test_indextts_config_delegates_to_generic_space_client(monkeypatch) -> None:
    class FakeClient:
        def get_config(self) -> dict[str, object]:
            return {"dependencies": [{"id": 1, "api_name": "/gen_single"}]}

    monkeypatch.setattr(precompute, "indextts_space_client", lambda: FakeClient())

    assert precompute.indextts_config() == {"dependencies": [{"id": 1, "api_name": "/gen_single"}]}


def test_wait_for_result_delegates_to_generic_space_client(monkeypatch) -> None:
    class FakeClient:
        def wait_for_queue_result(
            self,
            session_hash: str,
            *,
            timeout_seconds: float,
            poll_interval_seconds: float,
        ) -> dict[str, object]:
            assert session_hash == "session-123"
            assert timeout_seconds > 0
            assert poll_interval_seconds == 0.5
            return {"data": [{"path": "/tmp/out.wav"}]}

    monkeypatch.setattr(precompute, "indextts_space_client", lambda: FakeClient())

    assert precompute.wait_for_result("session-123") == {"data": [{"path": "/tmp/out.wav"}]}


def test_synthesize_batch_falls_back_to_single_when_batch_missing(monkeypatch) -> None:
    calls: list[str] = []

    def fake_synthesize(
        text: str,
        config: Mapping[str, object],
        fn_index: int,
        reference_audio: Mapping[str, object],
        voice_description: str,
    ) -> dict[str, object]:
        calls.append(text)
        return {"audio": b"RIFFstubWAVE", "mimeType": "audio/wav", "latencyMs": 3}

    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_ENABLED", "1")
    monkeypatch.setattr(precompute, "synthesize", fake_synthesize)

    result = precompute.synthesize_batch(
        ["hello", "world"],
        {"dependencies": [{"id": 6, "api_name": "/gen_single"}]},
        6,
        {"path": "/tmp/ref.wav"},
        "Same voice",
    )

    assert calls == ["hello", "world"]
    assert [item["batchMode"] for item in result] == ["sequential-fallback", "sequential-fallback"]
    assert all("not found" in str(item.get("batchFallbackReason") or "") for item in result)


def test_synthesize_batch_split_fallback_salvages_large_batch(monkeypatch) -> None:
    def fake_direct_batch(
        texts: list[str],
        config: Mapping[str, object],
        reference_audio: Mapping[str, object],
        voice_description: str,
    ) -> list[dict[str, object]]:
        if len(texts) > 2:
            raise RuntimeError("ZeroGPU worker error")
        return [
            {
                "audio": f"RIFF-{text}".encode("utf-8"),
                "mimeType": "audio/wav",
                "latencyMs": 4,
                "batchLatencyMs": 4,
                "batchMode": "batch",
            }
            for text in texts
        ]

    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_ENABLED", "1")
    monkeypatch.setattr(precompute, "direct_batch_synthesis", fake_direct_batch)

    result = precompute.synthesize_batch(
        ["one", "two", "three", "four", "five", "six", "seven", "eight"],
        {"dependencies": [{"id": 6, "api_name": "/gen_single"}, {"id": 9, "api_name": "/gen_batch"}]},
        6,
        {"path": "/tmp/ref.wav"},
        "Same voice",
    )

    assert len(result) == 8
    assert all(item["batchMode"] == "batch-split-fallback" for item in result)
    assert all(item["batchRequestedSize"] == 8 for item in result)
    assert all(item["batchExecutedSize"] == 2 for item in result)
    assert all(item["batchSplitDepth"] == 2 for item in result)
    assert all("ZeroGPU worker error" in str(item.get("batchFallbackReason") or "") for item in result)


def test_adaptive_split_batch_synthesis_falls_back_to_single_for_irreducible_failure(monkeypatch) -> None:
    calls: list[str] = []

    def fake_direct_batch(
        texts: list[str],
        config: Mapping[str, object],
        reference_audio: Mapping[str, object],
        voice_description: str,
    ) -> list[dict[str, object]]:
        raise RuntimeError("ZeroGPU worker error")

    def fake_synthesize(
        text: str,
        config: Mapping[str, object],
        fn_index: int,
        reference_audio: Mapping[str, object],
        voice_description: str,
    ) -> dict[str, object]:
        calls.append(text)
        return {"audio": b"RIFFstubWAVE", "mimeType": "audio/wav", "latencyMs": 3}

    monkeypatch.setattr(precompute, "direct_batch_synthesis", fake_direct_batch)
    monkeypatch.setattr(precompute, "synthesize", fake_synthesize)

    result = precompute.synthesize_batch(
        ["hello"],
        {"dependencies": [{"id": 6, "api_name": "/gen_single"}, {"id": 9, "api_name": "/gen_batch"}]},
        6,
        {"path": "/tmp/ref.wav"},
        "Same voice",
    )

    assert calls == ["hello"]
    assert result[0]["batchMode"] == "sequential-split-fallback"
    assert result[0]["batchRequestedSize"] == 1
    assert result[0]["batchExecutedSize"] == 1
    assert "ZeroGPU worker error" in str(result[0].get("batchFallbackReason") or "")


def test_indextts_contract_summary_reports_missing_batch_alias(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_API_NAME", "/gen_batch")

    summary = precompute.indextts_contract_summary(
        {"dependencies": [{"id": 6, "api_name": "/gen_single", "inputs": list(range(24))}]},
        6,
    )

    assert summary["singleContract"] == "legacy-24-field"
    assert summary["batchRegistered"] is False
    assert summary["recommendedMode"] == "parallel-gen-single"
    assert "/gen_single" in summary["registeredApiNames"]
    assert "deploymentDriftReason" in summary


def test_indextts_contract_summary_reports_registered_batch_alias(monkeypatch) -> None:
    monkeypatch.setenv("WALLET_INDEXTTS_BATCH_API_NAME", "/gen_batch")

    summary = precompute.indextts_contract_summary(
        {
            "dependencies": [
                {"id": 6, "api_name": "/gen_single", "inputs": list(range(25))},
                {"id": 9, "api_name": "/gen_batch", "inputs": list(range(25))},
            ]
        },
        6,
    )

    assert summary["singleContract"] == "segments-bucket-25-field"
    assert summary["batchRegistered"] is True
    assert summary["batchFnIndex"] == 9
    assert summary["batchContract"] == "segments-bucket-25-field"
    assert summary["recommendedMode"] == "gen_batch"


def test_normalize_slot_value_text_keeps_address_digits_spaced_and_ordinals_intact() -> None:
    normalized = precompute.normalize_slot_value_text("address", "530 NW 27th Street Corvallis, OR 97330")

    assert "five three zero" in normalized
    assert "twenty seventh Street" in normalized
    assert "nine seven three three zero" in normalized
    assert "fivethreezero" not in normalized
    assert "twoseventh" not in normalized


def test_batch_audio_references_prefers_generated_file_list() -> None:
    result = {
        "data": [
            {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
            {"__type__": "update", "value": [{"path": "/tmp/item-1.wav"}, {"path": "/tmp/item-2.wav"}]},
            {"__type__": "update", "value": None},
        ]
    }

    assert precompute.batch_audio_references(result) == [{"path": "/tmp/item-1.wav"}, {"path": "/tmp/item-2.wav"}]


def test_batch_audio_references_extracts_zip_output(monkeypatch) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("item-1.wav", b"RIFFoneWAVE")
        archive.writestr("item-2.wav", b"RIFFtwoWAVE")
    monkeypatch.setattr(precompute, "fetch_gradio_file", lambda ref: (buffer.getvalue(), "application/zip"))
    result = {
        "data": [
            {"__type__": "update", "value": {"path": "/tmp/preview.wav"}},
            {"__type__": "update", "value": []},
            {"__type__": "update", "value": {"path": "/tmp/batch.zip"}},
        ]
    }

    refs = precompute.batch_audio_references(result)

    assert [ref["name"] for ref in refs] == ["item-1.wav", "item-2.wav"]
    assert refs[1]["_inline_bytes"] == b"RIFFtwoWAVE"


def test_detects_indextts_quota_exceeded_message() -> None:
    message = (
        "IndexTTS queue failed: {'error': 'You have exceeded your Pro ZeroGPU quota "
        "(60s requested vs. 53s left). Try again in 23:05:50.'}"
    )

    assert precompute.is_indextts_quota_exceeded_error(message) is True
    assert precompute.indextts_retry_after_hint(message) == "23:05:50"


def test_raise_if_indextts_quota_exceeded_raises_typed_error() -> None:
    message = "ZeroGPU quota exceeded. Try again in 01:02:03."

    try:
        precompute.raise_if_indextts_quota_exceeded(message)
    except precompute.IndexTTSQuotaExceededError as exc:
        assert exc.retry_after == "01:02:03"
    else:
        raise AssertionError("Expected IndexTTSQuotaExceededError")


def test_bucket_sync_targets_default_to_audio_and_metadata_subpaths() -> None:
    targets = precompute.bucket_sync_targets("hf://buckets/Publicus/abby-voice")

    assert targets == {
        "bucketUri": "hf://buckets/Publicus/abby-voice",
        "audioUri": "hf://buckets/Publicus/abby-voice/audio",
        "metadataUri": "hf://buckets/Publicus/abby-voice/metadata",
    }


def test_sync_generated_outputs_to_bucket_invokes_hf_sync_for_audio_and_metadata(monkeypatch, tmp_path: Path) -> None:
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    (output_dir / "sample.mp3").write_bytes(b"mp3")
    manifest_path = tmp_path / "manifest.json"
    public_manifest_path = tmp_path / "public-manifest.json"
    manifest_path.write_text("{}", encoding="utf-8")
    public_manifest_path.write_text("{}", encoding="utf-8")

    calls: list[list[str]] = []

    monkeypatch.setattr(precompute, "load_secret_env", lambda: None)
    monkeypatch.setattr(precompute, "hf_cli_executable", lambda: "/usr/bin/hf")

    def fake_run(command: list[str], **kwargs: object) -> SimpleNamespace:
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout="synced", stderr="")

    monkeypatch.setattr(precompute.subprocess, "run", fake_run)

    summary = precompute.sync_generated_outputs_to_bucket(
        output_dir,
        manifest_path,
        public_manifest_path,
        "hf://buckets/Publicus/abby-voice",
    )

    assert calls[0] == ["/usr/bin/hf", "sync", str(output_dir), "hf://buckets/Publicus/abby-voice/audio"]
    assert calls[1][0:2] == ["/usr/bin/hf", "sync"]
    assert calls[1][-1] == "hf://buckets/Publicus/abby-voice/metadata"
    assert summary["audioUri"] == "hf://buckets/Publicus/abby-voice/audio"
    assert summary["metadataUri"] == "hf://buckets/Publicus/abby-voice/metadata"
