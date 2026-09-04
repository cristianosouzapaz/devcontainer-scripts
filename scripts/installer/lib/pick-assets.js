import {
    createPrompt,
    isDownKey,
    isEnterKey,
    isNumberKey,
    isSpaceKey,
    isUpKey,
    makeTheme,
    Separator,
    useKeypress,
    useMemo,
    usePagination,
    usePrefix,
    useState,
} from "@inquirer/core";
import chalk from "chalk";
import { PROMPT_THEME, sectionHeader } from "./theme.js";

/**
 * @fileoverview Stable multi-select prompt shared by the installer sub-installers, built on
 * `@inquirer/core` so a tag-filter bar can sit above the list. Left/right move a single
 * active tag chip (`All` plus one tag) and the list shows only the matching choices;
 * selections persist across filter changes. When no choice carries `tags` the bar is hidden
 * and the prompt behaves exactly like the official Inquirer checkbox. Free-text search is
 * still intentionally omitted.
 */

const CURSOR_HIDE = "\x1B[?25l";
const ALL_TAG = "All";
const SHORTCUTS = { all: "a", invert: "i" };

// Hand-copied from `@inquirer/checkbox`'s default theme so the rewrite renders identically.
const checkboxTheme = {
    icon: {
        checked: chalk.green("◉"),
        unchecked: "◯",
        cursor: "❯",
        disabledChecked: chalk.green("◉"),
        disabledUnchecked: "-",
    },
    style: {
        disabled: (text) => chalk.dim(text),
        renderSelectedChoices: (selected) => selected.map((choice) => choice.short).join(", "),
        description: (text) => chalk.cyan(text),
    },
    i18n: { disabledError: "This option is disabled and cannot be toggled." },
};

const isNavigable = (item) => !Separator.isSeparator(item);
const isSelectable = (item) => isNavigable(item) && !item.disabled;
const isChecked = (item) => isNavigable(item) && item.checked;

/**
 * Merge a choice's annotation into its label and normalise the "installed globally" marker,
 * preserving the wording the sub-installers already rely on.
 * @param {{name: string, annotation?: string}} choice
 * @returns {string}
 */
const formatName = (choice) => `${choice.name}${choice.annotation ? ` ${choice.annotation}` : ""}`;

/**
 * Order the caller's choices for display: alphabetically by name. Grouped pickers keep their
 * categories in the order the caller supplied them (a curated order the catalog owns) and
 * sort alphabetically only within each category. A stable, presentation-only sort — the
 * caller's array is left untouched.
 * @param {object[]} choices
 * @param {boolean} grouped
 * @returns {object[]}
 */
const orderChoices = (choices, grouped) => {
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    if (!grouped) return [...choices].sort(byName);
    const rank = new Map([...new Set(choices.map((choice) => choice.group))].map((group, index) => [group, index]));
    return [...choices].sort((a, b) => (rank.get(a.group) - rank.get(b.group)) || byName(a, b));
};

/**
 * Flatten the caller's choices into the internal item shape. `tags` defaults to an empty
 * array so a catalog that has not adopted tags yet simply yields no chip bar.
 * @param {object[]} choices
 * @returns {object[]}
 */
const normalizeChoices = (choices) => choices.map((choice) => {
    const name = formatName(choice);
    const item = {
        value: choice.value,
        name,
        short: name,
        disabled: choice.disabled === "installed globally" ? "(installed globally)" : (choice.disabled ?? false),
        checked: Boolean(choice.checked) && !choice.disabled,
        group: choice.group,
        tags: Array.isArray(choice.tags) ? choice.tags : [],
    };
    if (choice.description) item.description = choice.description;
    return item;
});

/**
 * Re-insert a category separator wherever the group changes. Run on the already-filtered
 * list so a narrowed tag view only shows the headers it still has entries under.
 * @param {object[]} items
 * @returns {object[]}
 */
const withGroupSeparators = (items) => items.flatMap((item, index) => [
    ...(item.group !== items[index - 1]?.group ? [new Separator(sectionHeader(item.group))] : []),
    item,
]);

