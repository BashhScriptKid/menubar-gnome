#!/usr/bin/env gjs -m
/*
 * probe-dbusmenu — look at the menus an application exports over dbusmenu,
 * straight from the session bus.
 *
 * This runs outside the shell, so it works against the live session without
 * reloading the extension.  It finds the dbusmenu objects of every process,
 * prints the whole tree with the raw properties of every item, and can send
 * the `opened`/`closed` events to a menu to see whether the application
 * fills it.
 *
 *   gjs -m devkit/probe-dbusmenu.js                    # list every app
 *   gjs -m devkit/probe-dbusmenu.js --pid 1234         # one application
 *   gjs -m devkit/probe-dbusmenu.js --app firefox      # by process name
 *   gjs -m devkit/probe-dbusmenu.js --pid 1234 --probe History
 *   gjs -m devkit/probe-dbusmenu.js --pid 1234 --probe "Other Bookmarks"
 *
 * `--probe LABEL` sends `opened` for the menu whose label is LABEL, waits,
 * reads the tree again, prints what changed, and sends `closed` so the
 * application gets its grab back.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const IFACE = 'com.canonical.dbusmenu';
const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);

/* ---- small bus helpers ------------------------------------------------- */

function callSync(busName, path, iface, method, params, replyType, timeout = 3000) {
    return conn.call_sync(busName, path, iface, method, params,
        new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE, timeout, null);
}

function listNames() {
    return callSync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', null, '(as)').deepUnpack()[0];
}

function pidOf(busName) {
    try {
        return callSync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [busName]), '(u)', 2000).deepUnpack()[0];
    } catch (e) {
        return -1;
    }
}

function introspect(busName, path) {
    try {
        return callSync(busName, path, 'org.freedesktop.DBus.Introspectable',
            'Introspect', null, '(s)', 200).deepUnpack()[0];
    } catch (e) {
        return null;
    }
}

/* the dbusmenu objects of a connection */
function menuPaths(busName) {
    const paths = [];
    const queue = ['/com/canonical/menu'];

    while (queue.length) {
        const path = queue.shift();
        const xml = introspect(busName, path);
        if (!xml)
            continue;

        const children = [];
        for (const match of xml.matchAll(/node name="([^"]+)"/g))
            children.push(match[1]);

        for (const child of children) {
            const childPath = `${path}/${child}`;
            const childXml = introspect(busName, childPath);
            if (!childXml)
                continue;
            if (childXml.includes(`interface name="${IFACE}"`))
                paths.push(childPath);
            else if (childPath.split('/').length < 6)
                queue.push(childPath);
        }
    }
    return paths;
}

/* ---- the dbusmenu tree ------------------------------------------------- */

function unwrap(value) {
    if (Array.isArray(value))
        return value.map(item => unwrap(item));

    if (!(value instanceof GLib.Variant))
        return value;

    const type = value.get_type_string();
    if (type === 'v')
        return unwrap(value.get_child_value(0));
    if (type === 'as' || type === 'ai' || type === 'au') {
        const out = [];
        for (let i = 0; i < value.n_children(); i++)
            out.push(unwrap(value.get_child_value(i)));
        return out;
    }
    if (type.startsWith('a{')) {
        const out = {};
        for (let i = 0; i < value.n_children(); i++) {
            const entry = value.get_child_value(i);
            try {
                out[unwrap(entry.get_child_value(0))] = unwrap(entry.get_child_value(1));
            } catch (e) {
                // ignore
            }
        }
        return out;
    }
    try {
        const out = value.unpack();
        if (Array.isArray(out))
            return out.map(item => unwrap(item));
        return (out instanceof GLib.Variant) ? unwrap(out) : out;
    } catch (e) {
        return null;
    }
}

function parseItem(variant) {
    let v = variant;
    while (v.get_type_string() === 'v')
        v = v.get_child_value(0);

    const id = v.get_child_value(0).unpack();
    const props = unwrap(v.get_child_value(1)) ?? {};
    const childrenVariant = v.get_child_value(2);
    const children = [];
    for (let i = 0; i < childrenVariant.n_children(); i++)
        children.push(parseItem(childrenVariant.get_child_value(i)));
    return {id, props, children};
}

