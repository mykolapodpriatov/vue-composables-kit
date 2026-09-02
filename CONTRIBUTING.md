# Contributing

Thanks for taking a look. This is a portfolio project, but issues and pull
requests are genuinely welcome.

## Getting started

```bash
corepack enable
pnpm install
pnpm run verify   # lint + typecheck + tests + build
```

`pnpm run verify` is the same set of checks CI runs. If it passes locally, CI
should pass too.

## Before opening a pull request

- `pnpm run verify` is green.
- New behaviour comes with a test. Bug fixes come with a test that fails
  without the fix.
- Comments explain **why**, not what. The code already says what.
- One reviewable idea per pull request. If a change has two unrelated halves,
  it is two pull requests.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). The body explains
the reasoning; the diff already shows the change.

```
feat(stream): fall back to SSE when the WebSocket upgrade is refused

Corporate proxies routinely drop the upgrade without closing the socket,
which left the feed silently empty rather than degraded.
```

## Code style

Formatting is Prettier's problem, not yours — `pnpm run format` before
committing, and do not hand-align anything.

TypeScript is strict, and `any` is not available. If the types are fighting
you, that is usually the design asking to be simpler; open an issue rather
than reaching for a cast.
