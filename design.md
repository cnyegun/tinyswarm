# Design System

A clean, restrained, government-grade visual language — inspired by the
Finnish Government website (valtioneuvosto.fi / Statsrådet).

This document is the **single source of truth** for how anything we build
should look and behave. Every screen, page, and component must follow it.
When in doubt, choose the calmer, plainer, more structured option.

---

## 1. How to use this document

- **Tokens first.** Section 3 defines every colour, size, and spacing value as
  a CSS custom property. Build with tokens — never hard-code a raw hex value,
  pixel size, or font name in a component.
- **Components second.** Section 8 specifies each reusable element. If you need
  something not listed, design it from the principles and tokens, then add it
  here so it stays consistent.
- **Accessibility is not optional.** Section 12 lists hard requirements. A
  design that fails them is not finished.
- Keep this file updated. A change to the style is a change to this document
  first, then the code.

---

## 2. Design principles

1. **Clarity over decoration.** Every element earns its place by helping the
   user read, understand, or act. If it only decorates, remove it.
2. **Trust through restraint.** This is an official, serious tone. No gradients,
   no glow, no playful illustration, no surprise. Confidence comes from calm.
3. **Structure and hierarchy.** Strong alignment, clear headings, generous
   whitespace, and obvious reading order. The layout should be understandable
   before a single word is read.
4. **Flat and rectangular.** Surfaces are flat. Corners are square. Edges are
   defined by space and thin rules, not shadows.
5. **Content first.** Text and real information lead. Images and UI chrome
   support the content; they never compete with it.
6. **Accessible by default.** High contrast, visible focus, keyboard support,
   and semantic structure are designed in from the start — not retrofitted.

---

## 3. Design tokens

Implement these once, globally, as CSS custom properties. All components
reference them by name.

```css
:root {
  /* ---- Brand ---- */
  --color-primary:        #003580; /* government blue — primary brand colour */
  --color-primary-dark:   #00265c; /* hover / active states */
  --color-primary-darker: #001a40; /* pressed state, deep footer */
  --color-primary-tint:   #e6ebf3; /* pale blue background wash */
  --color-accent:         #7b2d8e; /* violet — a single thin accent line only */

  /* ---- Neutrals ---- */
  --color-text:           #1a1a1a; /* primary body text (near-black) */
  --color-text-muted:     #595959; /* secondary text, captions */
  --color-text-inverse:   #ffffff; /* text on dark/blue surfaces */
  --color-surface:        #ffffff; /* default page & card background */
  --color-surface-subtle: #f3f3f3; /* alternating sections, quiet panels */
  --color-border:         #c9c9c9; /* hairlines, dividers, table rules */
  --color-border-input:   #595959; /* form-control boundaries (>= 3:1) */

  /* ---- Status ---- */
  --color-success:        #0a7d3c;  --color-success-bg: #e7f2eb;
  --color-warning:        #8a6100;  --color-warning-bg: #fbf0d4;
  --color-error:          #b3171f;  --color-error-bg:   #fae7e8;
  --color-info:           #003580;  --color-info-bg:    #e6ebf3;

  /* ---- Typography ---- */
  --font-sans: "Helvetica Neue", Helvetica, Arial, "Liberation Sans",
               system-ui, sans-serif;
  --text-xs:   0.875rem;  /* 14px — captions, meta */
  --text-sm:   1rem;      /* 16px — UI labels, buttons, dense text */
  --text-base: 1.125rem;  /* 18px — default body copy */
  --text-lg:   1.375rem;  /* 22px — h3, lead-in text */
  --text-xl:   1.75rem;   /* 28px — h2 */
  --text-2xl:  2.25rem;   /* 36px — h1 */
  --text-3xl:  2.75rem;   /* 44px — display / hero headline */
  --leading-tight:  1.25; /* headings */
  --leading-normal: 1.6;  /* body copy */
  --weight-regular:  400;
  --weight-semibold: 600;
  --weight-bold:     700;

  /* ---- Spacing (8px base, 4px half-step) ---- */
  --space-1: 0.25rem;  /*  4px */
  --space-2: 0.5rem;   /*  8px */
  --space-3: 0.75rem;  /* 12px */
  --space-4: 1rem;     /* 16px */
  --space-5: 1.5rem;   /* 24px */
  --space-6: 2rem;     /* 32px */
  --space-7: 3rem;     /* 48px */
  --space-8: 4rem;     /* 64px */
  --space-9: 6rem;     /* 96px */

  /* ---- Layout ---- */
  --layout-max:    1200px; /* maximum content width */
  --layout-gutter: var(--space-5);

  /* ---- Shape & focus ---- */
  --radius: 0;             /* square corners everywhere — no exceptions */
  --border-hairline: 1px solid var(--color-border);
  --focus-color:  #1a1a1a; /* focus outline colour */
  --focus-width:  3px;
  --focus-offset: 2px;

  /* ---- Elevation (floating layers only) ---- */
  --shadow-overlay: 0 2px 8px rgba(0, 0, 0, 0.18);

  /* ---- Motion ---- */
  --duration: 160ms;
  --easing:   ease;
}
```

