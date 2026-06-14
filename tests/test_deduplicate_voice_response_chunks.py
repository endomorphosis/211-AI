from __future__ import annotations

from collections import Counter

from scripts.deduplicate_voice_response_chunks import (
    collect_phrase_counts,
    detect_named_entity_phrases,
    mask_chunk,
    split_sentence_chunks,
)
from scripts.precompute_indextts_responses import normalize_indextts_spoken_text


def test_split_sentence_chunks_keeps_sentence_boundaries() -> None:
    chunks = split_sentence_chunks(
        "Call two one one now. Say: I need shelter in Eugene. If you are unsafe, call nine one one.",
        max_chars=120,
    )

    assert chunks == [
        "Call two one one now.",
        "Say: I need shelter in Eugene.",
        "If you are unsafe, call nine one one.",
    ]


def test_split_sentence_chunks_breaks_long_sentence_at_clause_boundary() -> None:
    chunks = split_sentence_chunks(
        "Call two one one now, say you need a safe ride, Backup number is five zero three, two two eight, six three two two.",
        max_chars=70,
    )

    assert len(chunks) > 1
    assert all(len(chunk) <= 90 for chunk in chunks)


def test_mask_chunk_turns_named_entities_into_reusable_templates() -> None:
    first = "Call ShelterCare now. Address is Highway ninety nine North, Eugene."
    second = "Call Rose Haven now. Address is Northwest Glisan Street, Portland."
    counts = collect_phrase_counts([first, second])

    first_mask = mask_chunk(first, counts)
    second_mask = mask_chunk(second, counts)

    assert any(slot["kind"] == "entity" for slot in first_mask["slots"])
    assert any(slot["kind"] == "entity" for slot in second_mask["slots"])
    assert any(slot["value"] == "ShelterCare" for slot in first_mask["slots"])
    assert any(slot["value"] == "Rose Haven" for slot in second_mask["slots"])


def test_local_ner_detects_cued_provider_and_location_slots() -> None:
    text = "I found Rose Haven in Portland. You can call Rose Haven now."
    phrases = detect_named_entity_phrases(text, Counter({"Rose Haven": 2}))

    assert ("Rose Haven", "entity") in phrases
    assert ("Portland", "location") in phrases


def test_mask_chunk_uses_local_ner_for_cued_program_names() -> None:
    masked = mask_chunk("The nearest option is Outside In near Portland.", Counter({"Outside In": 2}))

    assert "{entity_1}" in masked["maskedText"]
    assert any(slot["value"] == "Outside In" for slot in masked["slots"])


def test_mask_chunk_detects_phoneish_spoken_numbers() -> None:
    masked = mask_chunk("Call five zero three, two two eight, six three two two now.", Counter())

    assert "{phone_1}" in masked["maskedText"]
    assert masked["slots"][0]["kind"] == "phone"


def test_normalize_indextts_strips_markdown_bold_before_star_prosody() -> None:
    normalized = normalize_indextts_spoken_text("Call **9-1-1** now. Then call **2-1-1**.")

    assert "for for" not in normalized
    assert "nine one one" in normalized
    assert "two one one" in normalized
