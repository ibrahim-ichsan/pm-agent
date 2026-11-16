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
3. **Language model**: two free options, and both can be set. `GROQ_API_KEY` (console.groq.com) is tried first because it answers fast; `GEMINI_API_KEY` (aistudio.google.com) is the fallback and the only one that reads PDFs. Any other OpenAI-compatible provider works through `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. With no key at all, commands still work and free text is read by rule (dates, times, stage updates).
4. **Google Calendar**: in Google Cloud, enable the Google Calendar API, create a service account, add a JSON key and paste the whole file into `GOOGLE_SERVICE_ACCOUNT_JSON`. Share each calendar with the service account's email ("Make changes to events"). List the calendars in `CALENDAR_IDS`.
5. **Heroku**: create an app, set the config vars, deploy this repo, then scale `worker=1` (the bot needs no web dyno).

## Networking log

Set `NOTION_NETWORKING_DS` to the Networking database to switch this on.

- `/net <what happened>` (or a message starting with "met ..." / "ketemu ...") records who you met, what you talked about and what comes next. It updates the matching event row or creates one, sets a follow-up date (tomorrow unless you name one) and lists what to do next.
- `/prep` shows the prep notes for every event on the next event day; `/prep bny` or "what should I ask at BNY" finds one by name.
- `/followups` ranks the conversations waiting for a follow-up and says why each matters now; the morning digest reminds you on the day.
- `/people <name>` summarises one relationship from the log, with a state (New, Warm, Strong, Dormant) worked out each time.

## Priorities across databases

`src/priority.js` ranks tasks, applications, networking follow-ups and events by rule (due dates, stage, tier, follow-up age, people known at a company, calendar matches). No language model is involved, so the order is repeatable and each line states its reason.

- `/today` and the digest open with up to three top priorities.
- `/career` splits career work into urgent, important and what can wait.
- `/app <company>` shows one application with its checks (no prep task, deadline while still on the wishlist, Tier 1 gone quiet, referral without a follow-up, a contact at the company).
- The Sunday review ends with what matters next.

## Privacy

Message text, and any project brief you send, go to the language model provider you configured (Groq and/or Google Gemini) to be understood. Notion and calendar content is read for each reply and not stored by the bot.
