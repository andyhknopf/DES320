// ---------------------------------------------------------------------------
// ROOM — the rules of an online room, shared by every way of hosting one.
//
// A room seats two players, deals a game from the engine, and is the referee:
// every move is checked with engine.js before it counts. The same code runs in
// the Node lobby (online.mjs) and in the host's browser when the game is
// played peer to peer from a plain website (net.js), so both behave alike.
//
// Plain data in, plain data out: a room is JSON apart from its live engine
// state, which deal() rebuilds from the seed and the moves.
// ---------------------------------------------------------------------------

import * as E from './engine.js';

// Every current touchstone deck, labelled by faction, for the lobby's picker.
export const DECKS = E.J.touchstones.decks
  .filter((d) => (d.status || 'current') === 'current')
  .map((d) => {
    const ids = Object.keys(d.cards);
    const faction = ids.map((id) => E.CARD[id]?.faction).find((f) => f && f !== 'Neutral') ?? 'Neutral';
    const cards = Object.values(d.cards).reduce((a, b) => a + b, 0);
    return { id: d.id, name: d.name, faction, calibration: d.calibration, archetype: d.archetype, strategy: d.strategy, cards };
  });
const DECK_IDS = new Set(DECKS.map((d) => d.id));
export const isDeck = (id) => DECK_IDS.has(id);

const randInt = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I or O: codes get read aloud
export const newCode = () => Array.from({ length: 4 }, () => LETTERS[randInt(LETTERS.length)]).join('');
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
export const cleanName = (s, seat) => String(s ?? '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 24) || `Player ${seat + 1}`;

export const started = (room) => room.players.length === 2;
export const seatOf = (room, token) => (token ? room.players.findIndex((p) => p.token === token) : -1);

// room: { code, created, game, seed, firstPlayer, players: [{ name, deck, token }], intents: [{ seat, id, ms, at }],
//         state (live, never saved), over, winner }
export function createRoom({ code = newCode(), name, deck, token = newToken() }) {
  if (!isDeck(deck)) throw new Error('Pick a deck');
  return {
    code, created: new Date().toISOString(), game: 1, seed: 1 + randInt(1e9), firstPlayer: randInt(2),
    players: [{ name: cleanName(name, 0), deck, token }], intents: [], state: null, over: false, winner: null,
  };
}

// Returns the seat. A token already seated gets its seat back; a third player is refused.
export function joinRoom(room, { name, deck, token }) {
  const again = seatOf(room, token);
  if (again !== -1) return again;
  if (started(room)) throw new Error('That room already has two players');
  if (!isDeck(deck)) throw new Error('Pick a deck');
  room.players.push({ name: cleanName(name, 1), deck, token: token || newToken() });
  deal(room);
  return 1;
}

export function deal(room) {
  room.state = E.newGame({ seed: room.seed, firstPlayer: room.firstPlayer, match: room.players.map((p) => p.deck), names: room.players.map((p) => p.name) });
  for (const it of room.intents) {
    const r = E.apply(room.state, { seat: it.seat, id: it.id });
    if (!r.ok) throw new Error(`Room ${room.code}: saved move ${it.id} no longer applies (${r.reason})`);
    room.state = r.state;
  }
  room.over = E.isOver(room.state); room.winner = room.over ? room.state.winner : null;
}

// n is the move number the sender believes comes next, so a move sent from a stale screen is refused.
export function applyMove(room, seat, { id, n, ms }) {
  if (!started(room)) throw new Error('Waiting for the second player');
  if (room.over) throw new Error('The game is over');
  if (n !== room.intents.length) throw new Error('Out of step — resyncing');
  if (!room.state) deal(room);
  const r = E.apply(room.state, { seat, id: String(id) });
  if (!r.ok) throw new Error(r.reason);
  room.state = r.state;
  room.intents.push({ seat, id: String(id), ms: Number.isFinite(ms) ? Math.round(ms) : null, at: new Date().toISOString() });
  room.over = E.isOver(room.state); room.winner = room.over ? room.state.winner : null;
}

// Same seats and decks, a fresh shuffle, and the other player goes first.
export function rematch(room) {
  if (!room.over) throw new Error('Finish this game first');
  room.game += 1; room.seed = 1 + randInt(1e9); room.firstPlayer = 1 - room.firstPlayer; room.intents = [];
  deal(room);
}

// What a player's screen is told. Tokens are never in it.
export function publicRoom(room, seat = -1) {
  return {
    code: room.code, game: room.game, seed: room.seed, firstPlayer: room.firstPlayer,
    players: room.players.map((p) => ({ name: p.name, deck: p.deck, deckName: DECKS.find((d) => d.id === p.deck)?.name })),
    started: started(room), intents: room.intents.map(({ seat: s, id }) => ({ seat: s, id })),
    over: room.over, winner: room.winner, you: seat,
  };
}

// The playtest record: the same shape as the table's downloaded session.
export function sessionRecord(room) {
  return {
    source: 'online', code: room.code, game: room.game, seed: room.seed, firstPlayer: room.firstPlayer,
    match: room.players.map((p) => p.deck), names: room.players.map((p) => p.name), human: 'online',
    intents: room.intents, over: room.over, winner: room.winner,
    metrics: room.state ? E.metrics(room.state) : null, log: room.state?.log ?? [],
    created: room.created, savedAt: new Date().toISOString(),
  };
}

// For keeping a room somewhere (a file, browser storage) and bringing it back.
export const saveable = ({ state, ...rest }) => rest;
export function restore(saved) {
  const room = { ...saved, state: null };
  if (started(room)) deal(room);
  return room;
}
