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
    player.ws.send(JSON.stringify({ ...message, playerId }));
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

          const handleRequest = (result, message) => {
            try {
              const data = JSON.parse(message);
              if (data.type === 'movement' && ['left', 'right', 'up', 'down'].includes(data.direction)) {
                const player = result.room.players.get(result.playerId);
                if (player) {
                  const currentTimestamp = Date.now();

                  // Prüfen, ob das Zeitintervall für die nächste Anfrage abgelaufen ist
                  if (currentTimestamp - lastProcessedTimestamps[data.direction] > inputThrottleInterval) {
                    // Update player position based on the movement direction
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

                    // Ensure the player stays within the world boundaries
                    player.x = Math.max(-WORLD_WIDTH, Math.min(WORLD_WIDTH, player.x));
                    player.y = Math.max(-WORLD_HEIGHT, Math.min(WORLD_HEIGHT, player.y));

                    // Update previous positions
                    player.prevX = player.x - (data.direction === 'left' ? playerspeed : data.direction === 'right' ? -playerspeed : 0);
                    player.prevY = player.y - (data.direction === 'up' ? playerspeed : data.direction === 'down' ? -playerspeed : 0);

                    // Broadcast the updated position to other players in the room
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
