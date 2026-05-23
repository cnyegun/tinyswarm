# Claude web page generation — wrapper playbook

You are a Claude Code agent in a terminal. The web UI pasted a prompt pointing
here after the user picked a design style from the snapshot preview.
Permissions are pre-granted; do not pause to confirm.

## This is a *wrapper*, not a fork

Your job is to rebuild **only the front page** of a target website, applying
the chosen design system and EU / WCAG 2.2 AA accessibility standards. The
rest of the site stays untouched: **every link on your rebuilt page points
back at the original site's real URLs**. Images load from the original site
too. You are wrapping the front page with an accessible facelift, not
duplicating the whole site.

The web UI is watching the run directory; it shows the run as finished only
once you write the done marker in Step 5.

## Inputs (from your triggering prompt)

- **Target URL** — the page to wrap (e.g. `https://example.com/`). This is
  also the **origin** used to resolve every link and image.
- **Run directory** — `runs/<timestamp>/`, already exists.
- **Style file** — absolute path to the design system the user chose
  (e.g. `designs/corporate.md`).

The **project root** is the directory containing this file. `WCAG_2.2.html`
lives there.

## Deliverables (write into the run directory)

| File | Purpose |
|------|---------|
| `transformed.html` | the regenerated front page — the deliverable |
| `review.md` | the reviewer agent's findings (machine-friendly) |
| `report.html` | the human-readable report (issues found + fixes applied) |
| `claude-done.json` | the completion marker — **write this last** |

## Workflow

### 1. Capture the original page

```
curl -sL --max-time 30 -A "Mozilla/5.0 (X11; Linux x86_64)" "<URL>" -o "<RUN_DIR>/original.html"
```

Confirm `original.html` exists and is non-empty.

### 2. Launch the builder agent

Use the **Task** tool to launch a builder subagent with this prompt (fill in
the real paths and URL):

> Rebuild a website's front page as an **accessible wrapper**. Read the
> captured source at `<RUN_DIR>/original.html` and the chosen design system at
> `<STYLE_FILE>`. Produce one self-contained HTML file at
> `<RUN_DIR>/transformed.html` that:
>
> - Keeps the original page's content, structure, headings, and language.
> - Fully conforms to `<STYLE_FILE>` and to WCAG 2.2 Level AA.
> - **Rewrites every `<a href>` to an absolute URL** resolved against the
>   target origin `<URL>` — so each link still goes to the original site.
>   Resolve relative paths (`/about`, `./tickets`, `tickets.html`) against the
>   target URL. Leave already-absolute URLs unchanged.
> - **Rewrites every `<img src>` to an absolute URL** the same way — images
>   load from the original site, not from the wrapper.
> - **Uses only links and images that exist in `<RUN_DIR>/original.html`.**
>   First read `original.html` and extract its set of `href` and `src` URLs.
>   Every `<a href>` and `<img src>` in `transformed.html` must resolve to
>   one of those URLs (or to the target URL itself for the home link).
>   Internal fragment links like `<a href="#main">` (skip link, section
>   anchors that exist in your output) are exempt — but **never use empty
>   `<a href="#">` placeholders**: if a control has no real destination, do
>   not render it as a link. Do not invent navigation items, footer links,
>   CTAs, or images that did not appear in the source.
> - Inlines all CSS in a single `<style>` block built from the design tokens.
>   No external stylesheets, no remote fonts, no `<script>` tags.
> - Uses real landmarks (`header`, `nav`, `main`, `footer`), exactly one
>   `h1`, visible focus styles, sensible `alt` text on every meaningful
>   image, and a "skip to main content" link as the first focusable element.

### 3. Launch the reviewer agent

After the builder finishes, use the **Task** tool to launch a reviewer
subagent:

> Audit `<RUN_DIR>/transformed.html` against WCAG 2.2 Level AA and against
> `<STYLE_FILE>`. Use `<ROOT>/WCAG_2.2.html` as the criteria reference. Also
> confirm two invariants:
>
> - **Absolute URL invariant**: every `<a href>` is an absolute URL and every
>   `<img src>` is an absolute URL (fragment links like `#main` are exempt).
> - **No-invent invariant**: every `<a href>` (other than fragment links) and
>   every `<img src>` in `transformed.html` corresponds to a URL that appears
>   in `<RUN_DIR>/original.html`, or to the target URL itself. Flag any link
>   or image that the wrapper added on its own. Also flag any empty
>   `<a href="#">` placeholder.
>
> Write findings to `<RUN_DIR>/review.md` — one issue per line, most severe
> first. If there are no blocking issues, write exactly `No blocking issues.`

### 4. Apply the review

Read `<RUN_DIR>/review.md`. If it lists blocking issues, fix them directly in
`<RUN_DIR>/transformed.html` — **one pass, do not loop**. If it says
`No blocking issues.`, leave the file unchanged.

### 5. Write the human-readable report

Generate `<RUN_DIR>/report.html`: a self-contained HTML page summarizing
**what was wrong with the original page and what you fixed**. Style it with a
small inline CSS block (no external stylesheets, no scripts). It must include:

- A short summary paragraph: target URL, chosen style, run timestamp.
- A "Issues found" section — a list of WCAG 2.2 issues identified in the
  original page (one per row in a table or list). For each: a short title,
  the affected element or area (e.g. "main nav"), and the WCAG criterion
  number when known.
- A "Fixes applied" section — a list mapping each issue to the change you
  made in `transformed.html` (one sentence per fix).
- A "Review outcome" section — the contents of `review.md`, rendered as HTML
  (escape any HTML in the source).
- A footer link `<a href="transformed.html">View the improved page</a>` —
  this is a relative link inside the run directory; the web UI serves both
  files from `/artifact/`.

Keep it brief: the goal is for a non-developer to read it in under a minute
and understand both the problem and the fix. Plain language, no jargon, no
inline styles on each element — one `<style>` block at the top is enough.

### 6. Finalize and signal completion

1. Verify `<RUN_DIR>/transformed.html` exists, is non-empty valid HTML, and
   satisfies both invariants: every `<a href>` and every `<img src>` is
   absolute, **and** every one of those URLs also appears in
   `<RUN_DIR>/original.html` (fragment links exempt). If an earlier step
   failed to produce the file, write a minimal valid HTML page there yourself
   so the run still has an artifact.
2. Verify `<RUN_DIR>/report.html` exists and is non-empty. If you couldn't
   produce it, write a minimal one explaining what went wrong.
3. **Last of all**, write `<RUN_DIR>/claude-done.json`:

   ```json
   { "outcome": "done", "reason": "<one-sentence summary>", "output": "transformed.html", "report": "report.html" }
   ```

   If the run failed and you could not produce a real wrapper, still write
   this file — with `"outcome": "error"` and a `"reason"` explaining what
   went wrong. The web UI waits for this file; always write it.

## Rules

- **Wrapper invariant**: every `<a href>` and every `<img src>` resolves to
  an absolute URL on the original site. No relative paths survive.
- **No-invent invariant**: only URLs that appear in `original.html` may be
  used in `transformed.html`. No fabricated nav items, footer links, CTAs,
  or images. No empty `<a href="#">` placeholders.
- Fragment links such as `<a href="#main">` (skip link, in-page anchors) are
  fine — but the target anchor must exist in the same file.
- Work only inside the run directory you were given. Do not touch other
  `runs/` directories or any project files.
- Inline CSS only; no external stylesheets, no remote fonts, no `<script>`.
- The chosen `<STYLE_FILE>` is the single source of truth for visual design.
