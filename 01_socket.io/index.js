import express from 'express';
import { createServer } from 'node:http'; // node.js can act as a webserver and receive requests
import { fileURLToPath } from 'node:url'; // resolves file URL string / URL objects
import { dirname, join } from 'node:path'; // path.dirname() gets the folder of a given file path, path.join() combines multiple path segments 
import { Server } from 'socket.io';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// open the database file
const db = await open({
  filename: 'chat.db',
  driver: sqlite3.Database
});

// create our 'messages' table (you can ignore the 'client_offset' column for now)
await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
  );
`);
const app = express();
const server = createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {}, // in event of disconnection, this feature restores client's state (rooms they were in) and sends any missed events

}); // initialize a new instance of socket.io by passing the server (the HTTP server) object

const __dirname = dirname(fileURLToPath(import.meta.url)); // becomes /Users/jian/F2024 projects/tutorials/01_socket.io
// console.log(import.meta.url); => file:///Users/jian/F2024%20projects/tutorials/01_socket.io/index.js
console.log(__dirname);
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html')); // joins path segment 'index.html' to current directory => /Users/jian/F2024 projects/tutorials/01_socket.io/index.html
  /*
    res.sendFile is provided by express
    serves the html file to the user when GET request at http://localhost:3000/ is made
  */
});
io.on('connection', (socket) => { // listen for connections
  console.log('a user connected');
  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
  socket.on('chat message', async (msg, clientOffset, callback) => { // server receives msg from client
    let result;
    try {
      // store the message in the database
      result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
    } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */ ) {
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
    io.emit('chat message', msg, result.lastID);  }); // relays msg to clients

    // acknowledge the event, or else the client will keep retrying (up to retries times).
    callback();
});
if (!socket.recovered) { //  ?socket.recovered is provided by connectionStateRecovery
  /*
    If connectionStateRecovery succeeds, this segment will not need to run. 
    Otherwise, we fetch from db to get client their missed messages.
  */
  try {
    await db.each('SELECT id, content FROM messages WHERE id > ?',
      [socket.handshake.auth.serverOffset || 0],
      (_err, row) => {
        socket.emit('chat message', row.content, row.id); // works both after a temporary disconnection and a full page refresh
      }
    )
  } catch (e) {
    // something went wrong
  }
}
app.get('/', (req, res) => {
  res.send('<h1>Hello world</h1>');
});

server.listen(3000, () => {
  console.log('server running at http://localhost:3000');
});