import { bench, describe } from "vitest";
import { buildSessionTimelineItems } from "./timeline-items";
import {
  generateTimelinePerformanceFixture,
  LARGE_SESSION_EVENT_COUNT,
} from "./timeline-performance-fixture";

const DERIVATION_EVENT_COUNTS = [1_000, 5_000, LARGE_SESSION_EVENT_COUNT] as const;
const derivationFixtures = DERIVATION_EVENT_COUNTS.map((eventCount) => ({
  eventCount,
  events: generateTimelinePerformanceFixture(eventCount),
}));

describe("timeline performance", () => {
  bench("generate a 100,000-event fixture", () => {
    generateTimelinePerformanceFixture(LARGE_SESSION_EVENT_COUNT);
  });

  for (const { eventCount, events } of derivationFixtures) {
    bench(`derive timeline items from ${eventCount.toLocaleString("en-US")} events`, () => {
      buildSessionTimelineItems(events);
    });
  }
});
