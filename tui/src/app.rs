use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::events::SwarmEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Starting,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Queued,
    Active,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityTone {
    Info,
    Success,
    Warning,
    Error,
    Waiting,
}

#[derive(Debug, Clone)]
pub struct ReviewerState {
    pub name: String,
    pub risk: String,
    pub vote: String,
    pub summary: String,
}

impl ReviewerState {
    fn new(id: &str, name: &str) -> Self {
        Self {
            name: if name.is_empty() {
                title_case(id)
            } else {
                short_role_name(name)
            },
            risk: "pending".to_string(),
            vote: String::new(),
            summary: default_reviewer_summary(id),
        }
    }
}

#[derive(Debug)]
pub struct App {
    pub command: String,
    pub status: RunStatus,
    pub profile: String,
    pub target: String,
    pub model: String,
    pub agent: String,
    pub run_dir: String,
    pub artifact: String,
    pub log_file: String,
    pub local_url: String,
    pub max_iterations: u64,
    pub current_iteration: u64,
    pub scan_status: StepStatus,
    pub brief_status: StepStatus,
    pub report_status: StepStatus,
    pub preview_status: StepStatus,
    pub iteration_statuses: Vec<StepStatus>,
    pub checks_passed: Option<bool>,
    pub axe_violations: Option<u64>,
    pub failures: Option<u64>,
    pub decision: String,
    pub files_written: usize,
    pub preview_port: Option<u64>,
    pub reviewers: BTreeMap<String, ReviewerState>,
    pub activity: Vec<ActivityLine>,
    pub live_phase: String,
    pub live_text: String,
    pub last_check: String,
    pub last_clock: String,
    written_paths: BTreeSet<String>,
    decision_accepts: Option<u64>,
    decision_blocks: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ActivityLine {
    pub time: String,
    pub phase: String,
    pub icon: String,
    pub text: String,
    pub tone: ActivityTone,
}

impl App {
    pub fn new(args: Vec<String>) -> Self {
        Self {
            command: format!("npm run swarm:tui -- {}", args.join(" ")),
            status: RunStatus::Starting,
            profile: "accessibility".to_string(),
            target: args.last().cloned().unwrap_or_default(),
            model: "pending".to_string(),
            agent: "pending".to_string(),
            run_dir: "pending".to_string(),
            artifact: "transformed.html".to_string(),
            log_file: "swarm.log".to_string(),
            local_url: "pending".to_string(),
            max_iterations: 3,
            current_iteration: 0,
            scan_status: StepStatus::Queued,
            brief_status: StepStatus::Queued,
            report_status: StepStatus::Queued,
            preview_status: StepStatus::Queued,
            iteration_statuses: vec![StepStatus::Queued; 3],
            checks_passed: None,
            axe_violations: None,
            failures: None,
            decision: "pending".to_string(),
            files_written: 0,
            preview_port: None,
            reviewers: BTreeMap::new(),
            activity: Vec::new(),
            live_phase: "boot".to_string(),
            live_text: "waiting for swarm events".to_string(),
            last_check: "-".to_string(),
            last_clock: "--:--:--".to_string(),
            written_paths: BTreeSet::new(),
            decision_accepts: None,
            decision_blocks: None,
        }
    }

    pub fn apply_event(&mut self, event: &SwarmEvent) {
        self.last_clock = event.clock();
        match event.kind().unwrap_or_default() {
            "run_start" => self.apply_run_start(event),
            "phase" => self.apply_phase(event),
            "iteration" => self.apply_iteration(event),
            "prompt" => self.apply_prompt(event),
            "check" => self.apply_check(event),
            "decision" => self.apply_decision(event),
            "reviewer" => self.apply_reviewer(event),
            "serve" => self.apply_serve(event),
            "run_complete" => self.apply_run_complete(event),
            "progress" => self.apply_progress(event),
            "error" | "fatal" => {
                self.status = RunStatus::Failed;
                self.push_activity_at(
                    event.clock(),
                    "error",
                    "",
                    event.str("message").unwrap_or("unknown error"),
                    ActivityTone::Error,
                );
            }
            _ => {}
        }
    }

