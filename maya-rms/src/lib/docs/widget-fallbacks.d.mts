export interface OccupancyProps {
  rooms?: number;
  outOfService?: number;
  booked?: number;
  threshold?: number;
  compare?: "greater" | "less";
}
export declare const OCCUPANCY_DEFAULTS: Required<OccupancyProps>;
export declare function occupancySentence(props?: OccupancyProps): string;
export declare const WIDGET_NAMES: string[];
export declare function fallbackFor(name: string, props?: Record<string, unknown>): string | null;
