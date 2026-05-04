# DurableLoop Migration Status

## Initial state

- 2026-05-04: Ran `git switch main && git pull --ff-only`.
- 2026-05-04: Ran `gh issue list --state open --limit 100`.
- Target issues #1015, #1016, #1017, #1018, and #1019 are open.
- Related open issues exist, including #502, but the #1015-#1019 sequence remains the priority. No blocker, duplicate, or prerequisite has been identified yet.
- Untracked `.pulseed-sandbox/` existed before these edits and is left untouched.

## #1015 Define the DurableLoop naming contract and compatibility policy

- Status: in progress.
- Branch: `codex/issue-1015-durable-loop-contract`.
- Issue body reviewed with `gh issue view 1015`.
- Current `CoreLoop|core-loop|coreloop` usage was inventoried with `rg` across docs, source, and tests.
- Plan: add a short naming contract note only. Do not perform implementation renames in this issue.
- Review: separate review agent found one material issue: `tmp/` is gitignored, so the files must be committed with `git add -f`. The note content otherwise satisfies the acceptance criteria.
- Verification: `npm run typecheck` passed. `npm run lint:boundaries` passed with existing warnings and no errors.
