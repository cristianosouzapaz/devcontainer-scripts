import { readFileSync } from "node:fs";
import { isAbsolute, normalize, sep } from "node:path";

/**
 * @fileoverview Loading and schema-validation for the installers' JSON catalog files.
 */

/**
 * Read and parse a JSON catalog file, validating that it is an array.
 * @param {URL|string} fileUrl - URL or path of the JSON file to load.
 * @returns {object[]} Parsed array of catalog entries.
 * @throws If the file cannot be read or the root value is not an array.
 */
export const loadJsonCatalog = (fileUrl) => {
    const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Invalid catalog: expected an array in ${fileUrl}.`);
    return parsed;
};

/**
 * Read and parse a JSON object file.
 * @param {URL|string} fileUrl - URL or path of the JSON file to load.
 * @returns {Record<string, unknown>} Parsed object.
 * @throws {Error} If the file cannot be read, parsed, or is not an object.
 */
export const loadJsonObject = (fileUrl) => {
    const parsed = JSON.parse(readFileSync(fileUrl, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid JSON object in ${fileUrl}.`);
    return parsed;
};

/**
 * Whether a catalog path remains beneath its designated template directory.
 * @param {unknown} value - Untrusted catalog field value.
 * @returns {boolean} True for a non-empty, relative path without traversal components.
 */
const isSafeRelativePath = (value) => typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && normalize(value).split(sep).every((part) => part !== "..");

/**
 * Load a JSON catalog and validate every entry against a field schema.
 * @param {URL|string} fileUrl - URL or path of the JSON catalog to load.
 * @param {string} catalogName - Name used in the "Invalid <name> catalog entry" error.
 * @param {{
 *   strings?: string[],
 *   nonEmptyStrings?: string[],
 *   stringArrays?: string[],
 *   optionalStringArrays?: string[],
 *   safeRelativePaths?: string[],
 *   optionalSafeRelativePathArrays?: string[],
 * }} [schema] - Required string fields, non-empty string fields, string-array fields, and
 *   string-array fields that may also be absent, including optional arrays of safe relative
 *   template paths.
 * @returns {object[]} The validated entries.
 * @throws If the file is not an array or any entry violates the schema.
 */
export const loadValidatedCatalog = (fileUrl, catalogName, schema = {}) => {
    const { strings = [], nonEmptyStrings = [], stringArrays = [], optionalStringArrays = [], safeRelativePaths = [], optionalSafeRelativePathArrays = [] } = schema;
    const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
    const entries = loadJsonCatalog(fileUrl);

    entries.forEach((entry, index) => {
        const valid = entry !== null && typeof entry === "object" && !Array.isArray(entry)
            && strings.every((key) => Object.hasOwn(entry, key) && typeof entry[key] === "string")
            && nonEmptyStrings.every((key) => Object.hasOwn(entry, key) && typeof entry[key] === "string" && entry[key].length > 0)
            && stringArrays.every((key) => Object.hasOwn(entry, key) && isStringArray(entry[key]))
            && optionalStringArrays.every((key) => !Object.hasOwn(entry, key) || isStringArray(entry[key]))
            && safeRelativePaths.every((key) => Object.hasOwn(entry, key) && isSafeRelativePath(entry[key]))
            && optionalSafeRelativePathArrays.every((key) => !Object.hasOwn(entry, key)
                || (isStringArray(entry[key]) && entry[key].every(isSafeRelativePath)));
        if (!valid) throw new Error(`Invalid ${catalogName} catalog entry at index ${index}.`);
    });

    return entries;
};
