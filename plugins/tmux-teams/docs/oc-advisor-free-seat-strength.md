# oc-advisor free-seat strength ladder — preliminary comparison

Purpose: record the RATIONALE for the rung order of the `oc-advisor` free-seat
ladder. The order was decided by Master 2026-11-18 (`contract.md` in the ladder
run directory). This document is a citation, not the executable truth: the
ladder order lives in `review-policy.mjs` (`UNAVAILABLE_RESERVE_SUBSTITUTES`)
and in `oc-advisor/SKILL.md`. Re-measure before trusting a rung boundary.

## Ranked seats

Each rung is the `opencode` free seat named by the config value
`opencode/<model id>` (also the `ACP_MODEL` / `ACP_EXPECT_MODEL` value).
`AA` is the Artificial Analysis Intelligence Index v5.0.1. All benchmark
numbers below are PUBLISHER-REPORTED. `n/a` means not retrieved or not
published; params are shown total/active.

| # | model id (config value) | vendor | params (total/active) | AA v5.0.1 | key benchmarks (publisher-reported) | placement confidence |
|---|---|---|---|---|---|---|
| 1 (DEFAULT) | `opencode/deepseek-v4.1-flash-free` | DeepSeek (`deepseek-ai`) | n/a / n/a | 33 | DeepSWE 74.2; TB2.1 90.6; GPQA-D 90.9 | high |
| 2 | `opencode/inkling-2-small-free` | Thinking Machines (`thinkingmachines`) | n/a / n/a | 31 | DeepSWE 72.1; SWE-Pro v2 86.3; GPQA-D 88.6 | high |
| 3 | `opencode/glm-5.3-flash-free` | Z.ai / Zhipu (`zai-org`) | n/a / n/a | 28 | SWE-Ver 79.1; GPQA-D 91.2; TB2.1 82.7 | high |
| 4 | `opencode/mimo-v2.6-flash-free` | Xiaomi (`XiaomiMiMo`) | n/a / n/a | 27 | DeepSWE 67.9; TB2.1 87.6 | high |
| 5 | `opencode/hy4-flash-free` | Tencent (`hy.tencent.ai`) | n/a / n/a | n/a | DeepSWE 64.6; MMMU-Pro 75.8 | medium |
| 6 | `opencode/longcat-2.5-free` | Meituan (`meituan-longcat`) | n/a / n/a | n/a | TB2.1 88.4; TB4.0 38.5; DeepSWE 64.6 | medium |
| 7 | `opencode/flint-40b-free` | RecursiveSI | 40B / n/a | n/a | SWE-Pro v2 89.7; SWE-Ver 74.2; TB2.1 54.9 | medium |
| 8 | `opencode/beam-free` | Reflection (`reflection`) | 501B / 23B | 18 | SWE-Ver 81.6; TB2.1 80.1; DeepSWE 43.3 | high |
| 9 | `opencode/nemotron-3.5-super-vl-free` | NVIDIA | 120B / 12B | 14 | SWE-Ver 71.1; GPQA-D 89.5; TB2.1 60.7 | high |
| 10 | `opencode/nemotron-3.5-lightning-free` | NVIDIA | 30B / 3B | 6 | SWE-Ver 51.6; TB2.1 24.6 | high — weakest |

Params for rungs 7-10 are taken from the model-card identifiers
(`Beam-1.0-501B-A23B`, `NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`,
`NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16`, `flint-40b`); the remaining
cards were not retrieved with a stated total/active split, so those cells are
`n/a` rather than guessed. Rungs 5-7 have no AA score, hence medium placement
confidence: their order rests on sparse, non-comparable publisher benchmarks.

## Excluded seats

- `opencode/iceman-free` — no public benchmarks and no public specification;
  unrankable. Excluded 2026-11-18.
- `opencode/big-pickle` — rotating stealth backend; no current verified
  benchmark. Its identity can change between probes, so any score would be
  unstable. Excluded 2026-11-18.
