# Branch protection: no direct pushes, anywhere

No one can `git push` directly to *any* branch on this repo anymore — not `main`/`dev-staging`/`dev-stable`/`production`/`development`, and not your own personal branch (`dev-yourname`, etc.) either. Everything lands via a pull request, including changes to your own branch.

## Why

A supply-chain incident (September 2026) got in by pushing straight to branches with write access — including personal branches, not just shared ones. An obfuscated payload was injected into a build config file (auto-executes on `dev`/`build`), and `.gitignore` was weakened to stop excluding `.env`. It happened twice, hitting nearly every branch across the org both times.

If personal branches stayed pushable, that's still an open door for the same thing to happen again and quietly work its way into shared branches later via a normal PR. Requiring a PR for every branch — even a self-merged, zero-approval one on your own branch — means any write has to go through GitHub's merge API, which a stolen token can't silently bypass the way a raw push could.

Force-push and branch deletion are blocked permanently on every branch, for everyone, admins included. That's not getting relaxed later.

## One-time setup

```bash
winget install --id GitHub.cli   # or your OS's equivalent
gh auth login
```

## Walkthrough: Francis working on `dev-francis`

Francis **cannot** do this anymore — it will be rejected, even though it's his own branch:
```bash
git checkout dev-francis
git commit -am "some change"
git push                          # ❌ rejected: "Changes must be made through a pull request"
```

Instead, he works on a throwaway topic branch, and PRs *that* into `dev-francis`:
```bash
git checkout dev-francis
git pull
git checkout -b dev-francis-topic     # 1. new branch, off dev-francis
git commit -am "some change"          # 2. commit here — can be multiple commits over time,
git commit -am "another change"       #    keep working on this branch as long as you're mid-task
git push -u origin dev-francis-topic  # 3. push THIS branch — allowed, it has no protection rule

gh pr create --base dev-francis --title "..." --body "..."   # 4. PR: dev-francis-topic → dev-francis
gh pr merge --auto --squash                                   # 5. merges automatically, no approval needed
                                                               #    (it's his own branch)

git checkout dev-francis && git pull   # 6. sync back up, then delete the topic branch
git branch -d dev-francis-topic
git push origin --delete dev-francis-topic
```

You don't need a new topic branch per commit — just per chunk of work you're ready to land on your branch. Keep committing to the same topic branch while you're mid-task, open the PR when it's ready, then start a fresh topic branch for the next chunk.

## Landing something on a shared branch

Same shape, but a shared branch (`main`, `dev-staging`, `dev-stable`, `production`, `development`) needs 1 approval before it merges:

```bash
git checkout -b fix/whatever
git push -u origin fix/whatever
gh pr create --base dev-staging --title "..." --body "..."
gh pr merge --auto --squash
```

It sits until someone runs `gh pr review <number> --approve` (or approves from the GitHub web UI), then merges automatically.
