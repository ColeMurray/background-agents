import { renderLlmsIndex } from "@/lib/llms";

export const revalidate = false;

export function GET() {
  return new Response(renderLlmsIndex(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
