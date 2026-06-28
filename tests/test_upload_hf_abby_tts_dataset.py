from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.upload_hf_abby_tts_dataset import build_query_index, stage_abby_tts_dataset


class UploadHfAbbyTtsDatasetTests(unittest.TestCase):
    def test_stage_dataset_dedupes_text_hash_and_copies_audio(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo_root = Path(tmpdir)
            docs_dir = repo_root / "docs"
            audio_dir = repo_root / "wallet_interface" / "ui" / "public" / "assets" / "audio" / "precomputed" / "pregenerated-text-slot-phone-indextts"
            docs_dir.mkdir(parents=True)
            audio_dir.mkdir(parents=True)

            text = "Call two one one for help"
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
            manifest_path = docs_dir / "pregenerated_text_audio_slot_phone_public_manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "updatedAt": "2026-05-29T00:00:00Z",
                        "responses": [
                            {
                                "id": f"abby-tts-slot-value-{text_hash}",
                                "textHash": text_hash,
                                "text": text,
                                "originalTexts": ["Call 211 for help"],
                                "routes": ["/services/help"],
                                "slottedIntentIds": ["contact_support"],
                                "slottedCanonicalQueryTemplates": ["call 211"],
                                "slottedResponseFrameIds": ["frame-help"],
                                "slottedResponseSignatures": ["sig-help"],
                                "slottedEdgeIds": ["edge-help"],
                                "serviceTags": ["help"],
                                "locationTags": ["oregon"],
                                "sourceTypes": ["audio_plan.slot_value"],
                                "sourceIds": ["audio-slot::phone::demo"],
                                "status": "generated_mp3",
                                "preferredAudioPath": f"wallet_interface/ui/public/assets/audio/precomputed/pregenerated-text-slot-phone-indextts/abby-tts-{text_hash}.mp3",
                                "preferredMimeType": "audio/mpeg",
                            }
                        ],
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            source_audio = audio_dir / f"abby-tts-{text_hash}.mp3"
            source_audio.write_bytes(b"fake mp3 bytes")

            stage_dir = repo_root / "tmp_assets" / "hf-abby-tts-dataset"
            result = stage_abby_tts_dataset(
                repo_root=repo_root,
                manifest_paths=[manifest_path],
                provenance_paths=[manifest_path],
                audio_roots=[repo_root / "wallet_interface" / "ui" / "public" / "assets" / "audio" / "precomputed"],
                stage_dir=stage_dir,
                repo_id="endomorphosis/211-info",
                remote_prefix="audio/abby-tts/current",
                write_parquet_files=False,
            )

            self.assertEqual(result["recordCount"], 1)
            self.assertEqual(result["audioAvailableCount"], 1)
            self.assertEqual(result["runtimeManifestResponseCount"], 1)
            staged_audio = stage_dir / "audio" / f"abby-tts-{text_hash}.mp3"
            self.assertTrue(staged_audio.exists())
            self.assertEqual(staged_audio.read_bytes(), b"fake mp3 bytes")

            jsonl_path = stage_dir / "metadata" / "abby_tts_responses.jsonl"
            rows = [json.loads(line) for line in jsonl_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["id"], f"abby-tts-{text_hash}")
            self.assertEqual(row["textHash"], text_hash)
            self.assertEqual(row["manifestIds"], [f"abby-tts-slot-value-{text_hash}"])
            self.assertEqual(row["datasetAudioPath"], f"audio/abby-tts-{text_hash}.mp3")
            self.assertEqual(row["routes"], ["/services/help"])
            self.assertEqual(row["slottedIntentIds"], ["contact_support"])
            self.assertEqual(row["slottedCanonicalQueryTemplates"], ["call 211"])
            self.assertEqual(row["slottedResponseFrameIds"], ["frame-help"])
            self.assertEqual(row["slottedResponseSignatures"], ["sig-help"])
            self.assertEqual(row["slottedEdgeIds"], ["edge-help"])
            self.assertEqual(row["sourceTypes"], ["audio_plan.slot_value"])

            runtime_manifest = json.loads((stage_dir / "metadata" / "abby_tts_runtime_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(runtime_manifest["responseCount"], 1)
            runtime_entry = runtime_manifest["responses"][0]
            self.assertEqual(runtime_entry["id"], f"abby-tts-{text_hash}")
            self.assertEqual(runtime_entry["preferredAudioUrl"], "https://huggingface.co/datasets/endomorphosis/211-info/resolve/main/audio/abby-tts/current/audio/abby-tts-" + text_hash + ".mp3")
            self.assertEqual(runtime_entry["routes"], ["/services/help"])
            self.assertEqual(runtime_entry["slottedIntentIds"], ["contact_support"])

            provenance_copy = stage_dir / "provenance" / "docs" / manifest_path.name
            self.assertTrue(provenance_copy.exists())

    def test_build_query_index_groups_records_by_lookup_facets(self) -> None:
        query_index = build_query_index(
            [
                {
                    "id": "abby-tts-1234567890abcdef1234",
                    "textHash": "1234567890abcdef1234",
                    "text": "Call two one one",
                    "datasetAudioPath": "audio/abby-tts-1234567890abcdef1234.mp3",
                    "datasetAudioUrl": "https://huggingface.co/datasets/endomorphosis/211-info/resolve/main/audio/abby-tts/current/audio/abby-tts-1234567890abcdef1234.mp3",
                    "audioAvailable": True,
                    "routes": ["/services/help"],
                    "serviceTags": ["help"],
                    "locationTags": ["oregon"],
                    "sourceTypes": ["audio_plan.slot_value"],
                    "manifestPaths": ["docs/pregenerated_text_audio_slot_phone_public_manifest.json"],
                    "statuses": ["generated_mp3"],
                }
            ]
        )

        self.assertEqual(query_index["byTextHash"]["1234567890abcdef1234"], "abby-tts-1234567890abcdef1234")
        self.assertEqual(query_index["byRoute"]["/services/help"], ["abby-tts-1234567890abcdef1234"])
        self.assertEqual(query_index["byServiceTag"]["help"], ["abby-tts-1234567890abcdef1234"])
        self.assertEqual(query_index["byLocationTag"]["oregon"], ["abby-tts-1234567890abcdef1234"])


if __name__ == "__main__":
    unittest.main()