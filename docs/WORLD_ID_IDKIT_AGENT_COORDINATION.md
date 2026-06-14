# World ID IDKit – Parallel-Agent Coordination Notes

This document tells implementation agents which WORLDID tasks may be assigned
concurrently, how to update task status without races, which output files must
not be edited by two agents at once, and which validation commands each lane
must pass before a task is marked complete.

---

## 1. Dependency Graph and Concurrent Execution Waves

Tasks are grouped into waves. All tasks in the same wave may be assigned to
separate agents at the same time **subject to the file-conflict rules in
section 3**. A task must not begin until every task it lists in `Depends on:`
is `completed`.

### Wave 0 – Foundation (already completed)
| Task | Track | Key Outputs |
|------|-------|-------------|
| WORLDID-000 | ops | plan, todo file |
| WORLDID-010 | ops | `wallet_interface/world_id.py` |
| WORLDID-020 | proofs | `world_id.py` (RP sig) |
| WORLDID-030 | proofs | `world_id.py` (portal client) |
| WORLDID-040 | proofs | `world_id.py` (normalisation) |
| WORLDID-050 | core | wallet models |
| WORLDID-060 | privacy | nullifier policy |
| WORLDID-070 | proofs | proof receipt |
| WORLDID-080 | wallet | `app_service.py` |

### Wave 1 – First parallel group (all wave-0 tasks complete)
These three tasks may run concurrently; their output files do not overlap.

| Task | Track | Outputs (abbreviated) |
|------|-------|-----------------------|
| WORLDID-090 | wallet | `wallet_interface/api.py`, `tests/test_world_id_wallet_api.py` |
| WORLDID-100 | ops | `wallet_interface/deploy/*` |
| WORLDID-260 | ops | `docs/WORLD_ID_IDKIT_AGENT_COORDINATION.md` |

### Wave 2 – After WORLDID-090 and WORLDID-100 (independently)
WORLDID-110 unblocks when WORLDID-090 completes; WORLDID-120 unblocks when
WORLDID-100 completes. They may overlap each other because their output files
are disjoint.

| Task | Unblocked by | Track | Outputs |
|------|--------------|-------|---------|
| WORLDID-110 | WORLDID-090 | ui | `ui/src/services/walletApi.ts`, `ui/tests/agent-unit.spec.ts` |
| WORLDID-120 | WORLDID-100 | ui | `ui/package.json`, `ui/src/lib/runtimeConfig.ts`, `ui/src/vite-env.d.ts` |

### Wave 3 – After WORLDID-110 and WORLDID-120
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-130 | ui | `ui/src/components/world-id/WorldIdVerificationPanel.tsx`, `ui/src/app/App.tsx`, `ui/src/styles/global.css` |

### Wave 4 – After WORLDID-130 ⚠ file conflicts – must serialize
WORLDID-140 and WORLDID-150 are both unblocked by WORLDID-130 but share
`App.tsx`, `global.css`, and `smoke.spec.ts`. **Assign them to separate agents
only after verifying there is no active worktree for the other task.** The
safest strategy is to complete WORLDID-140 first, then WORLDID-150.

| Task | Track | Conflicting Outputs |
|------|-------|---------------------|
| WORLDID-140 | ui | `App.tsx`, `global.css`, `ui/tests/smoke.spec.ts` |
| WORLDID-150 | ui | `App.tsx`, `global.css`, `ui/tests/smoke.spec.ts` |

### Wave 5 – After WORLDID-140 (and WORLDID-150 for WORLDID-180) ⚠ partial conflict
WORLDID-160 and WORLDID-180 may overlap in time if WORLDID-150 finishes
before WORLDID-160 does, but they both write
`ui/tests/fullstack-wallet.spec.ts`. **Do not start WORLDID-180 until
WORLDID-160 is marked `completed`.**

| Task | Unblocked by | Track | Outputs |
|------|--------------|-------|---------|
| WORLDID-160 | WORLDID-070 ✓, WORLDID-140 | privacy | `walletProofReview.ts`, `wallet/service.py`, `fullstack-wallet.spec.ts` |
| WORLDID-180 | WORLDID-140, WORLDID-150 | quality | `world-id.spec.ts`, `smoke.spec.ts`, `fullstack-wallet.spec.ts` |

Recommended order: complete WORLDID-160 → then WORLDID-180.

### Wave 6 – After WORLDID-090 and WORLDID-160
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-170 | quality | `tests/test_world_id_wallet_api.py`, `tests/test_wallet_interface_api.py` |

### Wave 6b – After WORLDID-150 and WORLDID-170
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-181 | ui | `docs/WORLD_ID_IDKIT_UI_WORKFLOW_MATRIX.md`, `ui/tests/fixtures/world-id-fixtures.ts` |

### Wave 6c – After WORLDID-170, WORLDID-180, and WORLDID-181
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-182 | ui | `ui/tests/world-id-fullstack.spec.ts`, `ui/tests/fixtures/world-id-fixtures.ts` |

