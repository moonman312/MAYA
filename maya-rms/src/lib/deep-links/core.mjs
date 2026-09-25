// Links into MAYA: the one parser.
//
// Plain JavaScript on purpose. The app imports it (through index.ts, which
// binds registry.json), and so does the docs build (scripts/docs), which runs
// in plain Node before `next build` and must refuse a docs link this file
// would change or drop. One implementation means the docs can never show a
// link the app reads differently.
//
// Everything here is pure: no network, no DOM, no clock. The rules are the
// ones in registry.json and README.md beside it:
//
//   - a destination id that is not in the registry opens "home";
//   - a query over limits.rawQueryChars is ignored whole (the place still opens);
//   - only the first limits.keys keys are read, and the first of a repeated key wins;
//   - unknown keys, keys the destination does not take and bad values are
//     dropped one at a time, and the rest of the link still works;
//   - cross-field rules run after single values (requires, droppedBy, the
//     through range), then a destination missing a required key becomes its
//     fallback, keeping only what the fallback takes;
//   - whatever comes out is written back in the destination's own key order,
//     so the raw input is never echoed anywhere.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_OK = /^[\p{L}\p{M}\p{N} \-'’,.%&+()]+$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function numberPattern(decimals) {
  return new RegExp(`^\\d{1,6}${decimals > 0 ? `(\\.\\d{1,${decimals}})?` : ""}$`);
}

/** Milliseconds for a real YYYY-MM-DD between 2000 and 2100, else null. */
export function realDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 2000 || y > 2100) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}

const DEST_PATH = /^\/go\/[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

/**
 * The only `next` the sign-in page follows: one of MAYA's own /go links.
 * Returns the path and query to go to (a #fragment is dropped), or null.
 */
export function safeNext(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1536) return null;
  if (!raw.startsWith("/go/")) return null;
  if (/[\\\s]/.test(raw) || CONTROL.test(raw)) return null;
  let u;
  try {
    u = new URL(raw, "https://app.invalid");
  } catch {
    return null;
  }
  if (u.origin !== "https://app.invalid") return null;
  if (!DEST_PATH.test(u.pathname)) return null;
  // The active property is never switched by way of the sign-in page.
  u.searchParams.delete("hotel");
  const search = u.searchParams.toString();
  return u.pathname + (search ? `?${search}` : "");
}

/** The docs address for a registry docs reference ("section/page#anchor"). */
export function docsHref(ref) {
  if (typeof ref !== "string" || ref === "") return "/docs";
  const [page, anchor] = ref.split("#");
  return `/docs/${page}${anchor ? `#${anchor}` : ""}`;
}

