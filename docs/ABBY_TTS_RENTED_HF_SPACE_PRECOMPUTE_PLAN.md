# Abby TTS Rented HF Space Precompute Plan

## Objective

Precompute Abby TTS assets in this order so runtime playback hits the highest-reuse surfaces first:

1. BM25 vocabulary words
2. Individual pieces of slotted responses
3. Remaining duplicated full responses
4. Non-duplicative voice responses

This ordering maximizes latency savings before spending GPU time on long-tail utterances.

## Non-Negotiable Premise

The rented Hugging Face Space must either host IndexTTS itself or point `WALLET_INDEXTTS_SPACE_URL` at a private or dedicated IndexTTS deployment. Renting a controller Space that still calls `https://indexteam-indextts-2-demo.hf.space` will keep the current ZeroGPU quota and throughput bottleneck.

## Current Inventory And Run State

| Surface | Source | Count | Current state |
| --- | --- | ---: | --- |
| BM25 reusable words | `docs/pregenerated_text_audio_bm25_manifest.json` | 11608 | Paused at offset 288 in `docs/pregenerated_text_audio_bm25_batch_state.json` because the public demo hit ZeroGPU quota |
| Reusable shell segments | `docs/pregenerated_text_audio_shell_manifest.json` | 30 | Complete in `docs/pregenerated_text_audio_shell_batch_state.json` |
| Reusable slot values | `docs/pregenerated_text_audio_slot_value_manifest.json` | 321 | Split across `number`, `entity`, `address_part`, `location`, `phone`, and `zip`; all current batch states are complete |
| Unified pregenerated responses | `docs/pregenerated_text_response_manifest.json` | 13809 | Source of truth for full-response phases |
| Slotting opportunities | `docs/pregenerated_text_rewrite_opportunities.json` | 98 families | Estimated 5895 saved chunk calls if composed instead of synthesized as whole responses |
| Full-response source refs | `docs/pregenerated_text_chunk_dedupe.json` | 16368 refs over 13802 unique full responses | Phase-3 and phase-4 manifests are now derived in `docs/pregenerated_text_audio_duplicate_response_manifest.json` and `docs/pregenerated_text_audio_residual_response_manifest.json` |

Key derived facts from the current docs:

- BM25 is by far the largest reusable surface and should resume first.
- Shell and slot-value manifests are already complete for the current voice pass; rerun them only if the rented Space changes the voice reference or normalization contract.
- Phases 3 and 4 now have dedicated checked-in response manifests plus a derivation report, and can be regenerated with `python3 scripts/build_pregenerated_audio_response_phase_manifests.py`.
- A single orchestration entrypoint now exists at `python3 scripts/run_abby_tts_precompute_pipeline.py` for phase sequencing.

## Phase 0: Freeze Inputs And Verify The Dedicated Space

If the underlying response corpus changed, regenerate the inventories before starting the rented pass:

```bash
python3 scripts/build_pregenerated_text_response_manifest.py
python3 scripts/build_pregenerated_audio_asset_manifests.py
python3 scripts/build_pregenerated_audio_vocabulary_manifest.py
```

Set the runtime environment on the rented Space or runner shell:

```bash
export WALLET_INDEXTTS_SPACE_URL="https://<your-dedicated-space>.hf.space"
export WALLET_INDEXTTS_HF_TOKEN="$HF_TOKEN"
export WALLET_INDEXTTS_HF_BILL_TO="publicus"
export WALLET_INDEXTTS_TIMEOUT_SECONDS="900"
export WALLET_INDEXTTS_TRANSCRIPTION_DEVICE="cuda"
```

Probe the live contract before any long run:

```bash
python3 scripts/precompute_indextts_responses.py --print-indextts-contract
```

Use the contract probe to choose one of two throughput modes:

- If the dedicated Space exposes a working `gen_batch`, keep `WALLET_INDEXTTS_BATCH_ENABLED=1`, start with `WALLET_INDEXTTS_REMOTE_BATCH_SIZE=16`, and grow to `32` only after a few stable batches.
- If the dedicated Space still exposes only `gen_single`, set `WALLET_INDEXTTS_BATCH_ENABLED=0`, keep `WALLET_INDEXTTS_REMOTE_BATCH_SIZE=1`, and increase `WALLET_INDEXTTS_PARALLEL_WORKERS` gradually from `4` upward until latency, VRAM, or queue stability stops improving.

Resume versus restart rule:

- Resume existing batch state if the voice reference, spoken-text normalization, and target Space contract are unchanged.
- Restart the phase from offset `0` with `--force` if the rented Space changes the voice, text normalization, or audio post-processing assumptions.

Default orchestration dry-run:

