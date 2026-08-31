# Branch HQ — Project Context for Claude Code

Read this first, every session. For deep architecture detail, read `branch-hq-developer-guide.md` in the project root next — this file is the short version plus the standing rules; that one has the full picture.

## What this is

An Electron + React/TypeScript desktop app that runs a small team of AI agents (Michael orchestrates, Jim/Dwight/Riley build, Pam reviews) to generate code, documents, and hold plain conversation — through one chat interface, with a deterministic security scanner (Gate 1) and a QA layer (Pam) sitting between generation and anything the user sees.

## Standing rules — apply these without being asked

- **Never guess at a bug from a description alone.** Read the actual file, or the actual error, before proposing a fix. Several real bugs this session were only found by opening the file/rendering the actual output and looking, not by reasoning from a symptom.
- **Run `npm test` after any change touching `src/main/gate1.ts`, `resilience.ts`, `settingsStore.ts`, or `auditStore.ts`.** A real test suite exists (Vitest) covering these specifically — use it, and add a new test case for any new bug found in these files, the same way the existing ones are grounded in real past bugs, not invented examples.
- **Two correction loops exist in the pipeline, and they're different:** the Gate 1 / Pam loop (review-time, catches bad code before it runs) and self-healing (execution-time, catches code that passed review but crashes when actually run). Don't conflate them when debugging a failure — check which stage it actually failed at.
- **Verify before claiming something is fixed.** After an edit, check the actual resulting file state (view it, grep for what should/shouldn't be there) rather than assuming a str_replace or edit landed cleanly. This has caught real self-introduced mistakes (a mis-escaped regex, an accidentally-deleted instruction line) before they shipped.

## Current real status (update this section as things change)

- Core pipeline, both specialists, Gate 1, Pam, self-healing, settings, audit export, cost tracking, search, overwrite protection: built and tested.
- Local model routing (Ollama/OpenAI-compatible provider): built, **not yet confirmed working end-to-end** — treat as unproven until someone has actually run a real request through it.
- Automated test suite: real, passing, covers Gate 1 + resilience + settings + audit store. Does not and cannot test whether generated code is actually *good* — that still needs a human watching it happen.

## Where things live

- `src/main/index.ts` — pipeline orchestration, all IPC handlers, agent prompts
- `src/main/gate1.ts`, `resilience.ts`, `settingsStore.ts`, `auditStore.ts` — pure logic, unit tested
- `src/main/__tests__/` — the test suite
- `src/renderer/src/components/` — ChatInterface, SandboxPreview, SettingsModal
- `branch-hq-developer-guide.md` — full architecture writeup, known open items, file map