### Wave 7 – After WORLDID-090, WORLDID-170, and WORLDID-182
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-190 | ops | `wallet_interface/ops.py`, `tests/test_wallet_interface_ops.py`, `docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md` |

### Wave 7b – After WORLDID-150 and WORLDID-180
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-210 | ui | `App.tsx`, `smoke.spec.ts`, `fullstack-wallet.spec.ts` |

WORLDID-210 may run while WORLDID-181 or WORLDID-182 is active because its
listed files do not overlap with the new workflow fixture and full-stack spec
files. It must finish before WORLDID-183.

### Wave 7c – After WORLDID-182 and WORLDID-210
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-183 | ui | `world-id-ux.spec.ts`, `wallet-ux-review.spec.ts`, `artifacts/world-id-idkit-ui-review` |

### Wave 8 – After WORLDID-182 and WORLDID-190
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-200 | ops | `docs/WORLD_ID_IDKIT_STAGING_RUNBOOK.md`, `docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md` |

### Wave 9 – After WORLDID-200 ⚠ file conflicts – must serialize
WORLDID-230 and WORLDID-240 both write
`docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md` and
`docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md`. **Do not run them concurrently.**

| Task | Track | Conflicting Outputs |
|------|-------|---------------------|
| WORLDID-230 | privacy | implementation plan, signoff doc |
| WORLDID-240 | privacy | implementation plan, signoff doc |

### Wave 9b – After WORLDID-183, WORLDID-190, WORLDID-200, and WORLDID-210
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-250 | ops | `WALLET_TARGET_PRODUCTION_SIGNOFF.md`, `*.template.json`, `artifacts/` |

### After WORLDID-210
| Task | Track | Outputs |
|------|-------|---------|
| WORLDID-220 | ui | `App.tsx`, `api.py`, `test_world_id_wallet_api.py`, `smoke.spec.ts` |

---

## 2. How Agents Must Update Task Status

The daemon reads and writes state through the following files (relative to the
repository root):

```
data/world_id_implementation/state/worldid_task_state.json
data/world_id_implementation/state/worldid_strategy.json
data/world_id_implementation/state/worldid_events.jsonl
```

**Status lifecycle:**

```
todo → in_progress → completed
                   ↘ blocked
```

Agents must follow this protocol:

1. **Claim a task** – Before touching any file listed in `Outputs:`, confirm
   the task is `todo` in the state file and that no other worktree has already
   claimed it (check `active_worktree_path` in the state JSON). The daemon
   transitions the task to `in_progress` when it assigns a worktree.

2. **Work in an isolated worktree** – The daemon creates a git worktree for
   each task. Never edit output files of another task's worktree while that
   worktree is active.

3. **Pass validation before marking complete** – Run every command listed in
   the task's `Validation:` field (see section 4). Only after all commands
   exit 0 should the agent signal success to the daemon.

4. **Write evidence** – Tasks with `Completion: evidence` require at least one
   artifact (document or test output) committed inside the worktree before
   the daemon can merge.

5. **Report blockers immediately** – If validation cannot pass due to a
   missing upstream artifact, set status to `blocked` and record the
   dependency in `worldid_events.jsonl`.

---

## 3. Shared Output Files and How to Avoid Overlapping Edits

The table below lists files written by more than one task. Agents assigned to
tasks that share a file must be **serialized** (complete the lower-numbered
task first).

| Shared File | Tasks | Safe Order |
|-------------|-------|------------|
| `wallet_interface/ui/src/app/App.tsx` | 130, 140, 150, 210, 220 | serial 130 → 140 → 150 → 210 → 220 |
| `wallet_interface/ui/src/styles/global.css` | 130, 140, 150 | serial 130 → 140 → 150 |
| `wallet_interface/ui/tests/smoke.spec.ts` | 140, 150, 180, 210, 220 | serial per wave order |
| `wallet_interface/ui/tests/fullstack-wallet.spec.ts` | 160, 180, 210 | complete 160 before 180; 210 after both |
| `wallet_interface/ui/tests/fixtures/world-id-fixtures.ts` | 181, 182 | complete 181 before 182 |
| `tests/test_world_id_wallet_api.py` | 90, 160, 170, 220 | serial per dependency order |
| `docs/WALLET_TARGET_PRODUCTION_SIGNOFF.md` | 190, 200, 230, 240, 250 | serial per dependency order |
| `docs/WORLD_ID_IDKIT_WALLET_IMPLEMENTATION_PLAN.md` | 230, 240 | complete 230 before 240 (or 240 before 230) |
| `ipfs_datasets_py/ipfs_datasets_py/wallet/service.py` | 60, 70, 160 | serial per dependency order (already enforced by deps) |

**Enforcement rule:** before an agent begins editing any file in this list, it
must confirm that all other tasks that share the file are either `todo` (not
yet started) or `completed` (already merged). If another task sharing the file
is `in_progress`, the agent must wait.

