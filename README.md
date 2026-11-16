# Komplot

A Telegram bot that keeps one person's tasks, job applications and calendar in order.
Notion is the only place data lives; the bot keeps nothing of its own beyond settings.

- Write a line ("submit group report friday", "applied AIB grad risk, deadline 30 nov") and it is filed in Notion.
- A digest every morning at 07:00 Dublin time, reminders 3 days, 1 day and 0 days before a deadline at 09:00, a midweek check on Wednesday 13:00 and a weekly review on Sunday 18:00.
- Changes and deletions always ask for a tap on Yes first.
- Only the owner's Telegram account gets an answer.

## How it is built

Node 20+, no framework. `src/agent.js` holds the conversation logic; Notion, Google Calendar, Gemini and Telegram are thin clients injected into it, so the tests run against in-memory fakes.

| File | Job |
|---|---|
| `src/agent.js` | Commands, capture, buttons and confirmations |
| `src/digest.js` | Morning digest, midweek and weekly reviews |
| `src/reminders.js` | Which reminders go out now |
| `src/scheduler.js` | Runs once a minute; each job runs once per day |
| `src/dates.js` | Dublin time and reading dates out of text |
| `src/parse.js` | Turns the model's reading into an intent |
| `src/notion.js`, `src/calendar.js`, `src/llm.js`, `src/telegram.js` | Service clients |

Dates are read by rules, not by the model, so "friday" always means the next Friday (today included) and "31 feb" is never filed as a date.

## Tests

```
npm test
```

One test per row of the permutation tables A to D in the PRD.

## Set-up

All keys and IDs are config vars. The repo holds none.

1. **Telegram**: the bot token from BotFather goes in `TELEGRAM_TOKEN`. Your numeric user ID (ask @userinfobot) goes in `OWNER_TELEGRAM_ID`.
2. **Notion**: create an internal integration at notion.so/profile/integrations and put its secret in `NOTION_TOKEN`. On the "Komplot — PM Agent" page and on the roadmap database, open ••• > Connections and add the integration. Put the data source IDs in the `NOTION_*_DS` vars.
3. **Gemini**: create a key at aistudio.google.com and put it in `GEMINI_API_KEY`. Without it, commands still work and free text is filed as a plain task.
4. **Google Calendar**: in Google Cloud, enable the Google Calendar API, create a service account, add a JSON key and paste the whole file into `GOOGLE_SERVICE_ACCOUNT_JSON`. Share each calendar with the service account's email ("Make changes to events"). List the calendars in `CALENDAR_IDS`.
5. **Heroku**: create an app, set the config vars, deploy this repo, then scale `worker=1` (the bot needs no web dyno).

## Privacy

Message text, and any project brief you send, go to Google's Gemini API to be understood. Notion and calendar content is read for each reply and not stored by the bot.
