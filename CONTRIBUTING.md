# Contributing to Motiva

Thank you for contributing to Motiva. This project focuses on reliable, evidence-based agent orchestration, so contributions should be clear, testable, and scoped to a specific improvement.

## How to Contribute

You can contribute by:

- Reporting bugs
- Proposing features or design improvements
- Improving documentation
- Adding or refining tests
- Submitting code changes

Recommended workflow:

1. Review the existing documentation in `README.md` and relevant source files before making changes.
2. Create a focused branch for your work.
3. Keep changes narrow in scope and avoid unrelated refactors.
4. Add or update tests when behavior changes.
5. Update documentation when commands, APIs, or user-facing behavior change.

For local development:

```bash
npm install
npm run build
npm test
npm run typecheck
```

Motiva requires Node.js 18 or newer.

## Code of Conduct

All contributors are expected to participate professionally and respectfully.

- Be constructive in discussions, reviews, and issue reports.
- Assume good intent and focus on technical substance.
- Do not engage in harassment, discrimination, personal attacks, or disruptive behavior.
- Accept feedback and provide it in a clear, actionable form.

Project maintainers may moderate discussions and contributions to keep collaboration productive and safe.

## Submitting Issues

Open an issue when you find a bug, have a feature request, or want to propose a significant change.

Please include:

- A clear summary of the problem or proposal
- Relevant context and expected behavior
- Steps to reproduce, if reporting a bug
- Logs, error messages, screenshots, or test output when useful
- Notes about your environment, such as Node.js version or provider configuration, when relevant

Before opening a new issue, check whether the topic has already been reported.

## Pull Request Guidelines

Pull requests should be easy to review and grounded in observable behavior.

Before submitting a pull request:

1. Confirm the branch contains only relevant changes.
2. Run `npm run build`, `npm test`, and `npm run typecheck`.
3. Update documentation or inline comments where needed.
4. Write clear commit messages and a concise pull request description.

Each pull request should include:

- What changed
- Why the change was needed
- How it was tested
- Any follow-up work, tradeoffs, or known limitations

Additional guidance:

- Prefer small, focused pull requests over large mixed changesets.
- Preserve existing project structure and naming conventions.
- Avoid breaking public behavior without documenting it clearly.
- If a change affects CLI behavior, reports, or state handling, include enough detail for reviewers to verify it quickly.

Maintainers may request revisions before merging.
