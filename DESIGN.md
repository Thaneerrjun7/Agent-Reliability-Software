# DESIGN.md - trip-agent

I kept the starter's structure (one loop in `src/agent.ts`, a thin client, the same CLI contract) and fixed what was weak. The bigger additions are small modules next to it: `src/goal.ts` (reads the details out of the goal sentence), `src/goalcheck.ts` (checks a booking or search against the goal), `src/loadenv.ts` (reads `.env`), `scripts/show-trace.ts` (prints a trace).

Run it: `npm run agent -- --goal "..." --seed X --auto-confirm --output result.json --trace trace.jsonl` (needs `TRIP_AGENT_BASE_URL` and `TRIP_AGENT_API_KEY`, from the environment or a `.env` file). `npm test` runs the offline tests, `npm run evals` the public scenarios, `npm run trace -- <trace.jsonl>` prints a run as a timeline.

## How I spent my time

Roughly 3 hours 40 minutes from Press Start (about 7:35 PM) to the final push (about 11:15 PM).

- ~30 min: read the portal docs and the starter, set up the repo in personal Github, `.gitignore`, key in `.env`, read-only probe of the live API.
- ~50 min: Setting up the Plan on what to do and the steps , first pass at the failure paths: retry rules, caps, one idempotency key, reconciling a booking after a timeout, booking only flights from our own search.
- ~40 min: made the answer honest: end-of-run server check, answer built from checked data, stale-weather refetch, untrusted-text cleaning; first live evals.
- ~35 min: crash/Ctrl+C/Esc safety, trace per line with request ids, a self-audit of everything so far.
- ~45 min: checks against the goal, argument validation, and the failure-path test suite (two parts done in parallel by separate AI agents), an independent review, last fixes, this document.
- 20 min : Checking and Editing Code manually , while confiming information and editing DESIGN.md

## Design decisions

Each as: decision -> why -> what I gave up.