```bash
python3 scripts/run_abby_tts_precompute_pipeline.py --dry-run
```

GPU-ready full preprocessing wrapper:

```bash
python3 scripts/run_abby_tts_full_preprocessing.py \
  --space-url https://<your-dedicated-space>.hf.space \
  --bucket-root hf://buckets/Publicus/abby-voice/runs \
  --remote-batch-size 8 \
  --batch-retry-attempts 4 \
  --dry-run
```

The wrapper always plans phases 1 through 4, writes a reproducible run spec under `tmp_assets/abby-tts-runs/<run-label>/run-plan.json`, probes the live Space contract first, and then calls `scripts/run_abby_tts_precompute_pipeline.py` with the rented-GPU defaults. Add `--rerender-phase2` if you want to regenerate shell and slot pieces from scratch instead of resuming their current batch states.

## Phase 1: BM25 Vocabulary Words First

### Why First

The BM25 manifest is the largest reusable vocabulary surface and is already normalized for speech. Completing it first gives the biggest immediate reduction in future live synthesis and improves reuse across GraphRAG answers before touching longer utterances.

### Inputs

- Response manifest: `docs/pregenerated_text_audio_bm25_manifest.json`
- Current state: `docs/pregenerated_text_audio_bm25_batch_state.json`
- Current resume point: offset `288`

### Execution

If the voice and contract are unchanged, resume from the recorded offset:

```bash
python3 scripts/run_indextts_batch_generation.py \
  --response-manifest docs/pregenerated_text_audio_bm25_manifest.json \
  --state docs/pregenerated_text_audio_bm25_batch_state.json \
  --batch-manifest-dir docs/pregenerated_text_audio_bm25_batches \
  --progress-dir docs/pregenerated_text_audio_bm25_progress \
  --public-manifest docs/pregenerated_text_audio_bm25_public_manifest.json \
  --output-dir tmp_assets/abby-tts/bm25 \
  --start-offset 288 \
  --batch-size 32 \
  --validate-transcripts \
  --transcript-validation-limit 2 \
  --transcript-validation-device cuda
```

If the dedicated Space supports real remote batching, add a tuned `--remote-batch-size` and keep `--parallel-workers 1`. If it does not, keep `--remote-batch-size 1` and use `--parallel-workers <n>` instead.

### Validation Gate

- Keep inline transcript validation enabled, but validate only a small sample per batch during the long run.
- At the end of each 1000 generated terms, run a larger spot-check sample before continuing.
- Consider the phase complete only when `nextOffset >= totalResponses` in `docs/pregenerated_text_audio_bm25_batch_state.json` and no terminal batch manifest reports `rateLimitDetected` or transcript regressions.

### Publish After Acceptance

Stage and upload the generated audio as a phase snapshot first:

```bash
python3 scripts/upload_hf_abby_tts_dataset.py \
  --repo-id Publicus/211-abby-tts \
  --remote-prefix audio/abby-tts/runs/<timestamp>/phase-1-bm25 \
  --audio-root tmp_assets/abby-tts/bm25 \
  --upload
```

Promote to `audio/abby-tts/current` only after the snapshot passes validation.

## Phase 2: Individual Slotted Pieces

### Why Second

The slotting review shows the biggest reusable chunk savings come from composing phone, number, entity, and location-heavy frames. These pieces should exist before generating more full responses so runtime composition can absorb the repetitive shells and slot values.

### Current State

The current slot-piece pass is effectively complete for the checked-in voice run:

- `docs/pregenerated_text_audio_shell_batch_state.json`: complete for 30 shell segments
- `docs/pregenerated_text_audio_slot_number_batch_state.json`: complete for 87 numbers
- `docs/pregenerated_text_audio_slot_phone_batch_state.json`: complete for 42 phones
- `docs/pregenerated_text_audio_slot_entity_batch_state.json`: complete for 86 entities
- `docs/pregenerated_text_audio_slot_location_batch_state.json`: complete for 44 locations
- `docs/pregenerated_text_audio_slot_address_part_batch_state.json`: complete for 54 address parts
- `docs/pregenerated_text_audio_slot_zip_batch_state.json`: complete for 8 zip values

If the rented Space uses the same voice reference and output contract, treat phase 2 as already done and republish the current artifacts instead of regenerating them.

If the voice contract changes, rerun phase 2 in this order:

1. `docs/pregenerated_text_audio_shell_manifest.json`
2. `docs/pregenerated_text_audio_slot_value_manifests/number.json`
3. `docs/pregenerated_text_audio_slot_value_manifests/phone.json`
4. `docs/pregenerated_text_audio_slot_value_manifests/entity.json`
5. `docs/pregenerated_text_audio_slot_value_manifests/location.json`
6. `docs/pregenerated_text_audio_slot_value_manifests/address-part.json`
7. `docs/pregenerated_text_audio_slot_value_manifests/zip.json`

