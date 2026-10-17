# GV GR Staff Bot

A beginner-friendly Discord.js bot for Greenville RP staff duty, activity, sessions, events, private reports, and moderation logs. Shift, session, event, warning, report, note, and moderation records are stored in `database.sqlite` and remain available after the bot restarts.

## Requirements

- Node.js 20 or newer (Codespaces currently provides a suitable version).
- A Discord application and bot created in the [Discord Developer Portal](https://discord.com/developers/applications).
- Permission to invite bots and manage roles/channels in your server.

## 1. Add Your Bot Credentials

In the Codespaces terminal, run:

```sh
cp .env.example .env
```

Open `.env` in the file explorer and fill in:

```dotenv
DISCORD_TOKEN=paste_your_bot_token_here
DISCORD_CLIENT_ID=paste_your_application_id_here
```

Find the token on your application's **Bot** page in the Developer Portal. Find the application ID on **General Information**. Keep `.env` private: it is ignored by Git. Never paste the token into source code, share it, or commit `.env`. If a token is exposed, reset it on the Bot page immediately.

You can instead add `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` as Codespaces secrets/environment variables. The bot reads environment variables as well as `.env`.

## 2. Configure Your Server

Open `config.js` and replace `SERVER_ID` and the role/channel placeholders with your server's IDs. Keep each ID inside quotes. `STAFF_ROLE_IDS` should include all six staff levels. `MANAGEMENT_ROLE_IDS` should include Admin, Head Admin, Co-Owner, and Owner. `OWNER_ROLE_IDS` should include Co-Owner and Owner. Management and owner roles also receive clock and staff-panel access.

To copy IDs in Discord, open **User Settings → Advanced → Developer Mode**. Right-click the server, a role, or a channel and choose **Copy Server ID**, **Copy Role ID**, or **Copy Channel ID**. The server ID belongs in `SERVER_ID`; use the role IDs in the role arrays and the channel IDs beside their matching channel settings.

Create text channels for staff activity/logs, reports, sessions, events, and announcements. Set channel permission overrides so `@everyone` cannot view the private reports channel and only trusted staff (plus the bot) can view it. Apply the same restriction to any channel where staff logs should remain private. The bot needs to view and send messages in each channel it uses. Ticket workflows also require the bot's **Manage Channels** permission.

After first setup, open `/owner-dashboard` → **Server Settings** to select staff channels, ticket categories, the single Admin Testing/Recruiting access role, session join code/link/banner, Staff/Management/Owner role groups, and the server timezone (an IANA name such as `America/Chicago`). These changes are saved in SQLite and audited. Ticket categories must explicitly deny `@everyone` View Channel; ticket creation refuses categories that appear public or grant access to unconfigured roles. Discord server owners and roles with Administrator inherently bypass channel denies. `/staffconfig channel` and `/staffconfig role` remain available. The initial Owner role still needs to be set in `config.js` so someone can open the panel.

## 3. Enable Intents and Invite the Bot

In the Developer Portal, open **Bot → Privileged Gateway Intents** and enable **Server Members Intent** and **Presence Intent**. These are used for staff role checks and the online-staff count. AutoMod is disabled by default and the bot does not request Message Content in that state. If an Owner enables spam/repeated-message/link/invite scanning, enable **Message Content Intent** in the Developer Portal and restart the bot. Enabling AutoMod without that privileged intent can prevent the gateway connection.

Invite the bot from **OAuth2 → URL Generator**. Select the `bot` and `applications.commands` scopes, then grant these bot permissions:

- View Channels, Send Messages, Embed Links, and Read Message History
- Kick Members, Ban Members, and Moderate Members, for `/mod kick`, `/mod ban`, and `/mod timeout`

The current moderation invite permissions integer is `1099511712902`. Add **Manage Channels** if you plan to create tickets. An invite URL can be formed as:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=1099511712902&scope=bot%20applications.commands
```

Replace `YOUR_APPLICATION_ID`, open the URL, choose your server, and authorize. The bot's highest server role must be above the members it needs to moderate. If you do not want moderation commands, omit those three moderation permissions. Ticket creation additionally needs **Manage Channels**. Message-deletion logging is disabled.

## 4. Install and Start

From the workspace root in the Codespaces terminal:

```sh
npm install
npm start
```

Keep the Codespace running while you want the bot online. On startup the bot creates/opens `database.sqlite` and registers its slash commands in the configured `SERVER_ID`. Stop it with `Ctrl+C`. The SQLite file is ignored by Git; back it up if the workspace may be deleted or rebuilt.

Run the automated tests with:

```sh
npm test
```

### Staff Reminders

- Clock times are stored in UTC and Discord displays them in each user's local timezone. A 4:28 to 4:30 shift is 2 minutes and earns no completed-hour point.
- Unfinished daily RP reports are reminded in the staff activity channel 20 minutes after checkout. The reminder button opens a private rating/report flow; submitting the report removes its reminder. Checkout and hourly points are saved even if a report is not completed.
- The existing forgotten-checkout reminder begins after `SHIFT_REMINDER_HOURS` (6 hours by default) and offers **Still Working** or **End My Shift**. It does not automatically punish staff.
- Weekly-goal reminders are optional and off by default. Set `WEEKLY_GOAL_REMINDER_ENABLED: true` in `config.js` to enable them. `WEEKLY_GOAL_REMINDER_DAY_UTC` and `WEEKLY_GOAL_REMINDER_HOUR_UTC` control when they run (Sunday at 18:00 UTC by default). Each staff member is reminded at most once per week.
- Message-deletion notifications are disabled. Existing moderation records are preserved, and the Owner Dashboard cannot re-enable that handler.
- Player reports have a persistent per-user cooldown; staff daily RP reports retain the one-report-per-UTC-day and one-point bonus rules. Repeated daily-report form opens have a separate persistent 30-minute cooldown.
- Forgotten-shift reminder messages have a persistent 30-minute per-staff cooldown. Failed sends release the cooldown so the reminder can retry.
- AutoMod is disabled until an Owner enables it. Its default mode is log-only; it does not automatically ban members. Message bodies are not stored in AutoMod incident records.

### Events and RP Sessions

- Open `/staff-center` and click **Events** to create an event, review upcoming events, or open Management-only edit, cancel, host, attendance, and history actions.
- The event form uses date and ordinary time text (for example, `October 6, 2026` and `6:30 PM`), followed by event-type and description forms and Discord channel pickers. Entered times use the Owner-configured server IANA timezone; stored timestamps are UTC, and DST gaps are rejected rather than silently shifted. Ambiguous fall-back times choose the earlier occurrence. Announcements display the event's saved timezone and include a generated type-themed PNG, permanent `GV-EV-####` ID, Going/Can't Go RSVP buttons, and private Event Details.
- Event reminders are sent near 1 hour and 15 minutes before the start and at the scheduled start. The scheduler checks every minute, allows a short delivery grace period, retries failed delivery safely, and ignores cancelled/completed events.
- Click **Start RP Session** in `/staff-center` to enter title, description, scheduled date/time, expected duration, activity, and optional HTTPS banner in staged forms. Choose a type and voice channel, then publish to the configured RP Session channel. The Owner-configured join code is shown in a copyable code block; it is never invented by the bot. Scheduled and actual start times are stored separately. Staff can join or leave from the public post; the host and Management can use private session controls.
- **RP Controls** provides host/Management controls, including confirmed cancellation of scheduled sessions. **RP History** shows completed sessions and their host, type, duration, participant count, and permanent `GV-RP-####` ID. Scheduled sessions activate at their time and automatically close at their expected duration; pauses are excluded from active duration.
- `/announcement-builder create|edit|templates` supports staged embed creation, configured destinations, preview, HTTPS image/thumbnail/link buttons, up to five custom fields, a Staff Center action, saved templates, and edits to bot-owned announcements.
- `/ticket-panel channel:<channel>` posts the ticket panel. General Support, Staff Applications, and Admin Testing/Recruiting tickets create private channels under Owner-configured categories. Recruiting decisions are limited to the single configured role; transcripts are sent only when the configured destination is not visible to `@everyone`.
- Owner Dashboard **Message Cleanup** previews only bot-tracked completed session announcements older than 14 days. It verifies bot authorship, preserves all database history and panels, and never purges untracked messages.
- Event and session records, IDs, RSVPs, participants, reminder attempts, and event edit history use the existing `database.sqlite`; migrations add columns/tables without replacing existing records.

### Public Release Status

This workspace is still configured for one server: `SERVER_ID`, default channels, and initial roles are in `config.js`, and runtime settings are stored in one SQLite database. Do not invite this build to unrelated public servers; per-guild data scoping and first-run setup are not implemented. Railway operation still depends on mounting persistent storage at the configured database path and backing up SQLite before redeployment. AutoMod needs the privileged intent enabled before activation; ticket categories and the single recruiting role must be configured before ticket creation.

## 5. Test the Clock System

1. Confirm that `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `SERVER_ID`, and at least one staff role ID are set.
2. Start the bot with `npm start` and wait for the successful login and command-registration messages.
3. A configured management member runs `/staff-panel`. The panel is posted in the configured staff activity channel; running the command again refreshes that panel.
4. A staff member clicks **CLOCK IN**. The private confirmation shows the start time. Clicking it again reports that the member is already on duty.
5. Open `/staff-center` and click **My Stats** for private hours, points, weekly goal, streak, and report access.
6. Click **Check Out**. The private confirmation shows shift length, start/end times, and earned points. Clicking it again reports there is no active shift.
7. Restart the bot and verify the completed shift remains in **My Stats**. An active shift also remains active across a restart and can still be clocked out.

## Commands

- `/staff-panel` posts or refreshes the staff duty panel (management).
- `/staff-center`, `/management-dashboard`, and `/owner-dashboard` open private role-gated dashboards.
- `/ticket-panel channel:<channel>` posts or refreshes the private ticket creation panel (management).
- `/announcement-builder create|edit|templates` opens the management announcement builder.
- `/leaderboard period:weekly|monthly|alltime` shows the top staff by hours.
- `/session start host:<staff>` opens a session-name/description form; `/session end` ends the active session; `/session status` shows its current status. Staff join through the session announcement button.
- `/event create`, `/event list`, and `/event cancel` manage scheduled events. Supply an ISO 8601 time with an explicit timezone, such as `2026-10-04T18:00:00Z`.
- `/staffwarn`, `/staffnotes add`, `/staffnotes view`, and `/staffhistory` manage private staff records.
- `/report` opens the player report form. Management uses its buttons to mark reports Reviewing, Resolved, or Rejected.
- `/mod warn`, `/mod kick`, `/mod ban`, and `/mod timeout` record player moderation. Kick/ban/timeout also call Discord's moderation API.
- `/staffannounce` posts to the configured announcement channel.
- `/staffconfig channel` and `/staffconfig role` configure channels/role groups (Owner/Co-Owner only).

## Project Files

- `config.js`: Server ID, configurable staff/management/owner role IDs, channel IDs, and embed colors.
- `.env.example`: Names of the two required environment variables; copy it to `.env` for local Codespaces setup.
- `src/index.js`: Bot startup, slash-command registration, event routing, and clean shutdown.
- `src/commands/definitions.js`: Slash-command definitions registered in your server.
- `src/commands/clock.js`: Staff panel, clock buttons, status, activity, and leaderboard.
- `src/commands/staff.js`: Warnings, private notes/history, announcements, and owner configuration.
- `src/commands/operations.js`: Legacy RP-session and event slash commands.
- `src/commands/events.js` and `src/services/operations.js`: Staff Center event/session UI, persistent IDs, RSVP/participant tracking, type-themed PNGs, reminder scheduling, lifecycle controls, and history.
- `src/commands/safety.js`: Player reports and moderation commands.
- `src/buttons/index.js`: Dispatches panel, session, and report buttons.
- `src/events/messageDelete.js`: Kept as a disabled no-op; no deletion notifications or rows are created.
- `src/commands/announcements.js` and `src/commands/tickets.js`: Announcement builder and private ticket workflows.
- `src/events/automod.js` and `src/services/automod.js`: Opt-in message/join abuse detection and persistent incident/cooldown data.
- `src/services/clock.js`: Transactional SQLite clock-in/clock-out logic.
- `src/services/activity.js`: Shift summaries and leaderboard calculations.
- `src/database/index.js`: Creates the SQLite tables and indexes at startup.
- `src/utils/discord.js` and `src/utils/format.js`: Shared Discord, permission, timestamp, and duration helpers.
- `test/`: Automated tests for shift persistence and activity calculations.
- `database.sqlite`: Runtime SQLite database created at startup; the bot reapplies additive schema changes. It contains server records, is ignored by Git, and should live on persistent storage in hosted deployments.
