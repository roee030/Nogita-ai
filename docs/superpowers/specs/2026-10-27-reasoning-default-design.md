# Low-cost live reasoning default

## Goal

Reduce Nogita's live-reasoning setup from two required secrets/settings to one provider key without silently purchasing service or creating credentials.

## Design

- Keep Anthropic as the existing reasoning adapter.
- Use `claude-haiku-5-5` when `ANTHROPIC_MODEL` is absent or blank.
- Keep `ANTHROPIC_MODEL` as an explicit override for operators.
- Treat the reasoning readiness check as ready when live mode and the API key are present.
- Never create, print, or commit an API key, and do not make a live model call without operator-provided credentials.

## Rationale

Anthropic documents `claude-haiku-5-5` as its fast, cost-sensitive model for realtime chat and live support. On 2026-10-27 its published price for prompts up to 100K tokens is $0.10 per million input tokens and $0.50 per million output tokens.

Source: https://www.anthropic.com/claude/haiku

## Verification

- A request with no model override sends the maintained model ID.
- An explicit model override still wins.
- Readiness accepts live mode plus an API key without a model setting.
- Existing schema, safety, and provider-error tests remain green.
