# Corporate Design System

A refined, premium, editorial visual language — inspired by the
J.P. Morgan website. Built for established institutions that need to read as
trustworthy, considered, and quietly confident.

This document is the **single source of truth** for how anything built in this
style should look and behave. Every screen, page, and component must follow it.
When in doubt, choose the calmer, more spacious, more editorial option.

It is one of two interchangeable styles in `designs/`. It targets the same
**WCAG 2.2 Level AA** accessibility bar as `designs/government.md` — the style
is premium, but accessibility is never traded away for polish.

---

## 1. How to use this document

- **Tokens first.** Section 3 defines every colour, size, and spacing value as
  a CSS custom property. Build with tokens — never hard-code a raw hex value,
  pixel size, or font name in a component.
- **Components second.** Section 8 specifies each reusable element. If you need
  something new, design it from the principles and tokens, then add it here.
- **Accessibility is not optional.** Section 11 lists hard requirements. A
  design that fails them is not finished, however handsome it looks.

---

## 2. Design principles

1. **Quiet confidence.** Authority comes from restraint and craft, never from
   loud colour or ornament. Nothing shouts.
2. **Editorial hierarchy.** Serif headlines lead the eye; generous whitespace
   frames them. The page reads like a well-set publication.
3. **Photography carries the warmth.** Real, documentary photography of people
   and places does the emotional work — the interface itself stays sober.
4. **Warm, not clinical.** Off-whites and warm greys, never a cold pure-grey.
   The palette feels like paper and bronze, not steel.
5. **Content first.** Text and real information lead. Chrome supports it.
6. **Accessible by default.** High contrast, visible focus, keyboard support,
   and semantic structure are designed in from the start.

---

## 3. Design tokens

Implement these once, globally, as CSS custom properties. All components
reference them by name.

```css
:root {
  /* ---- Brand ---- */
  --color-brand:         #5b4129; /* dark brown — primary actions, links, key UI */
  --color-brand-deep:    #3a2a1a; /* hover / active / pressed */
  --color-accent:        #9a6b3f; /* bronze — thin accent rules only, never text */
  --color-brand-wash:    #f1ebe3; /* pale warm wash — selected rows, quiet panels */

  /* ---- Neutrals (warm) ---- */
  --color-ink:           #1c1a17; /* primary body text — warm near-black */
  --color-ink-muted:     #57514a; /* secondary text, captions, metadata */
  --color-inverse:       #ffffff; /* text on dark or photographic surfaces */
  --color-surface:       #ffffff; /* default page & card background */
  --color-surface-warm:  #f6f4f0; /* alternating sections, quiet panels */
  --color-deep:          #211b14; /* deep footer and dark bands */
  --color-border:        #d8d2c8; /* hairlines, dividers, table rules */
  --color-border-strong: #57514a; /* form-control boundaries (>= 3:1) */

  /* ---- Status ---- */
  --color-success: #1f7a43;  --color-success-bg: #e8f1ea;
  --color-warning: #8a5a00;  --color-warning-bg: #f6ecd9;
  --color-error:   #b22a26;  --color-error-bg:   #f7e7e6;
  --color-info:    #5b4129;  --color-info-bg:    #f1ebe3;

  /* ---- Typography ---- */
  --font-serif: Georgia, "Times New Roman", Times, "Liberation Serif", serif;
  --font-sans:  system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial,
                "Liberation Sans", sans-serif;
  --font-mono:  ui-monospace, SFMono-Regular, Menlo, Consolas,
                "Liberation Mono", monospace;
  --text-xs:   0.875rem;  /* 14px — captions, meta */
  --text-sm:   1rem;      /* 16px — UI labels, buttons */
  --text-base: 1.125rem;  /* 18px — default body copy */
  --text-lg:   1.375rem;  /* 22px — h3, lead-in text */
  --text-xl:   1.875rem;  /* 30px — h2 */
  --text-2xl:  2.5rem;    /* 40px — h1 */
  --text-3xl:  3.5rem;    /* 56px — hero display headline */
  --leading-tight:  1.15; /* headings */
  --leading-normal: 1.6;  /* body copy */
  --weight-regular:  400;
  --weight-semibold: 600;
  --weight-bold:     700;

  /* ---- Spacing (8px base, 4px half-step) ---- */
  --space-1: 0.25rem;  --space-2: 0.5rem;  --space-3: 0.75rem;
  --space-4: 1rem;     --space-5: 1.5rem;  --space-6: 2rem;
  --space-7: 3rem;     --space-8: 4rem;    --space-9: 6rem;

  /* ---- Layout ---- */
  --layout-max:    1280px; /* maximum content width */
  --layout-gutter: var(--space-5);

  /* ---- Shape & focus ---- */
  --radius:        2px;    /* a hair of softness — never more */
  --border-hairline: 1px solid var(--color-border);
  --focus-color:   #1c1a17;
  --focus-width:   3px;
  --focus-offset:  2px;

  /* ---- Elevation ---- */
  --shadow-card:    0 1px 3px rgba(28, 26, 23, 0.12);
  --shadow-overlay: 0 8px 24px rgba(28, 26, 23, 0.20);

  /* ---- Motion ---- */
  --duration: 180ms;
  --easing:   ease;
}
```

