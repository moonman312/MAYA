/**
 * The one judgement of whether a room type's name says "nobody sleeps here".
 *
 * Every PMS models a pickleball court, a parking bay, a boardroom and a spa
 * slot as a "room type", because sellable inventory is the only primitive it
 * has. Billing, the onboarding review, the import's proposal for
 * counts_as_room and the floor answer all need the same answer, from the same
 * rules, or they would eventually disagree about what a customer owes and
 * what MAYA prices. Kept in a module of its own so any of them can import it
 * without pulling the import analysis in with it.
 *
 * Naive keyword matching is a trap here: "Cabana Suite", "Spa Suite",
 * "Poolside King" and "Ballroom Suite" are all real bedrooms at real resorts.
 * So the signals are split in two.
 */

/** Never a sleeping room, whatever else the name says. */
const NON_ROOM_STRONG =
  /\b(parking|pickleball|boardroom|banquet|conference|meeting|treatment|massage|storage|locker|kayak|excursion|day\s?-?use|gift\s?shop|deposit|resort\s?fee|service\s?fee|add-?on|misc)\b/i;

/** Suggestive, but only damning when the name has no bedroom noun in it. */
const NON_ROOM_WEAK =
  /\b(spa|pool|cabana|golf|tennis|court|event|hall|ballroom|venue|gym|tour|rental|bike|wedding|package|fee)\b/i;

/** If one of these appears, someone sleeps there. */
const ROOM_NOUN =
  /\b(rooms?|suites?|kings?|queens?|doubles?|twins?|singles?|studios?|villas?|cabins?|bungalows?|apartments?|dorms?|beds?|bunks?|penthouses?|lofts?|cottages?|chalets?|casitas?)\b/i;

/**
 * The bill-time and review-time judgement: a strong word, or a weak word with
 * no bedroom noun beside it.
 */
export function nameLooksLikeNonRoom(name: string): boolean {
  if (NON_ROOM_STRONG.test(name)) return true;
  return NON_ROOM_WEAK.test(name) && !ROOM_NOUN.test(name);
}

/**
 * The stricter half of the same judgement: only the words that are never a
 * bedroom. "Deluxe Pool View" and "Spa Deluxe" trip the weak test, and they
 * are real bedrooms at real resorts. That test is fine for a bill-time
 * exclusion that under-charges us, but not for a default that takes a type
 * out of the engine's occupancy before anyone has looked at it, nor for
 * leaving a real room without the owner's floor.
 */
export function nameIsCertainlyNonRoom(name: string): boolean {
  return NON_ROOM_STRONG.test(name);
}

/**
 * Whether a room type is one MAYA should treat as a room when it applies a
 * hotel-wide answer to it. The owner's word (counts_as_room) wins in both
 * directions; a type nobody has answered for counts as a room unless its
 * name is one the import would have proposed as a non-room (the strong test),
 * which is what a live hotel's five-minute sync leaves null on purpose.
 */
export function treatAsRoom(rt: { counts_as_room?: boolean | null; name?: string | null; display_name?: string | null }): boolean {
  if (rt.counts_as_room === false) return false;
  if (rt.counts_as_room === true) return true;
  return !nameIsCertainlyNonRoom(String(rt.display_name || rt.name || ""));
}