- `opencode/minimax-m3.1-flash-free` — retired upstream; verified MISSING from
  the `opencode acp` 1.18.21 catalog 2026-11-18. It can no longer be seated at
  all, so it is out of the ladder regardless of strength. Was the default seat
  until 2026-11-16; replaced by DeepSeek 2026-11-18.
- Paid providers (`zai-coding-plan`, `cerebras`, `openai`, `google`) — cut by
  Master 2026-11-18. No paid seat is permitted as a fallback: the ladder ends
  in block-and-ask-Master, not a paid upgrade.
- `opencodeDeepseek` profile — REMOVED (absorbed into the default `opencode`
  profile). Not a distinct rung.

## Evidence rules

All numbers are PUBLISHER-REPORTED. Harnesses, prompts, and scoring differ
between publishers, so cross-model comparison is approximate; a higher score
on one benchmark is not evidence of a higher rung. AA v5.0.1 is the only common
index and covers 7 of 12 candidate seats; the other five have no common
denominator. Retrieval date for every source below: 2026-11-18. Probe evidence:
all ten rung ids were advertised in `configOptions` AND accepted by
`session/set_config_option` (ACK each) on `opencode acp` 1.18.21, 2026-11-18.
Live probe update (2026-11-19 on `@opencode/cli@2.3.2`, `opencode acp` v2.3.2
`initialize` + `session/new`, zero prompt quota spent): OpenCode v2.3.2 advertised
11 `opencode/*` free models (`beam-free`, `big-pickle`, `deepseek-v4.1-flash-free`,
`flint-40b-free`, `hy4-flash-free`, `iceman-free`, `inkling-2-small-free`,
`longcat-2.5-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`,
`nemotron-3.5-super-vl-free`), while `glm-5.3-flash-free` was absent from the
v2.3.2 catalog. `opencodeGlm` stays in `UNAVAILABLE_RESERVE_SUBSTITUTES` for
catalog compatibility, while opt-in `REVIEW_GATE_MODE=opencode-free` defaults to
`deepseek-v4.1-flash-free`, `inkling-2-small-free`, and `mimo-v2.6-flash-free`.
This ranking is PRELIMINARY — re-measure before trusting a rung boundary,
especially between adjacent AA scores (33/31, 28/27) and among the three
unscored middle rungs.

## Sources (URL + date)

HF model cards:

- `https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash` — 2026-10-16
- `https://huggingface.co/zai-org/GLM-5.3-Flash` — 2026-10-15
- `https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL` — 2026-10-28
- `https://huggingface.co/meituan-longcat/LongCat-2.5` — 2026-11-10
- `https://huggingface.co/RecursiveSI/flint` — 2026-10-21
- `https://huggingface.co/reflection/Beam-1.0-501B-A23B` — 2026-11-03
- `https://huggingface.co/thinkingmachines/Inkling-2-Small` — 2026-11-17
- `https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16` — 2026-08-24
- `https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16` — 2026-10-22

Other:

- `https://hy.tencent.ai/research/hy4-flash` — 2026-11-16
- `https://artificialanalysis.ai/leaderboards/models` — retrieved 2026-11-18
- `https://models.dev/api.json` — retrieved 2026-11-18
- `https://opencode.ai/docs/console/models` — retrieved 2026-11-18

## Ladder order (prose)

`deepseek -> inkling -> glm -> mimo -> hy4 -> longcat -> flint -> beam -> nemotron-super-vl -> nemotron-lightning`

The gate walks this ladder: each failed seat is replaced by its next rung,
repeatedly, until a rung answers or the ladder is exhausted; only then does it
block and ask Master. `planFallback` accumulates `failedSeats` on the plan so a
failed seat is never retried, and every seat used is labelled in the
report/receipt. The order is not a preference list to be skipped: it IS the
strength ranking recorded above.
