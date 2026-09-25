// Hand-picked lists for the docs home, the support page and the docs
// helper's starters. Every link is checked by the tests.

export const TOP_QUESTIONS = [
  { q: "Did a rule cut my price for the wedding weekend?", href: "/docs/wrong/start-here#did-a-rule-cut-my-price-for-the-wedding-weekend" },
  { q: "Why did nothing change today?", href: "/docs/wrong/start-here#why-did-nothing-change-today" },
  { q: "Can I undo that?", href: "/docs/recipes/undo-a-price-change" },
  { q: "Is it sending prices right now?", href: "/docs/wrong/start-here#is-it-sending-prices-right-now" },
  { q: "What happens if my card fails?", href: "/docs/billing/cards-payments-and-invoices#when-a-payment-fails" },
  { q: "How do I set a price myself?", href: "/docs/watch/setting-a-price-yourself" },
  { q: "How do I go live, and can I go back?", href: "/docs/live/going-live" },
  { q: "What is booking speed?", href: "/docs/rules/booking-speed" },
  { q: "Why is my occupancy different from Cloudbeds'?", href: "/docs/wrong/occupancy-looks-wrong#why-does-mayas-occupancy-differ-from-cloudbeds" },
  { q: "How do I change a rule?", href: "/docs/recipes/change-a-rule" },
];

export const START_WHERE_YOU_ARE = [
  { label: "I'm deciding", blurb: "What MAYA does, and what it does not.", href: "/docs/start/what-maya-does" },
  { label: "I've just connected", blurb: "The history import and what happens next.", href: "/docs/review/the-history-import" },
  { label: "I'm building rules", blurb: "Your first rule, one field at a time.", href: "/docs/rules/build-your-first-rule" },
  { label: "I want to go live", blurb: "Simulation, the switch, and going back.", href: "/docs/live/going-live" },
  { label: "Something looks wrong", blurb: "The four questions people ask first.", href: "/docs/wrong/start-here" },
  { label: "Billing and team", blurb: "Your bill, your card, your people.", href: "/docs/billing/the-billing-page" },
];

export const PMS_CARDS = [
  {
    name: "Cloudbeds",
    status: "Connect from the Cloudbeds Marketplace, with a 7-day free trial. MAYA reads and sends prices.",
    href: "/docs/connect/cloudbeds",
  },
  {
    name: "ThinkReservations",
    status: "Connect from inside MAYA after paying. A code may be needed. MAYA reads and sends prices.",
    href: "/docs/connect/thinkreservations",
  },
  {
    name: "Mews",
    status: "We connect it for you. MAYA reads your bookings and shows prices, and does not send them yet.",
    href: "/docs/connect/mews",
  },
];

export const HOME_STARTERS = [
  "What does MAYA actually do?",
  "How do I build my first rule?",
  "Did a rule cut my price for the wedding weekend?",
  "Can I undo that?",
  "Is it sending prices right now?",
  "What is booking speed?",
];

export const SUPPORT_STARTERS = [
  "How do I connect Cloudbeds?",
  "What does it cost?",
  "I forgot my password",
  "What happens if my card fails?",
  "How do I go live, and can I go back?",
  "Is there a status page?",
];

export const SUPPORT_EMAIL = "info@modern-hospitality-solutions.com";
