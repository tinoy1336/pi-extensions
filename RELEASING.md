# Releasing

Both packages are published to npm by CI: a merge to `main` versions, changelogs, tags
and publishes with no human step, once the one-time bootstrap below is done.

Package | Tag | Changelog
--- | --- | ---
`@tinoy/pi-ext-lib` | `ext-lib-vX.Y.Z` | `packages/ext-lib/CHANGELOG.md`
`@tinoy/pi-canon` | `canon-vX.Y.Z` | `packages/canon/CHANGELOG.md`

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
4. `ext-lib` runs before `canon`, because `canon` depends on it.

The two packages version independently: each has its own tag, its own changelog and its
own release-worthy commits. Configuration lives in `release/ext-lib.mjs` and
`release/canon.mjs`, and both are run from the repository root so the workspace
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
  publishes over npm's OIDC exchange, with provenance generated for both packages; no
  npm token exists in the repository or in secrets.

## One-time bootstrap

npm's trusted publishing (OIDC) is configured **against an existing package**, so each
package has to be published once by hand before CI can publish it at all. Do this once,
in this order.

1. **Log in locally.**

   ```bash
   npm login
   ```

2. **Publish both packages by hand, `ext-lib` first** (canon depends on it). The first
   publish of a scoped package needs `--access public`.

   ```bash
   (cd packages/ext-lib && npm publish --access public)
   (cd packages/canon && npm publish --access public)
   ```

3. **Push the baseline tags**, on the commit whose `package.json` carries version
   `0.1.0`. semantic-release measures from the last tag: with no tag its first release
   would be `1.0.0`, which would not match what was just published.

   ```bash
   git tag ext-lib-v0.1.0
   git tag canon-v0.1.0
   git push origin ext-lib-v0.1.0 canon-v0.1.0
   ```

4. **Wire the trusted publisher on npm, once per package.** On
   <https://www.npmjs.com/package/@tinoy/pi-ext-lib> → *Settings* → *Trusted Publisher*
   → *GitHub Actions*, and fill in:

   Field | Value
   --- | ---
   Organization or user | `tinoy1336`
   Repository | `pi-extensions`
   Workflow filename | `release.yml`
   Environment | *leave empty*

   Then repeat on <https://www.npmjs.com/package/@tinoy/pi-canon>.

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
- **Force a release by hand**: *Actions* → *Release* → *Run workflow*, choosing
  `both`, `ext-lib` or `canon`. A dispatch still honours both guardrails — the path gate
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
