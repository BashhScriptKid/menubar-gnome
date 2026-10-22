#!/usr/bin/env gjs -m
/*
 * unstick — tell an application that its menus are closed.
 *
 * When the global menu of a browser is asked to build a menu, the model is
 * rebuilt, and the application remembers the open menu under the id it had
 * before the rebuild.  If the closing event reaches an id the application
 * does not know any more, it never fires `popuphidden`, and its menubar
 * stays in the "a menu is open" state -- which is the state in which the
 * window buttons of the title bar are gone.
 *
 * This sends `closed` to every top-level menu of the application (and to
 * the root), which is what the bar should have sent in the first place.
 *
 *   gjs -m devkit/unstick.js --app firefox
 *   gjs -m devkit/unstick.js --pid 1234 --mode close
 *   gjs -m devkit/unstick.js --app firefox --mode root
 *   gjs -m devkit/unstick.js --app firefox --mode reconfirm
 *
 * `close`     sends closed for every top-level menu item (default)
 * `root`      sends closed for the root item only
 * `reconfirm` sends opened and then closed again for every top-level item,
 *             which also re-runs the build
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const IFACE = 'com.canonical.dbusmenu';
const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);

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

/*
 * One item of the tree: `(i a{sv} av)` -- and every child of it is wrapped
 * in a variant again, so the wrapper is removed before the item is read.
 */
function parseItem(variant) {
    let value = variant;
    while (value.get_type_string() === 'v')
        value = value.get_child_value(0);

    const id = value.get_child_value(0).unpack();
    const children = [];
    const list = value.get_child_value(2);
    for (let i = 0; i < list.n_children(); i++)
        children.push(parseItem(list.get_child_value(i)));

    return {id, children};
}

function layout(busName, path) {
    const reply = callSync(busName, path, IFACE, 'GetLayout',
        new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
    return reply.get_child_value(1);
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

const options = {pid: null, app: null, mode: 'close'};
for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === '--pid')
        options.pid = parseInt(ARGV[++i]);
    else if (ARGV[i] === '--app')
        options.app = ARGV[++i];
    else if (ARGV[i] === '--mode')
        options.mode = ARGV[++i];
}

/*
 * The pid of a process by the name of the program.  `pgrep` is not used:
 * its `-f` matches the whole command line, and the command line of this
 * very process contains the name of the application (it is an argument).
 */
function commOf(pid) {
    try {
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/comm`);
        return ok ? new TextDecoder().decode(contents).trim() : '';
    } catch (e) {
        return '';
    }
}

const found = [];
for (const name of listNames().filter(n => n.startsWith(':'))) {
    const paths = menuPaths(name);
    if (!paths.length)
        continue;

    const pid = pidOf(name);
    const comm = commOf(pid);
    print(`candidate ${name} pid ${pid} (${comm || '?'}): ` +
        `${paths.length} menu object(s)`);

    if (options.app && comm !== options.app)
        continue;
    if (options.pid && pid !== options.pid)
        continue;

    for (const path of paths)
        found.push({busName: name, path});
}

if (!found.length) {
    print(options.app
        ? `no dbusmenu object found for "${options.app}"`
        : 'no dbusmenu object found');
}
else {
    for (const entry of found) {
        print(`${entry.busName}${entry.path}`);
        const root = parseItem(layout(entry.busName, entry.path));
        const ids = root.children.map(child => child.id);
        print(`  top-level ids: [${ids.join(', ')}]`);

        for (const id of ids) {
            if (options.mode === 'reconfirm') {
                sendEvent(entry.busName, entry.path, id, 'opened');
                await delay(400);
            }
            sendEvent(entry.busName, entry.path, id, 'closed');
            await delay(60);
        }
        if (options.mode !== 'reconfirm')
            sendEvent(entry.busName, entry.path, 0, 'closed');

        print(`  ${options.mode} sent for ${ids.length} menus`);
    }
}
