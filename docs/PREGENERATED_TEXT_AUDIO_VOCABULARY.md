# Pregenerated Text Audio Vocabulary

Audio plan input: docs/pregenerated_text_audio_slot_plan.json
Browser corpus input: wallet_interface/ui/public/corpus/211-info/current
Vocabulary inventory: docs/pregenerated_text_audio_vocabulary_inventory.json
Vocabulary manifest: docs/pregenerated_text_audio_vocabulary_manifest.json
BM25-only manifest: docs/pregenerated_text_audio_bm25_manifest.json
GraphRAG candidates: docs/graphrag_audio_prerender_candidates.json

## Summary

- Audio-plan normalized values considered: 96
- BM25 reuse terms retained: 11611
- BM25-only precompute entries: 11608
- GraphRAG entity-name candidates retained: 180
- GraphRAG phone candidates retained: 180
- GraphRAG address candidates retained: 180
- Combined precompute-ready vocabulary entries: 12225

## Top Combined Candidates

- Portland: priority=8261.0179, candidate_kinds=audio_plan_slot_value, bm25_term, slot_kinds=location, term
- health: priority=8221.0136, candidate_kinds=bm25_term, slot_kinds=term
- housing: priority=7951.3743, candidate_kinds=bm25_term, slot_kinds=term
- mental: priority=6803.8732, candidate_kinds=bm25_term, slot_kinds=term
- school: priority=6705.1681, candidate_kinds=bm25_term, slot_kinds=term
- Avenue: priority=6697.3952, candidate_kinds=bm25_term, slot_kinds=term
- food: priority=6182.2725, candidate_kinds=bm25_term, slot_kinds=term
- youth: priority=5813.5348, candidate_kinds=bm25_term, slot_kinds=term
- child: priority=5664.5124, candidate_kinds=bm25_term, slot_kinds=term
- care: priority=5463.6194, candidate_kinds=bm25_term, slot_kinds=term
- shelter: priority=5302.1589, candidate_kinds=bm25_term, slot_kinds=term
- families: priority=4980.4367, candidate_kinds=bm25_term, slot_kinds=term
- counseling: priority=4849.644, candidate_kinds=bm25_term, slot_kinds=term
- resources: priority=4834.2149, candidate_kinds=bm25_term, slot_kinds=term
- Salem: priority=4489.1284, candidate_kinds=audio_plan_slot_value, bm25_term, slot_kinds=location, term
- summer: priority=4339.5375, candidate_kinds=bm25_term, slot_kinds=term
- Road: priority=4320.9277, candidate_kinds=bm25_term, slot_kinds=term
- E B T: priority=4315.0651, candidate_kinds=bm25_term, slot_kinds=term
- center: priority=4311.3948, candidate_kinds=bm25_term, slot_kinds=term
- family: priority=4030.345, candidate_kinds=bm25_term, slot_kinds=term

## Top BM25 Terms

- portland: bm25_score=8240.018, matched_docs=2021, df=5662
- health: bm25_score=8221.014, matched_docs=2498, df=11134
- housing: bm25_score=7951.374, matched_docs=1431, df=4780
- mental: bm25_score=6803.873, matched_docs=1568, df=5592
- school: bm25_score=6705.168, matched_docs=939, df=3821
- Avenue: bm25_score=6586.395, matched_docs=1865, df=5859
- food: bm25_score=6182.272, matched_docs=1010, df=3899
- youth: bm25_score=5813.535, matched_docs=1282, df=4835
- child: bm25_score=5664.512, matched_docs=1272, df=5297
- care: bm25_score=5463.619, matched_docs=1656, df=8932
- shelter: bm25_score=5302.159, matched_docs=943, df=3451
- families: bm25_score=4980.437, matched_docs=1237, df=6126
- counseling: bm25_score=4849.644, matched_docs=1200, df=4926
- resources: bm25_score=4834.215, matched_docs=1374, df=4793
- salem: bm25_score=4466.128, matched_docs=676, df=2184
- summer: bm25_score=4339.537, matched_docs=519, df=1912
- Road: bm25_score=4320.928, matched_docs=748, df=2505
- E B T: bm25_score=4315.065, matched_docs=161, df=529
- center: bm25_score=4311.395, matched_docs=1414, df=7509
- family: bm25_score=4030.345, matched_docs=1212, df=7668

