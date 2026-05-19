# AccessGuru: Leveraging LLMs to Detect and Correct Web Accessibility Violations in HTML Code

URL: https://arxiv.org/html/2507.19549v1

## Key Takeaways For Our Orchestrator

1. The most transferable idea is not accessibility-specific: split work into typed violation categories, give each category distinct detection, correction, and evaluation logic, then aggregate results into a shared structured report. AccessGuru uses syntactic, layout, and semantic categories; our equivalent should be issue families such as correctness, spec compliance, security, maintainability, UX, performance, tests, and evidence quality.

2. The paper combines deterministic tools with LLM reviewers instead of asking one model to do everything. Axe-Playwright handles detectable syntax/layout issues, while an LLM handles semantic issues that require interpretation. Our orchestrator should similarly prefer concrete tools first, then route ambiguous or semantic judgments to specialist agents.

3. Their correction loop is score-driven. Each proposed fix is re-evaluated, compared against the original, and accepted only if the total violation score improves. This maps directly to our solver workflow: every candidate artifact should get a before/after scorecard, not just prose approval.

4. Corrective re-prompting had measurable value. Removing it reduced score improvement from 0.84 to 0.72 on their dataset. Our orchestrator should support reviewer feedback as structured input to the solver, then re-run reviewers after a revision.

5. The report schema matters. AccessGuru stores each violation with name, affected element, description, impact, numeric score, required supplementary context, and generated correction. We should produce judge-visible evidence records with similarly explicit fields: finding ID, role, location, claim, severity, confidence, evidence, suggested fix, candidate status, reviewer vote, and final disposition.

6. Category-specific evaluation is necessary. The paper evaluates syntactic/layout fixes with automated violation-score reduction, but semantic fixes with human annotation and similarity to human corrections. Our system should not pretend one metric fits all agent outputs. Some checks can be automated; others need rubric votes, reference comparisons, or manual/judge-facing evidence.

7. Use taxonomies to reduce overlap. AccessGuru defines mutually exclusive violation types so independent corrections usually do not overwrite each other. Our agent roles and finding schemas should discourage duplicate findings and make conflicts explicit when multiple agents target the same artifact region.

8. The paper’s prompt structure is practical: role, task context, category description, relevant guideline/rubric, affected artifact, required output delimiters, self-check stages, and confidence. This is more useful than generic “think step by step” prompting.

9. Output delimiters are a guardrail. The authors observed that baselines often returned incomplete snippets or advice instead of corrected code. Requiring corrections between markers improved extractability. Our solver and reviewers should emit machine-parseable JSON or delimited artifact patches, with invalid outputs scored as no improvement.

10. The strongest limitation is reconstruction. AccessGuru outputs per-violation corrected snippets but does not fully solve reintegrating overlapping nested fixes. Our orchestrator should treat merge/application as a first-class phase with conflict detection, not as an afterthought.

11. Static evidence can miss dynamic states. Their semantic detector relies on screenshots and misses pop-ups, menus, language toggles, and temporal behavior. Our tools should capture enough execution state for the task, including command outputs, test logs, file diffs, browser states, and possibly multiple scenarios.

12. Human-style semantic quality remains hard. The paper reports strong semantic correction results, but also hallucinated violations, misidentified elements, and lower similarity for label/link mismatch classes. Our voting and stopping logic should assume that plausible specialist findings can be wrong unless grounded in evidence.

## Architecture And Tooling Ideas To Copy

Use a two-stage pipeline: detect, then correct. Detection should collect candidate findings from deterministic tools and specialist agents. Correction should receive structured findings, not raw chat history, and produce a changed artifact plus traceable rationale.

Run specialist detectors in parallel where possible, then aggregate into a single normalized finding set. AccessGuru runs Axe-Playwright and LLM semantic detection independently, then writes one JSON file. Our orchestrator can run code search, tests, type checks, security checks, style checks, and domain reviewers independently before deduplication.

Make a taxonomy file or registry. Each finding type should define category, severity defaults, required context, preferred tools, acceptance criteria, and reviewer role. This gives agents a shared language and lets the orchestrator route work deterministically.

