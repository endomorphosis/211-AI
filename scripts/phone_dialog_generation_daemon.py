#!/usr/bin/env python3
"""Generate phone-oriented 211 dialog scenarios through ipfs_datasets_py.llm_router.

The daemon incrementally writes scenario blueprints, simulated conversation
results, enriched DAG artifacts, and a dry-run audio manifest so later TTS
passes can bulk-render only the deduplicated spoken responses.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import random
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
IPFS_DATASETS_ROOT = REPO_ROOT / "ipfs_datasets_py"
for import_root in (IPFS_DATASETS_ROOT, REPO_ROOT):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from scripts.simulate_211_conversations import (  # noqa: E402
    DEFAULT_CORPUS,
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_PROMPTS,
    Local211Retriever,
    build_conversation_dag,
    build_conversation_memory,
    build_retrieval_query,
    infer_location_tag,
    infer_service_tag,
    load_documents,
    load_prompt_templates,
    route_turn,
    summarize_hit,
    update_conversation_state,
    write_dag_shards,
    ConversationState,
)


logger = logging.getLogger("phone_dialog_generation.daemon")

DEFAULT_OUTPUT_DIR = REPO_ROOT / "docs" / "phone_dialog_generation"
DEFAULT_STATE_DIR = REPO_ROOT / "data" / "phone_dialog_generation" / "state"
DEFAULT_RESULTS_JSONL = DEFAULT_OUTPUT_DIR / "phone_dialog_results.jsonl"
DEFAULT_BLUEPRINTS_JSONL = DEFAULT_OUTPUT_DIR / "phone_dialog_blueprints.jsonl"
DEFAULT_RESULTS_JSON = DEFAULT_OUTPUT_DIR / "phone_dialog_results.json"
DEFAULT_MEMORY_JSON = DEFAULT_OUTPUT_DIR / "phone_dialog_memory.json"
DEFAULT_DAG_JSON = DEFAULT_OUTPUT_DIR / "phone_dialog_dag.json"
DEFAULT_DAG_SHARDS = DEFAULT_OUTPUT_DIR / "phone_dialog_dag_shards"
DEFAULT_REPORT_JSON = DEFAULT_OUTPUT_DIR / "phone_dialog_report.json"
DEFAULT_DRYRUN_MANIFEST = DEFAULT_OUTPUT_DIR / "phone_dialog_indextts_manifest.json"
DEFAULT_DRYRUN_PUBLIC_MANIFEST = DEFAULT_OUTPUT_DIR / "phone_dialog_indextts_public_manifest.json"
DEFAULT_STATE_JSON = DEFAULT_STATE_DIR / "phone_dialog_generation_state.json"
DEFAULT_EVENTS_JSONL = DEFAULT_STATE_DIR / "phone_dialog_generation_events.jsonl"
DEFAULT_REWRITE_OPPORTUNITIES = DEFAULT_OUTPUT_DIR / "voice_response_rewrite_opportunities.json"

DEFAULT_PROVIDER = os.getenv("WALLET_VOICE_LLM_PROVIDER", "").strip()
DEFAULT_MODEL = (
    os.getenv("WALLET_VOICE_LLM_MODEL")
    or os.getenv("WALLET_AI_ROUTER_LLM_MODEL")
    or "Qwen/Qwen3.5-2B"
).strip()

SERVICE_NEEDS = [
    "food pantry",
    "community meals",
    "shelter",
    "warming center",
    "cooling center",
    "rent assistance",
    "eviction prevention",
    "utility assistance",
    "legal aid",
    "ID replacement help",
    "transportation help",
    "medical clinic",
    "dental clinic",
    "mental health services",
    "detox help",
    "domestic violence survivor advocacy",
    "diapers",
    "child care help",
    "employment help",
    "veteran housing help",
    "senior meals",
    "youth day center",
    "disability benefits help",
    "laundry services",
    "shower services",
    "mail service",
    "clothing help",
]

LOCATIONS = [
    "Portland",
    "Gresham",
    "Beaverton",
    "Hillsboro",
    "Clackamas",
    "Oregon City",
    "Eugene",
    "Salem",
    "Bend",
    "Medford",
    "Lane County",
    "Washington County",
    "Multnomah County",
]

CALLER_ARCHETYPES = [
    {
        "id": "homeless_exhausted",
        "label": "Homeless and exhausted caller",
        "profile": "Sleeping outside or in a car, low on battery, focused on immediate survival, may be brief or foggy.",
    },
    {
        "id": "sick_or_dying",
        "label": "Very sick or medically fragile caller",
        "profile": "In pain, weak, scared, sometimes struggling to breathe or speak in long sentences.",
    },
    {
        "id": "disorganized_distressed",
        "label": "Disorganized or highly distressed caller",
        "profile": "Thoughts may wander, may sound paranoid or confused, still has a real need underneath the confusion.",
    },
    {
        "id": "brilliant_tangential",
        "label": "Brilliant but tangential caller",
        "profile": "Articulate, fast, complex reasoning, but may over-explain and bury the concrete need.",
    },
    {
        "id": "grieving_emotional",
        "label": "Grieving or emotional caller",
        "profile": "May cry, hesitate, apologize, or need gentle repetition before acting.",
    },
    {
        "id": "calm_practical",
        "label": "Calm practical caller",
        "profile": "Direct, concise, wants next steps quickly.",
    },
    {
        "id": "elder_memory_gaps",
        "label": "Older caller with memory gaps",
        "profile": "May forget names, addresses, or what was just said and ask to repeat details slowly.",
    },
    {
        "id": "hearing_impaired",
        "label": "Caller who cannot hear well",
        "profile": "Often asks for repetition, asks for numbers slowly, and may mishear place names.",
    },
    {
        "id": "helper_for_other_person",
        "label": "Caller helping someone else",
        "profile": "Calling on behalf of a relative, client, or friend; may only know partial details.",
    },
    {
        "id": "intoxicated_or_sleep_deprived",
        "label": "Caller who is intoxicated or sleep deprived",
        "profile": "Speech may be uneven, delayed, repetitive, or difficult to organize.",
    },
    {
        "id": "youth_in_crisis",
        "label": "Young caller in crisis",
        "profile": "Under 25, distrustful of systems, worried about safety, transportation, or being turned away.",
    },
    {
        "id": "privacy_wary",
        "label": "Privacy-wary caller",
        "profile": "Worried about surveillance, data use, or whether asking for help could expose them.",
    },
]

CHANNEL_CONDITIONS = [
    {
        "id": "clear_line",
        "label": "Clear line",
        "effect": "Normal audio, no added repair behavior required.",
    },
    {
        "id": "bad_reception",
        "label": "Bad reception",
        "effect": "Drops words, may ask the assistant to repeat or restate.",
    },
    {
        "id": "background_noise",
        "label": "Background noise",
        "effect": "Caller is outside, in a shelter lobby, bus stop, or hospital and misses parts of the response.",
    },
    {
        "id": "borrowed_phone_low_battery",
        "label": "Borrowed phone and low battery",
        "effect": "Caller wants the most important number or next step first because the call may end.",
    },
    {
        "id": "hard_of_hearing",
        "label": "Hard of hearing",
        "effect": "Needs repetition and chunked phone numbers or addresses.",
    },
    {
        "id": "emotionally_overloaded",
        "label": "Emotionally overloaded",
        "effect": "May ask the assistant to slow down, repeat, or confirm what was said.",
    },
    {
        "id": "rambling_and_interrupting",
        "label": "Rambling and interrupting",
        "effect": "Caller circles back, repeats themselves, or partially answers the previous question.",
    },
]

ASSISTANT_STYLES = [
    {
        "id": "grounded_operator",
        "title": "Grounded operator",
        "system_prompt": (
            "You are Abby, a phone-based 211 navigator. Be precise, grounded only in the provided evidence, and concise."
        ),
        "response_rules": [
            "Use one concrete next step first.",
            "If you have a phone number, say it slowly in groups.",
            "Do not hallucinate services or hours.",
        ],
    },
    {
        "id": "slow_clear_repetition",
        "title": "Slow and clear repetition",
        "system_prompt": (
            "You are Abby on a difficult phone line. Speak in short sentences, repeat critical details once, and chunk numbers or addresses."
        ),
        "response_rules": [
            "Use extra verbal pacing and simple syntax.",
            "Repeat phone numbers and addresses when relevant.",
            "Ask only one clarifying question at a time.",
        ],
    },
    {
        "id": "compassionate_caseworker",
        "title": "Compassionate caseworker",
        "system_prompt": (
            "You are Abby. Sound calm, humane, and steady while still staying tightly grounded in evidence."
        ),
        "response_rules": [
            "Validate emotion briefly, then pivot to action.",
            "Keep the reply usable over the phone.",
            "Avoid sounding clinical or robotic.",
        ],
    },
    {
        "id": "crisis_triage",
        "title": "Crisis triage",
        "system_prompt": (
            "You are Abby handling urgent phone calls. Safety comes first. If there are crisis signals, say that clearly and guide toward immediate human help."
        ),
        "response_rules": [
            "If route is live_agent and safety is urgent, mention 911 clearly.",
            "Keep the message direct and short.",
            "Do not overload the caller with options.",
        ],
    },
    {
        "id": "privacy_trust_builder",
        "title": "Privacy and trust builder",
        "system_prompt": (
            "You are Abby. Explain only what is needed, avoid asking for unnecessary details, and sound trustworthy to callers who fear surveillance or institutions."
        ),
        "response_rules": [
            "Use low-pressure language.",
            "Offer options instead of demands.",
            "Avoid unnecessary personal questions.",
        ],
    },
]

TARGET_ROUTE_MIN_COUNTS = {
    "grounded_211_answer": 240,
    "live_agent": 240,
    "clarifying_prompt": 160,
    "template_guided_fallback": 160,
    "repeat_or_restate": 180,
    "calendar_event_support": 180,
    "provider_contact_support": 180,
    "app_surface_navigation": 180,
    "wallet_document_support": 180,
    "service_interaction_support": 180,
    "speech_unclear_clarification": 180,
    "safety_guardrail_support": 180,
}

TARGET_MODE_PROFILES: list[dict[str, Any]] = [
    {
        "id": "clear_grounded_request",
        "desired_routes": ("grounded_211_answer",),
        "preferred_callers": ("calm_practical", "helper_for_other_person"),
        "preferred_channels": ("clear_line", "borrowed_phone_low_battery"),
        "preferred_styles": ("grounded_operator", "compassionate_caseworker"),
        "service_needs": ("food pantry", "rent assistance", "medical clinic", "shelter", "laundry services"),
        "instruction": "Make the caller ask directly for a concrete service and location so Abby can give a grounded local answer.",
    },
    {
        "id": "broad_need_then_clarify",
        "desired_routes": ("clarifying_prompt",),
        "preferred_callers": ("helper_for_other_person", "privacy_wary", "grieving_emotional"),
        "preferred_channels": ("clear_line", "emotionally_overloaded"),
        "preferred_styles": ("compassionate_caseworker", "grounded_operator"),
        "instruction": "Make the caller start broad or uncertain so Abby needs to ask one focused clarifying question before searching deeper.",
    },
    {
        "id": "repeat_and_repair",
        "desired_routes": ("repeat_or_restate",),
        "preferred_callers": ("elder_memory_gaps", "hearing_impaired", "homeless_exhausted"),
        "preferred_channels": ("bad_reception", "hard_of_hearing", "background_noise"),
        "preferred_styles": ("slow_clear_repetition", "grounded_operator"),
        "instruction": "Make the caller miss a number, address, or name and ask Abby to repeat it slowly or in chunks.",
    },
    {
        "id": "urgent_escalation",
        "desired_routes": ("live_agent",),
        "preferred_callers": ("youth_in_crisis", "disorganized_distressed", "sick_or_dying"),
        "preferred_channels": ("emotionally_overloaded", "borrowed_phone_low_battery", "background_noise"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "instruction": "Make the call clearly urgent enough that Abby should prioritize live human help or emergency escalation.",
    },
    {
        "id": "helper_for_other_person",
        "desired_routes": ("clarifying_prompt", "grounded_211_answer", "provider_contact_support"),
        "preferred_callers": ("helper_for_other_person",),
        "preferred_channels": ("clear_line", "bad_reception"),
        "preferred_styles": ("grounded_operator", "compassionate_caseworker"),
        "instruction": "Make the caller act on behalf of someone else and only know partial details, so Abby has to bridge missing context.",
    },
    {
        "id": "misheard_details",
        "desired_routes": ("repeat_or_restate", "grounded_211_answer"),
        "preferred_callers": ("hearing_impaired", "elder_memory_gaps"),
        "preferred_channels": ("hard_of_hearing", "bad_reception"),
        "preferred_styles": ("slow_clear_repetition",),
        "instruction": "Make the caller mishear a number, provider name, or address and ask Abby to restate it.",
    },
    {
        "id": "privacy_wary_request",
        "desired_routes": ("wallet_document_support", "grounded_211_answer", "provider_contact_support"),
        "preferred_callers": ("privacy_wary",),
        "preferred_channels": ("clear_line", "background_noise"),
        "preferred_styles": ("privacy_trust_builder", "compassionate_caseworker"),
        "instruction": "Make the caller worry about privacy, data use, or whether documents or proof files are safe, while still needing real help.",
    },
    {
        "id": "emotionally_overloaded_request",
        "desired_routes": ("safety_guardrail_support", "repeat_or_restate", "clarifying_prompt"),
        "preferred_callers": ("grieving_emotional", "disorganized_distressed", "youth_in_crisis"),
        "preferred_channels": ("emotionally_overloaded", "background_noise"),
        "preferred_styles": ("compassionate_caseworker", "crisis_triage"),
        "instruction": "Make the caller overwhelmed, crying, panicky, or hard to follow so Abby needs to stabilize the call before moving on.",
    },
    {
        "id": "wallet_document_question",
        "desired_routes": ("wallet_document_support",),
        "preferred_callers": ("privacy_wary", "calm_practical", "elder_memory_gaps"),
        "preferred_channels": ("clear_line", "hard_of_hearing"),
        "preferred_styles": ("privacy_trust_builder", "grounded_operator"),
        "instruction": "Make the caller ask about wallet files, uploads, QR codes, proofs, exports, recovery bundles, or what is already stored.",
    },
    {
        "id": "calendar_follow_up",
        "desired_routes": ("calendar_event_support",),
        "preferred_callers": ("calm_practical", "elder_memory_gaps", "helper_for_other_person"),
        "preferred_channels": ("borrowed_phone_low_battery", "clear_line"),
        "preferred_styles": ("grounded_operator", "slow_clear_repetition"),
        "service_needs": ("medical clinic", "dental clinic", "legal aid", "disability benefits help", "ID replacement help"),
        "instruction": "Make the caller ask for a reminder, appointment, or follow-up event tied to a provider or service visit.",
    },
    {
        "id": "provider_contact_request",
        "desired_routes": ("provider_contact_support",),
        "preferred_callers": ("helper_for_other_person", "calm_practical", "privacy_wary"),
        "preferred_channels": ("clear_line", "borrowed_phone_low_battery"),
        "preferred_styles": ("grounded_operator", "privacy_trust_builder"),
        "instruction": "Make the caller ask Abby to help draft or prepare a text, email, voicemail, or call plan for a provider.",
    },
    {
        "id": "service_interaction_followup",
        "desired_routes": ("service_interaction_support",),
        "preferred_callers": ("calm_practical", "elder_memory_gaps", "helper_for_other_person"),
        "preferred_channels": ("clear_line", "rambling_and_interrupting"),
        "preferred_styles": ("grounded_operator", "compassionate_caseworker"),
        "instruction": "Make the caller describe a prior visit, call, intake, or screening and ask Abby to note what happened or plan the next step.",
    },
    {
        "id": "surface_navigation_request",
        "desired_routes": ("app_surface_navigation",),
        "preferred_callers": ("calm_practical", "elder_memory_gaps", "hearing_impaired"),
        "preferred_channels": ("clear_line", "hard_of_hearing"),
        "preferred_styles": ("grounded_operator", "slow_clear_repetition"),
        "instruction": "Make the caller ask Abby to open or show a surface like calendar, messages, uploads, proof center, interactions, audit, or security.",
    },
    {
        "id": "fallback_gap_request",
        "desired_routes": ("template_guided_fallback",),
        "preferred_callers": ("brilliant_tangential", "privacy_wary", "helper_for_other_person"),
        "preferred_channels": ("clear_line", "rambling_and_interrupting"),
        "preferred_styles": ("grounded_operator", "privacy_trust_builder"),
        "instruction": "Make the caller ask for service details that probably lack a strong local match, so Abby needs to explain the evidence gap and steer the next search.",
    },
    {
        "id": "safety_guardrail_check",
        "desired_routes": ("safety_guardrail_support",),
        "preferred_callers": ("sick_or_dying", "grieving_emotional", "youth_in_crisis", "disorganized_distressed"),
        "preferred_channels": ("emotionally_overloaded", "background_noise", "borrowed_phone_low_battery"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("medical clinic", "mental health services", "shelter", "warming center", "cooling center"),
        "instruction": "Make the caller sound weak, dizzy, panicky, overwhelmed, or vulnerable enough that Abby should do a short safety check before continuing, but avoid explicit emergency phrases like suicide, overdose, cannot breathe, or immediate danger unless you want a true live-agent emergency escalation.",
    },
    {
        "id": "suicidal_ideation_ambiguous",
        "desired_routes": ("safety_guardrail_support", "live_agent"),
        "preferred_callers": ("youth_in_crisis", "grieving_emotional", "disorganized_distressed"),
        "preferred_channels": ("emotionally_overloaded", "background_noise", "borrowed_phone_low_battery"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("mental health services", "shelter", "youth day center"),
        "instruction": "Make the caller sound like they may be thinking about harming themselves, but vary whether it is ambiguous enough for a safety check or clear enough for urgent live-agent escalation.",
    },
    {
        "id": "medical_distress_check",
        "desired_routes": ("safety_guardrail_support", "live_agent"),
        "preferred_callers": ("sick_or_dying", "elder_memory_gaps", "homeless_exhausted"),
        "preferred_channels": ("borrowed_phone_low_battery", "background_noise", "emotionally_overloaded"),
        "preferred_styles": ("crisis_triage", "slow_clear_repetition"),
        "service_needs": ("medical clinic", "warming center", "cooling center", "shelter"),
        "instruction": "Make the caller medically fragile: dizzy, weak, exposed to heat or cold, confused, or worried they might collapse. Include both non-911 safety checks and true emergency escalations across scenarios.",
    },
    {
        "id": "overdose_or_substance_risk",
        "desired_routes": ("live_agent", "safety_guardrail_support"),
        "preferred_callers": ("intoxicated_or_sleep_deprived", "helper_for_other_person", "youth_in_crisis"),
        "preferred_channels": ("bad_reception", "background_noise", "emotionally_overloaded"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("detox help", "medical clinic", "mental health services"),
        "instruction": "Make the call involve overdose concern, intoxication, withdrawal, or a friend who may be unresponsive. Some calls should require immediate emergency escalation; others should start with a safety check.",
    },
    {
        "id": "domestic_violence_or_threat",
        "desired_routes": ("live_agent", "safety_guardrail_support"),
        "preferred_callers": ("grieving_emotional", "privacy_wary", "helper_for_other_person"),
        "preferred_channels": ("background_noise", "borrowed_phone_low_battery", "emotionally_overloaded"),
        "preferred_styles": ("crisis_triage", "privacy_trust_builder"),
        "service_needs": ("domestic violence survivor advocacy", "shelter", "transportation help"),
        "instruction": "Make the caller unsafe because of partner violence, stalking, threats, or needing to leave quietly. Vary between immediate danger and safety-planning before service navigation.",
    },
    {
        "id": "unsafe_shelter_or_street_risk",
        "desired_routes": ("safety_guardrail_support", "live_agent", "grounded_211_answer"),
        "preferred_callers": ("homeless_exhausted", "youth_in_crisis", "privacy_wary"),
        "preferred_channels": ("background_noise", "bad_reception", "borrowed_phone_low_battery"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("shelter", "warming center", "cooling center", "transportation help"),
        "instruction": "Make the caller unsafe outside, threatened at a camp, at risk in a shelter, or trying to relocate. Include enough service context for Abby to navigate after checking safety.",
    },
    {
        "id": "psychosis_or_extreme_confusion",
        "desired_routes": ("safety_guardrail_support", "speech_unclear_clarification", "live_agent"),
        "preferred_callers": ("disorganized_distressed", "brilliant_tangential", "intoxicated_or_sleep_deprived"),
        "preferred_channels": ("rambling_and_interrupting", "background_noise", "bad_reception"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("mental health services", "shelter", "medical clinic"),
        "instruction": "Make the caller confused, paranoid, hearing voices, unable to sequence facts, or partly incoherent. Abby should clarify gently, check safety, and escalate when risk is high.",
    },
    {
        "id": "minor_runaway_or_exploitation_risk",
        "desired_routes": ("safety_guardrail_support", "live_agent", "grounded_211_answer"),
        "preferred_callers": ("youth_in_crisis", "helper_for_other_person", "privacy_wary"),
        "preferred_channels": ("borrowed_phone_low_battery", "background_noise", "emotionally_overloaded"),
        "preferred_styles": ("crisis_triage", "privacy_trust_builder", "compassionate_caseworker"),
        "service_needs": ("youth day center", "shelter", "transportation help"),
        "instruction": "Make the call involve a minor, runaway youth, couch-surfing, coercion, unsafe adults, or exploitation risk. Vary safety checks, mandated emergency escalation, and youth-service navigation.",
    },
    {
        "id": "elder_or_disabled_neglect",
        "desired_routes": ("safety_guardrail_support", "live_agent", "provider_contact_support"),
        "preferred_callers": ("elder_memory_gaps", "helper_for_other_person", "sick_or_dying"),
        "preferred_channels": ("hard_of_hearing", "background_noise", "borrowed_phone_low_battery"),
        "preferred_styles": ("crisis_triage", "slow_clear_repetition", "compassionate_caseworker"),
        "service_needs": ("senior meals", "medical clinic", "disability benefits help", "transportation help"),
        "instruction": "Make the caller an older adult, disabled person, or caregiver describing neglect, no food, missed medication, unsafe housing, or inability to reach care. Include safety checks and escalation when needed.",
    },
    {
        "id": "pregnancy_or_postpartum_risk",
        "desired_routes": ("safety_guardrail_support", "live_agent", "grounded_211_answer"),
        "preferred_callers": ("grieving_emotional", "sick_or_dying", "helper_for_other_person"),
        "preferred_channels": ("emotionally_overloaded", "borrowed_phone_low_battery", "background_noise"),
        "preferred_styles": ("crisis_triage", "compassionate_caseworker"),
        "service_needs": ("medical clinic", "diapers", "shelter", "transportation help"),
        "instruction": "Make the call involve pregnancy, postpartum depression, bleeding, no diapers, unsafe sleep, or a parent worried about harming themselves. Vary immediate medical escalation and safety checks.",
    },
    {
        "id": "lost_medication_or_medical_device",
        "desired_routes": ("safety_guardrail_support", "live_agent", "grounded_211_answer"),
        "preferred_callers": ("sick_or_dying", "elder_memory_gaps", "homeless_exhausted"),
        "preferred_channels": ("borrowed_phone_low_battery", "bad_reception", "hard_of_hearing"),
        "preferred_styles": ("crisis_triage", "slow_clear_repetition", "grounded_operator"),
        "service_needs": ("medical clinic", "transportation help", "shelter"),
        "instruction": "Make the caller lose medication, insulin, inhaler, oxygen, walker, wheelchair, or charger while homeless or displaced. Include urgency differences and concrete navigation needs.",
    },
    {
        "id": "trafficking_or_coercive_control",
        "desired_routes": ("safety_guardrail_support", "live_agent", "provider_contact_support"),
        "preferred_callers": ("privacy_wary", "youth_in_crisis", "grieving_emotional"),
        "preferred_channels": ("background_noise", "borrowed_phone_low_battery", "emotionally_overloaded"),
        "preferred_styles": ("crisis_triage", "privacy_trust_builder"),
        "service_needs": ("domestic violence survivor advocacy", "shelter", "transportation help"),
        "instruction": "Make the caller controlled by someone else, afraid their phone is monitored, unable to keep documents, or being forced to work, trade sex, or stay somewhere unsafe. Prioritize privacy and safety.",
    },
    {
        "id": "spotty_voice_clarification",
        "desired_routes": ("speech_unclear_clarification", "clarifying_prompt"),
        "preferred_callers": ("intoxicated_or_sleep_deprived", "disorganized_distressed", "hearing_impaired", "elder_memory_gaps"),
        "preferred_channels": ("bad_reception", "background_noise", "hard_of_hearing", "rambling_and_interrupting"),
        "preferred_styles": ("slow_clear_repetition", "compassionate_caseworker"),
        "instruction": "Make the transcript partial, mangled, nonsensical, or spotty enough that Abby needs to ask the caller to repeat the main need or choose from a small set of categories.",
    },
]

TARGET_MODE_PROFILE_BY_ID = {profile["id"]: profile for profile in TARGET_MODE_PROFILES}
FOCUS_PROFILE_IDS = {
    "all": tuple(profile["id"] for profile in TARGET_MODE_PROFILES),
    "safety-risk": (
        "safety_guardrail_check",
        "suicidal_ideation_ambiguous",
        "medical_distress_check",
        "overdose_or_substance_risk",
        "domestic_violence_or_threat",
        "unsafe_shelter_or_street_risk",
        "psychosis_or_extreme_confusion",
        "minor_runaway_or_exploitation_risk",
        "elder_or_disabled_neglect",
        "pregnancy_or_postpartum_risk",
        "lost_medication_or_medical_device",
        "trafficking_or_coercive_control",
        "urgent_escalation",
        "emotionally_overloaded_request",
        "spotty_voice_clarification",
    ),
}

TARGET_MODE_REQUIRED_BEATS = {
    "surface_navigation_request": [
        "The caller must explicitly ask Abby to open, show, switch to, or bring up a named app surface.",
        "Use a concrete surface name like calendar, messages, uploads, proof center, interactions, audit, security, or wallet.",
        "At least one of the last two caller turns must be about navigation rather than only service search.",
    ],
    "service_interaction_followup": [
        "The caller must describe a prior visit, intake, appointment, call, or provider interaction that already happened.",
        "The caller should ask Abby to note what happened, keep track of it, or help with the next follow-up step.",
        "Include at least one turn that clearly sounds like interaction-history or follow-up logging.",
    ],
    "wallet_document_question": [
        "The caller must ask about wallet files, uploads, proof bundles, QR codes, exports, recovery, or what is stored in the wallet.",
        "At least one turn should sound privacy-aware or mention wanting to check what is already saved.",
    ],
    "provider_contact_request": [
        "The caller must ask Abby to help prepare a text, message, email, voicemail, or call-back plan to a provider.",
        "At least one turn should focus on what to say or how to contact the provider, not just search for services.",
    ],
    "calendar_follow_up": [
        "The caller must ask for a reminder, follow-up, appointment time, or calendar event.",
        "At least one turn should clearly reference when to remember or revisit something.",
    ],
    "fallback_gap_request": [
        "Make the caller ask for details that are likely to have limited or ambiguous local matches.",
        "The call should naturally create a situation where Abby may need to explain an evidence gap or ask for a narrower search.",
    ],
    "spotty_voice_clarification": [
        "The first one or two caller turns should be partial, garbled, noisy, incoherent, or broken up enough that Abby cannot safely infer the full need.",
        "Use realistic partial transcripts like false starts, repeated fragments, [static], [inaudible], or interrupted phrases, but keep them readable JSON strings.",
        "After a repair turn, the caller can become more understandable.",
    ],
    "safety_guardrail_check": [
        "The caller should sound sick, fragile, panicky, or vulnerable enough for Abby to do a safety check before searching.",
        "Avoid explicit 911-level emergency phrases unless you intentionally want a hard emergency escalation.",
        "Let the caller still have a concrete service need after the safety check.",
    ],
    "suicidal_ideation_ambiguous": [
        "Include emotional risk language, but vary whether the caller is ambiguous, passive, or explicitly in immediate danger.",
        "At least one caller turn should let Abby ask a safety question or escalate to a live person.",
        "Keep the caller dignified and realistic rather than melodramatic.",
    ],
    "medical_distress_check": [
        "Include symptoms or exposure risk such as dizziness, weakness, confusion, heat, cold, fainting, or severe pain.",
        "Vary the urgency so some calls need 911 language and others need a brief safety check before service navigation.",
        "Include a concrete service need like clinic, shelter, warming, cooling, or transport.",
    ],
    "overdose_or_substance_risk": [
        "Include overdose, withdrawal, intoxication, or concern for another person.",
        "If the person may be unresponsive, not breathing normally, or in immediate danger, the route should become live_agent.",
        "If the risk is less certain, let Abby check safety before continuing.",
    ],
    "domestic_violence_or_threat": [
        "Include privacy, quiet planning, threats, stalking, assault risk, or fear of going back.",
        "Vary immediate-danger calls and safety-planning calls.",
        "Include a concrete next need such as shelter, advocacy, transport, or contacting a provider.",
    ],
    "unsafe_shelter_or_street_risk": [
        "Include danger outside, weather exposure, harassment, theft, camp sweep, shelter conflict, or fear of sleeping somewhere.",
        "Let Abby check immediate safety before moving to service navigation.",
        "Use a real location and a concrete service need.",
    ],
    "psychosis_or_extreme_confusion": [
        "Include confusion, paranoia, hearing voices, tangents, or unreliable details without making the caller a caricature.",
        "Include at least one turn where Abby should either clarify the main need or check safety.",
        "Vary whether the call resolves into mental health, shelter, medical care, or live-agent escalation.",
    ],
    "minor_runaway_or_exploitation_risk": [
        "Include youth-specific safety concerns such as being under 18, couch-surfing, unsafe adults, running away, or being pressured into something unsafe.",
        "Vary immediate danger, ambiguous exploitation risk, and youth-service navigation.",
        "Keep the caller's language realistic and protect privacy.",
    ],
    "elder_or_disabled_neglect": [
        "Include neglect, isolation, missed meals, missed medication, inaccessible housing, caregiver concerns, or inability to safely travel.",
        "Vary first-person callers and helpers calling on behalf of someone else.",
        "Let Abby check immediate safety before moving to senior, disability, medical, food, or transport support.",
    ],
    "pregnancy_or_postpartum_risk": [
        "Include pregnancy, postpartum emotional risk, bleeding, unsafe sleep, no diapers, or fear of harming self or baby.",
        "Vary medical emergencies and non-emergency safety checks.",
        "Include a concrete service need after the safety question when appropriate.",
    ],
    "lost_medication_or_medical_device": [
        "Include lost, stolen, or unavailable medication or medical equipment like insulin, inhaler, oxygen, wheelchair, walker, or a device charger.",
        "Vary whether the situation is immediately dangerous or a same-day navigation need.",
        "Include location and a realistic barrier like low battery, transport, shelter, or bad reception.",
    ],
    "trafficking_or_coercive_control": [
        "Include coercive control, monitored phone, withheld documents, forced labor, forced sex, or fear of being followed.",
        "Use privacy-preserving language and avoid unnecessary details.",
        "Vary between immediate danger and quiet safety-planning before service navigation.",
    ],
}


@dataclass(frozen=True)
class ScenarioSeed:
    seed_id: str
    service_need: str
    location: str
    caller: dict[str, str]
    channel: dict[str, str]
    style: dict[str, Any]
    target_mode: str


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Generate a single batch and exit.")
    parser.add_argument("--duration-hours", type=float, default=8.0, help="How long the daemon should run.")
    parser.add_argument("--interval-seconds", type=float, default=1.0, help="Pause between batches.")
    parser.add_argument("--batch-size", type=int, default=3, help="Scenario blueprints to generate per pass.")
    parser.add_argument("--checkpoint-every", type=int, default=18, help="Rebuild DAG artifacts after this many new scenarios.")
    parser.add_argument("--max-turns", type=int, default=7, help="Maximum caller turns per generated scenario.")
    parser.add_argument("--seed", type=int, default=211, help="Deterministic random seed for coverage planning.")
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    parser.add_argument("--model-name", default=DEFAULT_MODEL)
    parser.add_argument("--embedding-provider", default="auto")
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    parser.add_argument("--embedding-batch-size", type=int, default=64)
    parser.add_argument("--similarity-candidate-limit", type=int, default=0)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--prompt-templates", type=Path, default=DEFAULT_PROMPTS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--results-jsonl", type=Path, default=DEFAULT_RESULTS_JSONL)
    parser.add_argument("--blueprints-jsonl", type=Path, default=DEFAULT_BLUEPRINTS_JSONL)
    parser.add_argument("--results-json", type=Path, default=DEFAULT_RESULTS_JSON)
    parser.add_argument("--memory-json", type=Path, default=DEFAULT_MEMORY_JSON)
    parser.add_argument("--dag-json", type=Path, default=DEFAULT_DAG_JSON)
    parser.add_argument("--dag-shards", type=Path, default=DEFAULT_DAG_SHARDS)
    parser.add_argument("--report-json", type=Path, default=DEFAULT_REPORT_JSON)
    parser.add_argument("--dryrun-manifest", type=Path, default=DEFAULT_DRYRUN_MANIFEST)
    parser.add_argument("--dryrun-public-manifest", type=Path, default=DEFAULT_DRYRUN_PUBLIC_MANIFEST)
    parser.add_argument("--rewrite-opportunities", type=Path, default=DEFAULT_REWRITE_OPPORTUNITIES)
    parser.add_argument("--slot-friendly-voice", action="store_true", help="Bias assistant replies toward reusable TTS sentence frames.")
    parser.add_argument("--slot-friendly-frame-limit", type=int, default=16)
    parser.add_argument("--state-json", type=Path, default=DEFAULT_STATE_JSON)
    parser.add_argument("--events-jsonl", type=Path, default=DEFAULT_EVENTS_JSONL)
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    parser.add_argument(
        "--focus",
        default="all",
        choices=sorted(FOCUS_PROFILE_IDS),
        help="Restrict scenario planning to a focused profile family.",
    )
    return parser.parse_args(argv)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True))
        handle.write("\n")


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def iter_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def load_slot_friendly_voice_frames(path: Path, *, limit: int = 16) -> list[dict[str, Any]]:
    if not path.exists() or limit <= 0:
        return []
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not load slot-friendly rewrite opportunities from %s: %s", path, exc)
        return []
    frames: list[dict[str, Any]] = []
    for item in report.get("opportunities", []):
        template = str(item.get("canonicalTemplate") or "").strip()
        if not template:
            continue
        frames.append(
            {
                "template": template,
                "familyKind": str(item.get("familyKind") or ""),
                "estimatedSavedChunkCalls": int(item.get("estimatedSavedChunkCalls") or 0),
            }
        )
        if len(frames) >= limit:
            break
    return frames


def slot_friendly_voice_prompt_lines(frames: list[dict[str, Any]]) -> list[str]:
    if not frames:
        return []
    templates = [str(item.get("template") or "").strip() for item in frames if str(item.get("template") or "").strip()]
    return [
        "- Prefer reusable TTS-friendly sentence frames when they fit the evidence and route.",
        "- Replace placeholders like {phone_1}, {location_1}, and {entity_1} with the actual spoken value; never say the placeholder name.",
        "- Keep variable values in their own short sentence when possible, with natural pauses before and after.",
        "- Use these reusable frames verbatim when applicable: " + "; ".join(templates[:12]),
    ]


def extract_first_json_object(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : index + 1])
                except Exception:
                    return None
    return None


def build_coverage_snapshot(results: list[dict[str, Any]]) -> dict[str, Counter[str]]:
    route_counts: Counter[str] = Counter()
    caller_counts: Counter[str] = Counter()
    channel_counts: Counter[str] = Counter()
    style_counts: Counter[str] = Counter()
    target_mode_counts: Counter[str] = Counter()
    service_need_counts: Counter[str] = Counter()
    location_counts: Counter[str] = Counter()
    for result in results:
        route_counts.update(str(route) for route in result.get("actualRoutes", []) if str(route))
        phone = result.get("phone", {}) or {}
        caller_counts.update([str(phone.get("callerArchetype", {}).get("id") or "")])
        channel_counts.update([str(phone.get("channelCondition", {}).get("id") or "")])
        style_counts.update([str(phone.get("assistantStyle", {}).get("id") or "")])
        target_mode_counts.update([str(phone.get("targetMode") or "")])
        service_need_counts.update([str(phone.get("serviceNeed") or "")])
        location_counts.update([str(phone.get("location") or "")])
    return {
        "routes": route_counts,
        "callers": caller_counts,
        "channels": channel_counts,
        "styles": style_counts,
        "targetModes": target_mode_counts,
        "serviceNeeds": service_need_counts,
        "locations": location_counts,
    }


def target_mode_weight(profile: dict[str, Any], route_counts: Counter[str], target_mode_counts: Counter[str]) -> float:
    desired_routes = tuple(str(route) for route in profile.get("desired_routes", ()))
    if not desired_routes:
        return 1.0
    weight = 0.0
    observed_max = max([int(route_counts.get(route, 0)) for route in TARGET_ROUTE_MIN_COUNTS] or [1, 1])
    for route in desired_routes:
        target = TARGET_ROUTE_MIN_COUNTS.get(route, 120)
        current = int(route_counts.get(route, 0))
        deficit = max(target - current, 0)
        scarcity = min(4.0, observed_max / max(current, 1))
        weight += 1.0 + (deficit / max(target, 1)) + (0.35 * scarcity)
        if current == 0:
            weight += 1.5
    seen = int(target_mode_counts.get(str(profile.get("id") or ""), 0))
    return max(0.05, weight / (1.0 + (0.12 * seen)))


def choose_balanced_option(
    options: list[dict[str, Any]],
    *,
    preferred_ids: tuple[str, ...] | list[str] = (),
    counts: Counter[str] | None = None,
    rng: random.Random,
) -> dict[str, Any]:
    preferred = set(preferred_ids)
    candidates = [item for item in options if str(item.get("id") or "") in preferred] if preferred else list(options)
    if not candidates:
        candidates = list(options)
    counts = counts or Counter()
    min_count = min(int(counts.get(str(item.get("id") or ""), 0)) for item in candidates)
    rarest = [item for item in candidates if int(counts.get(str(item.get("id") or ""), 0)) == min_count]
    return rng.choice(rarest)


def choose_balanced_text_option(
    options: list[str],
    *,
    preferred_values: tuple[str, ...] | list[str] = (),
    counts: Counter[str] | None = None,
    rng: random.Random,
) -> str:
    preferred = set(preferred_values)
    candidates = [item for item in options if item in preferred] if preferred else list(options)
    if not candidates:
        candidates = list(options)
    counts = counts or Counter()
    min_count = min(int(counts.get(item, 0)) for item in candidates)
    rarest = [item for item in candidates if int(counts.get(item, 0)) == min_count]
    return rng.choice(rarest)


def focus_profiles(focus: str = "all") -> list[dict[str, Any]]:
    ids = set(FOCUS_PROFILE_IDS.get(focus, FOCUS_PROFILE_IDS["all"]))
    return [profile for profile in TARGET_MODE_PROFILES if str(profile.get("id") or "") in ids]


def choose_target_mode_profile(
    coverage: dict[str, Counter[str]] | None,
    rng: random.Random,
    *,
    focus: str = "all",
) -> dict[str, Any]:
    profiles = focus_profiles(focus)
    if not coverage:
        return rng.choice(profiles)
    route_counts = coverage.get("routes", Counter())
    target_mode_counts = coverage.get("targetModes", Counter())
    weights = [target_mode_weight(profile, route_counts, target_mode_counts) for profile in profiles]
    return rng.choices(profiles, weights=weights, k=1)[0]


def build_seed(
    counter: int,
    rng: random.Random,
    coverage: dict[str, Counter[str]] | None = None,
    *,
    focus: str = "all",
) -> ScenarioSeed:
    profiles = focus_profiles(focus)
    profile = choose_target_mode_profile(coverage, rng, focus=focus) if coverage else profiles[counter % len(profiles)]
    caller = choose_balanced_option(
        CALLER_ARCHETYPES,
        preferred_ids=tuple(profile.get("preferred_callers", ())),
        counts=(coverage or {}).get("callers"),
        rng=rng,
    )
    channel = choose_balanced_option(
        CHANNEL_CONDITIONS,
        preferred_ids=tuple(profile.get("preferred_channels", ())),
        counts=(coverage or {}).get("channels"),
        rng=rng,
    )
    style = choose_balanced_option(
        ASSISTANT_STYLES,
        preferred_ids=tuple(profile.get("preferred_styles", ())),
        counts=(coverage or {}).get("styles"),
        rng=rng,
    )
    service_need = choose_balanced_text_option(
        SERVICE_NEEDS,
        preferred_values=tuple(profile.get("service_needs", ())),
        counts=(coverage or {}).get("serviceNeeds"),
        rng=rng,
    )
    location = choose_balanced_text_option(
        LOCATIONS,
        counts=(coverage or {}).get("locations"),
        rng=rng,
    )
    target_mode = str(profile["id"])
    return ScenarioSeed(
        seed_id=f"phone_seed_{counter:06d}",
        service_need=service_need,
        location=location,
        caller=caller,
        channel=channel,
        style=style,
        target_mode=target_mode,
    )


def scenario_blueprint_prompt(seed: ScenarioSeed, *, max_turns: int) -> str:
    profile = TARGET_MODE_PROFILE_BY_ID.get(seed.target_mode, {})
    required_beats = TARGET_MODE_REQUIRED_BEATS.get(seed.target_mode, [])
    payload = {
        "service_need": seed.service_need,
        "location": seed.location,
        "caller_profile": seed.caller,
        "channel_condition": seed.channel,
        "assistant_style": {"id": seed.style["id"], "title": seed.style["title"]},
        "target_mode": seed.target_mode,
        "max_turns": max_turns,
    }
    return "\n".join(
        [
            "You are generating realistic phone-call user dialogue for a 211-style service navigator.",
            "Return JSON only.",
            "Write the caller like a real human, not like ChatGPT, and do not write the assistant side.",
            "Include phone-specific problems when relevant: repeats, mishearing, interruptions, low battery, crying, confusion, background noise, or asking to repeat a number.",
            "Supported task shapes include grounded 211 search, safety checks, urgent escalation, unclear speech repair, asking Abby to repeat details, wallet document or proof questions, calendar/reminder help, provider messaging, logging a provider visit, and opening a specific app surface.",
            "Do not make the caller sound mocking or cartoonish. Keep dignity even when the caller is distressed, disorganized, manic, sick, or emotional.",
            "Output one JSON object with keys: title, summary, coverageTags, callerTurns.",
            "callerTurns must be a JSON array of 3 to 7 short spoken utterances from the caller only.",
            "Each utterance should sound like something said over the phone, not prose narration.",
            "Make the service need and location come out naturally over the course of the call.",
            "If the target mode implies a wallet/app action, make the caller ask for that action naturally without dropping the service context.",
            f"Target-mode instruction: {profile.get('instruction') or 'Balance realism, safety, and useful route coverage.'}",
            *[f"Required beat: {beat}" for beat in required_beats],
            json.dumps(payload, ensure_ascii=True, sort_keys=True),
        ]
    )


def assistant_prompt(
    *,
    route: str,
    message: str,
    history: list[dict[str, str]],
    evidence: list[dict[str, Any]],
    seed: ScenarioSeed,
    reasons: list[str],
    slot_friendly_frames: list[dict[str, Any]] | None = None,
) -> str:
    evidence_payload = [
        {
            "docId": item.get("docId"),
            "title": item.get("title"),
            "providerName": item.get("providerName"),
            "programName": item.get("programName"),
            "phones": item.get("phones"),
            "addresses": item.get("addresses"),
            "eligibility": item.get("eligibility"),
            "requiredDocuments": item.get("requiredDocuments"),
            "snippet": item.get("snippet"),
        }
        for item in evidence[:3]
    ]
    return "\n".join(
        [
            seed.style["system_prompt"],
            "",
            "You are responding on a phone call as Abby.",
            f"Caller archetype: {seed.caller['label']}. {seed.caller['profile']}",
            f"Phone condition: {seed.channel['label']}. {seed.channel['effect']}",
            f"Conversation route: {route}",
            f"Routing reasons: {', '.join(reasons) if reasons else 'none'}",
            "Response rules:",
            *[f"- {rule}" for rule in seed.style["response_rules"]],
            "- Keep the reply spoken, natural, and under 90 words unless a number or address must be repeated.",
            "- If the route is clarifying_prompt, ask exactly one concrete question.",
            "- If the route is speech_unclear_clarification, say the audio was unclear and ask for one short repeat or one category choice.",
            "- If the route is safety_guardrail_support, do a brief safety check before moving back to service navigation.",
            "- If the route is repeat_or_restate, repeat only the missed detail and chunk it clearly.",
            "- If the route is app_surface_navigation, name the destination surface and what the caller can do there next.",
            "- If the route is wallet_document_support, stay privacy-preserving and focus on wallet files, proofs, uploads, exports, or recovery.",
            "- If the route is calendar_event_support, focus on reminder or appointment timing and ask for only one missing detail.",
            "- If the route is provider_contact_support, help the caller with what to say in a text, email, voicemail, or call.",
            "- If the route is service_interaction_support, summarize what happened with the provider and the next follow-up step.",
            "- If the route is template_guided_fallback, say you do not have a strong local match and ask for one missing detail or offer a human.",
            "- If the route is live_agent and there is urgent safety risk, clearly mention 911.",
            "- If you have a grounded phone number or address, chunk it for speech.",
            *slot_friendly_voice_prompt_lines(slot_friendly_frames or []),
            "- Use only the evidence given below for grounded details.",
            "",
            "Recent history:",
            json.dumps(history[-6:], ensure_ascii=True),
            "",
            f"Current caller turn: {message}",
            "Grounding evidence:",
            json.dumps(evidence_payload, ensure_ascii=True),
            "",
            "Write only Abby's next spoken reply.",
        ]
    )


def generate_text(
    prompt: str,
    *,
    provider: str | None,
    model_name: str,
    max_new_tokens: int,
    temperature: float,
) -> str:
    from ipfs_datasets_py import llm_router  # type: ignore

    return str(
        llm_router.generate_text(
            prompt,
            model_name=model_name,
            provider=provider,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            timeout=240,
        )
    ).strip()


def resolve_provider(provider: str) -> str | None:
    raw = (provider or "").strip()
    if not raw or raw.lower() == "auto":
        return None
    from ipfs_datasets_py import llm_router  # type: ignore

    try:
        llm_router.get_llm_provider(raw)
        return raw
    except Exception as exc:
        logger.warning("Requested provider %s is unavailable through llm_router: %s; falling back to auto", raw, exc)
        return None


def generate_blueprint(seed: ScenarioSeed, *, provider: str, model_name: str, max_turns: int) -> dict[str, Any]:
    raw = generate_text(
        scenario_blueprint_prompt(seed, max_turns=max_turns),
        provider=provider,
        model_name=model_name,
        max_new_tokens=700,
        temperature=0.9,
    )
    parsed = extract_first_json_object(raw)
    if not parsed:
        raise ValueError(f"llm_router blueprint did not return JSON: {raw[:240]}")
    turns = [str(item).strip() for item in parsed.get("callerTurns", []) if str(item).strip()]
    if len(turns) < 3:
        raise ValueError("blueprint returned fewer than 3 caller turns")
    parsed["callerTurns"] = turns[: max(3, min(max_turns, len(turns)))]
    parsed["coverageTags"] = [str(item).strip() for item in parsed.get("coverageTags", []) if str(item).strip()]
    return parsed


def build_phone_history(turns: list[dict[str, Any]]) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for turn in turns:
        history.append({"speaker": "caller", "text": str(turn.get("user") or "")})
        history.append({"speaker": "abby", "text": str(turn.get("assistant") or "")})
    return history


def simulate_phone_scenario(
    *,
    scenario_id: str,
    seed: ScenarioSeed,
    blueprint: dict[str, Any],
    retriever: Local211Retriever,
    templates: dict[str, dict[str, Any]],
    provider: str,
    model_name: str,
    slot_friendly_frames: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    del templates  # The route prompt ids still come from the deterministic router bundle.
    state = ConversationState()
    turns: list[dict[str, Any]] = []
    final_route = ""
    for message in blueprint["callerTurns"]:
        query = build_retrieval_query(message, state)
        hits = retriever.search(query, limit=5)
        route, reasons = route_turn(message, hits, state)
        evidence = [summarize_hit(hit) for hit in hits]
        reply = generate_text(
            assistant_prompt(
                route=route,
                message=message,
                history=build_phone_history(turns),
                evidence=evidence,
                seed=seed,
                reasons=reasons,
                slot_friendly_frames=slot_friendly_frames,
            ),
            provider=provider,
            model_name=model_name,
            max_new_tokens=220,
            temperature=0.55,
        )
        update_conversation_state(state, message, route)
        turn_index = len(turns) + 1
        turns.append(
            {
                "user": message,
                "retrievalQuery": query,
                "route": route,
                "reasons": reasons,
                "assistant": reply,
                "evidence": evidence,
                "promptTemplate": route,
                "state": {
                    "clarificationCount": state.clarification_count,
                    "fallbackCount": state.fallback_count,
                    "safetyGuardrailCount": state.safety_guardrail_count,
                    "speechUnclearCount": state.speech_unclear_count,
                    "liveAgentTriggered": state.live_agent_triggered,
                },
                "phone": {
                    "callerArchetypeId": seed.caller["id"],
                    "channelConditionId": seed.channel["id"],
                    "assistantStyleId": seed.style["id"],
                    "targetMode": seed.target_mode,
                    "turnIndex": turn_index,
                },
            }
        )
        final_route = route
    return {
        "id": scenario_id,
        "title": str(blueprint.get("title") or seed.seed_id),
        "summary": str(blueprint.get("summary") or ""),
        "expectedRoute": None,
        "expectedRoutes": None,
        "actualRoute": final_route,
        "actualRoutes": [turn["route"] for turn in turns],
        "passed": True,
        "coverageTags": sorted(
            {
                seed.caller["id"],
                seed.channel["id"],
                seed.style["id"],
                seed.target_mode,
                infer_service_tag(seed.service_need),
                infer_location_tag(seed.location),
                *[str(item) for item in blueprint.get("coverageTags", [])],
            }
        ),
        "phone": {
            "seedId": seed.seed_id,
            "serviceNeed": seed.service_need,
            "location": seed.location,
            "callerArchetype": seed.caller,
            "channelCondition": seed.channel,
            "assistantStyle": {"id": seed.style["id"], "title": seed.style["title"]},
            "targetMode": seed.target_mode,
        },
        "turns": turns,
    }


def enrich_dag_with_phone_variants(dag: dict[str, Any], memory: dict[str, Any], results: list[dict[str, Any]]) -> dict[str, Any]:
    records = {record["id"]: record for record in memory.get("records", [])}
    scenario_meta = {result["id"]: result.get("phone", {}) for result in results}
    variant_pool: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for record in records.values():
        key = (
            str(record.get("route") or ""),
            infer_service_tag(f"{record.get('user', '')} {record.get('retrievalQuery', '')}"),
            infer_location_tag(f"{record.get('user', '')} {record.get('retrievalQuery', '')}"),
        )
        text = " ".join(str(record.get("assistant") or "").split())
        if text and text not in variant_pool[key]:
            variant_pool[key].append(text)

    for node in dag.get("nodes", []):
        record = records.get(str(node.get("id") or ""))
        if not record:
            continue
        response = " ".join(str(record.get("assistant") or "").split())
        key = (str(node.get("route") or ""), str(node.get("serviceTag") or ""), str(node.get("locationTag") or ""))
        variants = [item for item in variant_pool.get(key, []) if item and item != response][:4]
        if response:
            node["voiceResponse"] = response
            node["assistantResponse"] = response
        node["voiceResponseAlternatives"] = variants
        node["callerArchetypeId"] = scenario_meta.get(str(node.get("scenarioId") or ""), {}).get("callerArchetype", {}).get("id")
        node["channelConditionId"] = scenario_meta.get(str(node.get("scenarioId") or ""), {}).get("channelCondition", {}).get("id")
        node["assistantStyleId"] = scenario_meta.get(str(node.get("scenarioId") or ""), {}).get("assistantStyle", {}).get("id")
    dag["purpose"] = (
        "Precomputed Abby phone-dialog DAG for low-latency voice routing, "
        "caller repair patterns, varied assistant response styles, and future bulk TTS rendering."
    )
    dag["phoneDialog"] = {
        "variantCoverage": {
            "callerArchetypes": Counter(
                str(result.get("phone", {}).get("callerArchetype", {}).get("id") or "") for result in results
            ),
            "channelConditions": Counter(
                str(result.get("phone", {}).get("channelCondition", {}).get("id") or "") for result in results
            ),
            "assistantStyles": Counter(
                str(result.get("phone", {}).get("assistantStyle", {}).get("id") or "") for result in results
            ),
        }
    }
    return dag


def write_artifacts(
    *,
    args: argparse.Namespace,
    results: list[dict[str, Any]],
    templates: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    del templates
    generated_at = utc_now().isoformat()
    results_payload = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "purpose": "LLM-generated Abby phone-dialog simulations with caller persona, phone repair patterns, and assistant style variation.",
        "provider": args.provider,
        "modelName": args.model_name,
        "focus": args.focus,
        "slotFriendlyVoice": bool(args.slot_friendly_voice),
        "rewriteOpportunities": str(args.rewrite_opportunities),
        "scenarioCount": len(results),
        "turnCount": sum(len(result.get("turns", [])) for result in results),
        "results": results,
    }
    write_json(args.results_json, results_payload)

    memory = build_conversation_memory(
        results,
        generated_at=generated_at,
        embedding_provider=args.embedding_provider,
        embedding_model=args.embedding_model,
        embedding_batch_size=args.embedding_batch_size,
        similarity_candidate_limit=args.similarity_candidate_limit,
    )
    write_json(args.memory_json, memory)

    dag = build_conversation_dag(memory, results, generated_at=generated_at)
    dag = enrich_dag_with_phone_variants(dag, memory, results)
    write_json(args.dag_json, dag)
    write_dag_shards(args.dag_shards, dag, memory.get("embedding", {}))

    coverage = {
        "routes": Counter(turn["route"] for result in results for turn in result.get("turns", [])),
        "callerArchetypes": Counter(
            str(result.get("phone", {}).get("callerArchetype", {}).get("id") or "") for result in results
        ),
        "channelConditions": Counter(
            str(result.get("phone", {}).get("channelCondition", {}).get("id") or "") for result in results
        ),
        "assistantStyles": Counter(
            str(result.get("phone", {}).get("assistantStyle", {}).get("id") or "") for result in results
        ),
        "targetModes": Counter(str(result.get("phone", {}).get("targetMode") or "") for result in results),
        "serviceTags": Counter(
            infer_service_tag(str(result.get("phone", {}).get("serviceNeed") or "")) for result in results
        ),
        "locationTags": Counter(
            infer_location_tag(str(result.get("phone", {}).get("location") or "")) for result in results
        ),
    }
    write_json(
        args.report_json,
        {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "scenarioCount": len(results),
            "turnCount": sum(len(result.get("turns", [])) for result in results),
            "focus": args.focus,
            "slotFriendlyVoice": bool(args.slot_friendly_voice),
            "coverage": {key: dict(sorted(counter.items())) for key, counter in coverage.items()},
        },
    )

    subprocess.run(
        [
            "python3",
            str(REPO_ROOT / "scripts/precompute_indextts_responses.py"),
            "--dag",
            str(args.dag_json),
            "--results",
            str(args.results_json),
            "--manifest",
            str(args.dryrun_manifest),
            "--public-manifest",
            str(args.dryrun_public_manifest),
            "--dry-run",
        ],
        cwd=REPO_ROOT,
        check=True,
    )
    return {
        "results_json": str(args.results_json),
        "memory_json": str(args.memory_json),
        "dag_json": str(args.dag_json),
        "dag_shards": str(args.dag_shards),
        "dryrun_manifest": str(args.dryrun_manifest),
    }


def update_state(
    args: argparse.Namespace,
    *,
    started_at: datetime,
    deadline: datetime,
    batch_count: int,
    scenario_counter: int,
    last_error: str = "",
    artifact_paths: dict[str, Any] | None = None,
) -> None:
    payload = {
        "schemaVersion": 1,
        "updatedAt": utc_now().isoformat(),
        "startedAt": started_at.isoformat(),
        "deadlineAt": deadline.isoformat(),
        "pid": os.getpid(),
        "provider": args.provider,
        "modelName": args.model_name,
        "focus": args.focus,
        "slotFriendlyVoice": bool(args.slot_friendly_voice),
        "rewriteOpportunities": str(args.rewrite_opportunities),
        "batchCount": batch_count,
        "scenarioCounter": scenario_counter,
        "lastError": last_error,
        "artifacts": artifact_paths or {},
    }
    write_json(args.state_json, payload)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level), format="%(asctime)s %(levelname)s %(message)s")
    effective_provider = resolve_provider(args.provider)
    rng = random.Random(args.seed)
    started_at = utc_now()
    deadline = started_at + timedelta(hours=max(0.0, args.duration_hours))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.state_dir.mkdir(parents=True, exist_ok=True)

    templates = load_prompt_templates(args.prompt_templates)
    documents = load_documents(args.corpus)
    retriever = Local211Retriever(documents)
    slot_friendly_frames = (
        load_slot_friendly_voice_frames(args.rewrite_opportunities, limit=args.slot_friendly_frame_limit)
        if args.slot_friendly_voice
        else []
    )
    logger.info(
        "Loaded %s documents and %s prompt templates; llm_router provider=%s model=%s slot_friendly_frames=%s",
        len(documents),
        len(templates),
        effective_provider or "auto",
        args.model_name,
        len(slot_friendly_frames),
    )

    state = load_json(args.state_json, {"scenarioCounter": 0, "batchCount": 0})
    existing_results = iter_jsonl(args.results_jsonl)
    existing_result_count = len(existing_results)
    all_results = list(existing_results)
    coverage_snapshot = build_coverage_snapshot(all_results)
    scenario_counter = max(int(state.get("scenarioCounter") or 0), existing_result_count)
    batch_count = int(state.get("batchCount") or 0)
    artifact_paths: dict[str, Any] = {}
    if existing_result_count:
        logger.info("Resuming with %s existing scenarios", existing_result_count)

    while utc_now() < deadline:
        generated_this_batch = 0
        for _ in range(max(1, args.batch_size)):
            scenario_counter += 1
            scenario_id = f"phone_dialog_{scenario_counter:07d}"
            seed = build_seed(scenario_counter, rng, coverage_snapshot, focus=args.focus)
            try:
                blueprint = generate_blueprint(
                    seed,
                    provider=effective_provider,
                    model_name=args.model_name,
                    max_turns=args.max_turns,
                )
                append_jsonl(
                    args.blueprints_jsonl,
                    {
                        "generatedAt": utc_now().isoformat(),
                        "scenarioId": scenario_id,
                        "seed": {
                            "seedId": seed.seed_id,
                            "serviceNeed": seed.service_need,
                            "location": seed.location,
                            "callerArchetypeId": seed.caller["id"],
                            "channelConditionId": seed.channel["id"],
                            "assistantStyleId": seed.style["id"],
                            "targetMode": seed.target_mode,
                        },
                        "blueprint": blueprint,
                    },
                )
                result = simulate_phone_scenario(
                    scenario_id=scenario_id,
                    seed=seed,
                    blueprint=blueprint,
                    retriever=retriever,
                    templates=templates,
                    provider=effective_provider,
                    model_name=args.model_name,
                    slot_friendly_frames=slot_friendly_frames,
                )
                append_jsonl(args.results_jsonl, result)
                append_jsonl(
                    args.events_jsonl,
                    {
                        "timestamp": utc_now().isoformat(),
                        "type": "scenario_generated",
                        "scenarioId": scenario_id,
                        "turnCount": len(result.get("turns", [])),
                        "coverageTags": result.get("coverageTags", []),
                    },
                )
                all_results.append(result)
                coverage_snapshot = build_coverage_snapshot(all_results)
                generated_this_batch += 1
            except Exception as exc:
                append_jsonl(
                    args.events_jsonl,
                    {
                        "timestamp": utc_now().isoformat(),
                        "type": "scenario_error",
                        "scenarioId": scenario_id,
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                )
                update_state(
                    args,
                    started_at=started_at,
                    deadline=deadline,
                    batch_count=batch_count,
                    scenario_counter=scenario_counter,
                    last_error=f"{type(exc).__name__}: {exc}",
                    artifact_paths=artifact_paths,
                )
                logger.warning("Scenario %s failed: %s", scenario_id, exc)
        batch_count += 1
        logger.info("Batch %s generated %s scenarios", batch_count, generated_this_batch)

        if generated_this_batch and scenario_counter % max(1, args.checkpoint_every) < generated_this_batch:
            artifact_paths = write_artifacts(args=args, results=all_results, templates=templates)
            append_jsonl(
                args.events_jsonl,
                {
                    "timestamp": utc_now().isoformat(),
                    "type": "checkpoint_written",
                    "scenarioCount": len(all_results),
                    "turnCount": sum(len(result.get("turns", [])) for result in all_results),
                    "artifacts": artifact_paths,
                },
            )
            logger.info("Checkpointed %s scenarios", len(all_results))

        update_state(
            args,
            started_at=started_at,
            deadline=deadline,
            batch_count=batch_count,
            scenario_counter=scenario_counter,
            artifact_paths=artifact_paths,
        )
        if args.once:
            break
        time.sleep(max(0.0, args.interval_seconds))

    artifact_paths = write_artifacts(args=args, results=all_results, templates=templates)
    update_state(
        args,
        started_at=started_at,
        deadline=deadline,
        batch_count=batch_count,
        scenario_counter=scenario_counter,
        artifact_paths=artifact_paths,
    )
    append_jsonl(
        args.events_jsonl,
        {
            "timestamp": utc_now().isoformat(),
            "type": "daemon_finished",
            "scenarioCount": len(all_results),
            "turnCount": sum(len(result.get("turns", [])) for result in all_results),
            "artifacts": artifact_paths,
        },
    )
    logger.info("Finished with %s scenarios", len(all_results))


if __name__ == "__main__":
    main()