export function createLinks(registry) {
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const isDestination = (id) => typeof id === "string" && has(registry.destinations, id);
  const destination = (id) => registry.destinations[isDestination(id) ? id : "home"];

  /** One value against one parameter. The canonical string, or null to drop it. */
  function checkValue(key, raw, narrowed) {
    const spec = registry.params[key];
    if (!spec || typeof raw !== "string") return null;
    if (raw.length > registry.limits.rawValueChars) return null;
    switch (spec.type) {
      case "enum": {
        const values = narrowed ?? spec.values;
        return values.includes(raw) ? raw : null;
      }
      case "flag":
        return raw === "1" ? "1" : null;
      case "int": {
        if (!/^\d{1,6}$/.test(raw)) return null;
        const n = Number(raw);
        return n >= spec.min && n <= spec.max ? String(n) : null;
      }
      case "number": {
        if (!numberPattern(spec.decimals ?? 0).test(raw)) return null;
        const n = Number(raw);
        if (spec.gt !== undefined && !(n > spec.gt)) return null;
        if (spec.min !== undefined && n < spec.min) return null;
        if (spec.max !== undefined && n > spec.max) return null;
        return String(n);
      }
      case "cmp": {
        const m = /^(gt|lt)(.*)$/.exec(raw);
        if (!m || !numberPattern(spec.decimals ?? 0).test(m[2])) return null;
        const n = Number(m[2]);
        if (n < spec.min || n > spec.max) return null;
        return `${m[1]}${n}`;
      }
      case "date":
        return realDate(raw) === null ? null : raw;
      case "month": {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return null;
        const y = Number(raw.slice(0, 4));
        return y >= 2000 && y <= 2100 ? raw : null;
      }
      case "uuid": {
        const v = raw.toLowerCase();
        return UUID.test(v) ? v : null;
      }
      case "text": {
        if (CONTROL.test(raw)) return null;
        const v = raw.normalize("NFC").replace(/\s+/g, " ").trim();
        if (v.length === 0 || [...v].length > spec.max) return null;
        return TEXT_OK.test(v) ? v : null;
      }
      case "destination":
        return isDestination(raw) ? raw : null;
      default:
        return null;
    }
  }

  function toPairs(query) {
    if (query == null) return [];
    if (typeof query === "string") {
      const q = query.startsWith("?") ? query.slice(1) : query;
      if (q.length > registry.limits.rawQueryChars) return [];
      return [...new URLSearchParams(q)];
    }
    if (query instanceof URLSearchParams) {
      if (query.toString().length > registry.limits.rawQueryChars) return [];
      return [...query];
    }
    // a plain object (docs attributes): values are strings
    return Object.entries(query).filter(([, v]) => typeof v === "string");
  }

  /**
   * source "go"      a /go link from anywhere: bad or unknown keys are dropped one by one.
   * source "docs"    a link the docs build writes: every drop, and every key the docs
   *                  may not send, is reported in `problems` so the build can refuse it.
   * source "arrival" the landing page re-reading what /go sent: only the destination's
   *                  own keys are read; the place keys and dl are someone else's.
   */
  function parseLink(destRaw, query, options = {}) {
    const source = options.source ?? "go";
    const problems = [];
    let destId = isDestination(destRaw) ? destRaw : "home";
    let fellBack = destId !== destRaw;
    if (fellBack && source === "docs") problems.push(`destination "${destRaw}"`);
    const dest = registry.destinations[destId];

    const firsts = new Map();
    let keys = 0;
    for (const [k, v] of toPairs(query)) {
      if (firsts.has(k)) continue;
      if (++keys > registry.limits.keys) break;
      firsts.set(k, v);
    }

    const out = {};
    const gate = {};
    for (const [k, v] of firsts) {
      const spec = has(registry.params, k) ? registry.params[k] : null;
      const allowedHere = spec && (dest.params.includes(k) || spec.global === true) && spec.go !== false;
      if (!allowedHere) {
        if (source !== "arrival") problems.push(k);
        continue;
      }
      if (source === "docs" && spec.docs === false) problems.push(k);
      if (source === "arrival" && spec.use === "gate") continue;
      const value = checkValue(k, v, dest.narrow?.[k]);
      if (value === null) {
        problems.push(k);
        continue;
      }
      if (source === "docs" && value !== v) problems.push(`${k} (would read as "${value}")`);
      if (spec.use === "gate") gate[k] = value;
      else out[k] = value;
    }

    for (const k of Object.keys(out)) {
      const spec = registry.params[k];
      if (spec.requires?.some((r) => !(r in out))) {
        delete out[k];
        problems.push(k);
      }
    }
    for (const k of Object.keys(out)) {
      const spec = registry.params[k];
      if (spec.droppedBy?.some((r) => r in out)) {
        delete out[k];
        problems.push(k);
      }
    }
    if ("through" in out) {
      const from = realDate(out.date);
      const to = realDate(out.through);
      const days = from === null || to === null ? -1 : (to - from) / 86_400_000;
      if (days < 0 || days > (registry.params.through.maxDaysAfter ?? 365)) {
        delete out.through;
        problems.push("through");
      }
    }

    if (dest.required?.some((r) => !(r in out))) {
      if (source === "docs") problems.push(`missing ${dest.required.filter((r) => !(r in out)).join(", ")}`);
      const fb = registry.destinations[dest.fallback] ? dest.fallback : "home";
      for (const k of Object.keys(out)) if (!registry.destinations[fb].params.includes(k)) delete out[k];
      destId = fb;
      fellBack = true;
    }

    return {
      dest: destId,
      params: out,
      query: canonicalQuery(destId, out),
      gate,
      problems: [...new Set(problems)],
      fellBack,
    };
  }

  /** The params in the destination's own order, as a query string without "?". */
  function canonicalQuery(destId, params) {
    const d = destination(destId);
    const sp = new URLSearchParams();
    for (const k of d.params) if (params && typeof params[k] === "string") sp.set(k, params[k]);
    return sp.toString();
  }

  /** The /go address for a destination and its (already valid) params. */
  function goHref(destId, params = {}, options = {}) {
    const id = isDestination(destId) ? destId : "home";
    const q = canonicalQuery(id, params);
    const sp = new URLSearchParams(q);
    if (options.hotel && checkValue("hotel", options.hotel) !== null) sp.set("hotel", options.hotel.toLowerCase());
    const s = sp.toString();
    return `/go/${id}${s ? `?${s}` : ""}`;
  }

  /**
   * Where /go sends a parsed link inside the app: the registry's path, the
   * destination's fixed keys, which destination it came through (dl), an
   * optional note, then its params. The path always comes from the registry.
   */
  function internalHref(parsed, options = {}) {
    const d = destination(parsed.dest);
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(d.target.set ?? {})) sp.set(k, v);
    sp.set("dl", isDestination(parsed.dest) ? parsed.dest : "home");
    if (options.note && checkValue("note", options.note) !== null) sp.set("note", options.note);
    for (const k of d.params) if (typeof parsed.params?.[k] === "string") sp.set(k, parsed.params[k]);
    const path = registry.paths.includes(d.target.path) ? d.target.path : "/";
    return `${path}?${sp.toString()}`;
  }

  /**
   * What a landing page reads once, on arrival: the destination it came
   * through (a valid dl is required; without one nothing is filled), the
   * note, its params re-validated from scratch, and the part of the page to
   * highlight. `keep` is the query without anything that applies once, for
   * history.replaceState.
   */
  function readArrival(search) {
    const sp = new URLSearchParams(typeof search === "string" && search.startsWith("?") ? search.slice(1) : search ?? "");
    const keep = new URLSearchParams();
    for (const [k, v] of sp) {
      const spec = has(registry.params, k) ? registry.params[k] : null;
      if (spec && spec.use === "place") keep.append(k, v);
    }
    const dl = sp.get("dl");
    if (!isDestination(dl)) return { dest: null, params: {}, note: null, focus: null, keep: keep.toString() };
    const parsed = parseLink(dl, sp, { source: "arrival" });
    const d = registry.destinations[parsed.dest];
    const noteRaw = sp.get("note");
    const note = noteRaw !== null ? checkValue("note", noteRaw) : null;
    const focus = parsed.params.focus ?? d.target.set?.focus ?? null;
    return { dest: parsed.dest, params: parsed.params, note, focus, keep: keep.toString() };
  }

  /** True when any of these params puts a value into a form. */
  function fills(params) {
    return Object.keys(params ?? {}).some((k) => registry.params[k]?.fills === true);
  }

  return {
    registry,
    isDestination,
    destination,
    checkValue,
    parseLink,
    canonicalQuery,
    goHref,
    internalHref,
    readArrival,
    fills,
  };
}
