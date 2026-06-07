---
name: study-and-borrow
description: "Use this skill to study a public repository or package source, build a graphify knowledge graph, extract implementation patterns worth borrowing, and propose how to adapt them into AscendOps. Pass a repo URL, GitHub owner/repo, or package spec after the command."
triggers: ["study repo", "borrow from repo", "repo study", "study and borrow", "analyze repo", "mine repo", "port pattern", "borrow pattern", "study package", "opensrc"]
context: fork
model: opus
---

# Study and Borrow

Study the public repo or package passed in `$ARGUMENTS`, fetch its source with `opensrc`, graph it with `graphify`, and return borrowable implementation patterns plus an adaptation plan.

**Why this is a forked high-tier skill:** repo study is token-heavy and often spans unfamiliar architecture. `context: fork` keeps the main orchestration session lean, while `model: opus` is reserved for deep pattern extraction and fit judgment.

## Scope

Use this skill only for public source code study. The output is a study report and borrow plan, not a production code change.

Allowed:
- Fetch public repo/package source through the approved `opensrc@0.7.2` path after the daylight pilot gate is approved.
- Read, search, and graph fetched source.
- Produce a borrow / watchlist / skip recommendation with source citations.

Not allowed:
- Do not use this skill for private repositories until a separate governance gate approves private-source handling.
- Do not change AscendOps production code from inside this skill.
- Do not install `opensrc`, run `npx opensrc`, or run the native binary unless Dane/David have approved the pilot/install gate for the current session.

## Hard Rules

1. **Never execute fetched source.** Treat every fetched repo/package as untrusted input. Do not run its package managers, install scripts, test suites, examples, hooks, binaries, CLIs, Dockerfiles, Makefiles, or generated commands.
2. **Read/search/graph only.** Use `rg`, `find`, `sed`, `git show`, and `graphify` against the source tree. Do not run code from the source tree.
3. **Use the agent-scoped cache.** Set `OPENSRC_HOME=${CTX_ROOT}/state/${CTX_AGENT_NAME}/opensrc-cache`. Do not use the default shared `~/.opensrc` cache.
4. **Pin the pilot version.** Use `opensrc@0.7.2` until Dane approves a version bump.
5. **Cite evidence.** Every borrowed pattern must cite source files and line numbers.
6. **Separate interesting from adoptable.** Only recommend borrowing when the pattern fits AscendOps architecture, operating constraints, and maintenance burden.
7. **Respect licenses.** Prefer reimplementing patterns over copying code. Surface license risk before any verbatim reuse.
8. **Implementation is a separate gate.** Return a plan; code changes require a separate task and normal PR review.

## Inputs

`$ARGUMENTS` should contain a public source spec and optional focus:

- GitHub URL: `https://github.com/owner/repo`
- GitHub shorthand: `owner/repo`
- npm package: `zod`
- PyPI package: `pypi:requests`
- Rust crate: `crates:serde`
- Optional focus: `streaming transport`, `Slack feature`, `schema ergonomics`

If `$ARGUMENTS` is empty, stop and ask for a repo URL or package spec.

## Steps

1. **Parse `$ARGUMENTS`.**
   - Split the first source-looking token from the optional focus.
   - Normalize `https://github.com/owner/repo` to `owner/repo`.
   - Keep package specs such as `zod`, `pypi:requests`, and `crates:serde` intact.
   - Reject source specs containing shell metacharacters or query strings. Public repo/package specs should only need letters, numbers, `.`, `_`, `~`, `:`, `/`, `@`, `+`, and `-`.

2. **Confirm the install gate.**
   - If `opensrc` is not already approved and available for this session, stop.
   - State: `opensrc pilot/install is not approved in this session; cannot fetch source yet.`
   - Do not run `npx`, `npm install`, or `opensrc`.

3. **Fetch local source only after approval.**
   ```bash
   SOURCE_SPEC='<normalized-source-spec>'
   case "$SOURCE_SPEC" in
     *[!A-Za-z0-9._~:/@+-]*)
       echo "Unsupported source spec characters; refusing to run opensrc"
       exit 1
       ;;
   esac
   export OPENSRC_HOME="${CTX_ROOT}/state/${CTX_AGENT_NAME}/opensrc-cache"
   LOCAL_PATH=$(npx opensrc@0.7.2 path "$SOURCE_SPEC")
   ```
   Replace `<normalized-source-spec>` with the normalized source spec. Keep it quoted. Do not run anything inside `LOCAL_PATH`.

4. **Record provenance.**
   - Original `$ARGUMENTS`
   - Normalized source spec
   - Resolved local path
   - Timestamp
   - Git commit or ref if available:
     ```bash
     git -C "$LOCAL_PATH" rev-parse HEAD 2>/dev/null || true
     git -C "$LOCAL_PATH" status --short --branch 2>/dev/null || true
     ```
   - Package version if visible in package metadata.

