# ADR 0008: Agent Plugins 1.0 conformance stops at the layout, and says why

## Status

**Amended — 2026-08-24, on Master's instruction.** The decision below stands for
the SHIPPED root and its reasoning is unchanged. What changed is that the
divergence is no longer only recorded: a second, conformant root now exists
beside it. See "The amendment" at the end.

Accepted — 2026-08-22. Scope set by Master as v0.34.0 item 1, "conform to the
Agent Plugins 1.0 standard". The manifest already did. The layout cannot, and
this records the decision not to try.

## Why this document exists

A future reader will find `$schema: agent-plugins.org/schemas/1.0.0` in
`plugins/tmux-teams/plugin.json`, read the standard, see that our directory
layout does not match it, and conclude that somebody started the job and stopped.
Nobody stopped. Finishing it would make the plugin uninstallable, and that is not
obvious from either document.

## What was measured

**The manifest conforms already.** Fetched and read against
`agent-plugins.org/schemas/1.0.0/plugin.schema.json`:

- `required` is exactly `["$schema", "name"]`. Both present.
- `$schema` must equal the schema URL exactly. It does.
- `name` must be 1–64 characters, lowercase, no `--` or `..`. `tmux-teams`
  passes.
- `author` permits only `name`, `email`, `url` and forbids additional
  properties. Ours carries `name` alone.
- Everything else — `version`, `description`, `homepage`, `repository`,
  `license`, `keywords` — is optional, and each of ours is the declared type.

**The layout does not, and the reason is on the other side.** The 1.0 portable
root is `plugin.json`, `skills/`, `mcp.json`, and reverse-domain namespaces
(`com.example.client/`) for client-specific material. Ours keeps
`.claude-plugin/` and `commands/` at the root instead.

Measured from the strings of the installed Claude Code binary
(`/Users/ngs/.local/share/claude/versions/2.1.239`, compiled — strings only, not
logic):

- It recognises plugin content by finding `.claude-plugin/`, or a top-level
  `commands/`, `skills/`, `agents/`, `hooks/`, `themes/`, `output-styles/`,
  `monitors/`, `workflows/`, `SKILL.md`, `.mcp.json` or `.lsp.json`. Its own
  diagnostic names that list.
- It contains **no occurrence of `agent-plugins.org`**, and none of a bare
  `${PLUGIN_ROOT}` — only `CLAUDE_PLUGIN_ROOT`.

The client this plugin ships to cannot read the namespace the standard asks us
to move into. Moving `.claude-plugin/` under `com.anthropic.claude/` would
satisfy 1.0 and produce a plugin that Claude Code declines to install.

## The decision

**Conform where the two agree; keep what the client needs where it looks for it;
record the divergence here.**

Concretely: `plugin.json` and `mcp.json` are the vendor-neutral pair and stay
exactly conformant. `.claude-plugin/plugin.json`, `.mcp.json` and `commands/`
stay at the root because that is where Claude Code looks. No reverse-domain
directory is created, because creating one that nothing reads is decoration.

**This pattern already exists in this repository and works.** `mcp.json` and
`.mcp.json` are not duplicates: the first carries the 1.0 `$schema` and uses
`${PLUGIN_ROOT}`, the second carries no schema and uses `${CLAUDE_PLUGIN_ROOT}`.
They differ on purpose, `tests/acp-lanes-mcp.test.mjs` asserts which must and
must not carry the schema key, and one test BOOTS the vendor-neutral
registration over JSON-RPC so a string-alike copy cannot pass for a working one.
Two registrations side by side, one portable and one native, both exercised.
This ADR extends that answer to the rest of the tree rather than inventing one.

## The argument against, stated rather than omitted

A standard adopted only where it is convenient is not adopted. A future client
that DOES read the 1.0 layout will not find this plugin's Claude-specific
material where the standard says to look, and this document is the only place
that explains why. If such a client appears, the right move is a reverse-domain
namespace ALONGSIDE the current paths — not instead of them — and the layout
test below is what will make that a deliberate change rather than a quiet one.

We also chose not to create the namespace speculatively. That is a bet that no
second client arrives before someone reads this file. The bet is recorded here
so it can be lost visibly.

## The gate, and why it came first

`tests/plugin-structure.test.mjs` asserts that `.claude-plugin/plugin.json`,
`.mcp.json` and `skills/` exist at the plugin root, and that the vendor-neutral
`plugin.json` and `mcp.json` exist beside them.

