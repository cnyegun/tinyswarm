# Tiny Rewrite Plan

## Goal

Build a small CLI that inspects a rendered page, asks the opencode agent harness to create an accessible rewrite, verifies the generated page once, optionally gives the harness one repair pass, then serves the result locally.

## Command

```bash
npm run tiny -- https://aaltoai-for-good.com/
```

## Runtime Flow

1. Use Playwright to load the original URL.
2. Extract visible page facts: title, headings, links, buttons, images, landmarks, paragraphs, and text snippets.
3. Run axe on the original page.
4. Write scan artifacts into `runs/<timestamp>/`.
5. Build an agent task from `DESIGN.skill`, `original.html`, `facts.json`, and `audit-brief.md`.
6. Use the official `@opencode-ai/sdk` only.
7. Start opencode with `createOpencode()` or connect to `TINY_OPENCODE_SERVER_URL` with `createOpencodeClient()`.
8. Create one SDK session and call `session.prompt()` for the initial rewrite.
9. Verify `transformed.html` with Playwright and axe.
10. If verification fails, call `session.prompt()` once more with the failures.
11. Stop after that one repair pass and serve the current `transformed.html`.

## Artifacts

- `original.html`: rendered original page.
- `facts.json`: extracted rendered page facts.
- `audit-brief.md`: accessibility brief for the harness.
- `task.md`: initial opencode harness task.
- `repair-task.md`: repair task, only when verification fails.
- `transformed.html`: final harness-written page.
- `verification.md`: final verification result.
- `harness.log`: SDK harness summary.
- `scan.log`: CLI runtime log.

## Harness Rules

- Do not call provider APIs directly.
- Do not implement custom opencode HTTP clients.
- Do not parse opencode SSE manually.
- Use `@opencode-ai/sdk` for opencode server/client/session calls.
- Default model is `deepseek/deepseek-v4-flash` with variant `max`.
- Override with `TINY_HARNESS_MODEL=<provider>/<model>` and `TINY_HARNESS_VARIANT=<variant>`.
- The harness owns creating and revising `transformed.html`.
- The CLI owns scanning, task construction, verification, artifacts, and local serving.

## Verification Scope

Keep verification small and external to the agent:

- Document title exists.
- Exactly one `h1`.
- `main` landmark exists.
- No `script`, `iframe`, `object`, or `embed` elements.
- No inline event handler attributes.
- Axe returns no violations for the generated page.
- Mobile viewport has no horizontal overflow.

## Local Server

Routes:

- `/` -> `transformed.html`
- `/original` -> `original.html`
- `/facts.json` -> `facts.json`
- `/audit-brief.md` -> `audit-brief.md`
- `/task.md` -> `task.md`
- `/repair-task.md` -> `repair-task.md`
- `/verification.md` -> `verification.md`
- `/harness.log` -> `harness.log`
- `/scan.log` -> `scan.log`

Use port `5177` when available, otherwise use a random port.

## Acceptance

- `npm run build` passes.
- `npm run test:mock` passes.
- Source uses `@opencode-ai/sdk` for opencode integration.
- Source contains no provider-specific transformer path.
- Source contains no regex-based HTML mutation/sanitization path.
