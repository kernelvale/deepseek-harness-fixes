# DeepSeek Harness repair report

English | [中文](FIXES.zh.md)

This public community repository combines three backend fixes and their regression tests on one `main` branch. It includes the complete upstream source and preserves its [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). The changes are not an upstream release.

## Source and scope

The source baseline is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), version `0.2.2-rc.1`, commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. The initial local import is a source snapshot; it does not claim to preserve the upstream commit graph. The three original independent fix commits remain available in [kernelvale/deepseek-harness](https://github.com/kernelvale/deepseek-harness).

| Fix | Trigger | Observable failure | Repaired behavior |
|---|---|---|---|
| Inherited inbox ownership | An inherited prefix contains a parent task insertion but excludes its later claim | A child performs parent work before its delegated task | A fresh delegation durably removes inherited pending input |
| Delegated model selection | A seeded child captures model B while its inherited selection still says A | The actual request uses A despite the new configuration | The child records its captured selection after the inherited prefix |
| Normal completion wake | A waking input arrives after the last empty-queue check and before idle publication | Input stays queued until another wake arrives | The finishing driver records a restart for the accepted input |

The first two failures are deterministic under the stated history and configuration conditions. The third is deterministic when its microtask timing window is forced; its frequency in ordinary usage has not been measured. These are local reproductions, not claims about observed production incidents.

## 1. A fork child replays a parent's queued task

### Reproduction and impact

1. While the parent processes task A, queue task B.
2. Let A finish. The parent claims B and starts its next turn.
3. Before that turn completes, create a fork child with delegated task C.
4. Forking copies only completed parent turns. That prefix contains B's insertion but excludes B's claim in the current turn.

Before the fix, the child reconstructs B as pending input and requests it before C. Users can see duplicated work, irrelevant child answers, extra model calls, or repeated tool side effects if B requests a mutating tool. The reproduction directly confirms repeated model input; destructive side effects are a code-based consequence and are not exercised against external systems.

### Cause and repair

The durable inbox projection replays inherited queue events as child-owned work. The [child manager](packages/subagent/subagent/src/manager.ts) now collects message identifiers from inherited insertion events and removes matching messages still pending in either child queue before publication. Those removals are ordinary child-session events, so restoration preserves them. Parent logs, parent queues, newly added child context, ordinary Session forks, and cold child resumes retain their own behavior.

Historical associations are [aaf50dc39adc](https://github.com/deepseek-ai/deepseek-harness/commit/aaf50dc39adcad8c34e4909b7d8d9c5dd9fcd874), the durable inbox projection change, and [b0a7d2ce3b4c](https://github.com/deepseek-ai/deepseek-harness/commit/b0a7d2ce3b4c19d7452e364b2d7acbfa87e707ed), the merge for PR #2672. PR #2746 later unified the Web queue with that projection. These associations come from code-diff tracing; a full historical bisection has not established the earliest introducing commit.

Evidence lives in [the ownership regression](packages/subagent/subagent/tests/fork-inherited-inbox.spec.ts) and [the shipped-profile recording](snapshots/session/fork-inherited-inbox/snapshot.yml). In the earlier independent comparison, both new cases failed on the unmodified baseline and passed after repair. Original independent fix: [932466e987fd](https://github.com/kernelvale/deepseek-harness/commit/932466e987fd62c945192790c8fcba46cee7c68e).

## 2. A child's captured model is overridden by inherited state

### Reproduction and impact

One trigger is completed parent history selecting A followed by an explicit fork-child selection of B. Another is a parent switching to B in its current, unfinished turn, then creating a default fork child while the completed prefix still selects A. A same-route explicit reasoning-effort clear can likewise be lost to the old inherited choice.

Before the fix, the child's creation configuration and actual model request disagree. This can affect capability, latency, cost, and reasoning behavior; changing providers may also cause an unexpected request failure if the inherited route is unavailable. Actual route mismatch is reproduced locally. No real provider billing or availability incident is claimed.

### Cause and repair

Session model-selection state takes precedence over creation options. The [child manager](packages/subagent/subagent/src/manager.ts) now writes the captured provider, model, and optional explicit reasoning effort into a fresh seeded child before publication. Omitting effort clears the old explicit selection and lets the adapter use its default. Existing child resumes preserve selections saved later by the child. Global selection precedence remains intact.

The historically related change is [b805300652a4](https://github.com/deepseek-ai/deepseek-harness/commit/b805300652a4ade0c81444dcda0af3bee103f922), PR #6298, which moved Session-first selection before step preparation. No full historical bisection has been performed.

Evidence lives in [the selection regression](packages/subagent/subagent/tests/fork-model-selection.spec.ts), [the permission regression](packages/subagent/subagent/tests/activation-policy.spec.ts), and [the model-switch recording](snapshots/session/fork-captured-model/snapshot.yml). The earlier unmodified-baseline comparison had three failures and two passing controls across five cases. The snapshot runner now checks each child's own recorded configuration and system-prompt versions. Original independent fix: [8cbb57341a54](https://github.com/kernelvale/deepseek-harness/commit/8cbb57341a5402cdc3fc31786cefdd5468e5bdb2).

## 3. A normal-completion handoff loses a new wake

### Reproduction and impact

Deliver a waking input in a microtask after the driver's final empty-inbox check but before that driver publishes idle. Both queued follow-up input and next-step steering input can trigger it. Ordinary delivery during active processing or after the driver is fully idle does not reproduce this window.

Before the fix, the input is accepted and remains queued, while the wake operation assumes the still-running driver will claim it. That driver has already decided to exit. Users can see an apparently ignored message that runs only after another waking input; SDK callers waiting for that queued turn can stall. The input is parked, not deleted.

### Cause and repair

The [agent-loop driver](packages/core/agent-loop/src/agent.ts) records a process-local finishing state once it commits to a normal exit. A wake in that state schedules a replacement driver after the current one settles. Cancellation clears an earlier restart, cancellation with retained inbox preserves parked input, a later post-cancellation wake still works, and context-only injection does not start a request. Failure to append the ending event follows the existing error path.

Historical associations are [f2e20c1ef04b](https://github.com/deepseek-ai/deepseek-harness/commit/f2e20c1ef04b27501016dabda696fe6891781489), the asynchronous driver handoff, and [df30c62e2b06](https://github.com/deepseek-ai/deepseek-harness/commit/df30c62e2b062da14fa0366728d821f416d72e57), PR #1870, which added a delayed wake for cancellation while leaving the normal-exit window uncovered. These are traced associations, not a completed historical bisection.

Evidence includes [ten loop cases](packages/core/agent-loop/tests/completion-wake.spec.ts), [the headless recording](snapshots/session/completion-wake-handoff/snapshot.yml), [the TypeScript SDK recording](snapshots/sdk/completion-wake-handoff/snapshot.yml), and [the Python SDK acceptance](python/sdk/tests/test_completion_wake.py). Nine earlier baseline cases produced three failures and six passing controls; the repaired cases and an additional ending-append failure case passed. The original Python comparison completed only the first turn and failed its expected two-turn assertion.

The SDK's first run still returns the result of its own input. An explicit wait joins the independent queued follow-up turn; this fix does not make the first result own that later work. Original independent fix: [1d2a2f7eab6a](https://github.com/kernelvale/deepseek-harness/commit/1d2a2f7eab6af39d6374283e922442963e9af6f3).

## Combined validation

The machine-readable [validation record](validation.json) lists commands and observed results for this combined checkout. The initial combined test invocation started before native build completion and failed because the native system module was absent; it is not counted as passing evidence. Regression results come from the subsequent invocation after a successful build.

| Combined-checkout check | Result |
|---|---|
| Full build, including aggregate type checks | 10 checks passed |
| Related behavior regressions | 58 files, 1,044 tests passed |
| Headless CLI and TypeScript SDK recordings | 16 passed; 226 outside the filter were not run |
| Python SDK handoff acceptance | 1 passed |
| Documentation checks | 43 passed |
| Static lint | Exit 0; one pre-existing unused-disable warning |

Earlier independent validation passed 545 related tests for each subagent fix, 501 loop tests for the wake fix, the associated headless recordings, six SDK recordings, and a Python acceptance plus runtime smoke. A previous source-overlay run passed all 17 new cases. The combined-checkout results in the validation record are the current evidence for this repository.

Validation uses Linux x64, Node.js 24.22.2, pnpm 11.28.5, and scripted adapters, recorded responses, or local mock services. There are no real-model API, Windows, macOS, installed-wheel, or single-file packaging results. No new public protocol fields, persistent event formats, CLI arguments, or configuration keys are introduced.

## Run this source

The official npm package does not include this community checkout's changes. To run this repository:

```sh
git clone https://github.com/kernelvale/deepseek-harness-fixes.git
cd deepseek-harness-fixes
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm dsh web
```

The prerequisites and platform build requirements are documented in the [development guide](docs/development.md). The [safety notice](SAFETY.md) applies.

## Upstream report

The upstream project disables Issues and pull requests and directs bug reports to [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions). The report is published as [upstream Discussion #12727](https://github.com/deepseek-ai/deepseek-harness/discussions/12727); its publication status is recorded in [the validation record](validation.json). The existence of this repair repository does not imply upstream acceptance or merge.
