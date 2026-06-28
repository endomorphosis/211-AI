# 211 AI Privacy Policy

Last updated: May 19, 2026

This is the repository copy for the public policy served at `/privacy.html`.

Short version: 211 AI uses information to help people find services, manage a
private wallet, communicate with providers when requested, and operate the
website. 211 AI does not sell personal information. 211 AI does not sell, rent,
share, or transfer SMS opt-in data or messaging consent information to third
parties or affiliates for marketing or promotional purposes.

## Contact

Privacy contact: ops@211-ai.com

## Information Collected

Depending on the feature used, 211 AI may collect contact information, messages,
calls, voice input, transcripts, service navigation data, wallet identifiers,
encrypted records, encrypted metadata, grants, revocations, audit events, proof
receipts, uploaded documents, location information chosen by the user, provider
workflow data, and technical/security metadata.

## SMS and Voice

If a user provides a phone number, texts the service, requests contact, or opts
in to messaging, 211 AI may send informational messages related to the request,
including Abby replies, service navigation follow-ups, check-in reminders,
provider updates, and wallet or account notices. Message and data rates may
apply. Message frequency varies.

Users can opt out by replying STOP, CANCEL, END, QUIT, UNSUBSCRIBE, or STOPALL.
Users may reply HELP for help.

No mobile information will be shared with third parties or affiliates for
marketing or promotional purposes. Text messaging originator opt-in data and
consent will not be shared with any third parties, except aggregators and
providers required to deliver the messaging service, comply with law, prevent
abuse, or provide the service requested.

## Wallet, UCANs, and Proofs

Wallet records are designed so raw record payloads and sensitive metadata remain
encrypted in wallet storage. Access to private records is controlled by wallet
authority, grants, signed wallet invocation tokens, and revocation checks. A
grant for analysis does not automatically grant plaintext decryption.

Where supported, Abby can use privacy-preserving proof receipts and
zero-knowledge-style workflows to show limited claims, such as service-area
membership, distance thresholds, or document category metadata, without
revealing the underlying document, exact address, proof witness, or private key
material.

## IPFS and Filecoin

When IPFS or Filecoin-style storage is enabled, wallet data is intended to be
encrypted before it is stored or pinned. CIDs, filenames, storage paths, gateway
URLs, and deal IDs are not privacy controls by themselves. They are treated as
sensitive metadata and are governed by wallet encryption, access controls,
retention policies, and unpin/delete workflows.

## Sharing

211 AI may share information with service providers, shelters, benefits
agencies, emergency contacts, police precincts, social workers, or other
recipients selected or authorized by the user. 211 AI may also share information
with infrastructure vendors needed for hosting, messaging, voice, email, AI
inference, storage, security, monitoring, support, legal compliance, safety, and
fraud or abuse prevention.

211 AI does not sell personal information and does not share SMS opt-in data or
consent with third parties or affiliates for marketing or promotional purposes.

## AI Processing

Abby may use local browser models, wallet-scoped routers, or hosted AI services
to understand questions, retrieve public service information, transcribe voice,
generate voice responses, summarize records, classify documents, or generate
redacted metadata. Private wallet context should be used only when requested or
approved for a workflow that needs it.

## Analytics

Production analytics must use reviewed templates, consent, nullifier checks,
aggregation thresholds, suppression, query-budget accounting, privacy-budget
controls, and audit events. 211 AI does not approve arbitrary raw analytics
queries over wallet documents, precise locations, direct identifiers, private
notes, provider conversations, or raw contribution values.

## Retention and Deletion

211 AI retains information for as long as needed to provide the service,
maintain wallet recovery and audit history, comply with legal obligations,
prevent abuse, resolve incidents, and honor retention choices. Wallet deletion
and record deletion are designed to revoke grants, rotate keys when needed,
remove manifest references, delete or unpin encrypted blobs where supported, and
retain only audit-safe tombstones or evidence required by policy.

Content-addressed networks and recipient downloads may limit the ability to
delete every copy that was already cached, pinned, or downloaded outside 211
AI's control. Revocation stops future access through wallet controls, but it
cannot claw back plaintext already disclosed to an authorized recipient.

## Choices

Users may choose what wallet records to create, upload, share, export, or delete;
revoke supported grants and access requests; opt out of SMS; request access,
correction, deletion, or support; and avoid uploading sensitive documents or
precise location unless a feature needs them.