> **Rule:** components reference tokens only. A literal `#003580`, `16px`, or
> `"Helvetica"` inside a component is a bug.

---

## 4. Colour

### Palette roles

| Token | Use it for | Never use it for |
|---|---|---|
| `--color-primary` | Logo, primary buttons, links, header band, key UI | Large background fills behind body text |
| `--color-primary-dark` / `-darker` | Hover/active states, footer | Default states |
| `--color-primary-tint` | Selected rows, quiet info panels, hover on light buttons | Text |
| `--color-accent` (violet) | **One** thin horizontal accent rule, as a brand detail | Text, fills, icons, more than one element per screen |
| `--color-text` | All body text and most headings | Text on dark backgrounds |
| `--color-text-muted` | Secondary/supporting text, metadata | Primary content, anything that must be noticed |
| `--color-surface` | Page and card backgrounds | — |
| `--color-surface-subtle` | Alternating sections, low-emphasis panels | Borders |

### Usage rules

- The interface is **predominantly white** with **dark text**. Blue is an
  accent for action and identity — it is not a background theme.
- Use **one** primary action colour. Do not introduce new hues. The status
  colours exist only for status.
- Never communicate meaning with colour alone (see §12). Pair it with text,
  an icon, or a label.
- The violet `--color-accent` is a signature detail, not a UI colour. At most
  one thin line per page.

### Verified contrast pairings (safe to use)

| Foreground | Background | Ratio |
|---|---|---|
| `--color-text` #1a1a1a | white | ~16:1 |
| `--color-primary` #003580 | white | ~10.8:1 |
| white | `--color-primary` #003580 | ~10.8:1 |
| `--color-text-muted` #595959 | white | ~7:1 |
| `--color-error` #b3171f | white | ~6.4:1 |

Any new pairing must be checked: **4.5:1** for normal text, **3:1** for large
text (≥24px, or ≥19px bold) and for UI component boundaries.

---

## 5. Typography

### Typeface

- **One family**: a neutral humanist sans-serif via `--font-sans`. The system
  stack is intentional — it is fast, reliable, and unbranded, which suits an
  official tone. Do not add a second UI typeface and do not use serifs,
  display, or script fonts.
- The logo wordmark is a fixed logotype (an image/SVG asset). Never recreate it
  with live text.

### Type scale

| Element | Size | Weight | Line height | Notes |
|---|---|---|---|---|
| Display / hero | `--text-3xl` | 700 | 1.25 | One per page, optional |
| h1 | `--text-2xl` | 700 | 1.25 | Exactly one per page |
| h2 | `--text-xl` | 700 | 1.25 | Section titles |
| h3 | `--text-lg` | 600 | 1.3 | Sub-sections |
| h4 | `--text-base` | 700 | 1.3 | Minor headings |
| Body | `--text-base` | 400 | 1.6 | Default text |
| UI / dense | `--text-sm` | 400–600 | 1.5 | Buttons, labels, controls |
| Caption / meta | `--text-xs` | 400 | 1.5 | `--color-text-muted` |

