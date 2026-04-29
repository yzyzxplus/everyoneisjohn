const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getPublicState(room) {
  const players = {};
  for (const [id, p] of Object.entries(room.players)) {
    players[id] = {
      name: p.name,
      willpower: p.willpower,
      isGM: p.isGM,
      isActive: room.activeVoice === id,
      bidReady: p.bidReady,
      obsessionCount: p.obsessionCount,
      obsessionLevel: p.obsessionLevel,
      characterReady: p.characterReady,
      pendingApproval: p.pendingApproval || false,
    };
  }
  return {
    phase: room.phase,
    activeVoice: room.activeVoice,
    activeVoiceName: room.activeVoice ? room.players[room.activeVoice]?.name : null,
    players,
    bidsRevealed: room.bidsRevealed,
    revealedBids: room.bidsRevealed ? room.revealedBids : null,
    tieBreakPlayers: room.tieBreakPlayers || null,
  };
}

function broadcastState(code) {
  if (!rooms[code]) return;
  io.to(code).emit('room-state', getPublicState(rooms[code]));
}

function log(code, message, type = 'info') {
  io.to(code).emit('log', { message, type, ts: Date.now() });
}

function startControlTest(code, reason) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'bidding';
  room.bidsRevealed = false;
  room.revealedBids = null;
  room.tieBreakPlayers = null;

  for (const p of Object.values(room.players)) {
    p.bid = null;
    p.bidReady = false;
  }

  io.to(code).emit('control-test-started', { reason });
  log(code, `⚔️ Control test: ${reason}`, 'event');
  broadcastState(code);
}

function revealBids(code) {
  const room = rooms[code];
  if (!room) return;

  room.bidsRevealed = true;
  const bids = {};
  let highest = -1;
  let winners = [];

  for (const [id, p] of Object.entries(room.players)) {
    if (p.isGM) continue;
    const bid = p.bid ?? 0;
    bids[id] = { name: p.name, bid };
    if (bid > highest) { highest = bid; winners = [id]; }
    else if (bid === highest) winners.push(id);
  }

  room.revealedBids = bids;
  const bidSummary = Object.values(bids).map(b => `${b.name}: ${b.bid}`).join(', ');
  log(code, `🎲 Bids revealed — ${bidSummary}`, 'reveal');

  if (winners.length === 1) {
    const winnerId = winners[0];
    room.players[winnerId].willpower -= highest;
    room.activeVoice = winnerId;
    room.phase = 'playing';
    room.tieBreakPlayers = null;

    io.to(code).emit('bids-revealed', { bids, winners, highest, newActive: winnerId, tieBreak: false });
    log(code, `👑 ${room.players[winnerId].name} takes control of John (spent ${highest} willpower)`, 'active');
    broadcastState(code);
    checkGameOver(code);
  } else {
    room.phase = 'tiebreak';
    room.tieBreakPlayers = winners;
    const tieNames = winners.map(id => room.players[id].name).join(' & ');
    io.to(code).emit('bids-revealed', { bids, winners, highest, tieBreak: true });
    log(code, `🔁 Tie between ${tieNames} — roll off to break the tie!`, 'event');
    broadcastState(code);
  }
}

