export type ParamSpec = {
  type: "enum" | "flag" | "int" | "number" | "cmp" | "date" | "month" | "uuid" | "text" | "destination";
  use: "place" | "once" | "gate";
  values?: string[];
  min?: number;
  max?: number;
  gt?: number;
  decimals?: number;
  default?: string;
  go?: boolean;
  docs?: boolean;
  global?: boolean;
  fills?: boolean;
  requires?: string[];
  droppedBy?: string[];
  row?: string;
  field?: string;
  check?: string;
  notBefore?: string;
  maxDaysAfter?: number;
  chars?: string;
};

export type DestinationSpec = {
  label: string;
  opens: string;
  target: { path: string; set?: Record<string, string> };
  params: string[];
  narrow?: Record<string, string[]>;
  required?: string[];
  fallback?: string;
  role?: string;
  belowRole?: "page" | { to: string; note: string };
  when?: Record<string, { to: string; set?: Record<string, string> }>;
  flash?: string;
  saveButton?: string;
  docs?: string;
  docsLinkable?: boolean;
  examples?: { q: string; out: string; dest?: string; docsProblems?: string[] }[];
};

export type Registry = {
  version: number;
  limits: { rawQueryChars: number; rawValueChars: number; keys: number; nextChars: number };
  roles: string[];
  paths: string[];
  params: Record<string, ParamSpec>;
  destinations: Record<string, DestinationSpec>;
  unknownDestinationExamples: { dest: string; q: string; resolves: string; out: string }[];
  help: { screens: Record<string, string>; panels: Record<string, string> };
};

export type ParsedLink = {
  dest: string;
  params: Record<string, string>;
  query: string;
  gate: Record<string, string>;
  problems: string[];
  fellBack: boolean;
};

export type Arrival = {
  dest: string | null;
  params: Record<string, string>;
  note: string | null;
  focus: string | null;
  keep: string;
};

export type LinkSource = "go" | "docs" | "arrival";

export type Links = {
  registry: Registry;
  isDestination(id: unknown): id is string;
  destination(id: string): DestinationSpec;
  checkValue(key: string, raw: string, narrowed?: string[]): string | null;
  parseLink(
    dest: string,
    query: string | URLSearchParams | Record<string, string> | null | undefined,
    options?: { source?: LinkSource },
  ): ParsedLink;
  canonicalQuery(dest: string, params: Record<string, string>): string;
  goHref(dest: string, params?: Record<string, string>, options?: { hotel?: string }): string;
  internalHref(parsed: Pick<ParsedLink, "dest" | "params">, options?: { note?: string | null }): string;
  readArrival(search: string | null | undefined): Arrival;
  fills(params: Record<string, string> | null | undefined): boolean;
};

export function createLinks(registry: Registry): Links;
export function safeNext(raw: unknown): string | null;
export function docsHref(ref: string | null | undefined): string;
export function realDate(s: string): number | null;
