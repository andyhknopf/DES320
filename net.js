// ---------------------------------------------------------------------------
// NET — how a table reaches its room, whichever way the game is hosted.
//
// On a plain website there is no server: the player who creates a room is its
// host, their browser runs the room (room.js) and referees every move with
// engine.js, and the guest's browser connects to it directly over WebRTC.
// PeerJS's free public broker only introduces the two browsers by room code;
// the game itself travels peer to peer. If the page is instead served by the
// optional Node lobby (online.mjs), the table talks to that server.
//
// Every transport offers the same three things: send(action, body), which
// resolves to { ok, body }; onRoom(fn), called with the whole room on every
// change; and onStatus(fn), called with a line for the player or null.
// ---------------------------------------------------------------------------

import * as R from './room.js';

const PEERJS = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'halotcg-v1-';   // the broker is shared by everyone who uses PeerJS
const hostKey = (code) => `halo-p2p-host-${code}`;
const guestKey = (code) => `halo-p2p-guest-${code}`;
const serverKey = (code) => `halo-online-${code}`;

const load = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: works until the tab closes */ } };

// --- the lobby's side -------------------------------------------------------------

// Is this page served by the Node lobby? On a static website /api/decks is a 404 page.
export async function serverAvailable() {
  if (document.querySelector('meta[name="halo-host"][content="static"]')) return false;   // the web/ build says so
  try { const r = await fetch('api/decks', { cache: 'no-store' }); return r.ok && (r.headers.get('content-type') || '').includes('json'); } catch { return false; }
}

// Peer to peer: the room lives in the host's browser from the moment it is made.
export function createHostedRoom({ name, deck }) {
  const room = R.createRoom({ name, deck });
  store(hostKey(room.code), R.saveable(room));
  return room.code;
}
export function rememberGuest(code, { name, deck }) {
  const was = load(guestKey(code));
  store(guestKey(code), { name, deck, token: was?.token || R.newToken() });
}
export function rememberServerSeat(code, token) { store(serverKey(code), token); }

// --- the table's side -------------------------------------------------------------

// Which way this browser is connected to the room, from what the lobby left behind.
export function openRoom(code) {
  if (load(hostKey(code))) return hostNet(code);
  if (load(guestKey(code))) return guestNet(code);
  if (load(serverKey(code))) return serverNet(code, load(serverKey(code)));
  return null;
}

function hub() {
  const rooms = new Set(), statuses = new Set();
  let lastRoom = null, lastStatus = null;
  return {
    room(r) { lastRoom = r; for (const f of rooms) f(r); },
    status(s) { lastStatus = s; for (const f of statuses) f(s); },
    onRoom(f) { rooms.add(f); if (lastRoom) f(lastRoom); },
    onStatus(f) { statuses.add(f); if (lastStatus !== null) f(lastStatus); },
  };
}

let peerLib = null;
function loadPeer() {
  peerLib ??= new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);
    const s = document.createElement('script');
    s.src = PEERJS; s.onload = () => resolve(window.Peer);
    s.onerror = () => reject(new Error('Could not load the connection library — check your internet connection.'));
    document.head.appendChild(s);
  });
  return peerLib;
}

// The host: this browser is the referee, and the guest's moves arrive over the link.
function hostNet(code) {
  const h = hub();
  const room = R.restore(load(hostKey(code)));
  const guests = new Set();
  const persist = () => store(hostKey(code), R.saveable(room));
  const tell = () => {
    h.room(R.publicRoom(room, 0));
    for (const c of guests) if (c.open && c.seat != null) c.send({ t: 'room', room: R.publicRoom(room, c.seat) });
  };
  const act = (seat, action, body) => {
    try {
      if (action === 'move') R.applyMove(room, seat, body);
      else if (action === 'rematch') R.rematch(room);
      else throw new Error('No such action');
      persist(); tell();
      return { ok: true, body: { n: room.intents.length } };
    } catch (err) { return { ok: false, body: { error: err.message, room: R.publicRoom(room, seat) } }; }
  };

  let tries = 0;
  const open = async () => {
    let Peer;
    try { Peer = await loadPeer(); } catch (err) { h.status(err.message); return; }
    const peer = new Peer(PREFIX + code, { debug: 0 });
    peer.on('open', () => { tries = 0; h.status(null); tell(); });
    peer.on('connection', (conn) => {
      conn.on('data', (msg) => {
        if (msg?.t === 'hello') {
          try {
            const before = room.players.length;
            conn.seat = R.joinRoom(room, msg);
            guests.add(conn);
            if (room.players.length !== before) persist();
            conn.send({ t: 'reply', rid: msg.rid, ok: true, body: { seat: conn.seat } });
            tell();
          } catch (err) { conn.send({ t: 'reply', rid: msg.rid, ok: false, body: { error: err.message } }); }
        } else if (msg?.t === 'act') {
          const res = conn.seat == null ? { ok: false, body: { error: 'Say hello first' } } : act(conn.seat, msg.action, msg.body);
          conn.send({ t: 'reply', rid: msg.rid, ...res });
        }
      });
      conn.on('close', () => { guests.delete(conn); if (R.started(room) && !room.over) h.status('Your opponent disconnected — the game waits here until they come back.'); });
      conn.on('open', () => h.status(null));
    });
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', (err) => {
      // After a refresh the broker can hold the room's name for a few seconds; keep asking for it.
      if (err.type === 'unavailable-id' || err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        h.status(tries++ < 2 ? 'Opening the room…' : 'Still opening the room — retrying…');
        peer.destroy(); setTimeout(open, 3000);
      } else h.status(`Connection problem: ${err.type}`);
    });
  };
  h.status('Opening the room…');
  open();
  tell();
  return { kind: 'host', send: async (action, body) => act(0, action, body), onRoom: h.onRoom, onStatus: h.onStatus };
}

