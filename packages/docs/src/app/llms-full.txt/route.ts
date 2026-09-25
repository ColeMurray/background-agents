import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  const content = await Promise.all(source.getPages().map(getLLMText));

  return new Response(content.join("\n\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