function layout(busName, path, parentId = 0) {
    const reply = callSync(busName, path, IFACE, 'GetLayout',
        new GLib.Variant('(iias)', [parentId, -1, []]), '(u(ia{sv}av))');
    return parseItem(reply.get_child_value(1));
}

function label(item) {
    return (item.props.label ?? '').replace(/_/g, '') || null;
}

function describe(item) {
    const marks = [];
    const p = item.props;
    if (p.type === 'separator')
        marks.push('sep');
    if (p['children-display'] === 'submenu')
        marks.push('submenu');
    if (p.enabled === false)
        marks.push('DISABLED');
    if (p.visible === false)
        marks.push('INVISIBLE');
    if (p['toggle-type'])
        marks.push(`toggle=${p['toggle-type']}/${p['toggle-state'] ?? 0}`);
    if (p.shortcut)
        marks.push(`key=${JSON.stringify(p.shortcut)}`);
    if (!p.label && !p.type && !p['children-display'])
        marks.push('PLACEHOLDER');
    if (p['icon-name'] || p['icon-data'])
        marks.push('icon');
    const text = label(item);
    const kids = item.children.length ? ` (${item.children.length} kids)` : '';
    return `${text === null ? '<no label>' : `"${text}"`}` +
        `${marks.length ? ` [${marks.join(' ')}]` : ''}${kids}`;
}

function dump(items, indent = 1, out = []) {
    for (const item of items) {
        out.push(`${'  '.repeat(indent)}${describe(item)}  id=${item.id}`);
        dump(item.children, indent + 1, out);
    }
    return out;
}

function findByLabel(root, wanted) {
    // the top level first: "History" is both a title and an item inside View
    for (const item of root.children ?? []) {
        if (label(item) === wanted)
            return item;
    }
    for (const item of root.children ?? []) {
        const found = findByLabel(item, wanted);
        if (found)
            return found;
    }
    return null;
}

function sendEvent(busName, path, id, event) {
    try {
        callSync(busName, path, IFACE, 'Event',
            new GLib.Variant('(isvu)', [id, event, new GLib.Variant('s', ''), 0]),
            '()', 2000);
        return true;
    } catch (e) {
        print(`  !! Event(${event}) for id ${id} failed: ${e.message}`);
        return false;
    }
}

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function labels(items) {
    return items.map(item => label(item) ?? '<sep>').join(', ');
}

/* ---- what to look at --------------------------------------------------- */

const argv = ARGV;
const options = {pid: null, app: null, probe: null, csd: false};

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pid')
        options.pid = parseInt(argv[++i]);
    else if (arg === '--app')
        options.app = argv[++i];
    else if (arg === '--probe')
        options.probe = argv[++i];
    else if (arg === '--csd')
        options.csd = true;
}

/*
 * The accessibility helper: what the decorations of the window look like,
 * and which menus of the application are open.  Both are asked from a
 * separate process (the helper), because walking the accessibility tree
 * from here would need libatspi, which this script does not load.
 */
const HELPER = `${GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])}/../helpers/atspi-helper.js`;

function helper(kind, pid, title = '') {
    const [ok, stdout] = GLib.spawn_sync(null,
        ['gjs', '-m', HELPER, kind, String(pid), title],
        null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (!ok)
        return null;
    const lines = stdout.toString().trim().split('\n');
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        return null;
    }
}

function decorations(pid, title) {
    const answer = helper('frame', pid, title);
    if (!answer?.ok)
        return `unavailable (${answer?.reason ?? 'no answer'})`;

    const buttons = answer.nodes.filter(node => node.role === 'PUSH_BUTTON' ||
        node.role === 'TOGGLE_BUTTON');
    if (!buttons.length)
        return 'NO BUTTONS IN THE TREE';
    return buttons.map(node => `${node.name}${node.showing ? '' : ' HIDDEN'}` +
        ` ${node.extents}`).join(' | ');
}

function openMenus(pid, title) {
    const answer = helper('popups', pid, title);
    if (!answer?.ok)
        return `unavailable (${answer?.reason ?? 'no answer'})`;
    return answer.popups.map(popup =>
        `"${popup.name}"(${popup.kids},${popup.showing ? 'showing' : 'hidden'})`)
        .join(', ') || 'none';
}

