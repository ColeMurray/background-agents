import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";

import { LogoMark } from "@/components/logo";
import { borderAlpha, brand, withAlpha } from "@/lib/brand";
import { socialCard, socialCardSize } from "@/lib/social-card";
import { source } from "@/lib/source";

type SocialCardRouteContext = {
  params: Promise<{ slug: string[] }>;
};

const {
  background,
  foreground: ink,
  mutedForeground: muted,
  accentForeground: accent,
} = brand.light;

export const revalidate = false;

export async function GET(_request: Request, { params }: SocialCardRouteContext) {
  const { slug } = await params;
  if (slug.at(-1) !== "image.png") notFound();

  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const card = socialCard(page, source.getPageTree());

  return new ImageResponse(
    <div
      style={{
        background,
        color: ink,
        display: "flex",
        height: "100%",
        padding: "48px",
        width: "100%",
      }}
    >
      <div
        style={{
          border: `2px solid ${withAlpha(ink, borderAlpha)}`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "52px 64px",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexShrink: 0,
            fontSize: 30,
            gap: "20px",
          }}
        >
          <LogoMark color={ink} size={52} />
          OpenInspect
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          {card.section ? (
            <div style={{ color: accent, display: "flex", fontSize: 24 }}>{card.section}</div>
          ) : null}
          <div
            style={{
              display: "block",
              fontSize: 56,
              fontWeight: 600,
              letterSpacing: "-1px",
              lineClamp: 2,
              lineHeight: 1.1,
            }}
          >
            {card.title}
          </div>
          <div
            style={{
              color: muted,
              display: "block",
              fontSize: 26,
              lineClamp: 3,
              lineHeight: 1.4,
            }}
          >
            {card.description}
          </div>
        </div>
      </div>
    </div>,
    socialCardSize
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: [...page.slugs, "image.png"],
  }));
}
