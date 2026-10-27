// Halo TCG engine — the rules and the greedy play policy, as one importable module.
// run.js (Merlin's balance runner) and touchstone-sim.mjs (the quick CLI) both call
// playGame(); neither implements a rule.
//
// It is a floor measurement: one fixed, unclever policy for every deck. A win rate
// here says how the decks compare when played plainly, not how good they are.
//
// Rules taken from rules.md. Where rules.md leaves a gap, the simulator picks a
// setting and names it in ASSUMPTIONS below, so a reader can tell a rule from a guess.

import { notePlayed } from './engine-kit.js';
import { DATA } from './cards-data.js';
import { MATCH } from './match.js';

export const ASSUMPTIONS = [
  'Pace (rules.md, 2026-10-27): life 50 + 20 recharging hero shield, 3x9 board, resource starts at 2 and caps at 15, opening hand 7, draw 2 a turn; --life overrides.',
  'Summoning sickness: a unit cannot attack the turn it is placed (rules.md; --sick 0 turns this off).',
  'Activation costs are provisional test values: Ark Foundry 3, Cartographer 1, Carrier Form 1, the other five 2. Once per turn; not on the turn the unit was placed.',
  'Skipping the Main step makes the next Resource step add --skip (default 2, provisional) instead of 1.',
  'Holding Protocol units back from trades was tried and dropped: it lowered Forerunner from 55% to 43% overall.',
  'Combined arms: a Human/UNSC Vehicle gets +1 Attack while adjacent to a friendly non-Vehicle unit with Attack above 0, and a Human/UNSC infantry unit gets +1 Attack while adjacent to a friendly Human/UNSC Vehicle (neutral Vehicles neither get nor give it).',
  'Any unit may attack any enemy unit or the hero (formation-position target legality is not yet defined).',
  'Blocking (rules.md; --block 0 turns it off): a defender front-zone unit may block any attack, any number of times while it survives; the blocked fight resolves as an attack on the blocker. Attacks from the side zone cannot be blocked (flanking).',
  'Blocking policy: the defender blocks with the front unit that survives the hit and hits back hardest; it throws a unit away to block only to stop lethal or to save a bigger unit. Attackers do not attack into a blocker that would survive and kill them. Units with more Attack than Health prefer the side zone; units with 4+ Health prefer the front zone (Covenant keeps caste zones; Flood keeps adjacency).',
  'Board is 3 rows (front, side, back) x 9 columns (--cols overrides); adjacency includes diagonals.',
  'Tactics are played only at the attack window, one per declared attack, from resource left over after the owner\'s own turn.',
  'Policy reserves resource for the cheapest Tactic in hand, plays units greedily (most expensive first), then spends what is left on activations, then on Redeploy.',
  "Smart policy (--smart 1, default): Redeploy moves UNSC units to make Vehicle-infantry pairs, and once a turn for Cortana's draw; skips Main when nothing in hand is affordable and resource is below the cap. --smart 0 is the old policy (no Redeploy, no skip) but still uses activations.",
  'Hijack: the stolen Vehicle leaves the enemy board and its Health becomes a shield on the hijacker (damage hits the shield first).',
  'The player going second starts with resource 1, so their first Resource step takes them to 2 (rules.md; --ahead 0 turns it off). --extra N gives them N extra opening cards (off; tested and dropped).',
  'Optional test (--coin 1, off by default): the player going second also gets a one-time Coin worth +1 resource for one turn, spent the first time it makes a unit in hand affordable.',
  'Expansion cards (1.5): Rally fires on every Redeploy, including free ones; the bot Redeploys every Rally unit it can afford each turn, toward a combined-arms partner, else within the same zone.',
  'Glory fires the first time the card is on the board while the formation is complete (checked after every play, response and turn step), once per card; Shipmaster fills whichever zone it sits in; Shade Gunner fills the side zone.',
  'Consume counts every other own unit destroyed at once (combat, removal or sacrifice); the bot sacrifices Infection Forms and 2-Attack-or-less units to Gravemind Spawn, and fires Flood self-destructs only for a kill, a 2+ unit zone, or a card.',
  'Awaken is checked at the start of its owner\'s turn, once per card; Time Dilation Field adds a turn in place to every other card, for Awaken and Protocol alike. Encrypt is only checked by Hijack.',
  'Bubble Shield\'s −1 Attack is modelled for the rest of the attacker\'s turn only, not into its blocks on your next turn.',
  'No mulligan.',
];

// Card data. In Node the engine reads ../cards.json fresh and rewrites cards-data.js,
// so the browser client (which cannot read files) always loads the same pool the sim ran.
export let J = DATA;
if (typeof process !== 'undefined' && process.versions?.node) {
  const fs = await import('node:fs');
  const src = new URL('../cards.json', import.meta.url);
  J = JSON.parse(fs.readFileSync(src, 'utf8'));
  const out = new URL('./cards-data.js', import.meta.url);
  const text = '// Generated from ../cards.json by engine.js whenever the sim runs. Do not edit.\nexport const DATA = ' + JSON.stringify(J) + ';\n';
  try { if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) fs.writeFileSync(out, text); } catch { /* read-only copy */ }
}
export const CARD = Object.fromEntries(J.cards.map((c) => [c.id, c]));
const byTitle = (t) => J.cards.find((c) => c.title === t);

// Rules values and policy switches. Defaults are the current rules.md; configure()
// overrides them for an experiment.
let LIFE = 50, SKIP = 2, SMART = true, EXTRA = 0, AHEAD = 1, COIN = false, BLOCK = true, SICK = true;
// NAIVE names a faction whose units the bot places in any free cell, ignoring zones: a
// stand-in for a new player who has not learned where that faction's units belong.
let NAIVE = null;
export function configure(o = {}) {
  if (o.life != null) LIFE = +o.life;
  if (o.skip != null) SKIP = +o.skip;
  if (o.smart != null) SMART = !!o.smart;
  if (o.extra != null) EXTRA = +o.extra;
  if (o.ahead != null) AHEAD = +o.ahead;
  if (o.coin != null) COIN = !!o.coin;
  if (o.block != null) BLOCK = !!o.block;
  if (o.sick != null) SICK = !!o.sick;
  if (o.naive !== undefined) NAIVE = o.naive || null;
  if (o.shield != null) HSHIELD = +o.shield;
  if (o.breakDraw != null) BREAKDRAW = +o.breakDraw;
  if (o.plasma != null) PLASMA = +o.plasma;
  if (o.doctrine != null) DOCTRINE = +o.doctrine;
  if (o.breakRes != null) BREAKRES = +o.breakRes;
  if (o.breakShield != null) BREAKSHIELD = +o.breakShield;
  for (const k of ['cols', 'cap', 'hand', 'draw', 'grow', 'start']) if (o[k] != null) ({ cols: () => (COLS = +o.cols), cap: () => (CAP = +o.cap), hand: () => (HAND = +o.hand), draw: () => (DRAW = +o.draw), grow: () => (GROW = +o.grow), start: () => (START = +o.start) })[k]();
  return { breakDraw: BREAKDRAW, shield: HSHIELD, cols: COLS, cap: CAP, hand: HAND, draw: DRAW, grow: GROW, start: START, life: LIFE, skip: SKIP, smart: SMART, extra: EXTRA, ahead: AHEAD, coin: COIN, block: BLOCK, sick: SICK, naive: NAIVE };
}
let seed = 1;
// Per-game record the balance report reads: which cards were dealt, drawn and played.
let GS = null;
// Event lines for the play client. The simulator leaves this null and logs nothing.
let LOG = null;
const note = (msg) => { if (LOG) LOG.push(msg); };
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const ROWS = 3, MAX_TURNS = 120;
// Pace: board width, resource cap, opening hand, cards drawn and resource gained per turn, starting resource.
let COLS = 9, CAP = 15, HAND = 7, DRAW = 2, GROW = 1, START = 2;
// Hero shields: soak hero damage first and recharge in full at the start of the owner's turn. 0 = off.
let HSHIELD = 20;
const ZONE = { Grunt: 0, Hunter: 0, Jackal: 1, Elite: 2, Turret: 2 };
const has = (c, k) => (c.abilities || []).includes(k);
const stat = (c) => { const [a, h] = (c.stats || '0/0').split('/').map(Number); return { a, h }; };
const IF = 'fl01', GRUNT = 'cov01', MARINE = 'n01', SENTINEL = 'fr03';
const ACT_COST = { 'Bursting Carrier': 1, 'Sacrificial Pod': 1, 'Carrier Swarm': 2, 'Spore Conduit': 1, 'Ark Foundry': 3, Cartographer: 1, 'Phantom Dropship': 2, 'Jackal Sniper': 2, 'Carrier Form': 1, 'Proto-Gravemind': 2, 'Master Chief': 2, 'Pelican Gunship': 2 };
const isInfantry = (u) => CARD[u.id].subtype !== 'Vehicle' && stat(CARD[u.id]).a > 0;
const isUnscVehicle = (u) => CARD[u.id].faction === 'Human/UNSC' && CARD[u.id].subtype === 'Vehicle';
const paired = (p, u) => p.board.some((v) => adj(u, v) && isInfantry(v));

function newPlayer(deck, name) {
  const lib = [];
  for (const [id, q] of Object.entries(deck.cards)) for (let i = 0; i < q; i++) lib.push(id);
  return { name, deck: shuffle(lib), hand: [], board: [], life: LIFE, max: 0, res: 0, fatigue: 0, turns: 0, skipped: false };
}

function draw(p, n = 1) {
  for (let i = 0; i < n; i++) {
    if (p.deck.length) { const id = p.deck.pop(); p.hand.push(id); if (GS) (GS.cardStats[id] ??= { drawn: 0, played: 0 }).drawn++; }
    else { p.fatigue++; p.life -= p.fatigue; }
  }
}