    pub fn push_activity(&mut self, phase: &str, text: String) {
        self.push_activity_at(
            self.last_clock.clone(),
            phase,
            icon_for_phase(phase, ActivityTone::Info),
            text,
            ActivityTone::Info,
        );
    }

    pub fn process_exited(&mut self, code: i32) {
        if self.status != RunStatus::Completed {
            self.status = if code == 0 {
                RunStatus::Completed
            } else {
                RunStatus::Failed
            };
        }
        self.push_activity_at(
            self.last_clock.clone(),
            "process",
            if code == 0 { "" } else { "" },
            format!("node runner exited with code {code}"),
            if code == 0 {
                ActivityTone::Success
            } else {
                ActivityTone::Error
            },
        );
    }

    pub fn accept_votes(&self) -> u64 {
        let reviewer_accepts = self
            .reviewers
            .values()
            .filter(|reviewer| reviewer.vote == "accept")
            .count() as u64;
        if reviewer_accepts > 0 {
            reviewer_accepts
        } else {
            self.decision_accepts.unwrap_or(0)
        }
    }

    pub fn block_votes(&self) -> u64 {
        let reviewer_blocks = self
            .reviewers
            .values()
            .filter(|reviewer| reviewer.vote == "block")
            .count() as u64;
        if reviewer_blocks > 0 {
            reviewer_blocks
        } else {
            self.decision_blocks.unwrap_or(0)
        }
    }

    pub fn pending_votes(&self) -> u64 {
        let pending = self
            .reviewers
            .values()
            .filter(|reviewer| reviewer.vote.is_empty())
            .count() as u64;
        if pending > 0 {
            pending
        } else {
            self.reviewers
                .len()
                .saturating_sub((self.accept_votes() + self.block_votes()) as usize)
                as u64
        }
    }

    pub fn artifact_ready(&self, suffix: &str) -> bool {
        self.written_paths.iter().any(|path| path.ends_with(suffix))
    }

    pub fn run_open(&self) -> bool {
        self.run_dir != "pending"
    }

    pub fn check_label(&self) -> &'static str {
        match self.checks_passed {
            Some(true) => "PASS",
            Some(false) => "FAIL",
            None => "pending",
        }
    }

    pub fn check_result_label(&self) -> String {
        match (self.checks_passed, self.failures) {
            (Some(true), _) => "passing".to_string(),
            (Some(false), Some(failures)) => format!("{failures} failures"),
            (Some(false), None) => "failing".to_string(),
            (None, _) => "-".to_string(),
        }
    }

    fn apply_run_start(&mut self, event: &SwarmEvent) {
        self.status = RunStatus::Running;
        self.profile = event.str("profile").unwrap_or(&self.profile).to_string();
        self.target = event.str("input").unwrap_or(&self.target).to_string();
        self.model = event.str("model").unwrap_or("unknown").to_string();
        self.agent = event.str("agent").unwrap_or("build").to_string();
        self.run_dir = event.str("runDir").unwrap_or("runs/...").to_string();
        self.artifact = event.str("artifact").unwrap_or(&self.artifact).to_string();
        self.log_file = event.str("logFile").unwrap_or(&self.log_file).to_string();
        self.max_iterations = event.u64("maxIterations").unwrap_or(3);
        self.iteration_statuses = vec![StepStatus::Queued; self.max_iterations as usize];
        if let Some(reviewers) = event.array("reviewers") {
            for reviewer in reviewers {
                if let Some(id) = reviewer.get("id").and_then(Value::as_str) {
                    let name = reviewer.get("name").and_then(Value::as_str).unwrap_or(id);
                    self.reviewers
                        .entry(id.to_string())
                        .or_insert_with(|| ReviewerState::new(id, name));
                }
            }
        }
        self.live_phase = "run".to_string();
        self.live_text = format!("started {}", self.run_dir);
        self.push_activity_at(
            event.clock(),
            "run",
            "",
            self.live_text.clone(),
            ActivityTone::Info,
        );
    }

