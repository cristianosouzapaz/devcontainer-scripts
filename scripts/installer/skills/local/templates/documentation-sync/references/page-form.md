# The form of a page

Load this when adding a page or an index entry, or when deciding whether new material is a
page at all. The [principles](principles.md) decide what may be written; this decides where it
goes and what shape it takes.

## New page, or an edit to an existing one?

Extend an existing page when the material is another aspect of a responsibility that page
already owns. Add a page only when the material is a responsibility no page owns yet, and when
its content passes the admission test: facts verifiable against the code, a why that names the
constraint or the alternative behind it.

A second page on a responsibility another page already owns breaks Single source before it is
written. If two pages would each need half the story, the split is wrong: it is one page.

Intent, guidelines and aspirational material are not pages. They go in a top-level document
linked from the index, never inlined into a page, because they cannot be checked against code.

## When a page must be deleted

When the responsibility a page owns no longer exists, the page is deleted in the same change,
and the index entry with it. **Generalizing a page to keep it alive is a symptom, not a fix**:
the wording gets vaguer until the page says nothing, passes every check, and still occupies
the slot a reader looks in.

The same applies to a page whose responsibility moved: it does not become a pointer to its
successor. The index is the redirect.

## What the README owns

The README says how the project is used — install, run, configure. The wiki says how it is
shaped and why. That is the whole boundary, and it is why the README answers to consistency
and verifiability but not to the page rules: it holds instructions, not responsibilities.

## What a page contains

In order:

1. **A title naming one concept.** No conjunction — a title that needs "and" is two pages.
2. **One paragraph of responsibility.** Which part of the repo this covers, and what it is
   answerable for. A reader who stops here knows whether to keep reading.
3. **The why.** Why the responsibility sits there and in that form: the decision, the
   constraint it answers, the alternative that was rejected. This is the part the code cannot
   state, and the reason the page exists.
4. **Pointers.** The directory, the entry file, the neighbouring page. Name locations, never
   their contents.

What a page does not contain: values the code holds, inventories, internal symbol names,
upstream behavior, or a summary of a page it links to.

## What the index contains

The index is the map, and the only file every reader opens. One line per page: the link, then
what the page covers and — where it is not obvious — why it exists. Never a summary of the
page's content; a summary is a second source of truth that ages while nobody reads it.

The index may state its own charter. Where it does, that statement wins over this skill for
that project.

Adding, renaming or removing a page updates the index in the same change. An unlinked page
does not exist: nobody navigates a documentation tree by listing directories.
