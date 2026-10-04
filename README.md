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

Create text channels for staff activity/logs, reports, sessions, events, and announcements. Set channel permission overrides so `@everyone` cannot view the private reports channel and only trusted staff (plus the bot) can view it. Apply the same restriction to any channel where staff logs should remain private. The bot needs to view and send messages in each channel it uses. The staff activity channel is also where `/staff-panel` posts its reusable panel.

After first setup, a configured Owner or Co-Owner can update channels and role groups using `/staffconfig channel` and `/staffconfig role`. These overrides are saved in SQLite. The initial Owner role still needs to be set in `config.js` so someone can run that command.

## 3. Enable Intents and Invite the Bot

In the Developer Portal, open **Bot → Privileged Gateway Intents** and enable **Server Members Intent** and **Presence Intent**. These are used for staff role checks and the online-staff count. Message content intent is not needed.

Invite the bot from **OAuth2 → URL Generator**. Select the `bot` and `applications.commands` scopes, then grant these bot permissions:

- View Channels, Send Messages, Embed Links, and Read Message History
- View Audit Log, for identifying who deleted a message
- Kick Members, Ban Members, and Moderate Members, for `/mod kick`, `/mod ban`, and `/mod timeout`

The equivalent least-privilege permissions integer is `1099511712902`. An invite URL can be formed as:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=1099511712902&scope=bot%20applications.commands
```

Replace `YOUR_APPLICATION_ID`, open the URL, choose your server, and authorize. The bot's highest server role must be above the members it needs to moderate. If you do not want moderation commands, omit those three moderation permissions. The bot logs deleted-message metadata, not message contents.

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
- The Owner Dashboard has an audited **Enable/Disable Delete Logs** button. Deletion logs contain the message author, channel, and time; message contents and the deleting person's identity are not recorded.

## 5. Test the Clock System

1. Confirm that `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `SERVER_ID`, and at least one staff role ID are set.
2. Start the bot with `npm start` and wait for the successful login and command-registration messages.
3. A configured management member runs `/staff-panel`. The panel is posted in the configured staff activity channel; running the command again refreshes that panel.
4. A staff member clicks **CLOCK IN**. The private confirmation shows the start time. Clicking it again reports that the member is already on duty.
5. Click **STATUS** to see all current shifts and durations. Click **MY ACTIVITY** for private hours, shifts, average length, sessions, events, moderation actions, and weekly/monthly hours.
6. Click **CLOCK OUT**. The private confirmation shows the shift length and start/end times. Clicking it again reports there is no active shift.
7. Restart the bot and verify the completed shift remains in **MY ACTIVITY**. An active shift also remains active across a restart and can still be clocked out.

## Commands

- `/staff-panel` posts or refreshes the staff duty panel (management).
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
- `src/commands/operations.js`: RP sessions and scheduled events.
- `src/commands/safety.js`: Player reports and moderation commands.
- `src/buttons/index.js`: Dispatches panel, session, and report buttons.
- `src/events/messageDelete.js`: Logs message author, channel, and time when deletion logging is enabled.
- `src/services/clock.js`: Transactional SQLite clock-in/clock-out logic.
- `src/services/activity.js`: Shift summaries and leaderboard calculations.
- `src/database/index.js`: Creates the SQLite tables and indexes at startup.
- `src/utils/discord.js` and `src/utils/format.js`: Shared Discord, permission, timestamp, and duration helpers.
- `test/`: Automated tests for shift persistence and activity calculations.
- `database.sqlite`: Initialized local SQLite database; the bot reapplies its schema on startup. It contains the server's records and is not committed to Git.
