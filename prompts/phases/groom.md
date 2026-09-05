Groom this backlog snapshot ({{count}} tickets). For each: is it ready for autonomous delivery? What relations exist? Which tickets form one coherent batch? What must be split or asked?

{{backlog}}

STUB NOTE: this is a skeleton prompt — a conservative pass is expected (few selections, questions only when clearly needed).

End your reply with exactly this JSON block (```json fenced), nothing after it:

```json
{
  "selected": ["KEY-1"],
  "relations": [{ "from": "KEY-1", "to": "KEY-2", "kind": "blocks" }],
  "splits": [{ "parentKey": "KEY-3", "drafts": [{ "title": "...", "description": "..." }] }],
  "questions": [{ "key": "KEY-4", "body": "Numbered questions phrased for a non-technical owner." }]
}
```

Selection criteria: Definition of Ready met, no unresolved product questions, and the selected set serves ONE common goal (coherence, not size). Relations use `blocks` = from blocks to.
