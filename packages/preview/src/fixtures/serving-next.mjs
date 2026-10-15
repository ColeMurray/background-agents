// Web child that passes the stack owner's readiness and auth checks, for post-readiness regressions.
import { createServer } from "node:http";

console.log(`owned-child ${process.pid}`);
createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify(request.url === "/api/auth/get-session" ? { user: { id: "test-member" } } : {})
  );
}).listen(Number(process.argv.at(-1)), "127.0.0.1");
