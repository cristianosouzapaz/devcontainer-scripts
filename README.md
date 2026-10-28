# DevContainer Scripts

A template for bootstrapping isolated, reproducible development environments using VS Code Dev Containers.

[![License](https://img.shields.io/github/license/cristianosouzapaz/devcontainer-scripts)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/cristianosouzapaz/devcontainer-scripts)](https://github.com/cristianosouzapaz/devcontainer-scripts/commits/main)
[![VS Code Dev Containers](https://img.shields.io/badge/VS%20Code-Dev%20Containers-007ACC)](https://code.visualstudio.com/docs/devcontainers/containers)
![Windows · PowerShell 5.1+](https://img.shields.io/badge/Windows-PowerShell%205.1%2B-5391FE)
![Docker](https://img.shields.io/badge/-Docker-2496ED)

## Overview

This starter kit creates a **Fully Isolated DevContainer** using Docker Volumes. It keeps your source code and development environment completely contained within Docker, ensuring no file system pollution on your local machine while providing a clean, disposable, and reproducible workspace.

## Requirements

- **Windows** with **PowerShell 5.1+**, to run the launcher and the project picker
- **Docker**, local or on a remote host reached through a Docker context (see [Pinning a Docker Context](#pinning-a-docker-context))
- **VS Code** with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

## Quick Start

### 1. Initialize a New Project

Download the launcher — the only file you keep locally, no clone needed — and run it; the
execution-policy bypass applies to that one process only and changes no machine setting:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/cristianosouzapaz/devcontainer-scripts/stable/launcher.ps1 -OutFile launcher.ps1 -UseBasicParsing
powershell -ExecutionPolicy Bypass -File .\launcher.ps1
```

Each run downloads the latest released `project-init.ps1` and all template files from this repository's `stable` release channel into a temp folder and executes them automatically, so the saved launcher never needs refreshing. A launcher saved before it followed `stable` still downloads from `main`; download it again to follow releases.

The script prompts for project type, optional features, secrets file location, an optional Docker context name, destination path, project name, repository URL(s) and any extra workspace folders.

### 2. Configure Secrets

Create `%USERPROFILE%\.config\.env` on your machine to store credentials that the container needs at startup. This file is mounted read-only inside the container and never committed to source control.

If Docker runs on another machine, the file has to live on that machine instead — Docker resolves a mount source on the daemon's filesystem, not on yours. The script asks where it is during initialization and defaults to the local path above; set `DEVCONTAINER_SECRETS_PATH` on your Windows machine to have your usual remote location offered as a second option, one keypress away. It is never selected for you — a one-off setup step to redo if you rebuild that machine.

All other settings can be adjusted in `devcontainer.json` after the project is initialized.

### 3. Launch

1. Open the project folder (`C:\Projects\my-app`) in VS Code.
2. When prompted, click **Reopen in Container** (or press `F1` > `Dev Containers: Reopen in Container`).

On first launch, the setup script runs every setup module in dependency order — configuring Git, installing dependencies, and activating any optional features selected during initialization; a module whose inputs aren't configured skips itself.

### Pinning a Docker Context

If your machine drives more than one Docker daemon (for instance a local Docker Desktop and a remote host), the script also asks for an optional Docker context name. Answering it writes `containers.environment.DOCKER_CONTEXT` into a `settings.json` under a `.vscode` folder in the generated project, so opening that folder always builds against the intended daemon instead of whatever context happens to be active. Leaving the prompt blank writes nothing; no `.vscode` folder is created.

The key is read by the [Container Tools extension](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-containers) (`ms-azuretools.vscode-containers`); see its documentation for how it is applied and what happens without it installed.

Set `DEVCONTAINER_DOCKER_CONTEXT` on your Windows machine to have your usual context offered as an answer instead of retyping it for every project — a one-off setup step to redo if you rebuild that machine.

This pairs with the remote-daemon secrets path in step 2: the secrets path tells the project where credentials live on a remote daemon's filesystem, and the Docker context tells VS Code which daemon to use in the first place.

## Configuration

Environment variables control the setup behavior. Set non-secret variables in `devcontainer.json` and secrets in your local `.config/.env` file.

The generated `devcontainer.json` also sets `"shutdownAction": "none"`: the container keeps running after VS Code disconnects, until you stop it with `docker stop <project-name>`. To reattach to its Herdr session, reopen the project and run `herdr` in an integrated terminal, or, without VS Code, run `docker exec -it <project-name> herdr` on the Docker host.

### Secret Variables

These sensitive variables should be set in your local `.config/.env` file only:

| Variable                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Default |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------ |
| `GIT_CLONE_TOKEN`        | Global fallback PAT for authenticating git clone/fetch (GitHub, GitLab, Gitea, Bitbucket, or any HTTP(S) git host). Used for any host without a more specific `GIT_CLONE_TOKEN_<HOST>` (see below).                                                                                                                                                                                                                                                                                   | -       |
| `GIT_CLONE_TOKEN_<HOST>` | Per-host PAT override, for setups where `REPO_SOURCE_N` spans multiple git hosts each needing a different token. Falls back to `GIT_CLONE_TOKEN` when unset — see [Multi-repo](#multi-repo) for the naming rule.                                                                                                                                                                                                                                          | -       |
| `GIT_SIGNING_KEY`        | SSH public key for commit signing (e.g. `ssh-ed25519 AAAA...`). Required for SSH commit signing.                                                                                                                                                                                                                                                                                                                                                                                      | -       |
| `NGROK_AUTHTOKEN`        | Token to configure ngrok tunneling                                                                                                                                                                                                                                                                                                                                                                                                                                                    | -       |
| `PERSIST_<NAME>`         | Variables prefixed with `PERSIST_` are written to `/etc/environment` with the prefix stripped — `PERSIST_FOO` becomes `FOO` for all container processes.                                                                                                                                                                                                                                                                                                                                                                                          | -       |

### Configuration Variables

These variables control the behavior of the DevContainer setup. The defaults below are the
values `project-init.ps1` writes into the generated `devcontainer.json` under `remoteEnv`. A
row with no default is either filled in from your answers or not written there at all, and
`SCRIPTS_REF`'s default comes from the Dockerfile build arg. Deleting a variable from
`remoteEnv` doesn't disable it — setup falls back to its own built-in default, which for a few
variables differs (`AUTO_UPDATE` falls back to `false` and `LOG_FILE` to stderr only, both in
`scripts/setup/lib/loader.sh`; `AGENT_ASSETS_REF` is resolved by the sync task itself,
in `scripts/sync-agent-assets.sh`).

| Variable            | Description                                                                                                                                                                                                                                                  | Default          |
| :------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------- |
| `AGENT_ASSETS_REF`  | Git ref the *Sync Global Agent Assets* task fetches machine-wide skills, commands and the installer from. Not set by `project-init.ps1`: unset, the task follows the `stable` release channel, falling back to `SCRIPTS_REF`. Set `main` to follow unreleased code. | -                |
| `AUTO_UPDATE`       | Automatically fetch and pull updates from remote repository (true/false)                                                                                                                                                                                     | `true`           |
| `CLEAN_CREDENTIALS` | Remove git credentials after setup (true/false)                                                                                                                                                                                                              | `false`          |
| `DEBUG_MODE`        | Enable debug-level logging output and UTC timestamps on the top-level step lines (true/false)                                                                                                                                                                | `false`          |
| `DEFAULT_BRANCH`    | Git branch to checkout and work with                                                                                                                                                                                                                         | `main`           |
| `DUMP_ERROR_STACK`  | Print error stack trace when exiting (true/false)                                                                                                                                                                                                            | `true`           |
| `EXTRA_FOLDER_N`    | Numbered extra workspace folder names: `EXTRA_FOLDER_1`, `EXTRA_FOLDER_2`, … Each is already bind-mounted at `/workspace/<name>`; used to add it as a root in the generated `.code-workspace`. Set automatically by `project-init.ps1`.                      | -                |
| `GIT_EMAIL`         | Email for git configuration (required)                                                                                                                                                                                                                       | -                |
| `GIT_USER`          | Git username for git configuration and repository URLs (required)                                                                                                                                                                                            | -                |
| `LOG_FILE`          | Path to log file (if empty, logs to stderr only)                                                                                                                                                                                                      | `/tmp/setup.log` |
| `LOG_LEVEL`         | Minimum log level: `DEBUG`, `INFO`, `SUCCESS`, `WARNING`, `ERROR`, `FATAL`                                                                                                                                                                                   | `INFO`           |
| `NO_COLOR`          | Set to any non-empty value to disable color in the log output; the status symbols (`⚙ → ✔ ⚠ ✖`) are kept. Log-file output is never colored regardless.                                                                                                | -                |
| `PROJECT_NAME`      | Project identifier. Used as the target directory in single-repo mode and to name the generated `.code-workspace` file whenever one is generated (multi-repo, or any extra workspace folders). Set automatically by `project-init.ps1`, and also passed as a Dockerfile build arg so the image can pre-create `/workspace/<PROJECT_NAME>`.                                                                                     | -                |
| `REPO_SOURCE`       | Clone URL for single-repo mode (`https://host/owner/repo.git`). Set automatically by `project-init.ps1`.                                                                                                                                                     | -                |
| `REPO_SOURCE_N`     | Numbered clone URLs for multi-repo mode: `REPO_SOURCE_1`, `REPO_SOURCE_2`, … Repos may span multiple git hosts — each host resolves its own token via `GIT_CLONE_TOKEN_<HOST>` (falling back to `GIT_CLONE_TOKEN`). Set automatically by `project-init.ps1`. | -                |
| `REQUIRE_DEPENDENCY_INSTALL` | Fail container setup if the project's dependencies can't be installed (true/false). When `false`, a failed install is only a warning.                                                                                                                       | `false`          |
| `SCRIPTS_REF`       | Git ref the image fetches the setup scripts from. Set as a Dockerfile build arg and persisted as an env var; defaults to the release tag (`vX.Y.Z`) the Dockerfile ships in, and is the *Sync Global Agent Assets* task's fallback when the `stable` channel does not resolve. | release tag      |
| `SSH_SIGNING`       | Enable SSH commit signing via the forwarded host SSH agent (true/false). Set by `project-init.ps1` based on feature selection.                                                                                                                        | `true`           |
| `STRUCTURED_LOGS`   | Output logs in JSON format (true/false)                                                                                                                                                                                                                      | `false`          |
| `VALIDATE_TOKEN`    | Verify git token connectivity on startup (true/false)                                                                                                                                                                                                        | `true`           |

### Following Unreleased `main`

A project builds and syncs released code by default. To follow `main` instead, set both refs in its `devcontainer.json`: `"SCRIPTS_REF": "main"` under `build.args` (or `args:` in `docker-compose.yml`) for the image, and `"AGENT_ASSETS_REF": "main"` under `remoteEnv` for the *Sync Global Agent Assets* task. A project generated before the `stable` channel existed carries `"AGENT_ASSETS_REF": "main"` in `remoteEnv`; remove that line to follow releases.

## Package Manager Detection

When a cloned repository contains a `package.json`, the setup script automatically selects the right package manager without any configuration:

| Signal                                   | Package manager used |
| :--------------------------------------- | :------------------- |
| `packageManager` field in `package.json` | as declared          |
| `pnpm-lock.yaml` present                 | pnpm                 |
| `package-lock.json` present              | npm                  |
| `yarn.lock` present                      | yarn                 |
| No lock file found                       | npm (default)        |

The pnpm store persists between rebuilds, so packages are only downloaded once.

## Single-repo

In single-repo mode, the container mounts a single volume at `/workspace`, with the cloned repository under `/workspace/<PROJECT_NAME>`. VS Code opens that folder directly, without a `.code-workspace` file. The image pre-creates `/workspace/<PROJECT_NAME>`, so on a freshly created volume that folder already exists when VS Code first attaches — before `postCreateCommand` clones into it.

If extra workspace folders are configured, VS Code opens the shared `/workspace` root instead,
so those folders are visible in Explorer from the first attach.

## Multi-repo

During initialization entering two or more repository URLs activates multi-repo mode:

- Each repo is cloned into its own subfolder `/workspace/<REPO_NAME>` of the single `<ProjectName>-data` volume — there are no per-repo volumes.
- That volume is mounted at `/workspace` and persists the `.code-workspace` file across rebuilds.
- VS Code attaches to the shared `/workspace` root; open the generated `<ProjectName>.code-workspace` for the multi-root view, where each repo appears as a labeled root in the Explorer.
- **Repos can span multiple git hosts** (e.g. one on GitHub, one on a private GitLab instance). Each host resolves its own clone token: set a host-specific `GIT_CLONE_TOKEN_<HOST>` in `.config/.env` for any host other than the one covered by your global `GIT_CLONE_TOKEN`. `<HOST>` is the repo's host, uppercased, with every non-alphanumeric character replaced by `_` — `gitlab.example.com` → `GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM`, `203.0.113.45:8929` → `GIT_CLONE_TOKEN_203_0_113_45_8929`. `project-init.ps1` prints the exact variable name to add as soon as you enter a non-GitHub repo URL. Example for GitHub + a private GitLab reachable at `gitlab.example.com`:

  ```bash
  # .config/.env
  GIT_CLONE_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx            # fallback, covers github.com
  GIT_CLONE_TOKEN_GITLAB_EXAMPLE_COM=glpat-xxxxxxxxxxxxxxxxxxxx       # specific to gitlab.example.com
  ```

## Extra Workspace Folders

Optionally bind-mount host folders as extra roots in the
generated `.code-workspace`. Optional and available in both single- and multi-repo mode.

For each folder, provide a host path (absolute, or relative to `%USERPROFILE%` —
validated on the spot) and a name, used as both the mount target (`/workspace/<name>`)
and the `.code-workspace` label. If Docker runs on another machine, give the folder's path
on that machine instead (e.g. `/srv/data/vault`) — it can't be checked from Windows, so it's
taken as typed.

## Persistent Data

Persistent tool credentials and configuration live in one shared Docker volume,
`devcontainer-shared-data`, mounted at `/var/lib/devcontainer` and reused by every project
built from this template on the same Docker host. Every declared coding agent gets its own
directory inside it; some categories are scoped to the project volume instead, and some are
reached through a managed symlink in the home directory rather than directly. Run
`devcontainer-data list` for the current set of categories.

Reset one category with `devcontainer-data reset <id>`; it clears that category's
directory after a confirmation and never removes a Docker volume. Resets that invalidate the
Herdr agent integrations re-apply them automatically. Add `--yes` for non-interactive use.

After rebuilding to receive a revised Herdr template, run `devcontainer-data update herdr` to
adopt it without silently replacing local configuration. To replace a modified configuration
without a prompt, add `--replace --yes`; every replacement backs up the local configuration
first.

If a tool suddenly behaves as if it were logged out, run `devcontainer-data status --health`
before logging in again. It is a read-only diagnostic that checks the persistent layout and
coding-agent dependencies, and gives every problem either a safe command or an explicit manual
action. Add `--json` for automation. A missing managed symlink puts credentials out of reach
without touching them; `devcontainer-data repair` restores it when that is safe.

## Authentication

### Claude Authentication

Claude authentication data is stored in the `claude` category of the shared volume.

- **First use**: run `claude auth login` once inside any container to authenticate via OAuth.
- **Subsequent rebuilds**: credentials are automatically available — no re-login required.
- **Reset**: run `devcontainer-data reset claude` to force re-authentication.

### Codex Authentication

Codex authentication data and its local configuration are stored in the `codex` category
of the shared volume. This includes `auth.json`, which contains access tokens and
must never be copied into a repository or shared.

- **First use**: run `codex login` inside any container; see the Codex CLI's own documentation for its other login modes.
- **Subsequent rebuilds**: credentials and Codex configuration are automatically available — no re-login required.
- **Reset**: run `devcontainer-data reset codex` to remove the cached login and local Codex environment.

### Pi Authentication

Pi authentication data, sessions and extension packages are stored in the `pi` category
of the shared volume.

- **First use**: run `pi` inside any container and authenticate with your chosen provider.
- **Subsequent rebuilds**: credentials, sessions and extensions are automatically available — no re-login required.
- **Reset**: run `devcontainer-data reset pi` to remove the cached login and local Pi environment.

### GitHub CLI Authentication

The **GitHub CLI** feature is always installed. Its authentication (`/root/.config/gh`) is likewise stored in the `github` category of the shared volume, shared by every project built from this template.

- **First use**: run `gh auth login` once inside any container.
- **Subsequent rebuilds**: the session is automatically available — no re-login required.
- **Reset**: run `devcontainer-data reset github` to force re-authentication.

### Global Agent Assets

The `agents` category of the shared `devcontainer-shared-data` volume, surfaced at
`/root/.agents` via a managed symlink (always on), holds machine-wide agent skills and
commands rather than credentials. It is populated by the `Framework: Sync Global Agent
Assets` task and shared by every project built from this template.

- **First use**: run the task once inside any container.
- **Update**: re-run the task; it re-fetches from the latest release (the `stable` channel), or from `AGENT_ASSETS_REF` when set.
- **Reset**: run `devcontainer-data reset agents` (follow it with a re-sync to repopulate).
- **Working-agreement mod**: the task also installs the Claude Code mod that enforces the
  working agreement. It is on by default in every session; turn it off with
  `claude plugin disable working-agreement@skills-dir` and back on with
  `claude plugin enable working-agreement@skills-dir`. A sync never changes that choice.

## SSH Commit Signing

Enabled by default. Can be toggled off during initialization.

**Prerequisites:**
- A host SSH agent running and forwarded into the container, so `SSH_AUTH_SOCK` points at a live socket. Some agents need their SSH agent turned on before they expose one; see the agent's own documentation.
- `GIT_SIGNING_KEY` set in your secrets `.env` file (your SSH public key, e.g. `ssh-ed25519 AAAA...`)


## Extending Your DevContainer

The DevContainer can be extended on demand with **skills**, **configuration file templates**,
**agent instructions**, and **workflow prompts** for common project tooling. The installers run
from a terminal inside the container; the image also ships VS Code task definitions at
`/opt/devcontainer/tasks.json`, which reach a project once copied into its `.vscode/tasks.json`.

```bash
devcontainer-install skills        # Skills
devcontainer-install configs       # Config templates
devcontainer-install agents        # Agent instruction/prompt templates
devcontainer-install agent-md      # CLAUDE.md / AGENTS.md blocks
devcontainer-install interactive   # Menu over all of the above
```

A curated set of skills and commands can also be installed **machine-wide** instead of
per project, via the `Framework: Sync Global Agent Assets` task (or
`devcontainer-install sync`). They persist in the `agents` category of
the shared `devcontainer-shared-data` volume and the per-project installers then show them
as already installed.

## License

MIT — see [LICENSE](LICENSE).
