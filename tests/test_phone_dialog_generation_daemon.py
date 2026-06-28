from __future__ import annotations

from collections import Counter

from scripts.phone_dialog_generation_daemon import (
    assistant_prompt,
    build_seed,
    target_mode_weight,
    TARGET_MODE_PROFILE_BY_ID,
    focus_profiles,
    enrich_dag_with_phone_variants,
    extract_first_json_object,
    load_slot_friendly_voice_frames,
    ScenarioSeed,
)


def test_extract_first_json_object_ignores_wrapping_text() -> None:
    payload = extract_first_json_object('preface {"title":"hello","callerTurns":["one","two","three"]} suffix')
    assert payload == {"title": "hello", "callerTurns": ["one", "two", "three"]}


def test_build_seed_is_deterministic_for_counter() -> None:
    import random

    seed_a = build_seed(17, random.Random(211))
    seed_b = build_seed(17, random.Random(211))
    assert seed_a.seed_id == seed_b.seed_id
    assert seed_a.service_need == seed_b.service_need
    assert seed_a.location == seed_b.location
    assert seed_a.caller["id"] == seed_b.caller["id"]
    assert seed_a.channel["id"] == seed_b.channel["id"]
    assert seed_a.style["id"] == seed_b.style["id"]


def test_build_seed_rotates_channel_and_style_early() -> None:
    import random

    seeds = [build_seed(index, random.Random(211)) for index in range(1, 13)]
    assert len({seed.channel["id"] for seed in seeds}) > 1
    assert len({seed.style["id"] for seed in seeds}) > 1


def test_underrepresented_route_profiles_get_more_weight() -> None:
    common_profile = TARGET_MODE_PROFILE_BY_ID["clear_grounded_request"]
    underrepresented_profile = TARGET_MODE_PROFILE_BY_ID["surface_navigation_request"]
    route_counts = Counter({"grounded_211_answer": 500, "live_agent": 500, "app_surface_navigation": 5})
    target_mode_counts = Counter({"clear_grounded_request": 40})

    common_weight = target_mode_weight(common_profile, route_counts, target_mode_counts)
    underrepresented_weight = target_mode_weight(underrepresented_profile, route_counts, target_mode_counts)

    assert underrepresented_weight > common_weight


def test_safety_focus_only_selects_risk_profiles() -> None:
    import random

    safety_profile_ids = {profile["id"] for profile in focus_profiles("safety-risk")}
    seeds = [build_seed(index, random.Random(211), focus="safety-risk") for index in range(1, 25)]

    assert safety_profile_ids
    assert {seed.target_mode for seed in seeds}.issubset(safety_profile_ids)
    assert "safety_guardrail_check" in safety_profile_ids
    assert "medical_distress_check" in safety_profile_ids
    assert "minor_runaway_or_exploitation_risk" in safety_profile_ids
    assert "trafficking_or_coercive_control" in safety_profile_ids


