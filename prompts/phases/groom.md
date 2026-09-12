<!--
Inputs: below is one batch's backlog snapshot — {{count}} tickets, one block per
ticket: key, state, the tracker's selected marker, title, description, the
relations already recorded on the ticket, and the last few owner comments
(earlier needs-info answers live there — read them before asking again). This
snapshot is the ONLY context you have: judge from what is written, never from
what you assume the team meant.

Output contract: your reply must END with exactly one fenced json verdict block
(the schema at the bottom) holding five arrays. classifications is required:
one entry per ticket you reviewed, with status ready | needs-info | blocked, a
one-sentence reason, and a confidence between 0.0 and 1.0. selected, relations,
splits, and questions are empty arrays when nothing applies.

Failure modes: (1) selecting a ticket whose classification is not "ready" with
confidence >= 0.7 fails validation and the whole run is retried once — low
confidence means ask, never select. (2) a needs-info classification without a
matching entry in questions fails validation — every ask must carry the actual
numbered questions. (3) inventing ticket keys, dependencies, or requirements
that are not in the snapshot corrupts the tracker. (4) asking a human something
the codebase could answer wastes the owner's time and stalls the batch.
-->

Backlog snapshot ({{count}} tickets):

{{backlog}}

You are grooming this batch toward autonomous delivery. Classify every ticket in the snapshot, then select a coherent batch.

**Definition of Ready** — a ticket is `ready` only when all of this is inferable from the snapshot:
1. **Goal** — the user-visible outcome, not a solution sketch.
2. **Scope** — what is included (and ideally what is explicitly out).
3. **Acceptance criteria** — how anyone can verify the result without guessing.
4. **No open product decision** — an unresolved "should it do X or Y?" is a question for the owner, not a detail you may assume.

**Confidence calibration** — confidence (0.0–1.0) is how sure you are the ticket can be delivered autonomously exactly as written. Any material ambiguity — a missing edge case, an undefined behavior, an assumed decision — caps confidence at 0.6 and makes the ticket `needs-info`. A ticket may appear in `selected` only when its classification is `ready` with confidence >= 0.7; the conductor enforces this deterministically and rejects anything below. Low confidence means ask, not guess.

**Statuses**:
- `ready` — Definition of Ready met; can enter `selected`.
- `needs-info` — a human must decide something first; put numbered questions in `questions` under the same key.
- `blocked` — work cannot start until another ticket is delivered (visible as a recorded relation, or stated in prose like "builds on KEY-2").

**Batch coherence** — `selected` is the set of ready tickets that serve ONE common goal when delivered together. Size is never a criterion: never select or reject a ticket because it looks big or small.

**Relations** — record only dependencies the snapshot actually shows. Direction convention: `"kind": "blocks"` means `from` blocks `to` (`from` must be delivered first). Do not re-record relations already listed on a ticket unless the snapshot lets you correct them.

**Splits** — only when a `ready` goal is genuinely too big for one autonomous delivery: draft two or more sub-tickets that EACH stand alone — independently deliverable and independently testable, with no half-finished shared state between them. A Definition-of-Ready gap is never a split; that is what questions are for.

**Questions** — one entry per `needs-info` ticket: numbered, each answerable on its own, phrased for a non-technical owner. Ask about behavior and outcomes ("what should the user see when the upload fails?"), never about implementation ("should this be a hook or a component?"). If a previous answer is already in the comments, do not ask again — build on it.

Worked example (abbreviated): LAW-1 states its goal, scope, and testable acceptance criteria with no open decision — `ready` at 0.85 and the only `selected` key. LAW-2's description says it normalizes into LAW-1's store, and the snapshot shows LAW-2 blocked-by LAW-1 — `blocked`. LAW-5 leaves open what the page shows when a document has no readable text — `needs-info` at 0.4: it gets numbered owner questions and is NOT selected.

End your reply with exactly one fenced json verdict block — the contract below, filled with your verdict for this snapshot — and nothing after it:

```json
{
  "classifications": [
    { "key": "LAW-1", "status": "ready", "reason": "Goal, scope, and acceptance criteria are explicit; no product decision is left open.", "confidence": 0.85 },
    { "key": "LAW-2", "status": "blocked", "reason": "Normalizes into LAW-1's store, which is not delivered yet.", "confidence": 0.9 },
    { "key": "LAW-5", "status": "needs-info", "reason": "The owner must decide what the page shows when a document has no readable text.", "confidence": 0.4 }
  ],
  "selected": ["LAW-1"],
  "relations": [{ "from": "LAW-1", "to": "LAW-2", "kind": "blocks" }],
  "splits": [],
  "questions": [{ "key": "LAW-5", "body": "1. What should the search page show instead of text when a saved document has none? 2. Should documents without readable text still appear in results at all?" }]
}
```
