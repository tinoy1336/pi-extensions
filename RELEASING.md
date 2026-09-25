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

## The publishing credential

Publishing authenticates with the `NPM_TOKEN` repository secret whenever the package has
no trusted publisher: the release job attempts the OIDC exchange first and falls back to
the token only when that exchange does not succeed. The secret holds one granular access
token scoped to `@tinoy`, with write access and the **2FA-bypass flag set**, taken from
the `_authToken` line of `~/.npmrc` and piped straight into
`gh secret set NPM_TOKEN --repo tinoy1336/pi-extensions` on stdin — the value is never
echoed and never written to a file.

That token class is why this route exists and why the trusted-publisher route is
deferred: `POST /-/package/{package}/trust` refuses a bypass-2FA token with `403` and
demands an interactive 2FA challenge, which a build runner cannot answer. The property
that disqualifies the token there is the one CI needs here — a bypass-2FA granular token
publishes without a one-time password — so it is the credential a package with no
trusted publisher reaches the registry with.

This is a bridge, not a destination: npm removes the ability to publish new versions
directly with a granular access token in **January 2027**, so the trusted-publisher route
in step 4 below has to be finished before then, and the token rotated on its own expiry
schedule until it is.

Provenance survives in token mode. `NPM_CONFIG_PROVENANCE=true` on the release step makes
`npm publish` sign a provenance statement from the job's OIDC identity, which is what the
job's `id-token: write` permission is for and why that permission stays on in token mode;
the repository is public, which npm requires for an attestation. Under trusted publishing
npm generates the same attestation automatically, without the flag.

## The first publish

A package's first version is the one publish semantic-release cannot compute: it measures
the next version from the last tag, so with no tag it prepares `1.0.0` for a manifest
carrying `0.1.0`. That is why the release job refuses a package with no `<key>-v*` tag
instead of releasing it. The first publish is therefore a deliberate, named act, done once
per package, and never a side effect of a merge.

`.github/workflows/first-publish.yml` is the route for exactly that act. It is a manual
dispatch, one package key from `RELEASE_ORDER` as its only input, and it publishes **the
version already in that package's `package.json`**, with public access and a provenance
attestation, then reads the version back from the registry:

```bash
gh workflow run first-publish.yml --repo tinoy1336/pi-extensions -f package=sudo-approve
gh run watch --repo tinoy1336/pi-extensions
```

It exists because the hand route is not always available: npm rate-limits publishes, and an
account that has just published a batch of packages can be refused on the next one
(`E429 … rate limited exceeded`). The limit follows the ACCOUNT, not the source it publishes
from: measured, a dispatch from a GitHub runner for this account was refused with the same
`429 Too Many Requests - PUT … Could not publish, as user undefined: rate limited exceeded`
that a publish from a working machine had received minutes earlier, so a runner is not a way
around the window.

**A first publish can also be refused for AUTHORIZATION, and that refusal reads as a 404.**
Measured: the same dispatch answered `npm error 404 Not Found - PUT
https://registry.npmjs.org/@tinoy%2fpi-io-guard - Not found` for a name the registry holds no
version of, while `release.yml` had published a new version of an existing package with the
same repository token minutes earlier. The registry answers `404`, not `403`, for a name the
credential may not create, so the message does not separate "this name is free" from "this
token cannot create it". Neither of the other routes is a way around it: `npm stage publish`
requires the package to exist already (`staged publishing`), and a trusted publisher is
configured from a package's settings page, which a package with no published version does not
have.

What it refuses to do, and why each refusal is there:

- **A second version of anything.** Before it presents a credential it asks the registry
  whether the name exists at all. `404` is the only answer that lets the run continue; a
  `200` naming the versions already published stops it; any other answer stops it too,
  because a check that cannot tell "absent" from "unreachable" must not publish. The
  version published is the manifest's, and there is no input for a version or a dist-tag,
  so the path cannot mint a version, re-publish one, or move `latest` onto an older
  release.
- **A set of packages.** The input names one package. `both` — the release dispatch's word
  for every package — is rejected, and so is any value that is not a package key in this
  repository.
- **A push.** The workflow has one trigger, `workflow_dispatch`, and its job holds
  `contents: read` and `id-token: write` only: no merge to `main` can start it, it creates
  no tag, and it pushes no commit. The baseline tag is the other half of the bootstrap and
  is pushed separately, on the commit whose manifest carries the version that was just
  published.

