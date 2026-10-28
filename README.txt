HALO TCG — ONLINE PLAY
Built 2026-10-28 20:14 UTC from the current cards and rules.

TO PUT IT ONLINE
Upload everything in this folder to your website, into any folder you like
(for example yoursite.com/halo/). Players go to that address. That's all.

No server software, database or account is needed. Any host that serves plain
files works: your own site, GitHub Pages, Netlify, Cloudflare Pages, itch.io
(as an HTML game), and so on. It must be served over https (or from localhost);
browsers refuse the connection features on plain http pages.

HOW PLAYERS USE IT
1. Open the site, type a name, pick a deck, and press Create room.
2. Send the four-letter code (or the link the game shows) to a friend.
3. The friend opens the site, picks a deck, and joins with the code.
The player who created the room is the host: their browser runs the game and
checks every move, so they keep the game page open while playing. Either
player can refresh or reconnect without losing the game.

PLAYING THE BOT
The front page also has "Play the bot": pick your deck and the bot's. The game
runs entirely in the page, so it needs no second player and no connection.

GAME RECORDS
Every game is kept in each player's browser. "Download game records" on the
front page saves them as one file, in the same format as the simulator's
sessions, for reading beside the balance runs.

GOOD TO KNOW
- The two browsers are introduced by PeerJS's free public service and then
  connect directly. A few strict networks (some offices and schools) block
  direct connections; if a game won't connect, try another network.
- Each browser holds the whole game, so a player who opens the developer
  tools could read the opponent's hand. Fine among friends.
