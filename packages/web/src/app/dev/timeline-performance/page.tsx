import { notFound } from "next/navigation";
import { TimelinePerformanceLab } from "./timeline-performance-lab";

export const dynamic = "force-dynamic";

export default function TimelinePerformancePage() {
  if (process.env.NODE_ENV === "production") notFound();

  return <TimelinePerformanceLab />;
}