It shares the `release` concurrency group with `release.yml`, so a first publish and a
release never work the registry account at the same time.

## Guardrails

- **Only after a green check.** The release trigger is CI's successful completion on
  `main`. A failed check releases nothing.
- **No release-worthy commit, no release.** semantic-release logs "There are no
  relevant changes, so no new version is released." and exits 0 without touching a
  version, a tag or the registry. The per-package path gate goes further: a
  `feat(canon)` push never starts the `ext-lib` release at all, so a package cannot be
  published for commits that never touched it.
- **No baseline tag, no release.** A package with no `<key>-v*` tag is refused before
  semantic-release runs. semantic-release measures the next version from the last tag, so
  with none it computes a first release of `1.0.0` and prepares that version into the
  manifest — not the `0.1.0` the manifest carries. The refusal sits in
  `.github/workflows/release.yml`, ahead of the path gate: an automatic run names the
  package in a warning annotation and skips it while releasing the rest, and an explicit
  dispatch that named that package fails (`::error::`, exit 2) instead of reporting success
  for a release that could not happen. The way past it is *The first publish* above — the
  dispatch publishes the version the manifest already carries, and the `<key>-v0.1.0` tag
  is pushed on that commit — never a hand-made tag, which is why the guard exists rather
  than a test.
- **A failed publish leaves no tag.** semantic-release creates and pushes the tag
  *before* it runs the publish plugins (`Create the tag before calling the publish
  plugins as some require the tag to exists`, `semantic-release/lib/index.js`), so the
  ordering itself cannot be inverted. The workflow compensates: it snapshots `git tag`
  before each package's release step, and on that step's failure
  `.github/scripts/withdraw-tag-if-unpublished.sh` removes exactly the tags that
  appeared — remote ref and local ref — leaving a previous successful package's tag
  alone. It asks the registry first, so a step that failed after `npm publish`
  succeeded keeps its tag; the deletion itself is `scripts/withdraw-tag.sh`.
- **OIDC first, the stored token as the fallback.** The release job passes the
  `NPM_TOKEN` secret to `@semantic-release/npm`, which asks the registry for an OIDC token
  first and, when that exchange does not succeed, writes `NPM_TOKEN` into the temporary
  `.npmrc` it hands to `npm publish`. A package whose trusted publisher is wired keeps
  using OIDC; a package with none publishes on the token instead of stopping at
  `ENONPMTOKEN`. Both paths produce a provenance attestation — that is what
  `NPM_CONFIG_PROVENANCE=true` and the job's `id-token: write` are for.

## One-time bootstrap

A package can only be released by CI once it is on the registry **and** carries a
baseline tag: semantic-release measures the next version from the last tag, so the
`release.yml` guard refuses a package that has none rather than publishing it as `1.0.0`.
Both halves are manual work, once per package. Do this in order.

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

   A hand publish can be refused with `E429 … rate limited exceeded`. That limit is
   bound to the account, not to the machine the publish comes from (*The first
   publish* above), so the dispatch there is refused for the same reason while the
   window is open and waiting it out is what clears it — measured: a
   publish batch was refused with `E429` at 05:00 UTC and a release publish for the
   same account succeeded at 05:11 UTC. Either route leaves the tag below as the
   remaining step.

3. **Push a baseline tag for every package**, on the commit whose `package.json`
   carries version `0.1.0`. semantic-release measures from the last tag: with no tag its
   first release would be `1.0.0`, which would not match what was just published.

   ```bash
   for k in $(ls packages); do git tag "${k}-v0.1.0"; done
   git push origin $(git tag --list '*-v0.1.0')
   ```

   A tag that already exists is reported by git and needs no action.

