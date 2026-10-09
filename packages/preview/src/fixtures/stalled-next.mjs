// Deliberately stuck web child for the stack owner's cancellation regression.
import { createServer } from "node:http";

console.log(`owned-child ${process.pid}`);
createServer((request, response) => {
  if (request.url === "/api/auth/get-session") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ user: { id: "test-member" } }));
    return;
  }
  console.log(`stalled ${request.url}`);
  // Keep this request open until the coordinator cancels and stops this child.
}).listen(Number(process.argv.at(-1)), "127.0.0.1");
