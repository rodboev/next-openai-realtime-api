const fs = require("fs");
const path = require("path");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createHttpsServer } = require("node:https");
const { parse } = require("node:url");
const next = require("next");
const { WebSocketServer } = require("ws");
const mkcert = require("mkcert");
require("dotenv").config();

const hostname = "localhost";
const port = process.env.PORT || 3000;

let httpServer;
let isHttps = false;

async function createSSLCerts() {
  try {
    const ca = await mkcert.createCA({
      organization: "Development CA",
      countryCode: "US",
      state: "California",
      locality: "San Francisco",
      validityDays: 365,
    });

    const cert = await mkcert.createCert({
      ca: { key: ca.key, cert: ca.cert },
      domains: ["127.0.0.1", "localhost"],
      validity: 365,
    });
    return { key: cert.key, cert: cert.cert };
  } catch (error) {
    console.error("Error creating SSL certificates:", error);
    process.exit(1);
  }
}

const webSocketServer = new WebSocketServer({ noServer: true });

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, hostname, port, customServer: true });
const handle = app.getRequestHandler();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error(`Environment variable "OPENAI_API_KEY" is missing.`);
}

let connectedClients = 0;

const log = (...args) => console.log("[RealtimeRelay]", ...args);

const handleWebSocketConnection = async (ws) => {
  connectedClients++;
  log(`New WebSocket connection established. Total clients: ${connectedClients}`);

  let RealtimeClient;
  try {
    const realtimeModule = await import("@openai/realtime-api-beta");
    RealtimeClient = realtimeModule.RealtimeClient;
  } catch (error) {
    log("Failed to import RealtimeClient:", error);
    ws.close();
    return;
  }

  log(`Connecting with key "${OPENAI_API_KEY.slice(0, 3)}..."`);
  const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

  // Relay: OpenAI Realtime API Event -> Browser Event
  client.realtime.on("server.*", (event) => {
    log(`Relaying "${event.type}" to Client: ${Object.keys(event).pop()}`);
    ws.send(JSON.stringify(event));
  });

  client.realtime.on("close", () => ws.close());

  // Relay: Browser Event -> OpenAI Realtime API Event
  const messageQueue = [];
  const messageHandler = async (data) => {
    try {
      const event = JSON.parse(data);
      log(`Relaying "${event.type}" to OpenAI`);
      await client.realtime.send(event.type, event);
    } catch (e) {
      console.error(e.message);
      log(`Error parsing event from client: ${data}`);
    }
  };

  ws.on("message", (data) => {
    if (!client.isConnected()) {
      messageQueue.push(data);
    } else {
      messageHandler(data);
    }
  });

  ws.on("close", () => {
    log("WebSocket connection closed");
    client.disconnect();
    connectedClients--;
  });

  try {
    log("Connecting to OpenAI...");
    await client.connect();
    log("Connected to OpenAI successfully!");
    while (messageQueue.length) {
      await messageHandler(messageQueue.shift());
    }
  } catch (e) {
    log(`Error connecting to OpenAI: ${e.message}`);
    ws.close();
    return;
  }
};

webSocketServer.on("connection", handleWebSocketConnection);
(async () => {
  await app.prepare();

  const httpsOptions = await createSSLCerts();
  httpServer = createHttpsServer(httpsOptions);
  isHttps = true;

  httpServer
    .on("request", async (req, res) => {
      const parsedUrl = parse(req.url, true);
      if (parsedUrl.pathname === "/api/ws") {
        // Handle the /api/ws request directly
        res.writeHead(200, { "Content-Type": "application/json" });
        const responseData = JSON.stringify({
          status: "available",
          count: connectedClients,
          port: port,
        });
        log("Sending response for /api/ws:", responseData);
        res.end(responseData);
      } else {
        // For all other routes, let Next.js handle the request
        await handle(req, res, parsedUrl);
      }
    })
    .on("upgrade", (req, socket, head) => {
      const { pathname } = parse(req.url);

      if (pathname === "/api/ws") {
        webSocketServer.handleUpgrade(req, socket, head, (ws) => {
          webSocketServer.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    })
    .listen(port, () => {
      const protocol = isHttps ? "https" : "http";
      console.log(` ▲ Ready on ${protocol}://${hostname}:${port}`);
    });
})().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
