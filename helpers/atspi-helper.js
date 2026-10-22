/* AT-SPI menubar reader, run as a separate process.
 *
 * Why a process of its own: libatspi's calls are synchronous and cannot be
 * given a timeout.  Walking the accessibility tree of an application that
 * does not answer -- a browser that has just started, a toolkit whose bridge
 * is not up yet -- blocks the caller until the D-Bus default timeout, which
 * was 16 seconds of a frozen desktop when this ran inside the shell.  Here
 * the shell can kill the whole process when it takes too long, and nothing
 * of it can block the compositor.
 *
 * Usage:
 *   gjs -m atspi-helper.js titles   <pid> <window title> ["<path json>"]
 *   gjs -m atspi-helper.js menus    <pid> <window title> ["<path json>"]
 *   gjs -m atspi-helper.js activate <pid> <window title>  <path json>
 *
 * One JSON object is printed on stdout:
 *   {"ok":true,"titles":["File",...]}
 *   {"ok":true,"menus":[{...}]}
 *   {"ok":true,"activated":true}
 *   {"ok":false,"reason":"no-app"|"no-menubar"|"titles-only"|...}
 *
 * Nothing else is written to stdout; the trace of every step goes to stderr,
 * and the shell relays it into its own log.
 */

import Atspi from 'gi://Atspi';
import GLib from 'gi://GLib';
import System from 'system';

const MAX_DEPTH = 2;        // how deep we descend into submenus
const SEARCH_DEPTH = 12;    // how deep we look for the MENU_BAR itself
const MAX_NODES = 250;
const MAX_SEARCH_NODES = 400;

const kind = ARGV[0];
const pid = parseInt(ARGV[1], 10);
const title = ARGV[2] ?? '';
const wantedPath = ARGV[3] ? JSON.parse(ARGV[3]) : null;

/*
 * The process that started this one is the shell.  The shell is on the
 * accessibility bus as well, and it is the slowest of the applications to
 * answer -- it is busy with the update that started this helper.  Its own
 * menus are never wanted, so it is skipped in the search.
 */
const shellPid = parentPid();

const started = GLib.get_monotonic_time();

function ms() {
    return ((GLib.get_monotonic_time() - started) / 1000).toFixed(0);
}

/* the trace of the run, on stderr: stdout is for the answer */
function trace(...parts) {
    printerr(`[${ms()}ms] ${parts.join(' ')}`);
}

/*
 * The pid of the process that started this one: the shell.  It is on the
 * accessibility bus as well, and it is the slowest one to answer.
 */
function parentPid() {
    try {
        const [, contents] = GLib.file_get_contents('/proc/self/stat');
        const text = new TextDecoder().decode(contents);
        // after the command name comes the state and then the parent pid
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
        return parseInt(fields[1], 10);
    } catch (e) {
        return -1;
    }
}

/* the answer is printed exactly once */
let answered = false;

function answer(object) {
    if (answered)
        return;
    answered = true;
    trace('answer', JSON.stringify(object).slice(0, 400));
    print(JSON.stringify(object));
    System.exit(0);
}

function fail(reason, extra = {}) {
    trace('FAIL', reason, JSON.stringify(extra));
    answer({ok: false, reason, ...extra});
}

function childCount(accessible) {
    try {
        return accessible.get_child_count();
    } catch (e) {
        trace('childCount failed:', e.message);
        return 0;
    }
}

function childAt(accessible, index) {
    try {
        return accessible.get_child_at_index(index);
    } catch (e) {
        trace(`childAt(${index}) failed:`, e.message);
        return null;
    }
}

function roleOf(accessible) {
    try {
        return accessible.get_role();
    } catch (e) {
        trace('role failed:', e.message);
        return -1;
    }
}

/* the name of a role, for the log */
const ROLE_NAMES = new Map();
for (const [name, value] of Object.entries(Atspi.Role))
    ROLE_NAMES.set(value, name);

function roleName(role) {
    return ROLE_NAMES.get(role) ?? `role-${role}`;
}

function nameOf(accessible) {
    try {
        return accessible.get_name() ?? '';
    } catch (e) {
        trace('name failed:', e.message);
        return '';
    }
}

/* is the accessible on the screen? */
function isShowing(accessible) {
    try {
        return accessible.get_state_set().contains(Atspi.StateType.SHOWING);
    } catch (e) {
        return false;
    }
}