The first three items are the highest-value subphase because the slotting review ranks phone and numeric frames as the dominant savings surface.

### Execution Template

Use the same runner for each manifest with phase-specific state and output paths. Example for `number.json`:

```bash
python3 scripts/run_indextts_batch_generation.py \
  --response-manifest docs/pregenerated_text_audio_slot_value_manifests/number.json \
  --state docs/pregenerated_text_audio_slot_number_batch_state.json \
  --batch-manifest-dir docs/pregenerated_text_audio_slot_number_batches \
  --progress-dir docs/pregenerated_text_audio_slot_number_progress \
  --public-manifest docs/pregenerated_text_audio_slot_number_public_manifest.json \
  --output-dir tmp_assets/abby-tts/slot-number \
  --batch-size 20 \
  --validate-transcripts \
  --transcript-validation-limit 2 \
  --transcript-validation-device cuda
```

Apply the same pattern to the shell and remaining slot manifests, swapping the manifest, state, batch directory, progress directory, public manifest, and output directory.

### Validation Gate

- Because this phase is small, validate all shell segments and a meaningful sample from every slot kind.
- If a rerun is only to refresh voice consistency, compare a handful of existing runtime hits against the new outputs before publishing.

### Publish After Acceptance

Upload a phase snapshot first, then promote it after composition tests pass:

```bash
python3 scripts/upload_hf_abby_tts_dataset.py \
  --repo-id Publicus/211-abby-tts \
  --remote-prefix audio/abby-tts/runs/<timestamp>/phase-2-slot-pieces \
  --audio-root tmp_assets/abby-tts/slot-number \
  --audio-root tmp_assets/abby-tts/slot-phone \
  --audio-root tmp_assets/abby-tts/slot-entity \
  --audio-root tmp_assets/abby-tts/slot-location \
  --audio-root tmp_assets/abby-tts/slot-address-part \
  --audio-root tmp_assets/abby-tts/slot-zip \
  --audio-root tmp_assets/abby-tts/shell \
  --upload
```

If phase 2 is being reused from the current completed local artifacts instead of rerendered into `tmp_assets`, point `--audio-root` at the existing local precomputed audio roots for those slot assets instead.

## Phase 3: Remaining Duplicated Full Responses

### Why Third

After BM25 and slot pieces are covered, the next best use of GPU time is exact repeated full responses that still are not worth composing from slots. This captures repeated whole utterances while the long tail is still deferred.

### Derivation Command

The post-slot duplicate full-response bucket is now generated by:

```bash
python3 scripts/build_pregenerated_audio_response_phase_manifests.py
```

That command writes the checked-in derivation artifacts:

- `docs/pregenerated_text_audio_duplicate_response_manifest.json`
- `docs/pregenerated_text_audio_residual_response_manifest.json`
- `docs/PREGENERATED_TEXT_AUDIO_RESPONSE_PHASES.md`

The current derivation summary is recorded in `docs/PREGENERATED_TEXT_AUDIO_RESPONSE_PHASES.md`.

The subsequent batch run then creates the phase-3 batch state, public manifest, batch manifests, and progress directory under the existing naming pattern.

### Manifest Derivation Rules

Build phase 3 as a filtered subset of the unified response inventory:

1. Start from `docs/pregenerated_text_response_manifest.json`.
2. Exclude any response text that will be composed from phase 2 shell and slot pieces.
3. Keep only exact full responses with repeated canonical source references. The implemented builder currently uses `len(sourceIds) >= 2`.
4. Sort descending by canonical source-ref count, then by any existing response priority metadata.
5. Write the filtered output to `docs/pregenerated_text_audio_duplicate_response_manifest.json`.

The raw inventory already shows `16368` full-response source refs over `13802` unique full responses, so there is enough repeated surface to justify this separate pass.

### Execution

Run the filtered manifest through the same batch runner:

```bash
python3 scripts/run_indextts_batch_generation.py \
  --response-manifest docs/pregenerated_text_audio_duplicate_response_manifest.json \
  --state docs/pregenerated_text_audio_duplicate_response_batch_state.json \
  --batch-manifest-dir docs/pregenerated_text_audio_duplicate_response_batches \
  --progress-dir docs/pregenerated_text_audio_duplicate_response_progress \
  --public-manifest docs/pregenerated_text_audio_duplicate_response_public_manifest.json \
  --output-dir tmp_assets/abby-tts/duplicate-responses \
  --batch-size 32 \
  --validate-transcripts \
  --transcript-validation-limit 2 \
  --transcript-validation-device cuda
```