## Top GraphRAG Entity Names

- DAYTIME WINTER WARMING CENTER: observed_in_docs=178

## Top GraphRAG Phones

- five zero three, two eight eight, eight one seven seven: observed_in_docs=135
- eight three three, nine nine zero, nine nine three zero: observed_in_docs=131
- eight five five, five zero three, seven two three three: observed_in_docs=126
- five four one, nine six seven, three eight eight eight: observed_in_docs=104
- five four one, three four two, five zero eight eight: observed_in_docs=104
- five four one, nine six two, eight eight zero zero: observed_in_docs=103
- five four one, five seven five, zero four two nine: observed_in_docs=102
- five four one, three eight six, one one one five: observed_in_docs=98
- five zero three, six four five, nine zero one zero: observed_in_docs=93
- five four one, seven six six, six eight three five: observed_in_docs=88
- five four one, three eight six, six three eight zero: observed_in_docs=84
- five four one, three two two, seven four zero zero: observed_in_docs=83
- five zero three, two eight zero, two six zero zero: observed_in_docs=83
- five four one, four seven five, four four five six: observed_in_docs=79
- five zero three, nine five three, six five nine eight: observed_in_docs=79
- five zero three, two three zero, nine eight seven five: observed_in_docs=76
- nine seven one, two seven nine, four eight zero zero: observed_in_docs=76
- five four one, eight eight nine, nine one six seven: observed_in_docs=74
- five four one, four four seven, five one six five: observed_in_docs=74
- five four one, six eight seven, two six six seven: observed_in_docs=74

## Top GraphRAG Addresses

- five one three five North East Columbia Boulevard, Portland, Oregon. ZIP code nine seven two one eight: observed_in_docs=165
- two five seven seven North East Courtney Drive, Bend, Oregon. ZIP code nine seven seven zero one: observed_in_docs=146
- five three zero North West twenty seventh Street, Corvallis, Oregon. ZIP code nine seven three three zero: observed_in_docs=131
- seven zero seven South West Gaines Street, Portland, Oregon. ZIP code nine seven two three nine: observed_in_docs=131
- four two two North Main Street, Condon, Oregon. ZIP code nine seven eight two three: observed_in_docs=110
- two three zero one Cove Avenue, La Grande, Oregon. ZIP code nine seven eight five zero: observed_in_docs=108
- one four zero South Holly Street, Medford, Oregon. ZIP code nine seven five zero one: observed_in_docs=107
- one one zero nine June Street, Hood River, Oregon. ZIP code nine seven zero three one: observed_in_docs=101
- six zero six Medical Parkway, Enterprise, Oregon. ZIP code nine seven eight two eight: observed_in_docs=100
- one zero five zero South West seventh Avenue, Albany, Oregon. ZIP code nine seven three two one: observed_in_docs=96
- five two eight East Main Street Suite E John Day, Oregon. ZIP code nine seven eight four five: observed_in_docs=88
- five zero zero Summer Street North East, Salem, Oregon. ZIP code nine seven three zero one: observed_in_docs=86
- eight zero zero North East Oregon Street, Portland, Oregon. ZIP code nine seven two three two: observed_in_docs=83
- one five one West seventh Avenue, Eugene, Oregon. ZIP code nine seven four zero one: observed_in_docs=83
- nine six five Tucker Road, Hood River, Oregon. ZIP code nine seven zero three one: observed_in_docs=82
- seven zero two Sunset Drive, Ontario, Oregon. ZIP code nine seven nine one four: observed_in_docs=80
- five zero zero North East A Street Suite 102, Madras, Oregon. ZIP code nine seven seven four one: observed_in_docs=79
- one one three two South West thirteenth Avenue, Portland, Oregon. ZIP code nine seven two zero five: observed_in_docs=79
- six two zero North East second Street, Gresham, Oregon. ZIP code nine seven zero three zero: observed_in_docs=79
- one nine five West twelfth Avenue, Eugene, Oregon. ZIP code nine seven four zero one: observed_in_docs=76
