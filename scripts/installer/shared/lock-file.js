import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * @fileoverview `template-lock.json` — the record of which canonical assets an installer
 * wrote and which native adapter files/symlinks it materialized for them. Lives in the
 * project root for a per-project install, or in `~/.agents` for a `--global` sync.
 */

const LOCK_VERSION = "2";

/** A fresh, empty lock structure for the current schema version. */
const emptyLock = () => ({ version: LOCK_VERSION, updatedAt: "", configs: {}, artifacts: {}, mdBlocks: {} });

/**
 * Merge a native adapter record into an agent's adapter list in place: update an existing
 * entry with the same path and type, otherwise append. No-op when agent or adapter is falsy.
 * @param {Record<string, object[]>} adapters - Map of agent name to adapter entries.
 * @param {string} agent - Agent name key.
 * @param {{ path: string, type: string }} adapter - Adapter record to merge.
 */
const addAdapter = (adapters, agent, adapter) => {
    if (!agent || !adapter) return;
    const entries = adapters[agent] ?? [];
    const existing = entries.find((entry) => entry.path === adapter.path && entry.type === adapter.type);
    if (existing) Object.assign(existing, adapter);
    else entries.push(adapter);
    adapters[agent] = entries;
};

/**
 * Read and parse template-lock.json from a root directory. Returns a default empty structure
 * when the file is missing, invalid, or written to another schema version.
 * @param {string} projectRoot - Absolute path to the root that holds template-lock.json.
 * @returns {{ version: "2", updatedAt: string, configs: object, artifacts: object, mdBlocks: object }}
 */
export const readLockFile = (projectRoot) => {
    try {
        const parsed = JSON.parse(readFileSync(join(projectRoot, "template-lock.json"), "utf8"));
        if (parsed.version !== LOCK_VERSION) return emptyLock();
        return {
            ...emptyLock(),
            ...parsed,
            configs: { ...(parsed.configs ?? {}) },
            artifacts: { ...(parsed.artifacts ?? {}) },
            mdBlocks: { ...(parsed.mdBlocks ?? {}) },
        };
    } catch {
        return emptyLock();
    }
};

/**
 * Write lock data to template-lock.json, always stamping `updatedAt` with the current time.
 * @param {string} projectRoot - Absolute path to the root that holds template-lock.json.
 * @param {{ version: "2", configs: object, artifacts: object, mdBlocks: object }} lockData
 */
export const writeLockFile = (projectRoot, lockData) => {
    const data = { ...lockData, version: LOCK_VERSION, updatedAt: new Date().toISOString() };
    writeFileSync(join(projectRoot, "template-lock.json"), JSON.stringify(data, null, 4) + "\n", "utf8");
};

/** Return an artifact's installed version, if tracked. */
export const getArtifactVersion = (lock, path) => lock.artifacts?.[path]?.version ?? null;

/** Record a canonical artifact and merge its materialized native adapters. */
export const recordArtifact = (lock, path, { kind, version, adapters = {}, source }) => {
    const existing = lock.artifacts[path] ?? { kind, adapters: {} };
    const mergedAdapters = { ...(existing.adapters ?? {}) };
    for (const [agent, entries] of Object.entries(adapters)) {
        for (const entry of entries) addAdapter(mergedAdapters, agent, entry);
    }
    lock.artifacts[path] = {
        ...existing,
        kind,
        ...(version === undefined ? {} : { version }),
        ...(source === undefined ? {} : { source }),
        adapters: mergedAdapters,
    };
};

/** Remove adapter records that no longer match their materialized filesystem entry. */
export const reconcileArtifactAdapters = (lock, root, path) => {
    const artifact = lock.artifacts?.[path];
    if (!artifact) return false;

    const before = JSON.stringify(artifact.adapters ?? {});
    const adapters = {};
    for (const [agent, entries] of Object.entries(artifact.adapters ?? {})) {
        const present = entries.filter((adapter) => {
            try {
                const stats = lstatSync(join(root, adapter.path));
                if (adapter.type === "symlink") {
                    const linkPath = join(root, adapter.path);
                    return stats.isSymbolicLink()
                        && typeof adapter.target === "string"
                        && resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(root, adapter.target);
                }
                return adapter.type === "file" && stats.isFile();
            } catch {
                return false;
            }
        });
        if (present.length > 0) adapters[agent] = present;
    }
    artifact.adapters = adapters;
    return before !== JSON.stringify(adapters);
};

/**
 * Lock-file adapter record for a `.claude/skills/<skillName>` symlink pointing at the
 * canonical skill directory.
 * @param {string} skillName - Portable Agent Skill name.
 * @returns {{ path: string, type: "symlink", target: string }}
 */
export const claudeSkillAdapter = (skillName) => ({
    path: join(".claude", "skills", skillName),
    type: "symlink",
    target: join(".agents", "skills", skillName),
});

/**
 * Lock-file adapter record for a `.claude/rules/<filename>` symlink pointing at a canonical
 * skill's SKILL.md.
 * @param {string} skillName - Portable Agent Skill name.
 * @param {string} filename - Rule filename under .claude/rules/.
 * @returns {{ path: string, type: "symlink", target: string }}
 */
export const claudeRuleAdapter = (skillName, filename) => ({
    path: join(".claude", "rules", filename),
    type: "symlink",
    target: join(".agents", "skills", skillName, "SKILL.md"),
});
