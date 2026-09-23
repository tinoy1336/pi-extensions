# Releasing

Every package is published to npm by CI: a merge to `main` versions, changelogs, tags
and publishes with no human step, once the one-time bootstrap below is done.

The table is in dependency order — the order `.github/workflows/release.yml` releases
them in (`RELEASE_ORDER`). A package sits after every package it imports.

| Package | Tag | Depends on | Changelog |
| --- | --- | --- | --- |
| `@tinoy/pi-ext-lib` | `ext-lib-vX.Y.Z` | — | `packages/ext-lib/CHANGELOG.md` |
| `@tinoy/pi-focus-state` | `focus-state-vX.Y.Z` | — | `packages/focus-state/CHANGELOG.md` |
| `@tinoy/pi-tariff` | `tariff-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/tariff/CHANGELOG.md` |
| `@tinoy/pi-cache-prefix-log` | `cache-prefix-log-vX.Y.Z` | — | `packages/cache-prefix-log/CHANGELOG.md` |
| `@tinoy/pi-child-request-dump` | `child-request-dump-vX.Y.Z` | — | `packages/child-request-dump/CHANGELOG.md` |
| `@tinoy/pi-no-subagent-fork` | `no-subagent-fork-vX.Y.Z` | — | `packages/no-subagent-fork/CHANGELOG.md` |
| `@tinoy/pi-canon` | `canon-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/canon/CHANGELOG.md` |
| `@tinoy/pi-build` | `build-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/build/CHANGELOG.md` |
| `@tinoy/pi-child-prompt-freeze` | `child-prompt-freeze-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/child-prompt-freeze/CHANGELOG.md` |
| `@tinoy/pi-cli-keys` | `cli-keys-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/cli-keys/CHANGELOG.md` |
| `@tinoy/pi-command-guard` | `command-guard-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/command-guard/CHANGELOG.md` |
| `@tinoy/pi-deepseek-cost` | `deepseek-cost-vX.Y.Z` | `@tinoy/pi-ext-lib`, `@tinoy/pi-tariff` | `packages/deepseek-cost/CHANGELOG.md` |
| `@tinoy/pi-desktop-notify` | `desktop-notify-vX.Y.Z` | `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state` | `packages/desktop-notify/CHANGELOG.md` |
| `@tinoy/pi-drift-anchor` | `drift-anchor-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/drift-anchor/CHANGELOG.md` |
| `@tinoy/pi-fleet` | `fleet-vX.Y.Z` | `@tinoy/pi-ext-lib`, `@tinoy/pi-tariff` | `packages/fleet/CHANGELOG.md` |
| `@tinoy/pi-focus-gate` | `focus-gate-vX.Y.Z` | `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state` | `packages/focus-gate/CHANGELOG.md` |
| `@tinoy/pi-image-read` | `image-read-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/image-read/CHANGELOG.md` |
| `@tinoy/pi-intercom-broadcast` | `intercom-broadcast-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/intercom-broadcast/CHANGELOG.md` |
| `@tinoy/pi-nf` | `nf-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/nf/CHANGELOG.md` |
| `@tinoy/pi-orphan-repair` | `orphan-repair-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/orphan-repair/CHANGELOG.md` |
| `@tinoy/pi-pause` | `pause-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/pause/CHANGELOG.md` |
| `@tinoy/pi-probe` | `probe-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/probe/CHANGELOG.md` |
| `@tinoy/pi-read-staleness` | `read-staleness-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/read-staleness/CHANGELOG.md` |
| `@tinoy/pi-status-metrics` | `status-metrics-vX.Y.Z` | `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state` | `packages/status-metrics/CHANGELOG.md` |
| `@tinoy/pi-sudo-approve` | `sudo-approve-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/sudo-approve/CHANGELOG.md` |
| `@tinoy/pi-todo-parent` | `todo-parent-vX.Y.Z` | `@tinoy/pi-ext-lib` | `packages/todo-parent/CHANGELOG.md` |

## What a release does

`.github/workflows/ci.yml` runs the structural checks on every push and pull request:
`typecheck`, `lint`, `check:pack`, and the container smoke test.

`.github/workflows/release.yml` triggers on the successful completion of CI on `main`
and releases each package with semantic-release, driven by Conventional Commits:

1. **check out the exact commit CI verified** (`workflow_run.head_sha`), with the branch
   name put on it, so a `main` that moves on between the two workflows cannot release an
   unchecked commit;
