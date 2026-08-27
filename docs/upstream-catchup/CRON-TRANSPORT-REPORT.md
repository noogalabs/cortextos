# Upstream Catch-up: Cron/Transport Family

## Binding header

- Family: `cron/transport`
- Canonical upstream set: 86 commits
- Fork base: `d7ca29d6c179af7900fb648ba236e5aa69a25349`
- Represented before port: 73 (65 patch-equivalent leaves and 8 merge/integration shells)
- Newly represented: 1
- Held or routed: 12
- External transport activation, trust-policy changes, cron activation policy,
  restart, and deployment: excluded

## Represented at the base

`1d001cb8`, `49b61a66`, `e9b65af9`, `7109f9a9`, `a3a75beb`,
`d7b531c4`, `d5b88c0e`, `43d4dfa0`, `a8e6c28f`, `5cfbe620`,
`00452d6c`, `4e2ebb6d`, `68205920`, `eaec9c35`, `7cac57aa`,
`bbe21879`, `528fd719`, `763bfa71`, `cab0d146`, `c9291cf6`,
`861bd6bd`, `c72af5d1`, `27b01a21`, `3e835bbd`, `d7aa78b3`,
`eec87452`, `7f09affd`, `9fc1c6bb`, `a30f176d`, `f34b329f`,
`f88e3d3a`, `d11854a9`, `c53a0ca2`, `3f338bc6`, `90deac6b`,
`00f79abf`, `f0c5dbb4`, `362d7a1d`, `eb93da5e`, `bc0f7144`,
`5ce5ea0d`, `a9dde1b4`, `f37dc1e7`, `035d51e6`, `462efc0c`,
`6ce2022b`, `8d8b872d`, `5bfda2f7`, `3f3d7386`, `0328e8eb`,
`aa1d9b51`, `1731eb69`, `95959dfd`, `cd6454c7`, `b1eee4bc`,
`00be9e65`, `f4ba977d`, `158dcfd0`, `784d6ca8`, `b8696f9f`,
`1ae60da0`, `22cc61ba`, `675943e0`, `b91261a6`, `eb3ddf3c`,
`49e57558`, `3a21d47f`, `ecdd47c9`, `3c0385b7`, `f013887d`,
`66a9a7aa`, `5ccab8c5`, `8b68e98c`.

The eight merge/integration shells are `1d001cb8`, `c9291cf6`, `861bd6bd`,
`1731eb69`, `cd6454c7`, `00be9e65`, `3c0385b7`, and `f013887d`.
Their represented leaves carry the relevant behavior; they are not replayed.

## Newly represented structural mechanic

- `cc3fffda`: plain-text Telegram messages now bypass both Markdown conversion
  and HTML escaping. Since the request is sent without `parse_mode`, escaping
  would expose literal `&gt;`, `&lt;`, and `&amp;` to the recipient. The casualty
  pins raw `5 > 4 & 3 < 4` preservation as well as no Markdown conversion.

This brings the represented total to 74/86.

## Holds and owner routing

- `051b22ee`: documentation/template validation aggregate; route to templates.
- `519b6984`: crash-hook fan-out placement; route to the hooks/daemon owner for
  an integration-grain casualty proving delivery without Telegram credentials.
- `e18c99b9`: adds a reaction command and therefore expands activation surface.
- `05ce125a`: changes Telegram identity from one allowed user to a multi-user
  trust model.
- `85ddcf71`: adds transcription-language transport configuration; language
  default/override policy is not inferred here.
- `c7dffe7e`: retries Telegram command registration and changes restart-time
  activation semantics.
- `fa62f172`: CronEntry validation is fail-closed and valuable, but it changes
  migration/activation policy (entry refusal and process exit status). It needs
  an explicit cron-policy ruling rather than an overnight adoption.
- `ba0ed7cb`: dashboard-only execution-log read optimization; route to the
  dashboard/CLI owner with its performance probe.
- `8475381d`, `25aea16b`: new Slack and Nostr transports; excluded.
- `f41017ab`, `4d3238cd`: unpooled IPv4/Happy-Eyeballs transport changes,
  including a default-on switch; network transport policy is stopped for a
  dedicated review/spec ruling.

No transport identity, cron activation, or network default was guessed.

## Validation

- TypeScript build: pass.
- Telegram plain-text casualty: raw comparison/ampersand/angle brackets survive
  with no `parse_mode` field.
- Telegram unit suite and cron suites are run at the family head.
- No push, PR, daemon restart, or deployment is part of this branch.
