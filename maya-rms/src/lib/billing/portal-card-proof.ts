/**
 * Reading the results of the Stripe portal card proof (A35).
 *
 * scripts/stripe-portal-card-proof.mts sets up, on a Stripe test clock, the
 * situation MAYA's checkout produces: a customer with NO default card, and
 * subscriptions that each carry their own card. On three customers (a group)
 * one subscription is on a card that fails, so its renewal is overdue, and
 * the other is on a different card of its own on purpose, like a group
 * property billed to its own card. The fourth customer is one property: only
 * the overdue subscription. The owner then uses one portal control per
 * customer, and this says what Stripe did to each subscription's own card,
 * what MAYA's webhook would then do (card-change.ts, run on the state Stripe
 * left), and whether that means MAYA must change.
 *
 * Pure: no Stripe calls here, so the reading can be tested.
 */

import { oldCardFor, planFor, type CardPlan } from "./card-change";

/** The portal control each proof customer is there to test. */
export type PortalControl = "add_card" | "card_flow" | "make_default" | "single_add_card";

const ADD_A_CARD =
  "Open the link. Under the payment methods, add a new card (4242 4242 4242 4242, any future date, any CVC) and keep the option to make it the default ticked if one is shown.";

export const PORTAL_CONTROLS: Record<PortalControl, { label: string; howTo: string; group: boolean }> = {
  add_card: {
    label: "Full portal: add a new card",
    howTo: ADD_A_CARD,
    group: true,
  },
  card_flow: {
    label: "Card-only screen (payment_method_update)",
    howTo:
      "Open the link. It goes straight to Stripe's screen for a new payment method. Enter 4242 4242 4242 4242, any future date, any CVC, and save.",
    group: true,
  },
  make_default: {
    label: "Full portal: make the spare card the default",
    howTo:
      "Open the link. The customer already has a spare card (the links step prints which). Use the menu next to it to make it the default. Add nothing.",
    group: true,
  },
  single_add_card: {
    label: "Full portal, one property: add a new card",
    howTo: ADD_A_CARD,
    group: false,
  },
};

/** What happened to one subscription's own card after the portal action. */
export type CardFate =
  /** Still on the card it had before. */
  | "kept"
  /** Its own card was removed, so it follows the customer's default. */
  | "cleared"
  /** Its own card is now the customer's new default. */
  | "moved"
  /** Some other card. Should not happen; read the subscription by hand. */
  | "other";

export function cardFate(before: string | null, after: string | null, customerDefault: string | null): CardFate {
  if (after === before) return "kept";
  if (!after) return "cleared";
  if (customerDefault && after === customerDefault) return "moved";
  return "other";
}

/** One subscription's own card, as set up and as the portal left it. */
export type ProofCard = { before: string; after: string | null };

export type ProofReading = {
  control: PortalControl;
  /** The customer's default card after the action. Null: none, so the action did not happen. */
  defaultCard: string | null;
  /** The overdue subscription, set up on the failing card (as if from checkout). */
  overdue: ProofCard;
  /** The subscription on a different card of its own. Absent for the one-property customer. */
  ownCard?: ProofCard | null;
  /** The overdue subscription's open invoice after the action, before any retry. */
  overdueInvoice: "paid" | "open" | "other" | "none";
};

/** What MAYA's webhook would do with the state Stripe left: no default before, so card-change.ts infers the old card. */
export type MayaPlan = { overdue: CardPlan; ownCard: CardPlan | null; ambiguous: boolean };

export function mayaPlanFor(r: ProofReading): MayaPlan | null {
  if (!r.defaultCard) return null;
  const subs = [r.overdue, ...(r.ownCard ? [r.ownCard] : [])];
  // The proof customers have no default card before the action, as after checkout.
  const old = oldCardFor(null, subs.map((s) => ({ own: s.after })), r.defaultCard);
  return {
    overdue: planFor(r.overdue.after, r.defaultCard, old.card),
    ownCard: r.ownCard ? planFor(r.ownCard.after, r.defaultCard, old.card) : null,
    ambiguous: old.ambiguous,
  };
}

export type ProofVerdict = {
  /** One line on what Stripe did. */
  finding: string;
  /** One line on what MAYA's webhook would then do. Null when nothing was proved. */
  maya: string | null;
  /** True when what Stripe did, or what MAYA would do, means MAYA (code or docs) has to change. */
  changeNeeded: boolean;
  /** What to do about it. */
  action: string;
};

