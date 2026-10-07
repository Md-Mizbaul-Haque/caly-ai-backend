This is a Node/Express REST API. Prioritize security, validation (Zod), and owner-scoped data access.

## Commands

```bash
npm run dev    # start dev server (nodemon)
npm test       # run tests
```

## Git safety — never lose code (2 separate repos)

This folder `caly-ai-backend/` is its own git repo. There is NO root git — NEVER run git commands in parent `E:\Caly Ai\`.

After EVERY feature, update, delete, or rename — BEFORE running `npm run dev`, tests, or declaring done:

1. `git status --short --branch` (must run inside `caly-ai-backend/`)
2. `git add .` (respects `.gitignore` — never `git add -f .env uploads/ *.key *.pem test-token.txt`)
3. `git status` again to confirm everything is staged (`A`/`M`/`D`, no unexpected `??` except ignored files)

Do NOT use `git checkout .`, `git reset --hard`, `git clean -fd`, or `git stash` unless the user explicitly asked — those lose unstaged work.
