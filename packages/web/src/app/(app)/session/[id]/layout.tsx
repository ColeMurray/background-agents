import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { getSessionBootstrap, SessionBootstrapError } from "@/lib/session-bootstrap";
import SessionLoading from "./loading";
import { SessionBootstrapProvider } from "./session-bootstrap-provider";

export default function SessionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<SessionLoading />}>
      <SessionBootstrapBoundary params={params}>{children}</SessionBootstrapBoundary>
    </Suspense>
  );
}

async function SessionBootstrapBoundary({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  try {
    const bootstrap = await getSessionBootstrap(id);
    return (
      <SessionBootstrapProvider key={id} bootstrap={bootstrap}>
        {children}
      </SessionBootstrapProvider>
    );
  } catch (error) {
    if (error instanceof SessionBootstrapError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }
}
