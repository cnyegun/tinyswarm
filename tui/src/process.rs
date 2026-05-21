use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread,
};

use anyhow::{Context, Result};

use crate::{app::App, events::SwarmEvent};

pub enum ProcessMessage {
    Event(SwarmEvent),
    Activity(String),
}

pub struct ChildHandle {
    child: Child,
    rx: Receiver<ProcessMessage>,
    exited: bool,
}

impl ChildHandle {
    pub fn drain_into(&mut self, app: &mut App) {
        while let Ok(message) = self.rx.try_recv() {
            match message {
                ProcessMessage::Event(event) => app.apply_event(&event),
                ProcessMessage::Activity(line) => app.push_activity("stderr", line),
            }
        }
        if !self.exited
            && let Ok(Some(status)) = self.child.try_wait()
        {
            self.exited = true;
            app.process_exited(status.code().unwrap_or(-1));
        }
    }

    pub fn is_running(&self) -> bool {
        !self.exited
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.exited = true;
    }
}

pub fn spawn_runner(args: &[String]) -> Result<ChildHandle> {
    let mut command_args = vec!["dist/index.js".to_string(), "--json-events".to_string()];
    command_args.extend(args.iter().cloned());

    let mut child = Command::new("node")
        .args(command_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to spawn node dist/index.js --json-events")?;

    let stdout = child.stdout.take().context("child stdout was not piped")?;
    let stderr = child.stderr.take().context("child stderr was not piped")?;
    let (tx, rx) = mpsc::channel();

    read_stdout(stdout, tx.clone());
    read_stderr(stderr, tx.clone());

    Ok(ChildHandle {
        child,
        rx,
        exited: false,
    })
}

fn read_stdout(stdout: impl std::io::Read + Send + 'static, tx: Sender<ProcessMessage>) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(event) = SwarmEvent::parse(&line) {
                let _ = tx.send(ProcessMessage::Event(event));
            } else if !line.trim().is_empty() {
                let _ = tx.send(ProcessMessage::Activity(line));
            }
        }
    });
}

fn read_stderr(stderr: impl std::io::Read + Send + 'static, tx: Sender<ProcessMessage>) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = tx.send(ProcessMessage::Activity(line));
            }
        }
    });
}
