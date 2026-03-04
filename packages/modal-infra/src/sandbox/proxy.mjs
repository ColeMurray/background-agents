import http from "node:http";
import { URL } from "node:url";

const ROUTES = {
  "/opencode":    { target: `http://localhost:${process.env.OPENCODE_PORT || 4096}`, strip: "/opencode" },
  "/terminal":    { target: `http://localhost:7681`, strip: "/terminal" },
  "/browser":     { target: `http://localhost:9222`, strip: "/browser" },
  "/jaeger":      { target: `http://localhost:16686`, strip: "/jaeger" },
  "/redpanda":    { target: `http://localhost:8080`, strip: "/redpanda" },
  "/rabbitmq":    { target: `http://localhost:15672`, strip: "/rabbitmq" },
  "/maildev":     { target: `http://localhost:1080`, strip: "/maildev" },
  "/minio":       { target: `http://localhost:9001`, strip: "/minio" },
  "/prometheus":  { target: `http://localhost:9090`, strip: "/prometheus" },
};

function findRoute(pathname) {
  for (const [prefix, config] of Object.entries(ROUTES)) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return config;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sandboxId: process.env.SANDBOX_ID }));
    return;
  }

  const route = findRoute(url.pathname);
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const targetPath = url.pathname.slice(route.strip.length) || "/";
  const targetUrl = route.target + targetPath + url.search;

  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: new URL(route.target).host },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream error", message: err.message }));
  });

  req.pipe(proxyReq);
});

// WebSocket upgrade support
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost`);
  const route = findRoute(url.pathname);
  if (!route) { socket.destroy(); return; }

  const targetPath = url.pathname.slice(route.strip.length) || "/";
  const targetUrl = new URL(route.target + targetPath + url.search);

  const proxyReq = http.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: targetUrl.pathname + targetUrl.search,
    method: "GET",
    headers: { ...req.headers, host: targetUrl.host },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      Object.entries(proxyRes.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n") +
      "\r\n\r\n"
    );
    if (proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", () => socket.destroy());
  proxyReq.end();
});

const PORT = parseInt(process.env.PROXY_PORT || "3000");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[reverse-proxy] Listening on :${PORT}`);
});
