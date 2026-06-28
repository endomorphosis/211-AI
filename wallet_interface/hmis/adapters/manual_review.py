"""Manual-review HMIS adapter backed by local fixtures."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from ..models import HmisActionType, HmisAdapterCapabilities, HmisAdapterResult


def _normalized_text(value: Any) -> str:
    return str(value or "").strip().lower()


@dataclass(slots=True)
class ManualReviewHmisAdapter:
    """Local fixture adapter for early HMIS lookup and review workflows."""

    fixtures: list[dict[str, Any]] = field(default_factory=list)
    name: str = "manual-review"

    def capabilities(self) -> HmisAdapterCapabilities:
        return HmisAdapterCapabilities(
            supports_lookup=True,
            supports_manual_review_packets=True,
        )

    def execute(
        self,
        *,
        action_type: HmisActionType,
        payload: Mapping[str, Any],
        context: Mapping[str, Any] | None = None,
    ) -> HmisAdapterResult:
        if action_type == "create_referral_draft":
            return self._create_referral_draft(payload)

        if action_type not in {"lookup_client", "lookup_household", "list_program_links"}:
            return HmisAdapterResult.failure(
                action_type=action_type,
                adapter_name=self.name,
                summary=f"manual review adapter does not implement {action_type}",
                errors=(f"unsupported action: {action_type}",),
            )

        matches = self._lookup_candidates(payload)
        return HmisAdapterResult.success(
            action_type=action_type,
            adapter_name=self.name,
            summary=f"found {len(matches)} HMIS fixture candidate(s)",
            normalized_payload={"candidates": matches, "candidate_count": len(matches)},
            warnings=("results are from manual-review fixtures, not a live HMIS",),
        )

    def _lookup_candidates(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        criteria = payload.get("criteria")
        if not isinstance(criteria, Mapping):
            criteria = payload

        action_type = str(payload.get("action_type") or "lookup_client")

        name_query = _normalized_text(criteria.get("name"))
        dob_query = _normalized_text(criteria.get("date_of_birth"))
        program_query = _normalized_text(criteria.get("program_ref"))

        matches: list[dict[str, Any]] = []
        for fixture in self.fixtures:
            entity_type = _normalized_text(fixture.get("entity_type") or "client")
            if action_type == "lookup_client" and entity_type != "client":
                continue
            if action_type == "lookup_household" and entity_type != "household":
                continue
            if action_type == "list_program_links" and entity_type != "program":
                continue

            candidate_name = _normalized_text(
                fixture.get("name") or fixture.get("household_name") or fixture.get("program_name")
            )
            candidate_dob = _normalized_text(fixture.get("date_of_birth"))
            candidate_program_values = {
                _normalized_text(fixture.get("program_ref")),
                _normalized_text(fixture.get("local_program_ref")),
                _normalized_text(fixture.get("external_program_id")),
                _normalized_text(fixture.get("external_project_id")),
            }
            candidate_program_values.discard("")

            if name_query and name_query not in candidate_name:
                continue
            if dob_query and dob_query != candidate_dob:
                continue
            if program_query and program_query not in candidate_program_values:
                continue
            matches.append(dict(fixture))
        return matches

    def _create_referral_draft(self, payload: Mapping[str, Any]) -> HmisAdapterResult:
        destination_program_ref = str(payload.get("destination_program_ref") or "").strip()
        local_subject_ref = str(payload.get("local_subject_ref") or "").strip()
        if not local_subject_ref:
            return HmisAdapterResult.failure(
                action_type="create_referral_draft",
                adapter_name=self.name,
                summary="manual review referral draft requires a local subject reference",
                errors=("missing local_subject_ref",),
            )
        if not destination_program_ref:
            return HmisAdapterResult.failure(
                action_type="create_referral_draft",
                adapter_name=self.name,
                summary="manual review referral draft requires a destination program",
                errors=("missing destination_program_ref",),
            )

        packet = {
            "review_mode": "manual",
            "destination_program_ref": destination_program_ref,
            "local_subject_ref": local_subject_ref,
            "service_plan_id": str(payload.get("service_plan_id") or ""),
            "service_doc_id": str(payload.get("service_doc_id") or ""),
            "provider_name": str(payload.get("provider_name") or ""),
            "program_name": str(payload.get("program_name") or ""),
            "summary": str(payload.get("summary") or ""),
            "eligibility_notes": str(payload.get("eligibility_notes") or ""),
            "contact_notes": str(payload.get("contact_notes") or ""),
        }
        return HmisAdapterResult.success(
            action_type="create_referral_draft",
            adapter_name=self.name,
            summary="created manual-review HMIS referral draft packet",
            normalized_payload={"draft_packet": packet},
            warnings=("draft is staged for manual review only and has not been submitted to HMIS",),
        )
