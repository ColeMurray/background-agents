import { notFound, redirect } from "next/navigation";
import { getSessionBootstrap, SessionBootstrapError } from "@/lib/session-bootstrap";
import { SessionClient } from "./session-client";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const bootstrap = await getSessionBootstrap(id);
    return <SessionClient key={id} sessionId={id} initialBootstrap={bootstrap} />;
  } catch (error) {
    if (error instanceof SessionBootstrapError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }
}