**It was written before anything moved, on purpose.** Until it existed, nothing
watched layout: every check read a KNOWN path and asserted its CONTENTS, so a
move that updated the four hard-coded paths would have kept the suite green
while the plugin became uninstallable. `claude plugin validate --strict .`
validates the marketplace manifest, not the layout.

Measured: moving `.claude-plugin/` out of the plugin root turns the suite red at
21/3. A test written after a move confirms what was done rather than checking
whether it was right.

## What this does not decide

Whether `commands/` — which Claude Code recognises but the standard leaves to
"each client's control" — should eventually move. It is left where it is, and
the layout test does not currently pin it, because nothing has forced the
question.

## The amendment — 2026-08-24

**Master's instruction: keep Claude as the primary layout, and add a second
folder that follows the standard. A client installing per the standard installs
from that folder instead.**

### What was re-measured, because the original reading was challenged

This ADR asserted non-conformance from a summary. The specification was fetched
again and quoted verbatim. Section 8:

> "Client-specific files MUST be represented under a top-level directory named
> for that namespace."

That is a MUST, and it settles the question the original text left implicit:
`.claude-plugin/`, `.mcp.json` and `commands/` ARE client-specific files, and
they sit at the plugin root. **The layout genuinely does not conform, and this
ADR's conclusion was right.**

Two things it did not say, both now measured:

- **Extra non-client entries at the root are fine.** Section 4.2's own standard
  layout prints `LICENSE` and `CHANGELOG.md` beside `plugin.json`, `skills/` and
  `mcp.json`. So `docs/` and `CONTEXT.md` were never the problem.
- **A first read of the same page said the namespace directory was OPTIONAL.**
  It was a paraphrase of "the spec does not mandate that plugins must provide
  such directories" — true only of a plugin that has no client-specific files at
  all. Ours has three. **The verbatim MUST is what governs; a summarised spec is
  not a spec**, and this is the second time this document has been moved by
  someone insisting on the literal text.

### What was built

`agent-plugins/tmux-teams/` — a conformant root, entirely symlinks:

```
agent-plugins/tmux-teams/
├── plugin.json              -> ../../plugins/tmux-teams/plugin.json
├── mcp.json                 -> ../../plugins/tmux-teams/mcp.json
├── skills                   -> ../../plugins/tmux-teams/skills
└── com.anthropic.claude/
    ├── plugin.json          -> ../../../plugins/tmux-teams/.claude-plugin/plugin.json
    ├── mcp.json             -> ../../../plugins/tmux-teams/.mcp.json
    └── commands             -> ../../../plugins/tmux-teams/commands
```

`plugins/tmux-teams/` is untouched, so Claude Code installs exactly what it
installed before.

**Symlinks rather than a copy or a generator, and that was measured rather than
assumed.** Probed before choosing: git stores them as mode `120000`, and they
survive both `git clone` and `git archive` as real links with content readable
through them. The cost is six lines in git for 2.4 MB and 69 files of skills,
and **drift is not prevented, it is impossible** — there is only ever one copy.
A generated root would have needed a build script and a staleness gate, which is
this repository's own `roadmap-render`/`roadmap-gate` pattern and would have been
the answer had the probe failed.

### The bet this ADR recorded, and how it was lost

The original text said:

> "We also chose not to create the namespace speculatively. That is a bet that no
> second client arrives before someone reads this file. The bet is recorded here
> so it can be lost visibly."

**It was lost, and visibly, exactly as intended — but not the way it expected.**
No second client arrived. The owner read the file and decided that conformance
should not wait for one. The bet was framed around a trigger from outside; what
fired was a decision from inside.

### What guards it

`tests/plugin-structure.test.mjs` asserts every entry in the portable root is a
symlink AND resolves, reads the manifests THROUGH the links (the portable one
must carry the 1.0 `$schema`, the namespaced Claude one must not), checks both
against `RELEASE_VERSION`, compares the skills the portable root sees against the
shipped list, and refuses any client-specific entry at the portable root.

Three mutations, each red: point a link at a missing target; replace a link with
a real copy; put `commands/` back at the portable root.

### What this still does not decide

Nothing has installed from `agent-plugins/tmux-teams/`. No client implementing
the 1.0 layout was available to try, which is the same gap the original decision
named — only now the plugin is ready for one instead of waiting to become ready.
