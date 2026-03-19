export type RuleConditionValue = string | number;

export type RuleAction = {
  adjust_rate_percent?: number;
  adjust_rate_dollars?: number;
};

export type RuleConfig = {
  id: string;
  rule_name: string;
  conditions: Record<string, RuleConditionValue>;
  action: RuleAction;
  room_types: string[];
  enabled: boolean;
};

export type CalendarRoomType = {
  name: string;
  total_rooms: number;
  occupancy_pct: number;
  booked: number;
  rate: number;
  revenue: number;
};

export type CalendarDay = {
  occupancy_pct: number;
  booked: number;
  total: number;
  revenue: number;
  weekday: string;
  room_types: CalendarRoomType[];
};

export type CalendarResponse = {
  year: number;
  month: number;
  month_name: string;
  days_in_month: number;
  first_weekday: number;
  thresholds: { low: number; high: number };
  days: Record<string, CalendarDay>;
};

export type SimulationReservation = {
  room_type: string;
  occupancy_percentage: number;
  booking_window: number;
  pickup_rate: number;
  current_rate: number;
};

export type SimulationResult = {
  room_type: string;
  original_rate: number;
  new_rate: number;
  applied_rules: string;
};

export type ChangelogEntry = {
  room_type: string;
  rule_name: string;
  original_rate: number;
  new_rate: number;
  change_pct: number;
  occupancy_pct: number;
  description: string;
};

export type ChangelogCycle = {
  cycle: number;
  timestamp: string;
  has_changes: boolean;
  changes: ChangelogEntry[];
};