const cells = (p) => { const s = new Set(p.board.map((u) => u.r * COLS + u.c)); const out = []; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!s.has(r * COLS + c)) out.push({ r, c }); return out; };
const adj = (a, b) => a !== b && Math.abs(a.r - b.r) <= 1 && Math.abs(a.c - b.c) <= 1;
const adjCells = (p, u) => cells(p).filter((x) => Math.abs(x.r - u.r) <= 1 && Math.abs(x.c - u.c) <= 1);

// Whether unit u fills the formation's requirement for zone r.
function formationFits(u, r) {
  const c = CARD[u.id];
  if (c.title === 'Shipmaster') return true;
  if (r === 0) return c.subtype === 'Grunt';
  if (r === 1) return c.subtype === 'Jackal' || c.title === 'Shade Gunner';
  return c.subtype === 'Elite' || c.title === 'Shade Emplacement';
}

// Glory: fires on each card on the board the moment the formation becomes complete; once per card.
function checkGlory(p, o, turn) {
  const now = complete(p);
  if (now) {
    const times = p.board.some((v) => CARD[v.id].title === 'Honor Guard Standard') ? 2 : 1;
    for (const u of [...p.board]) {
      if (!has(CARD[u.id], 'glory') || u.gloried || !p.board.includes(u)) continue;
      u.gloried = true; note(`${CARD[u.id].title}: Glory.`);
      for (let k = 0; k < times; k++) glory(p, o, u, turn);
    }
    cleanup(o); cleanup(p);
  }
  p.wasComplete = complete(p);
}

function glory(p, o, u, turn) {
  switch (CARD[u.id].title) {
    case 'Grunt Ultra': u.permA += 1; u.permH += 1; break;
    case 'Jackal Scout': { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); break; }
    case 'Hunter Pair': u.permA += 2; break;
    case 'Brute Chieftain': for (const v of p.board) v.tmpA += 1; break;
    case 'Spectre': { let best = 0, n = -1; for (let r = 0; r < ROWS; r++) { const k = o.board.filter((x) => x.r === r).length; if (k > n) { n = k; best = r; } } for (const x of o.board.filter((x) => x.r === best)) damage(o, x, 2); break; }
    case 'Elite Ranger': draw(p, 2); break;
    case 'Prophet of Mercy': for (const v of p.board) if (v !== u) { v.permA += 1; v.permH += 1; } break;
    case 'Unggoy Choir': spawnAny(p, GRUNT, 2, turn, 0); break;
    case 'Kig-Yar Pirate': { const e = pickEnemy(o, 99, (x) => hpMax(o, x) - x.dmg + x.shield <= 2); if (e) e.dmg = 999; break; }
  }
}

function complete(p) {
  const at = (row, sub) => p.board.some((u) => u.r === row && (sub.includes(CARD[u.id].subtype)
    || (sub.includes('Elite') && CARD[u.id].title === 'Shade Emplacement')
    || (sub.includes('Jackal') && CARD[u.id].title === 'Shade Gunner')
    || CARD[u.id].title === 'Shipmaster'));
  return at(0, ['Grunt']) && at(1, ['Jackal']) && at(2, ['Elite']);
}

// Turns a card counts as having been in place: Time Dilation Field adds one to every other card.
function inPlaceOf(p, u) { return u.inPlace + p.board.filter((v) => v !== u && CARD[v.id].title === 'Time Dilation Field').length; }

function awaken(p, o, u, turn) {
  switch (CARD[u.id].title) {
    case 'Constructor Swarm': spawnAny(p, SENTINEL, 1, turn); break;
    case 'Monitor Drone': draw(p, 2); break;
    case 'Halo Defense Grid': for (const x of o.board) damage(o, x, 3); break;
    case 'Cryptum': spawnAny(p, SENTINEL, 3, turn); break;
    case 'Guardian Construct': u.permA += 4; u.permH += 4; break;
    case 'Activation Monitor': for (const v of p.board) if (has(CARD[v.id], 'protocol')) v.full = true; break;
    case 'Index Keeper': { const top = p.deck.splice(-3); if (top.length) { top.sort((a, b) => (CARD[a].cost <= p.max + 2 ? CARD[a].cost : -1) - (CARD[b].cost <= p.max + 2 ? CARD[b].cost : -1)); p.hand.push(top.pop()); p.deck.unshift(...top); } break; }
  }
  draw(p, p.board.filter((v) => CARD[v.id].title === 'Ark Archivist').length);
  cleanup(o);
}

function protoRate(p) { return p.board.some((u) => CARD[u.id].title === 'Monitor Overseer') ? 2 : 1; }

function atk(p, u) {
  const c = CARD[u.id]; let a = u.a + u.tmpA + u.permA;
  if (has(c, 'infect')) a += p.board.filter((v) => adj(u, v) && CARD[v.id].faction === 'Flood').length;
  if (has(c, 'doctrine') && ZONE[c.subtype] === u.r) a += DOCTRINE;
  if (has(c, 'protocol')) a += u.full ? 3 : Math.min(3, inPlaceOf(p, u) * protoRate(p));
  if (c.title === 'Dormant Sentinel' && u.inPlace >= 3) a += 3;
  if (isUnscVehicle(u) && paired(p, u)) a += 1;
  if (c.title === 'Mercenary Pilot' && p.board.some((v) => v !== u && adj(u, v) && CARD[v.id].subtype === 'Vehicle')) a += 1;
  if (c.subtype === 'Vehicle') a += p.board.filter((v) => v !== u && CARD[v.id].title === 'Field Commander').length;
  if (CARD[u.id].faction === 'Human/UNSC' && isInfantry(u) && p.board.some((v) => adj(u, v) && isUnscVehicle(v))) a += 1;
  const cmp = complete(p);
  for (const v of p.board) {
    if (v === u) continue; const t = CARD[v.id].title;
    if (t === 'Sergeant Johnson') a += 1;
    if (t === 'Marine Sergeant' && has(c, 'redeploy')) a += 1;
    if (t === 'The Arbiter' && cmp) a += 1;
    if (t === 'Kig-Yar Skirmisher' && v.r === 1 && c.subtype === 'Grunt') a += 1;
    if (t === 'Infection Vector' && u.id === IF && adj(u, v)) a += 1;
    if (t === 'Weapon Cache' && adj(u, v)) a += 1;
    if (t === 'Ammo Cache' && adj(u, v) && u.r === 0) a += 1;
    if (t === 'Watchtower' && u.r === 2) a += 1;
    if (t === 'Ancient Network' && has(c, 'protocol')) a += 1;
    if (t === 'Honor Guard Ultra' && c.subtype === 'Elite' && u.r === 2) a += 1;
    if (t === 'Prophet of Truth' && cmp && has(c, 'doctrine')) a += 2;
  }
  if (c.title === 'Jackal Major' && cmp) a += 2;
  return Math.max(0, a);
}

function hpMax(p, u) {
  const c = CARD[u.id]; let h = u.h + u.permH + u.tmpH;
  if (c.title === 'Dormant Sentinel' && u.inPlace >= 3) h += 3;
  const cmp = complete(p);
  for (const v of p.board) {
    if (v === u) continue; const t = CARD[v.id].title;
    if ((t === 'Shield Generator' || t === 'Elephant Command Post') && adj(u, v)) h += 2;
    if (t === 'Ancient Network' && has(c, 'protocol')) h += 1;
    if (t === 'Honor Guard Ultra' && c.subtype === 'Elite' && u.r === 2) h += 1;
    if (t === 'Prophet of Truth' && cmp && has(c, 'doctrine')) h += 2;
  }
  return h;
}

const alive = (p, u) => u.dmg < hpMax(p, u);
function cleanup(p) {
  // repeated because an aura dying can lower another unit's health
  for (let k = 0; k < 4; k++) {
    const dead = p.board.filter((u) => !alive(p, u));
    if (!dead.length) break;
    p.board = p.board.filter((u) => alive(p, u));
    onDeaths(p, dead);
  }
}
// What happens when a player's units are destroyed (p owns the dead units).
function onDeaths(p, dead) {
  const o = p.opp;
  note(`Destroyed: ${dead.map((u) => CARD[u.id].title).join(', ')}.`);
  for (const u of dead) {
    switch (CARD[u.id].title) {
      case 'Militia Volunteer': heal(p, 2); break;
      case 'Infection Carrier': spawnAny(p, IF, 1, p.turnNo ?? 0); break;
      case 'Spore Host': spawnAdj(p, u, IF, 2, p.turnNo ?? 0); break;
      case 'Infested Pelican': spawnAny(p, IF, 3, p.turnNo ?? 0); break;
    }
  }
  // Consume: each surviving Consume unit grows once per other unit destroyed
  const g = p.board.some((v) => CARD[v.id].title === "Gravemind's Voice") ? 2 : 1;
  for (const v of p.board) if (has(CARD[v.id], 'consume')) { v.permA += g * dead.length; v.permH += g * dead.length; }
  // Proto-Keyes: 1 damage to an enemy unit per other unit destroyed
  const keyes = p.board.filter((v) => CARD[v.id].title === 'Proto-Keyes').length;
  if (o && keyes) { for (let i = 0; i < keyes * dead.length; i++) { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); } cleanup(o); }
}
function damage(p, u, n) { if (n <= 0) return; const s = Math.min(u.shield, n); u.shield -= s; u.dmg += n - s; }
// Damage to a hero: the shield takes it first. Fatigue goes straight to life.
// Catch-up: the first time in a turn that damage gets past the shield to life, that hero draws a card
// (nothing if their deck is empty), and has 2 extra resource on their next turn. BREAKDRAW = 0 turns the draw off.
let DOCTRINE = 1;
let BREAKDRAW = 1, BREAKRES = 2, BREAKSHIELD = 0;
// mult: how many points of shield each point of this damage strips (PLASMA for Covenant sources).
let PLASMA = 1;
function heroHit(p, n, mult = 1) {
  const sh = p.hshield || 0, s = Math.min(n, Math.ceil(sh / mult)); p.hshield = Math.max(0, sh - s * mult); p.life -= n - s;
  if (n - s > 0 && GS && GS.firstHurt == null) GS.firstHurt = p.name;
  if (n - s > 0 && !p.broke && BREAKDRAW && p.life > 0) { p.broke = true; const k = Math.min(BREAKDRAW, p.deck.length); if (k) { draw(p, k); note(`${p.name}: shield broken — draws ${k}.`); } p.breakBonus = true; }
  return n - s;
}
const heroLeft = (p) => p.life + (p.hshield || 0);
function heal(p, n) { p.life = Math.min(LIFE, p.life + n); }

