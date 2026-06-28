# Slotted Response DAG Deduplication Plan

## Goal

Use slotted, embedded user-intent nodes to route many surface forms of a caller request to the same graph neighborhood, then use GraphRAG to fill service/location/provider/phone/address slots from current evidence.

## Current Artifact

- sourceRecordCount: 13660
- intentNodeCount: 3577
- responseFrameNodeCount: 13583
- edgeCount: 13623
- reusableEdgeCount: 17
- uniqueExemplarCount: 13606
- routeCounts: {'app_surface_navigation': 113, 'calendar_event_support': 290, 'clarifying_prompt': 65, 'grounded_211_answer': 2145, 'live_agent': 6992, 'provider_contact_support': 226, 'repeat_or_restate': 2220, 'safety_guardrail_support': 563, 'service_interaction_support': 82, 'speech_unclear_clarification': 632, 'template_guided_fallback': 86, 'wallet_document_support': 246}

## DAG Layers

- Intent nodes: canonical slotted user query templates with embeddings, for example `I need {service_1} in {location_1}.`
- Response-frame nodes: reusable slotted response signatures, composed from deduplicated TTS-friendly chunks.
- Edges: route-specific intent-to-response-frame transitions with evidence document counts and examples.
- Unique exemplar leaves: wholly unique historical turns kept as fallback examples when no reusable frame is confident.

## Runtime Matching

1. Slot the live query using service/location/entity/phone/address NER.
2. Embed the canonical slotted query, not the literal location/service-specific query.
3. Vector-search intent nodes to find the right DAG neighborhood independent of service/location values.
4. Run GraphRAG with the original query plus extracted slots to retrieve fresh local records.
5. Fill response slots from GraphRAG evidence and validate risky values like phones, addresses, and safety instructions.
6. Prefer reusable response frames; fall back to unique exemplars for low-confidence or rare flows.

## Next Implementation Steps

- Wire the live voice/text router to compute the same canonical query template before RAG.
- Add a small vector index loader for `slotted_response_dag.json` intent embeddings.
- Add slot-fill validators for service, location, provider name, phone, address, hours, and safety level.
- Pre-render TTS for high-reuse response-frame chunks and variable slot chunks separately.
- Measure match confidence, fallback rate, and slot-fill correctness against the simulated conversation set.
