use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

use crate::app::{ActivityTone, App, RunStatus, StepStatus, reviewer_icon};

const BG: Color = Color::Black;
const FG: Color = Color::Gray;
const WHITE: Color = Color::White;
const CYAN: Color = Color::Cyan;
const GREEN: Color = Color::LightGreen;
const YELLOW: Color = Color::Yellow;
const RED: Color = Color::LightRed;
const BLUE: Color = Color::LightBlue;
const PURPLE: Color = Color::LightMagenta;
const DIM: Color = Color::DarkGray;
const PANEL_PAD_X: u16 = 2;
const PANEL_PAD_Y: u16 = 1;

pub fn draw(frame: &mut Frame, app: &App) {
    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(5),
            Constraint::Min(24),
            Constraint::Length(4),
        ])
        .spacing(1)
        .split(frame.area());

    draw_header(frame, root[0], app);
    draw_dashboard(frame, root[1], app);
    draw_footer(frame, root[2], app);
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block("");
    let inner = padded(block.inner(area), 1, 0);
    frame.render_widget(block, area);
    let title = if app.profile == "accessibility" {
        "SWARM A11Y"
    } else {
        "SWARM"
    };
    let preview = if app.local_url == "pending" {
        vec![styled("● ", DIM), styled("Local preview: pending", DIM)]
    } else {
        vec![
            styled("● ", GREEN),
            Span::raw("Local preview: "),
            styled_mod(clip(&app.local_url, 38), CYAN, Modifier::UNDERLINED),
        ]
    };
    let mut status_line = vec![
        Span::raw("Status: "),
        styled_mod(
            status_label(app.status),
            status_color(app.status),
            Modifier::UNDERLINED,
        ),
        divider(),
        Span::raw("Target: "),
        styled(clip(&app.target, 34), CYAN),
        divider(),
        Span::raw("Model: "),
        styled(clip(&app.model, 32), CYAN),
        divider(),
        Span::raw("Run: "),
        styled(clip(&app.run_dir, 34), CYAN),
        divider(),
        Span::raw("Iteration: "),
        styled(app.current_iteration.to_string(), GREEN),
        Span::raw(format!(" / {}", app.max_iterations)),
        divider(),
    ];
    status_line.extend(preview);

    let lines = vec![
        Line::from(styled_mod(title, CYAN, Modifier::BOLD)),
        Line::from(status_line),
    ];
    frame.render_widget(
        Paragraph::new(lines).style(Style::default().bg(BG).fg(FG)),
        inner,
    );
}

fn draw_dashboard(frame: &mut Frame, area: Rect, app: &App) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
        .spacing(1)
        .split(area);

    let top = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(19),
            Constraint::Percentage(47),
            Constraint::Percentage(34),
        ])
        .spacing(1)
        .split(rows[0]);
    draw_workflow(frame, top[0], app);
    draw_overview(frame, top[1], app);
    draw_reviewers(frame, top[2], app);

    let bottom = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(66), Constraint::Percentage(34)])
        .spacing(1)
        .split(rows[1]);
    draw_activity(frame, bottom[0], app);
    draw_artifacts(frame, bottom[1], app);
}

fn draw_workflow(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(" WORKFLOW ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let content = padded(inner, PANEL_PAD_X, 0);

    let mut lines = Vec::new();
    lines.push(Line::from(""));
    lines.push(workflow_line("Scan", app.scan_status, content.width));
    lines.push(connector_line());
    lines.push(workflow_line("Brief", app.brief_status, content.width));
    lines.push(connector_line());
    for (index, status) in app.iteration_statuses.iter().enumerate() {
        lines.push(workflow_line(
            &format!("Iteration {}", index + 1),
            *status,
            content.width,
        ));
        lines.push(connector_line());
    }
    lines.push(workflow_line("Report", app.report_status, content.width));
    lines.push(connector_line());
    lines.push(workflow_line("Preview", app.preview_status, content.width));
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), content);
}

