// For tests: repositories served over http on this PC, behind a login, the way GitHub is.
// Real git talks to it (git's own http-backend), so a refused login fails just as it does
// against GitHub. Prints its port, then runs until killed.
//   node git-http-server.mjs <folder holding the bare repositories> <user> <password> [file]
// While the file exists the login can read but not upload, as with read-only access on GitHub.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const [root, user, password, readOnly] = process.argv.slice(2);
const backend = path.join(spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim(), "git-http-backend");
const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (readOnly && fs.existsSync(readOnly) && (url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack")) {
    res.writeHead(403);
    res.end();
    return;
  }
  const cgi = spawn(backend, [], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      REMOTE_USER: user,
    },
    windowsHide: true,
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on("data", (d) => {
    if (sent) return res.write(d);
    head = Buffer.concat([head, d]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
    sent = true;
  });
  cgi.on("close", () => res.end());
  cgi.on("error", () => res.destroy());
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