function bestCell(p, c) {
  const free = cells(p); if (!free.length) return null;
  if (NAIVE && c.faction === NAIVE) return free[Math.floor(rnd() * free.length)];
  if (c.title === 'Shipmaster' || c.title === 'Shade Gunner') {
    const need = [['Grunt', 0], ['Jackal', 1], ['Elite', 2]].filter(([, r]) => !p.board.some((u) => u.r === r && formationFits(u, r))).map(([, r]) => r);
    const rows = c.title === 'Shade Gunner' ? [need.includes(1) ? 1 : 2] : (need.length ? need : [ZONE.Elite]);
    const z = free.filter((x) => rows.includes(x.r)); if (z.length) return z[0];
  }
  if (c.faction === 'Covenant' && ZONE[c.subtype] !== undefined) {
    const z = free.filter((x) => x.r === ZONE[c.subtype]); if (z.length) return z[0];
  }
  if (c.faction === 'Flood') {
    let best = free[0], bs = -1;
    for (const x of free) { const s = p.board.filter((v) => adj(x, v) && CARD[v.id].faction === 'Flood').length; if (s > bs) { bs = s; best = x; } }
    return best;
  }
  if (BLOCK && stat(c).a > stat(c).h) { const f = free.filter((x) => x.r === 1); if (f.length) return f[Math.floor(rnd() * f.length)]; }
  if (BLOCK && stat(c).h >= 4) { const f = free.filter((x) => x.r === 0); if (f.length) return f[Math.floor(rnd() * f.length)]; }
  if (c.title === 'Shield Generator' || c.title === 'Weapon Cache') {
    let best = free[0], bs = -1;
    for (const x of free) { const s = p.board.filter((v) => adj(x, v)).length; if (s > bs) { bs = s; best = x; } }
    return best;
  }
  return free[Math.floor(rnd() * free.length)];
}

function summon(p, id, at, turn) {
  const c = CARD[id]; const cell = at || bestCell(p, c); if (!cell) return null;
  const { a, h } = stat(c);
  const u = { uid: GS ? (GS.uid = (GS.uid || 0) + 1) : 0, id, r: cell.r, c: cell.c, a, h, dmg: 0, permA: 0, permH: 0, tmpA: 0, tmpH: 0, shield: 0, placed: turn, lastAtk: turn, inPlace: 0, full: false };
  p.board.push(u); return u;
}
function spawnAdj(p, u, id, n, turn) { for (let i = 0; i < n; i++) { const f = adjCells(p, u); if (!f.length) return; summon(p, id, f[0], turn); } }
function spawnAny(p, id, n, turn, row) { for (let i = 0; i < n; i++) { let f = cells(p); if (row !== undefined) f = f.filter((x) => x.r === row); if (!f.length) return; summon(p, id, f[0], turn); } }

function pickEnemy(o, dmg, filter = () => true) {
  const ts = o.board.filter(filter); if (!ts.length) return null;
  const kill = ts.filter((u) => hpMax(o, u) - u.dmg + u.shield <= dmg).sort((x, y) => atk(o, y) - atk(o, x));
  return kill[0] || ts.sort((x, y) => atk(o, y) - atk(o, x))[0];
}

function onPlace(p, o, u, turn) {
  const c = CARD[u.id]; const t = c.title; const cmp = () => complete(p);
  switch (t) {
    case 'Brute Combat Form': case 'Infection Form Mass': case 'Infection Wave': spawnAdj(p, u, IF, 1, turn); break;
    case 'Stalker Swarm': spawnAdj(p, u, IF, 2, turn); break;
    case 'Flood Tide': spawnAdj(p, u, IF, 3, turn); break;
    case 'Phantom Dropship': spawnAny(p, GRUNT, 1, turn, 0); break;
    case 'Grunt Swarm': spawnAny(p, GRUNT, 2, turn, 0); break;
    case 'Pelican Gunship': spawnAny(p, MARINE, 1, turn); break;
    case 'Sentinel Swarm': spawnAny(p, SENTINEL, 2, turn); break;
    case 'Elite Zealot': if (u.r === 2) { const e = pickEnemy(o, 2); if (e) damage(o, e, 2); } break;
    case 'Banshee': { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); break; }
    case 'Rocket Warthog': { const e = pickEnemy(o, 2); if (e) damage(o, e, 2); break; }
    case 'Wraith': for (const e of o.board.filter((x) => x.r === 0)) damage(o, e, 2); break;
    case 'Mendicant Bias': { const e = pickEnemy(o, 99, (x) => hpMax(o, x) - x.dmg <= 5); if (e) e.dmg = 999; break; }
    case 'Elite Lance Leader': if (u.r === 2) spawnAny(p, GRUNT, 1, turn, 0); break;
    case 'Phantom Gunship': spawnAny(p, GRUNT, 1, turn, 0); spawnAny(p, 'cov03', 1, turn, 1); break;
    case 'Elite Councilor': if (u.r === 2) { const top = p.deck.slice(-3); const k = top.findIndex((id) => ['Grunt', 'Jackal'].includes(CARD[id].subtype)); if (k >= 0) { const idx = p.deck.length - 3 + k; p.hand.push(p.deck.splice(Math.max(0, idx), 1)[0]); } } break;
    case 'Unggoy Deacon': if (u.r === 0) { const top = p.deck.slice(-3); const k = top.findIndex((id) => ['Jackal', 'Elite'].includes(CARD[id].subtype)); if (k >= 0) { const idx = p.deck.length - 3 + k; p.hand.push(p.deck.splice(Math.max(0, idx), 1)[0]); } } break;
    case 'Sangheili Ultra': if (u.r === 2 && cmp()) draw(p, 1); break;
    case 'Prophet of Regret': if (cmp()) draw(p, 2); break;
    case 'ODST Squad': if (p.board.length - 1 < o.board.length) draw(p, 1); break;
    case "Monitor’s Archive": draw(p, 1); break;
    case 'Battlefield Medic': heal(p, 2); break;
    case 'Gravemind Spawn': { const fodder = p.board.filter((v) => v !== u && (v.id === IF || atk(p, v) <= 2)); for (const v of fodder) v.dmg = 999; u.permA += 2 * fodder.length; u.permH += 2 * fodder.length; cleanup(p); break; }
    case 'Phase Shift Sentinel': u.inPlace = 2; break;
    case 'Sniper Spotter': { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); break; }
    case 'Spartan Fireteam': spawnAdj(p, u, MARINE, 2, turn); break;
    case 'Commander Miranda Keyes': for (const v of p.board.filter((x) => x !== u && has(CARD[x.id], 'redeploy') && !x.moved)) { const to = moveTarget(p, v); if (to) doRedeploy(p, o, v, to, turn, 0); } break;
  }
  if (has(c, 'hijack')) {
    const v = o.board.filter((x) => CARD[x.id].subtype === 'Vehicle' && !has(CARD[x.id], 'encrypt')).sort((x, y) => atk(o, y) - atk(o, x))[0];
    if (v) { u.shield += Math.max(0, hpMax(o, v) - v.dmg); o.board = o.board.filter((x) => x !== v); }
  }
  cleanup(o);
}

function startOfTurn(p, o, turn) {
  for (const u of [...p.board]) {
    u.inPlace++;
    const c = CARD[u.id];
    if (c.title === 'Gravemind') { let n = 2; for (const v of [...p.board]) { if (n <= 0) break; if (CARD[v.id].faction === 'Flood') { const f = adjCells(p, v); if (f.length) { summon(p, IF, f[0], turn); n--; } } } }
    if (c.title === 'Flood Hive') spawnAdj(p, u, IF, 1, turn);
    if (has(c, 'gestate') && turn - u.lastAtk >= 4) { spawnAdj(p, u, IF, 1, turn); u.lastAtk = turn; }
    if (c.title === '343 Guilty Spark') { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); }
    if (c.title === 'The Library' && u.inPlace >= 3) draw(p, 1);
    if (has(c, 'awaken') && !u.awakened && inPlaceOf(p, u) >= 3) { u.awakened = true; note(`${c.title}: Awaken.`); awaken(p, o, u, turn); }
    if (c.title === 'Control Room') { for (const x of o.board.filter((x) => x.r === 0)) damage(o, x, 1); }
  }
  cleanup(o);
}