fn draw_overview(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(" OVERVIEW ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height < 8 || inner.width < 40 {
        frame.render_widget(
            Paragraph::new("terminal too small").style(Style::default().fg(DIM)),
            inner,
        );
        return;
    }

    let content = padded(inner, PANEL_PAD_X, PANEL_PAD_Y);
    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(6),
            Constraint::Length(3),
            Constraint::Min(0),
        ])
        .split(content);
    let metrics = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
            Constraint::Percentage(20),
        ])
        .spacing(2)
        .split(sections[0]);

    draw_metric_column(
        frame,
        metrics[0],
        "󰒃",
        "Axe violations",
        metric_value(app.axe_violations),
        metric_state(app.axe_violations),
        RED,
    );
    draw_metric_column(
        frame,
        metrics[1],
        "",
        "Checks",
        metric_value(app.failures),
        app.check_label().to_string(),
        YELLOW,
    );
    draw_metric_column(
        frame,
        metrics[2],
        "",
        "Files written",
        app.files_written.to_string(),
        if app.files_written > 0 {
            "ready"
        } else {
            "pending"
        }
        .to_string(),
        GREEN,
    );
    draw_metric_column(
        frame,
        metrics[3],
        "",
        "Accept votes",
        format!("{} / {}", app.accept_votes(), app.reviewers.len()),
        if app.pending_votes() == 0 {
            "complete"
        } else {
            "pending"
        }
        .to_string(),
        PURPLE,
    );
    draw_metric_column(
        frame,
        metrics[4],
        "",
        "Preview port",
        app.preview_port
            .map_or("-".to_string(), |port| port.to_string()),
        if app.preview_port.is_some() {
            "ready"
        } else {
            "pending"
        }
        .to_string(),
        BLUE,
    );

    let checks_color = match app.checks_passed {
        Some(true) => GREEN,
        Some(false) => RED,
        None => YELLOW,
    };
    let summary = Line::from(vec![
        Span::raw("Automated checks: "),
        styled(app.check_label(), checks_color),
        divider(),
        Span::raw("Last check: "),
        styled(app.last_check.clone(), WHITE),
        divider(),
        Span::raw("Result: "),
        styled(app.check_result_label(), checks_color),
        divider(),
        Span::raw("Decision: "),
        styled(app.decision.clone(), CYAN),
    ]);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(styled("─".repeat(sections[1].width as usize), DIM)),
            summary,
        ])
        .alignment(Alignment::Center),
        sections[1],
    );
}

fn draw_metric_column(
    frame: &mut Frame,
    area: Rect,
    icon: &str,
    label: &str,
    value: String,
    state: String,
    color: Color,
) {
    let lines = vec![
        Line::from(vec![
            styled(icon, color),
            Span::raw("  "),
            styled_mod(value, WHITE, Modifier::BOLD),
        ]),
        Line::from(""),
        Line::from(Span::raw(label.to_string())),
        Line::from(styled(state, color)),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .alignment(Alignment::Center)
            .style(Style::default().fg(FG)),
        area,
    );
}

fn draw_reviewers(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(" REVIEWERS ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height < 7 {
        return;
    }
    let content = padded(inner, PANEL_PAD_X, PANEL_PAD_Y);
    let vote_height = 3;
    let list_height = content.height.saturating_sub(vote_height);
    let list_area = Rect::new(content.x, content.y, content.width, list_height);
    let mut lines = Vec::new();
    let max_reviewers = (list_height / 3).max(1) as usize;
    for (id, reviewer) in app.reviewers.iter().take(max_reviewers) {
        let risk = reviewer.risk.as_str();
        let vote = if reviewer.vote.is_empty() {
            "PENDING"
        } else {
            reviewer.vote.as_str()
        };
        lines.push(Line::from(vec![
            styled(format!("{}  ", reviewer_icon(id)), WHITE),
            styled_mod(format!("{:<11}", reviewer.name), WHITE, Modifier::BOLD),
            Span::raw("Risk: "),
            styled(format!("{:<8}", risk), risk_color(risk)),
            styled(format!("[{vote}]"), vote_color(vote)),
            Span::raw("  ›"),
        ]));
        lines.push(Line::from(vec![
            Span::raw("    "),
            Span::raw(clip(
                &reviewer.summary,
                list_area.width.saturating_sub(5) as usize,
            )),
        ]));
        lines.push(Line::from(""));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(FG))
            .wrap(Wrap { trim: true }),
        list_area,
    );

    let vote_area = Rect::new(
        content.x,
        content.y + list_height,
        content.width,
        vote_height,
    );
    let vote_line = Line::from(vec![
        Span::raw("Votes   "),
        styled(format!("{} accept", app.accept_votes()), GREEN),
        divider(),
        styled(format!("{} block", app.block_votes()), RED),
        divider(),
        styled(format!("{} pending", app.pending_votes()), YELLOW),
    ]);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(styled("─".repeat(vote_area.width as usize), DIM)),
            vote_line,
        ]),
        vote_area,
    );
}

