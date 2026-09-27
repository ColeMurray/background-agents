import { ImageResponse } from "next/og";

import { LogoMark } from "@/components/logo";
import { brand } from "@/lib/brand";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: brand.light.background,
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <LogoMark color={brand.light.foreground} size={28} />
    </div>,
    size
  );
}
