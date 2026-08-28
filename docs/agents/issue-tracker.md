# Issue tracker: GitHub

Issues and specifications for this fork live in GitHub Issues:

https://github.com/magickaichen/anarlog/issues

GitHub Issues are enabled for this fork. Files under `docs/agents/specs/` may
route related work to its authoritative issues, but must not duplicate issue
requirements or acceptance criteria.

Use the `gh` CLI for issue operations. Pass `--repo magickaichen/anarlog`
explicitly, especially for mutations, so commands never target the upstream
repository accidentally.

## Conventions

- Create one issue per independently verifiable change.
- Use issue bodies for requirements, acceptance criteria, decisions, and
  supporting evidence.
- Use issue comments for progress, discoveries, and changes to the plan.
- Link related issues and pull requests instead of duplicating their content.
- Treat bare issue references such as `#42` as issues in
  `magickaichen/anarlog`, unless another repository is named explicitly.
- Search for an existing issue before creating a new one.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull requests are implementation artifacts, not the primary backlog. Convert
new work discovered during review into an issue when it should be tracked
separately.

## When a skill says publish or fetch

- `publish` means create or update the corresponding GitHub issue.
- `fetch`, `hydrate`, or `inspect` means read the current issue, comments,
  labels, and linked pull requests using `gh`.
- Preserve GitHub as the source of truth after publishing. Do not maintain a
  second local copy of the issue unless a skill explicitly requires one.

## Wayfinding operations

When locating work:

1. Search open issues by relevant product and technical terms.
2. Inspect matching issue bodies, comments, labels, and linked pull requests.
3. Check closed issues when investigating prior decisions or regressions.
4. Confirm the current implementation in the repository before treating an
   old issue description as current behavior.
