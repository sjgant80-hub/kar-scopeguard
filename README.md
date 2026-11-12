# ScopeGuard

**Live: https://sjgant80-hub.github.io/kar-scopeguard/**

Your AI coding agent says the tests pass. ScopeGuard checks how it got there. It reads the change (a unified diff) and flags every test that was skipped, focused, loosened, commented out, made always-true or deleted, every tolerance widened and coverage floor lowered, every CI step told to ignore failures or removed, and every file outside what the task allowed. Every finding names its rule, its file and line, and the exact text. It runs in your browser, on the command line, in GitHub Actions and as a Claude Code Stop hook, with the same answer and the same SHA-256 fingerprints everywhere. No AI judge, no network, no dependencies.

Built by Kar for AI Native Solutions. MIT. Powered by the Konomi architecture, created by Thomas Frumkin.

## Run it

- **In the browser:** open the live page, pick an example or paste `git diff` output. Nothing is uploaded; the page's Content-Security-Policy blocks every connection.
- **Command line** (Node.js 20+, nothing to install):
  - `git diff main...HEAD | node cli.mjs -`
  - `node cli.mjs change.diff --scope .scopeguard --claim summary.txt --json`
  - `node cli.mjs --git` (this folder against its last commit, new files included), `node cli.mjs --git --staged` (a pre-commit hook)
  - Exit codes: `0` clean (and review, unless `--fail-on review`), `2` flagged, `1` the input could not be read or bad options.
- **GitHub Actions:** `uses: sjgant80-hub/kar-scopeguard@<commit>` after `actions/checkout@v4` with `fetch-depth: 0`. The scope is read from the base commit, so a change cannot widen its own scope. See `action.yml`.
- **Claude Code Stop hook:** add `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node /path/to/cli.mjs --hook"}]}]}}` to `.claude/settings.json`. On a high finding the agent is stopped once, shown the lines, and asked to fix the code or explain the change; it is never stopped twice for the same findings.
- **As a library:** `import { audit } from './kernel.mjs'`.

## The scope file

`.scopeguard` in the repository root, one rule per line: `allow <pattern>`, `deny <pattern>`, `tests <pattern>` (more test paths), `gate <pattern>` (more CI/config paths), `#` comments. Patterns: `**` any folders, `*` within one name, `?` one character. Deny wins over allow. Any line it does not understand is refused.

## Proof

- `CLAIMS.md` was committed before any code: what is claimed, how it is measured, what counts as a pass.
- `node --test kernel.test.mjs` (every rule with a positive and a negative example, every parser path and refusal), `node --test cli.test.mjs` (every exit code, `--git` on a real repository, the hook), `node --test checkcase.test.mjs`, `node --test page.test.mjs`.
- The witness v0.6 mutation gate runs on `kernel.mjs`, `cli.mjs` and `checkcase.mjs` in CI on every push. Local receipt: `receipts/witness.json`.
- Measured on our own public repositories' history, split by repository before any rule was written: `data/calibration-tune.json`, `data/calibration-held.json` (read once, after the kernel was frozen), every high finding hand-labelled in `data/labels-*.json`, and planted weakenings in `data/planted.json`. Re-run any record: `git show --format= --no-color --no-ext-diff -M <commit> | node cli.mjs - --json`.
- The Action runs on this repository on every push.

## Versions

- **v1 (9e580e8), the sealed result.** The kernel was frozen and committed, then the held-out half was read once: high false alarms on 2 of 330 held-out commits (0.61%), against a sealed target of at most 2%: met. Planted weakenings: 2,819 of 2,857 caught; the target was every plant for every rule, so three rules FAILED: test-run-removed (32 of 63), matcher-loosened (89 of 95), assert-neutered (110 of 111). The record is kept as it was, in `data/v1/`.
- **v1.1, the fixes.** Each v1 miss was read, and three were real blind spots: a CI step counted as still testing when any command of the same runner stayed (dropping one gated file from a list went unseen); a check counted as "still exact" when any exact check on the same value was added (a generic value like `r.why` hid a loosened one); a replaced assertion was judged across the whole file (an identical line elsewhere hid it). v1.1 fixes all three. Planted: 2,853 of 2,857; the four left are a removed file-identity check (it runs no tests), a test file that still runs inside the mutation step, a removed shell function the loops still call (CI fails loudly), and an always-true line next to an identical copy of the assertion it replaced. Because the held-out half had been read, v1.1's figures on it are a re-run, not a held-out result: 3 false alarms of 330.
- **v1.2.** ScopeGuard checked its own first push and flagged its own tests: they hold diffs as string literals (`'+it.skip("adds"...'`), and the test-file rules read markers inside quotes as code. v1.2 treats a marker, an assertion or a suppression inside a string literal on its line as data. Config files are not changed by this (their values are strings by nature). Same held-out re-run figures; planted 2,852 of 2,856 (one copy fewer: the planter no longer plants into a quoted assertion).

## Limits

It does not judge intent: a flagged line can be an honest change, and the verdict is a list of lines to read. It has no rule for a weakening it has no rule for: changing the code under test so a test passes trivially, or a new test that checks nothing useful. Pair it with mutation testing. It reads one line at a time, so a multi-line assertion is seen through its first line. The honest-data measurement is mostly JavaScript and mostly AI-written code; other languages are covered by rules and tests, not yet by a measurement.