### Validation Gate

- Verify that the duplicate manifest contains only responses still needed after phase 2 composition.
- Spot-check the highest-reuse responses first, because those are the direct latency-critical wins.

## Phase 4: Non-Duplicative Voice Responses

### Why Last

This is the most expensive surface and the least reusable per generated asset. It should only begin once every higher-reuse surface is finished and published.

### Derivation Command

The residual full-response manifest is created by the same builder:

```bash
python3 scripts/build_pregenerated_audio_response_phase_manifests.py
```

It writes the residual response manifest under the uploader-friendly name:

- `docs/pregenerated_text_audio_residual_response_manifest.json`

The subsequent phase-4 batch run creates:

- `docs/pregenerated_text_audio_residual_response_batch_state.json`
- `docs/pregenerated_text_audio_residual_response_public_manifest.json`
- `docs/pregenerated_text_audio_residual_response_batches/`
- `docs/pregenerated_text_audio_residual_response_progress/`

### Manifest Derivation Rules

Build phase 4 as the remainder of the unified response inventory after subtracting phase 2 and phase 3:

1. Start from `docs/pregenerated_text_response_manifest.json`.
2. Remove every response covered by slot composition.
3. Remove every response included in the phase 3 duplicate-response manifest.
4. The remainder becomes `docs/pregenerated_text_audio_residual_response_manifest.json`.
5. Sort by existing response priority so the highest-value residuals render first if the run is interrupted.

### Execution

```bash
python3 scripts/run_indextts_batch_generation.py \
  --response-manifest docs/pregenerated_text_audio_residual_response_manifest.json \
  --state docs/pregenerated_text_audio_residual_response_batch_state.json \
  --batch-manifest-dir docs/pregenerated_text_audio_residual_response_batches \
  --progress-dir docs/pregenerated_text_audio_residual_response_progress \
  --public-manifest docs/pregenerated_text_audio_residual_response_public_manifest.json \
  --output-dir tmp_assets/abby-tts/residual-responses \
  --batch-size 32 \
  --validate-transcripts \
  --transcript-validation-limit 2 \
  --transcript-validation-device cuda
```

### Validation Gate

- Use larger spot-checks at the end of each major offset interval because this phase is the least repetitive and most likely to hide edge normalization issues.
- Accept the phase only when the residual batch state reaches completion and the uploaded runtime manifest reflects the increased `responseCount`.

## Publishing And Dataset Strategy

Keep git as the source of manifests and provenance, not binary audio. Store generated audio in the Hugging Face dataset.

Recommended publish flow for every phase:

1. Generate to a local ignored directory under `tmp_assets/abby-tts/<phase>`.
2. Upload a snapshot to `audio/abby-tts/runs/<timestamp>/<phase>`.
3. Validate that snapshot.
4. Promote the accepted set to `audio/abby-tts/current`.
5. Refresh the runtime manifest consumed by the UI.

The current uploader already writes:

- `metadata/abby_tts_runtime_manifest.json`
- `metadata/abby_tts_query_index.json`
- provenance copies of the local manifests and batch states

That means each phase snapshot is auditable and can be rolled back without reintroducing binaries into git.

## Validation Policy For Speed

Use validation aggressively on small phases and sampling on large ones:

- Phase 1 BM25: sample during generation, then do a larger spot-check per major offset interval.
- Phase 2 slot pieces: validate every shell and a meaningful sample from each slot kind.
- Phase 3 duplicates: validate the highest-reuse responses first.
- Phase 4 residuals: use stratified spot-checks by route or response family.

Keep `--transcript-validation-device cuda` on the rented Space so validation does not become a CPU bottleneck.

## Definition Of Done

The rented HF Space pass is complete when all of the following are true:

1. `docs/pregenerated_text_audio_bm25_batch_state.json` reports completion.
2. Phase 2 slot-piece assets are either reused from the current completed states or rerendered and republished for the final voice contract.
3. `docs/pregenerated_text_audio_duplicate_response_manifest.json` and its batch state complete successfully.
4. `docs/pregenerated_text_audio_residual_response_manifest.json` and its batch state complete successfully.
5. The accepted outputs are promoted to `Publicus/211-abby-tts` under `audio/abby-tts/current`.
6. The published runtime manifest reflects the new response count and audio URLs.
7. No remaining run is blocked on the public ZeroGPU window because generation is now pointed at the dedicated Space.

## Recommended Next Step

Before renting compute, rerun `python3 scripts/build_pregenerated_audio_response_phase_manifests.py` after any response-inventory or slot-plan change so phases 3 and 4 stay aligned with the latest canonical response manifest.