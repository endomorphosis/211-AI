# Documentation Index (Current State)

This folder contains active runbooks, architecture references, implementation plans, and operational checklists for the current 211-AI system.

## Start here

- **Repository overview:** `../README.md`
- **Wallet service/API scope:** `../wallet_interface/README.md`
- **Abby UI runtime and tests:** `../wallet_interface/ui/README.md`
- **Deployment assets:** `../wallet_interface/deploy/README.md`

## Wallet architecture, operations, and production signoff

- `WALLET_OPERATOR_INTEGRATOR_REFERENCE.md` — stable wallet API/CLI/MCP contract and release-gate reference
- `WALLET_SECURITY_ARCHITECTURE_ADR.md` — wallet security architecture decisions
- `WALLET_PRODUCTION_DECISIONS_ADR.md` — production decision log
- `WALLET_OPERATIONS_RUNBOOK.md` — operator runbook for wallet environments
- `WALLET_PROOF_VERIFIER_CONTRACT.md` — verifier HTTP contract expectations
- `WALLET_RETENTION_POLICY.md` — encrypted storage and retention policy references
- `WALLET_TARGET_PRODUCTION_SIGNOFF.md` — target-environment signoff process
- `WALLET_TARGET_PRODUCTION_SIGNOFF_PACKET.template.json` — signoff packet template
- `WALLET_UCAN_PROFILE.md` — UCAN profile and fixture validation contract

## Wallet implementation tracking

- `UCAN_ZK_DATA_WALLET_IMPLEMENTATION_PLAN.md` — implementation phase and gate tracking
- `UCAN_ZK_DATA_WALLET_TODO.md` — executable backlog for wallet implementation daemon/supervisor flows
- `DOCUMENT_WALLET_IMPLEMENTATION_PLAN.md` — document wallet implementation planning context

## Abby UI and product design docs

- `ABBY_DESIGN_SYSTEM_FOUNDATION.md` — design-system baseline
- `ABBY_PRODUCT_IA_AND_WIREFRAMES.md` — IA and wireframe references
- `ABBY_ACCESSIBILITY_SAFETY_REVIEW.md` — accessibility/safety review notes
- `ABBY_HANDOFF_CONTRACTS_AND_GOVERNANCE.md` — handoff and governance contract notes
- `ABBY_UI_UX_AGENT_TODO.md` — UI/UX implementation backlog

## Service navigation and AI agent docs

- `211_SERVICE_NAVIGATION_PORTAL_PLAN.md` — portal plan
- `211_SERVICE_NAVIGATION_PORTAL_TODO.md` — portal backlog
- `211_SERVICE_NAVIGATION_PORTAL_RUNBOOK.md` — portal operations runbook
- `211_SERVICE_NAVIGATION_PORTAL_THREAT_MODEL.md` — portal threat model
- `HMIS_INTEGRATION_IMPLEMENTATION_PLAN.md` — HMIS integration implementation plan
- `HMIS_INTEGRATION_TODO.md` — HMIS integration backlog
- `HMIS_INTEGRATION_THREAT_MODEL.md` — HMIS integration threat model
- `HMIS_GOVERNANCE_ACCESS_MATRIX.md` — HMIS governance owners, roles, environments, and approval matrix
- `HMIS_CONSENT_DISCLOSURE_CONTRACT.md` — HMIS consent, scope, and disclosure contract
- `AI_AGENT_CHAT_IMPLEMENTATION_PLAN.md` — agent chat implementation plan
- `AI_AGENT_CHAT_IMPLEMENTATION_TODO.md` — agent chat backlog
- `AI_AGENT_CHAT_RUNBOOK.md` — agent chat operational runbook
- `AI_AGENT_CHAT_THREAT_MODEL.md` — agent chat threat model
- `AI_AGENT_CHAT_ACCESSIBILITY_REVIEW.md` — agent chat accessibility review

## Portland law GraphRAG and ingestion planning

- `PORTLAND_LAWS_WEBGPU_GRAPHRAG_PORT_PLAN.md`
- `PORTLAND_LAWS_WEBGPU_GRAPHRAG_PORT_TODO.md`
- `AGENTIC_SCRAPER_DESIGN.md`

## Historical working notes

The `abby notes*.md` files and similarly named exploratory documents are preserved as working notes and context, not canonical operational contracts.