### Rules

- **Headings** use `--color-text` by default. `--color-primary` is permitted
  for the page `h1` and major section headings — but if you use it, use it
  consistently across the whole product.
- Heading levels descend without skipping (`h1 → h2 → h3`). Levels reflect
  document structure, never font size — restyle with the scale above.
- Body copy: left-aligned, never justified. Measure (line length) capped at
  **~70 characters** (`max-width: 70ch`).
- Weights: only 400, 600, 700. No light or black weights. No italics except
  genuine semantic emphasis.
- No all-caps for sentences or buttons. Small uppercase is allowed only for
  short eyebrow labels with letter-spacing `0.06em`.
- Never centre paragraphs. Headings may be centred only in rare hero contexts.

---

## 6. Spacing & layout

### Spacing

- All margins, padding, and gaps come from the spacing scale. No arbitrary
  values.
- Default rhythm: `--space-4` between related items, `--space-6`–`--space-7`
  between sections, `--space-8`+ around major page regions.
- Be generous. Whitespace is the primary tool for hierarchy and calm.

### Page structure

- Content sits in a centred column: `max-width: var(--layout-max)` with
  `--layout-gutter` side padding.
- The canonical page is: **utility bar → brand header → (optional accent line)
  → main content → footer**.
- A two-column "navigation + content" layout is the default for section pages:
  a vertical menu on the left, content/media on the right (see §8.4).
- Align everything to a consistent grid. Ragged left edges and one-off indents
  are not allowed.

### Breakpoints

| Name | Min width | Behaviour |
|---|---|---|
| `sm` | 480px | Single column, stacked |
| `md` | 768px | Two columns may appear; nav can sit beside content |
| `lg` | 1024px | Full desktop layout |
| `xl` | 1280px | Content column reaches `--layout-max`, gutters grow |

Design mobile-first. Below `md`, the left navigation collapses above the
content as a full-width stacked list.

---

## 7. Shape, borders & elevation

- **Corners are square. `--radius: 0` everywhere** — buttons, inputs, cards,
  images, banners, avatars. This is a defining trait. No exceptions.
- **Borders** are thin, solid, single-colour. Use `--border-hairline` for
  dividers and table rules. Interactive component boundaries use a colour that
  meets 3:1 (`--color-border-input` or `--color-primary`).
- **No shadows on static elements.** Separation comes from whitespace and
  hairlines. The only permitted shadow is `--shadow-overlay`, used solely for
  layers that float above the page (dropdown menus, modals, the mobile menu).
- **No gradients** on surfaces, buttons, or text. Flat fills only.

---

## 8. Components

Every component: square corners, flat fill, token-based values, a visible
focus state, and a minimum interactive size of **44 × 44px**.

### 8.1 Utility bar (top)

- Full-bleed band, `--color-primary` background, `--color-text-inverse` text.
- Height ~48px; content vertically centred; font `--text-xs`/`--text-sm`.
- Holds only low-level utilities: organisation switcher, language selector.
- Optional brand detail: a single **3px** `--color-accent` line directly below
  the bar. Use it once, or not at all.

### 8.2 Brand header & logo

- White background, generous vertical padding (`--space-5`).
- Logo lockup (coat-of-arms mark + wordmark) sits left, as an SVG asset.
  Protect it with clear space equal to the mark's height; never recolour,
  stretch, rotate, or add effects.
- Search and a small contact/quick link sit right.

### 8.3 Search

- Rectangular text input + a solid `--color-primary` square button bearing a
  search icon. Button is the same height as the input; corners square.
- Input border `1px solid var(--color-border-input)`; placeholder in
  `--color-text-muted`.

### 8.4 Navigation — primary (vertical list)

- A plain vertical list of links.
- Each item: padding `--space-4` vertical, `--text-base`, `--weight-bold`,
  colour `--color-text`.
