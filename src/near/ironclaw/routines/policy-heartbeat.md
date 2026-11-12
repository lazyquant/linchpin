---
name: policy-heartbeat
schedule: "0 */6 * * *"
---

Every six hours, call linchpin_policy_verdict with policyId quantrin-near-v1.
Call linchpin_changes for each public chain root, using the two loaded snapshot ids.
Notify when the verdict is outside-policy or when any changes are returned.
Quote rule ids, fact ids and receipt ids in the notification.
Keep tool errors and coverage gaps visible. Label prose "unchecked summary".
No position data is available. Make no suggestion to act or trade.
