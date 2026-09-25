export type AppLabelEntry = { to: string; q?: string };
export type AppLabels = {
  labels: Record<string, AppLabelEntry>;
  phrases: Record<string, AppLabelEntry | null>;
  pages: Record<string, Record<string, AppLabelEntry | null>>;
};
export const PER_BLOCK: number;
export function entryFor(dict: AppLabels, page: string, label: string): AppLabelEntry | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAppLinker(dict: AppLabels): (options?: { page?: string }) => (tree: any) => void;
