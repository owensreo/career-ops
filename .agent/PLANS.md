# ExecPlans

Use a concise, repository-local ExecPlan for architecture, privacy-boundary, provider, workflow, migration, or multi-stage work. Store task plans in `.agent/plans/`.

Respect `AGENTS.md` and `DATA_CONTRACT.md`: plans must not copy or expose user-layer content, submitted text, application records, prompts, outputs, personal data, credentials, or secrets. Describe data categories and boundaries generically.

Include: objective, existing behavior, proposed behavior, constraints, privacy and security considerations, milestones, validation, rollback considerations, decisions, and final outcome.

Do not require a plan for a documentation correction, small bug fix, routine dependency bump, or other trivial change unless it meets one of the required criteria.