> **Rule:** components reference tokens only. A literal `#5b4129`, `18px`, or
> `"Georgia"` inside a component is a bug.

---

## 4. Colour

### Palette roles

| Token | Use it for | Never use it for |
|---|---|---|
| `--color-brand` | Primary buttons, links, active nav, key UI | Large fills behind body text |
| `--color-brand-deep` | Hover / active / pressed states | Default states |
| `--color-accent` (bronze) | **Thin** decorative accent rules only | Text, icons, fills — it fails text contrast |
| `--color-brand-wash` | Selected rows, quiet info panels | Text |
| `--color-ink` | All body text and most headings | Text on dark surfaces |
| `--color-ink-muted` | Secondary/supporting text, metadata | Anything that must be noticed |
| `--color-surface-warm` | Alternating sections, quiet panels | Borders |
| `--color-deep` | Footer band, occasional dark sections | Body backgrounds |

### Usage rules

- The interface is **predominantly warm white** with **dark warm text**. Brown
  is the colour of action and identity — not a background theme.
- Use **one** primary action colour (`--color-brand`). Do not introduce new
  hues. Status colours exist only for status.
- The bronze `--color-accent` is a signature detail — at most one thin rule per
  major region. It never carries text or meaning on its own.
- Never communicate meaning with colour alone (see §11): pair it with text, an
  icon, or a label.

### Verified contrast pairings (safe to use)

| Foreground | Background | Ratio |
|---|---|---|
| `--color-ink` #1c1a17 | white | ~15:1 |
| `--color-brand` #5b4129 | white | ~7.5:1 |
| white | `--color-brand` #5b4129 | ~7.5:1 |
| `--color-ink-muted` #57514a | white | ~7:1 |
| white | `--color-deep` #211b14 | ~16:1 |

Any new pairing must be checked: **4.5:1** for normal text, **3:1** for large
text (≥24px, or ≥19px bold) and for UI component boundaries.

---

## 5. Typography

The signature of this style is the pairing: **serif headlines, sans-serif body.**

### 5.1 Typefaces

- **Headings & display — serif**, via the `--font-serif` token. A classic,
  high-contrast serif gives the editorial, established voice. Use it for every
  `h1`–`h3`, the hero headline, and the wordmark-style logo text.
- **Body, UI & navigation — sans-serif**, via `--font-sans`. Clean and quiet,
  it keeps long text and controls highly legible.
- **Monospace — system stack** (`--font-mono`), strictly for code, figures, and
  command output.
- Both stacks are **system fonts** — no web-font files, no third-party CDN, no
  external requests. The interface renders correctly offline.
- **No third family.** No display, slab, script, or decorative fonts.

### 5.2 Type scale

| Role | Size token | Family | Weight | Line height |
|---|---|---|---|---|
| Hero display | `--text-3xl` | serif | 400 | 1.1 |
| h1 | `--text-2xl` | serif | 600 | 1.15 |
| h2 | `--text-xl` | serif | 600 | 1.2 |
| h3 | `--text-lg` | serif | 600 | 1.3 |
| Lead-in / intro | `--text-lg` | sans | 400 | 1.5 |
| Body | `--text-base` | sans | 400 | 1.6 |
| UI — buttons, labels, nav | `--text-sm` | sans | 400 / 600 | 1.5 |
| Caption / meta | `--text-xs` | sans | 400 | 1.5 |
| Eyebrow (uppercase label) | `--text-xs` | sans | 700 | 1.4, tracking 0.08em |

### 5.3 Rules

- **Weights:** only **400, 600, 700**. Serif headlines are usually 400–600;
  reserve 700 for emphasis. Never use 300, 500, 800, or 900.
- **Colour:** headings use `--color-ink`; `--color-brand` is allowed for the
  page `h1` only, applied consistently.
- **Heading levels** reflect document structure and never skip. Exactly one
  `h1` per page. Never pick a level for its size.
- **Body copy** is left-aligned — never justified. Line length capped at
  **70 characters** (`max-width: 70ch`); intro text at **60ch**.