// The guest: every move goes to the host, and the host's word is final.
function guestNet(code) {
  const h = hub();
  const me = load(guestKey(code));
  const pending = new Map();
  let conn = null, rid = 0, seated = false;
  const request = (t, body) => new Promise((resolve) => {
    if (!conn?.open) return resolve({ ok: false, body: { error: 'Not connected to the host' } });
    const id = ++rid; pending.set(id, resolve);
    conn.send({ t, rid: id, ...body });
    setTimeout(() => { if (pending.delete(id)) resolve({ ok: false, body: { error: 'The host did not answer' } }); }, 15000);
  });

  let peer = null, retry = null;
  const later = (ms) => { clearTimeout(retry); retry = setTimeout(connect, ms); };
  const connect = () => {
    if (!peer || peer.destroyed || peer.disconnected) return;
    if (conn) { conn.removeAllListeners?.(); conn.close(); }
    conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    conn.on('open', async () => {
      const r = await request('hello', { name: me.name, deck: me.deck, token: me.token });
      if (r.ok) { seated = true; h.status(null); } else h.status(r.body.error);
    });
    conn.on('data', (msg) => {
      if (msg?.t === 'room') h.room(msg.room);
      else if (msg?.t === 'reply') { const f = pending.get(msg.rid); if (f) { pending.delete(msg.rid); f({ ok: msg.ok, body: msg.body }); } }
    });
    conn.on('close', () => { h.status(seated ? 'Lost the connection to the host — reconnecting…' : 'Could not reach the host — retrying…'); later(2500); });
  };
  const start = async () => {
    let Peer;
    try { Peer = await loadPeer(); } catch (err) { h.status(err.message); return; }
    peer = new Peer({ debug: 0 });
    peer.on('open', connect);
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') { h.status(`Room ${code} isn't open right now — the host needs their game page open. Retrying…`); later(4000); }
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') { h.status('Connection problem — retrying…'); peer.destroy(); setTimeout(start, 3000); }
      else h.status(`Connection problem: ${err.type}`);
    });
  };
  h.status(`Connecting to room ${code}…`);
  start();
  return { kind: 'guest', send: (action, body) => request('act', { action, body }), onRoom: h.onRoom, onStatus: h.onStatus };
}

// The optional Node lobby: plain HTTP for moves, a server-sent event stream for the room.
function serverNet(code, token) {
  const h = hub();
  const es = new EventSource(`api/rooms/${code}/stream?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => { h.status(null); h.room(JSON.parse(e.data)); };
  es.onerror = () => h.status('Connection to the lobby server dropped — retrying…');
  const send = async (action, body) => {
    try {
      const r = await fetch(`api/rooms/${code}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, ...body }) });
      return { ok: r.ok, body: await r.json().catch(() => ({})) };
    } catch { return { ok: false, body: { error: 'Lost touch with the server' } }; }
  };
  return { kind: 'server', send, onRoom: h.onRoom, onStatus: h.onStatus };
}

// --- playtest records, kept in this browser -------------------------------------------
const RECORDS = 'halo-online-records';
export function keepRecord(rec) {
  const all = load(RECORDS) || {};
  all[`${rec.code}-g${rec.game}`] = rec;
  store(RECORDS, all);
}
export const records = () => Object.values(load(RECORDS) || {}).sort((a, b) => String(a.created).localeCompare(String(b.created)));
