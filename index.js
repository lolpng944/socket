const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const rooms = new Map();
let nextPlayerId = 1;

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

function broadcast(room, message) {
  for (const [playerId, player] of room.players) {
    player.ws.send(JSON.stringify({ ...message, playerId }));
  }
}

const playerspeed = 2;
const movementInterval = 10;

wss.on('connection', (ws, req) => {
  const token = req.url.slice(1);

  joinRoom(ws, token)
    .then((result) => {
      if (result) {
        console.log('Joined room:', result);

        let lastMovementTime = Date.now();

        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            if (data.type === 'movement' && ['left', 'right', 'up', 'down'].includes(data.direction)) {
              const currentTime = Date.now();

              // Check if enough time has passed since the last movement
              if (currentTime - lastMovementTime >= movementInterval) {
                const player = result.room.players.get(result.playerId);
                if (player) {
                  // Update the player's position on the server side
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

                  // Save the previous position for reconciliation
                  player.prevX = player.x - (data.direction === 'left' ? playerspeed : data.direction === 'right' ? -playerspeed : 0);
                  player.prevY = player.y - (data.direction === 'up' ? playerspeed : data.direction === 'down' ? -playerspeed : 0);

                  // Update the last movement time
                  lastMovementTime = currentTime;

                  // Send the movement to other players
                  broadcast(result.room, {
                    type: 'movement',
                    playerId: result.playerId,
                    x: player.x,
                    y: player.y,
                  });
                }
              }
            }
          } catch (error) {
            console.error('Error parsing message:', error);
          }
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
