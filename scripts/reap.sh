#!/usr/bin/env bash
# Runs a command as the reaper of every process orphaned under it: `scripts/reap.sh make check`.
# A container whose PID 1 reaps orphans late, such as a Claude Code cloud session, keeps each one as a zombie
# for seconds after it ends, and a zombie still answers `kill -0`. The tests that end a process and check at
# once that it is gone then read it as alive. Linux only: macOS and the CI runner reap orphans without it.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "error: no command to run; call it as scripts/reap.sh make check" >&2
  exit 2
fi
if [ "$(uname -s)" != "Linux" ]; then
  echo "error: a subreaper is a Linux feature; run the command without scripts/reap.sh here" >&2
  exit 2
fi

exec python3 - "$@" <<'PY'
import ctypes, os, signal, sys

PR_SET_CHILD_SUBREAPER = 36
if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    sys.exit(f"error: this process cannot become a subreaper ({os.strerror(ctypes.get_errno())}); "
             "run the command without scripts/reap.sh")

command = sys.argv[1:]
child = os.fork()
if child == 0:
    try:
        os.execvp(command[0], command)
    except OSError as e:
        sys.stderr.write(f"error: {command[0]} cannot be run: {e.strerror}\n")
        os._exit(127)

# A signal meant for the command reaches it, and the reaper ends with the command.
for sig in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(sig, lambda s, _: os.kill(child, s))
signal.signal(signal.SIGINT, signal.SIG_IGN)  # the terminal sends it to the command's group already

while True:
    pid, status = os.wait()  # reaps the orphans that ended, which is what the reaper is for
    if pid == child:
        break
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
PY
