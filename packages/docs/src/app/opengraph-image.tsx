import { ImageResponse } from "next/og";

export const alt = "Background Agents documentation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#f8f8f6",
        color: "#1a1a1a",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        padding: "80px",
        width: "100%",
      }}
    >
      <div
        style={{
          border: "2px solid rgba(26, 26, 26, 0.12)",
          display: "flex",
          flexDirection: "column",
          gap: "34px",
          padding: "68px",
          width: "100%",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: "20px", fontSize: 30 }}>
          <div
            style={{
              alignItems: "center",
              background: "#1a1a1a",
              color: "white",
              display: "flex",
              fontSize: 24,
              fontWeight: 700,
              height: 58,
              justifyContent: "center",
              width: 58,
            }}
          >
            BA
          </div>
          Background Agents
        </div>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 600, letterSpacing: "-3px" }}>
          Documentation
        </div>
        <div style={{ color: "#666", display: "flex", fontSize: 32 }}>
          Delegate, monitor, review, and operate background coding agents.
        </div>
      </div>
    </div>,
    size
  );
}
