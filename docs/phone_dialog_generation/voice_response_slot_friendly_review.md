# Slot-Friendly Voice Response Review

Generated: 2026-05-26T17:36:42.286347+00:00

## NER-Enhanced Scan

This pass uses local named-entity recognition heuristics for provider/program names, acronyms, Oregon locations, address-like phrases, and service-response cue phrases such as “call”, “contact”, “the nearest option is”, and “I found”.

## Dedupe Summary

- uniqueFullResponses: 13660
- fullResponseSourceRefs: 13660
- uniqueSentenceChunks: 46252
- sentenceChunkSourceRefs: 66131
- reusableSentenceChunks: 3577
- uniqueMaskedTemplates: 43397
- reusableMaskedTemplates: 459
- estimatedChunkReuseRatio: 0.3006
- estimatedMaskedTemplateReuseRatio: 0.0617

## Rewrite Opportunity Summary

- opportunityCount: 91
- reportedOpportunityCount: 91
- estimatedSavedChunkCallsTop: 5627
- estimatedSavedChunkCallsAll: 5627
- familyKindCounts: {'211_phrase': 1, 'emergency_phrase': 1, 'location': 22, 'named_entity': 32, 'phone_or_number': 28, 'static_phrase': 7}
- note: Savings are static-analysis estimates. Slot audio still needs prosody validation before runtime composition.

## Top Named Entities Found

- `Oregon`: 1377
- `Portland`: 1014
- `Eugene`: 828
- `ID`: 798
- `Salem`: 583
- `Hillsboro`: 578
- `Bend`: 520
- `Clackamas`: 514
- `Gresham`: 469
- `Medford`: 447
- `Oregon City`: 437
- `Beaverton`: 436
- `Washington`: 393
- `Multnomah`: 346
- `Washington County`: 246
- `Multnomah County`: 232
- `Lane County`: 217
- `La Grande`: 174
- `Place`: 173
- `ZIP`: 163
- `La Pine`: 126
- `Lane County Diaper Bank`: 112
- `Game Farm Road`: 94
- `Clackamas Service Center`: 94
- `SNAP`: 93
- `OHP`: 90
- `Overnight Winter Warming Shelter`: 83
- `ER`: 82
- `Cascades West Ride Line`: 82
- `Safe Place`: 82

## Highest-Value Rewrites

| Rank | Canonical frame | Kind | Saved calls | Unique chunks | Source templates | Examples |
|---:|---|---|---:|---:|---:|---|
| 1 | `Call {phone_1}.` | phone_or_number | 1258 | 1262 | 951 | You can call five-four-one, two-two-one, zero-eight-two-four. / You can call 5 0 3, 8 4 6, 3 0 9 4. |
| 2 | `The number is {phone_1}.` | phone_or_number | 1059 | 1063 | 714 | The number is five four one, two two one, zero eight two four. / The number is 5 0 3, 3 5 2, 6 0 0 0. |
| 3 | `The number is {number_1}, {number_2}, {number_3}.` | phone_or_number | 747 | 755 | 442 | The number is 503, 581, 5265. / The number is 541, 864, 0776. |
| 4 | `Call {number_1}, {number_2}, {number_3}.` | phone_or_number | 741 | 749 | 555 | Call 503, 228, 7465. / Call 541, 221, 0824. |
| 5 | `I’ll repeat: {phone_1}.` | phone_or_number | 542 | 546 | 96 | Again: 8-8-8, 6-8-9, 3-1-1-1. / Again: three six zero, five two one, six five two seven. |
| 6 | `I’ll repeat: {number_1}, {number_2}, {number_3}.` | phone_or_number | 437 | 445 | 117 | I’ll repeat: 541, 343, 4747. / I’ll repeat: 541, 336, 2339. |
| 7 | `Backup number: {phone_1}.` | phone_or_number | 285 | 289 | 116 | Backup number: 5-4-1, 7-4-3, 7-1-7-0. / Backup number: 5 4 1, 8 4 1, 1 9 7 4. |
| 8 | `Backup number: {number_1}, {number_2}, {number_3}.` | phone_or_number | 191 | 199 | 76 | Backup number: 541, 393, 8552. / Backup number: 541, 367, 5181. |
| 9 | `Main number: {phone_1}.` | phone_or_number | 144 | 148 | 61 | Most important number first: 5 0 3, 5 3 5, 1 1 5 1. / Most important number first: 5 0 3, 6 5 0, 5 6 2 2. |
| 10 | `{entity_1}.` | named_entity | 45 | 48 | 1 | Overnight Winter Warming Shelter. / Tap Reminder. |
| 11 | `The name is {entity_1}.` | named_entity | 27 | 31 | 4 | The name is Right Track Resource Center Overnight Winter Warming Shelter. / The name is KEEP. |
| 12 | `{location_1}.` | location | 20 | 23 | 1 | Multnomah County Eviction Prevention Program. / Salem. |
| 13 | `{zip_1}.` | static_phrase | 20 | 23 | 1 | ZIP code nine seven three zero four. / ZIP code nine seven zero four five. |
| 14 | `Again: {entity_1}.` | named_entity | 10 | 14 | 1 | Again: Gateway Center. / Again: Clothes That Work. |
| 15 | `{number_1}.` | phone_or_number | 10 | 13 | 1 | 771. / 2380. |
| 16 | `I’m in {location_1}.` | location | 9 | 13 | 2 | Say: “I’m in Oregon City. / Say: “I’m in Clackamas. |
| 17 | `Address: {number_1} {address_part_1}, {location_1}.` | phone_or_number | 8 | 17 | 1 | Address: 1333 Northwest Eastman Parkway, Gresham. / Address: 4060 West Amazon Drive, Eugene. |
| 18 | `I’ll say it again: {entity_1}.` | named_entity | 7 | 11 | 1 | I’ll say it again: Right Track Resource Center. / I’ll say it again: Fora Health. |
| 19 | `The name is {location_1}.` | location | 7 | 11 | 1 | The name is DHS Gresham. / The name is Portland Therapy Project. |
| 20 | `{address_part_1} name is {entity_1}.` | named_entity | 5 | 11 | 2 | The Place name is Ledding Library. / The Place name is Recovery Village Center Medical Detox. |
| 21 | `Again: {location_1}.` | location | 5 | 9 | 1 | Again: Multnomah County Eviction Prevention Program. / Again: Oregon City. |
| 22 | `Address is {number_1} {address_part_1}, {location_1}.` | phone_or_number | 4 | 13 | 1 | Address is 2890 Chad Drive, Eugene. / Address is 10305 East Burnside Street, Portland. |
| 23 | `It is {entity_1}.` | named_entity | 4 | 8 | 1 | It is JOIN PDX. / It is Cascades West Ride Line. |
| 24 | `I’ll repeat it: {entity_1}.` | named_entity | 4 | 8 | 1 | I’ll repeat it: Mercy Medical Angels. / I’ll repeat it: SUN. |
| 25 | `I’ll repeat: {location_1}.` | location | 4 | 8 | 1 | I’ll repeat: Greyhound Portland. / I’ll repeat: Washington County. |
| 26 | `Call nine one one now.` | emergency_phrase | 4 | 5 | 5 | Call nine one one right away. / call nine one one right away. |
| 27 | `{address_part_1} name is {location_1}.` | location | 3 | 9 | 2 | The Place name is Multnomah County. / The Place name is Downtown Bend Library. |
| 28 | `Call {entity_1}.` | named_entity | 3 | 7 | 2 | Open the Wallet surface. / Open the Extreme Heat Cooling Centers screen. |
| 29 | `{location_1}, {location_2}.` | location | 2 | 7 | 2 | Bend, Oregon. / Portland, Multnomah County. |
| 30 | `Again: {address_part_1}.` | static_phrase | 2 | 6 | 1 | Again: Lane County. / Again: Northwest Station Way. |
| 31 | `Are you in {location_1} right now?` | location | 2 | 6 | 1 | Are you in Medford right now? / Are you in Clackamas County right now? |
| 32 | `The clinic name is {entity_1}.` | named_entity | 2 | 6 | 1 | The clinic name is Salud Medical Center Dental Care. / The clinic name is Mental Health Therapies. |
| 33 | `{address_part_1}.` | static_phrase | 2 | 5 | 1 | West Sixth Street. / Lane County Diaper Bank. |
| 34 | `{entity_1} now.` | named_entity | 2 | 5 | 1 | Open Messages now. / Opening the Calendar now. |
| 35 | `Call two one one.` | 211_phrase | 2 | 3 | 3 | Dial two one one now. / Call two one one first. |

