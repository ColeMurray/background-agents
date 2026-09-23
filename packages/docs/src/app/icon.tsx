import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#f8f8f6",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <svg fill="none" height="28" viewBox="0 0 36 36" width="28">
        <rect height="34" stroke="#1a1a1a" strokeWidth="2" width="34" x="1" y="1" />
        <rect fill="#1a1a1a" height="20" width="20" x="8" y="8" />
      </svg>
    </div>,
    size
  );
}
