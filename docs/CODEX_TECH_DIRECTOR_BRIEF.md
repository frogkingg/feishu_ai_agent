# Codex Tech Director Brief

This file is the standing handoff note for Codex instances reviewing the MeetingAtlas / 会脉 Agent project.

## Role

Act as system architect and technical director. Review the codebase against the product intent, PRD direction, GitHub source of truth, and local runtime reality.

The product owner is responsible for experience, not code. Report technical findings as:

- user experience impact
- delivery risk
- repository or GitHub risk
- recommended next action

## Current Product Contract

- Product: MeetingAtlas / 会脉 Agent.
- Core value: turn meeting minutes into a personal execution loop and topic knowledge base.
- Default safety rule: confirmation-first side effects, dry-run by default.
- GitHub source of truth: `git@github.com:frogkingg/feishu_ai_agent.git`.
- Current local source of truth path: `/Users/xianjingheng/Documents/飞书比赛`.
- Main branch should stay aligned with `origin/main` unless a scoped Codex branch is intentionally active.

## Hourly Review Checklist

1. Compare local and remote repository state:
   - `git status --short --branch`
   - `git rev-parse HEAD`
   - `git ls-remote origin refs/heads/main`
2. Classify working tree changes:
   - product code changes
   - generated reports
   - local-only transcripts or runtime state
   - secrets or files that must never be committed
3. Run core checks:
   - `npm run build`
   - `npm run test`
   - `npm run format:check`
   - `npm run evaluate`
4. If `npm run evaluate` fails with `tsx` IPC `EPERM` in the sandbox, rerun outside the sandbox before calling it a product failure.
5. Check GitHub / CI state when available:
   - open PRs against `main`
   - failing GitHub Actions
   - branches that diverge from `main`
6. Review product alignment:
   - confirmation requests before side effects
   - `FEISHU_DRY_RUN=true` remains the safe default
   - real Feishu writes are not faked when CLI calls fail
   - user-facing card and confirmation flows stay inspectable

## Latest RC Acceptance Snapshot

Timestamp: 2026-05-06 Asia/Shanghai.

Status: Green for recording readiness, with card-action public click-through tracked separately.

Verified:

- RC branch: `codex/meetingatlas-production-rc`.
- RC commit: `6b9fb08 Fix MeetingAtlas production canary blockers`.
- `npm run build`: passed.
- `npm run test`: passed, 249 tests.
- Real LLM dry-run canary: passed with all Feishu write/card switches true and no real Feishu writes.
- Real Feishu task/calendar/Wiki/Doc write canary: passed in an isolated canary lane.
- Server deployment: public `/health` passed on commit `6b9fb08`; release posture remains dry-run.
- Feishu meeting-minutes webhook: signed `vc.meeting.recording_ready_v1` synthetic public callback returned accepted, duplicate event was idempotent, and the stored webhook event reached `processed`.

Recording wording:

- Say “默认演示保持 dry-run 和 confirmation-first”.
- Say “真实 LLM、真实飞书写入 canary、服务器健康检查、妙记事件回调均已验证”.
- Do not say the default shared service performs real task/calendar/wiki writes.
- Do not merge card-action public click-through with meeting-minutes event callback unless it is separately verified.

## Previous Manual Review Snapshot

Timestamp: 2026-04-30 21:20 Asia/Shanghai.

Status: Green with one repository-hygiene warning.

Summary for product owner: the project builds, tests pass, and mock evaluation passes; the only immediate risk was local transcript/report artifacts appearing in the working tree.

Verified:

- Local `HEAD`: `15b3f4b0f146d2fa316ad1f29b7a62da2fd37d96`.
- Remote `origin/main`: `15b3f4b0f146d2fa316ad1f29b7a62da2fd37d96`.
- `npm run build`: passed.
- `npm run test`: passed, 32 files / 117 tests.
- `npm run format:check`: initially failed on four files, then passed after Prettier-only formatting.
- `npm run evaluate`: passed outside the sandbox, 8/8 samples, mock fixture pipeline pass rate 100.0%.
- `git diff --check`: passed.

Local changes from this review:

- Prettier-only formatting in `src/server.ts`, `src/tools/larkVc.ts`, `tests/tools/larkVc.test.ts`, and `tests/workflows/createKnowledgeBaseWorkflow.test.ts`.
- `evaluation-output/mock-fixture-evaluation-report.md` timestamp refreshed by `npm run evaluate`.
- `.gitignore` now ignores `minutes/` so local meeting transcripts are not accidentally committed.
- This handoff document was added.

Current working-tree items to inspect before commit:

- `evaluation-output/real-llm-evaluation-report.md` is untracked and should be explicitly decided before publishing.
- `minutes/` contains local transcript downloads and should stay local-only.

## Reporting Format

When the product owner asks for progress, answer in Chinese:

- overall status: Green / Yellow / Red
- what changed since the last review
- what is ready for demo
- what blocks the next product milestone
- what decision is needed from the product owner, if any

Keep the answer experience-first. Avoid exposing low-level implementation detail unless it affects delivery, quality, privacy, or demo confidence.
