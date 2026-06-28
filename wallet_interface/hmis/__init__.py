"""HMIS integration contracts for 211-AI wallet workflows."""

from .adapters import ManualReviewHmisAdapter
from .errors import (
    HmisAdapterError,
    HmisConfigError,
    HmisConsentError,
    HmisIntegrationError,
    HmisMappingError,
    HmisMatchError,
    HmisPolicyError,
)
from .consent import HmisConsentDecision, evaluate_hmis_consent
from .mapper import HmisFieldMapping, HmisMappingRegistry
from .models import (
    HmisActionType,
    HmisAdapterCapabilities,
    HmisAdapterResult,
    HmisClientLink,
    HmisConsentRecord,
    HmisEnrollmentRecord,
    HmisHouseholdLink,
    HmisProgramLink,
    HmisReferralRecord,
    HmisSyncEvent,
)
from .service import HmisExecutionResult, HmisService

__all__ = [
    "HmisActionType",
    "HmisAdapterCapabilities",
    "HmisAdapterError",
    "HmisAdapterResult",
    "HmisClientLink",
    "HmisConfigError",
    "HmisConsentDecision",
    "HmisConsentError",
    "HmisConsentRecord",
    "HmisExecutionResult",
    "HmisFieldMapping",
    "HmisEnrollmentRecord",
    "HmisHouseholdLink",
    "HmisIntegrationError",
    "HmisMappingRegistry",
    "HmisMappingError",
    "HmisMatchError",
    "HmisPolicyError",
    "HmisProgramLink",
    "HmisReferralRecord",
    "HmisService",
    "HmisSyncEvent",
    "ManualReviewHmisAdapter",
    "evaluate_hmis_consent",
]