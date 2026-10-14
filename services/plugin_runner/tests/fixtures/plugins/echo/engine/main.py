"""Echo's actions. Each one exercises a single path of the runner or of the SDK."""

import asyncio
import ctypes
import os
import resource
import stat
import sys

from redamon_plugin_sdk import PluginError

# Appended to a skill part by propose_override, so later phases can find the proposal
# in a review screen and in the agent's prompt.
FIXTURE_MARKER = "ECHO-FIXTURE-OVERRIDE-MARKER"


async def echo(ctx, params):
    return {
        "echo": params,
        "plugin": ctx.plugin_id,
        "version": ctx.version,
        "user": ctx.user_id,
        "project": ctx.project_id,
        "session": ctx.session_id,
        "job": ctx.job_id,
    }


def _dumpable():
    libc = ctypes.CDLL(None, use_errno=True)
    return libc.prctl(3, 0, 0, 0, 0)  # PR_GET_DUMPABLE


async def describe(ctx, params):
    """What the worker can see about itself: the isolation tests read this."""
    tmp = os.environ.get("TMPDIR") or ""
    st = os.stat(tmp) if tmp else None
    limits = {name: list(resource.getrlimit(getattr(resource, name)))
              for name in ("RLIMIT_AS", "RLIMIT_NPROC", "RLIMIT_NOFILE", "RLIMIT_CORE", "RLIMIT_FSIZE")}
    return {
        "sysPath": list(sys.path),
        "cwd": os.getcwd(),
        "home": os.environ.get("HOME"),
        "tmpdir": tmp,
        "tmpMode": stat.S_IMODE(st.st_mode) if st else None,
        "tmpOwner": st.st_uid if st else None,
        "env": dict(os.environ),
        "uid": os.getuid(),
        "euid": os.geteuid(),
        "gid": os.getgid(),
        "groups": os.getgroups(),
        "pid": os.getpid(),
        "pgid": os.getpgid(0),
        "nice": os.nice(0),
        "rlimits": limits,
        "dumpable": _dumpable(),
        "flags": {"isolated": sys.flags.isolated, "no_site": sys.flags.no_site},
    }


async def sleep(ctx, params):
    seconds = float(params.get("seconds", 1))
    await asyncio.sleep(seconds)
    return {"slept": seconds}


async def crash(ctx, params):
    os._exit(int(params.get("code", 3)))


async def raise_plugin_error(ctx, params):
    raise PluginError(params.get("code", "echo_refused"),
                      params.get("message", "Echo refused this on purpose."))


async def raise_other(ctx, params):
    raise RuntimeError("echo fixture: an unexpected failure (detail 4242 stays in the log)")


async def print_noise(ctx, params):
    print("noise on stdout {not json")
    sys.stdout.write("more noise\n")
    sys.stdout.flush()
    os.write(1, b"noise written to fd 1\n")
    sys.stderr.write("noise on stderr\n")
    return {"printed": True}


async def big_result(ctx, params):
    return {"blob": "x" * int(params.get("bytes", 3 * 1024 * 1024))}


async def import_site_package(ctx, params):
    name = params.get("module", "fastapi")
    try:
        __import__(name)
    except ImportError:
        return {"module": name, "importable": False}
    return {"module": name, "importable": True}


def not_async(ctx, params):
    return {"never": "reached"}


async def read_session(ctx, params):
    transcript = await ctx.sdk.session.read()
    return {"events": len(transcript.get("events") or []), "meta": transcript.get("meta")}


async def call_llm(ctx, params):
    out = await ctx.sdk.llm.invoke(
        [{"role": "user", "content": params.get("prompt", "Say hello in one word.")}],
        max_tokens=params.get("max_tokens"))
    return {"content": out.get("content"), "model_used": out.get("model_used")}


async def propose_override(ctx, params):
    """Proposes the factory text of one part plus a marker line, for review tests."""
    skill = params.get("skill", "path_traversal")
    part = params.get("part", "payload_reference")
    current = await ctx.sdk.override.get("skill.text", skill)
    factory = next(p["text"] for p in current["parts"] if p["partId"] == part)
    out = await ctx.sdk.override.propose(
        "skill.text", skill, {part: factory + "\n" + FIXTURE_MARKER},
        note="Echo fixture proposal: the factory text plus one marker line.",
        scope=params.get("scope", "user"))
    return {"reviewProposal": {"extensionPoint": "skill.text", "changeSetId": out["changeSetId"]},
            "fromRevision": out["fromRevision"]}
