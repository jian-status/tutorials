import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }
  // set up the adapter on the primary thread
  setupPrimary();
} else {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);
  const port = process.env.PORT;

  const app = express(); // each worker will listen on a distinct port
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {}, // in event of disconnection, this feature restores client's state (rooms they were in) and sends any missed events
    adapter: createAdapter(), // set up the adapter on each worker thread
  }); // initialize a new instance of socket.io by passing the server (the HTTP server) object

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // console.log(import.meta.url); => file:///Users/jian/F2024%20projects/tutorials/01_socket.io/index.js

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });
  /*
    res.sendFile is provided by express
    serves the html file to the user when GET request at http://localhost:3000/ is made
  */         
  io.on("connection", async (socket) => { // listen for connections
    io.emit("chat message", `user connected on ${port}`);

    socket.on("disconnect", async () => {
      io.emit("chat message", `user disconnected on ${port}`);
    })
    socket.on("chat message", async (msg, clientOffset, callback) => { // server receives msg from client
      let result;
      try {
        // store the message in the database
        result = await db.run(
          "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
          `${port}: ` + msg,
          clientOffset
        );
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          /* 
            the message was already inserted, so we notify the client
            the UNIQUE constraint on the client_offset column prevents the duplication of the message
          */
          callback();
        } else {
          // nothing to do, just let the client retry
        }
        return;
      }
      // include the offset with the message
      io.emit("chat message", `${port}: ` + msg, result.lastID); // relays msg to clients
      callback(); // acknowledge the event, or else the client will keep retrying (up to retries times).

    });

    if (!socket.recovered) { //  ?socket.recovered is provided by connectionStateRecovery
      /*
        If connectionStateRecovery succeeds, this segment will not need to run. 
        Otherwise, we fetch from db to get client their missed messages.
      */
      try {
        await db.each(
          "SELECT id, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id); // works both after a temporary disconnection and a full page refresh
          }
        );
      } catch (e) {
        // something went wrong
      }
    }
  });

  server.listen(port, () => {  // each worker will listen on a distinct port
    console.log(`server running at http://localhost:${port}`);
  });
}
