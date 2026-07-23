/**
 * Scope filter evaluation — Implementation Guide §4.
 * Deno-portable copy of src/lib/engine/scope.ts (import paths only differ).
 */

import type { EngineRule } from "./domain.ts";
import { hotelStayDateIsoWeekday } from "./timezone.ts";

/**
 * Returns true if the rule's scope filters match the given stay date.
 */
export function ruleScopeMatches(
  rule: EngineRule,
  stayDate: string,
  _evalTs: string,
  hotelTimeZone: string = "UTC",
): boolean {
  if (!rule.is_active) return false;
  if (rule.signal_room_type_ids.length === 0) return false;
  if (rule.affected_room_type_ids.length === 0) return false;

  if (!dateWindowMatches(rule, stayDate)) return false;
  if (!dowMaskMatches(rule.dow_mask, stayDate, hotelTimeZone)) return false;

  return true;
}

function dateWindowMatches(rule: EngineRule, stayDate: string): boolean {
  if (rule.is_annual) {
    return annualWindowMatches(rule, stayDate);
  }
  return literalWindowMatches(rule, stayDate);
}

/** §4.1: literal date window — start_date <= stay_date <= end_date (ISO strings). */
function literalWindowMatches(rule: EngineRule, stayDate: string): boolean {
  if (rule.start_date && stayDate < rule.start_date) return false;
  if (rule.end_date && stayDate > rule.end_date) return false;
  return true;
}

/**
 * §4.2: annual recurrence — month/day only, year-wrap.
 */
function annualWindowMatches(rule: EngineRule, stayDate: string): boolean {
  if (!rule.start_date && !rule.end_date) return true;

  const sdMd = monthDayFromYmd(stayDate);

  if (!rule.start_date) {
    return sdMd <= monthDayFromYmd(rule.end_date!);
  }
  if (!rule.end_date) {
    return sdMd >= monthDayFromYmd(rule.start_date);
  }

  const startMd = monthDayFromYmd(rule.start_date);
  const endMd = monthDayFromYmd(rule.end_date!);

  if (startMd <= endMd) {
    return sdMd >= startMd && sdMd <= endMd;
  }
  return sdMd >= startMd || sdMd <= endMd;
}

/** §4.3: DOW mask — 7-bit, Mon=1 Tue=2 Wed=4 Thu=8 Fri=16 Sat=32 Sun=64. */
function dowMaskMatches(dowMask: number, stayDate: string, hotelTimeZone: string): boolean {
  const isoWeekday = hotelStayDateIsoWeekday(stayDate, hotelTimeZone);
  const bit = 1 << (isoWeekday - 1);
  return (bit & dowMask) !== 0;
}

function monthDayFromYmd(s: string): number {
  const parts = s.split("-").map(Number);
  const m = parts[1];
  const d = parts[2];
  return m * 100 + d;
}
