# Publishing

The package is publish-ready. Everything below has been verified against the
built output rather than assumed.

## One-time: log in

Publishing needs an npm account with access to the `@mykolapodpriatov` scope.
`npm login` is interactive and opens a browser, so it cannot be automated:

```bash
npm login
npm whoami   # should print your username
```

## Publish

```bash
pnpm publish --access public
```

`prepublishOnly` runs `pnpm verify` first — lint, typecheck, 151 tests and a
build — so a broken tree cannot reach the registry. `publishConfig.access` is
already `public`: scoped packages default to *private*, and private packages
need a paid plan, which makes the first publish fail with a confusing message
about payment rather than about scope.

## What ships

```
23 files · 51.3 kB packed · 157.6 kB unpacked
  dist/**        ESM bundle, .d.ts declarations, source maps
  README.md      9.8 kB
  LICENSE        MIT
  package.json
```

Source is not shipped — `files: ["dist"]`. Source maps are, because a stack
trace pointing into a bundled line is worth very little to whoever hits it.

## Verified before release

| | |
|---|---|
| `pnpm verify` | exit 0 — lint, typecheck, 151 tests, build |
| Coverage | 92.4 stmts · 89.1 branches · 94.2 funcs · 94.9 lines (thresholds 90/85/90/90) |
| `exports` map | imported from outside the repository, exactly as a consumer would: 12 exports, none missing, none extra |
| Tree-shaking | importing only `useCountdown` yields a **1830-byte** bundle; the other four modules are dropped entirely |
| Types | `.d.ts` emitted for every module, with declaration maps |

## After the first publish

- Add the npm version badge to the README.
- Consider enabling [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
  by publishing from CI with `--provenance`. It requires a trusted publisher
  setup, which is more ceremony than a `0.1.0` warrants — but it is the right
  next step once the API settles.

## Versioning

`0.1.0` is deliberate: a `0.x` release makes no promise of backwards
compatibility, and the API has one consumer so far. Breaking changes are a minor
bump until `1.0.0`.
