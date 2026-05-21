#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path


W = 1800
H = 1060


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def t(
    text: str,
    x: int,
    y: int,
    size: int = 24,
    weight: int = 500,
    color: str = "#172033",
    anchor: str = "middle",
    cls: str = "",
) -> str:
    class_attr = f' class="{cls}"' if cls else ""
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" '
        f'font-weight="{weight}" fill="{color}"{class_attr}>{esc(text)}</text>'
    )


def multiline(lines: list[str], x: int, y: int, size: int = 18, color: str = "#5a6475") -> str:
    return "\n".join(t(line, x, y + i * int(size * 1.35), size, 450, color) for i, line in enumerate(lines))


def node(x: int, y: int, w: int, h: int, n: str, title: str, body: list[str], accent: str = "#172033") -> str:
    return f'''
<g>
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="#ffffff" stroke="#cfd6e3" stroke-width="2"/>
  <circle cx="{x + 34}" cy="{y + 34}" r="18" fill="#f4f7fb" stroke="{accent}" stroke-width="1.8"/>
  {t(n, x + 34, y + 41, 16, 700, accent)}
  {t(title, x + w // 2 + 12, y + 41, 23, 700, "#172033")}
  <line x1="{x + 24}" y1="{y + 62}" x2="{x + w - 24}" y2="{y + 62}" stroke="#edf1f7" stroke-width="2"/>
  {multiline(body, x + w // 2, y + 91, 17)}
</g>'''


def lane(x: int, y: int, w: int, h: int, title: str) -> str:
    return f'''
<g>
  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5"/>
  {t(title, x + 26, y + 36, 16, 800, "#667085", "start", "mono")}
</g>'''


def arrow(x1: int, y1: int, x2: int, y2: int, label: str = "", dashed: bool = False) -> str:
    dash = 'stroke-dasharray="8 8"' if dashed else ""
    label_svg = ""
    if label:
        mx = (x1 + x2) // 2
        my = (y1 + y2) // 2
        label_svg = f'''
  <rect x="{mx - 82}" y="{my - 18}" width="164" height="28" rx="14" fill="#ffffff" stroke="#e2e8f0"/>
  {t(label, mx, my + 2, 13, 700, "#475467", cls="mono")}'''
    return f'''
<g>
  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#475467" stroke-width="2.5" marker-end="url(#arrow)" {dash}/>
  {label_svg}
</g>'''


def path_arrow(d: str, label: str, x: int, y: int) -> str:
    return f'''
<g>
  <path d="{d}" fill="none" stroke="#475467" stroke-width="2.5" marker-end="url(#arrow)" stroke-dasharray="8 8"/>
  <rect x="{x - 78}" y="{y - 18}" width="156" height="28" rx="14" fill="#ffffff" stroke="#e2e8f0"/>
  {t(label, x, y + 2, 13, 700, "#475467", cls="mono")}
</g>'''


def metric(x: int, y: int, label: str, value: str) -> str:
    return f'''
<g>
  <rect x="{x}" y="{y}" width="250" height="76" rx="12" fill="#ffffff" stroke="#cfd6e3" stroke-width="1.5"/>
  {t(value, x + 125, y + 34, 24, 800, "#172033", cls="mono")}
  {t(label, x + 125, y + 58, 13, 650, "#667085", cls="mono")}
</g>'''


def main() -> None:
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
<title id="title">Autonomous Accessibility Remediation System Flowchart</title>
<desc id="desc">Minimal scientific flowchart showing the scan, multi-agent review, fixer, deterministic validation, reviewer vote, decision, report, and iteration loop.</desc>
<defs>
  <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
    <path d="M 0 0 L 12 6 L 0 12 z" fill="#475467"/>
  </marker>
  <style>
    text {{ font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    .mono {{ font-family: "JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace; letter-spacing: 0.01em; }}
  </style>
</defs>

<rect width="{W}" height="{H}" fill="#f3f6fa"/>
<rect x="56" y="48" width="1688" height="964" rx="28" fill="#ffffff" stroke="#d9e0ea" stroke-width="2"/>

{t("Autonomous Accessibility Remediation System", 900, 105, 42, 800, "#172033")}
{t("A closed-loop multi-agent pipeline: audit → repair → validate → vote → report", 900, 141, 20, 450, "#667085")}

{lane(108, 190, 1584, 170, "INPUT + EVIDENCE COLLECTION")}
{lane(108, 406, 1584, 220, "AGENTIC REASONING + REPAIR")}
{lane(108, 672, 1584, 210, "DETERMINISTIC VALIDATION + GOVERNANCE")}

{node(150, 235, 260, 104, "1", "Scan", ["Fetch URL", "Save original.html", "Extract facts + axe"], "#175cd3")}
{node(505, 235, 300, 104, "2", "Brief", ["Preservation inventory", "Initial risk model", "Reviewer scopes"], "#175cd3")}
{node(900, 235, 350, 104, "3", "Source Evidence", ["facts.json", "axe.json / axe-full.json", "screenshot + original DOM"], "#175cd3")}

{node(150, 462, 320, 126, "4", "Specialist Review", ["Semantic", "Keyboard", "Cognitive", "Visual"], "#475467")}
{node(565, 462, 320, 126, "5", "Aggregate", ["Normalize findings", "Deduplicate", "Write solver-task.md"], "#475467")}
{node(980, 462, 340, 126, "6", "Fixer", ["cp original → transformed", "Edit in place", "Write solver-result.json"], "#9a3412")}
{node(1405, 462, 230, 126, "7", "Artifact", ["transformed.html", "Standalone page", "Brand preserved"], "#9a3412")}

{node(190, 728, 310, 126, "8", "Checks", ["Axe", "h1 + main", "Mobile overflow"], "#067647")}
{node(585, 728, 310, 126, "9", "Reviewer Vote", ["Accept / revise", "Blockers", "Quality score"], "#475467")}
{node(980, 728, 310, 126, "10", "Decision", ["Accept", "Continue", "Stop with risks"], "#475467")}
{node(1375, 728, 260, 126, "11", "Report", ["Before / after", "Evidence trail", "Residual risks"], "#175cd3")}

{arrow(410, 287, 505, 287)}
{arrow(805, 287, 900, 287)}
{arrow(1075, 339, 310, 462, "context")}
{arrow(470, 525, 565, 525)}
{arrow(885, 525, 980, 525)}
{arrow(1320, 525, 1405, 525)}
{arrow(1520, 588, 345, 728, "artifact")}
{arrow(500, 791, 585, 791)}
{arrow(895, 791, 980, 791)}
{arrow(1290, 791, 1375, 791)}
{path_arrow("M 1065 728 C 1045 650 990 628 910 618 C 730 596 600 620 515 680 C 455 723 420 724 400 728", "revise loop", 752, 648)}

<line x1="120" y1="918" x2="1680" y2="918" stroke="#e2e8f0" stroke-width="2"/>
{t("Observed runtime profile from logs", 150, 955, 15, 800, "#667085", "start", "mono")}
{metric(410, 938, "reviewer findings", "170s")}
{metric(690, 938, "fixer", "50s")}
{metric(970, 938, "axe/checks", "1.4s")}
{metric(1250, 938, "total run", "389s")}

{t("Key claim: stochastic agents propose and repair; deterministic checks gate every fixer turn.", 900, 1000, 18, 600, "#475467")}
</svg>
'''
    svg = "\n".join(line.rstrip() for line in svg.splitlines()) + "\n"
    out = Path("docs/swarm-flowchart.svg")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg, encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
