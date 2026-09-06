#!/usr/bin/env python3
"""Mechanical checks for the documentation-sync skill.

Covers only what a machine can decide: frontmatter, link and anchor resolution, reachability
from the index, repository paths a page names, literal values, titles, page growth and length.
Altitude, verifiability and authorship stay with the agent — no pattern can tell whether a
sentence explains a third party's mechanics.

ERROR is objectively broken and sets a nonzero exit. WARN is an indicator needing a decision:
confirm the line is an input contract and keep it, or cut it. `--strict` makes warnings fatal
too.

Every project-specific convention lives in the optional config file, never in this script: a
project whose pages must carry frontmatter, or whose navigation is generated instead of linked
from an index, configures that rather than reading findings it can never act on.
"""

import argparse
import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

CONFIG_FILE = ".documentation-sync.json"
INDEX_CANDIDATES = ("docs/wiki/index.md", "docs/index.md", "docs/wiki/README.md", "docs/README.md",
                    "wiki/index.md", "documentation/index.md")
FRONTMATTER_MODES = ("forbidden", "allowed", "required")
DEFAULTS = {
    "index": None,
    "frontmatter": "forbidden",
    "reachability": True,
    "maxLines": 400,
    "hardMaxLines": 800,
    "ignore": [],
}

LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
INLINE_CODE = re.compile(r"`([^`\n]+)`")
INLINE_ASSIGNMENT = re.compile(r"`\s*([A-Za-z_][\w.\-]*)\s*=\s*([^`\n]+?)\s*`")
BLOCK_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][\w.\-]*)\s*=\s*(\S.*)$")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
EXPLICIT_ANCHOR = re.compile(r"<a\s+[^>]*(?:id|name)=[\"']([^\"']+)[\"']|\{#([\w.\-]+)\}")
PATH_CANDIDATE = re.compile(r"^[\w.@+-]+(?:/[\w.@+-]+)+/?$")
CONJUNCTION = re.compile(r"\band\b|&", re.IGNORECASE)
EXTERNAL = ("http://", "https://", "mailto:")


class Findings:
    """Collects findings and counts them by severity."""

    def __init__(self):
        self.errors = 0
        self.warnings = 0

    def error(self, where, message):
        self.errors += 1
        print(f"ERROR {where}: {message}")

    def warn(self, where, message):
        self.warnings += 1
        print(f"WARN  {where}: {message}")


def load_config(explicit):
    """Return the merged configuration, the defaults when the project declares none.

    A malformed or unknown key aborts the run: a silently ignored setting looks exactly like a
    check that passed.
    """
    path = Path(explicit) if explicit else Path(CONFIG_FILE)
    if not path.is_file():
        if explicit:
            raise SystemExit(f"ERROR: config file not found: {path}")
        return dict(DEFAULTS)
    try:
        declared = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(f"ERROR: {path} cannot be parsed: {error}")
    if not isinstance(declared, dict):
        raise SystemExit(f"ERROR: {path} must contain an object")

    unknown = sorted(set(declared) - set(DEFAULTS))
    if unknown:
        raise SystemExit(f"ERROR: {path} has unknown keys: {', '.join(unknown)}")

    config = dict(DEFAULTS)
    config.update(declared)
    if config["frontmatter"] not in FRONTMATTER_MODES:
        raise SystemExit(f"ERROR: frontmatter must be one of {', '.join(FRONTMATTER_MODES)}")
    if not isinstance(config["reachability"], bool):
        raise SystemExit("ERROR: reachability must be true or false")
    for key in ("maxLines", "hardMaxLines"):
        if not isinstance(config[key], int) or isinstance(config[key], bool) or config[key] < 1:
            raise SystemExit(f"ERROR: {key} must be a positive integer")
    if not isinstance(config["ignore"], list) or any(not isinstance(item, str) for item in config["ignore"]):
        raise SystemExit("ERROR: ignore must be an array of glob patterns")
    if config["index"] is not None and not isinstance(config["index"], str):
        raise SystemExit("ERROR: index must be a path")
    return config


def is_ignored(path, patterns):
    """Return whether a path matches a project ignore glob, directory prefixes included."""
    relative = path.as_posix()
    return any(fnmatch.fnmatch(relative, pattern) or relative.startswith(pattern.rstrip("*/") + "/")
               for pattern in patterns)