2. **gate the package** — `scripts/release-relevant.sh <pkg>` refuses when no commit
   since that package's own tag touched `packages/<pkg>`;
3. **analyze, version, changelog, publish** — `@semantic-release/commit-analyzer` and
   `@semantic-release/release-notes-generator` (Conventional Commits), then
   `@semantic-release/changelog`, `@semantic-release/npm` (publish),
   `@semantic-release/git` (the release commit, pushed with `[skip ci]`),
   `@semantic-release/github` (the GitHub release);
4. **release in dependency order** — the packages are released one after the other in
   `RELEASE_ORDER` (`.github/workflows/release.yml`): `ext-lib` first, then `focus-state`
   and `tariff`, then every package that imports them. The order is mandatory, not tidy:
   a dependent's install resolves its dependencies from the registry, so a dependent
   released before its dependency cannot be installed at all (measured: resolving one of
   the new packages against the registry answered `404` while its dependency was
   unpublished).

The packages version independently: each has its own tag, its own changelog and its
own release-worthy commits. Configuration lives in one `release/<key>.mjs` per package,
and every one of them is run from the repository root so the workspace
lockfile is inside the release commit (`npm version` rewrites the root
`package-lock.json`; a lockfile left out of the commit makes the next `npm ci` fail).

## Guardrails

- **Only after a green check.** The release trigger is CI's successful completion on
  `main`. A failed check releases nothing.
- **No release-worthy commit, no release.** semantic-release logs "There are no
  relevant changes, so no new version is released." and exits 0 without touching a
  version, a tag or the registry. The per-package path gate goes further: a
  `feat(canon)` push never starts the `ext-lib` release at all, so a package cannot be
  published for commits that never touched it.
- **A failed publish leaves no tag.** semantic-release creates and pushes the tag
  *before* it runs the publish plugins (`Create the tag before calling the publish
  plugins as some require the tag to exists`, `semantic-release/lib/index.js`), so the
  ordering itself cannot be inverted. The workflow compensates: it snapshots `git tag`
  before each package's release step, and on that step's failure
  `scripts/withdraw-tag.sh` deletes exactly the tags that appeared — remote ref and
  local ref — leaving a previous successful package's tag alone.
- **Trusted publishing, no stored token.** The release job holds `id-token: write` and
  publishes over npm's OIDC exchange, with provenance generated for every package it
  publishes; no npm token exists in the repository or in secrets.

## One-time bootstrap

npm's trusted publishing (OIDC) is configured **against an existing package**, so each
package has to be published once by hand before CI can publish it at all. Do this once,
in this order.

1. **Log in locally.**

   ```bash
   npm login
   ```

2. **Publish every package by hand, in dependency order** — `ext-lib`, `focus-state`
   and `tariff` first, then the rest. The first publish of a scoped package needs
   `--access public`. Dependency order holds here too: a package published before its
   dependency is not installable until that dependency is up.

   ```bash
   for k in ext-lib focus-state tariff $(ls packages | grep -vE '^(ext-lib|focus-state|tariff)$'); do
     (cd "packages/$k" && npm publish --access public)
   done
   ```

   A package that is already on the registry at that version answers
   `EPUBLISHCONFLICT`; that is the expected answer for the packages published before
   this loop ran, and it is what "already bootstrapped" looks like.

3. **Push a baseline tag for every package**, on the commit whose `package.json`
   carries version `0.1.0`. semantic-release measures from the last tag: with no tag its
   first release would be `1.0.0`, which would not match what was just published.

   ```bash
   for k in $(ls packages); do git tag "${k}-v0.1.0"; done
   git push origin $(git tag --list '*-v0.1.0')
   ```

   A tag that already exists is reported by git and needs no action.

4. **Wire the trusted publisher on npm, once per package.** On
   <https://www.npmjs.com/package/@tinoy/pi-ext-lib> → *Settings* → *Trusted Publisher*
   → *GitHub Actions*, and fill in:

   Field | Value
   --- | ---
   Organization or user | `tinoy1336`
   Repository | `pi-extensions`
   Workflow filename | `release.yml`
   Environment | *leave empty*

   Then repeat on <https://www.npmjs.com/package/@tinoy/pi-canon> and on every other
   package: each one needs its own entry, at
   `https://www.npmjs.com/package/<name>` → *Settings* → *Trusted Publisher*. A package
   without an entry cannot use OIDC at all: its release stops at `verifyConditions` with
   `404 OIDC token exchange error - package not found`, before any tag is created.

   The workflow filename must be exactly `release.yml`: npm matches that field (and the
   environment, when one is set) against the OIDC token's claims, and it matches the
   *file*, not the job. The job in this repository is named `release` and sets no
   environment, which is why the field above stays empty — setting an environment on the
   job without repeating the same name here would break the exchange.

