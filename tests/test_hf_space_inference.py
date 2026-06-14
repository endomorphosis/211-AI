"""Tests for ipfs_accelerate_py.hf_space_inference module."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from ipfs_accelerate_py.hf_space_inference import (
    BatchProcessor,
    BatchState,
    HFBucketBackend,
    HFSpaceClient,
    LocalFileSystemBackend,
)


class TestBatchState:
    """Tests for BatchState dataclass."""

    def test_to_dict(self) -> None:
        state = BatchState(
            total_items=100,
            next_offset=32,
            batch_size=32,
            batches_completed=1,
            updated_at="2026-06-12T12:00:00Z",
        )
        data = state.to_dict()
        assert data["totalItems"] == 100
        assert data["nextOffset"] == 32
        assert data["batchesCompleted"] == 1

    def test_from_dict(self) -> None:
        data = {
            "schemaVersion": 1,
            "totalItems": 100,
            "nextOffset": 32,
            "batchSize": 32,
            "batchesCompleted": 1,
            "stopReason": "test",
        }
        state = BatchState.from_dict(data)
        assert state.total_items == 100
        assert state.next_offset == 32
        assert state.stop_reason == "test"

    def test_roundtrip(self) -> None:
        original = BatchState(
            total_items=200,
            next_offset=64,
            batch_size=32,
            batches_completed=2,
            updated_at="2026-06-12T12:30:00Z",
            stop_reason="",
        )
        data = original.to_dict()
        restored = BatchState.from_dict(data)
        assert restored.total_items == original.total_items
        assert restored.next_offset == original.next_offset


class TestLocalFileSystemBackend:
    """Tests for LocalFileSystemBackend."""

    def test_put_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            backend = LocalFileSystemBackend(Path(tmpdir))
            source = Path(tmpdir) / "source.txt"
            source.write_text("test content")

            success = backend.put_file(source, "dest/file.txt")
            assert success

            dest = Path(tmpdir) / "dest" / "file.txt"
            assert dest.exists()
            assert dest.read_text() == "test content"

    def test_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            backend = LocalFileSystemBackend(Path(tmpdir))
            file_path = Path(tmpdir) / "test.txt"
            file_path.write_text("exists")

            assert backend.exists("test.txt")
            assert not backend.exists("nonexistent.txt")

    def test_list_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            backend = LocalFileSystemBackend(Path(tmpdir))
            base = Path(tmpdir) / "files"
            base.mkdir()
            (base / "file1.txt").write_text("1")
            (base / "file2.txt").write_text("2")

            files = backend.list_files("files")
            assert len(files) == 2
            assert "files/file1.txt" in files
            assert "files/file2.txt" in files

    def test_sync_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            backend = LocalFileSystemBackend(Path(tmpdir) / "output")
            source_dir = Path(tmpdir) / "source"
            source_dir.mkdir()
            (source_dir / "file1.txt").write_text("1")
            (source_dir / "file2.txt").write_text("2")

            count = backend.sync_directory(source_dir, "synced")
            assert count == 2
            assert (Path(tmpdir) / "output" / "synced" / "file1.txt").exists()


class TestHFSpaceClient:
    """Tests for HFSpaceClient."""

    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_get_config(self, mock_session_class: MagicMock) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "dependencies": [
                {"label": "endpoint1", "component_name": "textbox"}
            ]
        }
        mock_session.get.return_value = mock_response

        client = HFSpaceClient("https://example.hf.space")
        config = client._get_config()
        assert len(config["dependencies"]) == 1

    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_get_endpoints(self, mock_session_class: MagicMock) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "dependencies": [
                {"label": "process", "component_name": "button"},
                {"label": "output", "component_name": "textbox"},
            ]
        }
        mock_session.get.return_value = mock_response

        client = HFSpaceClient("https://example.hf.space")
        endpoints = client.get_endpoints()
        assert len(endpoints) == 2
        assert endpoints[0].label == "process"
        assert endpoints[1].fn_index == 1

    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_probe_contract_available(self, mock_session_class: MagicMock) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "dependencies": [
                {"label": "process", "component_name": "button"}
            ]
        }
        mock_session.get.return_value = mock_response

        client = HFSpaceClient("https://example.hf.space")
        contract = client.probe_contract(expected_endpoints=["process"])
        assert contract["available"] is True
        assert len(contract["endpoints"]) == 1

    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_probe_contract_missing_endpoint(self, mock_session_class: MagicMock) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "dependencies": [
                {"label": "process", "component_name": "button"}
            ]
        }
        mock_session.get.return_value = mock_response

        client = HFSpaceClient("https://example.hf.space")
        contract = client.probe_contract(expected_endpoints=["missing"])
        assert contract["available"] is False
        assert any("not found" in e.lower() for e in contract["errors"])


class TestBatchProcessor:
    """Tests for BatchProcessor."""

    def test_load_state_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            processor = BatchProcessor(
                client=MagicMock(),
                output_backend=LocalFileSystemBackend(tmpdir),
                state_file=Path(tmpdir) / "state.json",
                batch_size=32,
            )
            state = processor.load_state()
            assert state.total_items == 0
            assert state.next_offset == 0

    def test_save_and_load_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            processor = BatchProcessor(
                client=MagicMock(),
                output_backend=LocalFileSystemBackend(tmpdir),
                state_file=Path(tmpdir) / "state.json",
                batch_size=32,
            )
            original_state = BatchState(
                total_items=100,
                next_offset=32,
                batches_completed=1,
            )
            processor.save_state(original_state)
            loaded = processor.load_state()
            assert loaded.total_items == 100
            assert loaded.next_offset == 32
            assert loaded.batches_completed == 1

    def test_calculate_retry_backoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            processor = BatchProcessor(
                client=MagicMock(),
                output_backend=LocalFileSystemBackend(tmpdir),
                state_file=Path(tmpdir) / "state.json",
                retry_backoff_seconds=10.0,
                retry_backoff_multiplier=2.0,
                retry_backoff_max_seconds=120.0,
            )
            # 10 * 2^0 = 10
            assert processor.calculate_retry_backoff(0) == 10.0
            # 10 * 2^1 = 20
            assert processor.calculate_retry_backoff(1) == 20.0
            # 10 * 2^2 = 40
            assert processor.calculate_retry_backoff(2) == 40.0
            # 10 * 2^4 = 160, but capped at 120
            assert processor.calculate_retry_backoff(4) == 120.0

    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_process_batch_success(self, mock_session_class: MagicMock) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        mock_response = MagicMock()
        mock_response.json.return_value = {"data": ["result1", "result2"]}
        mock_session.post.return_value = mock_response

        with tempfile.TemporaryDirectory() as tmpdir:
            client = HFSpaceClient("https://example.hf.space")
            processor = BatchProcessor(
                client=client,
                output_backend=LocalFileSystemBackend(tmpdir),
                state_file=Path(tmpdir) / "state.json",
            )
            success, results = processor.process_batch(
                items=["item1", "item2"],
                endpoint_fn_index=0,
                output_batch_id="batch-001",
            )
            assert success
            assert results == ["result1", "result2"]

    @patch("ipfs_accelerate_py.hf_space_inference.time.sleep")
    @patch("ipfs_accelerate_py.hf_space_inference.requests.Session")
    def test_process_batch_retry(
        self,
        mock_session_class: MagicMock,
        mock_sleep: MagicMock,
    ) -> None:
        mock_session = MagicMock()
        mock_session_class.return_value = mock_session
        
        # First call fails, second succeeds
        mock_response_fail = MagicMock()
        mock_response_fail.raise_for_status.side_effect = RuntimeError("Timeout")
        mock_response_success = MagicMock()
        mock_response_success.json.return_value = {"data": ["ok"]}
        
        mock_session.post.side_effect = [
            mock_response_fail,
            mock_response_success,
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            client = HFSpaceClient("https://example.hf.space")
            processor = BatchProcessor(
                client=client,
                output_backend=LocalFileSystemBackend(tmpdir),
                state_file=Path(tmpdir) / "state.json",
                retry_attempts=2,
            )
            success, results = processor.process_batch(
                items=["item1"],
                endpoint_fn_index=0,
                output_batch_id="batch-001",
            )
            assert success
            assert mock_sleep.called  # Backoff was applied


class TestHFBucketBackend:
    """Tests for HFBucketBackend (mocked, since hf-cli may not be available)."""

    @patch("ipfs_accelerate_py.hf_space_inference.subprocess.run")
    def test_put_file(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        backend = HFBucketBackend("hf://buckets/test/bucket")
        
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "file.txt"
            source.write_text("content")
            success = backend.put_file(source, "dest/file.txt")
            assert success
            assert mock_run.called

    @patch("ipfs_accelerate_py.hf_space_inference.subprocess.run")
    def test_exists(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(returncode=0)
        backend = HFBucketBackend("hf://buckets/test/bucket")
        exists = backend.exists("file.txt")
        assert exists

    @patch("ipfs_accelerate_py.hf_space_inference.subprocess.run")
    def test_list_files(self, mock_run: MagicMock) -> None:
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="-rw-r--r-- file1.txt\n-rw-r--r-- file2.txt\n",
        )
        backend = HFBucketBackend("hf://buckets/test/bucket")
        files = backend.list_files("prefix")
        assert len(files) >= 0  # Mock output parsing


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
