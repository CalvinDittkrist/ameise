package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Every session runs on a runtime ([ADR 0052]): Claude Code in print mode, which every stage has run on
// from the start, or Codex, which a reviewer of the panel runs on when its definition names it. The
// factory builds the call from the runtime, reads the events that runtime prints, and holds the result
// to the same schema and the same checks whichever runtime wrote it.
//
// [ADR 0052]: ../docs/adr/0052-sessions-run-on-a-runtime-and-codex-is-one-of-them.md
const (
	runtimeClaude = "claude"
	runtimeCodex  = "codex"
)

// codexModel is the model a Codex session runs on, named in the call (-m): no event of `codex exec
// --json` names the model, so the record knows it from the call alone (the prototype of 2026-09-27 on
// #230, with codex-cli 0.155.0). It is a Codex model whose scope quota-axi 0.1.49 reports, as
// model:codex_bengalfox (scopeAliases), so the quota check reads the scope it spends.
const codexModel = "gpt-5.3-codex"

// codexLoginTimeout is how long `codex login status` may take before a run that needs Codex starts.
const codexLoginTimeout = 30 * time.Second

// on is the runtime a session runs on.
func (s session) on() string {
	if s.runtime == "" {
		return runtimeClaude
	}
	return s.runtime
}

// codexCommand is the process of a Codex session: `codex exec` in the run's worktree, in the read-only
// sandbox, without a session file of its own (--ephemeral), without the host user's configuration and
// without any execpolicy rules of the user or of the worktree (--ignore-user-config, --ignore-rules: the
// sandbox bounds only the shell commands, while a configured MCP server or hook would reach the review
// input past it; the login in CODEX_HOME still holds), with the schema of its result as the output
// schema and its last message written to a file the factory reads as the structured result
// (https://learn.chatgpt.com/docs/developer-commands?surface=cli,
// https://learn.chatgpt.com/codex/non-interactive-mode and codex-rs/exec/src/cli.rs of openai/codex,
// checked on 2026-09-27). Its standard input is closed: with it open, Codex waits for more of the
// prompt before it starts. The configured worker arguments are Claude Code's and go to no Codex call.
func codexCommand(ctx context.Context, s session, claim claimed) *exec.Cmd {
	args := []string{"exec", "--sandbox", "read-only", "--cd", claim.worktree, "--ephemeral", "--skip-git-repo-check",
		"--ignore-user-config", "--ignore-rules",
		"--output-schema", s.schemaFile, "--json", "-o", s.lastMessage, "-m", s.model, s.prompt}
	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Dir = claim.worktree
	cmd.Env = workerEnv(os.Environ(), nil)
	cmd.Stdin = nil // the null device: exec reads nothing into it
	return cmd
}

// codexFiles makes the two files of a Codex session in a directory of their own and answers with what
// removes them once the session is read.
func codexFiles(s *session) (func(), error) {
	dir, err := os.MkdirTemp("", "factory-codex-")
	if err != nil {
		return nil, fmt.Errorf("the files of the Codex session could not be made: %w", err)
	}
	s.schemaFile, s.lastMessage = filepath.Join(dir, "schema.json"), filepath.Join(dir, "last-message.json")
	if err := os.WriteFile(s.schemaFile, []byte(s.schema), 0o600); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("the schema of the Codex session could not be written: %w", err)
	}
	return func() { os.RemoveAll(dir) }, nil
}

