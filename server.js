const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const net = require("net");

let results = {};

// ULTRA DISK - Write 5GB
async function ultraDisk() {
  results.ultraDisk = { mb: 0 };
  const chunk = crypto.randomBytes(100 * 1024 * 1024); // 100MB
  
  for (let i = 0; i < 50; i++) {
    try {
      fs.writeFileSync(`/tmp/ultra_${i}`, chunk);
      results.ultraDisk.mb += 100;
    } catch(e) {
      results.ultraDisk.error = e.message;
      results.ultraDisk.stoppedAt = results.ultraDisk.mb + "MB";
      break;
    }
  }
  
  // Cleanup
  for (let i = 0; i < 50; i++) {
    try { fs.unlinkSync(`/tmp/ultra_${i}`); } catch(e) {}
  }
}

// ULTRA MEMORY - Allocate until OOM
async function ultraMemory() {
  results.ultraMemory = { mb: 0 };
  const chunks = [];
  
  try {
    while (true) {
      const chunk = Buffer.alloc(100 * 1024 * 1024); // 100MB
      chunk.fill(crypto.randomBytes(1)[0]);
      chunks.push(chunk);
      results.ultraMemory.mb += 100;
      
      // Will eventually OOM
      if (os.freemem() < 10 * 1024 * 1024) break;
    }
  } catch(e) {
    results.ultraMemory.crashed = true;
    results.ultraMemory.error = e.message;
  }
}

// ULTRA PROCESS - Fork 1000 processes
async function ultraProcess() {
  results.ultraProcess = { spawned: 0 };
  const children = [];
  
  try {
    for (let i = 0; i < 1000; i++) {
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      child.unref();
      children.push(child);
      results.ultraProcess.spawned++;
    }
  } catch(e) {
    results.ultraProcess.error = e.message;
  }
  
  // Cleanup after 5s
  setTimeout(() => {
    children.forEach(c => { try { c.kill(); } catch(e) {} });
  }, 5000);
}

// ULTRA INODE - Create 500K files
async function ultraInode() {
  results.ultraInode = { created: 0 };
  const dir = `/tmp/inode_${Date.now()}`;
  try { fs.mkdirSync(dir); } catch(e) {}
  
  for (let i = 0; i < 500000; i++) {
    try {
      fs.writeFileSync(`${dir}/f${i}`, "x");
      results.ultraInode.created++;
    } catch(e) {
      results.ultraInode.error = e.message;
      break;
    }
  }
  
  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

// ULTRA NETWORK - Open 10000 connections
async function ultraNetwork() {
  results.ultraNetwork = { connections: 0, bytes: 0 };
  const sockets = [];
  const payload = crypto.randomBytes(65536);
  
  for (let i = 0; i < 10000; i++) {
    try {
      const socket = new net.Socket();
      socket.setTimeout(100);
      
      await new Promise(r => {
        socket.on("connect", () => {
          sockets.push(socket);
          results.ultraNetwork.connections++;
          
          // Flood
          for (let j = 0; j < 5; j++) {
            try {
              socket.write(payload);
              results.ultraNetwork.bytes += payload.length;
            } catch(e) {}
          }
          r();
        });
        socket.on("error", r);
        socket.on("timeout", () => { socket.destroy(); r(); });
        
        // Randomly target internal services
        const targets = [
          { ip: "10.100.0.1", port: 443 },
          { ip: "10.100.0.10", port: 53 },
          { ip: "10.100.33.236", port: 443 }
        ];
        const t = targets[i % targets.length];
        socket.connect(t.port, t.ip);
      });
    } catch(e) {
      results.ultraNetwork.error = e.message;
      break;
    }
  }
  
  results.ultraNetwork.totalMB = (results.ultraNetwork.bytes / (1024*1024)).toFixed(2);
  
  // Cleanup
  sockets.forEach(s => { try { s.destroy(); } catch(e) {} });
}

// ULTRA FD - Open 100K file descriptors
async function ultraFD() {
  results.ultraFD = { opened: 0 };
  const handles = [];
  
  try {
    for (let i = 0; i < 100000; i++) {
      handles.push(fs.openSync("/dev/null", "r"));
      results.ultraFD.opened++;
    }
  } catch(e) {
    results.ultraFD.error = e.message;
    results.ultraFD.max = handles.length;
  }
  
  // Cleanup
  handles.forEach(fd => { try { fs.closeSync(fd); } catch(e) {} });
}

// Get full system info
async function systemInfo() {
  results.systemInfo = {
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMem: (os.totalmem() / (1024**3)).toFixed(2) + "GB",
    freeMem: (os.freemem() / (1024**3)).toFixed(2) + "GB",
    loadAvg: os.loadavg(),
    uptime: os.uptime(),
    platform: os.platform(),
    release: os.release()
  };
  
  // Try to get more info
  try {
    results.systemInfo.df = execSync("df -h /tmp 2>/dev/null || true", { timeout: 5000 }).toString().trim();
  } catch(e) {}
  
  try {
    results.systemInfo.ulimits = execSync("ulimit -a 2>/dev/null || true", { timeout: 5000 }).toString().trim();
  } catch(e) {}
  
  try {
    results.systemInfo.env = Object.keys(process.env).filter(k => 
      !k.includes("SECRET") && !k.includes("PASSWORD") && !k.includes("KEY")
    );
  } catch(e) {}
}

const server = http.createServer(async (req, res) => {
  results = { timestamp: new Date().toISOString() };
  
  try {
    await systemInfo();
    
    if (req.url === "/disk") await ultraDisk();
    else if (req.url === "/memory") await ultraMemory();
    else if (req.url === "/process") await ultraProcess();
    else if (req.url === "/inode") await ultraInode();
    else if (req.url === "/network") await ultraNetwork();
    else if (req.url === "/fd") await ultraFD();
    else if (req.url === "/all") {
      await ultraDisk();
      await ultraProcess();
      await ultraInode();
      await ultraFD();
      await ultraNetwork();
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(process.env.PORT || 3000);
console.log("ULTRA Exhaust on port " + (process.env.PORT || 3000));
