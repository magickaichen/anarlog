# Triage labels

Use these labels as role-based workflow states. Repository-specific labels may
coexist with them, but must not replace their meanings.

| Label             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `needs-triage`    | The request has not yet been classified or validated.                      |
| `needs-info`      | Progress requires information or reproduction details from a human.        |
| `ready-for-agent` | Requirements and scope are clear enough for an agent to implement.         |
| `ready-for-human` | Agent work is complete and the result is ready for human review or action. |
| `wontfix`         | The request has been deliberately declined or will not be pursued.         |

## Transitions

- New or unclear requests start at `needs-triage`.
- Apply `needs-info` only when a specific unanswered question prevents useful
  progress.
- Apply `ready-for-agent` after the expected outcome and verification criteria
  are sufficiently clear.
- Replace `ready-for-agent` with `ready-for-human` when implementation and
  agent-owned verification are complete.
- Apply `wontfix` only with a comment explaining the decision.
- Remove obsolete workflow labels when applying a new workflow state.
- Do not use `needs-info` merely because implementation is difficult or
  incomplete.