// codexEvent is one line `codex exec --json` prints (https://learn.chatgpt.com/codex/non-interactive-mode,
// checked on 2026-09-27, and the prototype's events): the thread, the turn and its usage, the items of
// the turn, and the error a turn fails with.
type codexEvent struct {
	Type     string `json:"type"`
	ThreadID string `json:"thread_id"`
	Message  string `json:"message"`
	Usage    struct {
		Input      int `json:"input_tokens"`
		Cached     int `json:"cached_input_tokens"`
		CacheWrite int `json:"cache_write_input_tokens"`
		Output     int `json:"output_tokens"`
	} `json:"usage"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
	Item struct {
		Type             string `json:"type"`
		Text             string `json:"text"`
		Command          string `json:"command"`
		AggregatedOutput string `json:"aggregated_output"`
		Message          string `json:"message"`
	} `json:"item"`
}

// ingestCodex reads one event of a Codex session into the run and into the session's reading, as ingest
// does for Claude Code's stream. The totals are the turn's usage: Codex counts the cached input and
// the input it wrote to the cache within the input, and reports no cost, so the run's cost leaves the session out.
func (f *Factory) ingestCodex(r *Run, session *heard, line []byte) {
	event := func(e Event) {
		if session.label != "" {
			e.Title = session.label + ": " + e.Title
		}
		f.runs.event(r, e)
	}
	failed := func(title, message string) {
		e := Event{Kind: "error", Title: title + ": " + firstLine(message), Body: message}
		if session.label != "" {
			e.Title = session.label + ": " + e.Title
		}
		f.error(r, session, e)
	}
	var m codexEvent
	if json.Unmarshal(line, &m) != nil || m.Type == "" {
		event(Event{Kind: "error", Title: "the Codex session printed a line that is not its event format", Body: string(line)})
		return
	}
	switch m.Type {
	case "thread.started":
		event(Event{Kind: "init", Title: "session codex " + session.model + ", sandbox read-only", Body: m.ThreadID})
	case "turn.started", "item.started", "item.updated":
	case "item.completed":
		switch m.Item.Type {
		case "agent_message":
			event(Event{Kind: "text", Title: firstLine(m.Item.Text), Body: m.Item.Text})
		case "reasoning":
			event(Event{Kind: "thinking", Title: "thinking", Body: m.Item.Text})
		case "command_execution":
			event(Event{Kind: "tool", Title: strings.TrimSpace("shell " + firstLine(m.Item.Command)), Body: m.Item.AggregatedOutput})
		case "error":
			failed("error", m.Item.Message)
		default:
			event(Event{Kind: "tool", Title: m.Item.Type})
		}
	case "turn.completed":
		f.runs.update(r, func() {
			r.report(session, 1, 0, Tokens{Input: max(m.Usage.Input-m.Usage.Cached-m.Usage.CacheWrite, 0), Output: m.Usage.Output,
				CacheCreation: m.Usage.CacheWrite, CacheRead: m.Usage.Cached})
		})
	case "turn.failed":
		failed("turn failed", m.Error.Message)
	case "error":
		failed("error", m.Message)
	default:
		event(Event{Kind: "system", Title: "codex: " + m.Type, Body: string(line)})
	}
}

// readLastMessage reads the result of a Codex session that ended by itself: its last message, which
// Codex writes whole to the file of the call. A session that wrote none has no result.
func (f *Factory) readLastMessage(r *Run, session *heard, s session) {
	raw, err := os.ReadFile(s.lastMessage)
	if err != nil || len(bytes.TrimSpace(raw)) == 0 {
		return
	}
	f.settle(r, session, bytes.TrimSpace(raw), string(raw), "result: last message")
}

// runtimeMissing says why this host cannot start a session on a runtime, and is empty when it can:
// Codex is on the PATH of the factory's user and logged in there (`codex login status`,
// https://learn.chatgpt.com/codex/auth, checked on 2026-09-27). Claude Code is the host's own and is not
// asked. A check the context ended says nothing; the caller reads the context.
func (f *Factory) runtimeMissing(ctx context.Context, runtime string) string {
	if runtime != runtimeCodex || f.fake {
		return ""
	}
	path, err := exec.LookPath("codex")
	if err != nil {
		return "this host has no codex command on the PATH of the factory's user"
	}
	out, said, err := command(ctx, codexLoginTimeout, path, "login", "status")
	if err == nil || ctx.Err() != nil {
		return ""
	}
	why := strings.TrimSpace(said)
	if why == "" || why == err.Error() {
		why = firstLine(strings.TrimSpace(string(out)))
	}
	return fmt.Sprintf("Codex is not logged in on this host: `codex login status` failed (%v): %s", err, why)
}

// modelFor is the model a session runs on as the factory names it: the Codex model of a Codex
// session, the model of a reviewer's definition, and the worker's for every other session.
func (f *Factory) modelFor(s session) string {
	switch {
	case s.on() == runtimeCodex:
		return s.model
	case s.agent != "" && s.model != "" && s.model != "inherit":
		return s.model
	}
	return f.settings.WorkerModel
}
