import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @fileoverview The coding-agent packs as the installer sees them: one `<id>/agent.json` per
 * agent, read at run time so no installer code names an agent. An installer release carries the
 * packs in its own `packs/` directory (extracted by `install.sh`); a source checkout, or the
 * image's bootstrap copy, reads them from `setup/core/coding-agents/` beside the installer.
 * Only the fields the installer routes on are read; the setup side validates the rest.
 */

const releasePacksDir = fileURLToPath(new URL("../packs/", import.meta.url));
const sourcePacksDir = fileURLToPath(new URL("../../setup/core/coding-agents/", import.meta.url));

/**
 * @param {unknown} value - Candidate object.
 * @returns {value is Record<string, unknown>} Whether the value is a plain JSON object.
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Assert that a pack path is relative and stays below the root it is joined to.
 * @param {unknown} value - Candidate path.
 * @param {string} label - Name used in the validation error.
 * @returns {asserts value is string} Nothing.
 * @throws {TypeError} If the path is empty, absolute, or climbs with `..`.
 */
export const assertRelativePath = (value, label) => {
    if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.split("/").includes("..")) {
        throw new TypeError(`${label} must be a relative path below its root.`);
    }
};

/**
 * Read one `{ path, mode }` exposure of a pack. An absent exposure means `{ mode: "none" }`.
 * @param {Record<string, unknown>} raw - Parsed agent.json.
 * @param {string} key - Exposure field name.
 * @param {string[]} modes - Modes other than `none` the installer understands for the field.
 * @param {string} label - Pack label used in validation errors.
 * @returns {{ mode: string, path?: string }} The validated exposure.
 * @throws {TypeError} If the mode is unknown or a non-`none` mode has no safe path.
 */
const readExposure = (raw, key, modes, label) => {
    if (!Object.hasOwn(raw, key)) return { mode: "none" };
    const value = raw[key];
    if (!isRecord(value) || !Object.hasOwn(value, "mode") || (value.mode !== "none" && !modes.includes(value.mode))) {
        throw new TypeError(`${label}: ${key}.mode must be one of none, ${modes.join(", ")}.`);
    }
    if (value.mode === "none") return { mode: "none" };
    assertRelativePath(Object.hasOwn(value, "path") ? value.path : undefined, `${label}: ${key}.path`);
    return { mode: value.mode, path: value.path };
};

/**
 * Parse one agent.json text.
 * @param {string} text - File content.
 * @param {string} label - Pack label used in the error.
 * @returns {unknown} The parsed value.
 * @throws {Error} If the text is not valid JSON, with the parse error as its cause.
 */
const parsePackJson = (text, label) => {
    try {
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`, { cause: error });
        throw error;
    }
};

/**
 * Read and validate one pack.
 * @param {string} packsDir - Directory holding the pack folders.
 * @param {string} id - Pack folder name, the agent's id.
 * @returns {{ id: string, label: string, default: boolean, skillsCliAgent: string|null, skills: { mode: string, path?: string }, rules: { mode: string, path?: string }, projectInstructions: { mode: string, path?: string } }}
 * @throws {Error} If agent.json cannot be read or parsed, or a field the installer reads is invalid.
 * @effects Reads `<packsDir>/<id>/agent.json`.
 */
const readPack = (packsDir, id) => {
    const label = `${id}/agent.json`;
    const raw = parsePackJson(readFileSync(join(packsDir, id, "agent.json"), "utf8"), label);
    if (!isRecord(raw) || !Object.hasOwn(raw, "label") || typeof raw.label !== "string" || raw.label.length === 0) {
        throw new TypeError(`${label}: label must be a non-empty string.`);
    }
    const hasCliAgent = Object.hasOwn(raw, "skillsCliAgent");
    if (hasCliAgent && (typeof raw.skillsCliAgent !== "string" || raw.skillsCliAgent.length === 0)) {
        throw new TypeError(`${label}: skillsCliAgent must be a non-empty string.`);
    }
    return {
        id,
        label: raw.label,
        default: raw.default === true,
        skillsCliAgent: hasCliAgent ? raw.skillsCliAgent : null,
        skills: readExposure(raw, "skills", ["symlink"], label),
        rules: readExposure(raw, "rules", ["symlink"], label),
        projectInstructions: readExposure(raw, "projectInstructions", ["import"], label),
    };
};

/**
 * Load every coding-agent pack, in id order. Without an explicit directory, the release's own
 * `packs/` is used when present, else the source tree's `setup/core/coding-agents/`.
 * @param {string} [packsDir] - Directory holding one `<id>/agent.json` folder per agent.
 * @returns {ReturnType<typeof readPack>[]} The validated packs.
 * @throws {Error} If the directory cannot be read, holds no pack, or a pack is invalid.
 * @effects Reads the packs directory and each pack's agent.json.
 */
export const loadAgentPacks = (packsDir = existsSync(releasePacksDir) ? releasePacksDir : sourcePacksDir) => {
    const packs = readdirSync(packsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(packsDir, entry.name, "agent.json")))
        .map((entry) => entry.name)
        .sort()
        .map((id) => readPack(packsDir, id));
    if (packs.length === 0) throw new Error(`No coding-agent pack found in ${packsDir}.`);
    return packs;
};

/**
 * Keep the packs of the agents this container gets, as setup selects them: the ids `CODING_AGENTS`
 * lists, separated by any whitespace, or the packs marked `default` when it lists none. An id
 * without a pack is skipped here; setup is what rejects it.
 * @param {ReturnType<typeof readPack>[]} packs - Loaded packs.
 * @param {string|undefined} codingAgents - The `CODING_AGENTS` value, undefined when unset.
 * @returns {ReturnType<typeof readPack>[]} The selected packs, in their given order.
 */
export const selectAgentPacks = (packs, codingAgents) => {
    const listed = (codingAgents ?? "").split(/\s+/u).filter((id) => id.length > 0);
    return listed.length > 0 ? packs.filter((pack) => listed.includes(pack.id)) : packs.filter((pack) => pack.default);
};
