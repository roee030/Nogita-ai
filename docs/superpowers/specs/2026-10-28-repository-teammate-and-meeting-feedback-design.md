# Repository teammate and meeting feedback design

## Intent

Nogita should answer engineering questions from the whole repository, quickly and with file/commit evidence. In a meeting, people should know when she heard a request, when it is taking longer, and why she left or could not finish.

## Goals

- Index all supported, non-generated, non-secret text files in the configured repository ref, including project docs and root configuration files.
- Retrieve relevant code or commit evidence and include it in one concise reasoning call in the common case.
- Answer questions about recent commits on the configured branch from GitHub commit metadata, not source-code guesses.
- Make the first user-visible acknowledgement arrive as soon as the transcript quiet-window closes; avoid an additional progress utterance for ordinary short answers.
- Post a safe, concise chat notice before a controlled leave and best-effort notices for provider-reported exits/fatal errors.
- Surface provider processing errors in chat without exposing raw logs, secrets, or meeting transcript content.

## Non-goals

- Sending the complete repository to the model on every question.
- Indexing credentials, binary files, generated output, or dependency lockfiles.
- Claiming an exit notice was delivered when Attendee rejected the chat request.
- Changing the meeting provider, authorization rules, or task-writing permissions.

## Approaches

1. Send every repository file in each model request. Rejected: slow, expensive, and constrained by context size.
2. Keep the current capped lexical index and add more prompt instructions. Rejected: it can miss files and still needs sequential planner and answer calls.
3. Build a full in-memory index of supported repository text, retrieve concise evidence (including commit history when asked), and let the existing reasoning call answer directly from that evidence. Chosen: fits the current small repo, avoids new vendors/dependencies, and reduces the usual code-answer path to one model call.

## Decisions

- Preserve a bounded per-file size and safe-path filter, but do not silently cap the repository at 300 files or 5 MiB. Fail indexing explicitly if GitHub reports a truncated tree that cannot be expanded.
- Include extensionless project files such as Dockerfile, Makefile, Procfile, .gitignore, and .dockerignore.
- Cache the repository revision/index in memory and refresh it periodically rather than fetching the full tree on every utterance.
- Treat repository excerpts and provider log fields as untrusted data. Never echo raw logs into a meeting.
- Keep the existing speaker-fragment quiet window to avoid interrupting a speaker; send a chat acknowledgement immediately after that window, then a distinct spoken/chat progress update only for unusually slow work.
- For provider-reported leave/fatal events, attempt one safe chat notice before local cleanup and record delivery failure without claiming success.

## Constraints and success criteria

- No new runtime dependency or paid provider call is required for indexing; mock all GitHub/Attendee behavior in tests.
- The full current repository index includes every supported text file; secret, generated, binary, and lock files remain excluded.
- A code question with direct evidence can be answered in one Anthropic request, with a repository source reference in chat.
- Tests prove acknowledgement ordering, no duplicate progress for quick answers, and safe best-effort exit/error notices.
- Full test suite and TypeScript checks pass.

## Review findings before release

- Repository evidence must be fetched only after `mayReadCode` authorizes the speaker. The prefetch path is limited to questions with an explicit repository hint; ambiguous questions still use the planner's `inspect_code` path.
- The current lexical retrieval returns at most four excerpts and rejects supported files larger than 100 KiB. Passing tests does not establish that Nogita can answer every question about every file. Cross-file questions and large-file coverage need dedicated evaluation before claiming full repository fluency.
- The realtime voice path currently uses a fixed Deepgram voice and a 500 ms speech endpoint plus a 1.2-second quiet window. Natural turn-taking, interruption handling, prosody, and perceived latency require recorded meeting tests; this change does not certify humanlike conversation.
- Jira, Slack, and GitHub adapters exist, but live connectivity in the deployed environment must be checked separately from unit tests. Provider-reported exit notices remain best effort if the meeting provider has already disconnected the bot.
