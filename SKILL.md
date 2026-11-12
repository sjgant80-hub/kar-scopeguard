---
name: "kar-scopeguard"
description: "Checks a code change made by an AI coding agent for two things: whether it stayed inside the files the task allowed, and whether it made the tests easier to pass instead of making the code right (skipped or focused tests, assertions removed, commented out, made always-true or loosened, tolerances widened, coverage floors lowered, CI told to ignore failures, test files deleted). Use before trusting an agent's claim that the tests pass, when reviewing an AI-made diff or pull request, or when asked whether a change weakened its own tests. Deterministic Node.js script with no LLM judge and no network."
summary: "Did the agent get its green honestly? Reads a diff and flags every skipped, loosened, deleted or neutered test, every CI step told to ignore failures, and every file outside the allowed scope, each with its line. No LLM judge, no network, mutation-tested."
version: "1.0.0"
tags: ["code-review", "testing", "ai-agents", "agent-governance", "ci", "deterministic"]
use_cases: ["Check an agent's change before repeating its claim that all tests pass", "Catch a test that was skipped, loosened or commented out to get a green build", "Confirm an agent stayed inside the files a task allowed"]
docs_url: "https://sjgant80-hub.github.io/kar-scopeguard/"
---

# ScopeGuard: did the agent get its green honestly?

An agent that says "all tests pass" is making a claim. The cheapest way to make tests pass is often to change the
tests. ScopeGuard reads the change itself (a unified diff) and lists every line where that may have happened, with
the rule that found it, the file and line number, and the exact text.

## What it checks

High findings (a reviewer must read them before merging):

- a test marked to be skipped or focused (`it.skip`, `xit`, `it.only`, `@pytest.mark.skip`, `t.Skip`, `@Disabled` and others);
- an assertion turned into a comment, or replaced by one that can never fail (`expect(true).toBe(true)`);
- an exact check replaced by a looser one on the same value (`toEqual(...)` to `toBeDefined()`, `==` to `!=`, `assertEqual` to `assertTrue`);
- a numeric tolerance widened, a coverage or mutation-score threshold lowered, a strictness setting switched off;
- a test file deleted, or renamed to a path the test runner no longer finds;
- CI told to ignore failures (`continue-on-error: true`, `|| true`, `allow_failure`, `--passWithNoTests`), a test command removed, a test script replaced by a no-op;
- a binary test or CI file it cannot read (flagged, never passed);
- with a scope: a file outside the allowed paths, a denied path, or the scope file itself changed.

Review findings (worth a look, often honest): fewer assertions than before, an expected value changed, an empty
catch in a test, a snapshot rewritten, a baseline of accepted failures grown, a checker told to ignore a line, and
files the agent's own summary did not mention.

## When to use it

- Before you repeat an agent's claim that its change passes the tests.
- When asked to review a diff or pull request made by an AI coding agent.
- When asked whether a change stayed within the files a task allowed.

## How to run it

The script is `scripts/kar-scopeguard.mjs`: one file, Node.js 20 or newer, no dependencies, no network, and it
writes no files. Run it unchanged and keep the `.mjs` extension.

1. Get the change as a unified diff: `git diff main...HEAD > change.diff`, or `git show > change.diff` for the last commit.
2. Optional scope, one rule per line: `allow src/auth/**`, `deny .github/**` (`**` any folders, `*` within one name).
3. Optional: the agent's own summary of its change, as a text file, to compare against the files really touched.
4. Run `node scripts/kar-scopeguard.mjs change.diff [--scope scope.txt] [--claim summary.txt]`, or pipe the diff in with `-`.
5. Read the exit code: `0` clean or review only, `2` flagged (at least one high finding), `1` the diff could not be read (cut off, a combined merge diff, malformed: the reason is on stderr and in the report).
6. Report the verdict and every high finding with its file, line and text. Never call a flagged change "verified" or
   repeat "all tests pass" without naming the findings. Give the two fingerprints so the result can be rechecked.

## What it prints

A JSON report: `verdict` (`clean`, `review`, `flagged` or `unreadable`), `counts`, `files` (each path with its kind:
test, snapshot, gate or source, and its scope state), `findings` (rule, severity, path, line, text) and
`fingerprints`: the SHA-256 of the exact input and of the result. The `examples/` folder has eight real-shaped
changes with their expected reports.

## How it was checked

- The claims were committed before the code.
- On 395 commits from our own public repositories that touch a test or CI file, used to tune the
  rules, and then once on 330 held-out commits read after the code was frozen: high false alarms on
  2 of the 330 held-out commits (0.61%) for the sealed version 1; version 1.2, which fixes what the planted weakenings and its own first push found, re-run on the same commits: 3.
- Weakenings planted into the held-out real diffs were caught 2852 of 2856 times by version 1.2 (the misses are listed on the page).
- A mutation gate made 454 single-operator changes to the checking code and the tests caught 454 of them; the kernel checked has SHA-256 3dfee7a29bc46c1c05b2f780710f8d0b9fdb8ff3a5a894375e3a899c5b211256.

## Limits

It does not judge intent: a flagged line can be an honest change. It has no rule for a weakening it has no rule
for, such as changing the code under test so a test passes trivially, or a new test that checks nothing useful.
It reads one line at a time, so an assertion split over several lines is seen through its first line. Pair it with
a mutation test, which checks whether the tests can fail at all.

Source, tests and every measurement: https://github.com/sjgant80-hub/kar-scopeguard (MIT).
