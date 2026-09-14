# Branch protection: no direct pushes, anywhere

No one can `git push` directly to *any* branch on this repo anymore — not `main`/`dev-staging`/`dev-stable`/`production`/`development`, and not your own personal branch (`dev-yourname`, etc.) either. Everything lands via a pull request.

## Why

A supply-chain incident (September 2026) got in by pushing straight to branches with write access — including personal branches, not just shared ones. An obfuscated payload was injected into a build config file (auto-executes on `dev`/`build`), and `.gitignore` was weakened to stop excluding `.env`. It happened twice, hitting nearly every branch across the org both times.

If personal branches stayed pushable, that's still an open door for the same thing to happen again and quietly work its way into shared branches later via a normal PR. Requiring a PR for every branch — even a self-merged, zero-approval one on your own branch — means any write has to go through GitHub's merge API, which a stolen token can't silently bypass the way a raw push could.

Force-push and branch deletion are blocked permanently on every branch, for everyone, admins included. That's not getting relaxed later.

## One-time setup

```bash
winget install --id GitHub.cli   # or your OS's equivalent
gh auth login
```

## Working on your own branch

Push to a fresh topic branch, then PR it into your own branch and self-merge — no one else needs to approve:

```bash
git checkout -b dev-yourname-whatever-youre-doing
git push -u origin dev-yourname-whatever-youre-doing
gh pr create --base dev-yourname --title "..." --body "..."
gh pr merge --auto --squash
```

## Landing something on a shared branch

Same shape, but a shared branch (`main`, `dev-staging`, `dev-stable`, `production`, `development`) needs 1 approval before it merges:

```bash
git checkout -b fix/whatever
git push -u origin fix/whatever
gh pr create --base dev-staging --title "..." --body "..."
gh pr merge --auto --squash
```

It sits until someone runs `gh pr review <number> --approve` (or approves from the GitHub web UI), then merges automatically.