1. **Keep the loop and the client, tighten in place.** The README asks not to rewrite. Every change sits inside the existing `runAgent`; new pure logic went into `goal.ts` and `goalcheck.ts`. -> Gave up a cleaner split into many modules; `agent.ts` is still long.
2. **Caps (all end the run as `partial`).** 25 steps; 60 s of work; 50,000 planner tokens (a live search run used ~500); 50 chat messages (the API's own limit); 10 s per call; 3 retries per call (4 attempts) for the planner, for reads and for booking; 3 re-asks in a row for bad planner output; 2 repeated identical reads. The end-of-run server check has its own budget (2 tries x 6 s + 2 s wait = at most 14 s). Worst case is about 60 + 10 + 14 = 85 s, under the harness's 2 minutes, so our caps fire first. -> Gave up long runs: a goal needing more than 25 steps stops early.
3. **Retry only what can succeed.** 429 (waiting exactly `Retry-After`), 5xx and timeouts, with exponential backoff, jitter and a cap. Never 4xx. 401/403 stop the run. A wait that would pass the 60 s cap is not started. -> Gave up retrying a 500 that might be permanent; the cap bounds it.
4. **One idempotency key per booking intent: run seed + flight + passenger.** The same run replays the same booking, a reworded goal cannot create a second one, and another graded scenario (another seed) stays separate. After a timeout we read `GET /tools/bookings` and match by key before any retry. -> Gave up cross-seed de-duplication: two seeds booking the same flight for the same passenger are two bookings.
5. **The server decides what was booked.** Every run ends by reading `GET /tools/bookings`. A claimed booking the server does not hold is removed; one we could not confirm is reported as UNKNOWN, never as booked; one that exists but we thought had failed is added. -> Costs one extra request per run (and up to 14 s when the server is slow).
6. **The answer never uses the planner's words.** The mock planner can invent prices, times or bookings. `answer` is built from cleaned tool data (flights, weather, stale-weather note) and the server's booking list. A planner claim of a booking the server does not hold is recorded as an error. -> Gave up the planner's friendlier summary.
7. **Tool data is rebuilt, not filtered.** Flights and weather are rebuilt from known fields with the right types and short text; `notes` is dropped; instruction-like sentences are cut. Booking only accepts flight ids from our own search results. -> A real field with unusual text could be shortened.
8. **Checks against the goal, only when sure.** Before a booking: passenger (any name the goal gives is accepted, titles and accents ignored), nonstop, a euro budget, cheapest, route, the goal's single date, origin = destination, and one booking per passenger per goal (unless it mentions a return or several flights). Before search/weather: required arguments, a real `YYYY-MM-DD` date, the goal's route/day/city. Airport codes are never compared with city names; two place names differ only if they share no word. A detail the parser could not read is not enforced, so a misreading can only miss a wrong action, never block a right one. The parser lives in `src/goal.ts`. -> The parser is a few regexes, so unusual phrasing (a budget without a currency, a lowercase name) is simply not checked.
9. **If the planner keeps picking a flight that is not the cheapest,** it is told which one is cheapest once; on the second wrong pick the agent books the cheapest eligible flight itself (same passenger, from our own results, after the normal confirmation) and the answer says so. It only fires when the price is the only thing wrong. -> The agent, not the planner, makes that last choice.
10. **A step is one planner call plus its tool (or the final answer).** A re-ask happens inside the step, as the docs say, so it does not use up the step cap. Trace steps start at 1.
11. **Always leave a result.** The trace is appended line by line; a crash outside the loop writes a `failed` result that says nothing is verified; Ctrl+C stops cleanly (checks the server, writes the real result); Esc writes a stub result without any network and exits (code 130). Exit code is 0 whenever `result.json` was written. -> Esc skips the server check; use Ctrl+C when a booking might be in flight.
12. **No Node flag in `package.json`.** `.env` is read in code (`src/loadenv.ts`), never overriding variables already set, so `npm run agent` starts on any Node that can run the starter. `AbortSignal.any` is optional.

## Failure taxonomy

| Class | Examples | What the agent does |
|---|---|---|
| Retryable transport | 429, 5xx, timeout, dropped connection, a 200 that is not JSON | Retry with backoff and jitter, wait `Retry-After`, at most 3 retries; then fail that call (planner: `failed`; tool: told to the planner, a second identical failure stops the run `partial`) |
| Client error | 400, 404, 422 | Never retried; the planner is told; a rejected booking is never re-posted |
| Auth | 401, 403 | Stop the run at once, nothing else is called |
| Bad planner output | invalid JSON, unknown tool, missing/invalid args, empty reply, a route the goal did not ask for | Re-ask with the reason (inside the same step), at most 3 in a row, then `failed` |
| Untrusted content | instruction text in a flight field or an error message, an injected flight id | Cut or dropped before the planner sees it; never book a flight we did not find |
| Budget exhaustion | step, wall-clock, token, message caps; planner loops | Stop cleanly as `partial`, say which cap in `errors[]` and the answer |
| Uncertain write | booking times out after possibly committing | Same key, look it up on the server before retrying; if still unsure, report UNKNOWN and check again at the end |
| Operator stop | Ctrl+C, Esc, a declined confirmation | Clean `partial` result (Esc: stub result) |

## AI tools I used, and how

- **Tools:** I used Claude Code (desktop app; models like Opus 5.5 and Sonnet 5.5), including separate sub-agents to have them multitask and complete tasks quicker: one wrote the goal checks (Step 4), one wrote the failure-path tests and ran a "break it on purpose" check (Step 5) this was i can identify the problems early on and finally one reviewed Steps 4 and 5 independently.
- **How I used it:** Claude wrote most of the code and tests. I set the goals, chose between options it offered and directed it completely towards my goal and vision for this program. I also read the changes before every push and checked the code locally on VScode, ran the live evals, and told it to follow the docs and to ask me before any docs-driven change.
- **Things I decided myself:** the 60 s work cap with a separate 14 s end-of-run check; the booking key from the run seed. i also used AI to check the internet for how existing booking apps work currently and decided that dropping the planner's text from the answer was a good move. Not only that i figured that using the Esc key to stop immediately was better than Ctrl C, with a printed hint. I directed Claude to use exit code 130 for any signal stop, after Multiple Testing, booking the cheapest flight ourselves was the best option after the planner gets it wrong twice. I made sure my program follows the rulebook docs where counting re-asks inside the step;also suggested removing the Node flag from `package.json`.
- **Rejected suggestion (2 Clear Rejections Made):**
  - Claude decided to automatically set up it's own Termination Signal Key as Ctrl C and i immediately rejected it as it is the most common key used among users as it is also copy and paste on windows laptops and proposed for a separate Esc key as the Termination Signal Key, announced in a printed line, so stopping at once cannot be triggered by accident.
  - Claude offered a booking key from flight + passenger only (a simple idea). So i thought i could improve upon it and workshopped it with claude and with more research towards that singular point and as i found better options, I rejected it for a seed-based key, because a later graded scenario booking the same flight and passenger would have silently replayed the earlier booking.
- **Checked by me / by tests:** all work was reviewed locally first and then re-reviewed again to make sure my review was followed accordingly before pushing.Besides tthat, the six public evals were run live and passed (after the first round of fixes, after the goal checks, and again on the final code).I also made sure the tests were checked by deliberately breaking the code five ways and confirming they fail and Making sure to Rebuild them appropiately.

## Bug diary

Each: failure -> root cause -> fix [commit] -> regression test.

1. **Every 4xx was retried, 401/403 included.** Starter `isRetryableStatus` was `status === 429 || status >= 400`. -> 429/5xx only; 401/403 stop the run [8ad26b2] -> `booking.test.ts` "does not retry a 422 on the booking call", "stops the whole run on a revoked key"; `failures.test.ts` "4xx is never retried", "401 / 403 stop the run at once".
2. **Double booking.** Starter used a fresh key per attempt (`..._${attempt}`) and "reconciled" by flight id only, recording the key `"reconciled"`. -> one key per intent reused on every retry; reconcile by key before any retry [010ecc2] -> `booking.test.ts` "does not book twice when the booking commits and then times out", "reuses one key across 503 retries"; `failures.test.ts` rate-limited booking re-sends the same key.
3. **Rewording the goal made a second booking.** The key hashed the goal text. -> run seed + flight + passenger [60a2fbd] -> `booking.test.ts` "rewording the goal with the same seed replays the same booking", "a different seed is a separate booking".
4. **The caps never fired.** 400 steps, 240 s, 4M tokens, 5000 repeats, and the wall clock was reset every loop (`startedAt = now()`); a long `Retry-After` could sleep past any cap. -> constant start time, waits that do not fit are not started, 25 steps / 60 s / 50k tokens / 2 repeats [8ad26b2] -> `failures.test.ts` "a wait that does not fit in the wall-clock budget is never started", token and step cap tests.
5. **A planner repeating a booking was re-executed** (`book_flight` was exempt from repeat detection). -> success recorded and answered "already booked"; unconfirmed and rejected bookings are suppressed too [010ecc2, final fixes] -> `failures.test.ts` "repeating a booking that went through never posts a second time", "a booking the server rejected with 400 is not re-posted".
6. **Injected text reached the planner.** One regex covered one phrase, `notes` was forwarded, any flight id was bookable. -> rebuild records from known fields, drop `notes`, more patterns, book only our own results [010ecc2, 60a2fbd, final fixes] -> `answer.test.ts` "never passes `notes`...", `failures.test.ts` "untrusted text never reaches the planner" (including `assistant: ...`, which the first regex missed).
7. **The answer claimed bookings the server did not hold.** It used the planner's prose and local memory. -> end-of-run `GET /tools/bookings`, answer from cleaned data, `unsupported_planner_claim` [60a2fbd] -> `booking.test.ts` "drops a planner claim of a booking that never happened", "removes a booking from the result when the server does not hold it".
8. **Bookings reads had no seed**, so replays and the reconcile look-up were not pinned. -> seed on every request [60a2fbd] -> `failures.test.ts` "the run's seed is sent on every request".
9. **Stale weather was accepted** ("a refetch felt redundant"). -> refetch once, and say what happened in the answer [60a2fbd] -> `answer.test.ts` stale-weather tests.
10. **A bug was retried as a network error.** My own fix treated any `TypeError` as a dropped connection. -> only `TypeError: fetch failed` [6cead04] -> `audit.test.ts` "does not mistake a bug (a plain TypeError) for a network error".
11. **A crash lost the result and the trace.** Starter buffered the trace until the end and rethrew unexpected errors; steps were 0-based. -> per-line append, crash stub, Ctrl+C/Esc, 1-based steps [010ecc2, 6cead04] -> `runsafety.test.ts` "is on disk after each line", "a crash outside the agent loop still gives a failed result".
12. **Chat API limits were ignored.** More than 50 messages or a 4000-character tool message gives a 422 that would end the run; an empty or usage-less 200 reply was taken as an answer or crashed. -> message cap, 10 cheapest flights sent on, empty reply re-asked, unreadable 200 retried [6cead04] -> `audit.test.ts` size-limit tests, "re-asks when the reply has neither a tool call nor any text".
13. **A reply of the text `null` crashed a read tool** (found by the failure-path tests). -> the client turns any non-object body into a `bad_json` envelope [final fixes] -> `failures.test.ts` "a 200 reply whose body is the JSON text `null` ...".
14. **The booking could be re-posted up to the step cap after a 400** (found by the failure-path tests: 24 identical POSTs). -> a rejected booking is suppressed like an unconfirmed one [final fixes] -> `failures.test.ts` "a booking the server rejected with 400 is not re-posted".
15. **Re-asks were counted as steps**, against the docs' definition. -> a step counts once its move is usable [final fixes] -> `substitution.test.ts` "a re-ask happens inside the step".
16. **A Node-version trap in the run script.** I had put `--env-file-if-exists` in the `agent` script, which fails to start on an older Node. -> restored the original script and read `.env` in code [final fixes] -> `loadenv.test.ts`.
17. **The starter's eval runner cannot start `npm` on Windows** (`ENOENT`, reported as a misleading "timed out"). -> `evals/run_evals_win.ts`, a copy that starts npm through Node; the original is untouched.

18. **Correct bookings could be refused because of how the goal was read** (found by an independent review of the new checks). The passenger was the last "for <Capital>" in the goal ("... for Maria Silva and check the weather for Tokyo" gave "Tokyo"), titles and letters outside Latin-1 cut names ("Dr", "Pawe"), "under 1,000 euros" read as 1 and "max 2 connections" as a 2-euro budget, a route followed by other words was not read at all, and "the weather at the destination" was enforced as a city. -> `src/goal.ts`: accept any name the goal gives, read names with Unicode letters and titles, a budget only with a euro marker and thousands separators, a route that ends at a keyword, and enforce a weather city only when it is a named place; accents folded; place names differ only if they share no word [final fixes] -> `review.test.ts` (passenger, budget, route and place tests).
19. **Wrong actions slipped through.** A search or booking on another day than the goal's single date, a second flight for the same passenger, "Paris to Paris", a price of 0 or below treated as the cheapest, and a booking reported "confirmed on the server" when the end-of-run check had been refused with a 401. -> date, one-booking and same-place checks, prices must be above 0, and a booking counts as verified only if the end-of-run check succeeded [final fixes] -> `review.test.ts` ("a search for another day...", "one flight per passenger per run", "a zero or negative price...", "a booking whose later end-of-run check is refused (401)..."). The same review also found that no test would notice a missing per-call timeout; `review.test.ts` "our own per-call timeout is really installed" now fails if the timeout is removed.

## Known limits

- The goal parser is a handful of regexes. A capitalised word after "for" (like "for Friday") is accepted as a possible passenger name, so a booking under that word would not be flagged. Checks that need a parsed value are skipped when parsing fails (a budget without a currency, a lowercase name, "to X from Y").
- "Cheapest" compares the flights found in this run, on the goal's day when the goal names exactly one date.
- The planner is shown at most the 10 cheapest flights of a search; the answer lists up to 5.
- The mock planner's behaviour on unseen seeds is unknown; the checks refuse only when sure, and I could not test them against hidden scenarios.
- Esc does not check the server; a booking in flight at that moment would be missing from its stub result (the stub says so).

## What I'd do with +2 more hours

1. Split `runAgent` into smaller pieces (booking, answer building) so it can be read and explained more easily.
2. Compare cities with airports through a small lookup table instead of skipping airport codes, and read more goal phrasings ("to X from Y", budgets without a currency).
3. Try sending the `tools` field to the planner (the docs list it; I did not test whether the mock uses it).
4. Record real traces from live runs (one `success`, one `partial`) and replay them in tests.
5. Keep our own request rate under 60 per minute instead of only reacting to a 429.
