from __future__ import annotations

from scripts.suggest_slot_friendly_voice_rewrites import (
    canonical_rewrite_template,
    family_kind,
    normalize_slot_numbers,
)


def test_normalize_slot_numbers_compacts_slot_indices() -> None:
    assert normalize_slot_numbers("Again: {phone_7}. Backup: {phone_9}.") == "Again: {phone_1}. Backup: {phone_2}."


def test_phone_repeat_templates_canonicalize() -> None:
    assert canonical_rewrite_template("Again: {phone_1}.") == "I’ll repeat: {phone_1}."
    assert canonical_rewrite_template("I’ll say it once more: {phone_1}.") == "I’ll repeat: {phone_1}."


def test_phone_call_templates_canonicalize() -> None:
    assert canonical_rewrite_template("You can call {phone_1}.") == "Call {phone_1}."
    assert canonical_rewrite_template("Phone is {phone_1}.") == "The number is {phone_1}."


def test_named_entity_templates_canonicalize() -> None:
    assert canonical_rewrite_template("The place is {entity_1}.") == "The name is {entity_1}."
    assert family_kind("The name is {entity_1}.") == "named_entity"
    assert (
        canonical_rewrite_template("A good fit is {entity_1}.")
        == "A good fit is {entity_1}."
    )


def test_emergency_templates_canonicalize() -> None:
    assert canonical_rewrite_template("Call nine one one right away.") == "Call nine one one now."
    assert (
        canonical_rewrite_template("After nine one one is on the way, I can help with food support next.")
        == "After nine one one is on the way, I can help with food support next."
    )
    assert family_kind("Call nine one one now.") == "emergency_phrase"