// Score a response Tactic against a declared attack; returns a value and an apply().
function evalTactic(def, att, id, A, D) {
  const c = CARD[id]; const t = c.title; const cmp = complete(def);
  const aHp = () => hpMax(att, A) - A.dmg + A.shield;
  const aAtk = atk(att, A);
  const kills = (n) => n >= aHp();
  const dmgA = (n) => ({ v: kills(n) ? 10 + aAtk : n * 0.5, go: () => damage(att, A, n) });
  const splash = (n, m) => ({ v: (kills(n) ? 10 + aAtk : n * 0.5) + att.board.filter((x) => x !== A && adj(x, A)).length * m * 0.5,
    go: () => { damage(att, A, n); for (const x of att.board.filter((x) => x !== A && adj(x, A))) damage(att, x, m); } });
  const threat = D ? (aAtk >= hpMax(def, D) - D.dmg ? 6 + atk(def, D) : aAtk * 0.3) : aAtk * 0.6;
  switch (t) {
    case 'Spore Burst': case 'Tendril Lash': case 'Assimilate': case 'Trip Mine': {
      const n = t === 'Tendril Lash' && def.board.filter((x) => CARD[x.id].faction === 'Flood').length >= 3 ? 3 : 2;
      const r = dmgA(n); if (t === 'Assimilate') { const g = r.go; r.go = () => { g(); if (!alive(att, A)) spawnAny(def, IF, 1, 0); }; } return r;
    }
    case 'Flood Spore': case 'Frag Grenade': case 'Plasma Grenade': case 'Sentinel Beam': return dmgA(3);
    case 'Zealot Charge': case 'Sniper Overwatch': return dmgA(4);
    case 'Spartan Laser': return CARD[A.id].subtype === 'Vehicle' ? { v: 12 + aAtk, go: () => { A.dmg = 999; } } : dmgA(5);
    case 'Orbital Strike': return dmgA(6);
    case 'Spore Blast': { const r = dmgA(2); const g = r.go; r.go = () => { g(); if (!alive(att, A)) spawnAny(def, IF, 1, 0); }; return r; }
    case 'Hive Burst': { const forms = def.board.filter((x) => x.id === IF); if (!forms.length) return null; const n = forms.length * 2; return { v: kills(n) ? 10 + aAtk - forms.length : n * 0.3, go: () => { for (const f of forms) f.dmg = 999; damage(att, A, n); cleanup(def); } }; }
    case 'Gestation Burst': { const g = def.board.filter((x) => has(CARD[x.id], 'gestate')); return g.length >= 2 ? { v: g.length, go: () => { for (const x of g) spawnAdj(def, x, IF, 1, 0); } } : null; }
    case 'Containment Beam': return dmgA(def.board.some((x) => has(CARD[x.id], 'protocol') && (x.full || inPlaceOf(def, x) * protoRate(def) >= 3)) ? 4 : 2);
    case 'Stasis Field': return { v: threat + 1.5, go: () => { A.noDeal = true; A.stunned = true; } };
    case 'Sterilization Beam': { const near = att.board.filter((x) => x !== A && adj(x, A)); return { v: 10 + aAtk + near.reduce((sum, x) => sum + 2 + atk(att, x), 0), go: () => { A.dmg = 999; for (const x of near) x.dmg = 999; } }; }
    case 'Anti-Vehicle Mine': return CARD[A.id].subtype === 'Vehicle' ? dmgA(4) : null;
    case 'Fuel Rod Gun': { const r = dmgA(3); const g = r.go; r.v -= 0.5; r.go = () => { g(); heroHit(def, 1); }; return heroLeft(def) > 3 ? r : null; }
    case 'Overshield Pickup': return D ? { v: threat * 0.6, go: () => { D.tmpH += 2; } } : null;
    case 'Plasma Grenade Stick': return { v: kills(1) ? 10 + aAtk : 1, go: () => { damage(att, A, 1); A.tmpA -= 1; } };
    case 'Tank Beats Everything': return CARD[A.id].subtype === 'Vehicle' ? { v: 12 + aAtk, go: () => { A.dmg = 999; } } : dmgA(4);
    case 'Rocket Launcher': return dmgA(CARD[A.id].subtype === 'Vehicle' ? 6 : 4);
    case 'Energy Sword': return D ? { v: hpMax(def, D) - D.dmg > aAtk ? 3 : 0.5, go: () => { D.tmpA += 4; } } : null;
    case 'Bubble Shield': return { v: threat + 1, go: () => { A.noDeal = true; A.tmpA -= 1; } };
    case 'Drop Pod Assault': return cells(def).length >= 3 ? { v: 3.5, go: () => spawnAny(def, MARINE, 3, 0) } : null;
    case 'Plasma Volley': return dmgA(cmp ? 3 : 2);
    case 'Plasma Mortar': { const kills = att.board.filter((x) => hpMax(att, x) - x.dmg + x.shield <= 1); return { v: kills.reduce((sum, x) => sum + 2 + atk(att, x), 0) + att.board.length * 0.3, go: () => { for (const x of att.board) damage(att, x, 1); } }; }
    case "Truth's Sermon": return cmp ? { v: threat + 1.5, go: () => { A.noDeal = true; draw(def, 1); } } : null;
    case 'Plasma Overcharge': return D ? { v: 2 + (ZONE[CARD[D.id].subtype] === D.r ? 1 : 0), go: () => { D.tmpA += 2; if (ZONE[CARD[D.id].subtype] === D.r) D.tmpH += 2; } } : null;
    case 'Grunt Reinforcements': return cells(def).some((x) => x.r === 0) ? { v: complete(def) ? 1 : 2.5, go: () => spawnAny(def, GRUNT, 1, 0, 0) } : null;
    case 'Covering Fire': case 'Shortsword Strike': {
      const n = t === 'Covering Fire' ? 1 : 2;
      const hit = att.board.filter((x) => x.r === A.r);
      const kills = hit.filter((x) => hpMax(att, x) - x.dmg + x.shield <= n);
      return { v: kills.reduce((sum, x) => sum + 2 + atk(att, x), 0) + hit.length * n * 0.3, go: () => { for (const x of hit) damage(att, x, n); } };
    }
    case 'MAC Round': return dmgA(8);
    case 'Holy Wrath': return dmgA(cmp ? 4 : 2);
    case 'Overcharged Shot': return dmgA(CARD[A.id].subtype === 'Vehicle' ? 3 : 1);
    case 'Spore Cloud': return splash(1, 1);
    case 'Frag Out': return splash(2, 1);
    case 'Quarantine Zone': return splash(2, 2);
    case 'Gravity Hammer': return splash(3, 1);
    case "Monitor’s Beam": case 'Deletion Protocol': return { v: 10 + aAtk, go: () => { A.dmg = 999; } };
    case 'Purge Protocol': return hpMax(att, A) - A.dmg <= 4 ? { v: 10 + aAtk, go: () => { A.dmg = 999; } } : null;
    case 'Great Journey': return cmp ? { v: 10 + aAtk, go: () => { A.dmg = 999; } } : null;
    case 'Overrun': return dmgA(def.board.length);
    case 'Point Defense': return D ? { v: threat, go: () => { D.noDmg = true; } } : null;
    case 'Containment Field': case 'Tactical Retreat': return { v: threat, go: () => { A.noDeal = true; } };
    case 'Suppressing Fire': return { v: Math.min(threat, 2), go: () => { A.tmpA -= 2; } };
    case 'Power Drain': return { v: Math.min(threat, 2) + 1, go: () => { A.tmpA -= 2; for (const x of att.board.filter((x) => adj(x, A))) x.tmpA -= 2; } };
    case 'Overshield': return D ? { v: threat * 0.8, go: () => { D.tmpH += 3; } } : null;
    case 'Feral Instinct': return D ? { v: 2, go: () => { D.tmpA += 2; } } : null;
    // non-reactive Tactics, cast at the first window that is worth it
    case 'Field Ration': return def.life <= LIFE - 2 ? { v: 1.5, go: () => heal(def, 2) } : null;
    case 'Field Medic': return def.life <= LIFE - 3 ? { v: 2, go: () => heal(def, 3) } : null;
    case 'Last Stand': return def.life <= LIFE - 6 ? { v: 5, go: () => { heal(def, 6); for (const x of def.board) x.permH += 2; } } : null;
    case 'Reinforcements': return { v: 3, go: () => draw(def, 2) };
    case 'Supply Drop': return { v: 2.5, go: () => { draw(def, 1); heal(def, 2); } };
    case "Gravemind’s Will": { const n = def.board.filter((x) => x.id === IF).length; return n >= 2 ? { v: n, go: () => { for (const x of def.board) if (x.id === IF) { x.permA++; x.permH++; } } } : null; }
    case 'Outbreak': return cells(def).length ? { v: 3, go: () => { let n = 4; for (const v of [...def.board]) { if (n <= 0) break; if (CARD[v.id].faction === 'Flood') { const f = adjCells(def, v); if (f.length) { summon(def, IF, f[0], 0); n--; } } } } } : null;
    case 'Feet First': return { v: 3, go: () => spawnAny(def, MARINE, 2, 0) };
    case 'Activation Index': return def.board.filter((x) => has(CARD[x.id], 'protocol')).length >= 2 ? { v: 4, go: () => { for (const x of def.board) if (has(CARD[x.id], 'protocol')) x.full = true; } } : null;
    case 'Halo Array Pulse': { const mine = def.board.length, theirs = att.board.length; return theirs - mine >= 3 ? { v: 8, go: () => { def.board = []; att.board = []; } } : null; }
  }
  return null;
}

function window(def, att, A, D) {
  let best = null;
  for (const id of new Set(def.hand)) {
    const c = CARD[id]; if (c.type !== 'Tactic' || c.cost > def.res) continue;
    const e = evalTactic(def, att, id, A, D); if (!e || e.v <= 0) continue;
    const score = e.v - c.cost * 0.4;
    if (!best || score > best.score) best = { id, score, e };
  }
  if (best && best.score > 0) playResponse(def, att, best.id, best.e);
}

// Play response card id from def's hand against the declared attack.
function playResponse(def, att, id, e) {
  def.res -= CARD[id].cost; def.hand.splice(def.hand.indexOf(id), 1); notePlayed(GS, { def: { id } });
  note(`${def.name} responds with ${CARD[id].title}.`);
  e.go();
  checkGlory(def, att, 0);
  cleanup(att); cleanup(def);
}

const hpLeft = (q, x) => hpMax(q, x) - x.dmg + x.shield;
// the defender's blocking choice for an attack of strength a by unit u on target (null = hero)
// Rule: only a front-zone unit may block; a side-zone attacker flanks, and only a Sentry Turret may block it.
function canBlock(def, u, x, target) {
  return BLOCK && x.r === 0 && x !== target && (u.r !== 1 || CARD[x.id].title === 'Sentry Turret');
}

function chooseBlocker(def, att, u, a, target) {
  if (!BLOCK) return null;
  const front = def.board.filter((x) => canBlock(def, u, x, target));
  const holds = front.filter((x) => hpLeft(def, x) > a).sort((x, y) => atk(def, y) - atk(def, x));
  if (holds.length) return holds[0];
  if (target && hpLeft(def, target) > a) return null; // target survives anyway
  const cheap = front.sort((x, y) => atk(def, x) - atk(def, y))[0];
  if (!cheap) return null;
  if (!target && def.life <= a) return cheap; // stop lethal
  if (target && atk(def, target) > atk(def, cheap) + 1) return cheap; // save a bigger unit
  return null;
}

