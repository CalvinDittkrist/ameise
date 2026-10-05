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

// Every session runs on a runtime ([ADR 0039]): Claude Code in print mode, which every stage has run on
// from the start, or Codex, which a reviewer of the panel runs on when its definition names it. The
// factory builds the call from the runtime, reads the events that runtime prints, and holds the result
// to the same schema and the same checks whichever runtime wrote it.
//
// [ADR 0039]: ../docs/adr/0039-every-session-reports-through-a-structured-result.md
const (
	runtimeClaude = "claude"
	runtimeCodex  = "codex"
)

// codexModel is the model a Codex session runs on, named in the call (-m): no event of `codex exec
// --json` names the model, so the record knows it from the call alone (the prototype of 2026-09-27 on
// #230, with codex-cli 0.155.0). GPT-6.1-Sol is the newest coding model of the catalog that a ChatGPT
// login may run: on 2026-09-27 the host's login was refused gpt-5.3-codex ("not supported when using
// Codex with a ChatGPT account"). quota-axi 0.1.55 reports no scope of its own for it, so the check
// reads it on all_models.
const codexModel = "gpt-6.1-sol"

// codexMinimum is the oldest codex-cli that runs codexModel: 0.159.1 is the first release whose model
// catalog has gpt-6.1-sol, and an older one fails the session on an unknown model from inside a review.
const codexMinimum = "0.159.1"

// codexReasoning is the reasoning effort a Codex session runs with, passed as a configuration override:
// the catalog's default for the model is low, and a reviewer reads a whole change.
const codexReasoning = "high"

// codexCheckTimeout is how long `codex --version` and `codex login status` may each take before a run
// that needs Codex starts.
const codexCheckTimeout = 30 * time.Second

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
// checked on 2026-09-27). The prompt goes in on its standard input, which is closed after it, and the
// call names it `-`: Codex then reads the prompt from stdin alone, while a prompt in the arguments
// with a stdin that is no terminal has it print "Reading additional input from stdin..." on its error
// output, which the factory records as an error of the session, and append whatever stdin holds
// (resolve_root_prompt in codex-rs/exec/src/lib.rs, rust-v0.155.0, checked on 2026-09-28). It also
// keeps a long brief clear of the 128 KiB Linux holds an argument to. The configured worker arguments
// are Claude Code's and go to no Codex call.
func codexCommand(ctx context.Context, s session, claim claimed) *exec.Cmd {
	args := []string{"exec", "--sandbox", "read-only", "--cd", claim.worktree, "--ephemeral", "--skip-git-repo-check",
		"--ignore-user-config", "--ignore-rules",
		"-c", "model_reasoning_effort=\"" + codexReasoning + "\"",
		"--output-schema", s.schemaFile, "--json", "-o", s.lastMessage, "-m", s.model, "-"}
	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Dir = claim.worktree
	cmd.Env = workerEnv(os.Environ(), nil)
	cmd.Stdin = strings.NewReader(s.prompt) // exec copies it into a pipe and closes the pipe after it
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

// runtimeMissing says why this host cannot start a session on a runtime and what fixes it, and both are
// empty when it can: Codex is on the PATH of the factory's user, at least codexMinimum (`codex
// --version`), and logged in there (`codex login status`, https://learn.chatgpt.com/codex/auth, checked
// on 2026-09-27). Claude Code is the host's own and is not asked. A check the context ended says
// nothing; the caller reads the context.
func (f *Factory) runtimeMissing(ctx context.Context, runtime string) (why, fix string) {
	if runtime != runtimeCodex || f.fake {
		return "", ""
	}
	install := "Install the Codex CLI for the factory's user and log it in with `codex login` (the factory's runbook, the Codex runtime)"
	path, err := exec.LookPath("codex")
	if err != nil {
		return "this host has no codex command on the PATH of the factory's user", install
	}
	out, said, err := command(ctx, codexCheckTimeout, path, "--version")
	if ctx.Err() != nil {
		return "", ""
	}
	update := "Update the Codex CLI of the factory's user to " + codexMinimum + " or later (the factory's runbook, the Codex runtime)"
	if err != nil {
		return fmt.Sprintf("`codex --version` failed on this host (%v): %s, and %s needs codex-cli %s or later", err, firstLine(strings.TrimSpace(said)), codexModel, codexMinimum), update
	}
	version, ok := codexVersion(string(out))
	if !ok {
		return fmt.Sprintf("`codex --version` on this host printed %q, which names no version, and %s needs codex-cli %s or later", firstLine(strings.TrimSpace(string(out))), codexModel, codexMinimum), update
	}
	if minimum, _ := parseSemver(codexMinimum); version.less(minimum) {
		return fmt.Sprintf("codex-cli %s on this host is older than %s, which %s needs", version, codexMinimum, codexModel), update
	}
	out, said, err = command(ctx, codexCheckTimeout, path, "login", "status")
	if err == nil || ctx.Err() != nil {
		return "", ""
	}
	why = strings.TrimSpace(said)
	if why == "" || why == err.Error() {
		why = firstLine(strings.TrimSpace(string(out)))
	}
	return fmt.Sprintf("Codex is not logged in on this host: `codex login status` failed (%v): %s", err, why), install
}

// codexVersion is the version `codex --version` prints, "codex-cli 0.155.0", read from the last word
// of its first line.
func codexVersion(out string) (semver, bool) {
	words := strings.Fields(firstLine(strings.TrimSpace(out)))
	if len(words) == 0 {
		return semver{}, false
	}
	return parseSemver(words[len(words)-1])
}

// modelFor is the model a session runs on as the factory names it: the Codex model of a Codex
// session, the model of a reviewer's definition, and the worker's for every other session.
func (f *Factory) modelFor(s session) string {
	switch {
	case s.on() == runtimeCodex:
		return s.model
	case s.agent != "" && s.model != "":
		return s.model
	}
	return f.settings.WorkerModel
}