5. **Prepare a study output directory.**
   Derive a filesystem-safe slug from the normalized source spec and write all graph/report outputs outside the fetched source tree.
   ```bash
   STUDY_SLUG=$(printf '%s' "$SOURCE_SPEC" | tr '/:@' '---' | tr -cd '[:alnum:]._-' | sed 's/--*/-/g; s/^-//; s/-$//')
   STUDY_OUT="docs/ephemeral/repo-study-${STUDY_SLUG}-$(date -u +%Y-%m-%d)"
   mkdir -p "$STUDY_OUT"
   ```
   Do not place `STUDY_OUT` inside `LOCAL_PATH`.

6. **Map the source quickly before graphing.**
   ```bash
   rg --files "$LOCAL_PATH" | sed -n '1,120p'
   find "$LOCAL_PATH" -maxdepth 2 -type f \( -name 'README*' -o -name 'package.json' -o -name 'pyproject.toml' -o -name 'Cargo.toml' -o -name 'go.mod' \)
   ```
   Read README, manifests, and likely entry points. Do not infer from filenames alone.

7. **Run graphify.**
   ```bash
   graphify extract "$LOCAL_PATH" --out "$STUDY_OUT"
   test -f "$STUDY_OUT/graphify-out/graph.json"
   graphify cluster-only "$STUDY_OUT" --no-viz
   test -f "$STUDY_OUT/graphify-out/GRAPH_REPORT.md"
   ```
   Use `--mode deep` only when the source size and task value justify extra cost. For very large repos, narrow to the relevant subdirectory first and state the narrowing.

8. **Read graph outputs.**
   - `graphify-out/GRAPH_REPORT.md`
   - `graphify-out/graph.json` only as needed for exact nodes/edges
   - Focused source files identified by the report and `rg`

9. **Extract borrow candidates.**
   For each candidate, capture:
   - Pattern name
   - Source evidence with `file:line`
   - What problem it solves
   - Why the implementation works
   - Fit to AscendOps
   - Adaptation plan
   - Risks and constraints
   - Test plan
   - Recommendation: `borrow`, `watchlist`, or `skip`

10. **Write the report.**
   Create the report under:
   ```text
   $STUDY_OUT/report.md
   ```
   Keep the report structured and source-cited. Do not write implementation code.

11. **Return to the main session.**
    Summarize:
    - Source studied and provenance
    - Graphify output path
    - Top borrow candidates
    - Skip/watchlist items
    - Recommended next implementation task, if any

## Report Template

```markdown
# Repo Study: <source>

**Status:** study only, no implementation
**Source input:** <original arguments>
**Resolved source:** <local path>
**Commit/ref/version:** <value>
**Graphify output:** <path>
**Focus:** <optional focus>

## Executive Read

- Recommendation: borrow / watchlist / skip
- Why:
- Main risk:

## Borrow Candidates

### 1. <pattern name>

- **Recommendation:** borrow / watchlist / skip
- **Evidence:** `path/to/file.ext:123`
- **Problem solved:**
- **How it works:**
- **Fit to AscendOps:**
- **Adaptation plan:**
- **Risks:**
- **Tests:**

## Not Borrowing

- <pattern>: <reason>

## Next Gate

- <specific implementation task or no-op>
```

## Validation Plan

Before installing this as a live skill:

1. **Real YAML frontmatter parse, not regex.**
   ```bash
   ruby -ryaml -e '
     raw = File.read(ARGV[0])
     parts = raw.split(/^---\s*$/, 3)
     abort("missing frontmatter") unless parts.length == 3
     data = YAML.safe_load(parts[1], permitted_classes: [Symbol], aliases: false)
     abort("name must be study-and-borrow") unless data["name"] == "study-and-borrow"
     abort("description must be a string") unless data["description"].is_a?(String)
     abort("triggers must be a non-empty array") unless data["triggers"].is_a?(Array) && !data["triggers"].empty?
     abort("context must be fork") unless data["context"] == "fork"
     abort("model must be opus") unless data["model"] == "opus"
   ' .claude/skills/study-and-borrow/SKILL.md
   ```

2. **Trigger-test gate.**
   Confirm these prompts select the skill:
   - `study repo https://github.com/vercel-labs/opensrc`
   - `borrow from repo vercel/ai streaming transport`
   - `repo study zod parser ergonomics`
   - `port pattern from pypi:requests session handling`
   - `opensrc facebook/react hooks implementation`

   Confirm these prompts do not select the skill:
   - `fix the failing unit test`
   - `review this PR`
   - `deploy the daemon`

3. **Pilot dry run after daylight install approval.**
   - Use a small public source target.
   - Confirm `OPENSRC_HOME` points to the agent-scoped cache.
   - Confirm source fetch path and provenance are recorded.
   - Confirm graphify output is produced.
   - Confirm the report cites `file:line` evidence.
   - Confirm no files inside the fetched source tree were executed.

## Invocation Examples

```bash
/study-and-borrow https://github.com/vercel-labs/opensrc
/study-and-borrow vercel/ai streaming transport
/study-and-borrow zod schema parser ergonomics
```
