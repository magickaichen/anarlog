# Domain documentation

This repository uses a multi-context domain-documentation layout. Domain
knowledge is organized by cohesive product or business context rather than
assuming each package or directory is a separate domain.

Domain documents are created lazily by the domain-modeling workflow. Missing
domain files do not block ordinary repository work.

## Entry point

Start with the root `CONTEXT-MAP.md` when it exists. It maps a product concern
to the context documents and code paths that own it.

Load only:

1. The relevant entries from `CONTEXT-MAP.md`.
2. The selected context's `CONTEXT.md`.
3. Applicable ADRs from the root `docs/adr/` directory.
4. Applicable context-local ADRs from that context's `docs/adr/` directory.

Do not load every context document by default.

## Layout

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/
├── apps/
│   └── <context>/
│       ├── CONTEXT.md
│       └── docs/adr/
├── crates/
│   └── <context>/
│       ├── CONTEXT.md
│       └── docs/adr/
├── packages/
│   └── <context>/
│       ├── CONTEXT.md
│       └── docs/adr/
└── plugins/
    └── <context>/
        ├── CONTEXT.md
        └── docs/adr/
```

A single domain context may span multiple applications, crates, packages, or
plugins. In that case, `CONTEXT-MAP.md` must list all relevant paths and point
to one authoritative context document.

## Context documents

A `CONTEXT.md` should capture durable domain knowledge:

- purpose and boundaries;
- shared vocabulary;
- important entities and invariants;
- ownership of workflows and data;
- upstream and downstream relationships;
- known boundary ambiguities;
- links to relevant ADRs and source paths.

Do not use context documents for temporary implementation plans, task status,
command reference, or details that are already obvious from the code.

## Architecture decisions

Use ADRs for decisions that constrain future implementations or explain a
non-obvious tradeoff.

- Root `docs/adr/` contains decisions that affect multiple contexts.
- Context-local `docs/adr/` contains decisions owned by one context.
- When an ADR and a context document conflict, the accepted ADR takes
  precedence until the context document is updated.
- Link ADRs from the relevant context document and map.

## Maintenance

Update domain documentation when implementation work changes:

- a domain boundary;
- durable terminology;
- an invariant;
- ownership of data or behavior;
- a cross-context relationship;
- an architectural decision.

Do not create speculative contexts merely to mirror the repository's package
structure.
