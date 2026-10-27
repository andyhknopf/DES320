// ---------------------------------------------------------------------------
// ENGINE KIT — the constructs almost every card game needs, so your engine.js
// only has to contain what makes your game different.
//
// **No interview runs this**. It is the scaffolding a design's own
// `engine.js` imports, and every family template builds on it.
//
// Nothing here knows any rules. It provides zones, cards, counters, seats,
// phases, a seeded RNG, and — the part worth having — a `defaultView` that
// derives the seat-scoped projection from each zone's declared visibility.
// Get the visibility declarations right once and hidden information cannot
// leak, rather than relying on every future view change to remember.
//
// Purity rules, inherited by anything built on this: no I/O, no DOM, no
// Date.now(), no Math.random(). Same seed, same game, forever.
//
// **The words this emits are American English** -- `docs/american-english.md`.
// Its band labels are read far more often than the numbers behind them.
// ---------------------------------------------------------------------------

// --- randomness --------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function createRNG(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- visibility --------------------------------------------------------------

/**
 * How much of a zone a non-owner may learn.
 *   PUBLIC  — everyone sees every card (play areas, discard, shared board)
 *   OWNER   — owner sees cards, everyone else sees only the count (hand)
 *   SECRET  — nobody sees cards, everyone sees the count (deck)
 *   NONE    — nobody sees cards and the count is withheld too (facedown pile)
 * A card's own `facedown` flag downgrades it to hidden regardless of zone.
 */
export const VIS = { PUBLIC: 'public', OWNER: 'owner', SECRET: 'secret', NONE: 'none' };

// --- zones -------------------------------------------------------------------

/**
 * Declare a zone. `owner` is a seat index, or null for a shared zone.
 * `ordered: true` means position matters (a deck); false means it's a set.
 */
export function defineZone({
  id, label, kind = null, owner = null, visibility = VIS.PUBLIC, ordered = false,
  lane = null, display = null,
}) {
  // `kind` ("hand", "deck", "play"…) lets the view label a zone relative to
  // whoever is looking — "Your hand" rather than "Player 1 hand" — which the
  // client needs in order to tell your zones from an opponent's.
  //
  // `lane` is how a game with more than one battlefield gets laid out
  // correctly. Zones sharing a lane are drawn as one facing band across the
  // table — yours on your side, the opponent's opposite, a shared one in the
  // middle. A game with a front line and a support row declares two lanes and
  // the client renders two bands, in declaration order, without knowing what
  // either means. Zones with no lane sit on their owner's side as usual.
  //
  // `display` overrides how much room a zone gets: "panel" (full cards),
  // "mini" (compact cards), "chip" (a count). Default follows `kind`.
  return { id, label: label ?? id, kind, owner, visibility, ordered, lane, display, cards: [] };
}

/**
 * The conventional per-seat zone set. Override or extend freely — nothing
 * below assumes these exist by name except the helpers that take a zone id.
 */
export function standardSeatZones(seat, name) {
  return [
    defineZone({ id: `${seat}:deck`, kind: 'deck', label: `${name} deck`, owner: seat, visibility: VIS.SECRET, ordered: true }),
    defineZone({ id: `${seat}:hand`, kind: 'hand', label: `${name} hand`, owner: seat, visibility: VIS.OWNER }),
    defineZone({ id: `${seat}:play`, kind: 'play area', label: `${name} play area`, owner: seat, visibility: VIS.PUBLIC, lane: 'play' }),
    defineZone({ id: `${seat}:discard`, kind: 'discard', label: `${name} discard`, owner: seat, visibility: VIS.PUBLIC, ordered: true }),
    defineZone({ id: `${seat}:exile`, kind: 'exile', label: `${name} exile`, owner: seat, visibility: VIS.PUBLIC }),
  ];
}

/** Zones every seat shares — the common play area, and anything like it. */
export function standardSharedZones() {
  return [
    defineZone({ id: 'shared:play', label: 'Common play area', owner: null, visibility: VIS.PUBLIC }),
  ];
}

// --- cards -------------------------------------------------------------------

let _uid = 0;
/** Reset between games so ids are reproducible from a seed. */
export function resetCardIds() { _uid = 0; }

/**
 * An instance of a card definition. `def` is your card data (title, cost,
 * text…); everything mutable about the instance lives beside it.
 */
export function makeCard(def, id = null) {
  return {
    id: id ?? `c${++_uid}`,
    def,
    counters: {},      // { damage: 2, charge: 1, … }
    tapped: false,
    facedown: false,
    attachments: [],   // card ids attached to this one
    // A HOLDER ONLY IF IT SAYS SO. `holds: 3` on the def makes this a carrier
    // with room for three; `holds: true` is unlimited. Absent -- which is every
    // card that has ever existed in this kit -- and it carries nothing.
    ...(def?.holds != null ? { holds: def.holds, cargo: [] } : {}),
  };
}

export function makeDeck(defs, { copies = 1 } = {}) {
  const out = [];
  for (const d of defs) {
    const n = copies === 'count' ? (Number(d.count) || 1) : copies;
    for (let i = 0; i < n; i++) out.push(makeCard(d));
  }
  return out;
}

