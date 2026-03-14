const { Server } = require("socket.io");
const http = require("http");

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3001;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId) => {
    console.log(`User ${socket.id} joining room: ${roomId}`);
    socket.join(roomId);

    // Notify others in the room
    socket.to(roomId).emit("user-joined", socket.id);
  });

  socket.on("signal", ({ roomId, data }) => {
    // Relay signaling data (SDP, ICE candidates) to others in the room
    console.log(`Relaying signal from ${socket.id} in room ${roomId}`);
    socket.to(roomId).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
