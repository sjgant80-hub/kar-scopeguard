# Buyer walk, qwen2.5:7b on this machine, 2026-11-12T20:00:31.300Z

Page text: 34325 characters.

## CTO of a 300-person software company whose teams now merge many AI-agent pull requests a week (1442 s, prompt 9140 tokens)

1. **Questions the page does not answer:**
   - **Sentence:** "AI coding agents are now writing a large share of the changes many teams merge."
     - *Question:* How many changes are we talking about, and how does this compare to the number of changes reviewed by humans?
   - **Sentence:** "CTO and engineering leads: A green build from an AI agent becomes something you can trust: weakened tests and widened scope are caught before merge, not found in an incident review."
     - *Question:* Can you provide more details on how ScopeGuard identifies weakened tests and widened scope, and how it ensures these are caught before merge?
   - **Sentence:** "For your business: Fewer escaped defects from 'it passed CI' changes, and a written record (the fingerprint) of what was checked on each change."
     - *Question:* How does ScopeGuard ensure that the fingerprint accurately reflects the changes checked, and how does it prevent false positives?

2. **Confusing or contradictory sentences:**
   - **Sentence:** "The rules were tuned on half of our repositories' history and then run, once, on the other half."
     - *Contradiction:* "The sealed result: version 1, the held-out half read once"
     - *Explanation:* This sentence seems to imply that the rules were tested on the held-out half, but the "sealed result" suggests they were only read, not tested.

3. **Claims you do not trust:**
   - **Claim:** "On the held-out half, high findings that were false alarms came to 2 of 330 commits (0.6%). The sealed target was at most 2%: MET."
     - *Reason:* This claim is based on a re-run of the held-out data, which may not be as rigorous as an initial, independent test.
   - **Claim:** "Version 1.2 still misses 1 assert-neutered and 3 test-run-removed plants, read one by one."
     - *Reason:* The claim that these specific plants were missed seems too precise and may not reflect the overall effectiveness of the tool.

4. **Would you approve a trial?**
   - *Sentence:* "Yes, but with a clear understanding of the limitations and a detailed plan for rolling it out across 40 repositories."
     - *Reason:* Approving a trial would allow us to test the tool in a controlled environment, gather data, and address any issues before a full rollout.

## CISO of a UK bank that is piloting AI coding agents under model-risk and change-control rules (1146 s, prompt 9134 tokens)

1. **Questions the page does not answer that would need to be addressed before buying:**
   - **Sentence:** "The rules know JavaScript and TypeScript (Jest, Vitest, Mocha, node:test, Chai), Python (pytest, unittest), Go (testing, testify), Java and Kotlin (JUnit), C# (NUnit, xUnit), Ruby (RSpec, Minitest), PHP (PHPUnit) and Rust."
     - *Question:* How well do the rules work for each of these languages? Are there any known limitations or issues with specific frameworks or libraries?
   - **Sentence:** "The honest-data measurement above is mostly JavaScript, because that is what our repositories are written in, and mostly AI-written."
     - *Question:* How representative is the "honest-data" measurement for other languages and types of repositories? Are there plans to expand this measurement to include more languages and repositories?
   - **Sentence:** "A green build from an AI agent becomes something you can trust: weakened tests and widened scope are caught before merge, not found in an incident review."
     - *Question:* How does ScopeGuard handle changes that are not directly related to tests or CI configurations, such as changes in documentation or comments?

2. **Confusing or contradictory sentences:**
   - **Sentence:** "The page carries a Content-Security-Policy with connect-src 'none': it cannot open a connection to any site, its own included, so even a changed copy of the code could not send your diff anywhere."
     - *Contradiction:* This statement seems to contradict the fact that the page can still process and display diffs, which implies some form of network interaction.

3. **Claims or numbers you do not trust, and why:**
   - **Claim:** "On the held-out half, high findings that were false alarms came to 2 of 330 commits (0.6%). The sealed target was at most 2%: MET."
     - *Reason:* The claim of a 0.6% false alarm rate seems too low and may be overly optimistic without further details on the methodology and validation process.
   - **Claim:** "Every part is mutation-gated."
     - *Reason:* While the page states that every part is mutation-gated, it does not provide specific details on how this is implemented or validated.

4. **Would you approve a trial?**
   - *Sentence:* "Yes, I would approve a trial to evaluate the effectiveness and reliability of ScopeGuard in our specific development environment."

## Staff engineer who would have to install it, tune it and answer for it when it blocks a merge (989 s, prompt 9141 tokens)

1. **Questions the page does not answer:**
   - **"How does ScopeGuard handle multi-line assertions or checks?"** - The page mentions that multi-line statements are only seen through their first line, but it does not provide a clear explanation of how this is handled.
   - **"What happens if a change involves multiple files, and the scope is not explicitly defined for those files?"** - The page does not specify the behavior when a change touches files outside the explicitly defined scope.
   - **"How does ScopeGuard handle changes that involve complex refactorings, such as moving a function or class between files?"** - The page does not address how ScopeGuard deals with such refactorings.

2. **Confusing or contradictory sentences:**
   - "The rules know JavaScript and TypeScript (Jest, Vitest, Mocha, node:test, Chai), Python (pytest, unittest), Go (testing, testify), Java and Kotlin (JUnit), C# (NUnit, xUnit), Ruby (RSpec, Minitest), PHP (PHPUnit) and Rust." - This sentence is confusing because it lists multiple testing frameworks for each language, but the page later states that the rules are "equally" applied to all languages, which might imply a single set of rules.

3. **Numbers or claims not trusted:**
   - **"The sealed target was every plant caught, for every rule."** - I do not fully trust this claim because the page does not provide details on how the plants were created or how they were validated.
   - **"On the held-out half, high findings that were false alarms came to 2 of 330 commits (0.6%)."** - While this is a low rate, I would need more details on the methodology and the context of these false alarms to fully trust this claim.

4. **Approval for a trial:**
   - **"Yes, I would approve a trial because it provides a clear and consistent way to check changes, which could significantly reduce the risk of weakened tests, and it is open-source and can be run locally."**