// --- counters (work on a card OR a seat) -------------------------------------

export function getCounter(target, kind) { return target.counters?.[kind] ?? 0; }
/**
 * NOTE THAT ZERO DELETES THE KEY. That keeps a tableau tidy — a card with no
 * +1 counters carries no `plus` key rather than a zero — but it means
 * `target.counters.x` reads `undefined` for a counter that has been spent to
 * exactly zero. **Always read through `getCounter()`**, which returns 0.
 * Comparisons against `undefined` are false, so a direct read turns 'can you
 * afford it' into 'yes' and 'are you dead' into 'no' at precisely the value
 * where the answer changes. Both shipped in `engine.template.js` until
 * 2026-08-23 and were found by `scripts/testflight.mjs`.
 */
export function setCounter(target, kind, n) {
  target.counters = target.counters || {};
  if (n === 0) delete target.counters[kind]; else target.counters[kind] = n;
  return target;
}
export function addCounter(target, kind, n = 1) { return setCounter(target, kind, getCounter(target, kind) + n); }

// --- state -------------------------------------------------------------------

/**
 * Build a starting state. Pass your own zones to replace the standard set.
 *
 *   createState({
 *     seed: 1,
 *     seats: [{ name: 'Player 1', counters: { life: 20 } }, …],
 *     phases: ['draw', 'main', 'end'],
 *   })
 */
export function createState({ seed = 1, seats = [], phases = ['main'], zones = null, extraZones = [], firstPlayer = 0, yourSeat = null } = {}) {
  resetCardIds();
  const seatObjs = seats.map((s, i) => ({
    index: i,
    name: s.name ?? `Seat ${i}`,
    counters: { ...(s.counters ?? {}) },
  }));
  const zoneList = zones ?? [
    ...seatObjs.flatMap((s) => standardSeatZones(s.index, s.name)),
    ...standardSharedZones(),
    ...extraZones,
  ];
  const zoneMap = {};
  for (const z of zoneList) zoneMap[z.id] = z;
  return {
    seed,
    rngSeed: seed,
    // **`turn` counts TURNS and `round` counts ROUNDS, and they are two
    // integers because they are two facts.** A turn is one seat's primary
    // action; a round is every seat having taken one. A design whose rules
    // speak in rounds and whose state exposes only turns makes every consumer
    // divide by the seat count, which is wrong the first time a seat takes two
    // turns or misses one.
    turn: 1,
    round: 1,
    active: firstPlayer,
    // **`yourSeat` is `startgame`'s third argument** — the seat this host
    // speaks for, which is what makes one engine a client rather than the whole
    // table. A headless run drives every seat and still records one, because a
    // report has to say which seat it was written from. `null` means the caller
    // did not say, which a viewer-scoped projection must not silently read as 0.
    yourSeat,
    // **`phase` here is a STEP of the active seat's own turn** — draw, main,
    // end — and it is NOT the `phase` of the wiring vocabulary, where a phase
    // is a stretch inside a turn during which OTHER seats act. Two different
    // things wearing one word; the wiring's phase is `endPhase` below, and the
    // rename that would settle it is registered as
    // `the-engine-calls-a-step-a-phase` in `docs/open-gaps.md`.
    phase: phases[0],
    phases,
    seats: seatObjs,
    zones: zoneMap,
    log: [],
    over: false,
    winner: null,
  };
}

/**
 * **The one call a host makes.** `startgame(num players, first player, your
 * seat)` in the wiring vocabulary; after it returns, the engine makes every
 * call and the host only submits intents.
 *
 * It exists as its own name rather than as a comment on `createState` because
 * the interface is dispatched BY NAME — the same reason `setup ()` is its own
 * verb — and because a `newGame` that a host happens to call is not the same
 * claim as an entry point the design declares.
 */
export function startGame(state, { firstPlayer = undefined, yourSeat = undefined } = {}) {
  if (firstPlayer !== undefined) {
    if (!Number.isInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= state.seats.length) {
      throw new Error(`firstPlayer ${firstPlayer} is not a seat in a ${state.seats.length}-seat game`);
    }
    state.active = firstPlayer;
  }
  if (yourSeat !== undefined) state.yourSeat = yourSeat;
  state.turn = 1;
  state.round = 1;
  state.phase = state.phases[0];
  return state;
}

/** Advance the state's RNG deterministically and return a number in [0,1). */
export function nextRandom(state) {
  state.rngSeed = (Math.imul(state.rngSeed, 1664525) + 1013904223) >>> 0;
  return createRNG(state.rngSeed)();
}

export function log(state, msg) { state.log.push(msg); return state; }

// --- zone operations ---------------------------------------------------------

export const zone = (state, id) => state.zones[id];
export const cardsIn = (state, id) => state.zones[id]?.cards ?? [];
export const countIn = (state, id) => cardsIn(state, id).length;

