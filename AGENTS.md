# pi-hand-off agent instructions

## Scope and context

- `index.ts` is the entire extension. Its header explains the runtime design;
  keep it in sync when behavior changes.
- Keep `README.md` user-facing: value, usage, choices, limits, and recovery.
  Do not add event flows, API calls, or relay protocol details there.
- Session replacement recreates the extension in the same process. Plain data
  crosses that boundary via `globalThis`; session-bound objects must not.
- `/hand-off` puts a prompt in the editor for user review. Relays submit their
  next prompt automatically and persist recovery state per working directory.

## Validation

Ask before running `scripts/rpc-handoff-smoke-test.py`: it uses the user's live
pi configuration and makes **real, billed model requests**. Never run it in a
loop, in parallel, or as a side effect of other work.

Offline checks need no confirmation:

```sh
for f in scripts/*.test.mjs; do node "$f"; done
# No tsconfig.json: supply the inputs and options explicitly.
npx -y -p typescript tsc --noEmit --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 index.ts
```

## Releases

Release from GitHub; never `npm publish` from a laptop.

1. On `main`, bump `package.json` and add `## [X.Y.Z]` to `CHANGELOG.md`.
   Show that section to the user and wait for approval of the release wording.
2. With explicit approval, tag and push:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. With explicit approval, publish a GitHub Release for the tag. CI validates
   and stages it; a pre-release stages to `next` instead of `latest`.
4. Approve via npm's *Staged Packages* page or `npm stage approve <stage-id>`.
   The package is not installable until approved.
5. Verify `git rev-list -n1 vX.Y.Z` matches
   `npm view @grrrck/pi-hand-off@X.Y.Z gitHead`.

Commit and push workflow changes before tagging. Keep the workflow at
`.github/workflows/publish.yml` (npm's trusted publisher matches that name).
To validate without staging:
`gh workflow run publish.yml -f tag=vX.Y.Z -f dry_run=true`.
Never move or delete a pushed tag without asking the user.
