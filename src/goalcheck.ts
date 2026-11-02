/**
 * Pure checks of what the planner asks for against what the user's goal says.
 * Rule for every check: refuse only when sure. A detail that parseGoal could not
 * read from the goal is never checked, and we never guess.
 */

import type { CleanFlight, GoalIntent } from "./agent";

export type Check = { ok: true } | { ok: false; reason: string };

const tidy = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const isAirportCode = (s: string) => /^[a-z]{3}$/.test(s);

/**
 * True only when two place names are clearly different. One containing the other is
 * fine ("Lisbon" / "Lisbon (LIS)"). A 3-letter code (LIS, NRT) cannot be compared with
 * a city name without a lookup table, so with a code we cannot tell: not different.
 */
export function differentPlace(a: unknown, b: unknown): boolean {
  const x = tidy(typeof a === "string" ? a : "");
  const y = tidy(typeof b === "string" ? b : "");
  if (!x || !y || isAirportCode(x) || isAirportCode(y)) return false;
  return !x.includes(y) && !y.includes(x);
}

/** The goal's passenger may be cut short by the parser, so a longer name that starts with it is accepted. */
function samePassenger(goalName: string, name: string): boolean {
  const a = tidy(goalName);
  const b = tidy(name);
  return b === a || b.startsWith(`${a} `);
}

/** A flight on a clearly different route than the goal: both ends differ (one end alone may be just another airport name). */
function wrongRoute(intent: GoalIntent, f: CleanFlight): boolean {
  return differentPlace(f.origin, intent.origin) && differentPlace(f.destination, intent.dest);
}

/** The flights the goal allows (nonstop if it says so, within budget if it gives one, on its route), cheapest first. */
export function eligibleFlights(intent: GoalIntent, flights: CleanFlight[]): CleanFlight[] {
  return flights
    .filter((f) => (!intent.nonstop || f.nonstop) && (intent.budget === null || f.price_eur <= intent.budget) && !wrongRoute(intent, f))
    .sort((a, b) => a.price_eur - b.price_eur);
}

/** May this booking go ahead? A refusal's reason also tells the planner what would be acceptable. */
export function checkBookingAgainstGoal(intent: GoalIntent, flight: CleanFlight, passenger: string, found: CleanFlight[]): Check {
  const refuse = (reason: string): Check => ({ ok: false, reason });
  const eligible = eligibleFlights(intent, found);
  const instead = eligible.length > 0
    ? `Acceptable flights from the search results: ${eligible.slice(0, 3).map((f) => f.flight_id).join(", ")}.`
    : "No flight in the search results fits the goal: do not book; say so in the final answer.";

  if (intent.passenger && !samePassenger(intent.passenger, passenger)) {
    return refuse(`The goal is for passenger ${intent.passenger}; book under that name.`);
  }
  if (intent.nonstop && !flight.nonstop) {
    return refuse(`The goal asks for a nonstop flight, but ${flight.flight_id} has stops. ${instead}`);
  }
  if (intent.budget !== null && flight.price_eur > intent.budget) {
    return refuse(`The goal sets a budget of EUR ${intent.budget}, but ${flight.flight_id} costs EUR ${flight.price_eur}. ${instead}`);
  }
  if (wrongRoute(intent, flight)) {
    return refuse(`${flight.flight_id} flies ${flight.origin} to ${flight.destination}, not the goal's route ${intent.origin} to ${intent.dest}. ${instead}`);
  }
  if (intent.cheapest && eligible.length > 0 && flight.price_eur > eligible[0].price_eur) {
    return refuse(`The goal asks for the cheapest flight: ${flight.flight_id} costs EUR ${flight.price_eur}, but ${eligible[0].flight_id} costs EUR ${eligible[0].price_eur}. Book ${eligible[0].flight_id}.`);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Arguments of the read tools, checked before the API is called.
// ---------------------------------------------------------------------------

const MAX_ARG_CHARS = 80;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= MAX_ARG_CHARS;

/** YYYY-MM-DD and a real calendar day ("2026-13-45" is not). */
export function isRealDate(v: unknown): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A reason to re-ask the planner, or null when search_flights / get_weather arguments are usable and fit the goal. */
export function checkReadArgs(name: string, args: Record<string, unknown>, intent: GoalIntent): string | null {
  if (name === "search_flights") {
    if (!isText(args.origin) || !isText(args.dest)) return `search_flights needs origin and dest as non-empty text (max ${MAX_ARG_CHARS} characters)`;
    if (!isRealDate(args.date)) return "search_flights needs date as a real day written YYYY-MM-DD";
    // Here both sides are words (the planner's and the user's), so one end that differs is enough.
    if (differentPlace(args.origin, intent.origin) || differentPlace(args.dest, intent.dest)) {
      return `the goal asks for the route ${intent.origin} to ${intent.dest}; search that route`;
    }
  }
  if (name === "get_weather") {
    if (!isText(args.city)) return `get_weather needs city as non-empty text (max ${MAX_ARG_CHARS} characters)`;
    if (!isRealDate(args.date)) return "get_weather needs date as a real day written YYYY-MM-DD";
    if (differentPlace(args.city, intent.weatherCity)) return `the goal asks for the weather in ${intent.weatherCity}; ask for that city`;
  }
  return null;
}