/* the application object of a process */
function findApp(wantedPid) {
    const desktop = Atspi.get_desktop(0);
    trace('desktop: got the root object');

    const count = childCount(desktop);
    trace('desktop:', count, 'applications on the accessibility bus');

    /*
     * The applications are asked for from the last one to the first one,
     * because the shell registers itself at the start of the session and is
     * therefore the first one on the bus.  Asking the shell is the slowest
     * thing there is (it is busy with the very update that started this
     * helper), so the wanted application is normally found before the shell
     * is asked at all.
     */
    const found = [];
    for (let i = count - 1; i >= 0; i--) {
        const candidate = childAt(desktop, i);
        if (!candidate) {
            trace(`desktop: [${i}] is not reachable`);
            continue;
        }

        let candidatePid = -1;
        try {
            candidatePid = candidate.get_process_id();
        } catch (e) {
            trace(`desktop: [${i}] has no pid:`, e.message);
            continue;
        }

        const name = nameOf(candidate);
        if (candidatePid === wantedPid) {
            trace(`desktop: [${i}] "${name}" has pid ${candidatePid} -> this is the one`);
            return candidate;
        }
        if (candidatePid === parentPid()) {
            trace(`desktop: [${i}] "${name}" is the shell itself, skipped`);
            continue;
        }

        trace(`desktop: [${i}] "${name}" has pid ${candidatePid}`);
        found.push({node: candidate, pid: candidatePid, name});
    }

    /*
     * An application does not always publish its tree from the process that
     * runs the window: a browser publishes it from the process of its
     * browser integration host, which is a child of the browser.  So the
     * process tree of the wanted pid is looked at as well.
     */
    const related = relatedPids(wantedPid);
    trace(`desktop: ${related.size} processes belong to pid ${wantedPid}`);
    for (const app of found) {
        if (related.has(app.pid)) {
            trace(`desktop: "${app.name}" has pid ${app.pid} ` +
                '-> a process of the application');
            return app.node;
        }
    }

    trace(`desktop: no application with pid ${wantedPid}`);
    return null;
}

/*
 * The pids of the processes that belong to a process: the process itself,
 * the processes it started, and the processes it was started from.
 */
function relatedPids(pid) {
    const parents = new Map();

    try {
        const dir = GLib.Dir.open('/proc', 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            const child = parseInt(name, 10);
            if (!Number.isFinite(child))
                continue;
            const parent = parentOf(child);
            if (parent > 0)
                parents.set(child, parent);
        }
        dir.close();
    } catch (e) {
        trace('relatedPids: cannot look at /proc:', e.message);
        return new Set([pid]);
    }

    const related = new Set([pid]);

    // the processes it was started from
    let parent = parents.get(pid);
    while (parent > 1 && !related.has(parent)) {
        related.add(parent);
        parent = parents.get(parent);
    }

    // the processes it started, and theirs
    let grew = true;
    while (grew) {
        grew = false;
        for (const [child, parentPid] of parents) {
            if (related.has(parentPid) && !related.has(child)) {
                related.add(child);
                grew = true;
            }
        }
    }

    return related;
}

/* the process a process was started from */
function parentOf(pid) {
    try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!ok)
            return -1;
        const text = new TextDecoder().decode(contents);
        // after the command name (which is in parentheses, and may itself
        // contain spaces and parentheses) come the state and the parent
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
        return parseInt(fields[1], 10);
    } catch (e) {
        return -1;
    }
}

/* the frame (top level window) whose title matches the window we want */
function findFrame(app, wantedTitle) {
    const count = childCount(app);
    trace('frame: the application has', count, 'children');

    /*
     * Without a title the first window is taken: a probe that looks at the
     * decorations of an application does not always know the title, and an
     * application normally has one window.
     */
    const takeFirst = !wantedTitle;
    if (takeFirst)
        trace('frame: no title given, taking the first window');

    let fallback = null;
    for (let i = 0; i < count; i++) {
        const child = childAt(app, i);
        if (!child)
            continue;

        const role = roleOf(child);
        if (role !== Atspi.Role.FRAME && role !== Atspi.Role.WINDOW) {
            trace(`frame: [${i}] has role ${role}, not a window`);
            continue;
        }

        const name = nameOf(child);
        if (!name) {
            trace(`frame: [${i}] has no name`);
            continue;
        }

        if (takeFirst) {
            trace(`frame: [${i}] "${name}" is the first window`);
            return child;
        }

        const wanted = wantedTitle.toLowerCase();
        const found = name.toLowerCase();
        if (found === wanted) {
            trace(`frame: [${i}] "${name}" is the window we want`);
            return child;
        }
        if (!fallback && (wanted.includes(found) || found.includes(wanted))) {
            trace(`frame: [${i}] "${name}" is close enough, kept as the fallback`);
            fallback = child;
        } else {
            trace(`frame: [${i}] "${name}" does not match "${wantedTitle}"`);
        }
    }

    if (fallback)
        trace('frame: using the fallback');
    else
        trace(`frame: no window matches "${wantedTitle}"`);
    return fallback;
}

