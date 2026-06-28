"""Error types for HMIS integration workflows."""


class HmisIntegrationError(RuntimeError):
    """Base class for HMIS integration failures."""


class HmisConfigError(HmisIntegrationError):
    """Raised when HMIS integration configuration is invalid."""


class HmisPolicyError(HmisIntegrationError):
    """Raised when a requested HMIS action is blocked by policy."""


class HmisConsentError(HmisPolicyError):
    """Raised when consent is missing, expired, revoked, or insufficient."""


class HmisMappingError(HmisIntegrationError):
    """Raised when local-to-HMIS mapping is incomplete or invalid."""


class HmisMatchError(HmisIntegrationError):
    """Raised when identity or program matching cannot be resolved safely."""


class HmisAdapterError(HmisIntegrationError):
    """Raised when an HMIS adapter fails to execute or normalize a workflow."""