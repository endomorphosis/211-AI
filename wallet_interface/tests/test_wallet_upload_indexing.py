from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
VENDORED_IPFS_DATASETS = REPO_ROOT / "ipfs_datasets_py"
for path in (str(VENDORED_IPFS_DATASETS), str(REPO_ROOT)):
    if path not in sys.path:
        sys.path.insert(0, path)

from wallet_interface.api import create_app
from wallet_interface.app_service import WalletInterfaceService


def test_uploaded_wallet_file_gets_vector_and_graphrag_indexes(tmp_path, monkeypatch):
    monkeypatch.setenv("IPFS_AUTO_INSTALL", "false")
    monkeypatch.setenv("IPFS_DATASETS_AUTO_INSTALL", "false")
    monkeypatch.setenv("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")
    monkeypatch.setenv("WALLET_IPFS_UPLOAD_BACKEND", "mock")

    service = WalletInterfaceService(
        repository_root=tmp_path / "wallet-repository",
        storage_config={"primary": {"type": "local", "root": str(tmp_path / "wallet-blobs")}},
        auto_load_repository=False,
        auto_persist=True,
    )
    client = TestClient(create_app(service=service))

    owner_did = "did:key:indexing-owner"
    wallet_response = client.post("/wallets", json={"owner_did": owner_did})
    assert wallet_response.status_code == 200, wallet_response.text
    wallet_id = wallet_response.json()["wallet_id"]

    upload_response = client.post(
        f"/wallets/{wallet_id}/documents",
        data={"actor_did": owner_did, "title": "Indexing validation upload"},
        files={
            "file": (
                "indexing-validation.txt",
                b"Jane Doe jane@example.org 503-555-1212 needs housing, SNAP, clinic, and rent navigation.",
                "text/plain",
            )
        },
    )
    assert upload_response.status_code == 200, upload_response.text
    record_id = upload_response.json()["record_id"]

    profile_response = client.post(
        f"/wallets/{wallet_id}/records/{record_id}/metadata/generate",
        json={
            "actor_did": owner_did,
            "file_name": "indexing-validation.txt",
            "mime_type": "text/plain",
            "provider": "local-validation",
            "wallet_cid": record_id,
        },
    )
    assert profile_response.status_code == 200, profile_response.text

    metadata = profile_response.json()["metadata"]
    assert metadata["privacyProfileStatus"] == "profiled"
    assert "encrypted_vector_profile" in metadata["privacyProfileVectorTerms"]
    assert "redacted_graphrag" in metadata["privacyProfileVectorTerms"]
    assert "redacted_category_entity_graph" in metadata["privacyProfileVectorTerms"]

    artifact_ids = metadata["privacyProfileArtifactIds"]
    artifact_types = {
        service.wallet_service.derived_artifacts[artifact_id].artifact_type
        for artifact_id in artifact_ids
    }
    assert "redacted_document_vector_profile" in artifact_types
    assert "redacted_document_graphrag" in artifact_types

    audit_actions = {
        event.action for event in service.wallet_service.audit_events[wallet_id]
    }
    assert "record/vector_profile" in audit_actions
    assert "record/graphrag_redacted" in audit_actions

    wallet_module = importlib.import_module("ipfs_datasets_py.wallet")
    assert "/ipfs_datasets_py/ipfs_datasets_py/wallet/" in wallet_module.__file__


def test_wallet_metadata_generation_survives_ipld_publish_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("IPFS_AUTO_INSTALL", "false")
    monkeypatch.setenv("IPFS_DATASETS_AUTO_INSTALL", "false")
    monkeypatch.setenv("IPFS_DATASETS_PY_MINIMAL_IMPORTS", "1")
    monkeypatch.delenv("WALLET_IPFS_UPLOAD_BACKEND", raising=False)

    service = WalletInterfaceService(
        repository_root=tmp_path / "wallet-repository",
        storage_config={"primary": {"type": "local", "root": str(tmp_path / "wallet-blobs")}},
        auto_load_repository=False,
        auto_persist=True,
    )
    client = TestClient(create_app(service=service))

    owner_did = "did:key:indexing-owner-no-ipfs"
    wallet_response = client.post("/wallets", json={"owner_did": owner_did})
    assert wallet_response.status_code == 200, wallet_response.text
    wallet_id = wallet_response.json()["wallet_id"]

    upload_response = client.post(
        f"/wallets/{wallet_id}/documents",
        data={"actor_did": owner_did, "title": "Indexing validation upload"},
        files={
            "file": (
                "indexing-validation.txt",
                b"Client needs food, housing, SNAP, clinic, and rent navigation.",
                "text/plain",
            )
        },
    )
    assert upload_response.status_code == 200, upload_response.text
    record_id = upload_response.json()["record_id"]

    profile_response = client.post(
        f"/wallets/{wallet_id}/records/{record_id}/metadata/generate",
        json={
            "actor_did": owner_did,
            "file_name": "indexing-validation.txt",
            "mime_type": "text/plain",
            "provider": "local-validation",
            "wallet_cid": record_id,
        },
    )
    assert profile_response.status_code == 200, profile_response.text

    metadata = profile_response.json()["metadata"]
    assert metadata["privacyProfileStatus"] == "profiled"
    assert metadata["privacyProfileClassification"] != "Uncategorized"
    assert metadata["privacyProfileSummary"]
    assert "encrypted_vector_profile" in metadata["privacyProfileVectorTerms"]
    assert "redacted_graphrag" in metadata["privacyProfileVectorTerms"]
    assert "redacted_category_entity_graph" in metadata["privacyProfileSearchText"]
    assert "IPLD publish failed" in metadata["metadataStorageMessage"]