fn draw_activity(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(" RECENT ACTIVITY ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height < 5 {
        return;
    }
    let content = padded(inner, PANEL_PAD_X, PANEL_PAD_Y);

    let live_height = 3;
    let list_area = Rect::new(
        content.x,
        content.y,
        content.width,
        content.height.saturating_sub(live_height),
    );
    let live_area = Rect::new(
        content.x,
        content.y + content.height.saturating_sub(live_height),
        content.width,
        live_height,
    );
    let height = list_area.height as usize;
    let start = app.activity.len().saturating_sub(height);
    let lines: Vec<Line> = app.activity[start..]
        .iter()
        .map(|entry| {
            Line::from(vec![
                styled(format!("{:<8}", entry.time), DIM),
                Span::raw("  "),
                styled(
                    format!("[{:<8}]", clip(&entry.phase, 8)),
                    phase_color(&entry.phase),
                ),
                Span::raw("   "),
                styled(entry.icon.clone(), tone_color(entry.tone)),
                Span::raw("  "),
                Span::raw(clip(
                    &entry.text,
                    list_area.width.saturating_sub(28) as usize,
                )),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), list_area);

    let live = Line::from(vec![
        Span::raw("Live: "),
        styled(app.live_phase.clone(), phase_color(&app.live_phase)),
        Span::raw("  "),
        styled(
            clip(&app.live_text, live_area.width.saturating_sub(18) as usize),
            YELLOW,
        ),
    ]);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(styled("─".repeat(live_area.width as usize), DIM)),
            live,
        ]),
        live_area,
    );
}

fn draw_artifacts(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block(" ARTIFACTS ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let content = padded(inner, PANEL_PAD_X, PANEL_PAD_Y);
    let lines = vec![
        artifact_line("󰈙", "brief.md", app.artifact_ready("brief.md"), "ready"),
        Line::from(""),
        artifact_line(
            "󰈙",
            "report.html",
            app.artifact_ready("report.html"),
            "pending",
        ),
        Line::from(""),
        artifact_line(
            "",
            &app.artifact,
            app.artifact_ready(&app.artifact),
            "pending",
        ),
        Line::from(""),
        artifact_line("", &clip(&app.run_dir, 32), app.run_open(), "open"),
        Line::from(""),
        Line::from(styled("─".repeat(content.width as usize), DIM)),
        Line::from(vec![
            Span::raw("Run dir: "),
            styled(
                clip(&app.run_dir, content.width.saturating_sub(9) as usize),
                CYAN,
            ),
        ]),
        Line::from(vec![
            Span::raw("Log: "),
            styled(
                clip(&app.log_file, content.width.saturating_sub(5) as usize),
                CYAN,
            ),
        ]),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(FG))
            .wrap(Wrap { trim: true }),
        content,
    );
}

fn artifact_line(icon: &str, name: &str, ready: bool, fallback: &str) -> Line<'static> {
    let status = if ready { "ready" } else { fallback };
    let color = if ready { GREEN } else { DIM };
    Line::from(vec![
        styled(icon, WHITE),
        Span::raw("  "),
        Span::raw(name.to_string()),
        Span::raw("      "),
        styled(if ready { " " } else { "◌ " }, color),
        styled(status, color),
    ])
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let block = panel_block("");
    let inner = padded(block.inner(area), 1, 0);
    frame.render_widget(block, area);
    let command = Line::from(vec![
        styled("› ", GREEN),
        styled(
            clip(&app.command, inner.width.saturating_sub(55) as usize),
            CYAN,
        ),
        Span::raw("    "),
        styled("q", CYAN),
        Span::raw(" quit    "),
        styled("j", CYAN),
        Span::raw(" down    "),
        styled("k", CYAN),
        Span::raw(" up    "),
        styled("/", CYAN),
        Span::raw(" search    "),
        styled("?", CYAN),
        Span::raw(" help"),
    ]);

    let tabs = Line::from(vec![
        Span::raw("  1: "),
        styled_mod("opencode*", CYAN, Modifier::BOLD),
        Span::raw("      2: npm-logs      3: server"),
        Span::raw("      "),
        styled(app.last_clock.clone(), DIM),
    ]);
    frame.render_widget(Paragraph::new(vec![command, tabs]), inner);
}

