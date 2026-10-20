# GV GR Bot Repair Audit (Phase 1)

**Audit date:** 2026-10-20  
**Scope:** Read-only system audit, baseline verification, and stabilization of confirmed critical report-privacy handling. No deployment, production configuration change, migration, or record deletion was performed.

## Architecture

- **Runtime:** Node.js 20+, CommonJS, Discord.js 14. `package.json` defines `npm start` as `node src/index.js` and `npm test` as `node --test`.
- **Startup and registration:** `src/index.js` validates `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `SERVER_ID`; opens SQLite; creates the Discord client; registers every command from `src/commands/definitions.js` to one configured guild after `ClientReady`; and dispatches chat commands and component interactions.
- **Commands and panels:** `src/commands/` contains command-specific handlers and the Staff Center, Management, and Owner dashboards. `src/buttons/index.js` routes legacy clock/session/report buttons. `src/index.js` directly routes newer event, RP, ticket, announcement, management, and owner components.
- **Persistence:** `src/database/index.js` creates tables and indexes and performs additive column migrations. `src/services/` owns clock/activity, operations, staff rewards, and AutoMod logic. SQLite uses `config.DATABASE_PATH` (`./database.sqlite`) resolved against the process working directory; foreign keys and WAL are enabled. No migration in this audit was run against a production database.
- **Shared utilities:** `src/utils/discord.js` reads/writes SQLite settings, resolves role groups, fetches members, and sends configured-channel messages/logs.
- **Configuration and deployment:** `config.js` contains the single-server ID, role/channel defaults, and feature settings. `.env.example` lists required credential names; `.gitignore` excludes `.env`, SQLite data, and dependencies. `README.md` describes Railway persistent-storage requirements. No Railway, Docker, or Procfile deployment manifest is present. Railway must mount persistent storage at the configured database path, relative to the process working directory.
- **Dependencies:** `npm ls --depth=0` found all declared dependencies installed: better-sqlite3, discord.js, dotenv, luxon, and sharp. No dependency changes were made.

## Registered Commands and Routing

All commands below are present in `src/commands/definitions.js`, and the chat interaction dispatcher in `src/index.js` invokes the listed handler. Registration itself is attempted after Discord login/ready; it was not possible to verify the live application command list without credentials and a Discord connection.

| Command | Handler and dependencies | Access / channel behavior | Coverage and audit note |
|---|---|---|---|
| `/staff-panel` | `src/commands/clock.js` → `publishPanel`; clock service, staff-center utilities, SQLite settings | Server owner, management, or owner roles; posts/refreshes `STAFF_ACTIVITY_CHANNEL_ID` | `clock.test.js`, `staffPanels.test.js`; panel refresh and clock behavior covered |
| `/staff-center` | `src/commands/staffCenter.js`; staff rewards/activity services and panel utilities | Configured staff, management, and owners; ephemeral | `staffPanels.test.js`, `staffReminders.test.js`, `staffRewards.test.js` |
| `/management-dashboard` | `src/commands/staffCenter.js` → `staffManagement.js`; staff rewards/audit data | Active configured management/owner; ephemeral | `staffPanels.test.js`; panel and selected controls tested, not every action |
| `/owner-dashboard` | `src/commands/staffCenter.js` → `staffManagement.js`; staff rewards/settings/audit data | Server owner or configured Owner; ephemeral | `staffPanels.test.js`; settings and cleanup tested |
| `/leaderboard` | `src/commands/clock.js` → `services/activity.js` | Staff or management; ephemeral | `activity.test.js`, `staffPanels.test.js` |
| `/session start`, `end`, `status` | `src/commands/operations.js` → `src/commands/events.js` / `src/services/operations.js`; sessions/participants | Start/end management-only; status available in guild; staged workflow uses `SESSION_CHANNEL_ID` | Phase 2 tests verify shared lifecycle and panel/slash parity |
| `/event create`, `list`, `cancel` | `src/commands/operations.js` → `src/commands/events.js` / `src/services/operations.js`; events/history/reminders and configured event channel | Create/cancel management-only; list available in guild | Phase 3 tests verify shared event service, list, publish, retry, cancel and event persistence |
| `/staffwarn` | `src/commands/staff.js`; warnings table and staff log | Management; target must be configured staff | No dedicated direct command test identified |
| `/staffnotes add`, `view` | `src/commands/staff.js`; `staff_notes` table and staff log | Management; target must be configured staff; replies ephemeral | No dedicated direct command test identified |
| `/staffhistory` | `src/commands/staff.js`; warnings, notes, shifts and activity service | Management; private response | No dedicated direct command test identified |
| `/report` | `src/commands/safety.js`; reports table, cooldown service, configured report channel | Any guild member may submit; now posts only when `@everyone` View Channel is confirmed denied | `automod.test.js` covers cooldown, persistence, and new public-channel denial |
| `/staffannounce` | `src/commands/staff.js`; configured announcement/log channels | Management; posts to `STAFF_ANNOUNCEMENT_CHANNEL_ID` | No dedicated direct command test identified |
| `/announcement-builder create`, `edit`, `templates` | `src/commands/announcements.js`; drafts, announcements, templates, audit ledger and configured destinations | Management; preview/publish flow restricts targets to configured channels | `announcements.test.js` covers validation and create/edit/publish flow |
| `/ticket-panel channel:<channel>` | `src/commands/tickets.js`; settings and tickets table | Management; chosen guild text channel | `tickets.test.js` covers panel persistence, private-category validation, ticket creation, decisions and closure |
| `/mod warn`, `kick`, `ban`, `timeout` | `src/commands/safety.js`; moderation logs, cooldowns, Discord moderation API for kick/ban/timeout | Management and bot permission/target checks for punitive actions | `automod.test.js` covers warning cooldown; no full Discord API/hierarchy integration test |
| `/staffconfig channel`, `role` | `src/commands/staff.js`; SQLite settings and staff audit ledger | Server owner or configured Owner role | No direct command test identified; Owner Settings panel has tests |

## Major Panels and Component Paths

- **Staff duty panel:** `src/commands/clock.js` builds buttons through `src/utils/staffCenter.js`; `src/index.js` routes `gv:center:*`, and `src/commands/staffCenter.js` handles check-in, check-out, stats, reports, reminders, events, and RP controls. The check-in/check-out service rules are shared with management actions. `clock.test.js`, `staffPanels.test.js`, `staffReminders.test.js`, and `staffRewards.test.js` cover important paths.
- **Management dashboard:** `src/commands/staffManagement.js` creates `mgmt:*` buttons/selects/modals, with matching dispatch in `src/index.js`. Role checks are repeated at interaction time. Audit/shift actions use `services/staffRewards.js`. `staffPanels.test.js` covers selected dashboard and management shift operations.
- **Owner dashboard/settings:** `owner:*` controls are handled by `src/commands/staffManagement.js`, with selects/modals routed in `src/index.js`. Settings persist to SQLite and are audited. Message cleanup is restricted to tracked old session messages; deletion logging remains disabled. `staffPanels.test.js` covers key settings/cleanup paths.
- **Events/RP sessions:** panel and slash event creation/list/cancel share `src/services/operations.js`; panel edits/host changes and scheduled reminders/completion use the same persisted events and announcement references. Session slash/panel flows share their session service. `src/index.js` routes `gv:event:*` and `gv:rp:*` interactions. Event and session data remain separate.
- **Announcements:** `src/commands/announcements.js` owns create/edit/template controls, validates draft ownership and configured destination, and checks bot authorship before editing. `src/index.js` routes `gv:announce:*` components. No broken ID route was confirmed in the audited create/edit flow.
- **Tickets:** `src/commands/tickets.js` handles panel/create/close/decision/note flows. Creation validates category privacy before creating a channel; channel access is explicitly set. `src/index.js` routes ticket buttons/modals. Existing tests cover important privacy and close/transcript behavior.
- **Reports and moderation:** report state buttons route through `src/buttons/index.js` to `src/commands/safety.js`; moderation slash commands use the same module. Phase 1 adds fail-closed destination privacy for report delivery.
- **RP History:** user-facing panel entry points were removed in Phase 3. SQLite sessions, participants, event history, staff history, and audit rows were preserved.

## Findings

### Critical: Shared channel destinations create a permission-sensitive disclosure risk

- **Evidence:** In `config.js`, all six configured destinations (`STAFF_ACTIVITY_CHANNEL_ID`, `STAFF_ANNOUNCEMENT_CHANNEL_ID`, `STAFF_LOG_CHANNEL_ID`, `REPORT_CHANNEL_ID`, `SESSION_CHANNEL_ID`, and `EVENT_CHANNEL_ID`) resolve to one channel. The configuration audit compared equality only and did not print the configured IDs. `src/utils/discord.js` sends staff activity/log payloads to both the configured log and activity channels.
- **Impact:** If the shared channel allows `@everyone` to view it, staff log entries and operational posts may disclose staff activity or moderation metadata. Live Discord permission overwrites were not available to inspect, so actual exposure is unconfirmed. Player reports were separately hardened in Phase 1 to avoid publishing into a channel unless public visibility is explicitly denied.
- **Affected files:** `config.js`, `src/utils/discord.js`, `src/commands/safety.js`.
- **Recommended repair:** Before operating the bot, verify effective `@everyone` permissions in Discord. An Owner must configure distinct private report/staff-log destinations and appropriate public announcement/activity destinations; do not infer IDs from the local config. Live overwrites cannot be checked from this workspace.

### Medium: Slash event creation uses the existing service with fewer options

- **Evidence:** `/event create`, `list`, and `cancel` now call `createEvent`, `getUpcomingEvents`, and `cancelScheduledEvent`/`cancelEventRecord`. The panel uses these same transitions and `publishEventAnnouncement`; the scheduler uses `completeEventRecord`. `/event create` keeps its existing minimal options and supplies service defaults (Other type, two hours, no voice channel).
- **Impact:** Slash and panel writes share stable IDs, persistent records, cancellation/completion history, and announcement components. Slash-created events have fewer details than panel-created events; their embed clearly shows that no voice channel is configured.
- **Affected files:** `src/commands/operations.js`, `src/commands/events.js`, `src/services/operations.js`, `src/database/index.js`.
- **Recommended repair:** No redesign is needed. Add optional slash parameters only if live staff testing identifies a need.

### Medium: The local Railway deployment contract is documentation-only

- **Evidence:** `package.json` provides a valid `npm start` script and Node >=20 engine requirement. There is no Railway/Docker/Procfile manifest or database-path environment override; `config.DATABASE_PATH` is relative to the working directory. `README.md` notes that hosted deployments need persistent storage.
- **Impact:** A Railway service can start successfully while SQLite data is lost across redeploys if its volume is not mounted at the resolved database path. This audit did not inspect or alter production Railway settings.
- **Affected files:** `package.json`, `config.js`, `README.md`.
- **Recommended repair:** In Phase 4 deployment review, confirm Railway start command and persistent volume mount against the actual service configuration, without changing production settings without authorization.

### Medium: Live slash-command registration and Discord permissions remain unverified

- **Evidence:** `src/index.js` registers guild commands after `ClientReady` and logs registration errors but continues running. Interaction dispatch covers all currently defined top-level commands. No `.env` or credential environment variables were present, so no live login, registration, permission, or gateway smoke test was possible.
- **Impact:** A registration failure may leave the process online while Discord exposes stale commands. Actual role hierarchy, intents, and channel permissions cannot be validated by the local test suite.
- **Affected files:** `src/index.js`, `src/commands/definitions.js`, `config.js`.
- **Recommended repair:** After secure credentials and approval are available, verify registration in a test guild and capture startup/permission logs. Consider surfacing registration failure in deployment health monitoring.

## Phase 1 Changes

- `src/commands/safety.js` now sends player reports only if the report channel and guild `@everyone` role are available and effective `ViewChannel` is confirmed denied. Otherwise, the report remains saved in SQLite and the submitter is told delivery failed. Report submission/status changes no longer send duplicate summaries through the shared staff activity/log broadcaster.
- `test/automod.test.js` now covers both successful delivery to a verified-private channel and refusal to deliver to a public channel, while retaining the report record.
- No configuration, database records, migrations, public history features, or deployment settings were changed.

## Phase 2 Panel-Control Inventory

The inventory covers the Staff Center, Management Dashboard, session controls, and announcement controls changed or reverified in Phase 2. “Verified” means covered by local mocks/tests, not live Discord validation.

| Control | Expected action | Implementation and authorization | Verification |
|---|---|---|---|
| `gv:center:checkin` / `checkout` | Start/end own staff shift | `staffCenter.js` → `services/staffRewards.js`; configured staff check at click time | Existing staff panel/reward tests pass |
| `gv:center:stats`, `leaderboard`, `weekly`, `streak` | Show personal stats, leaders, goal, or streak | `staffCenter.js` and `utils/staffCenter.js`; configured staff check | Existing staff panel/reward tests pass |
| `gv:center:reports:<page>` | Show paginated personal reports | `staffCenter.js`; configured staff check and bounded page calculation | Existing staff panel/report tests pass |
| `gv:daily:rating:<shift>` / `gv:daily:remind:<shift>` | Select rating and open daily-report form | `staffCenter.js`; report must belong to the clicker and completed shift | Existing daily-report cooldown/reminder tests pass |
| `gv:shiftrem:<shift>:still/end` | Acknowledge or end own overdue shift | `staffCenter.js`; shift owner checked before mutation | Existing reminder tests pass |
| `gv:center:events` | Open event controls | `staffCenter.js` → `events.js`; configured staff check | Existing event panel tests pass; event-system redesign deferred |
| `gv:center:event:create/upcoming/edit/cancel/attendance/history/host` | Create/view/manage events | `events.js`; staff access for panel/create/upcoming, management access for edit/cancel/attendance/history/host | Existing form and management-denial tests pass; not every event management branch has dedicated coverage |
| `gv:event:rsvp:<id>:going/cant_go` / `gv:event:details:<id>` | Record public RSVP or show event detail | `events.js`; event-state check and SQLite RSVP/history update | Existing RSVP, duplicate-response, and event persistence tests pass |
| `gv:center:rp:start` | Open staged RP creation | `staffCenter.js` → `events.js`; staff host validation; selected-host flow is management-only | Panel-flow tests pass; slash/panel entry parity covered |
| RP type/channel selection | Complete draft setup | `events.js`; owner-bound draft, current staff check, extra management check for selected-host drafts | Flow, stale draft, and privilege-loss tests pass |
| `gv:rp:preview:<draft>` | Preview session without creating a record | `events.js`; validates host, configured text channel, bot permissions, and draft ownership | Preview/publish integration test passes |
| `gv:rp:confirm:<draft>` / `cancel:<draft>` | Confirm one publish or discard draft | `events.js` → `createSession`/`publishSession`; per-click staff and selected-host management checks | Persistence, duplicate-click, and auth-downgrade tests pass |
| `gv:center:rp:controls` / `gv:rp:info:<id>` | Open authorized session controls/details | `events.js`; active host or management required for live controls | Existing lifecycle tests pass |
| Session Start/Pause/Resume/Reminder/Announcement/Participants/End/Cancel | Perform lifecycle or participant action | `events.js` and shared session service; current host/management check; confirmation for scheduled cancel | Existing lifecycle tests plus shared atomic end coverage pass |
| `gv:rp:join:<id>` / `leave:<id>` / `info:<id>` | Join/leave or display session details | `events.js`; session state checked; live controls only for current host/management | Existing Join/Leave and lifecycle tests pass |
| `mgmt:overview`, `reports`, `activity`, `leaderboard` | Change management dashboard view | `staffManagement.js`; `requireManagerInteraction` on every click | Existing management panel tests pass |
| `mgmt:staff_history` / `mgmt:shift_action:*` | View staff record or open selected manual shift actions | `staffManagement.js`; management-only; action confirmations and audit service | Existing staff management tests pass |
| `mgmt:shift_confirm:*` / `shift_cancel:*` | Confirm or cancel management shift action | `staffManagement.js`; management rechecked and action attribution audited | Existing management shift tests pass |
| `mgmt:send_custom` | Begin a configured-channel custom message | `staffManagement.js` → `announcements.js`; management rechecked at entry and every subsequent interaction | Custom workflow integration test passes |
| `gv:announce:custom_channel:<draft>` / `custom_content:<draft>` | Select allowed destination and compose message | `announcements.js`; owner-bound draft, configured channel allowlist, input validation | Channel, embed, URL, and content validation tests pass |
| Custom preview Edit/Cancel/Save Template/Publish | Review, revise, discard, save template, or publish once | `announcements.js`; management check, status claim, safe mentions, configured destination and bot-permission checks | Preview, cancellation, existing template/edit path, duplicate and denied-permission tests pass |
| Custom published HTTPS link buttons | Open configured external destinations | Discord link buttons; only validated HTTPS URLs are accepted | Link validation and published payload tests pass |
| Custom selected reactions | Apply reactions to published message | `announcements.js`; Add Reactions preflight; individual API failures are reported without resending | Successful and partial reaction failure paths tested |
| Legacy `gv:clock_*`, `gv:status`, `gv:activity`, `gv:session_join:<id>` | Preserve older clock, status, activity, and session-join messages | `buttons/index.js` routes to existing clock/operations handlers; staff checks remain at click time | Existing clock/service tests pass; legacy session join IDs remain supported |

## Phase 2 Custom Message Limits

- Custom messages use HTTPS URLs for thumbnails/images. No local attachment upload is implemented; remote URL reachability and MIME type are not checked in the modal flow, and Discord-side rendering requires a live test.
- Only link buttons are supported. Arbitrary custom-ID actions are omitted rather than exposing nonfunctional buttons.
- Mentions are suppressed via `allowedMentions.parse = []`; there is no explicit ping-confirmation workflow.
- All tests use mocks and temporary SQLite databases. No live Discord login, production config change, or Railway deployment was performed.

## Phase 2 Test Status

- Focused announcement tests: 6 passed, 0 failed.
- Focused session/panel tests: 22 passed, 0 failed across `test/operations.test.js` and `test/operationPanels.test.js`.
- Full suite: 62 passed, 0 failed.
- The Phase 1 RP-start test failure was a mock missing `guild.members.fetch`; the test double now reflects the handler contract.

## Phase 3 Changes

- Slash `/event create`, `/event list`, and `/event cancel` now use the shared event service and announcement workflow. Panel and slash cancellation share an atomic transition; scheduled completion is idempotent, records history, updates the announcement, and disables RSVP controls.
- Event destinations are validated for guild, text channel, and bot permissions before event records are created. Panel drafts are claimed before asynchronous publication. Existing event rows atomically claim the announcement slot; definite 4xx rejection releases the claim for retry, while uncertain network outcomes remain blocked for manual reconciliation to prevent duplicate announcements.
- Upcoming-event listing includes scheduled events while in progress and excludes them after their configured end time. Rescheduling reopens existing reminder slots without deleting records. Failed event-start reminder sends do not add repeated `started` history entries, and reminders without a voice channel do not emit broken mentions. Event/session data remain separate.
- RP History was removed from user-facing Staff Center and RP Controls panels; session rows, participant rows, and other historical/audit data remain in SQLite. No tables or records were deleted.
- All six operational channel settings still have valid-looking IDs but resolve to one configured destination. No IDs were printed or changed; intended destinations and permission overwrites require an authorized Owner/live Discord review.
- No production configuration or Railway settings were changed.
- Phase 3 final verification: `npm test` 68 passed, 0 failed, 0 skipped/cancelled; `git diff --check` passed. Live Discord and Railway checks remain blocked on credentials/service access.

## Phase 4A Configuration and Safety

The six channel settings below currently contain valid-looking IDs but all resolve to the same configured destination. Their actual values are intentionally not reproduced. The Owner must choose and verify each assignment; no channel ID should be inferred from this audit.

| Setting | Used for | Owner confirmation needed |
|---|---|---|
| `STAFF_ACTIVITY_CHANNEL_ID` | Staff duty panel, activity, and staff reminders | Choose the intended staff activity audience and confirm staff/bot view/send/embed access |
| `STAFF_ANNOUNCEMENT_CHANNEL_ID` | `/staffannounce` and configured announcement destinations | Confirm staff-only or broader audience and the intended mention policy |
| `STAFF_LOG_CHANNEL_ID` | Staff and moderation logs | Confirm private management/Owner access plus bot send/embed access |
| `REPORT_CHANNEL_ID` | Player reports | Confirm private report-review access; report delivery is suppressed unless `@everyone` View Channel is denied |
| `SESSION_CHANNEL_ID` | RP session announcements and public Join/Leave controls | Confirm the intended member audience and bot send/embed/attachment access |
| `EVENT_CHANNEL_ID` | Event announcements, RSVP controls, and reminders | Confirm the intended member audience and bot send/embed/attachment access |

Permission/data review:

- **Player reports:** submission checks effective `@everyone` View Channel and fails closed if privacy cannot be established. Report content is stored in `reports`; duplicate summary logs were removed in Phase 1.
- **Applications/tickets:** ticket creation rejects categories without an explicit `@everyone` View Channel deny and rejects unconfigured role grants. Requester and reviewer overwrites are set on the new channel. Staff applications use configured management/Owner reviewers; Admin Testing/Recruiting decisions require exactly one configured recruiting role. Existing submissions remain in SQLite.
- **Sessions/events:** Phase 2 session commands and panel use a shared lifecycle. Phase 3 event slash and panel commands use the shared event service, announcement claims, cancellation/completion history, and reminder state. Session and event tables remain separate.
- **SQLite:** `config.DATABASE_PATH` is `./database.sqlite`, resolved relative to the process working directory. WAL and foreign keys are enabled; schema changes are additive. Tests use disposable databases. No production database was opened or migrated during 4A.
- **Live checks blocked:** effective channel overwrites, role hierarchy, application-channel membership, gateway intents, command registration, and real reaction/announcement delivery require an authorized Discord test server and credentials. Railway volume mount/persistence, start command, backups, and restart recovery require access to the Railway service. None was available or changed here.

## Recommended Phase 4 Order
1. Verify effective permissions and select distinct operational channels with an authorized Owner.
2. Run live test-guild checks for command registration, event/session components, rendered embeds/images, and reactions.
3. Confirm Railway's start command and persistent SQLite mount without changing production settings.
4. Perform project-wide cleanup after the remaining live checks.
