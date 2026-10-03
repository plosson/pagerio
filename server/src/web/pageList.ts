import type { DeliveryCounts, PageRow } from "../services/pages";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const BURST_WINDOW_MS = 10 * MINUTE_MS;
/** The newest page shows the orange "new page" dot while it is this recent. */
export const NEW_PAGE_MS = 15 * MINUTE_MS;

/** "just now", "4 min ago", "2 h ago", "3 d ago". A time in the future (clock skew) is "just now". */
export function relativeTime(at: number, now: number): string {
  const age = now - at;
  if (age < MINUTE_MS) return "just now";
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} h ago`;
  return `${Math.floor(age / DAY_MS)} d ago`;
}

export type PageGroup = { page: PageRow; count: number; delivery: DeliveryCounts };

/**
 * Pages are newest first. A run of pages with the same title and message, all within ten minutes
 * of the run's newest page, becomes one row that keeps the count and the summed delivery.
 */
export function groupBursts(pages: PageRow[], delivery: Map<string, DeliveryCounts>): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const page of pages) {
    const counts = delivery.get(page.id) ?? { sent: 0, sending: 0, failed: 0 };
    const last = groups.at(-1);
    if (last && last.page.title === page.title && last.page.message === page.message && last.page.created_at - page.created_at <= BURST_WINDOW_MS) {
      last.count += 1;
      last.delivery = { sent: last.delivery.sent + counts.sent, sending: last.delivery.sending + counts.sending, failed: last.delivery.failed + counts.failed };
    } else {
      groups.push({ page, count: 1, delivery: { ...counts } });
    }
  }
  return groups;
}

export type DeliveryStatus = { kind: "failed" | "sending" | "sent" | "none"; icon: string; text: string };

const devices = (n: number) => (n === 1 ? "1 device" : `${n} devices`);

/** Never "delivered": APNs accepting a push only means it was sent. */
export function deliveryStatus(counts: DeliveryCounts): DeliveryStatus {
  if (counts.failed > 0) return { kind: "failed", icon: "!", text: `${counts.failed} failed` };
  if (counts.sending > 0) return { kind: "sending", icon: "⟳", text: "Sending…" };
  if (counts.sent > 0) return { kind: "sent", icon: "✓", text: `Sent to ${devices(counts.sent)}` };
  return { kind: "none", icon: "○", text: "No devices" };
}

export function devicesLine(platforms: string[]): string {
  const names = [...new Set(platforms.map((p) => (p === "ios" ? "iPhone" : "Mac")))];
  return `${devices(platforms.length)} will ring · ${names.join(", ")}`;
}
