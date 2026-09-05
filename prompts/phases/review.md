Review this change. You see the ticket and the diff — that is all the context you get, by design.

{{ticket}}

## Diff

```diff
{{diff}}
```

Judge whether the diff honestly delivers the ticket. End your reply with exactly this JSON block (```json fenced), nothing after it:

```json
{
  "verdict": "approve or changes_requested",
  "findings": [
    {
      "severity": "blocker or major or minor",
      "file": "path if applicable",
      "issue": "what is wrong",
      "suggestion": "how to fix it"
    }
  ]
}
```
