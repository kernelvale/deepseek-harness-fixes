"""Python SDK projection of a new input accepted during normal turn handoff."""

from __future__ import annotations

import json
import os
from pathlib import Path
import runpy
import shlex
import shutil

import pytest
from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness


REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "apps/cli/lib/bin.js"


class WaitResponse(BaseModel):
    """Empty acknowledgement returned by the public session/wait operation."""


@pytest.mark.skipif(os.name != "posix", reason="the test launcher uses a POSIX shell wrapper")
def test_completion_wake_preserves_the_second_turn(tmp_path: Path) -> None:
    node = shutil.which("node")
    if node is None or not CLI.is_file():
        pytest.skip("requires Node.js and the built dsh CLI")
    fixture = runpy.run_path(str(REPO / "scripts/smoke-python-runtime.py"))
    launcher = tmp_path / "dsh-runtime"
    launcher.write_text(f"#!/usr/bin/env bash\nexec {shlex.quote(node)} {shlex.quote(str(CLI))} \"$@\"\n")
    launcher.chmod(0o700)
    sessions = tmp_path / "sessions"
    patch = fixture["write_profile_patch"](
        tmp_path, "handoff.patch.yml", sessions,
        [{"insert": [{"id": "python-completion-wake", "name": str(
            REPO / "snapshots/sdk/completion-wake-handoff/driver.mjs"
        )}]}],
    )
    with fixture["MockModel"]() as model:
        with DeepSeekHarness(
            provider="deepseek-official", model="smoke-model", cwd=str(tmp_path),
            dsh_bin=str(launcher), dsh_home=str(tmp_path / "home"), patches=(str(patch),),
            api_key="sk-keyless-smoke", base_url=model.url,
            env={"DSH_TELEMETRY_DISABLED": "1"}, request_timeout_seconds=30,
        ) as harness:
            result = harness.run("FIRST_TASK", session_id="completion-wake")
            # The prompt result owns its first idle; wait also joins the queued follow-up.
            harness.client.request("session/wait", {"sessionId": "completion-wake"}, response_model=WaitResponse)
    logs = list(sessions.rglob("session.v4.jsonl"))
    assert len(logs) == 1
    rows = [json.loads(line) for line in logs[0].read_text().splitlines()]
    observed = {
        "final_response": result.final_response,
        "turn_starts": sum(row["type"] == "turn/start" for row in rows),
        "turn_ends": sum(row["type"] == "turn/end" for row in rows),
        "inputs": [block["text"] for row in rows if row["type"] == "user/message"
                   and row["data"]["source"]["kind"] in {"user", "completion-wake-fixture"}
                   for block in row["data"]["content"] if block["type"] == "text"],
    }
    expected = Path(__file__).with_name("expected") / "completion-wake.json"
    assert observed == json.loads(expected.read_text()), observed
