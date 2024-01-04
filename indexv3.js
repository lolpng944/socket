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
const WORLD_WIDTH = 800; // Set the desired width of the world
const WORLD_HEIGHT = 600; // Set the desired height of the world
const playerspeed = 8;
const inputThrottleInterval = 20;

const MAX_PLAYERS_PER_ROOM = 5; // Set the desired maximum players per room

function createRoom(roomId) {
  const room = {
    players: new Map(),
  };
  rooms.set(roomId, room);
  return room;
}

async function joinRoom(ws, token) {
  return new Promise(async (resolve, reject) => {
    try {
      const expectedOrigin = 'tw-editor://.';
      const response = await axios.get(`https://a.nxjxvxgy.repl.co/verify-token/${token}`, {
        headers: {
          Origin: expectedOrigin,
        },
      });

      let roomId;
      let room;

      if (response.data.message) {
        for (const [id, currentRoom] of rooms) {
          if (currentRoom.players.size < MAX_PLAYERS_PER_ROOM) {
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

function broadcastPlayerList(room, playerId) {
  const playerList = Array.from(room.players, ([id, player]) => ({
    playerId: id,
    x: player.x,
    y: player.y,
  }));
  room.players.forEach((p, id) => {
    p.ws.send(JSON.stringify({ type: 'playerList', playerList, playerId }));
  });
}

function broadcast(room, message, playerId) {
  const player = room.players.get(playerId);
  if (player) {
    const playerData = Array.from(room.players, ([id, p]) => ({
      playerId: id,
      x: p.x,
      y: p.y,
    }));

    player.ws.send(JSON.stringify({ ...message, playerData }));
  }
}

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

          const handleRequest = (result, message, lastTimestamp) => {
            try {
              const data = JSON.parse(message);
              if (data.type === 'movement' && ['left', 'right', 'up', 'down'].includes(data.direction)) {
                const player = result.room.players.get(result.playerId);
                if (player) {
                  const currentTimestamp = Date.now();
                  const dt = (currentTimestamp - lastTimestamp) / 1000; // Convert to seconds

                  if (currentTimestamp - lastProcessedTimestamps[data.direction] > inputThrottleInterval) {
                    switch (data.direction) {
                      case 'left':
                        player.x -= playerspeed * dt;
                        break;
                      case 'right':
                        player.x += playerspeed * dt;
                        break;
                      case 'up':
                        player.y -= playerspeed * dt;
                        break;
                      case 'down':
                        player.y += playerspeed * dt;
                        break;
                    }

                    player.x = Math.max(-WORLD_WIDTH, Math.min(WORLD_WIDTH, player.x));
                    player.y = Math.max(-WORLD_HEIGHT, Math.min(WORLD_HEIGHT, player.y));

                    player.prevX = player.x - (data.direction === 'left' ? playerspeed * dt : data.direction === 'right' ? -playerspeed * dt : 0);
                    player.prevY = player.y - (data.direction === 'up' ? playerspeed * dt : data.direction === 'down' ? -playerspeed * dt : 0);

                    broadcast(result.room, {
                      type: 'movement',
                      x: player.x,
                      y: player.y,
                    }, result.playerId);

                    lastProcessedTimestamps[data.direction] = currentTimestamp;
                  }
                }
              }
            } catch (error) {
              console.error('Error parsing message:', error);
            }
          };

          let lastTimestamp = Date.now();

          ws.on('message', (message) => {
            handleRequest(result, message, lastTimestamp);
            lastTimestamp = Date.now();
          });

          ws.on('close', () => {
            result.room.players.delete(result.playerId);

            if (result.room.players.size === 0) {
              console.log('Last player left. Resetting the game or declaring a winner.');
              // Reset the game or declare a winner
            } else {
              broadcastPlayerList(result.room, result.playerId);
            }
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
