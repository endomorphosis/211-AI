from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_simulation_module():
    module_path = Path(__file__).parents[1] / "scripts" / "simulate_211_conversations.py"
    spec = importlib.util.spec_from_file_location("simulate_211_conversations", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_routes_broad_help_to_clarifying_prompt() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("I need help but I do not know where to start.", [])

    assert route == "clarifying_prompt"
    assert "broad help" in reasons[0]


def test_multiround_clarification_can_become_grounded_answer() -> None:
    sim = _load_simulation_module()
    templates = {
        "grounded_211_answer": {"id": "grounded_service_match"},
        "clarifying_prompt": {"id": "clarify_need_or_location"},
        "template_guided_fallback": {"id": "fallback_general_guidance"},
        "live_agent": {"id": "live_agent_handoff"},
    }
    document = sim.ServiceDocument(
        doc_id="service:food",
        title="Portland Food Pantry",
        text="Food pantry in Portland with groceries and meal boxes.",
        provider_name="Community Pantry",
        city="Portland",
        phones=[{"value": "(503) 555-0100"}],
        eligibility=[{"value": "Unrestricted"}],
    )
    retriever = sim.Local211Retriever([document])
    scenario = sim.ConversationScenario(
        id="broad_then_food",
        title="Broad then food",
        user_turns=[
            "I need help but I do not know where to start.",
            "I am in Portland and food is the most important thing today.",
        ],
        expected_routes=["clarifying_prompt", "grounded_211_answer"],
    )

    result = sim.simulate_conversation(scenario, retriever, templates)

    assert result["passed"] is True
    assert result["actualRoutes"] == ["clarifying_prompt", "grounded_211_answer"]
    assert "Food Pantry" in result["turns"][1]["evidence"][0]["title"]


def test_concrete_followup_query_does_not_include_vague_prior_turn() -> None:
    sim = _load_simulation_module()
    state = sim.ConversationState(user_messages=["I need help but I do not know where to start."])

    query = sim.build_retrieval_query("I am in Portland and food is the most important thing today.", state)

    assert query == "I am in Portland and food is the most important thing today."


def test_query_expansion_keeps_food_followups_service_specific() -> None:
    sim = _load_simulation_module()

    terms = sim.expand_query_terms(sim.tokenize("food in Portland"))

    assert terms == ["food", "pantry", "meal", "meals", "groceries", "portland"]


def test_multiround_repeated_under_evidenced_fallback_escalates() -> None:
    sim = _load_simulation_module()
    state = sim.ConversationState(fallback_count=1)
    document = sim.ServiceDocument(
        doc_id="service:benefits",
        title="Benefits Page",
        text="SNAP benefits information.",
        provider_name="Benefits Provider",
        required_documents=[],
        intake_steps=[],
    )
    hits = [sim.SearchHit(document=document, score=50.0, matched_terms=["benefits"])]

    route, reasons = sim.route_turn("I still cannot figure out what paperwork to bring for benefits.", hits, state)

    assert route == "live_agent"
    assert "repeated document/intake request" in reasons[0]


def test_live_agent_handoff_is_sticky_across_later_turns() -> None:
    sim = _load_simulation_module()
    state = sim.ConversationState(live_agent_triggered=True)
    document = sim.ServiceDocument(
        doc_id="service:shelter",
        title="Portland Shelter",
        text="Shelter record.",
        provider_name="Shelter Provider",
    )
    hits = [sim.SearchHit(document=document, score=99.0, matched_terms=["shelter"])]

    route, reasons = sim.route_turn("Actually maybe just search for Portland shelter.", hits, state)

    assert route == "live_agent"
    assert "already triggered" in reasons[0]


def test_routes_urgent_same_day_shelter_to_live_agent_even_with_evidence() -> None:
    sim = _load_simulation_module()
    document = sim.ServiceDocument(
        doc_id="service:shelter",
        title="Emergency Shelter",
        text="Emergency shelter service record.",
        provider_name="Shelter Provider",
    )
    hits = [sim.SearchHit(document=document, score=99.0, matched_terms=["shelter"])]

    route, reasons = sim.route_turn("I need a safe shelter right now tonight in Portland.", hits)

    assert route == "live_agent"
    assert "urgent" in reasons[0]


def test_document_requirement_without_document_evidence_uses_template_fallback() -> None:
    sim = _load_simulation_module()
    document = sim.ServiceDocument(
        doc_id="service:benefits",
        title="Benefits Page",
        text="SNAP benefits information.",
        provider_name="Benefits Provider",
        required_documents=[],
        intake_steps=[],
    )
    hits = [sim.SearchHit(document=document, score=50.0, matched_terms=["benefits"])]

    route, reasons = sim.route_turn("What documents do I need to apply for benefits in Oregon?", hits)

    assert route == "template_guided_fallback"
    assert "without document or intake evidence" in reasons[0]


def test_repeat_request_routes_to_repeat_or_restate_even_after_live_agent_state() -> None:
    sim = _load_simulation_module()
    state = sim.ConversationState(
        user_messages=["I need dental help in Eugene right now."],
        live_agent_triggered=True,
    )
    document = sim.ServiceDocument(
        doc_id="service:dental",
        title="Dental Clinic",
        text="Dental care record.",
        provider_name="Dental Provider",
    )
    hits = [sim.SearchHit(document=document, score=88.0, matched_terms=["dental", "eugene"])]

    route, reasons = sim.route_turn("Can you repeat that number again? You cut out.", hits, state)

    assert route == "repeat_or_restate"
    assert "repeat or restate" in reasons[0]


def test_safety_guardrail_route_handles_at_risk_but_not_confirmed_emergency() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("I feel weak and dizzy and I might pass out if I stay outside much longer.", [])

    assert route == "safety_guardrail_support"
    assert "safety check" in reasons[0] or "at risk" in reasons[0]


def test_repeated_safety_guardrail_signal_escalates_to_live_agent() -> None:
    sim = _load_simulation_module()
    state = sim.ConversationState(safety_guardrail_count=1)

    route, reasons = sim.route_turn("I feel weak and dizzy and I might pass out if I stay outside much longer.", [], state)

    assert route == "live_agent"
    assert "earlier guardrail" in reasons[0]


def test_overdose_or_unresponsive_signal_routes_to_live_agent() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("My friend may have overdosed and is unresponsive. What do I do?", [])

    assert route == "live_agent"
    assert "urgent" in reasons[0]


def test_ambiguous_self_harm_language_gets_safety_check() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("I do not trust myself tonight and I need somewhere safe to be.", [])

    assert route == "safety_guardrail_support"
    assert "safety check" in reasons[0] or "at risk" in reasons[0]


def test_lost_insulin_gets_safety_check_before_navigation() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("My insulin was stolen and I am outside in Gresham with no ride.", [])

    assert route == "safety_guardrail_support"
    assert "safety check" in reasons[0] or "at risk" in reasons[0]


def test_forced_sex_signal_routes_to_live_agent() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("Someone is forcing me into sex and I am locked in right now.", [])

    assert route == "live_agent"
    assert "urgent" in reasons[0]


def test_mangled_speech_routes_to_speech_unclear_clarification() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("[static] uh sorry c-can you hear me ... s-shelter maybe", [])

    assert route == "speech_unclear_clarification"
    assert "garbled" in reasons[0] or "hard to understand" in reasons[0]


def test_wallet_document_question_routes_to_wallet_document_support() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("What proof files and uploads are in my wallet right now?", [])

    assert route == "wallet_document_support"
    assert "wallet files" in reasons[0]


def test_calendar_question_routes_to_calendar_event_support() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("Can you put that intake appointment on my calendar and remind me tomorrow?", [])

    assert route == "calendar_event_support"
    assert "calendar" in reasons[0] or "appointment" in reasons[0]


def test_provider_message_request_routes_to_provider_contact_support() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("Can you help me text the shelter back and leave a voicemail if they do not answer?", [])

    assert route == "provider_contact_support"
    assert "contacting a provider" in reasons[0]


def test_service_interaction_request_routes_to_service_interaction_support() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("I went to the clinic and they told me to bring ID next time. Can you note that?", [])

    assert route == "service_interaction_support"
    assert "provider visit" in reasons[0] or "follow-up" in reasons[0]


def test_navigation_request_routes_to_app_surface_navigation() -> None:
    sim = _load_simulation_module()

    route, reasons = sim.route_turn("Open the calendar screen so I can see my follow-up event.", [])

    assert route == "app_surface_navigation"
    assert "calendar" in reasons[0]


def test_local_retriever_finds_grounded_service_match() -> None:
    sim = _load_simulation_module()
    document = sim.ServiceDocument(
        doc_id="service:food",
        title="Portland Food Pantry",
        text="Food pantry in Portland with groceries and meal boxes.",
        provider_name="Community Pantry",
        city="Portland",
        phones=[{"value": "(503) 555-0100"}],
        eligibility=[{"value": "Unrestricted"}],
    )
    retriever = sim.Local211Retriever([document])
    hits = retriever.search("food pantry Portland", limit=1)

    assert hits
    route, _ = sim.route_turn("Can you find a food pantry in Portland?", hits)
    assert route == "grounded_211_answer"


def test_conversation_memory_stores_embeddings_and_similar_cases() -> None:
    sim = _load_simulation_module()
    results = [
        {
            "id": "food_case",
            "title": "Food case",
            "turns": [
                {
                    "user": "I need food in Portland.",
                    "retrievalQuery": "I need food in Portland.",
                    "route": "grounded_211_answer",
                    "reasons": ["strong local 211 retrieval score"],
                    "assistant": "Food pantry match.",
                    "promptTemplate": "grounded_service_match",
                    "evidence": [{"docId": "service:food", "title": "Food Pantry"}],
                }
            ],
        },
        {
            "id": "pantry_case",
            "title": "Pantry case",
            "turns": [
                {
                    "user": "Can you find a pantry near Portland?",
                    "retrievalQuery": "Can you find a pantry near Portland?",
                    "route": "grounded_211_answer",
                    "reasons": ["strong local 211 retrieval score"],
                    "assistant": "Pantry match.",
                    "promptTemplate": "grounded_service_match",
                    "evidence": [{"docId": "service:pantry", "title": "Community Pantry"}],
                }
            ],
        },
    ]

    memory = sim.build_conversation_memory(
        results,
        generated_at="2026-05-19T00:00:00+00:00",
        embedding_provider="deterministic_sparse",
    )

    assert memory["recordCount"] == 2
    assert memory["embedding"]["provider"] == "deterministic_sparse_fallback"
    assert memory["records"][0]["embedding"]
    assert memory["records"][0]["similarCases"][0]["recordId"] == "pantry_case#turn-1"


def test_conversation_dag_has_sequence_similarity_and_shards() -> None:
    sim = _load_simulation_module()
    results = [
        {
            "id": "broad_food",
            "title": "Broad then food",
            "turns": [
                {
                    "user": "I need help but I do not know where to start.",
                    "retrievalQuery": "I need help but I do not know where to start.",
                    "route": "clarifying_prompt",
                    "reasons": ["user is asking for broad help without a service type"],
                    "assistant": "What city and need?",
                    "promptTemplate": "clarify_need_or_location",
                    "evidence": [],
                },
                {
                    "user": "I am in Portland and need food pantry.",
                    "retrievalQuery": "I am in Portland and need food pantry.",
                    "route": "grounded_211_answer",
                    "reasons": ["strong local 211 retrieval score"],
                    "assistant": "Food pantry match.",
                    "promptTemplate": "grounded_service_match",
                    "evidence": [{"docId": "service:food", "title": "Food Pantry"}],
                },
            ],
        }
    ]
    memory = sim.build_conversation_memory(
        results,
        generated_at="2026-05-19T00:00:00+00:00",
        embedding_provider="deterministic_sparse",
    )

    dag = sim.build_conversation_dag(memory, results, generated_at="2026-05-19T00:00:00+00:00")

    assert dag["nodeCount"] == 2
    assert any(edge["type"] == "scenario_next_turn" for edge in dag["edges"])
    assert "route__clarifying_prompt" in dag["shards"]
    assert "service__food" in dag["shards"]
    grounded = next(node for node in dag["nodes"] if node["route"] == "grounded_211_answer")
    assert grounded["voiceResponse"].startswith("I found")