// Rule: who may attack this turn — once each (twice with Master Chief's activation), not the turn placed
// unless a card says so, not while stunned, and not with 0 Attack.
function canAttack(p, u, turn) {
  return !u.skip && (!u.attacked || u.extraAtk) && (!SICK || u.placed < turn || ['Spartan Charge', 'Ghost Raider'].includes(CARD[u.id].title) || (CARD[u.id].title === 'Zealot Strike Team' && complete(p))) && atk(p, u) > 0;
}
function markAttacked(u, turn) { if (u.attacked) u.extraAtk = false; u.attacked = true; u.lastAtk = turn; }

// Resolve a declared attack after blocks and responses: attacker strikes first; a lethal hit takes nothing back.
function resolveAttack(p, o, u, target) {
  if (!alive(p, u) || !p.board.includes(u)) return;
  if (target && !o.board.includes(target)) target = null;
  const dealt = u.noDeal ? 0 : atk(p, u);
  if (target) {
    const shielded = !!target.noDmg;
    if (!shielded) damage(o, target, dealt);
    if (alive(o, target)) damage(p, u, atk(o, target));
    delete target.noDmg;
    note(`${CARD[u.id].title} hits ${CARD[target.id].title} for ${shielded ? 0 : dealt}.`);
  } else { const got = heroHit(o, dealt, CARD[u.id].faction === 'Covenant' ? PLASMA : 1); note(`${CARD[u.id].title} hits ${o.name} for ${dealt}${got < dealt ? ` (${dealt - got} to shields)` : ''}.`); }
  delete u.noDeal;
  cleanup(o); cleanup(p);
}

function attackPhase(p, o, turn) {
  const ready = () => p.board.filter((u) => canAttack(p, u, turn));
  let u;
  while ((u = ready()[0])) {
    markAttacked(u, turn);
    const a = atk(p, u);
    const enemyFace = o.board.reduce((s, x) => s + atk(o, x), 0);
    const myFace = ready().reduce((s, x) => s + atk(p, x), 0) + a;
    let target = null;
    if (myFace < heroLeft(o)) {
      const trades = o.board.filter((x) => hpMax(o, x) - x.dmg + x.shield <= a && (atk(o, x) === 0 || true))
        .map((x) => ({ x, safe: true }))
        .sort((m, n) => atk(o, n.x) - atk(o, m.x));
      // trade when racing is losing, or when the kill removes a bigger threat than this unit
      if (trades.length && (enemyFace >= heroLeft(p) / 2 || atk(o, trades[0].x) >= a)) target = trades[0].x;
    }
    const blocker = chooseBlocker(o, p, u, a, target);
    if (blocker && hpLeft(o, blocker) > a && atk(o, blocker) >= hpLeft(p, u)) continue; // would be walled and killed: hold back
    if (blocker) target = blocker;
    window(o, p, u, target);
    resolveAttack(p, o, u, target);
    if (o.life <= 0) return;
  }
}

// What an activated ability does, or null when it has nothing to act on. With bot set, the
// simulator's policy adds its own conditions (only fire for a kill, a crowded zone, a card).
// Targets are chosen by the engine: the enemy unit the effect can kill with the highest Attack, else the highest Attack.
function activationEffect(p, o, u, turn, bot = false) {
  const t = CARD[u.id].title;
  switch (t) {
    case 'Master Chief': return () => { u.extraAtk = true; };
    case 'Carrier Form': { const e = pickEnemy(o, 3); if (!e || (bot && !(hpMax(o, e) - e.dmg + e.shield <= 3 && atk(o, e) >= atk(p, u) - 1))) return null; return () => { u.dmg = 999; damage(o, e, 3); }; }
    case 'Ark Foundry': return cells(p).length ? () => spawnAny(p, SENTINEL, 1, turn) : null;
    case 'Bursting Carrier': { const e = pickEnemy(o, 2); if (!e || (bot && !(hpMax(o, e) - e.dmg + e.shield <= 2))) return null; return () => { u.dmg = 999; damage(o, e, 2); }; }
    case 'Sacrificial Pod': return (!bot || p.hand.length < 4 || p.board.some((v) => has(CARD[v.id], 'consume'))) ? () => { u.dmg = 999; draw(p, 1); } : null;
    case 'Carrier Swarm': { let best = 0, n = -1; for (let r = 0; r < ROWS; r++) { const k = o.board.filter((x) => x.r === r).length; if (k > n) { n = k; best = r; } } return n >= (bot ? 2 : 1) ? () => { u.dmg = 999; for (const x of o.board.filter((x) => x.r === best)) damage(o, x, 2); } : null; }
    case 'Spore Conduit': {
      const fodder = p.board.find((v) => v.id === IF && v !== u) || (bot ? null : p.board.filter((v) => v !== u).sort((x, y) => atk(p, x) - atk(p, y))[0]);
      if (!fodder || (bot && !p.board.some((v) => has(CARD[v.id], 'consume')))) return null;
      return () => { fodder.dmg = 999; draw(p, 1); };
    }
    case 'Pelican Gunship': return cells(p).length ? () => spawnAny(p, MARINE, 1, turn) : null;
    case 'Phantom Dropship': return cells(p).some((x) => x.r === 0) ? () => spawnAny(p, GRUNT, 1, turn, 0) : null;
    case 'Proto-Gravemind': { const f = p.board.find((x) => x.id === IF); return f ? () => { f.dmg = 999; u.permA += 2; } : null; }
    case 'Jackal Sniper': { if (u.r !== 1) return null; const e = pickEnemy(o, 1); return e ? () => damage(o, e, 1) : null; }
    case 'Cartographer': { if (!p.deck.length) return null; const top = CARD[p.deck[p.deck.length - 1]]; if (bot && !(top.cost > p.max + 2)) return null; return () => { if (top.cost > p.max + 2) p.deck.unshift(p.deck.pop()); }; }
  }
  return null;
}

function activate(p, o, turn, budget) {
  const cands = p.board.filter((u) => ACT_COST[CARD[u.id].title] !== undefined && !u.activated && u.placed < turn);
  // most valuable first
  const order = ['Master Chief', 'Carrier Form', 'Bursting Carrier', 'Carrier Swarm', 'Spore Conduit', 'Sacrificial Pod', 'Ark Foundry', 'Pelican Gunship', 'Phantom Dropship', 'Proto-Gravemind', 'Jackal Sniper', 'Cartographer'];
  cands.sort((x, y) => order.indexOf(CARD[x.id].title) - order.indexOf(CARD[y.id].title));
  for (const u of cands) {
    const t = CARD[u.id].title, cost = ACT_COST[t];
    if (cost > budget || !p.board.includes(u)) continue;
    const go = activationEffect(p, o, u, turn, true);
    if (!go) continue;
    budget -= cost; p.res -= cost; u.activated = true; go();
    cleanup(o); cleanup(p);
  }
  return budget;
}

function redeployCost(p, u) {
  let k = CARD[u.id].title === 'Mongoose' ? 0 : 1;
  if (p.board.some((v) => CARD[v.id].title === 'Captain Keyes')) k = Math.max(0, k - 1);
  return k;
}

// Where a unit moving for its own sake goes: next to a partner for combined arms, else
// the nearest empty cell in the same zone, else anywhere.
function moveTarget(p, u) {
  const free = cells(p); if (!free.length) return null;
  const partner = (x) => (isUnscVehicle(u) ? p.board.some((v) => v !== u && isInfantry(v) && adj(x, v)) : p.board.some((v) => v !== u && isUnscVehicle(v) && adj(x, v)));
  const scored = free.map((x) => ({ x, s: (partner(x) ? 10 : 0) + (x.r === u.r ? 3 : 0) - Math.abs(x.c - u.c) * 0.1 }));
  scored.sort((m, n) => n.s - m.s);
  return scored[0].x;
}

// What a unit's Rally does when it Redeploys.
function rally(p, o, u, turn) {
  const t = CARD[u.id].title;
  switch (t) {
    case 'ODST Drop Squad': u.tmpA += 1; break;
    case 'Warthog Gunner': { const e = pickEnemy(o, 1); if (e) damage(o, e, 1); break; }
    case 'Shock Trooper': u.permH += 1; break;
    case 'Siege Hornet': { let best = 0, n = -1; for (let r = 0; r < ROWS; r++) { const k = o.board.filter((x) => x.r === r).length; if (k > n) { n = k; best = r; } } for (const x of o.board.filter((x) => x.r === best)) damage(o, x, 1); break; }
    case 'Supply Runner': { draw(p, 1); if (p.hand.length) { const worst = p.hand.reduce((m, id) => (CARD[id].cost > CARD[m].cost ? id : m)); p.hand.splice(p.hand.indexOf(worst), 1); } break; }
    case 'Overwatch Team': for (const v of p.board) if (CARD[v.id].subtype === 'Vehicle') v.tmpA += 1; break;
    case "Johnson's Warthog": heroHit(o, 2); break;
    case 'Hornet Squadron': u.tmpA += 2; break;
    case 'ONI Agent': if (p.deck.length) { const top = CARD[p.deck[p.deck.length - 1]]; if (top.cost > p.max + 2) p.deck.unshift(p.deck.pop()); } break;
    default: return false;
  }
  cleanup(o);
  return true;
}

// One Redeploy: pay, move, then Cortana's draw, Lord Hood's growth and the unit's Rally.
function doRedeploy(p, o, u, to, turn, cost) {
  p.res -= cost; u.r = to.r; u.c = to.c; u.moved = true;
  if (!p.cortanaDrew && p.board.some((v) => CARD[v.id].title === 'Cortana')) { p.cortanaDrew = true; draw(p, 1); }
  const hoods = p.board.filter((v) => CARD[v.id].title === 'Lord Hood').length;
  u.permA += hoods; u.permH += hoods;
  if (has(CARD[u.id], 'rally') && rally(p, o, u, turn)) {
    note(`${CARD[u.id].title}: Rally.`);
    if (!p.fragmentUsed && p.board.some((v) => CARD[v.id].title === "Cortana's Fragment")) { p.fragmentUsed = true; rally(p, o, u, turn); }
  }
}

