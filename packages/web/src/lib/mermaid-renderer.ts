// Lazy client entry. Mermaid itself only executes in the opaque-origin iframe.
import {
  MAX_MERMAID_SOURCE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  isMermaidImage,
  type MermaidImage,
} from "./mermaid-renderer-protocol";

export type { MermaidImage } from "./mermaid-renderer-protocol";

let frame: HTMLIFrameElement | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();

export function renderMermaid(source: string, dark: boolean): Promise<MermaidImage | null> {
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) return Promise.resolve(null);

  const result = renderQueue.then(
    () =>
      new Promise<MermaidImage | null>((resolve) => {
        const current = frame ?? document.createElement("iframe");
        const channel = new MessageChannel();
        let settled = false;
        const finish = (image: MermaidImage | null, reset = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          current.removeEventListener("load", send);
          current.removeEventListener("error", fail);
          channel.port1.close();
          channel.port2.close();
          if (reset) {
            current.remove();
            frame = undefined;
          }
          resolve(image);
        };
        const fail = () => finish(null, true);
        const send = () => {
          frame = current;
          // An opaque-origin receiver requires "*". Replies use this private port,
          // not a global message listener that another frame could spoof.
          try {
            if (!current.contentWindow) return fail();
            current.contentWindow.postMessage({ source, dark }, "*", [channel.port2]);
          } catch {
            fail();
          }
        };
        const timer = setTimeout(fail, MERMAID_RENDER_TIMEOUT_MS);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          finish(isMermaidImage(event.data) ? event.data : null);
        };
        channel.port1.onmessageerror = fail;

        if (frame) {
          send();
        } else {
          current.setAttribute("sandbox", "allow-scripts");
          current.setAttribute("aria-hidden", "true");
          current.tabIndex = -1;
          current.referrerPolicy = "no-referrer";
          current.title = "Isolated diagram renderer";
          current.style.cssText =
            "position:fixed;left:-100000px;top:0;width:1000px;height:800px;visibility:hidden;pointer-events:none";
          current.addEventListener("load", send, { once: true });
          current.addEventListener("error", fail, { once: true });
          current.src = "/mermaid-renderer.html";
          document.body.append(current);
        }
      })
  );
  const safeResult = result.catch(() => {
    frame?.remove();
    frame = undefined;
    return null;
  });
  renderQueue = safeResult;
  return safeResult;
}