def test_enrich_dag_with_phone_variants_uses_assistant_responses() -> None:
    dag = {
        "nodes": [
            {
                "id": "scenario-1#turn-1",
                "scenarioId": "scenario-1",
                "route": "grounded_211_answer",
                "serviceTag": "food",
                "locationTag": "portland",
                "voiceResponse": "placeholder",
            },
            {
                "id": "scenario-2#turn-1",
                "scenarioId": "scenario-2",
                "route": "grounded_211_answer",
                "serviceTag": "food",
                "locationTag": "portland",
                "voiceResponse": "placeholder",
            },
        ]
    }
    memory = {
        "records": [
            {
                "id": "scenario-1#turn-1",
                "scenarioId": "scenario-1",
                "user": "Need food in Portland",
                "retrievalQuery": "food portland",
                "route": "grounded_211_answer",
                "assistant": "I found a pantry in Portland. Call 503 555 0100.",
            },
            {
                "id": "scenario-2#turn-1",
                "scenarioId": "scenario-2",
                "user": "Need groceries in Portland",
                "retrievalQuery": "groceries portland",
                "route": "grounded_211_answer",
                "assistant": "A likely match is a Portland pantry. I can repeat the number.",
            },
        ]
    }
    results = [
        {
            "id": "scenario-1",
            "phone": {
                "callerArchetype": {"id": "homeless_exhausted"},
                "channelCondition": {"id": "bad_reception"},
                "assistantStyle": {"id": "slow_clear_repetition"},
            },
        },
        {
            "id": "scenario-2",
            "phone": {
                "callerArchetype": {"id": "calm_practical"},
                "channelCondition": {"id": "clear_line"},
                "assistantStyle": {"id": "grounded_operator"},
            },
        },
    ]

    enriched = enrich_dag_with_phone_variants(dag, memory, results)

    first = enriched["nodes"][0]
    assert first["voiceResponse"] == "I found a pantry in Portland. Call 503 555 0100."
    assert "A likely match is a Portland pantry. I can repeat the number." in first["voiceResponseAlternatives"]
    assert first["callerArchetypeId"] == "homeless_exhausted"
    assert first["channelConditionId"] == "bad_reception"
    assert first["assistantStyleId"] == "slow_clear_repetition"


def test_load_slot_friendly_voice_frames_reads_top_opportunities(tmp_path) -> None:
    path = tmp_path / "rewrites.json"
    path.write_text(
        """
        {
          "opportunities": [
            {"canonicalTemplate": "Call {phone_1}.", "familyKind": "phone_or_number", "estimatedSavedChunkCalls": 10},
            {"canonicalTemplate": "The number is {phone_1}.", "familyKind": "phone_or_number", "estimatedSavedChunkCalls": 8}
          ]
        }
        """,
        encoding="utf-8",
    )

    frames = load_slot_friendly_voice_frames(path, limit=1)

    assert frames == [
        {
            "template": "Call {phone_1}.",
            "familyKind": "phone_or_number",
            "estimatedSavedChunkCalls": 10,
        }
    ]


def test_assistant_prompt_includes_slot_friendly_voice_guidance() -> None:
    seed = ScenarioSeed(
        seed_id="seed",
        service_need="shelter",
        location="Portland",
        caller={"id": "calm_practical", "label": "Calm caller", "profile": "Direct."},
        channel={"id": "clear_line", "label": "Clear line", "effect": "Clear."},
        style={
            "id": "grounded_operator",
            "title": "Grounded operator",
            "system_prompt": "You are Abby.",
            "response_rules": ["Be concise."],
        },
        target_mode="clear_grounded_request",
    )

    prompt = assistant_prompt(
        route="grounded_211_answer",
        message="I need shelter in Portland.",
        history=[],
        evidence=[],
        seed=seed,
        reasons=[],
        slot_friendly_frames=[{"template": "Call {phone_1}.", "familyKind": "phone_or_number"}],
    )

    assert "Prefer reusable TTS-friendly sentence frames" in prompt
    assert "Call {phone_1}." in prompt
    assert "never say the placeholder name" in prompt


def test_ipfs_accelerate_llm_router_shim_delegates_to_ipfs_datasets(monkeypatch) -> None:
    from ipfs_accelerate_py import llm_router as accelerate_llm_router
    from ipfs_datasets_py import llm_router as datasets_llm_router

    calls: list[dict[str, object]] = []

    def fake_generate_text(prompt: str, *args: object, provider: str | None = None, **kwargs: object) -> str:
        calls.append({"prompt": prompt, "provider": provider, "kwargs": kwargs})
        return "shim-ok"

    monkeypatch.setattr(datasets_llm_router, "generate_text", fake_generate_text)

    result = accelerate_llm_router.generate_text("hello", provider="hf", model_name="Qwen/Qwen3.5-2B")

    assert result == "shim-ok"
    assert calls == [
        {
            "prompt": "hello",
            "provider": "hf_inference_api",
            "kwargs": {"model_name": "Qwen/Qwen3.5-2B"},
        }
    ]