/**
 * The list to display for the active tag: every item under `All`, otherwise only items
 * carrying the active tag. Category separators are reapplied only when the picker is grouped
 * and the visible items span more than one category — a lone header would just echo the
 * active tag chip (or, under `All`, add nothing to a single-category catalog).
 * @param {{items: object[], grouped: boolean, tagList: string[], tagPos: number}} state
 * @returns {object[]}
 */
const buildView = ({ items, grouped, tagList, tagPos }) => {
    const activeTag = tagList[tagPos];
    const filtered = tagPos === 0 ? items : items.filter((item) => item.tags.includes(activeTag));
    const spansCategories = new Set(filtered.map((item) => item.group)).size > 1;
    return grouped && spansCategories ? withGroupSeparators(filtered) : filtered;
};

const firstNavigableIndex = (view) => {
    const index = view.findIndex(isNavigable);
    return index === -1 ? 0 : index;
};

/**
 * Render the tag bar on one line: active chip in reverse video, the rest dimmed except `All`,
 * kept full-strength as the "clear the filter" affordance. The match count trails an active
 * tag only — under `All` it would just be the catalog size.
 * @param {string[]} tagList
 * @param {number} tagPos
 * @param {number} matchCount - Selectable entries visible under the active tag.
 * @returns {string}
 */
const renderTagBar = (tagList, tagPos, matchCount) => {
    const chip = (tag, index) => {
        if (index === tagPos) return chalk.inverse.bold(` ${tag} `);
        return tag === ALL_TAG ? tag : chalk.dim(tag);
    };
    const chips = tagList.map(chip).join("  ");
    return tagPos === 0 ? chips : `${chips}   ${chalk.dim(`· ${matchCount}`)}`;
};

/**
 * Multi-select prompt with a tag-filter chip bar. Behaves as a plain checkbox when no
 * choice carries tags.
 */