function redeploy(p, o, turn, budget) {
  const canMove = (u) => has(CARD[u.id], 'redeploy') && !u.moved && redeployCost(p, u) <= budget;
  const cortana = () => !p.cortanaDrew && p.board.some((v) => CARD[v.id].title === 'Cortana');
  const move = (u, to) => { const k = redeployCost(p, u); budget -= k; doRedeploy(p, o, u, to, turn, k); };
  // pair each unpaired UNSC Vehicle with infantry: move the Vehicle, or bring a spare infantry unit to it
  for (const v of p.board.filter((x) => isUnscVehicle(x) && !paired(p, x))) {
    if (canMove(v)) {
      const spot = p.board.filter((x) => x !== v && isInfantry(x)).map((x) => adjCells(p, x)[0]).find(Boolean);
      if (spot) { move(v, spot); continue; }
    }
    // an infantry unit is spare if no paired Vehicle relies on it alone
    const spare = (x) => !p.board.some((w) => w !== v && isUnscVehicle(w) && adj(w, x) && !p.board.some((z) => z !== x && adj(w, z) && isInfantry(z)));
    const inf = p.board.find((x) => isInfantry(x) && canMove(x) && spare(x));
    const spot = adjCells(p, v)[0];
    if (inf && spot) move(inf, spot);
  }
  // Rally: move every unit whose Rally pays, cheapest first, while resource lasts
  for (const u of p.board.filter((x) => has(CARD[x.id], 'rally')).sort((x, y) => redeployCost(p, x) - redeployCost(p, y))) {
    if (!canMove(u) || !p.board.includes(u)) continue;
    const to = moveTarget(p, u); if (to) move(u, to);
  }
  // Cortana: one paid move a turn draws a card
  if (cortana()) { const u = p.board.find(canMove); const to = u && cells(p)[0]; if (u && to) move(u, to); }
}

function mainPhase(p, o, turn) {
  // the Coin: spend it the first time it lets a unit in hand be played that otherwise could not
  if (p.coin && p.hand.some((id) => CARD[id].type === 'Unit' && CARD[id].cost === p.res + 1)) { p.coin = false; p.res += 1; }
  if (SMART && p.max < CAP && !p.hand.some((id) => CARD[id].type === 'Unit' && CARD[id].cost <= p.res)
      && !p.board.some((u) => ACT_COST[CARD[u.id].title] !== undefined && u.placed < turn && ACT_COST[CARD[u.id].title] <= p.res)) {
    p.skipped = true; return;
  }
  const tactics = p.hand.filter((id) => CARD[id].type === 'Tactic').map((id) => CARD[id].cost);
  const reserve = tactics.length ? Math.min(...tactics) : 0;
  let played = true;
  while (played) {
    played = false;
    const budget = p.res - (p.res > reserve ? reserve : 0);
    const opts = p.hand.filter((id) => CARD[id].type === 'Unit' && CARD[id].cost <= budget).sort((x, y) => CARD[y].cost - CARD[x].cost);
    for (const id of opts) {
      if (!cells(p).length) break;
      p.res -= CARD[id].cost; p.hand.splice(p.hand.indexOf(id), 1); notePlayed(GS, { def: { id } });
      const u = summon(p, id, null, turn); if (u) onPlace(p, o, u, turn);
      checkGlory(p, o, turn);
      played = true; break;
    }
  }
  const spare = p.res - (p.res > reserve ? reserve : 0);
  const left = activate(p, o, turn, spare);
  if (SMART) redeploy(p, o, turn, left);
}

// One game. Returns the winner (0 = deck A, 1 = deck B, -1 = no winner by the turn cap),
// the total turns, and a state the coverage tally reads.
export function playGame(dA, dB, firstA, { seed: s = 1 } = {}) {
  seed = s;
  GS = { cardStats: {}, zones: {} };
  const P = [newPlayer(dA, 'A'), newPlayer(dB, 'B')];
  P[0].opp = P[1]; P[1].opp = P[0];
  P.forEach((p, i) => { GS.zones[`${i}:deck`] = { cards: p.deck.map((id) => ({ def: { id } })) }; });
  const r = game(P, firstA);
  return { ...r, state: GS, life: P.map((p) => p.life) };
}

// Setup: opening hands, and the second player starts one resource step ahead.
function setupGame(P, cur) {
  draw(P[cur], HAND); draw(P[1 - cur], HAND + EXTRA);
  P[0].hshield = P[1].hshield = HSHIELD;
  P[cur].max = START;
  if (COIN) P[1 - cur].coin = true;
  P[1 - cur].max = START + AHEAD;
}

// Start of a turn: reset per-turn state, grow and refill resource, draw (Fatigue on an empty deck),
// then start-of-turn effects. Returns false if the draw killed the active player.
function beginTurn(p, o, turn) {
  for (const u of p.board) { u.tmpA = 0; u.tmpH = 0; u.attacked = false; u.extraAtk = false; u.activated = false; u.moved = false; u.skip = !!u.stunned; u.stunned = false; }
  p.cortanaDrew = false; p.fragmentUsed = false; p.turnNo = turn;
  for (const u of o.board) { u.tmpA = 0; u.tmpH = 0; }
  p.hshield = HSHIELD + (p.breakBonus ? BREAKSHIELD : 0); p.broke = false; o.broke = false;
  p.max = Math.min(CAP, p.max + (p.skipped ? SKIP : GROW)); p.res = p.max + (p.breakBonus ? BREAKRES : 0); p.breakBonus = false; p.skipped = false;
  draw(p, DRAW); if (p.life <= 0) return false;
  startOfTurn(p, o, turn); cleanup(p); cleanup(o); checkGlory(p, o, turn);
  return true;
}

function game(P, firstA) {
  let cur = firstA ? 0 : 1;
  setupGame(P, cur);
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const p = P[cur], o = P[1 - cur];
    if (!beginTurn(p, o, turn)) return { winner: 1 - cur, turn };
    mainPhase(p, o, turn);
    attackPhase(p, o, turn);
    checkGlory(p, o, turn); checkGlory(o, p, turn);
    if (o.life <= 0) return { winner: cur, turn };
    if (p.life <= 0) return { winner: 1 - cur, turn };
    cur = 1 - cur;
  }
  return { winner: -1, turn: MAX_TURNS };
}



// ---------------------------------------------------------------------------
// THE PLAY CONTRACT — what play.html calls: meta, newGame, view, legalMoves, apply, isOver, metrics.
//
// It drives the same rule functions the simulator does (beginTurn, canAttack, canBlock,
// resolveAttack, playResponse, activationEffect, doRedeploy, onPlace, checkGlory), one
// player decision at a time. The decks come from match.js; `node sim/set-match.mjs` changes them.
//
// Simplifications the client makes, on top of the simulator's own list:
//  - A placed or redeployed unit goes into the leftmost empty cell of the zone the player picks.
//  - Targets of automatic effects (Glory, Rally, Awaken, when-placed and activations) are picked
//    by the engine: the enemy unit the effect can kill with the highest Attack, else the highest Attack.
//  - One response per declared attack, and no mulligan.
// ---------------------------------------------------------------------------

import { defaultView, defaultMetrics } from './engine-kit.js';

export const meta = { name: 'Halo TCG', players: [2, 2], seats: 2, seatNames: ['Player 1', 'Player 2'] };

const ROWNAME = ['front', 'side', 'back'];
const deckById = (id) => J.touchstones.decks.find((d) => d.id === id);

// Run fn with the engine's per-game globals pointed at this state, then hand them back.
function inGame(state, fn) {
  seed = state.rng; GS = state.gs; LOG = state.log;
  const link = () => { if (state.P) { state.P[0].opp = state.P[1]; state.P[1].opp = state.P[0]; } };
  link();
  try { return fn(); } finally { state.rng = seed; if (state.P) { delete state.P[0].opp; delete state.P[1].opp; } LOG = null; }
}

const unitByUid = (p, uid) => p.board.find((u) => u.uid === +uid);
const freeCellIn = (p, r) => cells(p).filter((x) => x.r === r).sort((x, y) => x.c - y.c)[0] ?? null;

// The game has ended once a hero is at 0 or below; the active player wins ties they caused.
function checkOver(s) {
  const [a, b] = s.P;
  if (a.life <= 0 || b.life <= 0) {
    s.over = true;
    s.winner = a.life <= 0 && b.life <= 0 ? s.cur : (a.life <= 0 ? 1 : 0);
    s.log.push(`${s.P[s.winner].name} wins.`);
  }
  return s.over;
}

// match and names are optional: the online lobby deals each room its own two decks and player names.
export function newGame({ seed: sd = 1, firstPlayer = 0, match = MATCH, names = null } = {}) {
  const decks = match.map(deckById);
  if (decks.some((d) => !d)) throw new Error(`Unknown deck in match: ${match.join(", ")}`);
  const st = { P: null, cur: firstPlayer, match: [...match], turn: 1, phase: 'main', rng: sd, gs: { cardStats: {}, zones: {} }, log: [], over: false, winner: null, pending: null, last: null };
  inGame(st, () => {
    st.P = decks.map((d, i) => { const pl = newPlayer(d, `${names?.[i] || meta.seatNames[i]} — ${d.name}`); return pl; });
    st.P.forEach((pl, i) => { st.gs.zones[`${i}:deck`] = { cards: pl.deck.map((id) => ({ def: { id } })) }; });
    const [a, b] = st.P; a.opp = b; b.opp = a;
    setupGame(st.P, st.cur);
    st.log.push(`Game begins (seed ${sd}). ${st.P[st.cur].name} goes first; the other player starts one resource step ahead.`);
    beginTurn(st.P[st.cur], st.P[1 - st.cur], st.turn);
  });
  st.P.forEach((pl) => { pl.didMain = false; });
  st.seats = [0, 1]; st.active = activeSeat(st);   // read by Merlin's trial loop and testflight
  return st;
}

