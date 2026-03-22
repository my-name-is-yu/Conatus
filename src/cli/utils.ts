// ─── CLI Shared Utilities ───

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
Moxen — AI agent orchestrator

Usage:
  moxen run --goal <id>              Run CoreLoop for a goal
  moxen improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  moxen suggest "<context>"          Suggest improvement goals for a project context
  moxen goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  moxen goal add "<description>" --negotiate          Register a goal via LLM negotiation
  moxen goal list                    List all registered goals
  moxen goal list --archived         Also list archived goals
  moxen goal archive <id>            Archive a completed goal (moves state to ~/.moxen/archive/)
  moxen goal remove <id>             Remove a goal by ID
  moxen goal show <id>               Show goal details (dimensions, constraints, deadline)
  moxen goal reset <id>              Reset goal state for re-running
  moxen cleanup                      Archive all completed goals and remove stale data
  moxen status --goal <id>           Show current status and progress
  moxen report --goal <id>           Show latest report
  moxen log --goal <id>              View observation and gap history log
  moxen tui                          Launch the interactive TUI
  moxen start --goal <id>            Start daemon mode for one or more goals
  moxen stop                         Stop the running daemon
  moxen cron --goal <id>             Print crontab entry for a goal
  moxen config character             Show or update character configuration
  moxen datasource add <type>        Register a new data source (file | http_api)
  moxen datasource list              List all registered data sources
  moxen datasource remove <id>       Remove a data source by ID
  moxen capability list              List all registered capabilities
  moxen capability remove <name>     Remove a capability by name
  moxen plugin list                  List installed plugins
  moxen plugin install <path>        Install a plugin from a local directory
  moxen plugin remove <name>         Remove an installed plugin
  moxen provider show                Show current provider config
  moxen provider set                 Set LLM provider and/or default adapter

Options (moxen run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (moxen improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (moxen suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (moxen goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --negotiate                         Use LLM negotiation instead of raw mode
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (moxen config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (moxen datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (moxen provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  MOXEN_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  moxen goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  moxen goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  moxen goal add "Increase test coverage to 90%" --negotiate
  moxen goal list
  moxen goal show <id>
  moxen goal reset <id>
  moxen run --goal <id>
  moxen status --goal <id>
  moxen report --goal <id>
  moxen log --goal <id>
  moxen config character --show
  moxen config character --caution-level 3
  moxen datasource add file --path /path/to/metrics.json --name "My Metrics"
  moxen datasource add http_api --url https://api.example.com/metrics --name "API"
  moxen datasource list
  moxen datasource remove ds_1234567890
`.trim());
}

export function printCharacterConfig(config: {
  caution_level: number;
  stall_flexibility: number;
  communication_directness: number;
  proactivity_level: number;
}): void {
  console.log(`  caution_level:              ${config.caution_level}  (1=conservative, 5=ambitious)`);
  console.log(`  stall_flexibility:          ${config.stall_flexibility}  (1=pivot fast, 5=persistent)`);
  console.log(`  communication_directness:   ${config.communication_directness}  (1=considerate, 5=direct)`);
  console.log(`  proactivity_level:          ${config.proactivity_level}  (1=events-only, 5=always-detailed)`);
}
