import { renderMermaid } from "./mermaid-svg-renderer";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || event.ports.length !== 1) return;
  const request = event.data;
  if (
    typeof request !== "object" ||
    request === null ||
    !("source" in request) ||
    typeof request.source !== "string" ||
    !("dark" in request) ||
    typeof request.dark !== "boolean"
  )
    return;

  const port = event.ports[0];
  void renderMermaid(request.source, request.dark).then((image) => {
    port.postMessage(image);
    port.close();
  });
});