// Who must act: the turn player, except while a declared attack waits on the defender.
const activeSeat = (s) => (s.phase === 'block' || s.phase === 'respond' ? 1 - s.cur : s.cur);

// With { cells: true }, play and redeploy moves name an exact cell (play:i:r:c, move:uid:r:c)
// instead of a zone; placement anywhere empty is legal either way.
export function legalMoves(state, seat, { cells: byCell = false } = {}) {
  if (state.over || seat !== activeSeat(state)) return [];
  const moves = [];
  inGame(state, () => {
    const p = state.P[state.cur], o = state.P[1 - state.cur], turn = state.turn;
    if (state.phase === 'main') {
      p.hand.forEach((id, i) => {
        const c = CARD[id];
        if (c.type !== 'Unit' || c.cost > p.res) return;
        if (byCell) { for (const x of cells(p)) moves.push({ id: `play:${i}:${x.r}:${x.c}`, label: `Play ${c.title} (${c.cost}) to ${ROWNAME[x.r]} ${x.c + 1}`, group: 'Play a unit', cards: [`h${state.cur}-${i}`] }); }
        else for (let r = 0; r < ROWS; r++) if (freeCellIn(p, r)) moves.push({ id: `play:${i}:${r}`, label: `Play ${c.title} (${c.cost}) to your ${ROWNAME[r]} zone`, group: 'Play a unit', cards: [`h${state.cur}-${i}`] });
      });
      for (const u of p.board) {
        const t = CARD[u.id].title, cost = ACT_COST[t];
        if (cost !== undefined && !u.activated && u.placed < turn && cost <= p.res && activationEffect(p, o, u, turn, false)) {
          moves.push({ id: `act:${u.uid}`, label: `Activate ${t} (pay ${cost})`, group: 'Activate', cards: [`u${u.uid}`] });
        }
        if (has(CARD[u.id], 'redeploy') && !u.moved && redeployCost(p, u) <= p.res) {
          if (byCell) { for (const x of cells(p)) moves.push({ id: `move:${u.uid}:${x.r}:${x.c}`, label: `Redeploy ${t} to ${ROWNAME[x.r]} ${x.c + 1} (pay ${redeployCost(p, u)})`, group: 'Redeploy', cards: [`u${u.uid}`] }); }
          else for (let r = 0; r < ROWS; r++) if (freeCellIn(p, r)) moves.push({ id: `move:${u.uid}:${r}`, label: `Redeploy ${t} to your ${ROWNAME[r]} zone (pay ${redeployCost(p, u)})`, group: 'Redeploy', cards: [`u${u.uid}`] });
        }
      }
      if (!p.didMain) moves.push({ id: 'skip', label: `Skip your Main step (+${SKIP} resource growth next turn)`, group: 'Turn' });
      moves.push({ id: 'combat', label: 'Go to combat', group: 'Turn', tone: 'primary' });
    } else if (state.phase === 'combat') {
      for (const u of p.board) {
        if (!canAttack(p, u, turn)) continue;
        const t = CARD[u.id].title;
        moves.push({ id: `atk:${u.uid}:hero`, label: `${t} (${atk(p, u)}) attacks ${o.name.split(' — ')[0]}`, group: 'Attack', cards: [`u${u.uid}`], tone: 'primary' });
        for (const x of o.board) moves.push({ id: `atk:${u.uid}:${x.uid}`, label: `${t} (${atk(p, u)}) attacks ${CARD[x.id].title} (${atk(o, x)}/${hpLeft(o, x)})`, group: 'Attack', cards: [`u${u.uid}`, `u${x.uid}`] });
      }
      moves.push({ id: 'end', label: 'End turn', group: 'Turn' });
    } else if (state.phase === 'block') {
      const u = unitByUid(p, state.pending.a), target = state.pending.t == null ? null : unitByUid(o, state.pending.t);
      for (const x of o.board) if (canBlock(o, u, x, target)) moves.push({ id: `block:${x.uid}`, label: `Block with ${CARD[x.id].title} (${atk(o, x)}/${hpLeft(o, x)})`, group: 'Block', cards: [`u${x.uid}`] });
      moves.push({ id: 'noblock', label: 'Do not block', group: 'Block' });
    } else if (state.phase === 'respond') {
      const u = unitByUid(p, state.pending.a), target = state.pending.t == null ? null : unitByUid(o, state.pending.t);
      o.hand.forEach((id, i) => {
        const c = CARD[id];
        if (c.type !== 'Tactic' || c.cost > o.res) return;
        if (!evalTactic(o, p, id, u, target)) return;
        moves.push({ id: `resp:${i}`, label: `Play ${c.title} (${c.cost})`, group: 'Respond', cards: [`h${1 - state.cur}-${i}`] });
      });
      moves.push({ id: 'pass', label: 'No response', group: 'Respond', tone: 'primary' });
    }
  });
  return moves;
}

// Placement hints for the table: for a hand unit (h<seat>-<i>) or a Redeploy unit (u<uid>), what
// each empty cell is worth. The unit is tried in every cell and taken back again, so the gain is
// the rules' own arithmetic: total Attack + Health on the seat's board, against the worst cell.
// `formation` marks a cell that completes the Covenant formation (Glory fires there).
export function placementHints(state, seat, card) {
  if (state.over || seat !== state.cur || state.phase !== 'main') return [];
  return inGame(state, () => {
    const p = state.P[seat];
    const total = () => p.board.reduce((s, v) => s + atk(p, v) + hpMax(p, v), 0);
    const glory = () => p.board.some((v) => has(CARD[v.id], 'glory') && !v.gloried);
    let place, undo;
    if (card.startsWith('h')) {
      const id = p.hand[+card.split('-')[1]];
      if (!id || CARD[id].type !== 'Unit') return [];
      const uid = GS.uid;
      place = (x) => summon(p, id, x, state.turn);
      undo = () => { p.board.pop(); GS.uid = uid; };
    } else {
      const u = unitByUid(p, card.slice(1)); if (!u) return [];
      const home = { r: u.r, c: u.c };
      place = (x) => { u.r = x.r; u.c = x.c; };
      undo = () => { u.r = home.r; u.c = home.c; };
    }
    const was = complete(p);
    const out = cells(p).map((x) => {
      place(x);
      const v = { r: x.r, c: x.c, value: total(), formation: !was && complete(p), glory: !was && complete(p) && glory() };
      undo(); return v;
    });
    const floor = Math.min(...out.map((v) => v.value));
    const best = Math.max(...out.map((v) => v.value));
    return out.map(({ value, ...v }) => ({ ...v, gain: value - floor, best: value === best && best > floor }));
  });
}

export function apply(state, intent) {
  if (state.over) return { ok: false, reason: 'The game is over.' };
  if (intent.seat !== activeSeat(state)) return { ok: false, reason: `It is not your move — ${state.P[activeSeat(state)].name} must act.` };
  if (![...legalMoves(state, intent.seat), ...legalMoves(state, intent.seat, { cells: true })].some((m) => m.id === intent.id)) return { ok: false, reason: `"${intent.id}" is not a legal move now.` };
  const s = structuredClone(state);
  const [kind, x, y, z] = intent.id.split(':');
  const cellOf = (pl) => (z === undefined ? freeCellIn(pl, +y) : { r: +y, c: +z });
  inGame(s, () => {
    const p = s.P[s.cur], o = s.P[1 - s.cur], turn = s.turn;
    if (kind === 'play') {
      const id = p.hand[+x], r = +y;
      p.res -= CARD[id].cost; p.hand.splice(+x, 1); notePlayed(GS, { def: { id } }); p.didMain = true;
      s.log.push(`${p.name} plays ${CARD[id].title} to the ${ROWNAME[r]} zone.`);
      const u = summon(p, id, cellOf(p), turn); if (u) onPlace(p, o, u, turn);
      checkGlory(p, o, turn);
    } else if (kind === 'act') {
      const u = unitByUid(p, x), cost = ACT_COST[CARD[u.id].title];
      p.res -= cost; u.activated = true; p.didMain = true;
      s.log.push(`${p.name} activates ${CARD[u.id].title}.`);
      activationEffect(p, o, u, turn, false)(); cleanup(o); cleanup(p); checkGlory(p, o, turn);
    } else if (kind === 'move') {
      const u = unitByUid(p, x); p.didMain = true;
      s.log.push(`${p.name} redeploys ${CARD[u.id].title} to the ${ROWNAME[+y]} zone.`);
      doRedeploy(p, o, u, cellOf(p), turn, redeployCost(p, u)); checkGlory(p, o, turn);
    } else if (kind === 'skip') {
      p.skipped = true; s.phase = 'combat';
      s.log.push(`${p.name} skips the Main step (+${SKIP} growth next turn).`);
    } else if (kind === 'combat') {
      s.phase = 'combat';
    } else if (kind === 'atk') {
      const u = unitByUid(p, x); markAttacked(u, turn);
      s.pending = { a: u.uid, t: y === 'hero' ? null : +y };
      s.log.push(`${CARD[u.id].title} attacks ${y === 'hero' ? o.name : CARD[unitByUid(o, y).id].title}.`);
      s.phase = 'block';
    } else if (kind === 'block') {
      const b = unitByUid(o, x); s.pending.t = b.uid;
      s.log.push(`${o.name} blocks with ${CARD[b.id].title}.`);
      s.phase = 'respond';
    } else if (kind === 'noblock') {
      s.phase = 'respond';
    } else if (kind === 'resp' || kind === 'pass') {
      const u = unitByUid(p, s.pending.a), target = s.pending.t == null ? null : unitByUid(o, s.pending.t);
      if (kind === 'resp') { const id = o.hand[+x]; playResponse(o, p, id, evalTactic(o, p, id, u, target)); }
      if (u) resolveAttack(p, o, u, target);
      checkGlory(p, o, turn); checkGlory(o, p, turn);
      s.last = { seat: s.cur, text: s.log.slice(-3).join(' ') };
      s.pending = null; s.phase = 'combat';
    } else if (kind === 'end') {
      checkGlory(p, o, turn); checkGlory(o, p, turn);
      s.log.push(`${p.name} ends the turn.`);
      if (!checkOver(s)) {
        s.cur = 1 - s.cur; s.turn += 1; s.phase = 'main';
        const np = s.P[s.cur]; np.didMain = false;
        if (!beginTurn(np, s.P[1 - s.cur], s.turn)) s.log.push(`${np.name} takes Fatigue damage.`);
      }
    }
    checkOver(s);
  });
  s.active = activeSeat(s);
  return { ok: true, state: s };
}

