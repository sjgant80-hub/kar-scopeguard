# ScopeGuard: the sealed claims

Written and committed before any code. Each claim says what will be measured, how, and what counts as a pass.
A claim that fails stays on this page, marked FAILED, with the number that failed it.

## What it is

A check for code changes made by an AI coding agent (or anyone). It reads a unified diff (`git diff`, `git show`,
a pull request's `.diff`) and answers two questions with the exact lines as evidence:

1. **Did the change stay inside the files the task allowed?** (an optional scope file: `allow`, `deny` patterns)
2. **Did the change make the tests easier to pass instead of making the code right?** (skipped or focused tests,
   assertions removed, commented out, made always-true or loosened, tolerances widened, coverage thresholds lowered,
   test steps removed from CI, failures told to be ignored)

It gives a verdict, every finding with the file and line it came from, and two SHA-256 fingerprints (input and
result) that the command line and the page compute the same way. No AI judge, no network.

## The claims

- **S1 · Every touched path is classified.** Every file the diff adds, deletes, modifies, renames or copies is
  listed with its class (test, gate, source) and its scope state (allowed, denied, outside). A rename is checked on
  both its old and new path.
- **S2 · What cannot be read fails loudly.** A diff that cannot be parsed, a hunk whose line counts do not match its
  header (a cut-off diff), a combined merge diff, or a scope line it does not understand is refused (exit 1), never
  passed. A binary change to a test or gate file cannot be inspected, so it is a finding, never silence.
- **S3 · A closed list of rules.** Every rule has an id, a severity (high or review) and a test with a positive
  and a negative example. The rule list is on the page and in the kernel; nothing is checked that is not listed,
  and the page says what is not checked.
- **S4 · Honest changes: the false-alarm rate is measured and published as measured.** The honest set is every
  non-merge commit that touches a test or gate file in the estate's own public repositories cloned on the build
  machine. The set is split by repository before any rule is written: a repository whose name's SHA-256 starts with
  an even hex digit is in the tuning half, odd is held out. Severities and patterns may be changed after reading the
  tuning half only. The held-out half is read once, after the kernel's hash is committed, and its numbers are
  reported as they come.
  - Target: high-severity findings on at most 2% of held-out honest commits. Every held-out high finding is read by
    hand and labelled either a real weakening (it counts as a catch, not a false alarm) or a false alarm.
- **S5 · Planted weakenings are caught on real diff shapes.** For each high rule, the weakening is planted into
  real held-out diffs (one new line, hunk header adjusted) and the kernel must flag it in every planted copy where
  the planted line lands in a file of the class the rule covers. Target: 100% per rule.
- **S6 · Same fingerprints everywhere.** The command line and the page give the same input and result SHA-256 for
  the same diff and scope. Tested on the page's own examples.
- **S7 · Total.** The kernel's exported functions never throw on garbage (witness fuzz).
- **S8 · Gated.** Every kernel is mutation-gated by witness with every mutant run; clean, or each survivor baselined
  with a written reason.
- **S9 · The claimed-files check.** Given the agent's own summary of what it changed, it lists every touched file
  the summary never names and every named file the diff never touches.

## What it does not claim

It does not judge intent. A flagged line can be an honest change (a test removed with the feature it tested, an
expected value updated because the specification changed). The verdict is a list of lines a reviewer must read
before merging, with the reason for each. It reads only the diff: it does not run the tests, and a weakening it has
no rule for passes unnoticed.
