/**
 * Pure checks of what the planner asks for against what the user's goal says.
 * Rule for every check: refuse only when sure. A detail that parseGoal could not
 * read from the goal is never checked, and we never guess.
 */

import type { CleanFlight } from "./agent";
import type { GoalIntent } from "./goal";

/** `better` is set only when the single thing wrong is the price: the goal asked for the cheapest and a cheaper eligible flight exists. */
export type Check = { ok: true } | { ok: false; reason: string; better?: CleanFlight };

/** Lower case, accents removed ("São" -> "sao"), spaces collapsed. */
const tidy = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
const words = (s: string) => tidy(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const isAirportCode = (s: string) => /^[a-z]{3}$/.test(s);

/**
 * True only when two place names are clearly different: they share no word. "Tokyo" and
 * "Tokyo, Japan" are the same place. A 3-letter code (LIS, NRT) cannot be compared with a
 * city name without a lookup table, so with a code we cannot tell: not different.
 */
export function differentPlace(a: unknown, b: unknown): boolean {
  const x = tidy(typeof a === "string" ? a : "");
  const y = tidy(typeof b === "string" ? b : "");
  if (!x || !y || isAirportCode(x) || isAirportCode(y)) return false;
  const wy = words(y);
  return !words(x).some((w) => wy.includes(w));
}

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof"]);
/** The name parts that identify a person: no titles, no single-letter initials. */
const nameParts = (s: string) => words(s).filter((w) => !TITLES.has(w) && w.length > 1);

/** The same person if one name's parts are all in the other's: "Anna Nowak" = "Dr. Anna Nowak" = "Anna Maria Nowak". */
function samePassenger(goalName: string, name: string): boolean {
  const a = nameParts(goalName);
  const b = nameParts(name);
  if (a.length === 0 || b.length === 0) return true; // nothing to compare: do not refuse
  return a.every((p) => b.includes(p)) || b.every((p) => a.includes(p));
}

/** A flight on a clearly different route than the goal: both ends differ (one end alone may be just another airport name). */
function wrongRoute(intent: GoalIntent, f: CleanFlight): boolean {
  return differentPlace(f.origin, intent.origin) && differentPlace(f.destination, intent.dest);
}

/** A flight on another day than the goal's single date (only when both are plain dates). */
function wrongDate(intent: GoalIntent, f: CleanFlight): boolean {
  return intent.dateGiven && /^\d{4}-\d{2}-\d{2}$/.test(f.date) && f.date !== intent.date;
}

/** The flights the goal allows (nonstop if it says so, within budget if it gives one, on its route and day), cheapest first. */
export function eligibleFlights(intent: GoalIntent, flights: CleanFlight[]): CleanFlight[] {
  return flights
    .filter((f) => (!intent.nonstop || f.nonstop) && (intent.budget === null || f.price_eur <= intent.budget) && !wrongRoute(intent, f) && !wrongDate(intent, f))
    .sort((a, b) => a.price_eur - b.price_eur);
}

/**
 * May this booking go ahead? A refusal's reason also tells the planner what would be acceptable.
 * `alreadyBooked` is what this run has booked so far.
 */
export function checkBookingAgainstGoal(
  intent: GoalIntent,
  flight: CleanFlight,
  passenger: string,
  found: CleanFlight[],
  alreadyBooked: Array<{ flight_id: string; passenger: string }> = [],
): Check {
  const refuse = (reason: string): Check => ({ ok: false, reason });
  const eligible = eligibleFlights(intent, found);
  const instead = eligible.length > 0
    ? `Acceptable flights from the search results: ${eligible.slice(0, 3).map((f) => f.flight_id).join(", ")}.`
    : "No flight in the search results fits the goal: do not book; say so in the final answer.";

  if (intent.origin && intent.dest && tidy(intent.origin) === tidy(intent.dest)) {
    return refuse(`The goal's origin and destination are the same place (${intent.origin}); there is no flight to book.`);
  }
  if (intent.passengerCandidates.length > 0 && !intent.passengerCandidates.some((c) => samePassenger(c, passenger))) {
    return refuse(`The goal is for passenger ${intent.passengerCandidates.join(" or ")}; book under that name.`);
  }
  if (!intent.multiFlight && alreadyBooked.some((b) => b.flight_id !== flight.flight_id && samePassenger(b.passenger, passenger))) {
    return refuse(`A flight is already booked for ${passenger} in this run (${alreadyBooked.map((b) => b.flight_id).join(", ")}); the goal asks for one booking.`);
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
  if (wrongDate(intent, flight)) {
    return refuse(`${flight.flight_id} flies on ${flight.date}, but the goal asks for ${intent.date}. ${instead}`);
  }
  if (intent.cheapest && eligible.length > 0 && flight.price_eur > eligible[0].price_eur) {
    return {
      ok: false,
      reason: `The goal asks for the cheapest flight: ${flight.flight_id} costs EUR ${flight.price_eur}, but ${eligible[0].flight_id} costs EUR ${eligible[0].price_eur}. Book ${eligible[0].flight_id}.`,
      better: eligible[0],
    };
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
    if (intent.dateGiven && args.date !== intent.date) return `the goal asks for ${intent.date}; search that day`;
  }
  if (name === "get_weather") {
    if (!isText(args.city)) return `get_weather needs city as non-empty text (max ${MAX_ARG_CHARS} characters)`;
    if (!isRealDate(args.date)) return "get_weather needs date as a real day written YYYY-MM-DD";
    // Only a clearly named place is enforced ("Cairo that day"), not phrases like "the destination".
    if (intent.weatherCity && /^\p{Lu}/u.test(intent.weatherCity) && differentPlace(args.city, intent.weatherCity)) {
      return `the goal asks for the weather in ${intent.weatherCity}; ask for that city`;
    }
  }
  return null;
}
