# claude-mods

Claude Code mods (hooks-module plugins) for subagent visibility, task tracking, token savings and daily workflow. Needs Claude Code 2.1.304 or newer (built and tested on 2.1.304; the mod API is early access and can change between releases).

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install agent-monitor --marketplace samarthsh-git/claude-mods
/plugin install task-inbox --marketplace samarthsh-git/claude-mods
/plugin install token-saver --marketplace samarthsh-git/claude-mods
/plugin install daily-driver --marketplace samarthsh-git/claude-mods
/plugin install clarify-first --marketplace samarthsh-git/claude-mods
/plugin install mod-scout --marketplace samarthsh-git/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. From a shell: `claude plugin install <mod> --marketplace samarthsh-git/claude-mods`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `samarthsh-git/claude-mods`, then Add plugin.

If this repository is private, the machine needs a git credential for github.com (`gh auth login`, then `gh auth setup-git`); the install never prompts for one.

## The mods

### agent-monitor: what every subagent is doing

- A sidebar (`/subagents`) that opens by itself when the first subagent starts.
- Each subagent shows its task, type, model, run time, tool count and tokens.
- A live "now:" line shows what it is doing at that moment (`$ npm test`, `reading auth.ts`, `searching "TODO"`).
- Finished agents show a one-line result. History stays across sessions (last 60).
- Press a row to open that agent's transcript. `/subagents clear` wipes the history.
- The status line shows `⚙ N subagents running`, and a toast appears when one fails.

### task-inbox: to-do list and task inbox

The `Tasks` pane (`/todo` or `/inbox`) has three parts:

1. **Claude's plan.** A live mirror of Claude's own TodoWrite or Task list: ☐ pending, ◐ in progress, ☑ done.
2. **My to-dos.** Your own list, saved per project. `/todo <text>` adds, `/todo done 2` ticks, `/todo rm 2` removes, `/todo clear` drops finished ones.
3. **Inbox.** Queue tasks with `/inbox <text>`, then press **Send** (or `/inbox send`). Claude spawns one background subagent per task, in parallel, on the cheapest model that fits. You keep working while they run, and agent-monitor shows their progress.

### token-saver: fewer tokens, same accuracy

| Feature | What it does | Setting |
| --- | --- | --- |
| Subagent model routing | `balanced`: search and lookup subagents (Explore, guides) run on Haiku. `aggressive`: general-purpose and Plan subagents spawned from an Opus-class session also run on Sonnet. A model Claude or you set explicitly is never changed, and neither are forks or plugin agents. | `routing` |
| Lean-output rules | Adds about 150 tokens to the system prompt: no preamble or recaps, locate before reading, batch tool calls, delegate broad searches, prefer Edit, never trade correctness for brevity. It sits in the cached part of the prompt. | `leanRules` |
| Duplicate-read guard | Refuses once a Read of a file Claude already read with the same range in the same context while the file is unchanged on disk. Repeating the exact call goes through, so the worst case is one extra round trip. It resets on compaction. | `dedupeReads` |
| Usage HUD | Status line: `ctx 42% · $1.23 · 5h 37%`. Toasts at 70% context (suggests /compact or /clear) and at 80% of a rate limit. | always on |
| Model advisor | A toast when a prompt looks trivial for an Opus-class model, or hard for Haiku. Pure regex, costs no tokens, at most once per 15 min. | `advisor` |
| `/tokens` | Report: fresh, cached and output tokens, cache hit rate, subagent share, what token-saver saved, and concrete tips. | |

Change settings with `/config` (or `pluginConfigs` in settings.json).

What saves the most, from experience: `/clear` between unrelated tasks, keeping the prompt cache warm (no model switches mid-thread), delegating read-heavy searches to subagents, and using Sonnet as the default with Opus only for hard problems. The mod nudges toward these; it cannot measure your exact savings.

### daily-driver: get more done per day

- `/aim <goal>` sets a focus goal (`/aim auto <goal>` sets one only when none is set), shown above the prompt with time spent and today's file and commit counts. Press **Done** or run `/aim done` to log it.
- When a turn ran 60 s or longer (setting `notifyAfterSeconds`), you get a desktop or phone notification with Claude's answer. Hand Claude long work and switch tasks.
- `/eod` (or `/eod yesterday`) prints a zero-token work log: Claude time, prompts, files changed, commits, test runs, subagents and goals done. Paste it into a standup.
- `/handoff` has Claude write `.claude/handoff.md` (goal, done, state, next steps, gotchas). `/pickup` in the next session continues from it, and a toast reminds you when one exists.

### clarify-first: questions before complex work

