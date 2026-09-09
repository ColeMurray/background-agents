import type { ReactNode } from "react";

export function IntegrationSettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h3 className="text-base font-semibold text-foreground mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

export function IntegrationSettingsMessage({
  tone,
  text,
}: {
  tone: "error" | "success";
  text: string;
}) {
  return (
    <div
      className={`mb-4 rounded-sm border px-4 py-3 text-sm ${
        tone === "error"
          ? "border-destructive/20 bg-destructive-muted text-destructive"
          : "border-success/20 bg-success-muted text-success"
      }`}
    >
      {text}
    </div>
  );
}