    fn apply_phase(&mut self, event: &SwarmEvent) {
        let status = status_from(event.str("status"));
        if event.str("phase") == Some("scan") {
            self.scan_status = status;
            match status {
                StepStatus::Active => self.push_activity_at(
                    event.clock(),
                    "scan",
                    "󰒋",
                    "Scan started",
                    ActivityTone::Info,
                ),
                StepStatus::Completed => self.push_activity_at(
                    event.clock(),
                    "scan",
                    "",
                    "Scan completed",
                    ActivityTone::Success,
                ),
                StepStatus::Failed => self.push_activity_at(
                    event.clock(),
                    "scan",
                    "",
                    event.str("error").unwrap_or("Scan failed"),
                    ActivityTone::Error,
                ),
                StepStatus::Queued => {}
            }
        }
    }

    fn apply_iteration(&mut self, event: &SwarmEvent) {
        let iteration = event.u64("iteration").unwrap_or(0);
        if iteration == 0 {
            return;
        }
        self.current_iteration = iteration;
        let index = (iteration - 1) as usize;
        if index < self.iteration_statuses.len() {
            self.iteration_statuses[index] = status_from(event.str("status"));
        }
        if event.str("status") == Some("active") {
            self.push_activity_at(
                event.clock(),
                "iter",
                "●",
                format!("Iteration {iteration} started"),
                ActivityTone::Info,
            );
        }
    }

    fn apply_prompt(&mut self, event: &SwarmEvent) {
        let phase = event.str("phase").unwrap_or("prompt");
        let status = event.str("status").unwrap_or("unknown");
        let agent = event.str("agent").unwrap_or("agent");
        let step_status = status_from(Some(status));
        if phase == "brief" {
            self.brief_status = step_status;
        }
        if phase == "report" {
            self.report_status = step_status;
        }
        if status == "done" {
            self.record_outputs(event);
        }
        let tone = match status {
            "done" => ActivityTone::Success,
            "failed" => ActivityTone::Error,
            "start" => ActivityTone::Info,
            _ => ActivityTone::Waiting,
        };
        if matches!(status, "start" | "done" | "failed") {
            let text = prompt_activity_text(phase, agent, status);
            self.live_phase = phase.to_string();
            self.live_text = text.clone();
            self.push_activity_at(
                event.clock(),
                phase,
                icon_for_phase(phase, tone),
                text,
                tone,
            );
        }
    }

    fn apply_check(&mut self, event: &SwarmEvent) {
        if event.str("status") == Some("start") {
            self.live_phase = "check".to_string();
            self.live_text = "Automated checks running".to_string();
            self.push_activity_at(
                event.clock(),
                "check",
                "",
                self.live_text.clone(),
                ActivityTone::Info,
            );
            return;
        }
        if let Some(passed) = event.bool("passed") {
            self.checks_passed = Some(passed);
        }
        self.failures = event.u64("failures").or(self.failures);
        self.axe_violations = event.u64("axeViolations").or(self.axe_violations);
        self.last_check = event.clock();
        let text = if self.checks_passed == Some(true) {
            "Automated checks passed".to_string()
        } else {
            format!(
                "Automated checks failed: {} failures",
                self.failures.unwrap_or(0)
            )
        };
        self.live_phase = "check".to_string();
        self.live_text = text.clone();
        self.push_activity_at(
            event.clock(),
            "check",
            if self.checks_passed == Some(true) {
                ""
            } else {
                ""
            },
            text,
            if self.checks_passed == Some(true) {
                ActivityTone::Success
            } else {
                ActivityTone::Warning
            },
        );
    }

    fn apply_decision(&mut self, event: &SwarmEvent) {
        self.decision_accepts = event.u64("accepts").or(self.decision_accepts);
        self.decision_blocks = event.u64("blocks").or(self.decision_blocks);
        self.decision = event.str("outcome").unwrap_or("pending").to_string();
        self.push_activity_at(
            event.clock(),
            "decision",
            "󰇘",
            format!("Decision: {}", self.decision),
            if self.decision == "accept" {
                ActivityTone::Success
            } else {
                ActivityTone::Warning
            },
        );
    }