- **Minimum rendered text size** is 14px (`--text-xs`).
- **No all-caps** sentences. Uppercase is allowed only for the short eyebrow
  label, with the tracking above.
- Numerals in tables and statistics use `font-variant-numeric: tabular-nums`.

---

## 6. Spacing & layout

- All margins, padding, and gaps come from the spacing scale. No arbitrary
  values.
- Be **generous**. This style breathes — `--space-7`–`--space-9` between major
  page regions, `--space-5`–`--space-6` between sections.
- Content sits in a centred column: `max-width: var(--layout-max)` with
  `--layout-gutter` side padding. Hero and photographic bands may be full-bleed.
- The canonical page is: **utility bar → brand header + primary nav → hero →
  main content → footer.**
- Align everything to a consistent grid. Ragged edges are not allowed.

### Breakpoints

| Name | Min width | Behaviour |
|---|---|---|
| `sm` | 480px | Single column, stacked |
| `md` | 768px | Two columns may appear; nav sits inline |
| `lg` | 1024px | Full desktop layout |
| `xl` | 1280px | Content reaches `--layout-max`, gutters grow |

Design mobile-first with `min-width` queries only. Below `md`, primary nav
collapses into a single menu button.

---

## 7. Shape, borders & elevation

- **Corners are nearly square:** `--radius: 2px` everywhere — buttons, inputs,
  cards, images. A whisper of softness, never a rounded look.
- **Borders** are thin, solid, single-colour, warm. Use `--border-hairline` for
  dividers and rules. Interactive boundaries use `--color-border-strong` or
  `--color-brand` (≥ 3:1).
- **Elevation is restrained.** Cards may use `--shadow-card` — a single soft,
  low shadow — to lift them gently off the page. `--shadow-overlay` is for
  floating layers (menus, modals) only. Never stack or exaggerate shadows.
- **No gradients** on surfaces, buttons, or text. The only acceptable gradient
  is a subtle dark scrim over a hero photograph for text legibility (§8.5).

---

## 8. Components

Every component: 2px corners, flat fill, token-based values, a visible focus
state, and a minimum interactive size of **44 × 44px**.

### 8.1 Utility bar (top)

- Thin full-bleed band, `--color-deep` background, `--color-inverse` text.
- Holds only low-level utilities: language/region switcher, login link.
- Optional: a single **2px** `--color-accent` rule directly beneath it.

### 8.2 Brand header & primary navigation

- White background, generous vertical padding (`--space-5`).
- The logo is a **serif wordmark** (`--font-serif`, `--color-ink`), set left.
  If a real logo asset exists, use it and never recolour or stretch it.
- Primary navigation is a horizontal row of links in `--font-sans`,
  `--weight-semibold`, `--color-ink`. Expandable items show a chevron and open
  a panel using `--shadow-overlay`.
- Hover/active nav item: `--color-brand` text, optionally with a 2px brand
  underline. The current section also carries `aria-current="page"`.
- Search and key utilities sit at the right of the header.

### 8.3 Hero

- Full-bleed **photograph** with a dark scrim (`linear-gradient` from
  transparent to `rgba(33,27,20,0.55)`) so overlaid text always meets contrast.
- Headline in serif `--text-3xl`, `--color-inverse`; one short supporting line
  beneath it.
- If no suitable photo exists, use a solid `--color-deep` panel instead — never
  place text on a busy image without a scrim or panel.

### 8.4 Breadcrumb & sub-navigation

- Breadcrumbs: `--text-sm`, links in `--color-brand`, separator a plain `›` in
  `--color-ink-muted`; the current page is not a link.
- Sub-navigation tabs: a horizontal row, centred under the hero; the active tab
  carries a 2px `--color-brand` underline and `aria-current`.

### 8.5 Cards & content blocks

- White surface, `--radius`, optional `--shadow-card`, internal padding
  `--space-5`–`--space-6`.
- A card headline is serif (`h3`); supporting text is sans, `--color-ink-muted`.
- Separate cards with `--space-5` of space. A whole clickable card must still
  expose a real link for assistive technology.

### 8.6 Buttons

Shared: 2px corners, `--weight-semibold`, `--text-sm`, `min-height: 48px`,
padding `--space-3 --space-5`, `2px solid` border box, transition
`background var(--duration)`. Sentence case.

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| **Primary** | `--color-brand` | inverse | transparent | `--color-brand-deep` |
| **Secondary** | `--color-surface` | `--color-brand` | `2px solid --color-brand` | bg `--color-brand-wash` |
| **Tertiary** | none | `--color-brand` | none | underline |

