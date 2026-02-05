# GigaSoftware OpenClaw Fork

## Remotes

- **origin** → `git@github.com:GiGaSoftwareDevelopment/openclaw.git` (our fork)
- **upstream** → `https://github.com/openclaw/openclaw.git` (source repo)

## Sync from Upstream

Pull latest changes from the source repo into our fork:

```bash
cd ~/Dev/openclaw
git fetch upstream
git checkout main
git merge upstream/main
# Resolve conflicts if any (our .giga/ directory should never conflict)
git push origin main
```

### When to sync

- Before starting new work
- When upstream releases a new version
- Periodically (weekly or biweekly)

### Conflict strategy

- **`.giga/` directory** — always keep ours (upstream doesn't have it)
- **Extension files we've modified** — review diff carefully, merge our changes on top
- **Everything else** — take upstream's version

## Our Customizations

All GigaSoftware-specific files live in `.giga/` to avoid upstream conflicts:

- `.giga/FORK.md` — this file
- `.giga/CHANGELOG.md` — our changes on top of upstream
- `.giga/JIRA.md` — Jira project info and ticket conventions

## Branch Conventions

- `main` — mirrors upstream + our merged changes
- `feat/CLAW-XX-description` — feature branches per Jira ticket
- Keep feature branches short-lived; merge to main via PR

## Jira

- **Project:** CLAW
- **Board:** https://gigasoftware.atlassian.net/jira/software/projects/CLAW/board
- **Commit format:** `feat(CLAW-XX): description`
- **Branch format:** `feat/CLAW-XX-short-description`

## Repo Location

`~/Dev/openclaw`
