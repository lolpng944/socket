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

const moveInterval = 10; // 10 milliseconds
const playerspeed = 8;

function updatePlayerPosition(player, direction) {
  switch (direction) {
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
}

wss.on('connection', (ws, req) => {
  const token = req.url.slice(1);

  joinRoom(ws, token)
    .then((result) => {
      if (result) {
        console.log('Joined room:', result);

        // Accumulate movements for each player
        const movements = new Map();

        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            if (data.type === 'movement' && ['left', 'right', 'up', 'down'].includes(data.direction)) {
              const playerId = result.playerId;

              if (!movements.has(playerId)) {
                movements.set(playerId, []);
              }

              movements.get(playerId).push(data.direction);
            }
          } catch (error) {
            console.error('Error parsing message:', error);
          }
        });

        setInterval(() => {
          if (canMove(result.room)) {
            // Process accumulated movements for all players
            movements.forEach((directions, playerId) => {
              const player = result.room.players.get(playerId);

              if (player) {
                // Update the player's position based on accumulated movements
                directions.forEach((direction) => {
                  updatePlayerPosition(player, direction);
                });

                // Save the previous position for reconciliation
                player.prevX = player.x;
                player.prevY = player.y;

                // Send the movement to other players
                broadcast(result.room, {
                  type: 'movement',
                  playerId,
                  x: player.x,
                  y: player.y,
                });
              }
            });

            // Clear accumulated movements
            movements.clear();
          }
        }, moveInterval);

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