On a complex task or a deep, open-ended question, Claude first checks the repo and the chat for what it can learn itself. If something that would change the result is still missing, it asks you up to 4 multiple-choice questions in one round, with a recommended option on each. It then states the agreed spec in 3 lines or fewer, does the work, and checks the result against that spec. Everyday prompts ("fix the typo", "what is X") pass straight through.

Cost:
- **Detection:** free keyword scoring decides most prompts. Only borderline ones get a classification call on the small, fast model, typically a few hundred tokens. Set `detector` to `heuristic` for zero detection tokens.
- **Instruction:** about 200 tokens of instruction reach the model, and only on prompts flagged complex.
- **Payoff:** one question round is usually cheaper than redoing work built on a wrong assumption. That trade is the point of the mod. It is not a measured gain.

Commands: `/clarify on` (default) · `off` · `always` · `now <task>` (force questions for one task) · `/clarify` alone shows status. Settings: `detector` (hybrid / heuristic / model), `maxQuestions` (1 to 4).

### mod-scout: the right mod at the right time

It reads each prompt locally, with no model call and zero tokens, and never changes what Claude sees:

- **Suggests** the installed mod that fits, as a toast, once per kind per session. For example "why is my usage so high" suggests `/tokens`, a list of 3 or more tasks suggests `/inbox`, and "wrapping up for today" suggests `/handoff`. It knows every mod here plus Podium and Grounded Engineering, and stays quiet about mods you have not installed.
- **Sets your focus goal** (daily-driver's `/aim`) from your first real task of the session, unless you already set one.
- **Makes mods for you:** send the same prompt a third time and it becomes a slash command on the spot (`/run-test`, say). This costs no tokens to make or to use beyond the prompt itself. `/scout rm <name>` removes one.
- **Builds bigger mods on request:** `/scout build <idea>` has Claude write, validate and test a new mod, with zero run-time token cost wherever the feature allows. This is the one part that spends tokens, and only when you ask.

`/scout` shows recent suggestions and your macros. `/scout off` pauses it. Settings: `autoMacros`, `autoFocus`.

## Claude chat (claude.ai, phone and desktop apps)

The mods above run only in Claude Code: the chat app has no plugin system. For chat, `chat/` holds the closest equivalents, and both work on every device once set up:

1. **`chat/preferences.txt`**: paste it into Settings → Profile → personal preferences. It holds the lean-output rules, clarifying questions on complex tasks only, and a model-fit hint. It is about 200 words, shorter than a typical preferences block, and preferences ride on every message, so shorter is cheaper.
2. **`chat/deep-work-skill.zip`**: upload it in Settings → Capabilities → Skills. It is a gather → ask → spec → deliver → self-check procedure that Claude loads only for complex work, so everyday chats pay just its one-line description.

Chat habits that save the most: start a new chat per topic (each message resends the whole chat), put reference files in a Project instead of pasting them again, and use a lighter model for simple asks.

## Cloud sessions from your phone

`.claude/settings.json` registers this marketplace and enables the six mods, so a Claude Code session opened on this repository (from claude.ai/code or the phone app) offers to install them with no commands typed.

## Third-party mods from the same Reddit thread

These are other people's projects. Install them from their own repositories:

| Mod | What it is | Install |
| --- | --- | --- |
| [Podium](https://github.com/madjagstudios/podium) | Hands jobs to other agent CLIs (Codex, Gemini, other Claude models) and tracks them in one pane, with sprints and PRs. Needs Node 22+, git 2.28+ and at least one other agent CLI. | `/plugin marketplace add madjagstudios/plugins`, then `/plugin install podium@madjagstudios` |
| [Grounded Engineering](https://github.com/madjagstudios/grounded-engineering) | `/grounded` pane: engineering practices that fit your repo, with sources, plus a reviewed shelf of skill repositories. | `/plugin marketplace add madjagstudios/grounded-engineering`, then `/plugin install grounded-engineering@grounded-engineering` |
| [claude-ui-mod](https://gitlab.com/blockshooter/claude-ui-mod) | Not a Claude Code plugin. It patches the files of the Claude Desktop app on Windows: subagent HUD, task rail, usage meters, provider routing. | Windows only. Quit Claude Desktop, then `git clone https://gitlab.com/blockshooter/claude-ui-mod && cd claude-ui-mod && npm ci && node scripts/verify-frontend.cjs && node patch.js apply`. Read its SECURITY.md first: it rewrites your Claude Desktop install, and app updates can break it. `node patch.js revert` undoes it. |

The "optimaizr" and "inbox monitor" mods mentioned in the thread had no links. task-inbox and token-saver cover the same ground.

## Developing

```bash
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
```

To run a working copy, add `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/abs/path/mods/agent-monitor:/abs/path/mods/task-inbox" }` to `~/.claude/settings.json`, or start with `claude --plugin-dir mods/<mod>`.

## License

MIT
