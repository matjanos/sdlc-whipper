Define the deterministic acceptance check for this ticket.

{{ticket}}

STUB NOTE: this is a skeleton prompt — keep the acceptance minimal but real enough to drive a test.

End your reply with exactly this JSON block (```json fenced), nothing after it:

```json
{
  "acceptanceTest": "Given/when/then description of the single scenario that proves this ticket delivered",
  "testPath": "path/relative/to/repo where the test will live, following existing test layout",
  "brief": "one paragraph for the implementer: scope, approach, what NOT to touch"
}
```