fn workflow_line(label: &str, status: StepStatus, width: u16) -> Line<'static> {
    let (icon, color, text) = match status {
        StepStatus::Queued => ("○", DIM, "queued"),
        StepStatus::Active => ("●", CYAN, "active"),
        StepStatus::Completed => ("✓", GREEN, "completed"),
        StepStatus::Failed => ("×", RED, "failed"),
    };
    let label_width = width.saturating_sub(14).max(10) as usize;
    Line::from(vec![
        styled("  ", DIM),
        styled(icon, color),
        Span::raw("  "),
        styled(
            format!("{label:<label_width$}"),
            if status == StepStatus::Active {
                CYAN
            } else {
                WHITE
            },
        ),
        styled(text, color),
    ])
}

fn connector_line() -> Line<'static> {
    Line::from(vec![Span::raw("  "), styled("│", DIM)])
}

fn panel_block(title: &str) -> Block<'static> {
    Block::default()
        .title(styled_mod(title, CYAN, Modifier::BOLD))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM))
        .style(Style::default().bg(BG).fg(FG))
}

fn status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Starting => "Starting",
        RunStatus::Running => "Running",
        RunStatus::Completed => "Completed",
        RunStatus::Failed => "Failed",
    }
}

fn status_color(status: RunStatus) -> Color {
    match status {
        RunStatus::Starting => YELLOW,
        RunStatus::Running | RunStatus::Completed => GREEN,
        RunStatus::Failed => RED,
    }
}

fn metric_value(value: Option<u64>) -> String {
    value.map_or("-".to_string(), |value| value.to_string())
}

fn metric_state(value: Option<u64>) -> String {
    if value.is_some() { "ready" } else { "pending" }.to_string()
}

fn risk_color(value: &str) -> Color {
    match value {
        "low" => GREEN,
        "medium" => YELLOW,
        "high" => RED,
        "pending" => YELLOW,
        _ => DIM,
    }
}

fn vote_color(value: &str) -> Color {
    match value.to_ascii_lowercase().as_str() {
        "accept" => GREEN,
        "block" => RED,
        "revise" => YELLOW,
        _ => YELLOW,
    }
}

fn tone_color(tone: ActivityTone) -> Color {
    match tone {
        ActivityTone::Info => BLUE,
        ActivityTone::Success => GREEN,
        ActivityTone::Warning | ActivityTone::Waiting => YELLOW,
        ActivityTone::Error => RED,
    }
}

fn phase_color(phase: &str) -> Color {
    match phase {
        "scan" | "review" | "check" | "server" => CYAN,
        "brief" | "iter" => GREEN,
        "fix" | "decide" => YELLOW,
        "error" => RED,
        _ => BLUE,
    }
}

fn styled<T: Into<String>>(text: T, color: Color) -> Span<'static> {
    Span::styled(text.into(), Style::default().fg(color))
}

fn styled_mod<T: Into<String>>(text: T, color: Color, modifier: Modifier) -> Span<'static> {
    Span::styled(
        text.into(),
        Style::default().fg(color).add_modifier(modifier),
    )
}

fn divider() -> Span<'static> {
    styled("   │   ", DIM)
}

fn padded(area: Rect, x: u16, y: u16) -> Rect {
    Rect::new(
        area.x.saturating_add(x),
        area.y.saturating_add(y),
        area.width.saturating_sub(x * 2),
        area.height.saturating_sub(y * 2),
    )
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    if max <= 1 {
        return "…".to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}
