# Releasing RelayRoom

For maintainers. Everything here has to be done by a person - there is no
"release" button, and one step deliberately cannot be automated.

Server, web and the client packages ship **in lockstep under one version**. That
is enforced by the `fixed` group in `.changeset/config.json`; do not bump a
package on its own.

## What goes where

| Artifact | How | Automated |
|---|---|---|
| `@relayroom/cli`, `@relayroom/install` | `pnpm release` (`changeset publish`) | **No - local, needs npm auth** |
| `ghcr.io/relayroom/relayroom-{server,web}` | `Release images` workflow, manual dispatch | Yes, once dispatched |
| GitHub release + tag | `gh release create` | No |

The other five packages are `private: true` and are never published; changesets
still versions them so the lockstep number stays true.

### Why npm publishing is manual

The npm release workflow was removed in `9cbd84a`. OIDC trusted publishing never
authenticated across 0.3.3 through 0.3.9 - E404 with an empty `setup-node` token,
then ENEEDAUTH once that was removed, because npm will not do the OIDC exchange
through the `changesets`/`pnpm publish` path. Every release from 0.3.0 onward
shipped by running `pnpm release` locally.

**Read that commit message before trying to automate it again.** It is a
well-explored dead end.

## Steps

**1. Merge the feature PRs.** Each should carry a `.changeset/*.md`. A PR with no
user-visible effect (internal refactor, test-only) correctly has none.

**2. Version.**

```sh
pnpm version-packages     # = changeset version
```

This bumps all seven `package.json` files and consumes the changesets. It also
writes per-package `CHANGELOG.md` files, which this repo does **not** use -
delete them; the root `CHANGELOG.md` is the only changelog.

**3. Write the root `CHANGELOG.md` entry by hand.** Keep a Changelog headings
(`Added` / `Fixed` / `Changed` / `Security`). Say what a reader would have
experienced, not what the diff did. Call out migrations and anything that changes
behavior for an existing install.

**4. Open a `release/X.Y.Z` PR** and let CI pass before merging, as with any other
change.

**5. Tag and publish the release, from the merge commit.**

```sh
git tag -a vX.Y.Z -m "RelayRoom X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --notes-file <the new CHANGELOG section>
```

**6. Publish to npm.**

```sh
npm whoami || npm login
pnpm release
```

**7. Build the images.** Actions -> `Release images` -> Run workflow, version
`X.Y.Z`. It builds amd64 and arm64 on native runners and merges them into one
multi-arch manifest tagged `:X.Y.Z` and `:latest`.

## Two things that have bitten us

**The tag and the images must come from the same commit.** The workflow builds
whatever `main` currently points at, not the tag. If anything lands between the
tag and the dispatch, the published image is not the tagged source. Check:

```sh
git rev-parse vX.Y.Z^{commit} origin/main    # must print the same sha twice
```

**The image build is not covered by CI.** `ci.yml` runs the test suite and builds
the CLI; the Docker images are built only by the release workflow. A change that
breaks an image build therefore surfaces at release time, after npm has already
published. This happened in 0.4.1. Until CI covers it, build the web image locally
before tagging:

```sh
docker build -f apps/web/Dockerfile --build-arg RELAYROOM_VERSION=X.Y.Z -t rr-verify .
```

## Do not add a new hardcoded version

Every version an instance reports derives from `package.json`, which changesets
maintains. Four hand-maintained copies had drifted apart before 0.4.1, and an
instance built from source reported itself as `0.3.2` while the release was
`0.4.0`. If you find yourself typing a version number into source, that is the bug
returning.
