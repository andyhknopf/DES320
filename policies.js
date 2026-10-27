// Bot policies the play client can put in a seat. The decision comes from the
// simulator's own greedy policy (engine.js botMove), so a human game against
// the bot is a game against the same player the balance runs used.
import { botMove } from './engine.js';

export const POLICIES = {
  'simulator greedy': (legal, state, seat) => {
    const id = botMove(state, seat);
    return legal.find((m) => m.id === id) ?? legal[0];
  },
};