One primary button per view. Avoid disabled buttons; if unavoidable, use a
muted grey and explain what is needed nearby.

### 8.7 Links

- Colour `--color-brand`; underlined in body copy. Standalone navigational
  links may drop the underline but must underline on hover and show focus.
- Visited links keep the same colour. External links and downloads are labelled
  in text ("(PDF)"), never by colour or icon alone.

### 8.8 Forms & inputs

- Every field has a visible `<label>` above it, `--weight-semibold`. No
  placeholder-only labelling.
- Input: white background, `2px solid var(--color-border-strong)`, `--radius`,
  padding `--space-3`, `min-height: 48px`, font `--text-base`.
- Focus: border `--color-brand` **and** the standard focus outline (§11).
- Errors: field border `--color-error`, a message below prefixed with "Error:"
  and linked via `aria-describedby`. Never colour alone.

### 8.9 Footer

- Full-bleed band, `--color-deep` background, `--color-inverse` text and links.
- Organised into clear columns: about, key links, legal/accessibility
  statement, region. Generous padding (`--space-8` vertical).

### 8.10 Tables

- Plain. Horizontal `--border-hairline` rules between rows; no vertical rules.
- Header row: `--weight-bold`, bottom border `2px solid --color-ink`.
- Left-align text; right-align numbers (`tabular-nums`). Real `<th>` with `scope`.

---

## 9. Imagery & photography

- Large, authentic **documentary photography**: real people, real places,
  natural light. This style leans on imagery for warmth.
- Rectangular crops, 2px corners, consistent aspect ratios. No heavy filters,
  duotones, or drop shadows on photos.
- Every meaningful image has descriptive alt text; decorative images get an
  empty `alt=""`. No information lives only in an image.
- Charts reuse the palette: `--color-brand` for the primary series; never rely
  on colour alone to distinguish series.

---

## 10. Motion

- Motion is functional and quiet: hover/focus feedback, expand/collapse, and
  showing/hiding overlays only.
- Duration `--duration` (180ms), easing `--easing`. Nothing slower than 250ms.
- No parallax, autoplay, or attention-seeking animation.
- Always honour `prefers-reduced-motion: reduce` — disable non-essential
  transitions entirely.

---

## 11. Accessibility — hard requirements

Target **WCAG 2.2 Level AA** as a minimum. A build that fails any of the
following is not done.

- **Contrast:** ≥ 4.5:1 for normal text, ≥ 3:1 for large text and for the
  boundary of every UI component and meaningful graphic. Text over photographs
  always sits on a scrim or solid panel.
- **Visible focus:** every interactive element shows a clear indicator —
  `outline: var(--focus-width) solid var(--focus-color); outline-offset:
  var(--focus-offset);`. On dark or photographic surfaces use a white outline
  with a surrounding ring so it stays visible. Never remove outlines without an
  equal replacement.
- **Keyboard:** everything is operable by keyboard alone, in a logical order,
  with no traps. Provide a "skip to main content" link as the first focusable
  element.
- **Target size:** interactive controls are at least 24 × 24px; aim for
  44 × 44px.
- **Semantic structure:** real HTML landmarks (`header`, `nav`, `main`,
  `footer`). One `h1` per page; headings in order.
- **Don't rely on colour alone** for status, errors, required fields, or links.
- **Forms:** every control has a programmatically associated label; errors are
  described in text and linked with `aria-describedby`.
- **Images & media:** meaningful images have alt text; decorative ones empty
  alt.
- **Language:** set the page `lang`; the layout must absorb longer translated
  strings without breaking.
- **Motion:** respect `prefers-reduced-motion` (§10).
- Provide and link an **accessibility statement** in the footer.

---

## 12. Voice & tone

- **Considered and precise.** Clear, complete sentences. Confident, never
  boastful.
- **Formal but human.** Respectful and warm — never casual, never cold.
- **Honest.** Describe states accurately, including errors and limitations.
- Sentence case for headings, buttons, labels, and navigation.
- Be consistent: the same thing is called the same name everywhere.

---

## 13. Quick reference — do & don't

**Do**
- Build with tokens; keep generous whitespace and a strong grid.
- Pair serif headlines with sans-serif body — that contrast is the style.
- Lead with photography for warmth and content for substance.
- Keep one primary action per view; make focus obvious.

**Don't**
- No gradients (except a hero scrim), no heavy shadows, no rounded look.
- No second serif, no display or script fonts, no light/black weights.
- No decorative colour, no meaning-by-colour-alone, no all-caps sentences.
- No hard-coded hex, pixel, or font values inside components.

---

*One of two styles in `designs/`. Keep this document and the code in step —
update the design here first.*