function processName(pid) {
    try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/comm`);
        return ok ? new TextDecoder().decode(contents).trim() : '';
    } catch (e) {
        return '';
    }
}

const wantedPid = options.app
    ? parseInt(GLib.spawn_command_line_sync(`pgrep -n -f ${JSON.stringify(options.app)}`)[1]
        .toString().trim()) || null
    : options.pid;

print(`probe: looking at the session bus${wantedPid ? ` for pid ${wantedPid}` : ''}` +
    `${options.probe ? `, will probe "${options.probe}"` : ''}`);

const names = listNames().filter(name => name.startsWith(':'));
print(`probe: ${names.length} unique connections`);

const apps = new Map();   // pid -> {name, paths}
for (const name of names) {
    const paths = menuPaths(name);
    if (!paths.length)
        continue;
    const pid = pidOf(name);
    if (wantedPid && pid !== wantedPid)
        continue;
    if (!apps.has(pid))
        apps.set(pid, {names: [], paths: []});
    const app = apps.get(pid);
    app.names.push(name);
    for (const path of paths)
        app.paths.push({busName: name, path});
}

if (!apps.size) {
    print(wantedPid
        ? `probe: pid ${wantedPid} exports no dbusmenu object`
        : 'probe: no connection on the bus exports a dbusmenu object');
}
else {
    for (const [pid, app] of apps) {
        print(`\nprobe: pid ${pid} (${processName(pid) || '?'}) — ` +
            `${app.paths.length} menu object(s)`);
        for (const entry of app.paths) {
            print(`\n  ${entry.busName}${entry.path}`);
            let root;
            try {
                root = layout(entry.busName, entry.path);
            } catch (e) {
                print(`  !! GetLayout failed: ${e.message}`);
                continue;
            }

            const tree = dump([root]).slice(1);
            for (const line of tree)
                print(line);

            if (!options.probe)
                continue;

            const item = findByLabel(root, options.probe);
            if (!item) {
                print(`  !! no item labelled "${options.probe}"`);
                continue;
            }

            print(`\n  --- PROBE "${options.probe}" id=${item.id}: ` +
                `${item.children.length} children before`);
            print(`      before: ${labels(item.children)}`);

            const csdPid = pid;
            const title = '';
            if (options.csd) {
                print(`      title bar before: ${decorations(csdPid, title)}`);
                print(`      open menus  before: ${openMenus(csdPid, title)}`);
            }

            /*
             * `opened` tells the application that the menu is shown, which
             * is what makes it build the contents.  It also makes the
             * application take a grab, so `closed` must follow.
             */
            sendEvent(entry.busName, entry.path, item.id, 'opened');
            await delay(600);

            let after;
            try {
                after = findByLabel(layout(entry.busName, entry.path), options.probe);
            } catch (e) {
                print(`  !! re-read failed: ${e.message}`);
            }

            if (options.csd) {
                print(`      title bar during: ${decorations(csdPid, title)}`);
                print(`      open menus  during: ${openMenus(csdPid, title)}`);
            }

            if (after) {
                print(`      after : ${labels(after.children)}`);
                print(`      ${after.children.length} children after ` +
                    `(id ${item.id} -> ${after.id})`);
                if (after.children.length !== item.children.length)
                    print('      ==> THE APPLICATION FILLED THE MENU');
                else
                    print('      ==> no change');
            }

            /*
             * The application remembers the open menu under the id it was
             * opened with, and showing a menu renumbers the model -- so both
             * ids are closed, exactly as the extension does it.
             */
            const ids = [...new Set([item.id, after?.id])].filter(id => id !== undefined);
            for (const id of ids) {
                sendEvent(entry.busName, entry.path, id, 'closed');
                print(`      (closed id ${id})`);
            }

            if (options.csd) {
                for (const wait of [150, 500, 1000]) {
                    await delay(wait);
                    print(`      +${wait}ms title bar: ${decorations(csdPid, title)}`);
                    print(`      +${wait}ms open menus : ${openMenus(csdPid, title)}`);
                }
            }
        }
    }
}