export function findCard(state, cardId) {
  for (const z of Object.values(state.zones)) {
    const i = z.cards.findIndex((c) => c.id === cardId);
    if (i !== -1) return { card: z.cards[i], zone: z, index: i };
  }
  return null;
}

// --- holders, and the carrier ------------------------------------------------
//
// **Zones held cards and cards held nothing.** `putIn` took a zone, `move` took
// a zone, and there was no way to say *this card is on that piece* — so a
// mobile holder was unrepresentable, and the substrate layer's carrier test sat
// at DECLARABLE and unrunnable. The declaration was already a tree: a token with
// `holds: true` projects a part of its own with a `cargo` attribute, so a cart
// on a map with three goods aboard is `map` → `Cart` → `Cart.cargo`.
//
// **A HOLDER IS DECLARED, NEVER ASSUMED, and that is the guard against the
// slide this repair could have caused.** `substrate-layer.md` warns in as many
// words against a model that ends in everything being nested containers. A card
// holds nothing unless it says `holds`; every card that does not is exactly what
// it was before.
//
// **Capacity is the holder role's parameter, wherever the role appears** — an
// echidna carries one butterfly, a hand carries N cards, a truck carries three
// goods. One knob, not three separate rules, so `holds` is both the declaration
// and the limit.

/** `holds: 3` on a card's def or on the card. `true` means no limit. */
const holdsOf = (card) => card?.holds ?? card?.def?.holds ?? null;

/** Is this card a holder at all? */
export const isHolder = (card) => holdsOf(card) != null;

/** What a holder is carrying. Empty for a card that carries nothing. */
export const cargoOf = (state, holderId) => findCard(state, holderId)?.card?.cargo
  ?? findHeld(state, holderId)?.card?.cargo ?? [];

/**
 * Resolve a holder address to the array that holds cards.
 *
 * **Two forms, and the dotted one is the whole point**: `discard` is a zone, as
 * it always was, and `cart1.cargo` is a card that holds. Anything else throws
 * rather than silently putting a card nowhere.
 */
function holderAt(state, address) {
  const z = state.zones[address];
  if (z) return { cards: z.cards, capacity: null, what: `zone ${address}` };
  const dot = String(address).lastIndexOf('.');
  if (dot > 0 && address.slice(dot + 1) === 'cargo') {
    const holderId = address.slice(0, dot);
    const held = findHeld(state, holderId);
    if (!held) throw new Error(`No such holder: ${holderId}`);
    if (!isHolder(held.card)) {
      throw new Error(`${holderId} does not declare \`holds\`, so nothing can be put on it`);
    }
    held.card.cargo ??= [];
    const cap = holdsOf(held.card);
    return { cards: held.card.cargo, capacity: cap === true ? null : cap, what: `${holderId}.cargo` };
  }
  throw new Error(`No such zone: ${address}`);
}

export function putIn(state, address, card, { toTop = false } = {}) {
  const h = holderAt(state, address);
  if (h.capacity != null && h.cards.length >= h.capacity) {
    throw new Error(`${h.what} is full at ${h.capacity} — a capacity that silently overfills is not a capacity`);
  }
  if (toTop) h.cards.unshift(card); else h.cards.push(card);
  return card;
}

/**
 * Find a card anywhere it can be — a zone, or aboard a holder, at any depth.
 *
 * **This is what makes *where is this good?* answer through the chain** rather
 * than stopping at the first holder that claims it. `findCard` still searches
 * zones only, deliberately: a caller asking which zone a card is in is asking a
 * different question, and several ask it.
 */
