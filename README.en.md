# communitd

A Discord bridge that dispatches @mentions to Claude Code agents running on your own machine.

The name is `community` + `-d` — the daemon suffix of `httpd` / `sshd`, and the `d` of Discord:
a community of bots, kept resident.

*日本語: [README.md](README.md) — the full documentation is in Japanese.*

## What it is

You mention a bot in a Discord channel; the bridge starts the local `claude` CLI in that
channel's working directory and posts the result back in a thread. Bots hand work to each
other, so a single request can go **ask → implement → verify → reviewed result** without you
touching the keyboard in between.

- **The channel is the project, the thread is the unit of work.** Channel name maps to a
  working directory and a permission set; every mention opens a thread and keeps a Claude
  session per thread and bot.
- **Agents call each other with control footers.** A line of `[[handoff:<bot key>]]` at the end
  of a reply is the *only* way one bot starts another. Plain `@name` in prose is never
  converted, so quoting an example cannot trigger anything.
- **Delegation is a contract, not a convention.** The manager emits a structured delegation
  (background / goal / touch set / acceptance criteria / stop conditions) and the touch set
  becomes the worker's **actual write permission** — editing outside it is refused by the tool
  layer, not by discipline.
- **Machine verification before hand-back.** A channel can define `verify` (for example
  `npm test`); a failing run is fed back into the same session, and a final failure stops the
  handoff instead of passing broken work along.

## How it works

```
you ──@mention──▶ manager: scope & split ──[[handoff:worker]]──▶ worker: implement
                     ▲                                             │
                     └────────── [[handoff:manager]] (review) ◀─────┘
```

Role prompts come in three layers: `roles/_common.md` (shared rules) → `roles/<role>.md` (that
bot's job) → a **runtime context block** the bridge generates per job (permissions, who is
callable, working directory). When they disagree, the runtime context wins — writing "who
exists" or "what is writable" into a role prompt makes it lie the moment you change settings.

The role name is the **filename** of the role prompt: a bot pointing at `roles/worker.md` is
the `worker` role, and that name is what the runtime context and the other role prompts use to
address it.

## Requirements

- **A Claude subscription (Pro / Max or similar).** The bridge launches your local `claude` CLI
  and reuses **its** authentication — no API key is needed, but **this does not run for free**.
- **Node.js 20.6+**, **git**, and a **`claude` CLI that is already authenticated**
  (`claude -p "test"` must answer)
- **`codex` CLI** only if you want a reviewer bot on the codex runtime
- **A Discord server you administer**, plus two bot applications to invite into it
- **OS**: verified on Windows 11. macOS / Linux are branched for in code but **not verified on
  real hardware** (CI runs the unit tests on ubuntu).

## Quick start

Full walkthrough: [SETUP.md](SETUP.md) (Japanese). The short version:

1. `git clone` this repository and run `npm ci`.
2. `cp config.policy.example.json config.policy.json` — set `channels.<name>.cwd` to your
   project's absolute path. The channel key must match the Discord channel name.
   This example is **read-only by default** (`"tools": "readonly"`, `"permissionMode": "default"`):
   the agent reads, but never writes files or runs shell commands. To let it edit and run
   `git`/`node`/`npm` (needed for step 10), copy `config.policy.dev.example.json` instead —
   picking the stronger setup is a deliberate, separate step.
3. Create a Discord server if you do not have one, and a text channel matching the channel key.
4. `cp config.secrets.example.json config.secrets.json` — fill in `guildId` and
   `allowedUserIds` from the server you just made (Discord → Advanced → Developer Mode, then
   right-click to copy IDs).
5. `cp .env.example .env`.
6. Create two bot applications at <https://discord.com/developers/applications>. For each:
   reset the token, turn **MESSAGE CONTENT INTENT** on, and invite it with the `bot` and
   `applications.commands` scopes.
7. Paste the two tokens into `.env` as `MANAGER_DISCORD_TOKEN` and `WORKER_DISCORD_TOKEN`.
8. Run **`npm run doctor`**. It touches nothing — it just reports config, CLI, working
   directory and `data/` state as ✅ / ⚠️ / ❌. Fix every ❌ before starting.
9. `npm start`. You should see `[manager] logged in as ...` for each bot.
10. In your channel: `@Manager write "hello" into hello.txt, delegate it to Worker`. The
    manager delegates, the worker implements, the manager checks and reports back.

## Security warning

**This bridge turns Discord messages into command execution on your machine.** Read the
permission model before you widen anything:

- **Everyone in `allowedUserIds` effectively has your shell.** They can make the agent read and
  write files under a channel's `cwd` and run the shell commands you allowed there. Treat
  adding a user as handing them a terminal on this machine.
- `guildId` and `allowedUserIds` are **mandatory**; the bridge refuses to start without them
  rather than treating "unset" as "unrestricted".
- **Defaults are least privilege**: a channel with no `tools` key is `readonly`, and
  `permissionMode` defaults to `default`. Writing and shell access only exist where you wrote
  them explicitly.
- **Prompt injection is a real path here.** Thread text, quotes and attachments (including text
  *inside images* and the contents of uploaded text files) reach the model nearly verbatim.
  Granting `WebFetch`/`WebSearch` *and* write access to the same channel means the wording of a
  fetched page can cause local changes or exfiltration.
- **`.claude/agents/*.md` definitions are closer to code than to config** — they can change
  permissions, tools, working directory, execution paths and persistent state. Only load ones
  you trust.
- For shared or public servers, keep channels `readonly`; if you need writes, use a separate
  bot and channel scoped to a throwaway working tree.

Details: [docs/reference/security-model.md](docs/reference/security-model.md) (Japanese).

## Full docs are in Japanese

[README.md](README.md) is the entry point, [SETUP.md](SETUP.md) is the setup walkthrough, and
`docs/reference/` holds the reference pages: security model, operations (triggers, the job
queue and what each slash command refuses), tool permissions, control markers, delegation
contract, codex runtime, extra read directories, attachments, tool trace, metrics, prompt cache.

## License

MIT — see [LICENSE](LICENSE). Security notes and how to report a vulnerability privately:
[SECURITY.md](SECURITY.md). Release notes: [CHANGELOG.md](CHANGELOG.md).
