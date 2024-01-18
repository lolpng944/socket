const WebSocket = require("ws");
const http = require("http");
const axios = require("axios");
const Limiter = require("limiter").RateLimiter;

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const rooms = new Map();
let nextPlayerId = 1;

function createRateLimiter() {
  const rate = 1; // Allow one request every 50 milliseconds
  return new Limiter({
    tokensPerInterval: rate,
    interval: 25, // milliseconds
  });
}

const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;
const playerspeed = 0.5;
//const inputThrottleInterval = 20;

// Add a global variable to store batched messages
const batchedMessages = new Map();

// Function to add messages to the batch
function addToBatch(room, messages) {
  if (!batchedMessages.has(room)) {
    batchedMessages.set(room, []);
  }
  batchedMessages.get(room).push(...messages);
}

// Function to send batched messages
function sendBatchedMessages(room) {
  const messages = batchedMessages.get(room);
  if (messages && messages.length > 0) {
    const playerData = Array.from(room.players.values()).reduce(
      (acc, player) => {
        acc[player.playerId] = {
          x: player.x,
          y: player.y,
          direction: player.direction,
          hat: player.hat,
          top: player.top,
        };
        return acc;
      },
      {},
    );
    const broadcastMessage = {
      playerData,
      coins: room.coins,
    };
    room.players.forEach((player) => {
      player.ws.send(JSON.stringify(broadcastMessage));
    });
    batchedMessages.set(room, []); // Clear the batch after sending
  }
}

function createRoom(roomId) {
  const room = {
    players: new Map(),
  };
  rooms.set(roomId, room);
  generateRandomCoins(room);
  return room;
}

function handleCoinCollected(result, index) {
  const room = result.room;
  const playerId = result.playerId;
  const player = room.players.get(playerId);

  room.coins.splice(index, 1);

  const expectedOrigin = "tw-editor://."; // Adjust this to your actual expected origin

  // Make an asynchronous Axios request to increase coins for the player
  axios
    .post(
      `https://4gy7dw-3000.csb.app/increasecoins-lqemfindegiejgkdmdmvu/${playerId}`,
      null,
      {
        headers: {
          Origin: expectedOrigin,
        },
      },
    )
    .then(() => {
      console.log(`Coins increased for player ${playerId}`);
    })
    .catch((error) => {
      console.error("Error increasing coins:", error);
    });

  // Broadcast player position and new coins to all players
  const messages = Array.from(room.players.keys()).map((playerId) => ({
    type: "movement",
    x: room.players.get(playerId).x,
    y: room.players.get(playerId).y,
    playerId: playerId,
    direction: room.players.get(playerId).direction,
    hat: room.players.get(playerId).hat,
    top: room.players.get(playerId).top,
  }));
  messages.push({ type: "coins", coins: room.coins });
  messages.push({ type: "coin_collected", coinIndex: index }, playerId);
  addToBatch(room, messages);
  generateRandomCoins(room);
}

function generateRandomCoins(room) {
  const coins = [];
  for (let i = 0; i < 1; i++) {
    const coin = {
      x: Math.floor(Math.random() * (WORLD_WIDTH * 2 + 1)) - WORLD_WIDTH,
      y: Math.floor(Math.random() * (WORLD_HEIGHT * 2 + 1)) - WORLD_HEIGHT,
    };
    coins.push(coin);
  }
  room.coins = coins;

  // Broadcast player positions and new coins to all players
  const messages = [
    ...Array.from(room.players.keys()).map((playerId) => ({
      type: "movement",
      x: room.players.get(playerId).x,
      y: room.players.get(playerId).y,
      playerId: playerId,
      direction: room.players.get(playerId).direction,
      hat: room.players.get(playerId).hat,
      top: room.players.get(playerId).top,
    })),
    { type: "coins", coins: room.coins },
  ];

  addToBatch(room, messages);
}

async function joinRoom(ws, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = "tw-editor://.";
      const response = await axios.get(
        `https://4gy7dw-3000.csb.app/verify-token/${token}`,
        {
          headers: {
            Origin: expectedOrigin,
          },
        },
      );

      let roomId;
      let room;

      if (response.data.message) {
        for (const [id, currentRoom] of rooms) {
          if (currentRoom.players.size < 4) {
            roomId = id;
            room = currentRoom;
            break;
          }
        }

        if (!roomId) {
          roomId = `room_${rooms.size + 1}`;
          room = createRoom(roomId);
        }

        const playerId = response.data.message;
        const hat = response.data.hat;
        const top = response.data.top;
        const playerRateLimiter = createRateLimiter(); // Create a rate limiter for each player
        room.players.set(playerId, {
          ws,
          x: 0,
          y: 0,
          direction: null,
          prevX: 0,
          prevY: 0,
          lastProcessedPosition: 0,
          playerId: playerId,
          rateLimiter: playerRateLimiter,
          hat: hat,
          top: top,
        });

        resolve({ roomId, playerId, room });
      } else {
        ws.close(4001, "Invalid token");
        reject("Invalid token");
      }
    } catch (error) {
      console.error("Error verifying token:", error);
      ws.close(4000, "Token verification error");
      reject("Token verification error");
    }
  });
}

