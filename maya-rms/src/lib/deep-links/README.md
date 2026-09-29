# Links into MAYA

`registry.json` is the one list of places a link may open and the values it may carry. Everything that makes or reads a link goes through `core.mjs` with this file:

- `/go/<destination>` (`src/app/go/[destination]/route.ts`) checks a link, sends a signed-out visitor through sign-in and back, reroutes a role that cannot act there, then redirects to the app's own address for that place. It changes nothing (apart from the active property, see below).
- The dashboard and the Team, Billing and review pages read what arrived once (`readArrival`), fill forms without saving, highlight the place, then take everything that applies once out of the address bar.
- The docs build (`scripts/docs`) validates every `<OpenInMaya>`, `<AppLink>` and linked `<Ui>` label against it and refuses anything the parser would change or drop.

## Rules for editing

- **Keys are forever.** Never rename a destination or a parameter or give one a new meaning. To retire one, keep it with `"retired": true`; old links in emails and bookmarks keep landing.
- A value may be added to an enum at any time. Removing one follows the retire rule.
- `paths` is the complete list of places `/go` may redirect to. Never add a path that does something on GET (`/onboarding`, `/onboarding/connect`, `/onboarding/confirming`, `/account/billing/restart`, `/login?claim=`, `/auth/*`, any `/api/*`).
- A link only opens and fills in. Nothing a link carries may save, send, go live, pay, invite or delete. No parameter carries a price, an email, a free-text reason or anything else personal; the only free text is a rule name (60 plain characters).
- Bump `version` on every change.

## Unknown destinations

A destination id the registry does not have opens the nearest place it names: `families` maps the part before the dot to that family's main place (`/go/rules` and `/go/rules.edit` open the Rules tab, `/go/billing.cancel` the Billing page), keeping only the parameters that place takes. Anything else (`/go/rule`, `/go/admin.users`, upper case, extra dots or slashes) opens `home`. `/go` still checks the role for wherever it lands.

## Parameter uses

- `place`: stays in the address and drives the screen (`tab`, `panel`, `month`, `date`, `filter`, `view`). Back and forward work, and the address can be shared.
- `once`: read once on arrival, then removed from the address (every pre-fill and highlight, plus `dl` and `note`).
- `gate`: read by `/go` only (`hotel`), never forwarded.

`go: false` keys are set by `/go` from the destination's `target` and never taken from a link. `docs: false` keys are for links the app makes (they name the property's own nights and ids), and the docs build refuses them.

`problem` (a "Prices not reaching" item's id, `changelog.problem`) is a `place` key: the Change Log keeps it in the address, so the item the price editor's "See the error log" opened stays named on a refresh. The highlight itself still runs once, on arrival (`data-deeplink="changelog.problem:<id>"` on the item, `arrivalFlashTarget`). Without a visible item to name, the editor links to the `changelog` destination instead.

## The active property

`hotel` is honoured only when the click came from MAYA itself (`Sec-Fetch-Site: same-origin` or `none`), it is not a prefetch, and the signed-in person can open that property. Otherwise it is ignored and the active property stays. It is never carried through sign-in (the hop back from sign-in is same-origin, so a hand-made `/login?next=` could launder it): `/go` leaves it out of `next`, and `safeNext` strips it. The docs never send it.