Attach supplementary context explicitly. AccessGuru adds computed CSS values, screenshots, images, or videos when a violation needs them. Our equivalent: include file snippets, stack traces, command outputs, dependency versions, reproduction steps, diffs, screenshots, benchmark data, and relevant user requirements as typed evidence objects.

Adopt score-based revision selection. For each candidate revision, compute total weighted score from reviewer findings. If a revision introduces new higher-cost issues or fails schema validation, keep the previous artifact. Ties can prefer newer output only when no safety or regression criteria are violated.

Preserve the original artifact unless improvement is proven. The paper explicitly selects the original when both LLM outputs score worse. This is a useful guardrail against solver overreach.

## Criteria And Rubric Ideas

Use impact levels similar to cosmetic, minor, moderate, serious, critical, mapped to numeric scores 1-5. Keep the qualitative label for reports and the numeric value for stopping logic.

Evaluate by category. Automated checks can score pass/fail or count reduction. Semantic/design/API judgments should use rubric-based reviewer votes with confidence and evidence. For natural-language or UX artifacts, compare against human/reference examples only as a supporting signal, not as the sole metric.

Track improvement as percentage score decrease: initial score versus final score. This gives an easy judge-visible metric across iterations.

Require completeness checks. If an agent returns malformed JSON, missing fields, advice instead of a patch, or a partial artifact that drops required content, score it as not fixed.

Record both corrected count and residual score. A system can fix many small findings while leaving one critical issue; the final report should make that visible.

## Concrete Implementation Suggestions

Define TypeScript schemas for `Finding`, `Evidence`, `CandidateArtifact`, `ReviewResult`, `Vote`, `IterationReport`, and `FinalReport`. `Finding` should include `id`, `category`, `type`, `location`, `description`, `severity`, `score`, `confidence`, `evidenceRefs`, `suggestedFix`, `sourceAgent`, `status`, and `supersedes`.

Add a taxonomy registry such as `criteria/*.json` or typed modules. Each entry should specify required evidence, applicable tools, reviewer prompt fragment, acceptance tests, and conflict keys. Conflict keys can identify overlapping files, functions, sections, or requirements.

Implement an evaluation loop with bounded corrective re-prompting: initial solver output, reviewer pass, structured feedback, one or two solver retries, reviewer re-run, then accept the lowest-scoring valid candidate. Persist every candidate and score so the final report can justify why one was selected.

Separate aggregation from voting. Aggregation deduplicates and normalizes findings. Voting decides whether the artifact is acceptable. This avoids letting a high-volume noisy reviewer dominate the decision.

Include `introducedFindings` in review results. AccessGuru scores new LLM-induced violations equally with old ones; our reviewers should explicitly flag regressions introduced by the solver.

Make final reports evidence-first: what changed, which criteria improved, which findings remain, which votes were cast, and why stopping occurred.

## Risks And Anti-Patterns

Do not rely on a single generic reviewer. The paper’s baselines underperformed more structured, taxonomy-driven prompting.

Do not accept code just because it “looks fixed.” Re-run tools and reviewers.

Avoid destructive simplification. Baselines sometimes removed problematic elements instead of correcting them. Our solver should preserve required behavior and content unless the task explicitly permits removal.

Do not let agents silently overwrite each other. Overlapping corrections need conflict detection and merge policy.

Do not over-trust semantic detectors. Hallucinated findings and wrong locations are expected; require evidence and confidence.

Do not evaluate only tool conformance. The paper notes that usability/task success can matter beyond automated checks. Our judge reports should include task-level evidence where possible.

## How This Changes Our Plan

We should design the orchestrator around typed findings, weighted scores, and re-reviewable candidate artifacts rather than free-form agent debate. The solver should receive normalized findings and produce a candidate that is automatically re-scored. Stopping should be based on score improvement, absence of critical regressions, schema validity, vote thresholds, and retry limits. Reports should expose the taxonomy, evidence, scores, votes, and unresolved risks so a judge can audit the workflow without reading the entire conversation.