function mayaLine(plan: MayaPlan, invoice: ProofReading["overdueInvoice"]): string {
  const pays = invoice === "open" ? "pays its open invoice with the new card at once" : "finds no open invoice to pay";
  const overdue =
    plan.overdue === "move"
      ? `moves the overdue subscription to the new card and ${pays}`
      : plan.overdue === "own_card"
        ? "leaves the overdue subscription on the failing card and pays nothing (no default before and two different cards: it cannot tell which was the old one)"
        : `${pays} for the overdue subscription (it ${plan.overdue === "follows" ? "follows the default" : "is on the new card"} already)`;
  if (plan.ownCard == null) return `MAYA ${overdue}.`;
  const own = plan.ownCard === "move" ? "moves the subscription on its own card to the new card" : "leaves the subscription on its own card alone";
  return `MAYA ${overdue}, and ${own}.`;
}

export function readProof(r: ProofReading): ProofVerdict {
  const name = PORTAL_CONTROLS[r.control].label;
  if (!r.defaultCard) {
    return {
      finding: `${name}: the customer's default card did not change.`,
      maya: null,
      changeNeeded: false,
      action:
        "Nothing was proved. Either the action was not done, or this control saves a card without making it the default. Note which, and run check again after doing it.",
    };
  }
  const overdueFate = cardFate(r.overdue.before, r.overdue.after, r.defaultCard);
  const ownFate = r.ownCard ? cardFate(r.ownCard.before, r.ownCard.after, r.defaultCard) : null;
  const plan = mayaPlanFor(r) as MayaPlan;
  const maya = mayaLine(plan, r.overdueInvoice);

  if (ownFate === "cleared" || ownFate === "moved") {
    return {
      finding: `${name}: Stripe took the subscription on its own card off that card (${ownFate}).`,
      maya,
      changeNeeded: true,
      action:
        "Through this control the portal itself moves a property off a card of its own, which MAYA never does. Tell Claude: the docs promise (a group property can stay on its own card) needs changing for this control, or MAYA needs to put the card back. Jake's call.",
    };
  }
  if (ownFate === "other" || overdueFate === "other") {
    return {
      finding: `${name}: a subscription ended up on a card that is neither its old one nor the new default.`,
      maya,
      changeNeeded: true,
      action: "Unexpected. Open the subscriptions in the dashboard, note their payment method, and send that to Claude.",
    };
  }
  if (plan.ownCard === "move") {
    return {
      finding: `${name}: Stripe left the subscription on its own card alone.`,
      maya,
      changeNeeded: true,
      action: "MAYA would move a property off a card of its own, which it promises never to do. Send this output to Claude.",
    };
  }
  const paidLine =
    r.overdueInvoice === "paid" ? " The portal also paid the overdue invoice itself, so MAYA finds nothing open (harmless)." : "";

  if (!r.ownCard) {
    if (overdueFate === "kept") {
      return {
        finding: `${name}: Stripe left the subscription on the failing card.${paidLine}`,
        maya,
        changeNeeded: false,
        action:
          "This is the gap A35 closes: without MAYA, Stripe keeps retrying the failing card. With one property, every subscription is on that one card, so MAYA moves it and pays. No change.",
      };
    }
    return {
      finding: `${name}: Stripe moved the subscription to the new card itself (${overdueFate}).${paidLine}`,
      maya,
      changeNeeded: false,
      action: "MAYA has nothing to move, and its payment still settles the overdue invoice at once. No change.",
    };
  }

  if (overdueFate === "kept") {
    return {
      finding: `${name}: Stripe left both subscriptions on their own cards.${paidLine}`,
      maya,
      changeNeeded: false,
      action:
        "The documented exception: with no default card before and two different cards, MAYA moves neither, so the overdue property keeps retrying the failing card until the owner emails us which properties to move (cards-payments-and-invoices, Moving to another card). No change, unless Jake wants this case handled too.",
    };
  }
  return {
    finding: `${name}: Stripe moved the overdue subscription to the new card itself (${overdueFate}) and left the one on its own card alone.${paidLine}`,
    maya,
    changeNeeded: false,
    action: "MAYA leaves the one on its own card alone and settles the overdue invoice at once. No change.",
  };
}