- Items are separated by a `--border-hairline` between them.
- Expandable items show a chevron (`v`) at the right edge.
- Hover: text `--color-primary` and/or background `--color-surface-subtle`.
- Current page: `--color-primary` text plus a 4px `--color-primary` left edge
  marker — and an accessible `aria-current="page"`.

### 8.4b Navigation — breadcrumb & inline

- Breadcrumbs: `--text-sm`, links in `--color-primary`, separator a plain `/`
  in `--color-text-muted`, current page not a link.

### 8.5 Buttons

Shared: square corners, `--weight-semibold`, `--text-sm`, `min-height: 48px`,
padding `--space-3 --space-5`, `2px solid` border box (so variants align),
transition `background var(--duration)`. Sentence case. No icon required; if
used, an icon sits left with `--space-2` gap.

| Variant | Background | Text | Border | Hover | Use |
|---|---|---|---|---|---|
| **Primary** | `--color-primary` | inverse | transparent | `--color-primary-dark` | The main action — one per view |
| **Secondary** | `--color-surface` | `--color-primary` | `2px solid --color-primary` | bg `--color-primary-tint` | Alternative actions |
| **Tertiary** | none | `--color-primary` | none | underline | Low-priority actions; looks like a link |

- Active/pressed: `--color-primary-darker`.
- Avoid disabled buttons; instead, keep them enabled and explain what's needed.
  If a disabled state is unavoidable: background `#6f6f6f`, no hover, and an
  accessible explanation nearby.
- Never more than one primary button in a group.

### 8.6 Links

- Colour `--color-primary`; underlined in body copy.
- Standalone navigational links may omit the underline but must underline on
  hover and show focus.
- Visited links keep the same colour (consistency over status here).
- External links and downloads are labelled in text (e.g. "(PDF)"), not by
  colour or icon alone.

### 8.7 Forms & inputs

- Every field has a visible `<label>` above it, in `--weight-semibold`. No
  placeholder-only labelling.
- Input: white background, `2px solid var(--color-border-input)`, square
  corners, padding `--space-3`, `min-height: 48px`, font `--text-base`.
- Focus: border `--color-primary` **and** the standard focus outline (§12).
- Help text sits below the label in `--color-text-muted` `--text-sm`.
- Errors: field border `--color-error`, an error message below the field
  prefixed with a clear word ("Error:"), and the message linked to the field
  via `aria-describedby`. Never indicate an error with colour alone.
- Required fields are marked in text ("required"), not with a bare asterisk.

### 8.8 Cards & content blocks

- White surface, optional `--border-hairline`, square corners, **no shadow**.
- Internal padding `--space-5`.
- A card is a grouping device, not a raised object. Separate cards with
  `--space-5` of space, not elevation.

### 8.9 Notifications & banners

- Full-width within the content column. White or tinted background, a **4px
  solid left border** in the status colour, dark text, square corners.
- Variants: info (`--color-info`), success, warning, error — each with its
  matching `*-bg` tint.
- Lead with a short bold summary line, then detail, then actions.
- Each banner carries a text label of its type and an appropriate icon — colour
  is never the only signal.
- The cookie/consent banner follows this pattern: white background, dark
  explanatory text, a primary and a secondary button, and a plain link to more
  information.

### 8.10 Hero & imagery block

- Hero images are large, square-cornered rectangles with no border or shadow.
- Image may sit beside content (two-column) or full-width above it.
- Never place low-contrast text directly on a busy photo; use a solid panel.

### 8.11 Footer

- Full-bleed band, `--color-primary-darker` background, `--color-text-inverse`
  text and links (links underlined on hover, always with visible focus).
- Organised into clear columns: contact, key links, accessibility statement,
  language. Generous padding (`--space-7` vertical).

### 8.12 Tables

- Plain. Horizontal `--border-hairline` rules between rows; no vertical rules,
  no zebra fills unless density truly requires it (`--color-surface-subtle`).
- Header row: `--weight-bold`, bottom border `2px solid --color-text`.
- Left-align text; right-align numbers. Real `<th>` with `scope`.