5. **Let a release run.** Merge a `feat:` or `fix:` commit to `main` and watch
   *Actions* → *Release*.

If a release fails at `verifyConditions` with `EINVALIDNPMTOKEN`, the OIDC exchange was
refused: either step 4 is not configured for that exact package, or the workflow
filename does not match.

## The live-turn secret

`.github/workflows/live-turn.yml` is a manual dispatch that spends one real model call
against the installed packages: it installs the `npm pack` tarballs, runs pi headlessly
with the extension loaded, and fails unless the model actually wrote the canon store.
It is never triggered by a push.

It needs one repository secret, created by hand:

Secret | Value
--- | ---
`PI_TEST_API_KEY` | an API key for the provider named in the dispatch input (default provider `deepseek`, model `deepseek-flash`)

Create it under *Settings* → *Secrets and variables* → *Actions* → *New repository
secret*. The key is passed to pi as a command-line argument and is never printed; the
workflow's dispatch inputs (`provider`, `model`, `prompt`) choose what the turn runs.

## Forcing, skipping, previewing

- **Preview** the releases semantic-release would make, without publishing or tagging:

  ```bash
  npm run release:dry
  ```

  This runs the same gate the job runs. Two things it needs before it can report
  anything: an authenticated npm session (`npm login` — without one it stops at
  `EINVALIDNPMTOKEN`), and a reachable `origin` (semantic-release reads the remote's
  branches, so the GitHub repository has to exist and answer `git ls-remote`).
- **Force a release by hand**: *Actions* → *Release* → *Run workflow*, choosing `both`
  or any one key from `RELEASE_ORDER`. A dispatch still honours both guardrails — the path gate
  and the "no release-worthy commit" rule — so a dispatch with nothing to release does
  nothing. To publish a patch when no release-worthy commit exists (a repair after a
  failed publish, for instance), commit an empty `fix:` first:

  ```bash
  git commit --allow-empty -m "fix(canon): republish"
  ```
- **Skip a release for one push**: put `[skip ci]` in the commit message — CI does not
  run, so the release trigger never fires. Note this skips the whole checks pass too.
  A commit that is only `chore:`, `docs:`, `test:` or `refactor:` releases nothing on
  its own.

## Rolling back a bad publish

1. **Nothing reached the registry.** The tag is the only trace; it was created before
   the publish plugins ran. A failed release step already withdraws it
   (`scripts/withdraw-tag.sh`); if the run was killed before that, delete it by hand:

   ```bash
   git push origin :refs/tags/canon-vX.Y.Z
   git tag -d canon-vX.Y.Z
   ```

   A release commit that did get pushed is undone with `git revert <sha>` — the version
   in the manifests goes back, and the next release computes the same version again.

2. **The version is on npm.** Delete the GitHub release too, then either
   `npm unpublish <pkg>@<version>` (npm only allows this while the version is under 72
   hours old and has no dependents) or, for anything older,
   `npm deprecate <pkg>@<version> "<why>"`. Then fix forward: never re-publish the same
   version, release the next patch instead.

3. **A tag exists but the version was never published.** This is the recoverable
   middle state semantic-release itself resumes from: the next release run finds the
   tag, adds the channel note, and publishes the version it names.

## Notes

- `conventional-changelog-conventionalcommits` is a direct devDependency pinned to the
  major the release plugins can render: the changelog writer the semantic-release
  plugins ship is v8, and preset v10 refuses it (`conventional-changelog-conventionalcommits
  requires conventional-changelog-writer@9 or newer`). Bumping the preset without the
  plugins fails the notes step.
- `npm run changelog` (git-cliff → a root `CHANGELOG.md`) is a local preview tool; the
  changelogs that ship are the per-package ones the release writes.
- The release job pushes commits and tags to `main`. Branch protection must allow the
  workflow's `GITHUB_TOKEN` to push (an allowlisted bypass, or no rule that requires a
  pull request on `main`), otherwise the release stops after publishing.
- `scripts/smoke.sh` uses `docker` by default and `$CONTAINER_ENGINE` if set; on a
  machine without a daemon, `npm run smoke:local` runs the same harness against the
  same tarball install.
