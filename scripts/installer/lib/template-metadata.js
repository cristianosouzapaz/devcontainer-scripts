import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @fileoverview The kit's own data on a template, read from the template's YAML frontmatter
 * instead of a hand-written catalog. It lives under the Agent Skills `metadata` map, as
 * `kit-*` keys (see `docs/wiki/installer/overview.md`), and is stripped before any template
 * reaches a project. The parser covers only the subset the templates use: top-level
 * `key: value` lines and one level of indented `key: value` lines under `metadata:`.
 */

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const topLevelPattern = /^([\w-]+):\s*(.*)$/;
const nestedPattern = /^\s+([\w-]+):\s*(.*)$/;
const kitKeyPattern = /^\s+kit-[\w-]+:/;
const versionPattern = /^\d+\.\d+\.\d+$/;

/**
 * Strip one layer of matching single or double quotes from a frontmatter value.
 * @param {string} value - Raw frontmatter value.
 * @returns {string} The unquoted value.
 */
export const unquote = (value) => {
    const quoted = value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0];
    return quoted ? value.slice(1, -1) : value;
};

/**
 * Split a space-separated metadata value into its words.
 * @param {string|undefined} value - Metadata value, or undefined when absent.
 * @returns {string[]} The words, empty when the value is absent or blank.
 */
const words = (value) => (value ?? "").split(/\s+/).filter((word) => word.length > 0);

/**
 * Parse the frontmatter of a markdown template.
 * @param {string} content - Template content.
 * @returns {{ raw: Record<string, string>, metadata: Record<string, string>, body: string }}
 *   Top-level values as written (quotes kept, `metadata` excluded), the unquoted `metadata`
 *   map, and the content after the frontmatter (all of it when there is none).
 * @throws {TypeError} If content is not a string.
 */
export const parseFrontmatter = (content) => {
    if (typeof content !== "string") throw new TypeError("Template content must be a string.");
    const raw = Object.create(null);
    const metadata = Object.create(null);
    const match = frontmatterPattern.exec(content);
    if (!match) return { raw, metadata, body: content };

    const state = { inMetadata: false };
    for (const line of match[1].split(/\r?\n/)) {
        const top = topLevelPattern.exec(line);
        if (top) {
            state.inMetadata = top[1] === "metadata" && top[2].trim().length === 0;
            if (!state.inMetadata) raw[top[1]] = top[2].trim();
            continue;
        }
        const nested = nestedPattern.exec(line);
        if (state.inMetadata && nested) metadata[nested[1]] = unquote(nested[2].trim());
    }
    return { raw, metadata, body: match[2] };
};

/**
 * Remove the kit's `kit-*` keys from a template's `metadata` map, and the `metadata` key
 * itself when nothing else is left under it. Every other line is kept as written, so a
 * template without kit keys comes back unchanged.
 * @param {string} content - Template content.
 * @returns {string} The content an installed file receives.
 * @throws {TypeError} If content is not a string.
 */
export const stripKitMetadata = (content) => {
    if (typeof content !== "string") throw new TypeError("Template content must be a string.");
    const match = frontmatterPattern.exec(content);
    if (!match) return content;

    const lines = match[1].split(/\r?\n/);
    const kept = [];
    const state = { inMetadata: false, metadataIndex: -1, others: 0 };
    for (const line of lines) {
        if (topLevelPattern.test(line)) {
            state.inMetadata = /^metadata:\s*$/.test(line);
            if (state.inMetadata) state.metadataIndex = kept.length;
        } else if (state.inMetadata && kitKeyPattern.test(line)) {
            continue;
        } else if (state.inMetadata && nestedPattern.test(line)) {
            state.others += 1;
        }
        kept.push(line);
    }
    if (state.metadataIndex >= 0 && state.others === 0) kept.splice(state.metadataIndex, 1);
    if (kept.length === lines.length) return content;
    const eol = content.startsWith("---\r\n") ? "\r\n" : "\n";
    return `---${eol}${kept.join(eol)}${eol}---${eol}${match[2]}`;
};

/**
 * Read and validate the metadata a template declares for the installer.
 * @param {string} content - Template content.
 * @param {string} label - Template path used in validation errors.
 * @returns {{ name: string, description: string, version: string, tags: string[], skills: string[], global: boolean, body: string }}
 *   The unquoted `name` and `description`, `kit-version`, the space-separated `kit-tags`
 *   and `kit-skills`, whether `kit-global` is `"true"`, and the content after the frontmatter.
 * @throws {Error} If `name` or `description` is empty, `kit-version` is not a semantic
 *   version, or `kit-global` is neither `"true"` nor `"false"`.
 */
export const readKitMetadata = (content, label) => {
    const { raw, metadata, body } = parseFrontmatter(content);
    const field = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined);
    const name = unquote(field(raw, "name") ?? "");
    const description = unquote(field(raw, "description") ?? "");
    const version = field(metadata, "kit-version");
    const global = field(metadata, "kit-global");

    if (name.length === 0 || description.length === 0) throw new Error(`${label}: frontmatter needs a name and a description.`);
    if (version === undefined || !versionPattern.test(version)) throw new Error(`${label}: metadata.kit-version must be a version such as 1.0.0.`);
    if (global !== undefined && global !== "true" && global !== "false") throw new Error(`${label}: metadata.kit-global must be "true" or "false".`);

    return {
        name,
        description,
        version,
        tags: words(field(metadata, "kit-tags")),
        skills: words(field(metadata, "kit-skills")),
        global: global === "true",
        body,
    };
};

/**
 * Discover the templates of one kind by scanning their folder, in file-name order.
 * @param {string} dir - Absolute template directory.
 * @param {string} suffix - File-name suffix that marks a template of this kind.
 * @returns {({ file: string } & ReturnType<typeof readKitMetadata>)[]} One entry per
 *   matching file, with its metadata.
 * @throws {Error} If the directory or a template cannot be read, or a template's metadata is invalid.
 * @effects Reads the directory listing and every matching file below dir.
 */
export const scanTemplates = (dir, suffix) => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ file, ...readKitMetadata(readFileSync(join(dir, file), "utf8"), file) }));
