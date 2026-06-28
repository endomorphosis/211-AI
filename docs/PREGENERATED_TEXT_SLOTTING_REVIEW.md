# Pregenerated Text Slotting Review

Input manifest: docs/pregenerated_text_response_manifest.json
Dedupe summary JSON: docs/pregenerated_text_chunk_dedupe.json
Rewrite opportunities JSON: docs/pregenerated_text_rewrite_opportunities.json

## Coverage

- Unified pregenerated responses reviewed: 13809
- Unique sentence chunks after splitting: 46747
- Reusable sentence chunks: 3632
- Unique masked templates: 43587
- Reusable masked templates: 477
- Estimated chunk reuse ratio: 0.3015
- Estimated masked-template reuse ratio: 0.0676

## Source Families

- 211: 149
- phone_dialog: 13660

## Top Named Entities

- Oregon: 1485
- Portland: 1043
- Eugene: 848
- ID: 799
- Salem: 606
- Hillsboro: 593
- Bend: 522
- Clackamas: 518
- Gresham: 477
- Medford: 459
- Beaverton: 443
- Oregon City: 439
- Washington: 399
- Multnomah: 353
- Washington County: 246
- Multnomah County: 232
- Lane County: 217
- ZIP: 199
- La Grande: 174
- Place: 173
- La Pine: 127
- Lane County Diaper Bank: 112
- SNAP: 99
- Game Farm Road: 95
- Clackamas Service Center: 94

## Opportunity Summary

- Rewrite opportunity families found: 98
- Estimated saved chunk calls across all opportunities: 5895
- Estimated saved chunk calls in reported top set: 5895
- Opportunity family kinds: {"211_phrase": 1, "emergency_phrase": 1, "location": 23, "named_entity": 36, "phone_or_number": 30, "static_phrase": 7}
- Opportunity source-family counts: {"211": 11, "phone_dialog": 74}
- Audio plan static segments across all reusable families: 178
- Audio plan slot-kind count across all reusable families: 108

## Highest-Value Candidates

- Call {phone_1}.: kind=phone_or_number, unique_chunks=1351, estimated_saved=1347, families=211, phone_dialog
  Example: You can call five-four-one, two-two-one, zero-eight-two-four.
- The number is {phone_1}.: kind=phone_or_number, unique_chunks=1063, estimated_saved=1059, families=phone_dialog
  Example: The number is five four one, two two one, zero eight two four.
- The number is {number_1}, {number_2}, {number_3}.: kind=phone_or_number, unique_chunks=756, estimated_saved=748, families=211, phone_dialog
  Example: The number is 503, 581, 5265.
- Call {number_1}, {number_2}, {number_3}.: kind=phone_or_number, unique_chunks=749, estimated_saved=741, families=phone_dialog
  Example: Call 503, 228, 7465.
- I’ll repeat: {phone_1}.: kind=phone_or_number, unique_chunks=546, estimated_saved=542, families=phone_dialog
  Example: Again: 8-8-8, 6-8-9, 3-1-1-1.
- I’ll repeat: {number_1}, {number_2}, {number_3}.: kind=phone_or_number, unique_chunks=445, estimated_saved=437, families=phone_dialog
  Example: I’ll repeat: 541, 343, 4747.
- Backup number: {phone_1}.: kind=phone_or_number, unique_chunks=344, estimated_saved=340, families=211, phone_dialog
  Example: Backup number: 5-4-1, 7-4-3, 7-1-7-0.
- Backup number: {number_1}, {number_2}, {number_3}.: kind=phone_or_number, unique_chunks=199, estimated_saved=191, families=phone_dialog
  Example: Backup number: 541, 393, 8552.
- Main number: {phone_1}.: kind=phone_or_number, unique_chunks=148, estimated_saved=144, families=phone_dialog
  Example: Most important number first: 5 0 3, 5 3 5, 1 1 5 1.
- {zip_1}.: kind=static_phrase, unique_chunks=56, estimated_saved=53, families=211, phone_dialog
  Example: ZIP code nine seven two one six.
- {entity_1}.: kind=named_entity, unique_chunks=48, estimated_saved=45, families=phone_dialog
  Example: Overnight Winter Warming Shelter.
- I found {entity_1}.: kind=named_entity, unique_chunks=44, estimated_saved=40, families=211, phone_dialog
  Example: I found Red Cross Disaster Services.
