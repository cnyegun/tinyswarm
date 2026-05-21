mod app;
mod events;
mod process;
mod ui;

use std::{env, io, time::Duration};

use anyhow::Result;
use app::App;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};

fn main() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: tiny-rewrite-tui accessibility <url>");
        std::process::exit(2);
    }

    let mut child = process::spawn_runner(&args)?;
    let mut terminal = setup_terminal()?;
    let result = run(&mut terminal, &mut child, args);
    restore_terminal(&mut terminal)?;
    if child.is_running() {
        child.kill();
    }
    result
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    child: &mut process::ChildHandle,
    args: Vec<String>,
) -> Result<()> {
    let mut app = App::new(args);
    loop {
        child.drain_into(&mut app);
        terminal.draw(|frame| ui::draw(frame, &app))?;

        if event::poll(Duration::from_millis(120))?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            let quit = key.code == KeyCode::Char('q')
                || (key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL));
            if quit {
                break;
            }
        }
    }
    Ok(())
}

fn setup_terminal() -> Result<Terminal<CrosstermBackend<io::Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    Ok(Terminal::new(backend)?)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}