function checkGameOver(code) {
  const room = rooms[code];
  if (!room || room.phase === 'ended') return;
  const players = Object.values(room.players).filter(p => !p.isGM);
  if (players.length > 0 && players.every(p => p.willpower <= 0)) {
    room.phase = 'ended';
    room.activeVoice = null;
    log(code, '💀 All Voices are out of willpower. John sinks into sleep. Game over!', 'end');
    io.to(code).emit('game-over', { reason: 'willpower' });
    broadcastState(code);
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ gmName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      gmSocketId: socket.id,
      phase: 'lobby',
      activeVoice: null,
      bidsRevealed: false,
      revealedBids: null,
      tieBreakPlayers: null,
      players: {
        [socket.id]: {
          name: gmName,
          isGM: true,
          willpower: 0,
          skills: [],
          obsession: '',
          obsessionLevel: 0,
          obsessionCount: 0,
          bid: null,
          bidReady: false,
          characterReady: true,
        },
      },
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, playerId: socket.id });
    broadcastState(code);
    log(code, `🎭 Room ${code} created by GM: ${gmName}`, 'info');
  });

  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) return socket.emit('error', { message: 'Room not found. Check your code.' });
    if (room.phase !== 'lobby') return socket.emit('error', { message: 'Game already in progress.' });

    const codeUpper = code.toUpperCase();
    room.players[socket.id] = {
      name: playerName,
      isGM: false,
      willpower: 10,
      skills: [],
      obsession: '',
      obsessionLevel: 1,
      obsessionCount: 0,
      bid: null,
      bidReady: false,
      characterReady: false,
    };

    socket.join(codeUpper);
    socket.roomCode = codeUpper;
    socket.emit('room-joined', { code: codeUpper, playerId: socket.id });
    broadcastState(codeUpper);
    log(codeUpper, `👤 ${playerName} joined the room`, 'info');
  });

  socket.on('submit-character', ({ skills, obsession, obsessionLevel, willpowerStart }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || player.isGM) return;

    player.skills = skills.filter(s => s.trim());
    player.obsession = obsession;
    player.obsessionLevel = parseInt(obsessionLevel) || 1;
    player.willpower = parseInt(willpowerStart) || 10;
    player.characterReady = false;
    player.pendingApproval = true;

    socket.emit('character-saved', { skills: player.skills, obsession, obsessionLevel: player.obsessionLevel, willpower: player.willpower });
    broadcastState(code);
    log(code, `📋 ${player.name} submitted their character — awaiting GM approval`, 'info');

    // Notify GM privately with character details
    io.to(room.gmSocketId).emit('gm-player-sheet', {
      playerId: socket.id,
      name: player.name,
      skills: player.skills,
      obsession: player.obsession,
      obsessionLevel: player.obsessionLevel,
      willpower: player.willpower,
    });
  });

  socket.on('approve-character', ({ playerId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;
    player.characterReady = true;
    player.pendingApproval = false;
    io.to(playerId).emit('character-approved');
    log(code, `✅ GM approved ${player.name}'s character`, 'info');
    broadcastState(code);
  });

  socket.on('reject-character', ({ playerId, reason }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;
    player.characterReady = false;
    player.pendingApproval = false;
    io.to(playerId).emit('character-rejected', { reason: reason || '' });
    log(code, `❌ GM rejected ${player.name}'s character${reason ? `: ${reason}` : ''}`, 'info');
    broadcastState(code);
  });

  socket.on('chat-message', ({ text }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const trimmed = (text || '').trim().slice(0, 200);
    if (!trimmed) return;
    io.to(code).emit('chat-message', { name: player.name, isGM: player.isGM, text: trimmed, ts: Date.now() });
  });

  socket.on('start-game', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;

    const readyPlayers = Object.values(room.players).filter(p => !p.isGM && p.characterReady);
    if (readyPlayers.length < 1) return socket.emit('error', { message: 'Need at least one player ready.' });

    room.phase = 'playing';
    io.to(code).emit('game-started');
    log(code, '🌅 The game begins. John wakes up...', 'event');
    broadcastState(code);

    setTimeout(() => startControlTest(code, 'John wakes up. Who takes control?'), 1000);
  });

  socket.on('trigger-control-test', ({ reason }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    startControlTest(code, reason || 'Control test triggered by GM');
  });

  socket.on('submit-bid', ({ amount }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'bidding') return;
    const player = room.players[socket.id];
    if (!player || player.isGM) return;

    const bid = Math.max(0, Math.min(parseInt(amount) || 0, player.willpower));
    player.bid = bid;
    player.bidReady = true;

    socket.emit('bid-submitted', { amount: bid });
    broadcastState(code);

    const nonGM = Object.values(room.players).filter(p => !p.isGM);
    const readyCount = nonGM.filter(p => p.bidReady).length;
    log(code, `🤫 ${readyCount}/${nonGM.length} voices have bid`, 'info');

    if (nonGM.every(p => p.bidReady)) revealBids(code);
  });

  socket.on('force-reveal-bids', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    revealBids(code);
  });

  socket.on('resolve-tiebreak', ({ winnerId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    const winner = room.players[winnerId];
    if (!winner) return;

    winner.willpower = Math.max(0, winner.willpower - (winner.bid ?? 0));
    room.activeVoice = winnerId;
    room.phase = 'playing';
    room.tieBreakPlayers = null;

    io.to(code).emit('tiebreak-resolved', { winnerId, winnerName: winner.name });
    log(code, `👑 Tiebreak won by ${winner.name}! They take control of John.`, 'active');
    broadcastState(code);
    checkGameOver(code);
  });

  socket.on('roll-dice', ({ willpowerSpent, hasSkill }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player || room.activeVoice !== socket.id) return;

    const spent = Math.max(0, Math.min(parseInt(willpowerSpent) || 0, player.willpower));
    player.willpower = Math.max(0, player.willpower - spent);

    const rawRoll = Math.floor(Math.random() * 6) + 1;
    const finalRoll = rawRoll + spent;
    const threshold = hasSkill ? 3 : 6;
    const success = finalRoll >= threshold;

    const resultText = success ? '✅ SUCCESS' : '❌ FAILURE';
    log(code, `🎲 ${player.name} rolls ${rawRoll}${spent > 0 ? `+${spent}WP` : ''} = ${finalRoll} vs ${threshold} needed — ${resultText}`, success ? 'success' : 'failure');

    io.to(code).emit('dice-rolled', {
      playerId: socket.id,
      playerName: player.name,
      rawRoll,
      willpowerSpent: spent,
      finalRoll,
      threshold,
      hasSkill,
      success,
    });
    broadcastState(code);

    if (!success) checkGameOver(code);
  });

  socket.on('complete-obsession', ({ playerId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;

    player.obsessionCount++;
    log(code, `🏆 ${player.name} completed their obsession! (×${player.obsessionCount})`, 'success');
    io.to(code).emit('obsession-completed', { playerId, playerName: player.name, count: player.obsessionCount });
    broadcastState(code);

    setTimeout(() => startControlTest(code, `${player.name}'s obsession was fulfilled — a new struggle begins!`), 800);
  });

  socket.on('john-nap', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;

    const roll = Math.floor(Math.random() * 6) + 1;
    const sleeps = roll >= 4;

    if (sleeps) {
      for (const p of Object.values(room.players)) {
        if (!p.isGM) p.willpower++;
      }
      room.activeVoice = null;
      log(code, `😴 John naps! (rolled ${roll}) All Voices gain 1 Willpower.`, 'event');
      io.to(code).emit('john-napped', { roll, slept: true });
      broadcastState(code);
      setTimeout(() => startControlTest(code, 'John wakes from his nap...'), 2000);
    } else {
      log(code, `👀 John stays awake. (rolled ${roll}, needed 4+)`, 'info');
      io.to(code).emit('john-napped', { roll, slept: false });
    }
  });

  socket.on('adjust-willpower', ({ playerId, delta }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    const player = room.players[playerId];
    if (!player) return;

    player.willpower = Math.max(0, player.willpower + delta);
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    log(code, `⚡ GM adjusted ${player.name}'s willpower ${sign} → ${player.willpower}`, 'info');
    broadcastState(code);
    checkGameOver(code);
  });

  socket.on('end-game', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;
    room.phase = 'ended';
    room.activeVoice = null;
    log(code, '🔚 GM ended the game.', 'end');
    io.to(code).emit('game-over', { reason: 'gm' });
    broadcastState(code);
  });

  socket.on('reveal-scores', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.gmSocketId !== socket.id) return;

    const scores = Object.entries(room.players)
      .filter(([, p]) => !p.isGM)
      .map(([id, p]) => ({
        id,
        name: p.name,
        obsession: p.obsession,
        obsessionLevel: p.obsessionLevel,
        obsessionCount: p.obsessionCount,
        score: p.obsessionCount * p.obsessionLevel,
        skills: p.skills,
      }))
      .sort((a, b) => b.score - a.score);

    io.to(code).emit('scores-revealed', { scores });
    log(code, '📊 Final scores revealed!', 'event');
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const player = room.players[socket.id];
    if (!player) return;

    if (player.isGM) {
      log(code, '⚠️ GM disconnected. Room closed.', 'end');
      io.to(code).emit('gm-disconnected');
      delete rooms[code];
    } else {
      delete room.players[socket.id];
      log(code, `👋 ${player.name} disconnected`, 'info');
      io.to(code).emit('player-left', { playerId: socket.id, name: player.name });
      broadcastState(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Everyone is John — server running at http://localhost:${PORT}`);
});