    fn apply_reviewer(&mut self, event: &SwarmEvent) {
        let id = event.str("id").unwrap_or("reviewer").to_string();
        let reviewer = self
            .reviewers
            .entry(id.clone())
            .or_insert_with(|| ReviewerState::new(&id, &id));
        if let Some(risk) = event.str("risk") {
            reviewer.risk = risk.to_string();
        }
        if let Some(vote) = event.str("vote") {
            reviewer.vote = vote.to_string();
        }
        if let Some(summary) = event.str("summary") {
            reviewer.summary = summary.to_string();
        }
        let reviewer_name = reviewer.name.clone();
        let phase = event.str("phase").unwrap_or("reviewer");
        self.push_activity_at(
            event.clock(),
            &id,
            reviewer_icon(&id),
            format!("{reviewer_name} {phase} saved"),
            ActivityTone::Success,
        );
    }

    fn apply_serve(&mut self, event: &SwarmEvent) {
        self.preview_port = event.u64("port");
        self.local_url = event.str("localUrl").unwrap_or("pending").to_string();
        self.preview_status = StepStatus::Completed;
        self.push_activity_at(
            event.clock(),
            "server",
            "󰖟",
            format!("Preview server ready: {}", self.local_url),
            ActivityTone::Success,
        );
    }

    fn apply_run_complete(&mut self, event: &SwarmEvent) {
        self.status = RunStatus::Completed;
        self.run_dir = event.str("runDir").unwrap_or(&self.run_dir).to_string();
        self.log_file = event.str("logFile").unwrap_or(&self.log_file).to_string();
        self.local_url = event.str("localUrl").unwrap_or(&self.local_url).to_string();
        self.preview_status = StepStatus::Completed;
        self.push_activity_at(
            event.clock(),
            "run",
            "",
            "Swarm completed",
            ActivityTone::Success,
        );
    }

    fn apply_progress(&mut self, event: &SwarmEvent) {
        let phase = event.str("phase").unwrap_or("progress");
        let message = event.str("message").unwrap_or_default();
        let tone = tone_for_message(message);
        self.live_phase = phase.to_string();
        self.live_text = message.to_string();
        self.push_activity_at(
            event.clock(),
            phase,
            icon_for_phase(phase, tone),
            message,
            tone,
        );
    }

    fn record_outputs(&mut self, event: &SwarmEvent) {
        let Some(outputs) = event.array("outputs") else {
            return;
        };
        for output in outputs {
            if let Some(path) = output.get("path").and_then(Value::as_str) {
                self.written_paths.insert(path.to_string());
            } else if let Some(path) = output.as_str() {
                self.written_paths.insert(path.to_string());
            }
        }
        self.files_written = self.written_paths.len();
    }

    fn push_activity_at(
        &mut self,
        time: impl Into<String>,
        phase: &str,
        icon: impl Into<String>,
        text: impl Into<String>,
        tone: ActivityTone,
    ) {
        self.activity.push(ActivityLine {
            time: time.into(),
            phase: compact_phase(phase),
            icon: icon.into(),
            text: text.into(),
            tone,
        });
        if self.activity.len() > 300 {
            self.activity.drain(0..self.activity.len() - 300);
        }
    }
}

fn status_from(value: Option<&str>) -> StepStatus {
    match value {
        Some("start") | Some("active") | Some("accepted") => StepStatus::Active,
        Some("completed") | Some("done") | Some("passed") => StepStatus::Completed,
        Some("failed") => StepStatus::Failed,
        _ => StepStatus::Queued,
    }
}

fn prompt_activity_text(phase: &str, agent: &str, status: &str) -> String {
    match (phase, status) {
        ("brief", "done") => "Brief generated".to_string(),
        ("fix", "start") => "Fixer started".to_string(),
        ("fix", "done") => "Fixer wrote transformed artifact".to_string(),
        ("report", "done") => "Report generated".to_string(),
        (_, "done") => format!("{agent} completed {phase}"),
        (_, "failed") => format!("{agent} failed {phase}"),
        _ => format!("{agent} running {phase}"),
    }
}