const tagCheckbox = createPrompt((config, done) => {
    const { pageSize = 14, loop = true, grouped = false } = config;
    const theme = makeTheme(checkboxTheme, config.theme);
    const { keybindings } = theme;

    const [status, setStatus] = useState("idle");
    const prefix = usePrefix({ status, theme });
    const [items, setItems] = useState(() => normalizeChoices(orderChoices(config.choices, grouped)));

    const tagList = useMemo(() => {
        const tags = new Set();
        for (const item of items) for (const tag of item.tags) tags.add(tag);
        return [ALL_TAG, ...[...tags].sort()];
    }, [items.length]);
    const hasTagBar = tagList.length > 1;

    const [tagPos, setTagPos] = useState(0);
    const view = useMemo(() => buildView({ items, grouped, tagList, tagPos }), [items, grouped, tagList, tagPos]);
    const bounds = useMemo(() => {
        const first = view.findIndex(isNavigable);
        const last = view.findLastIndex(isNavigable);
        return { first: first === -1 ? 0 : first, last: last === -1 ? 0 : last };
    }, [view]);

    const [active, setActive] = useState(bounds.first);
    const [errorMsg, setError] = useState();

    useKeypress((key) => {
        if (isEnterKey(key)) {
            setStatus("done");
            done(items.filter(isChecked).map((choice) => choice.value));
        } else if (hasTagBar && (key.name === "left" || key.name === "right")) {
            if (errorMsg) setError(undefined);
            const nextPos = (tagPos + (key.name === "right" ? 1 : -1) + tagList.length) % tagList.length;
            setTagPos(nextPos);
            setActive(firstNavigableIndex(buildView({ items, grouped, tagList, tagPos: nextPos })));
        } else if (isUpKey(key, keybindings) || isDownKey(key, keybindings)) {
            if (errorMsg) setError(undefined);
            const offset = isUpKey(key, keybindings) ? -1 : 1;
            if (!loop && ((offset === -1 && active === bounds.first) || (offset === 1 && active === bounds.last))) return;
            const nextNavigable = (from) => {
                const candidate = (from + offset + view.length) % view.length;
                return isNavigable(view[candidate]) ? candidate : nextNavigable(candidate);
            };
            if (view.length > 0) setActive(nextNavigable(active));
        } else if (isSpaceKey(key)) {
            const target = view[active];
            if (!target || Separator.isSeparator(target)) return;
            if (target.disabled) {
                setError(theme.i18n.disabledError);
                return;
            }
            setError(undefined);
            setItems(items.map((item) => (item === target ? { ...item, checked: !item.checked } : item)));
        } else if (key.name === SHORTCUTS.all) {
            const inView = new Set(view.filter(isSelectable));
            const turnOn = [...inView].some((item) => !item.checked);
            setItems(items.map((item) => (inView.has(item) ? { ...item, checked: turnOn } : item)));
        } else if (key.name === SHORTCUTS.invert) {
            const inView = new Set(view.filter(isSelectable));
            setItems(items.map((item) => (inView.has(item) ? { ...item, checked: !item.checked } : item)));
        } else if (isNumberKey(key)) {
            const target = view.filter(isNavigable)[Number(key.name) - 1];
            if (target && isSelectable(target)) {
                setActive(view.indexOf(target));
                setItems(items.map((item) => (item === target ? { ...item, checked: !item.checked } : item)));
            }
        }
    });

    const message = theme.style.message(config.message, status);
    const activeItem = view[active];
    const description = activeItem && isNavigable(activeItem) ? activeItem.description : undefined;

    const page = usePagination({
        items: view,
        active,
        renderItem({ item, isActive }) {
            if (Separator.isSeparator(item)) return ` ${item.separator}`;
            const cursor = isActive ? theme.icon.cursor : " ";
            if (item.disabled) {
                const label = typeof item.disabled === "string" ? item.disabled : "(disabled)";
                const box = item.checked ? theme.icon.disabledChecked : theme.icon.disabledUnchecked;
                return theme.style.disabled(`${cursor}${box} ${item.name} ${label}`);
            }
            const box = item.checked ? theme.icon.checked : theme.icon.unchecked;
            const line = `${cursor}${box} ${item.name}`;
            return isActive ? theme.style.highlight(line) : line;
        },
        pageSize,
        loop,
    });

    if (status === "done") {
        const answer = theme.style.answer(theme.style.renderSelectedChoices(items.filter(isChecked), items));
        return [prefix, message, answer].filter(Boolean).join(" ");
    }

    const keys = [
        ...(hasTagBar ? [["‹ ›", "filter by tag"]] : []),
        ["↑↓", "navigate"],
        ["space", "select"],
        [SHORTCUTS.all, "all"],
        [SHORTCUTS.invert, "invert"],
        ["⏎", "submit"],
    ];

    const lines = [
        [prefix, message].filter(Boolean).join(" "),
        // Blank line above and below the chip bar, matching the footer gap below the list.
        ...(hasTagBar ? [" ", ` ${renderTagBar(tagList, tagPos, view.filter(isSelectable).length)}`, " "] : []),
        page,
        " ",
        description ? theme.style.description(description) : "",
        errorMsg ? theme.style.error(errorMsg) : "",
        theme.style.keysHelpTip(keys),
    ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();

    return `${lines}${CURSOR_HIDE}`;
});

/**
 * Select one or more installer assets. A tag-filter bar appears when the choices carry
 * `tags`; otherwise this is a plain multi-select.
 * @param {object} config
 * @param {string} config.message - Prompt heading.
 * @param {{name: string, value: unknown, annotation?: string, group?: string, tags?: string[], description?: string, disabled?: string, checked?: boolean}[]} config.choices
 * @param {boolean} [config.grouped] - Add category separators for grouped choices.
 * @param {number} [config.pageSize]
 * @param {object} [context] - Optional Inquirer runtime context, used by tests.
 * @returns {Promise<unknown[]>} The selected values.
 * @throws {Error} If the prompt cannot be rendered or is cancelled.
 * @effects Presents an interactive multi-select prompt on the current terminal.
 */
export const pickAssets = (config, context) => tagCheckbox(
    { ...config, theme: { ...PROMPT_THEME, ...config.theme } },
    { clearPromptOnDone: true, ...context },
);
