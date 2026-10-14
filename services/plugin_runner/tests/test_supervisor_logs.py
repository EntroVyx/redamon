"""The plugin log: each worker's stderr kept in a ring buffer of the last 1,000 lines per
plugin, and printed on the container's stdout with a `[plugin:<id>@<version>]` prefix
(design §13 "where plugin logs are written", D-77, R-12)."""

import io

from supervisor.logs import LINE_MAX_CHARS, LogBuffer
from tests.support import install_plugin, wait_until


def test_the_buffer_keeps_the_last_thousand_lines():
    out = io.StringIO()
    buf = LogBuffer(max_lines=1000, stream=out)
    for i in range(1500):
        buf.add("echo", "1.0.0", f"line {i}")
    lines = buf.tail("echo", 1000)
    assert len(lines) == 1000
    assert lines[0].endswith("line 500") and lines[-1].endswith("line 1499")
    assert buf.tail("echo", 5)[-1].endswith("line 1499") and len(buf.tail("echo", 5)) == 5


def test_each_line_is_printed_with_its_plugin_prefix():
    out = io.StringIO()
    buf = LogBuffer(stream=out)
    buf.add("echo", "1.2.3", "hello")
    assert out.getvalue() == "[plugin:echo@1.2.3] hello\n"


def test_a_long_line_is_cut():
    buf = LogBuffer(stream=io.StringIO())
    buf.add("echo", "1.0.0", "x" * (LINE_MAX_CHARS * 2))
    assert len(buf.tail("echo", 1)[0]) <= LINE_MAX_CHARS + 40


def test_a_cut_made_by_the_reader_is_counted_with_the_buffers_own():
    buf = LogBuffer(stream=io.StringIO())
    buf.add("echo", "1.0.0", "x" * (LINE_MAX_CHARS + 10), cut=1000)
    assert buf.tail("echo", 1)[0].endswith(" [... 1010 characters cut]")


def test_control_characters_a_plugin_prints_are_escaped():
    out = io.StringIO()
    buf = LogBuffer(stream=out)
    buf.add("echo", "1.0.0", "red \x1b[31mtext\rover\x00written\tok")
    assert out.getvalue() == "[plugin:echo@1.0.0] red \\x1b[31mtext\\x0dover\\x00written\tok\n"


def test_a_plugin_cannot_print_what_looks_like_a_supervisor_event():
    buf = LogBuffer(stream=io.StringIO())
    buf.add("echo", "1.0.0", "[runner] worker started: pid 1 uid 0")
    buf.event("echo", "1.0.0", "worker exited")
    assert buf.tail("echo", 2) == ["1.0.0 [plugin] [runner] worker started: pid 1 uid 0",
                                   "1.0.0 [runner] worker exited"]


def test_plugins_have_separate_buffers():
    buf = LogBuffer(stream=io.StringIO())
    buf.add("a", "1.0.0", "from a")
    buf.add("b", "1.0.0", "from b")
    assert [l.endswith("from a") for l in buf.tail("a", 10)] == [True]
    assert buf.tail("nobody", 10) == []


def test_the_logs_route_returns_the_worker_stderr(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "raise_other")
    h.act("echo", "print_noise")

    def lines():
        return h.get("/runner/v1/plugins/echo/logs?lines=1000").json()["lines"]

    wait_until(lambda: any("noise on stdout" in l for l in lines()))
    text = "\n".join(lines())
    assert "RuntimeError" in text and "4242" in text
    assert len(h.get("/runner/v1/plugins/echo/logs?lines=2").json()["lines"]) == 2


def test_the_lines_parameter_is_clamped(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    for q in ("lines=0", "lines=-5", "lines=abc", "lines=99999", ""):
        r = h.get(f"/runner/v1/plugins/echo/logs?{q}")
        assert r.status_code == 200 and isinstance(r.json()["lines"], list), q


def test_worker_events_are_in_the_plugin_log(runner, plugins_dir):
    h = runner([install_plugin(plugins_dir)])
    h.act("echo", "crash")

    def lines():
        return h.get("/runner/v1/plugins/echo/logs?lines=1000").json()["lines"]

    wait_until(lambda: any("[runner]" in l and "exited" in l for l in lines()))
    assert any("[runner]" in l and "started" in l for l in lines())