export const isOver = (state) => !!state.over;

// One unit, as a card the client can draw: Attack/Health now, and what it is doing.
function unitCard(state, owner, u) {
  return inGame(state, () => {
    const p = state.P[owner], c = CARD[u.id];
    const flags = [];
    if (owner === state.cur && canAttack(p, u, state.turn) && state.phase !== 'main') flags.push('ready to attack');
    if (u.placed === state.turn && owner === state.cur) flags.push('placed this turn');
    if (has(c, 'protocol')) flags.push(`Protocol +${u.full ? 3 : Math.min(3, inPlaceOf(p, u) * protoRate(p))}`);
    if (u.shield) flags.push(`shield ${u.shield}`);
    return { id: `u${u.uid}`, def: { title: c.title, badge: `${atk(p, u)}/${hpLeft(p, u)}`, type: c.type, subtype: c.subtype, text: [c.text, (c.abilities || []).join(', '), flags.join(' · ')].filter(Boolean).join(' — '), stats: c.stats } };
  });
}

export function view(state, seat) {
  const zones = {};
  state.P.forEach((p, i) => {
    zones[`${i}:hand`] = { id: `${i}:hand`, kind: 'hand', label: 'hand', owner: i, visibility: 'owner', cards: p.hand.map((id, k) => ({ id: `h${i}-${k}`, def: { ...CARD[id], badge: String(CARD[id].cost) } })) };
    zones[`${i}:deck`] = { id: `${i}:deck`, kind: 'deck', label: 'deck', owner: i, visibility: 'secret', cards: p.deck.map(() => ({})) };
    for (let r = 0; r < ROWS; r++) {
      zones[`${i}:${ROWNAME[r]}`] = { id: `${i}:${ROWNAME[r]}`, kind: `${ROWNAME[r]} zone`, label: `${ROWNAME[r]} zone`, owner: i, visibility: 'public', lane: ROWNAME[r],
        cards: p.board.filter((u) => u.r === r).sort((a, b) => a.c - b.c).map((u) => unitCard(state, i, u)) };
    }
  });
  const ks = { seats: state.P.map((p) => ({ name: p.name, counters: {} })), zones, turn: state.turn, phase: state.phase, active: activeSeat(state), over: state.over, winner: state.winner, log: state.log };
  const foe = 1 - seat, me = state.P[seat], them = state.P[foe];
  const phaseLabel = { main: 'Main step — play, activate, redeploy', combat: 'Combat — declare attacks', block: 'Block — choose a front-zone blocker', respond: 'Response window' }[state.phase];
  const v = defaultView(ks, seat, {
    stats: [
      { label: 'Your life', value: me.life, seat },
      { label: 'Your resource', value: `${me.res} / ${me.max}${me.skipped ? ' (skipping: +' + SKIP + ' next)' : ''}`, seat },
      { label: 'Your deck', value: me.deck.length, seat },
      { label: `${them.name.split(' — ')[0]} life`, value: them.life, seat: foe },
      { label: `${them.name.split(' — ')[0]} resource`, value: `${them.res} / ${them.max}`, seat: foe },
    ],
    fields: {
      opponentName: them.name,
      turnLabel: 'Turn',
      phaseLabel,
      recap: state.last && state.last.seat !== seat ? { text: state.last.text, winnerSeat: state.last.seat, cards: [] } : null,
    },
  });
  for (const z of v.zones) if (/front|side|back/.test(z.id)) z.placeholder = 'empty';
  v.table = tableView(state, seat);
  return v;
}

// The table as a drag-and-drop client draws it: both boards cell by cell (public), the
// viewer's own hand in full, the opponent's hand as a count, and the attack in progress.
// Presentation of state the rules already hold; nothing here decides anything.
function tableView(state, seat) {
  return inGame(state, () => {
    const unit = (owner, u) => {
      const pl = state.P[owner], c = CARD[u.id];
      const info = unitCard(state, owner, u);
      return { id: `u${u.uid}`, uid: u.uid, r: u.r, c: u.c, title: c.title, attack: atk(pl, u), health: hpLeft(pl, u), type: c.type, subtype: c.subtype ?? null, faction: c.faction,
        text: c.text, keywords: c.abilities ?? [], status: info.def.text.split(' — ').slice(-1)[0], fresh: u.placed === state.turn && owner === state.cur,
        ready: owner === state.cur && state.phase === 'combat' && canAttack(pl, u, state.turn) };
    };
    return {
      rows: ROWS, cols: COLS, rowNames: ROWNAME, cur: state.cur, active: activeSeat(state), phase: state.phase, turn: state.turn,
      heroes: state.P.map((pl, i) => ({ seat: i, name: pl.name, life: pl.life, shield: pl.hshield || 0, shieldMax: HSHIELD, res: pl.res, max: pl.max, deck: pl.deck.length, hand: pl.hand.length, skipping: !!pl.skipped })),
      boards: state.P.map((pl, i) => pl.board.map((u) => unit(i, u))),
      hand: state.P[seat].hand.map((id, k) => { const c = CARD[id]; return { id: `h${seat}-${k}`, title: c.title, cost: c.cost, type: c.type, subtype: c.subtype ?? null, faction: c.faction, stats: c.stats || null, text: c.text, keywords: c.abilities ?? [] }; }),
      pending: state.pending ? { attacker: `u${state.pending.a}`, target: state.pending.t == null ? 'hero' : `u${state.pending.t}` } : null,
      over: state.over, winner: state.winner,
    };
  });
}

export function metrics(state) {
  return { turns: state.turn, winner: state.winner, naturalEnd: !!state.over, life: state.P.map((p) => p.life), decks: state.match ?? MATCH };
}

// The simulator's own greedy policy, asked for one decision. policies.js hands it to the client.
export function botMove(state, seat) {
  const legal = legalMoves(state, seat).map((m) => m.id);
  if (!legal.length) return null;
  const s = structuredClone(state);
  return inGame(s, () => {
    const p = s.P[s.cur], o = s.P[1 - s.cur], turn = s.turn;
    const pick = (id) => (legal.includes(id) ? id : null);
    if (s.phase === 'main') {
      if (!p.didMain && p.max < CAP && !p.hand.some((id) => CARD[id].type === 'Unit' && CARD[id].cost <= p.res)
        && !p.board.some((u) => ACT_COST[CARD[u.id].title] !== undefined && u.placed < turn && ACT_COST[CARD[u.id].title] <= p.res)) return 'skip';
      const tactics = p.hand.filter((id) => CARD[id].type === 'Tactic').map((id) => CARD[id].cost);
      const reserve = tactics.length ? Math.min(...tactics) : 0;
      const budget = p.res - (p.res > reserve ? reserve : 0);
      const opts = p.hand.map((id, i) => [id, i]).filter(([id]) => CARD[id].type === 'Unit' && CARD[id].cost <= budget).sort((x, y) => CARD[y[0]].cost - CARD[x[0]].cost);
      for (const [id, i] of opts) { const cell = bestCell(p, CARD[id]); const m = cell && pick(`play:${i}:${cell.r}`); if (m) return m; }
      for (const u of p.board) { const cost = ACT_COST[CARD[u.id].title]; if (cost !== undefined && cost <= budget && activationEffect(p, o, u, turn, true)) { const m = pick(`act:${u.uid}`); if (m) return m; } }
      for (const u of p.board.filter((x) => has(CARD[x.id], 'rally'))) { const to = moveTarget(p, u); const m = to && pick(`move:${u.uid}:${to.r}`); if (m && to.r !== u.r) return m; }
      return 'combat';
    }
    if (s.phase === 'combat') {
      for (const u of p.board.filter((x) => canAttack(p, x, turn))) {
        const a = atk(p, u);
        const trades = o.board.filter((x) => hpLeft(o, x) <= a).sort((m, n) => atk(o, n) - atk(o, m));
        const enemyFace = o.board.reduce((sum, x) => sum + atk(o, x), 0);
        const target = trades.length && (enemyFace >= heroLeft(p) / 2 || atk(o, trades[0]) >= a) ? trades[0] : null;
        const blocker = chooseBlocker(o, p, u, a, target);
        if (blocker && hpLeft(o, blocker) > a && atk(o, blocker) >= hpLeft(p, u)) continue;
        const m = pick(`atk:${u.uid}:${target ? target.uid : 'hero'}`); if (m) return m;
      }
      return 'end';
    }
    const u = unitByUid(p, s.pending.a), target = s.pending.t == null ? null : unitByUid(o, s.pending.t);
    if (s.phase === 'block') { const b = chooseBlocker(o, p, u, atk(p, u), target); return (b && pick(`block:${b.uid}`)) || 'noblock'; }
    let best = null;
    o.hand.forEach((id, i) => {
      const c = CARD[id]; if (c.type !== 'Tactic' || c.cost > o.res) return;
      const e = evalTactic(o, p, id, u, target); if (!e || e.v <= 0) return;
      const score = e.v - c.cost * 0.4; if (!best || score > best.score) best = { i, score };
    });
    return (best && best.score > 0 && pick(`resp:${best.i}`)) || 'pass';
  });
}