def resolve_index(configured):
    """Return the documentation index path, or None when it cannot be located."""
    if configured:
        path = Path(configured)
        return path if path.is_file() else None
    for candidate in INDEX_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return path
    return None


def slugify(heading):
    """Return the anchor a heading generates, following the common Markdown renderer rules."""
    text = re.sub(r"[`*_~]", "", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"\s+", "-", text.strip())


def anchors(text):
    """Return every fragment a page exposes: heading slugs, deduplicated, plus explicit ids."""
    found = set()
    counts = {}
    for line in text.splitlines():
        match = HEADING.match(line)
        if match:
            slug = slugify(match.group(2))
            if not slug:
                continue
            seen = counts.get(slug, 0)
            counts[slug] = seen + 1
            found.add(slug if seen == 0 else f"{slug}-{seen}")
    for explicit, braced in EXPLICIT_ANCHOR.findall(text):
        found.add(explicit or braced)
    return found


def links(text):
    """Yield (target, fragment) for repo-local links; external schemes are dropped."""
    for raw in LINK.findall(text):
        target = raw.split()[0].strip("<>")
        if not target or target.startswith(EXTERNAL):
            continue
        path, _, fragment = target.partition("#")
        yield path, fragment


def fenced_lines(lines):
    """Yield (number, text) for lines inside fenced code blocks."""
    fenced = False
    for number, line in enumerate(lines, start=1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            yield number, line


def prose_lines(lines):
    """Yield (number, text) for lines outside fenced code blocks."""
    fenced = False
    for number, line in enumerate(lines, start=1):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            yield number, line


def check_frontmatter(page, lines, mode, findings):
    present = bool(lines) and lines[0].strip() == "---"
    if mode == "forbidden" and present:
        findings.error(f"{page}:1", "page carries YAML frontmatter")
    if mode == "required" and not present:
        findings.error(f"{page}:1", "page is missing the required YAML frontmatter")


def check_links(page, text, findings):
    """Resolve every local link and, for Markdown targets, the fragment it points at."""
    for target, fragment in links(text):
        destination = (page.parent / target).resolve() if target else page.resolve()
        if target and not destination.exists():
            findings.error(str(page), f"link does not resolve: {target}")
            continue
        if not fragment or destination.suffix != ".md":
            continue
        try:
            available = anchors(destination.read_text(encoding="utf-8"))
        except OSError:
            continue
        if fragment not in available:
            findings.error(str(page), f"anchor does not resolve: {target}#{fragment}")


def check_paths(page, lines, patterns, findings):
    """Resolve the repository paths a page names in inline code.

    Only a candidate whose first segment is an existing directory is resolved, so an external
    reference that merely looks like a path — an image tag, an owner/name pair — is never
    mistaken for a stale one. A path below a directory that no longer exists at all is
    therefore out of reach here, and stays with the reader.
    """
    for number, line in prose_lines(lines):
        for span in INLINE_CODE.findall(line):
            candidate = span.strip()
            if not PATH_CANDIDATE.match(candidate) or "://" in candidate:
                continue
            resolved = Path(candidate.rstrip("/"))
            if is_ignored(resolved, patterns) or not Path(resolved.parts[0]).is_dir():
                continue
            if not resolved.exists():
                findings.error(f"{page}:{number}", f"path does not exist in the repository: {candidate}")


def is_input_contract(name):
    """Return whether an identifier reads as an env var, which readers set themselves.

    Shipped defaults are the noisy case worth flagging, and they are lower-case config keys by
    convention. Exempting SCREAMING_SNAKE_CASE keeps the warning rare enough to be read.
    """
    return name.isupper()


def check_literals(page, lines, findings):
    """Flag values a page reproduces, skipping identifiers that read as input contracts."""
    for number, line in prose_lines(lines):
        for name, value in INLINE_ASSIGNMENT.findall(line):
            if not is_input_contract(name):
                findings.warn(f"{page}:{number}", f"reproduces a value: `{name}={value}` — shipped default to cut, or a contract to keep?")
    for number, line in fenced_lines(lines):
        match = BLOCK_ASSIGNMENT.match(line)
        if match and not is_input_contract(match.group(1)):
            findings.warn(f"{page}:{number}", f"reproduces a value in a code block: {match.group(1)}={match.group(2)}")


def check_title(page, lines, findings):
    """Flag a title that joins two concepts, which is two pages wearing one filename."""
    for number, line in prose_lines(lines):
        match = HEADING.match(line)
        if match and len(match.group(1)) == 1:
            if CONJUNCTION.search(match.group(2)):
                findings.warn(f"{page}:{number}", f"title joins two concepts: {match.group(2)} — one concept per page")
            return


def check_length(page, lines, config, findings):
    if len(lines) > config["hardMaxLines"]:
        findings.error(str(page), f"{len(lines)} lines, past the {config['hardMaxLines']}-line hard stop — split the page")
    elif len(lines) > config["maxLines"]:
        findings.warn(str(page), f"{len(lines)} lines, over the {config['maxLines']}-line guideline")


def committed_line_count(page):
    """Return the page's line count at HEAD, or None when it is new or git is unavailable."""
    try:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
        relative = page.resolve().relative_to(Path(root))
        blob = subprocess.run(["git", "show", f"HEAD:{relative.as_posix()}"], capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError):
        return None
    return len(blob.stdout.splitlines())


def check_growth(page, lines, findings):
    before = committed_line_count(page)
    if before is not None and len(lines) > before:
        findings.warn(str(page), f"grew from {before} to {len(lines)} lines — state the reason, or generalize the existing wording instead")


def check_reachability(index, patterns, findings):
    """Walk the index's link graph and report pages it never reaches."""
    root = index.parent
    seen = {index.resolve()}
    queue = [index]
    while queue:
        page = queue.pop()
        try:
            text = page.read_text(encoding="utf-8")
        except OSError:
            continue
        for target, _ in links(text):
            if not target:
                continue
            linked = (page.parent / target).resolve()
            if linked.suffix == ".md" and linked.is_file() and linked not in seen:
                seen.add(linked)
                queue.append(linked)
    for page in sorted(root.rglob("*.md")):
        if page.resolve() not in seen and not is_ignored(page, patterns):
            findings.error(str(page), "not reachable from the index — an unlinked page does not exist")


def check_page(page, config, findings, docs_page=True):
    """Run every applicable check on one page.

    A page outside the documentation tree — the README — is held to the claims it makes about
    the repository, not to the shape rules that belong to a wiki.
    """
    try:
        text = page.read_text(encoding="utf-8")
    except OSError as error:
        findings.error(str(page), f"cannot be read: {error}")
        return
    lines = text.splitlines()
    check_links(page, text, findings)
    check_paths(page, lines, config["ignore"], findings)
    if not docs_page:
        return
    check_frontmatter(page, lines, config["frontmatter"], findings)
    check_literals(page, lines, findings)
    check_title(page, lines, findings)
    check_length(page, lines, config, findings)
    check_growth(page, lines, findings)


def main():
    parser = argparse.ArgumentParser(description="Mechanical documentation checks.")
    parser.add_argument("pages", nargs="*", help="pages to check; omit with --all")
    parser.add_argument("--all", action="store_true", help="check every page under the index, the README, and reachability")
    parser.add_argument("--index", help="documentation index (default: configured, else discovered)")
    parser.add_argument("--config", help=f"configuration file (default: {CONFIG_FILE} when present)")
    parser.add_argument("--strict", action="store_true", help="exit nonzero on warnings too")
    parser.add_argument("--max-lines", type=int, help="override the length guideline")
    args = parser.parse_args()

    config = load_config(args.config)
    if args.max_lines is not None:
        config["maxLines"] = args.max_lines
    findings = Findings()
    readme = Path("README.md")

    if args.all:
        index = resolve_index(args.index or config["index"])
        if index is None:
            print(f"ERROR: no documentation index found; set \"index\" in {CONFIG_FILE} or pass --index", file=sys.stderr)
            return 1
        pages = [page for page in sorted(index.parent.rglob("*.md")) if not is_ignored(page, config["ignore"])]
        if config["reachability"]:
            check_reachability(index, config["ignore"], findings)
    elif args.pages:
        pages = [Path(page) for page in args.pages]
    else:
        parser.error("give one or more pages, or --all")

    for page in pages:
        check_page(page, config, findings)
    if args.all and readme.is_file():
        check_page(readme, config, findings, docs_page=False)

    print(f"{findings.errors} error(s), {findings.warnings} warning(s).")
    return 1 if findings.errors or (args.strict and findings.warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