4. **(Deferred) Wire the trusted publisher on npm, once per package.** Nothing below is
   needed while the `NPM_TOKEN` secret publishes: a package with no publisher entry
   exchanges no OIDC token and publishes on the token instead. This becomes the required
   operator step again when the token route is retired, which is why it is kept. On
   <https://www.npmjs.com/package/@tinoy/pi-ext-lib> → *Settings* → *Trusted Publisher*
   → *GitHub Actions*, and fill in:

   Field | Value
   --- | ---
   Organization or user | `tinoy1336`
   Repository | `pi-extensions`
   Workflow filename | `release.yml`
   Environment | *leave empty*
   Allowed actions | tick `npm publish`

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

   A package with no entry logs `OIDC token exchange with the npm registry failed: 404
   OIDC token exchange error - package not found` and continues: `@semantic-release/npm`
   falls through to the token, which is the credential the publish actually uses. Without
   the secret in that fallback position the same log line is followed by `ENONPMTOKEN No
   npm token specified`, and the release stops there.

   **`npm publish` is required, not optional.** The exchange matches the organization,
   repository, workflow filename and environment; it does not match the action. A connection
   that allows only `npm stage publish` therefore exchanges its OIDC token successfully,
   signs and logs a provenance statement, and only then has the upload refused:

   ```
   npm error 403 403 Forbidden - PUT https://registry.npmjs.org/<name> - OIDC permission denied for this action
   ```

   That refusal names the action, which is what makes it read like a credential problem; the
   provenance statement logged moments earlier is the tell that it is not one. A newly created
   connection permits `npm stage publish` only — direct publishing is a separate opt-in — so a
   package added here arrives one tick away from that failure. It is a default, not a quirk:
   the same tick is owed per package — the two on the registry now, and each of the other 24 as
   it is first published, in the dependency order of the table above.

   An existing connection cannot be edited to add the action: delete it and create it again
   with `npm publish` ticked, or from the CLI (`npm trust` asks for 2FA):

   ```bash
   npm trust list @tinoy/pi-ext-lib                     # the connection's id
   npm trust revoke @tinoy/pi-ext-lib --id=<id>
   npm trust github @tinoy/pi-ext-lib \
     --file release.yml --repo tinoy1336/pi-extensions --allow-publish
   ```

   Four more properties of this surface, each measured by reading it back rather than inferred
   from what the form shows:

   **An authentication URL is live for about five minutes.** The CLI polls the registry for the
   approval, and roughly 300 s after the id is issued the registry has discarded it: the poll then
   answers `404 Not Found - GET https://registry.npmjs.org/-/v1/done?authId=*** - not found` and
   the call is lost, which is how a set of reads ends with every id expired and none approved.
   Holding one id open while someone is found does not work — issue a fresh one as each expires and
   keep rolling until one is approved. Tell the person directly as well: a popup in the
   notification centre expires in fifteen seconds, and eight heads-ups left there produced no
   approval at all.

   **One approval covers the whole set, but the reads are one call per package.**
   `npm trust list` is not a set-wide read: the package name is the positional argument, else the
   `name` of the local `package.json`, so from a directory holding neither it stops without a
   network call (`Package name must be specified either as an argument or in the package.json
   file`). Verify with `npm trust list <package>`, once per package: twenty-five reads take about
   seventy-five seconds, well inside one approved window.

   **A credential cannot be made to skip the challenge.** A granular token with 2FA bypass enabled
   is refused outright, with no challenge issued and no URL printed:

   ```
   npm error 403 403 Forbidden - POST https://registry.npmjs.org/-/package/<name>/trust - {"success":false,"error":"Granular access tokens that bypass two-factor authentication may not perform this action."}
   ```

   A token created with the bypass left unchecked is asked for a one-time password instead
   (`npm error code EOTP`, plus the authentication URL), and a request with no credential answers
   `401 Bearer token authorization is required`. The interactive approval is genuinely required:
   there is no unattended route to this surface, and the credential that publishes releases is not
   one that can wire the publisher.

   **What a connection stores.** Read back, a connection holds the repository, the workflow file
   *name* (`release.yml` — the name, never a path, matched case-sensitively against the workflow
   that publishes), no environment, and the set of allowed actions. Every connection read back
   carried `publish` and `stage publish` together, entries configured earlier included — a shape
   that uniform across a whole set reads as what the form stores by default rather than the choice
   made on each page, so a page that was ticked for `npm publish` alone is not evidence that the
   stored grant is that narrow.

5. **Let a release run.** Merge a `feat:` or `fix:` commit to `main` and watch
   *Actions* → *Release*.

If a release fails at `verifyConditions` with `ENONPMTOKEN No npm token specified`, the
`NPM_TOKEN` secret is missing or empty (the plugin logs it before it looks at the
registry) — the OIDC line above it is then only an explanation of why it wanted a token.
Its companion is `EINVALIDNPMTOKEN`: something presented a token (an `NPM_TOKEN`
variable, or an `_authToken` in `.npmrc`) and the registry refused it, so the secret needs
replacing. The 404 on OIDC is not evidence that the package is absent from the registry: a
published package with no publisher entry answers the same thing.

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
   (`.github/scripts/withdraw-tag-if-unpublished.sh`); if the run was killed before that, delete it by hand:

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
