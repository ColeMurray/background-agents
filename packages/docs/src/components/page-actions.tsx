type PageActionsProps = {
  markdownUrl: string;
  title: string;
};

export function PageActions({ markdownUrl, title }: PageActionsProps) {
  const issueUrl = new URL("https://github.com/ColeMurray/background-agents/issues/new");
  issueUrl.searchParams.set("title", `Docs feedback: ${title}`);
  issueUrl.searchParams.set("labels", "documentation");

  return (
    <div className="mb-8 flex flex-wrap gap-4 border-b border-fd-border pb-5 text-sm text-fd-muted-foreground">
      <a className="hover:text-fd-foreground" href={markdownUrl}>
        View as Markdown
      </a>
      <a
        className="hover:text-fd-foreground"
        href={issueUrl.toString()}
        rel="noreferrer"
        target="_blank"
      >
        Give feedback
      </a>
    </div>
  );
}
