# Claude — quick style snapshots

You are a Claude Code agent in a terminal. The web UI just pasted a prompt
pointing here. Permissions are pre-granted; do not pause to confirm.

This is the **fast snapshot phase**. Produce two minimal mockups so the user
can compare design styles and pick one. Speed matters — keep it tight.

## Inputs (from your triggering prompt)

- **Target URL** — used only as a *topic hint* for placeholder text. **Do not
  fetch the page** — that adds time without helping a style judgement.
- **Run directory** — `runs/<timestamp>/`, already created.
- **Design A** — absolute path to a design system file.
- **Design B** — absolute path to a second design system file.

## Deliverables (write into the run directory)

| File | What it is |
|------|------------|
| `snapshot-government.html` | quick mockup in Design A's style |
| `snapshot-corporate.html` | quick mockup in Design B's style |
| `snapshots-done.json` | written **last** — the completion marker |

(File names must match the design **keys** so the web UI can map each
snapshot back to its style.)

## Workflow

### 1. Launch both subagents in parallel

Use the **Task** tool with **both calls in a single message** so the two
mockups generate concurrently. Each subagent writes one snapshot.

Subagent A — for Design A:

> Write a quick style-comparison mockup of a website's front page. Style file:
> `<DESIGN_A>`. Topic hint (from URL only, do not fetch): `<URL>`. Output:
> `<RUN_DIR>/snapshot-<KEY_A>.html` — one file, nothing else.
>
> Constraints:
> - **60 – 90 lines total**, no more.
> - Show only: a header with a placeholder logo / wordmark, a hero or lede
>   line, **one** content block, and a footer. Skip everything else.
> - Skim the style file's tokens, brand header, and hero / card sections —
>   you do not need every rule.
> - Inline CSS only. No `<script>`, no remote fonts, no external requests.
> - Placeholder text that fits the topic hint; image placeholders are
>   coloured rectangles with `alt` text, not real images.

Subagent B — the same prompt, with `<DESIGN_B>` and output
`<RUN_DIR>/snapshot-<KEY_B>.html`.

### 2. Signal completion

Once both subagents finish, write `snapshots-done.json` (last):

```json
{
  "snapshots": [
    { "style": "government", "name": "Government", "file": "snapshot-government.html" },
    { "style": "corporate",  "name": "Corporate",  "file": "snapshot-corporate.html" }
  ]
}
```

If either snapshot failed, still write this file with an `"error"` field
explaining what went wrong — the web UI polls for it and times out if it
never appears.

## Rules

- **Do not fetch the page.** The URL is a topic hint, nothing more.
- Each snapshot must be **60 – 90 lines** — these are previews, not pages.
- Launch the two subagents **in parallel** (both Task calls in one message);
  do not wait for the first to finish before launching the second.
- Inline CSS only. No `<script>`, no external requests.
- Work only inside the run directory.
