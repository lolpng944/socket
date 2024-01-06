const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');
const Limiter = require('limiter').RateLimiter;

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const rooms = new Map();
let nextPlayerId = 1;

const rate = 1;
const burst = 5;
const tokenBucket = new Limiter({ tokensPerInterval: rate, interval: 'sec', maxBurst: burst });
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;
const playerspeed = 4;
const inputThrottleInterval = 20;

function createRoom(roomId) {
  const room = {
    players: new Map(),
  };
  rooms.set(roomId, room);
  generateRandomCoins(room); // Add this line to generate random coins when creating a room
  return room;
}

function handleCoinCollected(result, index) {
  const room = result.room;
  const playerId = result.playerId;

  // Remove the collected coin
  room.coins.splice(index, 1);
  broadcast(room, { type: 'coin_collected', coinIndex: index }, playerId);

  // Generate new coins
  generateRandomCoins(room);
}

function generateRandomCoins(room) {
  const coins = [];
  for (let i = 0; i < 3; i++) {
    const coin = {
      x: Math.floor(Math.random() * (WORLD_WIDTH * 2 + 1)) - WORLD_WIDTH,
      y: Math.floor(Math.random() * (WORLD_HEIGHT * 2 + 1)) - WORLD_HEIGHT,
    };
    coins.push(coin);
  }
  room.coins = coins;
  broadcast(room, { type: 'coins', coins });
}

async function joinRoom(ws, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = 'tw-editor://.';
      const response = await axios.get(`https://4gy7dw-3000.csb.app/verify-token/${token}`, {
        headers: {
          Origin: expectedOrigin,
        },
      });

      let roomId;
      let room;

      if (response.data.message) {
        for (const [id, currentRoom] of rooms) {
          if (currentRoom.players.size < 2) {
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
        room.players.set(playerId, { ws, x: 0, y: 0, prevX: 0, prevY: 0 });

        resolve({ roomId, playerId, room });
      } else {
        ws.close(4001, 'Invalid token');
        reject('Invalid token');
      }
    } catch (error) {
      console.error('Error verifying token:', error);
      ws.close(4000, 'Token verification error');
      reject('Token verification error');
    }
  });
}

function broadcast(room, message, playerId) {
  const player = room.players.get(playerId);
  if (player) {
    const broadcastMessage = {
      ...message,
      playerId,
      coins: room.coins, // Include the positions of the coins in the broadcast
    };
    player.ws.send(JSON.stringify(broadcastMessage));
  }
}

const lastProcessedTimestamps = {
  left: 0,
  right: 0,
  up: 0,
  down: 0,
};


const handleRequest = (result, message) => {
  try {
    const data = JSON.parse(message);
    if (data.type === 'movement' && ['left', 'right', 'up', 'down'].includes(data.direction)) {
      const player = result.room.players.get(result.playerId);
      if (player) {
        const currentTimestamp = Date.now();

        if (currentTimestamp - lastProcessedTimestamps[data.direction] > inputThrottleInterval) {
          switch (data.direction) {
            case 'left':
              player.x -= playerspeed;
              break;
            case 'right':
              player.x += playerspeed;
              break;
            case 'up':
              player.y -= playerspeed;
              break;
            case 'down':
              player.y += playerspeed;
              break;
          }

          player.x = Math.max(-WORLD_WIDTH, Math.min(WORLD_WIDTH, player.x));
          player.y = Math.max(-WORLD_HEIGHT, Math.min(WORLD_HEIGHT, player.y));

          player.prevX = player.x - (data.direction === 'left' ? playerspeed : data.direction === 'right' ? -playerspeed : 0);
          player.prevY = player.y - (data.direction === 'up' ? playerspeed : data.direction === 'down' ? -playerspeed : 0);

          broadcast(result.room, {
            type: 'movement',
            x: player.x,
            y: player.y,
          }, result.playerId);

          result.room.coins.forEach((coin, index) => {
            const coinHitboxSize = 20;
            if (
              player.x - playerspeed < coin.x + coinHitboxSize &&
              player.x + playerspeed > coin.x - coinHitboxSize &&
              player.y - playerspeed < coin.y + coinHitboxSize &&
              player.y + playerspeed > coin.y - coinHitboxSize
            ) {
              handleCoinCollected(result, index);
              result.room.coins.splice(index, 1);
              broadcast(result.room, { type: 'coin_collected', coinIndex: index }, result.playerId);

              axios.post('https://example.com/api/increase-coins', { playerId: result.playerId })
                .then(response => {
                  console.log('Coins increased successfully:', response.data);
                })
                .catch(error => {
                  console.error('Error increasing coins:', error);
                });
            }
          });

          lastProcessedTimestamps[data.direction] = currentTimestamp;
        }
      }
    }
  } catch (error) {
    console.error('Error parsing message:', error);
  }
};

wss.on('connection', (ws, req) => {
  const token = req.url.slice(1);

  if (tokenBucket.tryRemoveTokens(1)) {
    joinRoom(ws, token)
      .then((result) => {
        if (result) {
          console.log('Joined room:', result);

          const lastProcessedTimestamps = {
            left: 0,
            right: 0,
            up: 0,
            down: 0,
          };

          ws.on('message', (message) => {
            handleRequest(result, message);
          });

          ws.on('close', () => {
            result.room.players.delete(result.playerId);
          });
        } else {
          console.error('Failed to join room:', result);
        }
      })
      .catch((error) => {
        console.error('Error joining room:', error);
      });
  } else {
    console.log('Connection rate-limited. Too many connections in a short period.');
    ws.close(4002, 'Connection rate-limited. Too many connections in a short period.');
  }
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