fn tone_for_message(message: &str) -> ActivityTone {
    let lower = message.to_ascii_lowercase();
    if lower.contains("failure") || lower.contains("failed") || lower.contains("error") {
        ActivityTone::Error
    } else if lower.contains("waiting") || lower.contains("missing") {
        ActivityTone::Waiting
    } else if lower.contains("done") || lower.contains("passed") || lower.contains("completed") {
        ActivityTone::Success
    } else {
        ActivityTone::Info
    }
}

fn compact_phase(phase: &str) -> String {
    if phase.starts_with("iteration") {
        return "iter".to_string();
    }
    match phase {
        "findings" => "review".to_string(),
        "decision" => "decide".to_string(),
        _ => phase.chars().take(10).collect(),
    }
}

fn icon_for_phase(phase: &str, tone: ActivityTone) -> &'static str {
    if tone == ActivityTone::Error {
        return "";
    }
    if tone == ActivityTone::Waiting {
        return "";
    }
    if tone == ActivityTone::Success {
        return "";
    }
    match phase {
        "scan" => "󰒋",
        "brief" => "󰈙",
        "fix" => "󰁨",
        "check" => "",
        "server" => "󰖟",
        _ => "",
    }
}

pub fn reviewer_icon(id: &str) -> &'static str {
    match id {
        "cognitive" => "󰧑",
        "keyboard" => "",
        "semantic" => "",
        "visual" => "",
        _ => "",
    }
}

fn default_reviewer_summary(id: &str) -> String {
    match id {
        "cognitive" => "Task flow, labels, instructions, copy clarity.".to_string(),
        "keyboard" => "Focus order, traps, activation, target size.".to_string(),
        "semantic" => "Landmarks, headings, names, alt text.".to_string(),
        "visual" => "Contrast, reflow, focus, spacing, zoom.".to_string(),
        _ => "Waiting for specialist review.".to_string(),
    }
}

fn title_case(id: &str) -> String {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Reviewer".to_string(),
    }
}

fn short_role_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("cognitive") {
        "Cognitive".to_string()
    } else if lower.contains("keyboard") {
        "Keyboard".to_string()
    } else if lower.contains("semantic") || lower.contains("screen-reader") {
        "Semantic".to_string()
    } else if lower.contains("visual") || lower.contains("contrast") {
        "Visual".to_string()
    } else {
        title_case(name.split_whitespace().next().unwrap_or("Reviewer"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::SwarmEvent;

    #[test]
    fn applies_run_and_decision_events() {
        let mut app = App::new(vec!["accessibility".into(), "https://example.com".into()]);
        let start = SwarmEvent::parse(
            r#"{"type":"run_start","profile":"accessibility","input":"https://example.com","runDir":"runs/x","model":"gpt-5","agent":"build","maxIterations":2,"reviewers":[{"id":"semantic","name":"screen-reader/semantic structure reviewer"}]}"#,
        )
        .unwrap();
        app.apply_event(&start);
        assert_eq!(app.status, RunStatus::Running);
        assert_eq!(app.run_dir, "runs/x");
        assert_eq!(app.iteration_statuses.len(), 2);
        assert_eq!(app.reviewers["semantic"].name, "Semantic");

        let decision = SwarmEvent::parse(
            r#"{"type":"decision","outcome":"continue","accepts":3,"blocks":1,"checksPass":false}"#,
        )
        .unwrap();
        app.apply_event(&decision);
        assert_eq!(app.decision, "continue");
        assert_eq!(app.accept_votes(), 3);
        assert_eq!(app.block_votes(), 1);
    }

    #[test]
    fn tracks_artifact_outputs() {
        let mut app = App::new(vec!["accessibility".into(), "https://example.com".into()]);
        let prompt = SwarmEvent::parse(
            r#"{"type":"prompt","phase":"brief","status":"done","outputs":[{"path":"runs/x/brief.md"}]}"#,
        )
        .unwrap();
        app.apply_event(&prompt);
        assert!(app.artifact_ready("brief.md"));
        assert_eq!(app.files_written, 1);
    }
}
