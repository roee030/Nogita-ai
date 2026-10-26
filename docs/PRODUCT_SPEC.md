# Nogita V1 — Product Contract

**Date:** 2026-10-26  
**Audience:** Development and QA.  
**Current implementation:** foundations only.

## Mission

Nogita participates in invited engineering meetings and offers one combined user experience:

1. A conversational English voice assistant with context from the current meeting.
2. A code-aware technical teammate grounded in authorized GitHub/Jira/Slack information.
3. A task executor capable of creating and assigning real issues, returning receipts in meeting chat, and drafting small PRs when explicitly requested and authorized.

All three capabilities must operate together before labeling a release `V1`.

## Interaction state machine

`NOT_INVITED -> JOINED_SILENT -> DIRECTLY_ADDRESSED -> ANSWERING/EXECUTING -> JOINED_SILENT -> LEFT`

Parallel passive lane: `JOINED_SILENT -> IMPORTANT_CONTRIBUTION_DETECTED -> HAND_RAISED -> WAITING_FOR_DIRECT_ADDRESS`

Invariants:

- `speak()` is called **only** within the `DIRECTLY_ADDRESSED` request context.
- No implicit 20-second follow-up window: a new spoken reply requires addressing "Nogita" again.
- An accepted raised hand is not permission to speak. The facilitator must still say Nogita's name.
- `sendCompletion()` runs only for completion of an explicitly requested task or code lookup.
- Task completion never triggers autonomous speech. Spoken acknowledgement is allowed in the directly addressed turn at task start.
- A native raise-hand capability that is unsupported remains pending internally. It does not become chat spam or unrequested speech.
- A command heard in a conversation that is **not addressed to Nogita** does not grant permission to do anything.
- No transcript archive or recording by default. Check underlying provider controls and retention separately.

## Required V1 scenarios

| ID | Situation | Expected |
| --- | --- | --- |
| P01 | Invited by authorized user | Joins one meeting; no autonomous joining from calendar |
| P02 | Team speaks for ten minutes | Passive listening and context maintenance; no unsolicited answers |
| P03 | Someone says "Nogita, explain the trade-off" | Replies concisely in English via voice, using context |
| P04 | Follow-up without calling its name | Remains silent |
| P05 | Recognizes significant missed edge case | Raises hand, no voice or chat |
| P06 | Host acknowledges hand but does not say name | Remains silent |
| P07 | Participant says "Nogita, what did you want to add?" | Gives reason and evidence |
| P08 | Authorized participant asks about code | Reads correct repo, returns verified explanation with source references |
| P09 | Authorized participant requests a task | Uses project/board config, validates owner, creates issue, posts completed link |
| P10 | Explicit request to prepare small PR | Branch, check, draft PR only, no merge; post link after completion |
| P11 | Impostor or unauthorized speaker asks to create issue | Denied, no write |
| P12 | Meeting ends | Leaves, purges temporary conversational content |
| P13 | Provider failure | Error status; no falsely reported successful action |

**Currently incomplete:** P01/03/07/10 end-to-end, live provider permissions, real speech stream, provider-native hand raising, durable write idempotency, reliable topic-aware suggestions.

## Voice handling requirements

- Real-time STT + LLM + TTS, or speech-to-speech architecture, selected by measured latency, interruption handling, speaker identification, and provider availability.
- Voice activity detection and interruption support.
- No reactivation on own synthesized speech.
- Explicit address phrase detection with confirmation where ambiguous.
- No automatic speech after tool completion, even if other people have been speaking.
- English spoken conversation; translation/localization is future scope.

## Definition of Done for V1

A controlled Google Meet meeting demonstrates: contextual voice, grounded GitHub question answering, Jira issue creation and chat receipt, Slack mentions and retrieval, small draft PR creation, unsolicited raise-hand without speech, authorized identity mapping, and privacy enforcement — with live integration logs and human QA, not just mocks.
