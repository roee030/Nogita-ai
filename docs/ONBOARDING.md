# Onboarding a pilot team

How to connect one team to Nogita without changing code. It takes about an hour with someone from the team who can
create tokens in their Jira, GitHub and Slack. Phase 6's gate is that they then use her with no code change
(`docs/WORK_PLAN.md`).

## 1. Start from the template

```bash
npm run onboard -- --template > acme.json
```

The file holds no secrets. Every token is a reference, `"env:NAME"`, read from the environment when the file loads
(on Render: the service's environment variables; locally: `.env`).

| Field | What to put |
|---|---|
| `tenant.id`, `tenant.name` | A short id (lowercase, dashes) and the team's name |
| `tenant.timeZone`, `tenant.weekStartsOn` | Where the team works, such as `Asia/Jerusalem` and `sunday`. Without them "today" means UTC |
| `ai.mode`, `ai.anthropicApiKey` | `live`, and `env:` the variable holding the Anthropic key |
| `boards` | Their Jira site (`baseUrl`, a bot account's `email`, `token`, `projectKey`). Mark the one new tasks go to as `default` |
| `repositories` | Their GitHub `owner`, `repo`, the branch they ship from as `ref`, and a read-only `token` (or `publicRepo: true`) |
| `chat` | Their Slack bot token. Optional: without it there are no Slack threads and no hand-off from a meeting |
| `people` | Everyone who will talk to her: `id`, `displayName`, `email`, and `jiraAccountId` so tasks can be assigned to them |
| `authorizedActorIds` | The `people` ids that may read the code and open tasks. Everyone else gets general answers only |

## 2. Tokens

- **Jira:** an API token for a bot account that can browse and create issues in the project.
- **GitHub:** a fine-grained token with read access to the repository's contents. Add Pull requests write only if
  they want draft pull requests (`draftPullRequests: true`).
- **Slack:** a bot token (`xoxb-`) from an app installed in their workspace, invited to the channels she should read.
- Put each one in the environment under the name the file references.

## 3. Check it

```bash
npm run onboard -- --config acme.json
```

It checks the file, then calls each provider with the file's own settings, as readiness does: Jira, GitHub, Slack,
Anthropic, plus Deepgram and Attendee from the environment. Each line is ✓ (fine), ✗ (fix before the first
meeting) or · (optional). It never prints a secret. `--offline` checks the file only. Exit code 1 means something
is still missing.

Common fixes:

- **Jira refused (HTTP 401/403):** wrong email or token, or the bot account can't see the project.
- **GitHub refused (HTTP 404):** the token can't see the repository, or `ref` is not a branch. Use the branch they
  ship from, not a feature branch, or her answers about "what landed today" go stale.
- **Not in people:** an id in `authorizedActorIds` has no person with that id.

## 4. Run it

Set `NOGITA_TENANT_CONFIG` to the file's path (or to its JSON) on the server, restart, and check `/readiness`.
For the pilot meetings also set `NOGITA_TURN_LOG=redacted` (the default), `NOGITA_USAGE_LOG=true` and
`NOGITA_AUDIT_LOG=true`, so `npm run dashboard` can show their quality, cost and the phase 5 gates.

## 5. The first meeting

Sit in on it. Afterwards, run `npm run dashboard` and look at:

- lost questions
- writes in the audit log
- anything they had to repeat

Ask each person to rate how clear she was, from 1 to 5. That's the one gate no log records.
