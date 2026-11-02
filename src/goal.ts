/**
 * Reads the details the agent checks bookings and searches against out of the goal sentence.
 * The rule for every field: when in doubt, leave it unread (null / false). A detail that is not
 * read is simply not enforced, so a misreading can never block a correct booking.
 */

export type GoalIntent = {
  origin: string | null;
  dest: string | null;
  date: string; // the one ISO date in the goal, else tomorrow (only trusted when dateGiven)
  dateGiven: boolean; // exactly one YYYY-MM-DD date appears in the goal
  wantBooking: boolean;
  wantWeather: boolean;
  nonstop: boolean;
  cheapest: boolean;
  multiFlight: boolean; // the goal talks about a return, outbound, both, multi-city...: more than one booking is fine
  budget: number | null; // in EUR; null unless the goal gives a plain euro amount
  passenger: string | null; // the first name the goal gives (for messages); null when the goal names nobody
  passengerCandidates: string[]; // every "for <Name>" / "passenger <Name>" in the goal: a booking under any of them is accepted
  weatherCity: string | null; // the words after "weather in", e.g. "Cairo that day"
};

const TITLE = String.raw`(?:(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+)?`;
const NAME = String.raw`\p{Lu}[\p{L}'’-]*(?:\s+(?:\p{Lu}\.|\p{Lu}[\p{L}'’-]*)){0,2}`;
const PASSENGER_RE = new RegExp(String.raw`(?:\b[Ff]or|\b[Pp]assenger(?:\s+name)?\s*[:=]?)\s+(${TITLE}${NAME})`, "gu");

// "from <place> to <place>": the destination ends at a keyword, a digit or punctuation.
const PLACE = String.raw`\p{L}[\p{L}'’.() -]*?`;
const STOP_WORDS = "on|and|for|under|below|with|that|which|before|after|by|in|at|please|nonstop|non-stop|direct|cheapest";
const ROUTE_RE = new RegExp(String.raw`\bfrom\s+(${PLACE})\s+to\s+(${PLACE})(?=\s+(?:${STOP_WORDS})\b|\s+\d|[,;:!?]|\.(?:\s|$)|$)`, "iu");

// A budget counts only as a plain amount in euros: "under 500 EUR", "under €500", "budget of EUR 1,000".
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const EURO = String.raw`€|eur(?:os?)?`;
const BUDGET_RE = new RegExp(
  String.raw`(?:under|below|less\s+than|up\s+to|at\s+most|no\s+more\s+than|within|max(?:imum)?(?:\s+of)?|budget(?:\s+of)?)\s*(?:(${EURO})\s*)?(${AMOUNT})(?:\s*(${EURO})\b)?`,
  "i",
);

export function parseGoal(goalText: string, now = new Date()): GoalIntent {
  const text = goalText.trim();

  const route = text.match(ROUTE_RE);
  const origin = route ? route[1].trim() : null;
  const dest = route ? route[2].trim() : null;

  const isoDates = [...new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])];
  let date = isoDates.length === 1 ? isoDates[0] : null;
  if (!date) {
    const relative = text.match(/\bon\s+(today|tomorrow)\b/i);
    const d = new Date(now);
    if (!relative || relative[1].toLowerCase() === "tomorrow") d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }

  const budgetM = text.match(BUDGET_RE);
  const budget = budgetM && (budgetM[1] || budgetM[3]) ? Number(budgetM[2].replace(/,/g, "")) : null;

  const passengerCandidates = [...text.matchAll(PASSENGER_RE)].map((m) => m[1].trim());
  const weatherM = text.match(/\bweather\s+(?:in|for|at)\s+([^.,;:!?]+)/i);

  return {
    origin,
    dest,
    date,
    dateGiven: isoDates.length === 1,
    wantBooking: /\b(book|reserve)\b/i.test(text) && !/\b(?:do\s+not|don'?t|not|never|without)\s+(?:to\s+)?(?:book|reserve)\b/i.test(text),
    wantWeather: /\bweather\b/i.test(text),
    nonstop: /non[- ]?stop|\bdirect\b|\bno\s+(?:layovers?|stops?|connections?)\b|\bwithout\s+(?:any\s+)?(?:stops?|layovers?|connections?)\b/i.test(text),
    cheapest: /\b(?:cheapest|lowest[- ](?:price|fare|cost)|least\s+expensive)\b/i.test(text),
    multiFlight: /\b(?:return|round[- ]?trip|outbound|inbound|two\s+flights|2\s+flights|both|connecting|multi[- ]city)\b/i.test(text),
    budget,
    passenger: passengerCandidates[0] ?? null,
    passengerCandidates,
    weatherCity: weatherM ? weatherM[1].trim() : null,
  };
}