function findRole(accessible, role, depth = 0, budget = {left: MAX_SEARCH_NODES}) {
    if (!accessible) {
        trace(`findRole: nothing at depth ${depth}`);
        return null;
    }
    if (budget.left <= 0) {
        trace(`findRole: the node budget is used up at depth ${depth}`);
        return null;
    }
    budget.left--;

    const own = roleOf(accessible);
    if (own === role) {
        trace(`findRole: found role ${role} at depth ${depth} ` +
            `(${MAX_SEARCH_NODES - budget.left} nodes visited)`);
        return accessible;
    }
    if (depth >= SEARCH_DEPTH) {
        trace(`findRole: the search depth is reached at depth ${depth}`);
        return null;
    }

    const count = childCount(accessible);
    for (let i = 0; i < count; i++) {
        const found = findRole(childAt(accessible, i), role, depth + 1, budget);
        if (found)
            return found;
    }
    return null;
}

/*
 * An application can have several windows, each with its own menubar.  The
 * menubar of the window in front wins; only when that cannot be found is the
 * first menubar of the application used.
 */
function findMenuBar(app, wantedTitle) {
    const frame = findFrame(app, wantedTitle);
    if (frame) {
        trace('menubar: looking in the frame of the window in front');
        const bar = findRole(frame, Atspi.Role.MENU_BAR, 0, {left: MAX_SEARCH_NODES});
        if (bar) {
            trace('menubar: the frame has one');
            return bar;
        }
        trace('menubar: the frame has none, looking at the whole application');
    } else {
        trace('menubar: no frame, looking at the whole application');
    }

    const bar = findRole(app, Atspi.Role.MENU_BAR);
    if (!bar)
        trace('menubar: the application has none either');
    return bar;
}

function tagOf(item) {
    try {
        return item.get_attributes()?.tag ?? '';
    } catch (e) {
        trace('tag failed:', e.message);
        return '';
    }
}

function containerKind(container) {
    const tag = tagOf(container);
    if (tag === 'menubar')
        return 'menubar';
    if (tag === 'toolbar')
        return 'toolbar';
    return 'menu';
}

/* Firefox: tag says menu / menuitem / menuseparator, states say enabled */
function itemInfo(item) {
    const info = {tag: '', enabled: true, checked: false, checkable: false};

    try {
        const states = item.get_state_set();
        info.enabled = states.contains(Atspi.StateType.ENABLED) &&
            states.contains(Atspi.StateType.SENSITIVE);
        info.checked = states.contains(Atspi.StateType.CHECKED);
    } catch (e) {
        trace('states failed:', e.message);
    }

    try {
        const attributes = item.get_attributes() ?? {};
        info.tag = attributes.tag ?? '';
        info.checkable = attributes.checkable === 'true';
    } catch (e) {
        trace('attributes failed:', e.message);
    }

    return info;
}

function itemType(info, kind) {
    if (kind === 'menubar')
        return 'submenu';
    if (kind === 'toolbar')
        return 'standard';
    if (info.tag === 'menu')
        return 'submenu';
    return 'standard';
}

/*
 * The nodes carry the child indices they were found at, so that activating
 * one later means walking the same path down from the menubar instead of
 * keeping an accessible reference alive in the shell.
 */
