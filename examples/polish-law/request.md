# Test request: Polish legal-search app

Target repository: `~/code/test-sdlc-app` (sibling of this conductor repo).

Build the small MVP described in the target's `docs/request.md`: periodically collect recent official legislation and decisions from NSA, SAOS, SN, TSUE and TK, then expose a Polish keyword-search interface inspired by the supplied screenshot. The longer-term product vision is a better LEX-style research tool; the immediate goal is testing sdlc-conductor with a few independently verifiable tickets.

Use `tickets.json` in this directory as the local Linear-shaped backlog and the target's `.sdlc/config.json` as the conductor configuration. Six tickets cover persistence, legislation, decisions, scheduling, search UI and end-to-end acceptance. Each has explicit scope, acceptance criteria and dependency relations.

See [README.md](README.md) for executable commands and expected outcomes.
