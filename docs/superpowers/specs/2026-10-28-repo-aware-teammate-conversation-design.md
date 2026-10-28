# Repo-aware teammate conversation design

## Intent
Nogita should answer repository questions with the competence of a codebase-aware engineering agent, then express the answer like a concise, natural teammate. The user should not hear silence during longer work, nor have Nogita mistake a short pause for the end of a turn.

## Goals
- Search the full configured repository, not only files whose paths match query words.
- Ground repository answers in retrieved code and identify the source file naturally.
- Keep a bounded in-memory index per repository tree revision; exclude known secret/credential files and never persist source outside the process.
- Make spoken answers direct, concise, and conversational.
- For work that takes longer than a short threshold, speak one varied progress acknowledgment and then the final answer.
- Debounce provider-final speech so a short thinking pause does not immediately trigger Nogita.

## Non-goals
- No vector database, external embeddings, code mutations, or repository writes.
- No promise that every possible question can be answered: Nogita must say when the indexed repository lacks evidence.
- No audio/transcript retention and no user-visible storage of source code.
- No changes to authorization, task creation, or leave behavior.

## Approaches
1. **Fetch and index all eligible files in memory per Git tree revision (chosen).** Fetch the configured repository's bounded source/config/docs files, rank query matches across both file paths and contents, and return compact excerpts. This directly fixes path-only recall and avoids a new paid service; first cold lookup has a bounded indexing cost, then later lookups reuse the index.
2. Call GitHub Code Search for every question. This avoids downloading all files, but depends on API search availability/authorization and offers less control over cross-file ranking and excerpt selection.
3. Send the entire repository to Claude on every question. This is simple in concept but is slow, expensive, context-limited, and exposes much more code per request than needed.

The chosen approach uses GitHub tree/blob APIs and a bounded lexical index. The server warms the index in the background at startup; a first question arriving during warmup shares the same in-flight indexing promise. Search uses both the caller's full question and the planner's code terms/synonyms, not just the planner's shortened query. The answer model receives only the best evidence excerpts, with prompt guidance to answer like a concise teammate and name the relevant file. An in-memory cache is keyed by the Git tree SHA and refreshed automatically when the configured ref changes.

## Conversation behavior
After a directly addressed request begins processing, schedule one progress phrase after 900 ms. If the answer finishes first, cancel it. Otherwise choose a natural phrase from a varied set, never repeat the same phrase twice in a row within a meeting, and finish with the answer. Keep spoken code answers to at most four short sentences and roughly 55 words. Provider-final speech uses the existing 1200 ms same-speaker quiet window rather than flushing immediately; additional fragments or non-empty interim recognition from the same speaker reset the timer without duplicating interim text.

## Constraints and safety
- Keep repository and index memory bounded: at most 300 files, 5 MiB source bytes, files at most 100 KiB, at most four returned evidence excerpts, each excerpt at most 2400 characters.
- Exclude secret files and generated/dependency/build paths, including `.env*`, `node_modules`, `dist`, `build`, `.git`, `vendor`, `coverage`, and lockfiles.
- Exclude `.env*` variants, sensitive directory/file names such as `secrets/`, `credentials.*`, `service-account.*`, `private_key`, `id_rsa`, and private-key/certificate bundles before fetching. This is path-based protection; a secret embedded in an otherwise ordinary source file cannot be reliably identified by filename and may be included in evidence.
- Reject malformed or unsupported blob payloads instead of caching an incomplete revision; sanitize JSON parse failures so provider response bodies are never interpolated into errors.
- Fetch blobs by the SHA supplied by the selected Git tree so one index never mixes revisions.
- Keep cache process-local; clear in-flight cache state on errors so a later request can retry.
- A progress acknowledgment is speech, with existing chat fallback on TTS failure; it is not a claim that work is complete.
- Keep authorization and external-action policy unchanged.

## Acceptance
- A query whose terms appear only inside a generically named source file returns that file as evidence.
- A cache hit performs no additional blob requests; a changed tree SHA rebuilds the index.
- Secret/generated paths are not fetched; oversized/truncated repositories fail safely or remain bounded.
- Evidence answers are concise, conversational, grounded, and identify their source.
- A fast request has no progress speech; a slow request has exactly one varied progress phrase before its final response.
- Two provider-final fragments separated by less than the quiet window become one command; resumed interim speech postpones dispatch, and no command is emitted before the window expires.
- Full test suite and TypeScript typecheck pass. No live call or paid service is required for automated verification.

## Builder calls
- Use weighted lexical/phrase scoring across all indexed file contents and paths; no new dependency or external vector store.
- Use bounded concurrency for the initial blob fetch and keep snippets around matching lines rather than returning file prefixes.
- Keep the current English meeting voice; use plain first-person teammate phrasing without claiming facts that evidence does not support.