function parseChildren(parent, depth, budget, kind, prefix) {
    const nodes = [];
    if (budget.left <= 0) {
        trace(`parse: the node budget is used up at depth ${depth}`);
        return nodes;
    }
    if (depth > MAX_DEPTH) {
        trace(`parse: the depth limit is reached at depth ${depth}`);
        return nodes;
    }

    const count = childCount(parent);
    for (let i = 0; i < count; i++) {
        if (budget.left-- <= 0) {
            trace('parse: the node budget ran out');
            break;
        }

        const child = childAt(parent, i);
        if (!child) {
            trace(`parse: [${i}] is not reachable`);
            continue;
        }

        const role = roleOf(child);
        const label = nameOf(child);
        const info = itemInfo(child);
        const path = [...prefix, i];

        if (role === Atspi.Role.SEPARATOR || info.tag === 'menuseparator') {
            trace(`parse: [${path.join('.')}] "${label}" is a separator`);
            nodes.push({
                label: '', type: 'separator', enabled: true, visible: true,
                children: [], path,
            });
            continue;
        }

        const node = {
            label,
            type: itemType(info, kind),
            enabled: info.enabled,
            visible: true,
            shortcut: null,
            // null: the item cannot be checked, true/false: it is checked
            toggle: info.checkable ? info.checked : null,
            children: [],
            path,
        };

        const childCount_ = childCount(child);
        if (childCount_ > 0 && depth < MAX_DEPTH) {
            node.children = parseChildren(child, depth + 1, budget,
                containerKind(child), path);
            if (node.children.length)
                node.type = 'submenu';
        }

        if (kind === 'menubar')
            node.type = 'submenu';

        trace(`parse: [${path.join('.')}] "${label}" type=${node.type} ` +
            `enabled=${node.enabled} checked=${node.toggle} children=${node.children.length}`);

        nodes.push(node);
    }

    return nodes;
}

/*
 * Does the tree have the items of every menu, or only the titles?  A toolkit
 * that publishes its menubar in the accessibility tree (Qt, GTK3) has the
 * items of every menu there.  One that builds menus when they are opened
 * (XUL, so Firefox) has only the titles, and such a tree is of no use.
 */
function isComplete(nodes) {
    for (const node of nodes) {
        if (node.type === 'separator')
            continue;
        if (!node.children.length) {
            trace(`complete: "${node.label}" has no items, so the tree is titles only`);
            return false;
        }
    }
    trace('complete: every menu has its items');
    return true;
}

function clickActionIndex(item) {
    try {
        if (!item.is_action()) {
            trace('action: the item has no action');
            return -1;
        }
        for (let i = 0; i < item.get_n_actions(); i++) {
            if (item.get_action_name(i) === 'click') {
                trace(`action: "click" is action ${i}`);
                return i;
            }
        }
        if (item.get_n_actions() > 0) {
            trace(`action: no "click", using action 0 of ${item.get_n_actions()}`);
            return 0;
        }
        trace('action: the item has no actions at all');
        return -1;
    } catch (e) {
        trace('action failed:', e.message);
        return -1;
    }
}

