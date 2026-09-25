// The property systems MAYA connects to, and the ones on the roadmap. The home
// page's Integrations list and the support page share it.

export type PmsStatus = "Early access" | "Coming soon";

export const PMS_ROADMAP: { name: string; status: PmsStatus }[] = [
  { name: "Cloudbeds", status: "Early access" },
  { name: "Mews", status: "Early access" },
  { name: "ThinkReservations", status: "Early access" },
  { name: "StayNTouch", status: "Coming soon" },
  { name: "Little Hotelier", status: "Coming soon" },
  { name: "WebRezPro", status: "Coming soon" },
  { name: "Opera Cloud", status: "Coming soon" },
  { name: "ResNexus", status: "Coming soon" },
  { name: "Maestro", status: "Coming soon" },
];