## New NER-Slotted Families To Prefer

- `{entity_1}.`: 48 chunks, saved 45
- `The name is {entity_1}.`: 31 chunks, saved 27
- `{location_1}.`: 23 chunks, saved 20
- `Again: {entity_1}.`: 14 chunks, saved 10
- `I’m in {location_1}.`: 13 chunks, saved 9
- `I’ll say it again: {entity_1}.`: 11 chunks, saved 7
- `The name is {location_1}.`: 11 chunks, saved 7
- `{address_part_1} name is {entity_1}.`: 11 chunks, saved 5
- `Again: {location_1}.`: 9 chunks, saved 5
- `It is {entity_1}.`: 8 chunks, saved 4
- `I’ll repeat it: {entity_1}.`: 8 chunks, saved 4
- `I’ll repeat: {location_1}.`: 8 chunks, saved 4
- `{address_part_1} name is {location_1}.`: 9 chunks, saved 3
- `Call {entity_1}.`: 7 chunks, saved 3
- `{location_1}, {location_2}.`: 7 chunks, saved 2
- `Are you in {location_1} right now?`: 6 chunks, saved 2
- `The clinic name is {entity_1}.`: 6 chunks, saved 2
- `{entity_1} now.`: 5 chunks, saved 2
- `Can you call {entity_1} with you?`: 5 chunks, saved 1
- `I heard {location_1}.`: 5 chunks, saved 1

## Suggested Rewrite Rules

- Provider/program names: rewrite service matches into stable frames such as `The name is {entity_1}.`, `{entity_1} is in {location_1}.`, or `Call {entity_1}.`
- Phone numbers: rewrite any “you can call”, “number is”, “again”, “backup” variants into one of `Call {phone_1}.`, `The number is {phone_1}.`, `I’ll repeat: {phone_1}.`, or `Backup number: {phone_1}.`
- Three-part phone fragments: rewrite comma/ellipsis variants into `Call {number_1}, {number_2}, {number_3}.` or `The number is {number_1}, {number_2}, {number_3}.`
- Emergency language: use `If you are in immediate danger, call nine one one now.` or `Call nine one one now.` exactly.
- 211 language: use `Call two one one.` or `Two one one.` exactly when the chunk is only a call instruction.
- Locations: keep short chunks like `In {location_1}.` or `I’m in {location_1}.` instead of many locally phrased variants.

## Top Static/Slot Asset Families

- named_entity: 32 families, estimated 114 saved chunk calls
- phone_or_number: 28 families, estimated 5426 saved chunk calls
- location: 22 families, estimated 56 saved chunk calls
- static_phrase: 7 families, estimated 25 saved chunk calls
- 211_phrase: 1 families, estimated 2 saved chunk calls
- emergency_phrase: 1 families, estimated 4 saved chunk calls