export function findHeld(state, cardId) {
  const inZone = findCard(state, cardId);
  if (inZone) return { ...inZone, container: inZone.zone.cards, holder: null };
  const walk = (cards, holder) => {
    for (let i = 0; i < cards.length; i += 1) {
      const c = cards[i];
      if (c.id === cardId) return { card: c, zone: null, index: i, container: cards, holder };
      if (c.cargo?.length) {
        const deeper = walk(c.cargo, c);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  for (const z of Object.values(state.zones)) {
    const found = walk(z.cards, null);
    if (found) return found;
  }
  return null;
}

/**
 * The chain of holders a card sits inside, outermost first — `['map', 'cart1',
 * 'cart1.cargo']`.
 *
 * Returns `null` for a card that is nowhere, which is a real answer and not an
 * error: a card can be out of play.
 */
export function whereIs(state, cardId) {
  const walk = (cards, trail) => {
    for (const c of cards) {
      if (c.id === cardId) return trail;
      if (c.cargo?.length) {
        const deeper = walk(c.cargo, [...trail, c.id, `${c.id}.cargo`]);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  for (const z of Object.values(state.zones)) {
    const chain = walk(z.cards, [z.id]);
    if (chain) return chain;
  }
  return null;
}

/**
 * Move a card to a zone or aboard a holder. Returns the card, or null if it
 * wasn't found.
 *
 * **A holder moves with its cargo**, which is the whole reason a carrier is not
 * just a zone with a position: moving the cart moves the goods, and nothing has
 * to enumerate them.
 */
export function move(state, cardId, to, { toTop = false, faceup = null } = {}) {
  const found = findHeld(state, cardId);
  if (!found) return null;
  // Refuse the loop before the splice, or a failed move leaves the card out of
  // play — a holder cannot be put aboard something it is already carrying.
  const dot = String(to).lastIndexOf('.');
  if (dot > 0 && to.slice(dot + 1) === 'cargo') {
    const target = to.slice(0, dot);
    if (target === cardId || (whereIs(state, target) ?? []).includes(cardId)) {
      throw new Error(`${cardId} cannot be loaded onto ${target}, which it is already carrying`);
    }
  }
  found.container.splice(found.index, 1);
  if (faceup !== null) found.card.facedown = !faceup;
  try {
    putIn(state, to, found.card, { toTop });
  } catch (e) {
    found.container.splice(found.index, 0, found.card);   // put it back; a refused move moves nothing
    throw e;
  }
  return found.card;
}

/** Draw n cards from a seat's deck into their hand. Returns what was drawn. */
export function draw(state, seat, n = 1, { deck = `${seat}:deck`, hand = `${seat}:hand` } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = state.zones[deck];
    if (!d || !d.cards.length) break;
    const card = d.cards.shift();
    putIn(state, hand, card);
    noteCard(state, card, 'drawn');
    out.push(card);
  }
  return out;
}

// --- which cards came up in play ---------------------------------------------
//
// **A card in a deck is not a card that was tested.** A deck of forty plays
// perhaps fifteen of them in a game, and a card that sits at the bottom of every
// shuffle, or is drawn and never cast, contributes nothing to the win rate it is
// counted in. `draw()` tallies every draw on its own; an engine calls
// `notePlayed()` where a card is played, and `sim-kit`'s `createCoverage()`
// reads the tally back across every trial. Keyed by the card's DESIGN -- its
// `def.id` -- so four copies of one card are one row.

/** The design a card instance is a copy of: its `id` in `cards.json`. */
export const designOf = (card) => card?.def?.id ?? card?.def?.title ?? null;

function noteCard(state, card, what) {
  const key = designOf(card);
  if (key == null) return;
  const stats = (state.cardStats ??= {});
  const s = (stats[key] ??= { drawn: 0, played: 0 });
  s[what] += 1;
}

/** Record that a card was played. Call it from `apply()` wherever one is. */
export function notePlayed(state, card) {
  noteCard(state, card, 'played');
}

export function shuffleZone(state, zoneId) {
  const z = state.zones[zoneId];
  if (z) z.cards = shuffle(z.cards, () => nextRandom(state));
  return state;
}

// --- deckbuilders ------------------------------------------------------------
//
// A deckbuilder needs two things a constructed format never does: a deck that
// recycles through its own discard, and a shared supply to gain from. Both are
// generic enough to live here rather than in one game's engine.

/**
 * Draw with reshuffling — the deckbuilder's draw.
 *
 * `draw()` above stops at an empty deck, which is correct for a format where
 * running out is a loss condition. Here the discard is shuffled back in and
 * play continues, and **the reshuffle count is recorded** on
 * `state.shuffles[seat]`, because cards-per-shuffle is the direct read on deck
 * density — this family's real currency.
 */
export function drawCycling(state, seat, n = 1, opts = {}) {
  const { deck = `${seat}:deck`, hand = `${seat}:hand`, discard = `${seat}:discard` } = opts;
  const out = [];
  state.shuffles ??= {};
  for (let i = 0; i < n; i++) {
    let d = state.zones[deck];
    if (!d) break;
    if (!d.cards.length) {
      const dis = state.zones[discard];
      if (!dis || !dis.cards.length) break;          // nothing left anywhere
      d.cards = dis.cards.splice(0, dis.cards.length);
      shuffleZone(state, deck);
      state.shuffles[seat] = (state.shuffles[seat] ?? 0) + 1;
    }
    const card = d.cards.shift();
    putIn(state, hand, card);
    out.push(card);
  }
  return out;
}

/** Every card a seat owns, wherever it currently sits — the deck *is* the
 *  score in this family, so "how big is my deck" must count all of it. */
export function deckSize(state, seat, zones = ['deck', 'hand', 'discard', 'play']) {
  return zones.reduce((n, z) => n + (state.zones[`${seat}:${z}`]?.cards.length ?? 0), 0);
}

/**
 * The shared supply: named piles of identical cards, with a depth each.
 *
 * `piles` is `{ pileId: { card, count } }`, where `card` is a template the
 * pile stamps copies from. Depth is a pacing control and often an end
 * condition, so it is explicit rather than infinite.
 */
export function makeSupply(state, piles) {
  state.supply = {};
  for (const [id, { card, count }] of Object.entries(piles)) {
    state.supply[id] = { id, card, count, initial: count };
  }
  return state;
}

export const pileCount = (state, pileId) => state.supply?.[pileId]?.count ?? 0;
export const emptyPiles = (state) =>
  Object.values(state.supply ?? {}).filter((p) => p.count === 0).map((p) => p.id);
export const availablePiles = (state) =>
  Object.values(state.supply ?? {}).filter((p) => p.count > 0).map((p) => p.id);

/**
 * Gain a card from a pile. Goes to the discard by default — **the delay
 * between paying and drawing is the genre's signature**, and a gain that
 * lands in hand is a deliberate rules exception, not a default.
 *
 * Returns the card, or null if the pile is empty. Records the purchase on
 * `state.purchases[pileId]` so the per-pile distribution — a pile nobody buys
 * is a slice of the design doing nothing — is measured rather than inferred.
 *
 * The pile is stamped onto the card's **definition** (`card.def.pile`), not the
 * instance, because every copy from a pile shares it.
 */
export function gain(state, seat, pileId, { to = `${seat}:discard` } = {}) {
  const pile = state.supply?.[pileId];
  if (!pile || pile.count <= 0) return null;
  pile.count -= 1;
  // Two tallies, because they answer different questions and conflating them
  // is a live bug: the balance stage wants pile popularity across the table,
  // while a policy asking "have I bought one of these yet" must not be able to
  // see its opponent's purchases.
  state.purchases ??= {};
  state.purchases[pileId] = (state.purchases[pileId] ?? 0) + 1;
  state.purchasesBySeat ??= {};
  state.purchasesBySeat[seat] ??= {};
  state.purchasesBySeat[seat][pileId] = (state.purchasesBySeat[seat][pileId] ?? 0) + 1;
  const card = makeCard({ ...pile.card, pile: pileId });
  putIn(state, to, card);
  return card;
}

/** Projection for the supply — public by definition; everyone can read it. */
export const supplyView = (state) =>
  Object.values(state.supply ?? {}).map(({ id, count, initial, card }) =>
    ({ id, count, initial, title: card?.title ?? id, cost: card?.cost ?? null }));

// --- the cycling river -------------------------------------------------------
//
// The other supply architecture (`kb/39`). A static supply is a fixed set of
// piles; a river is a deck that flows through a face-up row, refilling as
// cards are taken. **The choice is not cosmetic**: a static supply is
// plannable and therefore solvable, so it needs curating; a river is
// unplannable, so the game turns tactical and every card must stand on its own
// without being contextualised by the others.
//
// Built on zones rather than beside them, so a river gets visibility, movement
// and the standard projection for free.

/**
 * Create a river: a shuffled deck feeding a face-up row of `rowSize`.
 *
 * `cardDefs` is the whole flowing pool, one entry per physical card — pass
 * duplicates rather than counts, because a river has no piles to hold a count.
 */
export function makeRiver(state, id, cardDefs, { rowSize = 5, shuffled = true } = {}) {
  const deckId = `${id}:deck`, rowId = `${id}:row`;
  state.zones[deckId] = defineZone({
    id: deckId, kind: 'deck', label: `${id} deck`, visibility: VIS.SECRET, ordered: true,
  });
  state.zones[rowId] = defineZone({
    id: rowId, kind: 'row', label: `${id} row`, visibility: VIS.PUBLIC, ordered: true,
  });
  for (const d of cardDefs) putIn(state, deckId, makeCard({ ...d, river: id }));
  if (shuffled) shuffleZone(state, deckId);
  state.rivers ??= {};
  state.rivers[id] = { id, rowSize, exhausted: false };
  refillRiver(state, id);
  return state;
}

/** Top up the row from the deck. Sets `exhausted` when the deck runs dry —
 *  a river that cannot refill is an end condition in most designs that use one,
 *  so it is recorded rather than left to be inferred from a short row. */
export function refillRiver(state, id) {
  const r = state.rivers?.[id];
  if (!r) return state;
  const deck = state.zones[`${id}:deck`], row = state.zones[`${id}:row`];
  while (row.cards.length < r.rowSize && deck.cards.length) {
    putIn(state, `${id}:row`, deck.cards.shift());
  }
  r.exhausted = !deck.cards.length && row.cards.length < r.rowSize;
  return state;
}

export const riverRow = (state, id) => state.zones[`${id}:row`]?.cards ?? [];
export const riverDeckSize = (state, id) => state.zones[`${id}:deck`]?.cards.length ?? 0;

/**
 * Take a card out of the row and refill behind it.
 *
 * Goes to the discard by default, exactly as `gain()` does — the delay is the
 * genre's signature whichever architecture supplies the card. Returns the card,
 * or null if it is not in the row.
 *
 * **The refill happens immediately**, which is a rules decision worth making
 * deliberately: refilling now means the next player sees the replacement, and
 * refilling at end of turn means the buyer does. Pass `refill: false` to defer
 * it and call `refillRiver` yourself.
 */
export function takeFromRiver(state, seat, id, cardId, { to = `${seat}:discard`, refill = true } = {}) {
  const row = state.zones[`${id}:row`];
  const idx = row?.cards.findIndex((c) => c.id === cardId) ?? -1;
  if (idx < 0) return null;
  const [card] = row.cards.splice(idx, 1);
  putIn(state, to, card);
  // Tallied by definition, not by pile — a river has no piles, but "which
  // cards actually get bought" is the same question and the same diagnostic.
  const key = card.def?.id ?? card.def?.title ?? 'unknown';
  state.purchases ??= {};
  state.purchases[key] = (state.purchases[key] ?? 0) + 1;
  state.purchasesBySeat ??= {};
  state.purchasesBySeat[seat] ??= {};
  state.purchasesBySeat[seat][key] = (state.purchasesBySeat[seat][key] ?? 0) + 1;
  if (refill) refillRiver(state, id);
  return card;
}

// --- bags --------------------------------------------------------------------
//
// The third architecture, and the mechanic's own name says so: BGG calls the
// family *Deck, Bag, and Pool Building*. A bag is a deck with the ordering
// thrown away — you control the distribution and nothing else — and
// [kb/39] recommends one whenever a design does not need draw *order*, because
// it costs no shuffling, no ordering rules and no table time.
//
// Kept separate from zones deliberately: a bag has no order to project, and
// modelling it as an ordered zone would invite code that peeks at position.
//
// A TOKEN MAY CARRY FIELDS, added 2026-09-01, and the reason it had to be is
// that without it the substrate layer's bag test passed as a declaration and
// failed at the runtime. A stock of chips each carrying **a value and an
// effect** declares cleanly — one `deck`, `ordered: false`, both fields on
// `schema.occupant`, projecting as `distribution, known: nobody` — and then had
// nowhere to be built. `contents` stored `{ kind: count }`, so a token carried
// nothing but its kind, and **the only other holder in this file is a zone**,
// whose `cards` is an array and whose order `cardsIn` hands out.
//
// **So a chip with properties was buildable only as a zone, and building it
// that way gives up the guarantee this section exists to state** — *the order
// is unknowable by construction*. That is a real trade and the declaration
// never made it; the runtime made it silently.
//
// **The repair is a def table beside the counts.** `contents` stays
// `{ key: count }` and gains an optional `defs` keyed the same way, so a draw
// is still weighted over counts and there is still no order to expose. **A bag
// that declares defs refuses a count for a key it has no def for**, because the
// alternative is drawing a token whose fields are silently `null` — which is
// the same class of defect as the placeholder that type-checks.

/**
 * A bag of tokens, as `{ kind: count }`. `drawn` is what is currently out.
 *
 * Pass `{ defs }` to give the kinds fields — `{ red: { value: 3, effect: 'x' } }`.
 * **Declaring defs makes the key set closed**: every key in `contents`, and
 * every later `addToBag`, must name one.
 */
export function makeBag(state, id, contents = {}, { defs = null } = {}) {
  state.bags ??= {};
  if (defs) {
    const undeclared = Object.keys(contents).filter((k) => !(k in defs));
    if (undeclared.length) {
      throw new Error(`bag ${id} has counts for undeclared token(s): ${undeclared.join(', ')}`);
    }
  }
  state.bags[id] = {
    id, contents: { ...contents }, drawn: [], discard: {}, ...(defs ? { defs: { ...defs } } : {}),
  };
  return state;
}

/** The def table, or `null` where the bag's tokens are bare kinds. */
export const bagDefs = (state, id) => {
  const d = state.bags?.[id]?.defs;
  return d ? { ...d } : null;
};

/** One token's fields, or `null` — for a bare-kind bag, and for a key with no
 *  def, which only a defs-less bag can have. */
export const bagDef = (state, id, key) => state.bags?.[id]?.defs?.[key] ?? null;

/** Declare a token kind and its fields. Call before putting any in. */
export function defineBagToken(state, id, key, def) {
  const b = state.bags?.[id];
  if (!b) throw new Error(`no bag ${id}`);
  b.defs ??= {};
  b.defs[key] = def;
  return state;
}

export const bagCount = (state, id) =>
  Object.values(state.bags?.[id]?.contents ?? {}).reduce((n, c) => n + c, 0);

export const bagContents = (state, id) => ({ ...(state.bags?.[id]?.contents ?? {}) });

/** Put tokens in. This is the *only* build action a bag has, which is the
 *  point: you are shaping a distribution, not a sequence. */
export function addToBag(state, id, kind, n = 1) {
  const b = state.bags?.[id];
  if (!b) throw new Error(`no bag ${id}`);
  if (b.defs && !(kind in b.defs)) {
    throw new Error(`bag ${id} has no def for token ${kind} — declare it with defineBagToken first`);
  }
  b.contents[kind] = (b.contents[kind] ?? 0) + n;
  return state;
}

/**
 * Draw one token, weighted by what is actually in the bag, without
 * replacement. Returns the kind, or null when the bag is empty.
 *
 * Drawn tokens go to `drawn` rather than back, so a press-your-luck design can
 * read the run so far — and `refillBag` is what ends the round.
 */
export function drawFromBag(state, id) {
  const b = state.bags?.[id];
  if (!b) throw new Error(`no bag ${id}`);
  const total = bagCount(state, id);
  if (!total) return null;
  let pick = Math.floor(nextRandom(state) * total);
  for (const [kind, n] of Object.entries(b.contents)) {
    if (pick < n) {
      b.contents[kind] -= 1;
      if (b.contents[kind] === 0) delete b.contents[kind];
      b.drawn.push(kind);
      return kind;
    }
    pick -= n;
  }
  return null;                                    // unreachable while total > 0
}

/**
 * Draw one token and hand back its fields with it: `{ key, def }`, or `null`
 * when the bag is empty.
 *
 * **The same draw as `drawFromBag`** — weighted over counts, without
 * replacement, off the seeded RNG — so a design does not choose between fields
 * and the distribution. `def` is `null` on a bare-kind bag, which is the honest
 * answer rather than an empty object.
 */
export function drawTokenFromBag(state, id) {
  const key = drawFromBag(state, id);
  return key == null ? null : { key, def: bagDef(state, id, key) };
}

/** How many of `kind` have come out since the last refill — the number a
 *  press-your-luck bust condition is usually counted against. */
export const drawnCount = (state, id, kind) =>
  (state.bags?.[id]?.drawn ?? []).filter((k) => k === kind).length;

/** Return everything drawn to the bag. The end of a round, and the reason a
 *  bag needs no shuffling: putting tokens back IS the shuffle. */
export function refillBag(state, id) {
  const b = state.bags?.[id];
  if (!b) throw new Error(`no bag ${id}`);
  for (const kind of b.drawn) b.contents[kind] = (b.contents[kind] ?? 0) + 1;
  b.drawn = [];
  return state;
}

/** Projection. The contents are public in most designs — the whole skill is
 *  knowing your own distribution — while the *order* is unknowable by
 *  construction, which is what a bag buys you over a deck.
 *
 *  **Fields are public on the same argument the contents are**: knowing that
 *  the bag holds four 3-point chips is the skill, and it is not knowledge of
 *  which one comes next. `defs` appears only where the bag declared one, so a
 *  bare-kind bag projects exactly what it always did. */
export const bagView = (state, id) => {
  const defs = bagDefs(state, id);
  return {
    id,
    remaining: bagCount(state, id),
    contents: bagContents(state, id),
    drawn: [...(state.bags?.[id]?.drawn ?? [])],
    ...(defs ? { defs } : {}),
  };
};

/** Projection for a river — the row is public, the deck is a count. */
export const riverView = (state, id) => ({
  id,
  deck: riverDeckSize(state, id),
  exhausted: !!state.rivers?.[id]?.exhausted,
  row: riverRow(state, id).map((c) => ({
    id: c.id, title: c.def?.title ?? c.def?.id, cost: c.def?.cost ?? null,
  })),
});

// --- turn structure ----------------------------------------------------------

/** Move to the next phase; wraps to the next seat's first phase. */
export function nextPhase(state) {
  const i = state.phases.indexOf(state.phase);
  if (i < state.phases.length - 1) { state.phase = state.phases[i + 1]; return state; }
  return endTurn(state);
}

/**
 * The active seat finishing its primary action.
 *
 * **`turn` advances on every one of these and `round` advances on the
 * circuit.** Before the two counters were separated this function incremented
 * `turn` once per circuit, which made `state.turn` a round count under a turn's
 * name — the same conflation the wiring vocabulary now forbids, living in the
 * engine that runs it.
 */
export function endTurn(state) {
  state.active = (state.active + 1) % state.seats.length;
  state.phase = state.phases[0];
  state.turn += 1;
  if (state.active === 0) state.round += 1;
  return state;
}

/**
 * A seat finishing its part of somebody ELSE'S turn — the reaction, the bid,
 * the building it does because another seat called Builder.
 *
 * **Refused from the active seat**, which is the interface rule rather than a
 * convenience: the seat whose turn it is ends with `endTurn`. It advances no
 * counter and passes no seat, because ending your part of another seat's turn
 * changes nothing about whose turn it is — the whole of what it carries is that
 * you are done, which is what lets a manager know when the phase is over.
 */
export function endPhase(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.seats.length) {
    throw new Error(`${seat} is not a seat in a ${state.seats.length}-seat game`);
  }
  // **THE ACTIVE SEAT MAY END A PHASE ENTRY, and the refusal that said
  // otherwise is gone.** It assumed one seat active at a time, each seat either
  // taking a turn or watching. `activate (activationType)` replaced that: a
  // `phase` entry activates a seat without displacing `activeSeat`, so a
  // simultaneous design activates every seat with `phase` and leaves
  // `activeSeat` on the lead — which gives the lead a phase entry to end.
  // `gamemanager-kit.js` carries the same change and the reasoning in full; the
  // two enforce one interface and must not answer differently.
  return state;
}

// --- the seat-scoped projection ---------------------------------------------

/** What a viewer is allowed to learn about one card. */
function projectCard(card, canSeeFaces) {
  // Nothing derived from the card may appear here — not the id, not its
  // length. The viewer learns that a card exists and nothing else.
  if (!canSeeFaces || card.facedown) return { id: 'hidden', facedown: true };
  const d = card.def ?? {};
  const lines = [];
  if (d.type || d.subtype) lines.push([d.type, d.subtype].filter(Boolean).join(' — '));
  if (d.text) lines.push(d.text);
  if (d.stats != null) lines.push(String(d.stats));
  for (const [k, v] of Object.entries(card.counters ?? {})) lines.push(`${k}: ${v}`);
  if (card.tapped) lines.push('(tapped)');
  // `badge` is the one number a player scans a hand by — a cost, a power, a
  // level. It renders in the card's corner rather than as another line of text,
  // because a value buried in the fourth line is a value nobody reads. Optional:
  // a def without one projects null and the corner stays empty.
  return {
    id: card.id, title: d.title ?? card.id, badge: d.badge ?? null, lines,
    counters: { ...card.counters }, tapped: card.tapped,
  };
}

// Your zones first, then shared, then the opponent's; within each, the zones
// you look at most come first. Presentation only — no rule depends on it.
const OWNER_RANK = { you: 0, shared: 1, opponent: 2 };
const KIND_RANK = { hand: 0, 'play area': 1, discard: 2, exile: 3, deck: 4 };
const ZONE_ORDER = (z) => (OWNER_RANK[z.owner] ?? 3) * 100 + (KIND_RANK[z.kind] ?? 50);

function canSee(zone, viewer) {
  switch (zone.visibility) {
    case VIS.PUBLIC: return true;
    case VIS.OWNER: return zone.owner === viewer;
    case VIS.SECRET:
    case VIS.NONE: return false;
    default: return false;
  }
}

/**
 * Derive the whole seat-scoped view from zone visibility. THE CLIENT RECEIVES
 * ONLY THIS — never raw state.
 *
 * Pass `extra` to add game-specific fields (status text, stats row, …), or
 * write your own `view()` and call this for the zone list.
 */
export function defaultView(state, viewer, extra = {}) {
  const me = state.seats[viewer];
  const zones = Object.values(state.zones)
    .filter((z) => z.visibility !== VIS.NONE || z.owner === viewer)
    .map((z, seq) => {
      const visible = canSee(z, viewer);
      const showCount = z.visibility !== VIS.NONE || z.owner === viewer;
      const rel = z.owner === null ? 'shared' : (z.owner === viewer ? 'you' : 'opponent');
      // Label relative to the viewer, so "your hand" is never confusable with
      // an opponent's in the interface.
      const label = z.kind
        ? (rel === 'you' ? `Your ${z.kind}` : rel === 'shared' ? z.label : `${state.seats[z.owner]?.name} ${z.kind}`)
        : z.label;
      // A SECRET zone (a deck) projects a count and nothing else — emitting N
      // card objects would imply per-card information the viewer doesn't have,
      // and renders as an absurd wall of identical backs. An OWNER zone seen
      // by someone else (a hand) does emit backs, because how many cards are
      // held is itself meaningful and individual cards can be targeted.
      const asCount = z.visibility === VIS.SECRET || z.visibility === VIS.NONE;
      return {
        id: z.id,
        label,
        kind: z.kind,
        owner: rel,
        lane: z.lane ?? null,
        display: z.display ?? null,
        // Declaration order, so the client can lay lanes out the way the game
        // listed them rather than alphabetically. Presentation only.
        seq,
        count: showCount ? z.cards.length : undefined,
        cards: asCount ? [] : z.cards.map((c) => projectCard(c, visible)),
        note: asCount
          ? `${z.cards.length} card${z.cards.length === 1 ? '' : 's'}`
          : (z.cards.length === 0 ? 'empty' : undefined),
      };
    })
    .sort((a, b) => ZONE_ORDER(a) - ZONE_ORDER(b));

  return {
    seat: viewer,
    seatName: me?.name,
    turn: state.turn,
    phase: state.phase,
    activeSeat: state.active,
    yourTurn: state.active === viewer && !state.over,
    over: state.over,
    winner: state.winner,
    status: extra.status ?? (state.over
      ? (state.winner === viewer ? 'You win.' : state.winner == null ? 'Game over.' : 'You lose.')
      : (state.active === viewer ? `Your turn — ${state.phase}.` : `Waiting for ${state.seats[state.active]?.name}.`)),
    stats: extra.stats ?? defaultStats(state, viewer),
    zones,
    log: state.log.slice(-40),
    ...extra.fields,
  };
}

function defaultStats(state, viewer) {
  const out = [];
  for (const s of state.seats) {
    for (const [k, v] of Object.entries(s.counters)) {
      out.push({ label: `${s.index === viewer ? 'Your' : s.name + "'s"} ${k}`, value: v });
    }
  }
  out.push({ label: 'Turn', value: state.turn });
  return out;
}

/** Same shape the simulator reports, so human and simulated games compare. */
export function defaultMetrics(state) {
  return {
    turns: state.turn,
    winner: state.winner,
    naturalEnd: !!state.over,
    seatCounters: state.seats.map((s) => ({ ...s.counters })),
    zoneSizes: Object.fromEntries(Object.values(state.zones).map((z) => [z.id, z.cards.length])),
  };
}

/** Structural clone that keeps engines pure without every caller remembering. */
export const clone = (state) => structuredClone(state);
