# Pregenerated Text Response Inventory

Generated at: 2026-06-14T00:50:38Z
Unified manifest: docs/pregenerated_text_response_manifest.json

## Findings

- Unified pregenerated text responses: 13809
- Legacy-only responses retained from historical manifests: 7
- Responses referenced by a served public manifest: 0
- Responses with historical audio artifacts or URLs recorded: 65
- Public 211 audio directory MP3 files present: 0

## Canonical Source Families

| Family | Canonical responses | DAG | Results |
| --- | ---: | --- | --- |
| 211 chat simulation | 142 | docs/211_conversation_dag.json | docs/211_chatbot_simulation_results.json |
| Phone dialog generation | 13660 | docs/phone_dialog_generation/phone_dialog_dag.json | docs/phone_dialog_generation/phone_dialog_results.json |

## Legacy Manifest Coverage

| Family | Role | Responses | Unique text | Served public | Status counts | Path |
| --- | --- | ---: | ---: | --- | --- | --- |
| 211 | legacy_manifest | 142 | 142 | no | planned:142 | docs/211_indextts_precompute_manifest.json |
| 211 | historical_batch_manifest | 32 | 32 | no | generated_mp3:32 | docs/211_indextts_precompute_batches/batch-00000-offset-000000.json |
| 211 | historical_batch_manifest | 32 | 32 | no | generated_mp3:32 | docs/211_indextts_precompute_batches/batch-00001-offset-000032.json |
| 211 | historical_batch_manifest | 32 | 32 | no | failed:31, generated_mp3:1 | docs/211_indextts_precompute_batches/batch-00002-offset-000064.json |
| 211 | historical_batch_manifest | 32 | 32 | no | failed:32 | docs/211_indextts_precompute_batches/batch-00003-offset-000096.json |
| 211 | historical_batch_manifest | 14 | 14 | no | failed:14 | docs/211_indextts_precompute_batches/batch-00004-offset-000128.json |
| phone_dialog | legacy_manifest | 13660 | 13660 | no | planned:13660 | docs/phone_dialog_generation/phone_dialog_indextts_manifest.json |
| phone_dialog | legacy_manifest | 13660 | 13660 | no | planned:13660 | docs/phone_dialog_generation/phone_dialog_indextts_public_manifest.json |

## Next Command

Use the unified manifest directly for future dry runs or batch generation:

`python3 scripts/precompute_indextts_responses.py --response-manifest docs/pregenerated_text_response_manifest.json --dry-run --limit 10`
