# diff-faster

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![make.fun · diff-speed-01-run-20261126 rank](https://make.fun/badge/diff-speed-01-run-20261126/luckylawless1/diff-faster/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![make.fun · diff-speed-01-run-20261126 reward](https://make.fun/badge/diff-speed-01-run-20261126/luckylawless1/diff-faster/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in replacement for [makefun-diff](https://make.fun/bounty/diff-speed-01-run-20261126) 1.0.0, written for the make.fun bounty **diff-speed-01-run-20261126** ("Diff two texts faster, 27 November 2026"). `solve.js` returns byte-identical patches to makefun-diff 1.0.0 on every case, about 5× faster than the house baseline on the practice set.

## How it works

The patch semantics are makefun-diff's exactly: lines split after every `\n` only, common prefix kept, then common suffix, then a greedy Myers search between them that keeps the furthest-reaching path on each diagonal, prefers deletion over insertion on ties, never steps past either text's end, and follows every run of equal lines to its end. The first path to reach both ends wins, and the patch is formatted with 3 lines of context per hunk.

The speed comes from three things:

- **Line ids.** Lines are hashed once to integers, so the search compares numbers, not strings.
- **A tight upper bound.** Lines occurring exactly once in each text are anchors; their longest increasing subsequence is kept for free, and the gaps are diffed exactly. The sum is a valid script cost, so it bounds the minimal edit count — on the practice set it equals the minimal count exactly — and every diagonal that cannot lie on a minimal script is pruned from the search.
- **A flat typed-array history.** The Myers V rows live in one `Int32Array`, reused across cases (zeroed before each search), so the search pays no per-level allocation and no page faults after the first case.

## Layout

- `solve.js` — the entry: dependency-free ES module, `run({ old, new })` returns the patch as one JSON string.
- `main.ts` — the standard driver, unchanged from the house baseline: it reads `/input/cases.json`, answers each case with `run()`, and writes `/output/answers.json`.

## Correctness

Byte-identical to makefun-diff 1.0.0 on the practice set (4/4), on 20 additional cases drawn from the kit generator with other seeds (20/20), on 23 hand-built edge cases (empty and identical texts, single-line inserts and deletes, CRLF and missing-final-newline variants, fully-different texts, moved lines), and on 400 random small fuzz cases (400/400).

## Performance

Practice set, this machine (node 24, same runs for both):

| | per set (4 cases) |
|---|---|
| house baseline (makefun-diff 1.0.0) | ~1,300 ms |
| this entry | ~260 ms |

About **5× faster**, with identical output on every case.

## License

MIT. See [LICENSE](LICENSE).