---

## 9. Iconography

- One icon set, one style: simple, geometric, line or solid, ~2px stroke.
- Default size 24px; inherit the surrounding text colour (`currentColor`).
- Icons support labels; they do not replace them. A standalone icon button
  needs an `aria-label`.
- No decorative, illustrative, or multicolour icons. No emoji in the UI.

---

## 10. Imagery & photography

- Authentic documentary photography: real people, real places, natural light.
- No staged stock clichés, no heavy filters, no duotones, no drop shadows.
- Rectangular crops, square corners, consistent aspect ratios.
- Every meaningful image has descriptive alt text; purely decorative images get
  empty `alt=""`.
- Charts and data visuals reuse the palette: `--color-primary` for the primary
  series; never rely on colour alone to distinguish series (use labels,
  patterns, or direct annotation).

---

## 11. Motion

- Motion is functional and quiet. Allowed only for: hover/focus feedback,
  expand/collapse, and showing/hiding overlays.
- Duration `--duration` (160ms), easing `--easing`. Nothing slower than 250ms.
- No parallax, no autoplaying media, no looping or attention-seeking animation,
  no motion that conveys information on its own.
- Always honour `prefers-reduced-motion: reduce` — disable non-essential
  transitions and animations entirely.

---

## 12. Accessibility — hard requirements

Target **WCAG 2.2 Level AA** as a minimum. A build that fails any of the
following is not done.

- **Contrast:** ≥ 4.5:1 for normal text, ≥ 3:1 for large text and for the
  boundary of every UI component and meaningful graphic.
- **Visible focus:** every interactive element shows a clear focus indicator:
  `outline: var(--focus-width) solid var(--focus-color); outline-offset:
  var(--focus-offset);`. On dark/blue surfaces, use a white outline with a
  surrounding ring so it stays visible against any background. Never remove
  outlines without an equal replacement.
- **Keyboard:** everything is operable by keyboard alone, in a logical order,
  with no traps. Provide a "skip to main content" link as the first focusable
  element.
- **Target size:** interactive controls are at least 24 × 24px (2.2 minimum);
  aim for 44 × 44px.
- **Semantic structure:** use real HTML elements and landmarks (`header`,
  `nav`, `main`, `footer`). One `h1` per page; headings in order.
- **Don't rely on colour alone** to convey status, errors, required fields, or
  links — always pair with text, an icon, or underlines.
- **Forms:** every control has a programmatically associated label; errors are
  described in text and linked with `aria-describedby`.
- **Images & media:** meaningful images have alt text; decorative ones have
  empty alt; no information lives only in an image.
- **Language:** set the page `lang`; the design must accommodate multiple
  languages (and longer translated strings) without breaking layout.
- **Motion:** respect `prefers-reduced-motion` (§11).
- Provide and link an **accessibility statement** in the footer.

---

## 13. Voice & tone

- **Plain language.** Short sentences. Common words. Explain, don't impress.
- **Clear and direct.** Lead with what the user needs. Use active voice.
- **Formal but human.** Respectful and neutral — never casual, never cold.
- **Honest.** Describe states accurately, including errors and limitations.
- Sentence case for everything: headings, buttons, labels, navigation.
- Be consistent: the same thing is called the same name everywhere.

---

## 14. Quick reference — do & don't

**Do**
- Build with tokens; keep layouts on the grid; use generous whitespace.
- Keep corners square, surfaces flat, borders thin.
- Lead with content and clear headings.
- Make focus obvious and contrast strong.
- Use one primary action per view.

**Don't**
- No rounded corners, shadows on static elements, or gradients.
- No second typeface, no light/black weights, no all-caps sentences.
- No decorative colour, no rainbow of hues, no meaning-by-colour-alone.
- No emoji or multicolour icons in the UI.
- No parallax, autoplay, or decorative animation.
- No hard-coded hex, pixel, or font values inside components.

---

*Keep this document and the codebase in step. Update the design here first.*