- The name is {entity_1}.: kind=named_entity, unique_chunks=31, estimated_saved=27, families=phone_dialog
  Example: The name is Right Track Resource Center Overnight Winter Warming Shelter.
- The address is {number_1} {address_part_1}, {location_1}, {location_2}.: kind=phone_or_number, unique_chunks=34, estimated_saved=23, families=211
  Example: The address is 800 North East Oregon Street, Portland, Oregon.
- I found {location_1}.: kind=location, unique_chunks=25, estimated_saved=21, families=211
  Example: I found Dav Transportation Network Portland VA Medical Center.
- {location_1}.: kind=location, unique_chunks=23, estimated_saved=20, families=phone_dialog
  Example: Multnomah County Eviction Prevention Program.
- Again: {entity_1}.: kind=named_entity, unique_chunks=14, estimated_saved=10, families=phone_dialog
  Example: Again: Gateway Center.
- {number_1}.: kind=phone_or_number, unique_chunks=13, estimated_saved=10, families=phone_dialog
  Example: 771.
- I’m in {location_1}.: kind=location, unique_chunks=13, estimated_saved=9, families=phone_dialog
  Example: Say: “I’m in Oregon City.
- Address: {number_1} {address_part_1}, {location_1}.: kind=phone_or_number, unique_chunks=17, estimated_saved=8, families=phone_dialog
  Example: Address: 1333 Northwest Eastman Parkway, Gresham.

## Audio Composition Plan

- Call {phone_1}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=2, slot_kinds=phone
  Top phone values: 5 4 1, 9 6 2, 7 9 9 4, 3-6-0, 5-2-1, 6-5-2-7, 5-4-1, 2-2-1, 0-8-2-4
- The number is {phone_1}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=2, slot_kinds=phone
  Top phone values: 5 4 1, 9 6 2, 7 9 9 4, 5 4 1, 7 7 9, 4 3 5 7, 5-0-3, 7-7-1, 7-9-1-4
- The number is {number_1}, {number_2}, {number_3}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=4, slot_kinds=number
  Top number values: 503, 541, 771
- Call {number_1}, {number_2}, {number_3}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=4, slot_kinds=number
  Top number values: 503, 541, 800
- I’ll repeat: {phone_1}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=2, slot_kinds=phone
  Top phone values: 5-4-1, 2-2-1, 0-8-2-4, 5 4 1, 9 6 2, 7 9 9 4, 5-4-1, 3-2-2, 8-7-6-8
- I’ll repeat: {number_1}, {number_2}, {number_3}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=4, slot_kinds=number
  Top number values: 503, 541, 800
- Backup number: {phone_1}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=2, slot_kinds=phone
  Top phone values: 9-7-1, 3-1-9, 9-7-9-3, nine seven one, three one nine, nine seven nine three, three six zero, five two one, six five two seven
- Backup number: {number_1}, {number_2}, {number_3}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=4, slot_kinds=number
  Top number values: 503, 541, 800
- Main number: {phone_1}.: strategy=compose static shells with numeric or phone slot audio; prioritize digit and phone chunk reuse first, static_segments=2, slot_kinds=phone
  Top phone values: 3-6-0, 5-2-1, 6-5-2-7, five four one, three two two, eight seven six eight, nine seven one, three one nine, nine seven nine three
- {zip_1}.: strategy=synthesize once as a static reusable chunk, static_segments=1, slot_kinds=zip
  Top zip values: ZIP code nine seven nine one four, ZIP code nine seven two two three, ZIP code nine seven two one four
- {entity_1}.: strategy=compose a reusable shell with provider or program entity audio, static_segments=1, slot_kinds=entity
  Top entity values: Overnight Winter Warming Shelter, Not Union Gospel, Right Track Resource Center Overnight Winter Warming Shelter
- I found {entity_1}.: strategy=compose a reusable shell with provider or program entity audio, static_segments=2, slot_kinds=entity
  Top entity values: Homeless Day Center, Eviction Prevention Assistance, Behavioral Health Services

## Interpretation

- Phone and numeric prompts are still the largest slotting surface, so number-specific chunk composition remains the biggest direct GPU savings lever.
- Named provider and program entities remain frequent enough to justify more reusable entity-slot frames beyond the current slotted DAG coverage.
- Location-bearing prompts are common enough to benefit from more canonical location-slot frames, especially where the surrounding sentence shell is stable.