function main() {
    trace(`request: kind=${kind} pid=${pid} title="${title}" path=${JSON.stringify(wantedPath)}`);
    trace(`the process that started this helper has pid ${shellPid}`);

    if (!kind || !Number.isFinite(pid) || pid <= 0)
        fail('bad-request');

    let app;
    try {
        app = findApp(pid);
    } catch (e) {
        fail('no-atspi', {error: e.message});
    }
    if (!app)
        fail('no-app');

    if (kind === 'frame') {
        /*
         * The decorations of the window.
         *
         * The buttons of a title bar are ordinary widgets of the
         * application, so they are in the accessibility tree -- and their
         * state says whether the title bar is really gone (the widgets are
         * hidden, or not there any more) or merely not painted (the
         * widgets are there, showing, with the size they always had).
         */
        const frame = findFrame(app, title);
        if (!frame)
            fail('no-frame');

        const nodes = [];
        const walk = (node, depth, budget) => {
            if (depth > 12 || budget.left <= 0)
                return;
            budget.left--;

            const role = roleOf(node);
            const name = nameOf(node);
            const interesting = role === Atspi.Role.PUSH_BUTTON ||
                role === Atspi.Role.TOGGLE_BUTTON ||
                /TITLE|HEADER|FRAME|WINDOW/.test(roleName(role));

            if (interesting) {
                let extents = '';
                try {
                    const e = node.get_extents(Atspi.CoordType.SCREEN);
                    extents = ` ${Math.round(e.width)}x${Math.round(e.height)}` +
                        ` at ${Math.round(e.x)},${Math.round(e.y)}`;
                } catch (error) {
                    extents = ' (no extents)';
                }
                nodes.push({
                    role: roleName(role),
                    name,
                    showing: isShowing(node),
                    extents: extents.trim(),
                });
            }

            for (let i = 0; i < childCount(node); i++) {
                const child = childAt(node, i);
                if (child)
                    walk(child, depth + 1, budget);
            }
        };
        walk(frame, 0, {left: 500});

        trace(`frame: ${nodes.length} decoration nodes: ` +
            nodes.map(node => `${node.role}"${node.name}"` +
                `${node.showing ? '' : '(hidden)'}`).join(' | '));
        answer({ok: true, nodes});
    }

    if (kind === 'popups') {
        /*
         * Which menus of the application are open?
         *
         * A menu that is open is a menu with children that are showing: the
         * application keeps the items of a menu it has opened, and an open
         * popup is in the tree with its items.  This is what tells whether
         * the application is still holding a menu open -- which is what an
         * application with a modal grab does, and what a window whose title
         * bar is not painted any more looks like.
         */
        const open = [];
        const walk = (node, depth, budget) => {
            if (depth > 12 || budget.left <= 0)
                return;
            budget.left--;
            const r = roleOf(node);
            if ((r === Atspi.Role.MENU || r === Atspi.Role.MENU_BAR ||
                 r === Atspi.Role.POPUP_MENU) && childCount(node) > 0) {
                const showing = isShowing(node);
                open.push({name: nameOf(node), role: r, kids: childCount(node), showing});
            }
            for (let i = 0; i < childCount(node); i++) {
                const c = childAt(node, i);
                if (c)
                    walk(c, depth + 1, budget);
            }
        };
        walk(app, 0, {left: 800});
        trace(`popups: ${open.length} menus with items: ` +
            `${open.map(o => `"${o.name}"(${o.kids},${o.showing ? 'showing' : 'hidden'})`).join(', ')}`);
        answer({ok: true, popups: open});
    }


    let bar;
    try {
        bar = findMenuBar(app, title);
    } catch (e) {
        fail('walk-failed', {error: e.message});
    }
    if (!bar)
        fail('no-menubar');

    if (kind === 'titles') {
        const titles = [];
        for (let i = 0; i < childCount(bar); i++) {
            const child = childAt(bar, i);
            if (child)
                titles.push(nameOf(child));
        }
        trace(`titles: ${titles.length} titles`);
        answer({ok: true, titles});
    }

    if (kind === 'menus') {
        const menus = parseChildren(bar, 0, {left: MAX_NODES}, 'menubar', []);
        if (!menus.length) {
            trace('menus: the menubar has no children');
            fail('empty');
        }
        if (!isComplete(menus))
            fail('titles-only', {titles: menus.map(node => node.label)});
        trace(`menus: ${menus.length} menus are complete`);
        answer({ok: true, menus});
    }

    if (kind === 'submenu') {
        // one menu of the application, by the path of child indices it was
        // read at (the same path the activation uses)
        const menus = parseChildren(bar, 0, {left: MAX_NODES}, 'menubar', []);
        const wanted = wantedPath ?? [];
        let current = {children: menus};
        for (const index of wanted) {
            current = (current.children ?? [])[index];
            if (!current)
                break;
        }
        if (!current || current === bar || !Array.isArray(current.children)) {
            trace(`submenu: [${wanted.join('.')}] is not in the tree`);
            fail('no-such-menu');
        }
        trace(`submenu: [${wanted.join('.')}] has ${current.children.length} items`);
        answer({ok: true, children: current.children});
    }

    if (kind === 'activate') {
        if (!Array.isArray(wantedPath))
            fail('bad-path');

        let target = bar;
        for (const index of wantedPath) {
            const next = childAt(target, index);
            if (!next) {
                trace(`activate: [${wantedPath.join('.')}] is gone at ${index}`);
                fail('gone');
            }
            target = next;
        }

        const index = clickActionIndex(target);
        if (index < 0)
            fail('no-action');

        try {
            target.do_action(index);
            trace(`activate: [${wantedPath.join('.')}] did action ${index}`);
        } catch (e) {
            fail('action-failed', {error: e.message});
        }

        answer({ok: true, activated: true});
    }

    fail('bad-kind');
}

try {
    main();
} catch (e) {
    fail('crashed', {error: e.message});
}

// Atspi keeps the main loop alive; the answer is already on stdout.
System.exit(0);