function broadcastPlayerPositions(room) {
  const playerPositions = Array.from(room.players.entries()).reduce(
    (acc, [playerId, player]) => {
      acc[playerId] = { x: player.x, y: player.y, direction: player.direction };
      return acc;
    },
    {},
  );

  const message = {
    type: "update",
    playerData: playerPositions,
    coins: room.coins,
  };

  room.players.forEach((player) => {
    player.ws.send(JSON.stringify(message));
  });
}

function addToBatch(room, messages) {
  if (!batchedMessages.has(room)) {
    batchedMessages.set(room, []);
  }
  batchedMessages.get(room).push(...messages);
}

function handleRequest(result, message) {
  try {
    const data = JSON.parse(message);
    if (data.type === "movement" && typeof data.direction === "number") {
      // Ensure the direction is within the range of -180 to 180 degrees
      const validDirection =
        data.direction >= -180 && data.direction <= 180 ? data.direction : NaN;

      if (!isNaN(validDirection)) {
        const player = result.room.players.get(result.playerId);
        if (player) {
          // Calculate delta time only when the player changes position
          const deltaTime = player.lastProcessedPosition !== undefined ? 20 : 0;

          player.direction = validDirection > 0 ? 90 : -90;

          // Adjust the direction so that right is 90, left is -90, up is 0, and down is 180
          const finalDirection = validDirection - 90;

          // Calculate the x and y components based on the adjusted direction angle
          const radians = (finalDirection * Math.PI) / 180;
          const xDelta = playerspeed * deltaTime * Math.cos(radians);
          const yDelta = playerspeed * deltaTime * Math.sin(radians);

          // Update player position based on the calculated deltas
          player.x = Math.round(player.x + xDelta);
          player.y = Math.round(player.y + yDelta);

          // Check if the player is within the radius of any coin
          const collectedCoins = [];
          result.room.coins.forEach((coin, index) => {
            const distance = Math.sqrt(
              Math.pow(player.x - coin.x, 2) + Math.pow(player.y - coin.y, 2),
            );

            if (distance <= 60) {
              // Player is within the radius of the coin
              collectedCoins.push(index);
            }
          });

          // Process collected coins
          if (collectedCoins.length > 0) {
            collectedCoins.forEach((index) => {
              handleCoinCollected(result, index);
            });
          }

          player.x = Math.max(-WORLD_WIDTH, Math.min(WORLD_WIDTH, player.x));
          player.y = Math.max(-WORLD_HEIGHT, Math.min(WORLD_HEIGHT, player.y));

          // Broadcast player positions and new coins in a single message
          const messages = Array.from(result.room.players.keys()).map(
            (playerId) => ({
              type: "movement",
              x: result.room.players.get(playerId).x,
              y: result.room.players.get(playerId).y,
              playerId: playerId,
              direction: player.direction,
              hat: player.hat,
              top: player.top,
            }),
          );
          messages.push({ type: "coins", coins: result.room.coins });

          addToBatch(result.room, messages);

          player.lastProcessedPosition = { x: player.x, y: player.y };
        }
      } else {
        console.warn("Invalid direction value:", data.direction);
      }
    }
  } catch (error) {
    console.error("Error parsing message:", error);
  }
}

wss.on("connection", (ws, req) => {
  const token = req.url.slice(1);

  joinRoom(ws, token)
    .then((result) => {
      if (result) {
        console.log("Joined room:", result);

        ws.on("message", (message) => {
          // Check the rate limit before processing the message
          if (result.room.players.has(result.playerId)) {
            const player = result.room.players.get(result.playerId);
            if (player.rateLimiter.tryRemoveTokens(1)) {
              handleRequest(result, message);
            }
          } else {
            console.log("Player not found in the room.");
          }
        });

        ws.on("close", () => {
          result.room.players.delete(result.playerId);
        });
      } else {
        console.error("Failed to join room:", result);
      }
    })
    .catch((error) => {
      console.error("Error joining room:", error);
    });
});

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});

// Use setInterval to send batched messages at regular intervals
setInterval(() => {
  rooms.forEach((room) => {
    sendBatchedMessages(room);
  });
}, 25); // 20 milliseconds (adjust as needed)
