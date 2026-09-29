import subprocess
import sys
import unittest

from helpers import ROOT

REAP = ROOT / "scripts" / "reap.sh"


@unittest.skipUnless(sys.platform.startswith("linux"), "a subreaper is a Linux feature")
class ReapTests(unittest.TestCase):
    """`scripts/reap.sh <command>`: the command runs as it would alone, and an orphan of it that ends is
    gone, even in a container whose PID 1 would keep it as a zombie."""

    def reap(self, *command):
        return subprocess.run([str(REAP), *command], capture_output=True, text=True, timeout=60)

    def test_an_orphan_that_ends_is_gone_for_kill_0(self):
        # The subshell ends at once, so the sleep it started is an orphan when it is killed. It has half a second
        # to be gone: the PID 1 of a cloud container reaps orphans too, but only every two seconds or so.
        r = self.reap("bash", "-c", "pid=$( ( sleep 30 >/dev/null & echo $! ) ); kill \"$pid\"; "
                      "for _ in $(seq 5); do kill -0 \"$pid\" 2>/dev/null || exit 0; sleep 0.1; done; exit 1")
        self.assertEqual(r.returncode, 0, "the orphan answers kill -0 after it ended: " + r.stderr)

    def test_the_command_exit_status_and_output_pass_through(self):
        r = self.reap("bash", "-c", "echo out; echo err >&2; exit 3")
        self.assertEqual((r.returncode, r.stdout, r.stderr), (3, "out\n", "err\n"))

    def test_no_command_is_an_error_naming_the_call(self):
        r = self.reap()
        self.assertEqual(r.returncode, 2)
        self.assertIn("error: no command to run; call it as scripts/reap.sh make check", r.stderr)
