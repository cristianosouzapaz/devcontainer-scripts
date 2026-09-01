import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** @fileoverview Immutable loading, updating, reconciliation, and persistence for template locks. */

const LOCK_VERSION = "2";
const emptyLock = () => ({ version: LOCK_VERSION, updatedAt: "", configs: {}, artifacts: {}, mdBlocks: {} });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isMissingFileError = (error) => isRecord(error) && Object.hasOwn(error, "code") && error.code === "ENOENT";

const addAdapter = (adapters, agent, adapter) => {
    const entries = Array.isArray(adapters[agent]) ? adapters[agent] : [];
    const isMatch = (entry) => isRecord(entry) && entry.path === adapter.path && entry.type === adapter.type;
    return { ...adapters, [agent]: entries.some(isMatch)
        ? entries.map((entry) => isMatch(entry) ? { ...entry, ...adapter } : { ...entry })
        : [...entries.map((entry) => ({ ...entry })), { ...adapter }] };
};

/**
 * Read a lock file. Missing, malformed, and obsolete locks return an empty current lock; other I/O failures rethrow.
 * Effects: reads `template-lock.json` below projectRoot.
 * @param {string} projectRoot - Root containing the lock file.
 * @returns {{ version: string, updatedAt: string, configs: object, artifacts: object, mdBlocks: object }} Validated lock data.
 * @throws {Error} If reading an existing lock fails unexpectedly.
 */
export const readLockFile = (projectRoot) => {
    try {
        const parsed = JSON.parse(readFileSync(join(projectRoot, "template-lock.json"), "utf8"));
        if (!isRecord(parsed) || !Object.hasOwn(parsed, "version") || parsed.version !== LOCK_VERSION) return emptyLock();
        return { ...emptyLock(), ...parsed, configs: isRecord(parsed.configs) ? { ...parsed.configs } : {}, artifacts: isRecord(parsed.artifacts) ? { ...parsed.artifacts } : {}, mdBlocks: isRecord(parsed.mdBlocks) ? { ...parsed.mdBlocks } : {} };
    } catch (error) {
        if (error instanceof SyntaxError || isMissingFileError(error)) return emptyLock();
        throw error;
    }
};

/**
 * Persist lock data with a fresh timestamp.
 * Effects: overwrites `template-lock.json` below projectRoot; write failures rethrow.
 * @param {string} projectRoot - Root containing the lock file.
 * @param {object} lockData - Validated lock data to serialize.
 * @returns {void}
 * @throws {Error} If the lock cannot be written.
 */
export const writeLockFile = (projectRoot, lockData) => {
    writeFileSync(join(projectRoot, "template-lock.json"), `${JSON.stringify({ ...lockData, version: LOCK_VERSION, updatedAt: new Date().toISOString() }, null, 4)}\n`, "utf8");
};

/** @param {object} lock - Lock data. @param {string} path - Canonical artifact path. @returns {string|null} Recorded version, if valid. */
export const getArtifactVersion = (lock, path) => {
    const artifact = isRecord(lock.artifacts) && Object.hasOwn(lock.artifacts, path) ? lock.artifacts[path] : null;
    return isRecord(artifact) && typeof artifact.version === "string" ? artifact.version : null;
};

/**
 * Return lock data with an artifact recorded and adapters merged.
 * @param {object} lock - Existing lock data, never mutated.
 * @param {string} path - Canonical artifact path.
 * @param {{ kind: string, version?: string, adapters?: Record<string, object[]>, source?: string }} artifact - Artifact fields.
 * @returns {object} New lock data.
 */
export const recordArtifact = (lock, path, { kind, version, adapters = {}, source }) => {
    const existing = isRecord(lock.artifacts) && Object.hasOwn(lock.artifacts, path) && isRecord(lock.artifacts[path]) ? lock.artifacts[path] : { kind, adapters: {} };
    const mergedAdapters = Object.entries(isRecord(adapters) ? adapters : {}).reduce((current, [agent, entries]) => Array.isArray(entries) ? entries.reduce((next, adapter) => isRecord(adapter) && typeof adapter.path === "string" && typeof adapter.type === "string" ? addAdapter(next, agent, adapter) : next, current) : current, isRecord(existing.adapters) ? { ...existing.adapters } : {});
    return { ...lock, artifacts: { ...(isRecord(lock.artifacts) ? lock.artifacts : {}), [path]: { ...existing, kind, ...(version === undefined ? {} : { version }), ...(source === undefined ? {} : { source }), adapters: mergedAdapters } } };
};

/**
 * Return lock data whose adapters still exist beneath root.
 * Effects: reads adapter paths below root; missing adapter paths are removed and other failures rethrow.
 * @param {object} lock - Existing lock data, never mutated.
 * @param {string} root - Filesystem root containing adapters.
 * @param {string} path - Canonical artifact path.
 * @returns {{ lock: object, changed: boolean }} Updated lock and reconciliation result.
 * @throws {Error} If an existing adapter cannot be inspected.
 */
export const reconcileArtifactAdapters = (lock, root, path) => {
    const artifact = isRecord(lock.artifacts) && Object.hasOwn(lock.artifacts, path) && isRecord(lock.artifacts[path]) ? lock.artifacts[path] : null;
    if (!artifact) return { lock: { ...lock }, changed: false };
    const before = JSON.stringify(artifact.adapters ?? {});
    const adapters = Object.entries(isRecord(artifact.adapters) ? artifact.adapters : {}).reduce((current, [agent, entries]) => {
        const present = Array.isArray(entries) ? entries.filter((adapter) => {
            try {
                if (!isRecord(adapter) || typeof adapter.path !== "string" || typeof adapter.type !== "string") return false;
                const linkPath = join(root, adapter.path);
                const stats = lstatSync(linkPath);
                return adapter.type === "symlink" ? stats.isSymbolicLink() && typeof adapter.target === "string" && resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(root, adapter.target) : adapter.type === "file" && stats.isFile();
            } catch (error) {
                if (isMissingFileError(error)) return false;
                throw error;
            }
        }) : [];
        return present.length > 0 ? { ...current, [agent]: present } : current;
    }, {});
    const changed = before !== JSON.stringify(adapters);
    return { lock: { ...lock, artifacts: { ...(isRecord(lock.artifacts) ? lock.artifacts : {}), [path]: { ...artifact, adapters } } }, changed };
};

/** @param {string} skillName - Skill directory name. @returns {{ path: string, type: string, target: string }} Claude skill adapter. */
export const claudeSkillAdapter = (skillName) => ({ path: join(".claude", "skills", skillName), type: "symlink", target: join(".agents", "skills", skillName) });

/** @param {string} skillName - Skill directory name. @param {string} filename - Claude rule filename. @returns {{ path: string, type: string, target: string }} Claude rule adapter. */
export const claudeRuleAdapter = (skillName, filename) => ({ path: join(".claude", "rules", filename), type: "symlink", target: join(".agents", "skills", skillName, "SKILL.md") });
