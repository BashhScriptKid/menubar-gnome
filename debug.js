/* Debug logging.
 *
 * `console.debug` is filtered out of the default journal view, so everything
 * goes through `print()`.  Every line is prefixed with the time since the
 * module was loaded and the section it comes from:
 *
 *     menubar[   12.345] dbusmenu: ...
 *
 * So a single grep shows the whole life of an update:
 *
 *     journalctl --user -b -p debug | grep 'menubar\['
 *
 * Set DEBUG to false to silence all of it.
 */

import GLib from 'gi://GLib';

export const DEBUG = true;

const START = GLib.get_monotonic_time();

function stamp() {
    const seconds = (GLib.get_monotonic_time() - START) / 1e6;
    return seconds.toFixed(3).padStart(9, ' ');
}

function fmt(value) {
    if (typeof value === 'string')
        return value;
    if (value === null || value === undefined)
        return String(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function clip(text, length = 70) {
    const value = String(text ?? '');
    return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function log(section, ...parts) {
    if (!DEBUG)
        return;
    print(`menubar[${stamp()}] ${section}: ${parts.map(fmt).join(' ')}`);
}

/* a one-line summary of a node, for the tree dump */
function describe(node) {
    const marks = [];
    if (node.type === 'separator')
        marks.push('sep');
    if (node.type === 'submenu')
        marks.push('submenu');
    if (node.enabled === false)
        marks.push('DISABLED');
    if (node.visible === false)
        marks.push('INVISIBLE');
    if (node.toggle !== null && node.toggle !== undefined)
        marks.push(`check=${node.toggle}`);
    if (node.shortcut)
        marks.push(`key=${node.shortcut}`);
    if (node.unbuilt)
        marks.push('UNBUILT');
    if (node.activate)
        marks.push('clickable');
    if (node.fetch ?? node.loadChildren ?? node.refresh)
        marks.push('fetchable');
    const kids = node.children?.length ? ` (${node.children.length} kids)` : '';
    const suffix = marks.length ? ` [${marks.join(' ')}]` : '';
    return `"${clip(node.label ?? '', 60)}"${suffix}${kids}`;
}

export function dumpTree(section, nodes, title = 'tree') {
    if (!DEBUG)
        return;
    log(section, `${title}: ${nodes?.length ?? 0} top-level nodes`);
    const walk = (list, depth) => {
        for (const node of list ?? []) {
            log(section, `${'  '.repeat(depth)}${describe(node)}`);
            walk(node.children, depth + 1);
        }
    };
    walk(nodes, 1);
}
