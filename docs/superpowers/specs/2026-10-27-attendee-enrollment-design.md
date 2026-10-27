# Privacy-safe Attendee identity enrollment discovery

## Goal

Make a real speaker's stable Attendee `speaker_user_uuid` discoverable during an authorized test meeting without logging or persisting meeting content.

## Design

- Accept candidates only from signature-verified Attendee transcript webhooks bound to a known bot/session.
- Record only an unmapped `speaker_user_uuid` and the observation timestamp.
- Never record transcript text, display name, meeting/session ID, bot ID, or the ephemeral speaker UUID.
- Keep candidates only in process memory for one hour, deduplicated and capped at 20.
- Expose candidates only through the existing bearer-authenticated admin API.
- Continue treating candidates as unverified until an operator intentionally adds the UUID to `IDENTITY_MAP_JSON` and restarts.

## Non-goals

The endpoint does not edit environment variables, approve an identity automatically, or prove which human spoke. The operator must correlate the controlled test turn and update deployment secrets explicitly.
