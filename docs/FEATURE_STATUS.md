# GV GR Bot Feature Status

Status describes code-path evidence from the repository and local tests, not proof of live Discord availability.

| Feature / command | Registration and handler | State | Evidence / dependency |
|---|---|---|---|
| `/staff-panel` and clock buttons | Registered; `clock.js`, `staffCenter.js`, `services/clock.js`, `services/staffRewards.js` | Implemented; locally covered | Panel refresh, shift persistence, points, and stats tests pass; requires configured staff activity channel and Discord permissions |
| `/staff-center` | Registered; `staffCenter.js` | Implemented; locally covered | `staffPanels.test.js`, `staffReminders.test.js`, `staffRewards.test.js`; private interaction and SQLite |
| `/management-dashboard` | Registered; `staffCenter.js` → `staffManagement.js` | Implemented; partially covered | Management access, selected actions and shift operations tested; remaining action combinations need broader coverage |
| `/owner-dashboard` | Registered; `staffCenter.js` → `staffManagement.js` | Implemented; partially covered | Owner settings and cleanup tested; all individual settings and component routes not exhaustively tested |
| `/leaderboard` | Registered; `clock.js` → `services/activity.js` | Implemented; locally covered | Weekly/monthly/all-time calculations tested; requires eligible staff role |
| `/session start`, `/session end`, `/session status` | Registered; `operations.js` → `events.js` and `services/operations.js` | Shared lifecycle; locally covered | Start uses the same staged draft, preview, confirm, create and publish path as Staff Center. End/status use shared persisted lifecycle. Existing legacy join buttons remain routed. |
| `/event create`, `/event list`, `/event cancel` | Registered; `operations.js` → `events.js` and `services/operations.js` | Shared service; locally covered | Create, list, and cancel use the shared event persistence/query/publish/cancel path; slash create retains basic input options and default type/duration/voice values. |
| Staff Center Events panel | `events.js` and `services/operations.js`; `gv:center:event:*`, `gv:event:*` routed in `index.js` | Implemented; locally covered | Draft/channel checks, shared stable-ID persistence, RSVP, edit/host/cancel, completion, reminder deduplication, and event-history writes are covered locally. |
| Staff Center RP session panel | `events.js` and `services/operations.js`; `gv:rp:*` routed in `index.js` | Implemented; locally covered | Start preview/confirm, lifecycle, duplicate prevention, role rechecks, slash parity, and history retention tests pass. User-facing RP History panel entry was removed; persisted historical sessions/participants remain. |
| `/staffwarn` | Registered; `staff.js` | Handler present; direct coverage gap | Management-only, configured staff target, warning table and log channel; no dedicated command test identified |
| `/staffnotes add`, `/staffnotes view` | Registered; `staff.js` | Handler present; direct coverage gap | Management-only, private response, SQLite notes; no dedicated command test identified |
| `/staffhistory` | Registered; `staff.js` | Handler present; direct coverage gap | Management-only; reads warnings, notes, shifts, and activity summary; no dedicated command test identified |
| `/staffannounce` | Registered; `staff.js` | Handler present; direct coverage gap | Management-only; sends to configured staff-announcement channel; no dedicated command test identified |
| `/staffconfig channel`, `/staffconfig role` | Registered; `staff.js` | Handler present; direct coverage gap | Owner-only; persistent SQLite settings and audit ledger; no direct command test identified |
| `/report` and report status buttons | Registered; `safety.js`, `buttons/index.js` | Implemented; privacy-stabilized; locally covered | Cooldown and persistence covered; public or unverifiable destination is not sent to; actual destination overwrites still require live verification |
| `/mod warn`, `/mod kick`, `/mod ban`, `/mod timeout` | Registered; `safety.js` | Implemented; partial coverage | Manager gate, cooldown, bot permission check for punitive actions, moderation log; actual hierarchy/API results require Discord integration test |
| `/announcement-builder create`, `edit`, `templates` | Registered; `announcements.js` | Implemented; locally covered | Existing preview/edit/template workflow retained and shares the same publisher with custom messages; create/edit/publish and validation tested |
| Management Dashboard `📨 Send Custom` | `staffManagement.js` → `announcements.js`; `mgmt:send_custom` and `gv:announce:*` | Implemented; locally covered | Configured channel picker, text and up to 10 JSON embeds, fields, HTTPS images/links, optional link buttons/reactions, preview/edit/cancel/publish, safe mentions and partial reaction failure handling tested |
| `/ticket-panel` and ticket components | Registered; `tickets.js` | Implemented; locally covered | Panel persistence, category privacy, duplicate protection, role-limited decisions, close/transcript behavior tested |
| AutoMod | Gateway handlers in `index.js`; `events/automod.js`, `services/automod.js` | Opt-in; locally covered | Log-only default, optional intent, filters, exemptions, cooldowns, and timeout behavior tested; production requires matching Discord privileged intent when enabled |
| Message-delete notifications | `events/messageDelete.js` | Disabled/no-op by design | README and panel tests confirm disabled; no deletion logging was enabled or changed |
| Railway deployment | README only; no deployment manifest | Not verified | Must confirm `npm start`, Node runtime, and persistent volume mount to the resolved SQLite path in Railway |

## Slash Command Registration

Every top-level command in `src/commands/definitions.js` is dispatched by `src/index.js` to a matching handler. The live guild registration was not verified because no credentials were available. The registrar logs errors but does not stop the running process if registration fails.

## Phase 3 Notes

- The six operational channel settings still have valid-looking values but all resolve to one destination. Intended channel separation and effective Discord permissions require an authorized Owner decision and live verification; this workspace did not change the settings or print IDs.
- Event and RP session data remain in separate SQLite tables and lifecycles. No event/session records or audit/history rows were deleted.

## Phase 4A Configuration Status

| Setting | Purpose | Owner must confirm |
|---|---|---|
| `STAFF_ACTIVITY_CHANNEL_ID` | Duty panel, activity, reminders | Intended audience and staff/bot access |
| `STAFF_ANNOUNCEMENT_CHANNEL_ID` | Staff announcements and builder destination | Staff-only versus broader audience and mention policy |
| `STAFF_LOG_CHANNEL_ID` | Staff/moderation audit posts | Private management/Owner access |
| `REPORT_CHANNEL_ID` | Player report review | Private audience; code suppresses delivery if `@everyone` View Channel is not denied |
| `SESSION_CHANNEL_ID` | RP session announcements | Member audience and bot send/embed/attachment permissions |
| `EVENT_CHANNEL_ID` | Event announcements, RSVP and reminders | Member audience and bot send/embed/attachment permissions |

All six are syntactically configured but currently alias one destination; no IDs were copied into this report or changed. Live channel overwrites, role hierarchy, application-review membership, intents, command registration, and Railway persistence require Owner/service access and remain unverified. SQLite is WAL-backed, enables foreign keys, uses additive migrations, and resolves `./database.sqlite` from the process working directory.

## Send Custom Limitations

- The modal accepts HTTPS image URLs; it cannot upload local attachments. URL syntax is validated, but remote image reachability, MIME type, and Discord-side rendering are not verified before publication.
- Only HTTPS link buttons are offered; arbitrary custom-ID actions are intentionally omitted because no additional button actions are implemented.
- `allowedMentions.parse` is empty, so `@everyone`, `@here`, role, and user pings are suppressed rather than requiring a confirmation flow.
- Discord API, role hierarchy, and destination overwrites require live test-server verification; unit mocks do not establish those live conditions.
