import { describe, expect, test } from "bun:test";
import type { PageRow } from "../../src/services/pages";
import { deliveryStatus, devicesLine, groupBursts, relativeTime } from "../../src/web/pageList";
import { T0 } from "../helpers";

const MIN = 60_000;

let n = 0;
function page(over: Partial<PageRow> = {}): PageRow {
  n += 1;
  return {
    id: `pg_${n}`,
    public_id: `pub${n}`,
    account_id: "acc",
    title: "Deploy failed",
    message: "rollout stopped",
    details: null,
    url: null,
    group_key: null,
    source: "trigger",
    idempotency_key: null,
    created_at: T0,
    ...over,
  };
}

describe("relativeTime", () => {
  test("never goes negative: a page from the future is 'just now'", () => {
    expect(relativeTime(T0 + 5 * 60 * MIN, T0)).toBe("just now");
    expect(relativeTime(T0 + 365 * 24 * 60 * MIN, T0)).toBe("just now");
  });

  test("boundaries land on the documented formats", () => {
    expect(relativeTime(T0 - 59_999, T0)).toBe("just now");
    expect(relativeTime(T0 - MIN, T0)).toBe("1 min ago");
    expect(relativeTime(T0 - 59 * MIN - 59_999, T0)).toBe("59 min ago");
    expect(relativeTime(T0 - 60 * MIN, T0)).toBe("1 h ago");
    expect(relativeTime(T0 - 24 * 60 * MIN + 1, T0)).toBe("23 h ago");
    expect(relativeTime(T0 - 24 * 60 * MIN, T0)).toBe("1 d ago");
    expect(relativeTime(T0 - 30 * 24 * 60 * MIN, T0)).toBe("30 d ago");
  });
});

describe("groupBursts", () => {
  test("a looping script's 37 identical pages in 5 minutes collapse into one row, newest first", () => {
    const burst = Array.from({ length: 37 }, (_, i) => page({ created_at: T0 - i * 8_000 }));
    const groups = groupBursts(burst, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(37);
    expect(groups[0]!.page).toBe(burst[0]!);
  });

  test("failures inside a burst are summed, so one failure is never hidden by successes", () => {
    const pages = [page(), page({ created_at: T0 - MIN }), page({ created_at: T0 - 2 * MIN })];
    const delivery = new Map([
      [pages[0]!.id, { sent: 2, sending: 0, failed: 0 }],
      [pages[1]!.id, { sent: 1, sending: 0, failed: 1 }],
      [pages[2]!.id, { sent: 2, sending: 0, failed: 0 }],
    ]);
    const [group] = groupBursts(pages, delivery);
    expect(group!.delivery).toEqual({ sent: 5, sending: 0, failed: 1 });
    expect(deliveryStatus(group!.delivery)).toEqual({ kind: "failed", icon: "!", text: "1 failed" });
  });

  test("the window is measured from the run's newest page, so an endless loop still splits", () => {
    const pages = Array.from({ length: 30 }, (_, i) => page({ created_at: T0 - i * MIN }));
    const groups = groupBursts(pages, new Map());
    expect(groups.map((g) => g.count)).toEqual([11, 11, 8]);
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(30);
  });

  test("a different page between identical ones breaks the run", () => {
    const pages = [page(), page({ title: "Other", created_at: T0 - MIN }), page({ created_at: T0 - 2 * MIN })];
    expect(groupBursts(pages, new Map()).map((g) => g.count)).toEqual([1, 1, 1]);
  });

  test("same message but a missing versus empty-looking title is not the same page", () => {
    const pages = [page({ title: null }), page({ title: "rollout stopped", message: "rollout stopped", created_at: T0 - MIN })];
    expect(groupBursts(pages, new Map())).toHaveLength(2);
  });

  test("an empty list stays empty and a missing delivery entry counts as zero", () => {
    expect(groupBursts([], new Map())).toEqual([]);
    expect(groupBursts([page()], new Map())[0]!.delivery).toEqual({ sent: 0, sending: 0, failed: 0 });
  });
});

describe("deliveryStatus", () => {
  test("pairs an icon with a word for every state and never says delivered", () => {
    const states = [
      { sent: 0, sending: 0, failed: 0 },
      { sent: 0, sending: 2, failed: 0 },
      { sent: 1, sending: 0, failed: 0 },
      { sent: 2, sending: 1, failed: 0 },
      { sent: 0, sending: 1, failed: 3 },
    ].map(deliveryStatus);
    expect(states.map((s) => `${s.icon} ${s.text}`)).toEqual(["○ No devices", "⟳ Sending…", "✓ Sent to 1 device", "⟳ Sending…", "! 3 failed"]);
    for (const s of states) expect(s.text.toLowerCase()).not.toContain("deliver");
  });
});

describe("devicesLine", () => {
  test("names each platform once", () => {
    expect(devicesLine(["ios", "macos", "ios"])).toBe("3 devices will ring · iPhone, Mac");
    expect(devicesLine(["macos"])).toBe("1 device will ring · Mac");
  });
});