---

## 4. Validation Commands Each Lane Must Run

Run these commands from the repository root in the isolated worktree before
signalling task completion.

### ops track
```bash
# WORLDID-000, WORLDID-200, WORLDID-230, WORLDID-240, WORLDID-260
python scripts/wallet_implementation_daemon.py \
  --once --no-implement \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid

# WORLDID-100
python wallet_interface/deploy/smoke_local_mock_stack.py --help
pytest tests/test_world_id_wallet_api.py -q

# WORLDID-190
pytest tests/test_wallet_interface_ops.py tests/test_world_id_wallet_api.py -q
python -m wallet_interface.ops --validate-production-readiness

# WORLDID-250
python -m wallet_interface.ops --validate-production-readiness
python -m wallet_interface.ops --validate-target-signoff-packet
```

### proofs track
```bash
# WORLDID-020, WORLDID-030, WORLDID-040
pytest tests/test_world_id_wallet.py -q
```

### core track
```bash
# WORLDID-050
pytest ipfs_datasets_py/tests/unit/test_data_wallet.py -q
```

### privacy track
```bash
# WORLDID-060, WORLDID-070
pytest ipfs_datasets_py/tests/unit/test_data_wallet.py -q

# WORLDID-160
pytest tests/test_world_id_wallet_api.py -q
npm --prefix wallet_interface/ui test -- tests/fullstack-wallet.spec.ts

# WORLDID-230, WORLDID-240
python scripts/wallet_implementation_daemon.py \
  --once --no-implement \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid
```

### wallet track
```bash
# WORLDID-080
pytest tests/test_world_id_wallet_api.py -q

# WORLDID-090
pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q
```

### ui track
```bash
# WORLDID-110
npm --prefix wallet_interface/ui run build

# WORLDID-120
npm --prefix wallet_interface/ui ci
npm --prefix wallet_interface/ui run build

# WORLDID-130
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/agent-unit.spec.ts

# WORLDID-140, WORLDID-150
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts

# WORLDID-180
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/world-id.spec.ts
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts

# WORLDID-181
python scripts/wallet_implementation_daemon.py --once --no-implement --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md --task-prefix "## WORLDID-" --state-dir data/world_id_implementation/state --state-prefix worldid
npm --prefix wallet_interface/ui run build

# WORLDID-182
pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/world-id-fullstack.spec.ts

# WORLDID-183
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/world-id-ux.spec.ts
npm --prefix wallet_interface/ui test -- tests/wallet-ux-review.spec.ts

# WORLDID-210
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
npm --prefix wallet_interface/ui test -- tests/fullstack-wallet.spec.ts

# WORLDID-220
pytest tests/test_world_id_wallet_api.py -q
npm --prefix wallet_interface/ui run build
npm --prefix wallet_interface/ui test -- tests/smoke.spec.ts
```

### quality track
```bash
# WORLDID-170
pytest tests/test_world_id_wallet_api.py tests/test_wallet_interface_api.py -q

# WORLDID-180 (see ui track above)
```

---

## 5. Quick-Reference: Which Tasks May Run Concurrently

```
Wave 1:   090 ║ 100 ║ 260            (no file conflicts)
Wave 2:   110 ║ 120                  (no file conflicts)
Wave 3:   130                        (single task)
Wave 4:   140 → 150                  (⚠ serialize – shared files)
Wave 5:   160 → 180                  (⚠ serialize – shared fullstack-wallet.spec.ts)
Wave 6:   170                        (single task)
Wave 6b:  181                        (workflow matrix and fixtures)
Wave 6c:  182                        (full-stack World ID Playwright)
Wave 7:   190 ║ 210                  (no file conflicts)
Wave 7c:  183                        (after 182 and 210)
Wave 8:   200                        (single task)
Wave 9:   230 → 240                  (⚠ serialize – shared docs)
          250                        (single task)
After:    220                        (single task)
```

Notation: `A ║ B` = concurrent; `A → B` = must serialize (A first).

---

## 6. Supervisor and Daemon Invocation

To run the daemon in observation-only mode (no implementation, just state
inspection):

```bash
python scripts/wallet_implementation_daemon.py \
  --once --no-implement \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid
```

To run the supervisor (manages multiple daemon instances):

```bash
python scripts/wallet_implementation_supervisor.py \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid \
  --no-implement
```

To restrict a daemon instance to a single track (e.g. `ui`):

```bash
python scripts/wallet_implementation_daemon.py \
  --once --implement \
  --allowed-tracks ui \
  --todo-path docs/WORLD_ID_IDKIT_WALLET_TODO.md \
  --task-prefix "## WORLDID-" \
  --state-dir data/world_id_implementation/state \
  --state-prefix worldid
```

Running one daemon per track is the recommended way to parallelize work while
keeping each daemon's file-edit scope narrow and conflict-free (subject to the
file-conflict table in section 3).
