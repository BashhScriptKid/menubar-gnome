/* dbusmenu source — the richest source.
 *
 * Apps that export a menu (Chromium, Firefox under XWayland, GTK3 apps with
 * appmenu-gtk-module, Qt apps) publish a `com.canonical.dbusmenu` object and
 * announce it by calling `com.canonical.AppMenu.Registrar.RegisterWindow()`.
 *
 * We *are* that registrar. Two details matter and both are non-obvious:
 *
 *  - The modern signature is `RegisterWindow(u windowId, o menuObjectPath)`.
 *    The legacy protocol used `(o window, u timestamp)`. Chromium's and
 *    Firefox's dbus libraries resolve methods by name *and* verify the
 *    in-signature, so a mismatch means the call is never even sent — the app
 *    silently never registers.
 *
 *  - `GetLayout` is `(i parentId, i recursionDepth, as propertyNames)`, not
 *    the spec's `(u revision, i parentId, as)`. Same silent-failure story:
 *    calling it spec-style returns an empty tree, which looks exactly like
 *    "this app has no menu".
 *
 * The registrar key (windowId) is opaque — it is *not* an X window id — so we
 * resolve a focused Meta.Window to its registration through the process id of
 * the bus name that called us.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {log, dumpTree} from '../debug.js';

const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const DBUSMENU_IFACE = 'com.canonical.dbusmenu';
const MAX_PID_LOOKUPS = 4;   // bus calls per update when resolving pids
const INTROSPECT_TIMEOUT_MS = 60;    // a connection that does not answer
const DISCOVERY_EMPTY_TTL_US = 10 * 1000 * 1000;   // look again when nothing was found

/*
 * Ask the application to build a menu?
 *
 * The `opened` event of the dbusmenu protocol makes the application show
 * the menu -- in its own window, with a grab.  That is the only way to get
 * the parts of a menu that the application only builds when it is shown
 * (the history list, the bookmark list, the folders of the bookmarks), and
 * it is also the only way our extension changes anything in the window of
 * an application: the application hides the buttons of its title bar while
 * a menu of it is open, and some builds do not bring them back.
 *
 * With this off the bar shows what the export of the application holds --
 * the structure of the menus, but not the parts that are filled when they
 * are shown.
 */
const DEMAND_MENUS = true;

/*
 * The same switch, but at runtime: with this file in place the
 * application is never asked to build a menu, and the bar shows what the
 * export of the application holds.  It is the way to try the two ways
 * without logging out (the extension is loaded once per shell process).
 *
 *   touch ~/.cache/menubar-no-demand
 */
const DEMAND_SWITCH_FILE = `${GLib.get_home_dir()}/.cache/menubar-no-demand`;

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/*
 * How long to wait for the application to say that it built a menu.  The
 * build usually happens while it handles the `opened` event, so this is only
 * the fallback for the applications that build it asynchronously.
 */
const BUILD_TIMEOUT_MS = 500;

function demandAllowed() {
    if (!DEMAND_MENUS)
        return false;
    return !GLib.file_test(DEMAND_SWITCH_FILE, GLib.FileTest.EXISTS);
}

const REGISTRAR_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg type="u" name="windowId" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="o" name="menuObjectPath" direction="out"/>
    </method>
  </interface>
</node>`;

export class DBusMenuSource {
    constructor() {
        this._registrations = new Map();   // windowId -> {busName, path}
        this._discovered = new Map();       // pid -> Promise of [{busName, path}]
        this._lastObject = new Map();       // pid -> {busName, path} of the last tree
        this._watched = new Set();          // "busNamepath" of the objects we watch
        this._changed = new Set();          // "busNamepath" -> the app changed its menus
        this._revisions = new Map();        // "busNamepath" -> the revision we read
        this._built = new Map();            // menu path -> what the application built
        this._opened = new Map();           // "busNamepath" -> the ids we opened
        this._builds = new Map();           // "busNamepath" -> when it was built
        this._waiters = [];                 // waiting for a menu to be built
        this._openedAt = 0;                 // when the last "opened" was sent
        this._namesOfPid = null;            // pid -> [busName]
        this._pidCache = new Map();        // busName -> pid
        this._byPid = new Map();           // pid -> [registration]
        this._conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._ownerId = 0;
        this._objectId = 0;
    }

    get name() {
        return 'dbusmenu';
    }

    start() {
        const info = Gio.DBusNodeInfo.new_for_xml(REGISTRAR_XML);
        this._objectId = this._conn.register_object(
            REGISTRAR_PATH, info.interfaces[0], this._onMethodCall.bind(this), null, null);

        this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, REGISTRAR_NAME,
            Gio.BusNameOwnerFlags.NONE, null,
            () => this._onNameAcquired(), () => this._onNameLost());
    }

    stop() {
        /*
         * Close every menu that is still open in an application.  A menu
         * that is left open in the application keeps a grab there: the
         * application does not answer any more, and the window of the
         * application is in a strange state (its title bar is not painted
         * any more, so the buttons of the window disappear).
         */
        for (const [key, ids] of this._opened) {
            const [busName, path] = key.split('|');
            for (const id of ids)
                this._sendEvent(busName, path, id, 'closed');
        }
        this._opened.clear();

        if (this._objectId) {
            this._conn.unregister_object(this._objectId);
            this._objectId = 0;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._registrations.clear();
        this._byPid.clear();
        this._discovered.clear();
        this._namesOfPid = null;
    }

    _onNameAcquired() {
        log('dbusmenu', `owning ${REGISTRAR_NAME}`);
    }

    _onNameLost() {
        // another registrar took over; we stop being a source
        log('dbusmenu', `lost ${REGISTRAR_NAME} — another registrar is running`);
    }

    _onMethodCall(connection, sender, objectPath, interfaceName, methodName,
                  parameters, invocation) {
        log('dbusmenu', `method ${methodName} from ${sender}`,
            parameters.print(true));
        switch (methodName) {
        case 'RegisterWindow': {
            const [windowId, menuPath] = parameters.deepUnpack();
            this._register(sender, windowId, menuPath);
            invocation.return_value(null);
            break;
        }
        case 'UnregisterWindow': {
            const [windowId] = parameters.deepUnpack();
            this._unregister(windowId);
            invocation.return_value(null);
            break;
        }
        case 'GetMenuForWindow': {
            const [windowId] = parameters.deepUnpack();
            const entry = this._registrations.get(windowId);
            invocation.return_value(new GLib.Variant('(o)', [entry ? entry.path : '/']));
            break;
        }
        default:
            invocation.return_error_literal(
                Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD,
                `Unknown method ${methodName}`);
            break;
        }
    }

    _register(sender, windowId, menuPath) {
        this._registrations.set(windowId, {busName: sender, path: menuPath});
        log('dbusmenu', `REGISTERED window=${windowId} menu=${menuPath} bus=${sender}`,
            `(now ${this._registrations.size} registrations)`);
        this._pidCache.delete(sender);
        this._rebuildPidIndex();
        // the application announced a menu, so the one that was found on the
        // bus is not needed any more
        this._discovered.clear();
        // resolve the pid right away: doing it lazily means every update has
        // to ask the bus about every registered application
        this._pidForBusName(sender, () => {});
        this.onUpdated?.();
    }

    _unregister(windowId) {
        log('dbusmenu', `UNREGISTERED window=${windowId} (was ` +
            `${JSON.stringify(this._registrations.get(windowId) ?? null)})`);
        this._registrations.delete(windowId);
        this._rebuildPidIndex();
        this._discovered.clear();
        this.onUpdated?.();
    }

    _rebuildPidIndex() {
        this._byPid.clear();
        for (const [windowId, entry] of this._registrations) {
            const pid = this._pidCache.get(entry.busName);
            if (pid === undefined)
                continue;
            if (!this._byPid.has(pid))
                this._byPid.set(pid, []);
            this._byPid.get(pid).push({windowId, ...entry});
        }
    }

    _pidForBusName(busName, callback) {
        if (this._pidCache.has(busName)) {
            log('dbusmenu', `pid of ${busName} is cached: ${this._pidCache.get(busName)}`);
            callback(this._pidCache.get(busName));
            return;
        }
        log('dbusmenu', `asking the bus for the pid of ${busName}`);
        this._conn.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [busName]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 2000,
            null, (source, result) => {
                try {
                    const [pid] = source.call_finish(result).deepUnpack();
                    log('dbusmenu', `pid of ${busName} is ${pid}`);
                    this._pidCache.set(busName, pid);
                    this._rebuildPidIndex();
                    callback(pid);
                } catch (e) {
                    log('dbusmenu', `could not get the pid of ${busName}: ${e.message}`);
                    this._pidCache.set(busName, -1);
                    callback(-1);
                }
            });
    }

    /*
     * A D-Bus call as a Promise.
     *
     * The discovery below used to call the bus synchronously.  That blocks
     * the main loop of the shell: resolving the pid of one application cost
     * a ListNames plus a pid lookup for every connection on the bus (170 of
     * them on a normal desktop), and a connection that did not answer cost
     * its whole introspection timeout.  Everything else in the shell --
     * including the timers of the other sources -- waited for it, so one
     * update took 750ms even though each piece was fast.
     */
    _call(busName, path, iface, method, params, replyType, timeout) {
        return new Promise((resolve, reject) => {
            this._conn.call(busName, path, iface, method, params,
                new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE, timeout, null,
                (source, result) => {
                    try {
                        resolve(source.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async getMenus(descriptor) {
        if (!descriptor) {
            log('dbusmenu', 'getMenus: no descriptor');
            return null;
        }

        const pid = descriptor.pid;
        if (!pid || pid <= 0) {
            log('dbusmenu', `getMenus: no pid (${pid})`);
            return null;
        }

        log('dbusmenu', `getMenus: pid=${pid} title="${descriptor.title}"` +
            ` context=${descriptor.context}`);

        // resolve the registration(s) belonging to this process
        const entries = await this._entriesForPid(pid);
        log('dbusmenu', `registrations for pid ${pid}: ${entries.length}`,
            entries.map(entry => `${entry.busName}${entry.path}`));
        if (entries.length) {
            for (const entry of entries) {
                const nodes = await this._readTree(entry.busName, entry.path);
                if (nodes && nodes.length) {
                    // the nodes belong to this window and to no other one
                    log('dbusmenu', `using the registered menu ${entry.busName}${entry.path}`,
                        `(${nodes.length} titles)`);
                    this._rememberObject(pid, entry.busName, entry.path);
                    this._tag(nodes, descriptor.context);
                    dumpTree('dbusmenu', nodes, 'registered menubar');
                    return nodes;
                }
                log('dbusmenu', `registration ${entry.busName}${entry.path} gave no menus`);
            }
        }

        /*
         * The application may export its menu without announcing it.
         *
         * An application that exports a dbusmenu object puts it on the
         * session bus under /com/canonical/menu/<n> -- the object is
         * created by dbusmenu_server_new() and is on the bus whether the
         * application announces it or not.  Only the announcement differs:
         * an X11 application calls RegisterWindow() on the registrar, while
         * a Wayland application tells the compositor about it, which needs
         * a protocol the compositor may not have.
         *
         * So the object is looked for on the bus.  The connections of the
         * process are found by their pid, and the objects are found by
         * asking the bus daemon for the names of the process.
         */
        const found = await this._discoverForPid(pid);
        let candidates = found;
        log('dbusmenu', `menu objects on the bus for pid ${pid}: ${candidates.length}`,
            candidates.map(entry => `${entry.busName}${entry.path}`));

        /*
         * An application with several windows exports one object per
         * window, and the one of the window in front is the one wanted.
         * The titles of the window say which object it is -- but they are
         * only read when there is more than one candidate, because reading
         * them costs a walk through the accessibility tree of the
         * application.
         */
        const titles = candidates.length > 1 ? await this._titlesFor(descriptor) : null;
        if (candidates.length > 1) {
            log('dbusmenu', `several objects: AT-SPI titles =`,
                titles ? `[${titles.join(', ')}]` : 'unavailable');
        }

        for (const entry of candidates) {
            const nodes = await this._readTree(entry.busName, entry.path);
            if (!nodes || !nodes.length)
                continue;

            if (titles?.length) {
                const labels = nodes.map(node => node.label);
                const matches = labels.length === titles.length &&
                    labels.every((label, i) => label === titles[i]);
                log('dbusmenu', `${entry.busName}${entry.path}: ` +
                    `[${labels.join(', ')}] ${matches ? 'MATCHES' : 'does not match'} ` +
                    'the AT-SPI titles');
                if (!matches)
                    continue;
            }

            log('dbusmenu', `using discovered menu ${entry.busName}${entry.path}`,
                `(${nodes.length} titles)`);
            this._rememberObject(pid, entry.busName, entry.path);
            this._tag(nodes, descriptor.context);
            dumpTree('dbusmenu', nodes, 'discovered menubar');
            return nodes;
        }

        /*
         * None of the objects that are known fits the window -- the
         * application may have opened another window, which exported
         * another object.  So the bus is looked at again.
         */
        if (candidates.length > 1 && titles?.length) {
            log('dbusmenu', 'no object matched, scanning the bus again');
            this._discovered.delete(pid);
            candidates = await this._discoverForPid(pid);
            for (const entry of candidates) {
                const nodes = await this._readTree(entry.busName, entry.path);
                if (!nodes || !nodes.length)
                    continue;

                const labels = nodes.map(node => node.label);
                if (labels.length !== titles.length ||
                    !labels.every((label, i) => label === titles[i]))
                    continue;

                log('dbusmenu', `rescan found ${entry.busName}${entry.path}`);
                this._tag(nodes, descriptor.context);
                dumpTree('dbusmenu', nodes, 'rescanned menubar');
                return nodes;
            }
        }

        log('dbusmenu', `no menu found for pid ${pid}`);
        return null;
    }

    /*
     * The titles of the menubar of the window, if they can be read.
     */
    async _titlesFor(descriptor) {
        if (!descriptor.getTitles) {
            log('dbusmenu', 'no title source available');
            return null;
        }

        try {
            const titles = await descriptor.getTitles();
            log('dbusmenu', `AT-SPI titles:`, titles ? `[${titles.join(', ')}]` : 'null');
            return titles;
        } catch (e) {
            log('dbusmenu', `could not read the titles: ${e.message}`);
            return null;
        }
    }

    /*
     * The dbusmenu objects that a process exports, found on the session bus
     * without an announcement.
     *
     * The bus daemon is asked for the names of the process, and every name
     * is asked whether it has an object.  That is a lot of calls, so the
     * result is remembered -- the objects of a process do not move.  A
     * process that exported nothing is looked at again after a while, so
     * that an application which connects to the bus (or starts exporting)
     * after it was first focused is still found.
     */
    async _discoverForPid(pid) {
        const cached = this._discovered.get(pid);
        if (cached && (cached.count === null || cached.count > 0 ||
                       GLib.get_monotonic_time() - cached.at < DISCOVERY_EMPTY_TTL_US)) {
            log('dbusmenu', `discovery for ${pid} is cached`);
            return cached.promise;
        }

        const started = GLib.get_monotonic_time();
        const entry = {at: GLib.get_monotonic_time(), count: null, promise: null};
        const promise = this._scanBusForPid(pid).catch(e => {
            log('dbusmenu', `could not look for menus of ${pid}: ${e.message}`);
            return [];
        }).then(found => {
            log('dbusmenu', `discovery for ${pid} took ` +
                `${((GLib.get_monotonic_time() - started) / 1000).toFixed(0)}ms: ${found.length} objects`);
            entry.count = found.length;
            return found;
        });
        entry.promise = promise;
        this._discovered.set(pid, entry);
        return promise;
    }

    async _scanBusForPid(pid) {
        const names = await this._busNamesOfPid(pid);
        log('dbusmenu', `bus names of ${pid}:`, names);
        const found = [];

        /*
         * The objects are found by introspection: the bus daemon knows the
         * children of a path, so one call per level is enough.  A path that
         * does not exist is answered at once, while a connection that does
         * not answer at all would take until the timeout -- a browser has
         * several connections and only one of them has the menu, so the
         * timeout has to be short.  The connections are looked at in
         * parallel: done one after the other, the timeouts added up.
         */
        const perName = await Promise.all(
            names.map(busName => this._menuObjectPaths(busName)));

        names.forEach((busName, i) => {
            for (const path of perName[i])
                found.push({busName, path});
        });

        if (found.length)
            log('dbusmenu', `found ${found.length} menu objects of ${pid} on the bus`);

        return found;
    }

    /*
     * The paths of the dbusmenu objects of a connection.
     *
     * A dbusmenu object lives under /com/canonical/menu/<n>, so the
     * children of /com/canonical/menu are the objects.  The path is walked
     * down from the root, because a connection may have other things on the
     * bus as well.
     */
    async _menuObjectPaths(busName) {
        const paths = [];
        const queue = ['/com/canonical/menu'];
        let unanswered = 0;
        let checked = 0;

        while (queue.length) {
            const path = queue.shift();
            checked++;

            let children = [];
            try {
                const xml = (await this._call(busName, path,
                    'org.freedesktop.DBus.Introspectable', 'Introspect', null,
                    '(s)', INTROSPECT_TIMEOUT_MS)).deepUnpack()[0];

                for (const match of xml.matchAll(/node name="([^"]+)"/g))
                    children.push(match[1]);
            } catch (e) {
                unanswered++;
                log('dbusmenu', `  ${busName}${path}: introspection failed: ${e.message}`);
                continue;
            }

            log('dbusmenu', `  ${busName}${path}: ${children.length} children` +
                (children.length ? ` [${children.join(', ')}]` : ''));

            for (const child of children) {
                const childPath = `${path}/${child}`;
                if (await this._isMenuObject(busName, childPath)) {
                    log('dbusmenu', `  ${busName} has a menu object at ${childPath}`);
                    paths.push(childPath);
                } else if (childPath.split('/').length < 6) {
                    queue.push(childPath);
                }
            }
        }

        if (!paths.length && unanswered)
            log('dbusmenu', `  ${busName}: no menu object ` +
                `(${unanswered} of ${checked} paths did not answer introspection)`);
        else
            log('dbusmenu', `  ${busName}: ${paths.length} menu objects ` +
                `(${checked} paths looked at, ${unanswered} did not answer)`);

        return paths;
    }

    /* does the object at that path carry the dbusmenu interface? */
    async _isMenuObject(busName, path) {
        try {
            const xml = (await this._call(busName, path,
                'org.freedesktop.DBus.Introspectable', 'Introspect', null,
                '(s)', INTROSPECT_TIMEOUT_MS)).deepUnpack()[0];
            const isMenu = xml.includes(`interface name="${DBUSMENU_IFACE}"`);
            log('dbusmenu', `  ${busName}${path}: ${isMenu ? 'IS a menu object' : 'is not a menu object'}`);
            return isMenu;
        } catch (e) {
            log('dbusmenu', `  ${busName}${path}: introspection failed: ${e.message}`);
            return false;
        }
    }

    /*
     * The bus names of a process.
     *
     * The bus daemon knows the pid behind every name, but asking it for
     * every name on the bus is a lot of calls.  The answer is remembered
     * per name forever -- unique names are never reused -- so only the
     * names that appeared since the last look are resolved.  The lookups
     * themselves run in parallel and asynchronously, because a few hundred
     * of them done one after the other, synchronously, froze the shell.
     */
    async _busNamesOfPid(pid) {
        if (!this._namesOfPid)
            this._namesOfPid = new Map();   // pid -> [busName]
        if (!this._nameTable)
            this._nameTable = new Map();    // busName -> pid, -1 if gone

        const known = this._namesOfPid.get(pid);
        if (known) {
            log('dbusmenu', `bus names of ${pid} are cached (${known.length})`);
            return known;
        }

        const all = (await this._call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, '(as)', 3000)).deepUnpack()[0];
        log('dbusmenu', `${all.length} names on the bus, looking for pid ${pid}`);

        // only the unique names belong to a single process
        const unique = all.filter(name => name.startsWith(':'));
        const unknown = unique.filter(name => !this._nameTable.has(name));

        await Promise.all(unknown.map(async name => {
            try {
                const owner = (await this._call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                    'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                    new GLib.Variant('(s)', [name]), '(u)', 2000)).deepUnpack()[0];
                this._nameTable.set(name, owner);
            } catch (e) {
                this._nameTable.set(name, -1);
                log('dbusmenu', `the pid of ${name} is not known: ${e.message}`);
            }
        }));
        log('dbusmenu', `${unknown.length} of ${unique.length} names had to be looked at` +
            ` (${this._nameTable.size} names are known in total)`);

        const names = unique.filter(name => this._nameTable.get(name) === pid);

        // a process may not have connected to the bus yet: let the next
        // update look again instead of remembering "none"
        if (names.length)
            this._namesOfPid.set(pid, names);

        return names;
    }

    /*
     * The titles of the menubar of a process, read from the object that is
     * already known.  This is a plain listing: it opens nothing and needs
     * no search on the bus, so it is cheap enough for the structure check
     * that runs every few seconds.
     */
    async getTitles(descriptor) {
        const pid = descriptor?.pid;
        if (!pid)
            return null;

        const object = this._lastObject.get(pid);
        if (!object) {
            log('dbusmenu', `getTitles: no menu object is known for pid ${pid}`);
            return null;
        }

        const started = GLib.get_monotonic_time();
        const nodes = await this._readTree(object.busName, object.path);
        const elapsed = (GLib.get_monotonic_time() - started) / 1000;
        if (!nodes?.length) {
            log('dbusmenu', `getTitles: ${object.busName}${object.path} has no titles ` +
                `(${elapsed.toFixed(1)}ms)`);
            return null;
        }

        const titles = nodes.map(node => node.label);
        log('dbusmenu', `getTitles: [${titles.join(', ')}] (${elapsed.toFixed(1)}ms)`);
        return titles;
    }

    _rememberObject(pid, busName, path) {
        this._lastObject.set(pid, {busName, path});
        this._watchObject(pid, busName, path);
    }

    /*
     * Watch a menu object.
     *
     * The dbusmenu protocol has a signal for exactly this: `LayoutUpdated`
     * says that the layout of the menu changed, and `ItemsPropertiesUpdated`
     * says that the properties of some items changed.  An application that
     * sends them tells the bar that its menus are not what the bar has.
     *
     * Firefox does not send them (measured: no signal at all while it
     * filled a menu), so the revision of the tree is the watch for it: the
     * revision changes with every rebuild of the model.  It has to be asked
     * for, but the answer is tiny.
     */
    _watchObject(pid, busName, path) {
        const key = `${busName}${path}`;
        if (this._watched.has(key))
            return;
        this._watched.add(key);

        const changed = (what, detail) => {
            log('dbusmenu', `watch: ${what} on ${busName}${path}${detail ? ` (${detail})` : ''}`);
            /*
             * The tree of the application is not what the bar has any more.
             * The bar is not rebuilt here: that would close a menu that is
             * open.  The next time a menu of the application is fetched, the
             * new tree is read -- and that is when the bar needs it.
             */
            this._changed.add(`${busName}${path}`);

            /*
             * The application says when it rebuilt its model -- that is
             * when a menu it was asked to build is ready.  Whoever waits
             * for that can go on.
             */
            if (what === 'LayoutUpdated') {
                const key = `${busName}${path}`;
                this._builds.set(key, GLib.get_monotonic_time());
                for (const waiter of this._waiters) {
                    if (waiter.key === key)
                        waiter.resolve(true);
                }
            }
        };

        try {
            this._conn.signal_subscribe(busName, DBUSMENU_IFACE, 'LayoutUpdated', path, null,
                Gio.DBusSignalFlags.NONE, (c, sender, objectPath, iface, signal, params) => {
                    const [revision, parent] = params.deepUnpack();
                    changed('LayoutUpdated', `revision=${revision} parent=${parent}`);
                });
            this._conn.signal_subscribe(busName, DBUSMENU_IFACE, 'ItemsPropertiesUpdated', path, null,
                Gio.DBusSignalFlags.NONE, (c, sender, objectPath, iface, signal, params) => {
                    const [updated, removed] = params.deepUnpack();
                    changed('ItemsPropertiesUpdated',
                        `${updated.length} updated, ${removed.length} removed`);
                });
            log('dbusmenu', `watching ${busName}${path} for layout changes`);
        } catch (e) {
            log('dbusmenu', `could not watch ${busName}${path}: ${e.message}`);
        }
    }

    /*
     * Wait until the application says that it rebuilt its model.
     *
     * The `LayoutUpdated` signal is that message: it comes when the model
     * of the application was rebuilt, which is what happens when it built
     * the menu it was asked to build.  The wait is bounded -- the menu is
     * closed either way, and an application that says nothing is simply
     * slower, not stuck.
     */
    _waitForBuild(busName, path, timeout) {
        const key = `${busName}${path}`;

        // it may have happened while the "opened" call was running
        const built = this._builds.get(key);
        if (built !== undefined && built >= this._openedAt)
            return Promise.resolve(true);

        return new Promise(resolve => {
            let done = false;
            let timer = 0;

            const waiter = {
                key,
                resolve: value => {
                    if (done)
                        return;
                    done = true;
                    if (timer)
                        GLib.source_remove(timer);
                    this._waiters = this._waiters.filter(w => w !== waiter);
                    resolve(value);
                },
            };

            this._waiters.push(waiter);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                waiter.resolve(false);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /*
     * The revision of the model of an application.
     *
     * The revision changes with every rebuild of the model, so it says
     * whether the tree the bar has is still the tree of the application.
     * The answer is small: only the root of the menu is asked for.
     */
    _revision(busName, path) {
        return new Promise(resolve => {
            this._conn.call(busName, path, DBUSMENU_IFACE, 'GetLayout',
                new GLib.Variant('(iias)', [0, 0, []]),
                new GLib.VariantType('(u(ia{sv}av))'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (source, result) => {
                    try {
                        resolve(source.call_finish(result).get_child_value(0).unpack());
                    } catch (e) {
                        log('dbusmenu', `the revision of ${busName}${path} is not known: ` +
                            `${e.message}`);
                        resolve(-1);
                    }
                });
        });
    }

    _tag(nodes, context) {
        for (const node of nodes) {
            node.context = context;
            if (node.children?.length)
                this._tag(node.children, context);
        }
    }

    _entriesForPid(pid) {
        return new Promise(resolve => {
            const known = this._byPid.get(pid);
            if (known && known.length) {
                log('dbusmenu', `pid ${pid} has ${known.length} known registrations`);
                resolve(known);
                return;
            }
            // we may not know the pid of every registrar yet
            const names = [...new Set([...this._registrations.values()].map(e => e.busName))]
                .filter(name => !this._pidCache.has(name));
            if (!names.length) {
                log('dbusmenu', `pid ${pid}: no registration and no unresolved pids left`);
                resolve([]);
                return;
            }
            log('dbusmenu', `pid ${pid}: resolving ${Math.min(names.length, MAX_PID_LOOKUPS)} ` +
                `of ${names.length} unresolved bus names`);
            // only a few at a time: the bus calls can take a moment each and
            // this runs on every focus change
            const batch = names.slice(0, MAX_PID_LOOKUPS);
            let pending = batch.length;
            for (const name of batch) {
                this._pidForBusName(name, () => {
                    pending--;
                    if (pending === 0) {
                        const entries = this._byPid.get(pid) ?? [];
                        log('dbusmenu', `pid ${pid}: after resolving ${batch.length} bus names ` +
                            `there are ${entries.length} registrations`);
                        resolve(entries);
                    }
                });
            }
        });
    }

    _readTree(busName, path) {
        return new Promise(resolve => {
            const started = GLib.get_monotonic_time();
            this._conn.call(busName, path, DBUSMENU_IFACE, 'GetLayout',
                new GLib.Variant('(iias)', [0, -1, []]),
                new GLib.VariantType('(u(ia{sv}av))'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (source, result) => {
                    const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                    try {
                        const reply = source.call_finish(result);
                        // reply: (u (ia{sv}av))
                        const revision = reply.get_child_value(0).unpack();
                        this._revisions.set(`${busName}${path}`, revision);
                        const layout = reply.get_child_value(1);
                        // the dbusmenu root is the menubar container; its
                        // children are the top-level menus (File, Edit, ...)
                        const root = this._buildNode(this._parseItem(layout), busName, path, 0, []);
                        const count = root?.children?.length ?? 0;
                        log('dbusmenu', `GetLayout ${busName}${path} -> revision ${revision}, ` +
                            `${count} top-level menus in ${elapsed.toFixed(1)}ms`);
                        resolve(root?.children ?? null);
                    } catch (e) {
                        log('dbusmenu', `GetLayout ${busName}${path} FAILED after ` +
                            `${elapsed.toFixed(1)}ms: ${e.message}`);
                        resolve(null);
                    }
                });
        });
    }

    /*
     * The layout is a tree of (ia{sv}av) structs, but Chromium wraps each
     * child in an extra variant ('v' inside 'av'), and GJS 1.88's
     * GLib.Variant.get_string() is broken (it returns "[text,length]"), so
     * everything is read through unpack().
     */
    _parseItem(variant) {
        let v = variant;
        while (v.get_type_string() === 'v')
            v = v.get_child_value(0);

        const id = v.get_child_value(0).unpack();
        const props = this._parseProps(v.get_child_value(1));
        const childrenVariant = v.get_child_value(2);

        const children = [];
        for (let i = 0; i < childrenVariant.n_children(); i++)
            children.push(this._parseItem(childrenVariant.get_child_value(i)));

        return {id, props, children};
    }

    /*
     * GJS 1.88's Variant.unpack() is unreliable for some types (it returns
     * "[text,length]" for strings via get_string(), and [{},{}] for string
     * arrays), so values are unwrapped by hand.
     */
    _unwrap(value) {
        if (Array.isArray(value))
            return value.map(item => this._unwrap(item));

        if (!(value instanceof GLib.Variant))
            return value;

        const type = value.get_type_string();

        if (type === 'v') {
            try {
                return this._unwrap(value.get_child_value(0));
            } catch (e) {
                return null;
            }
        }

        if (type === 'as' || type === 'ai' || type === 'au') {
            const out = [];
            for (let i = 0; i < value.n_children(); i++)
                out.push(this._unwrap(value.get_child_value(i)));
            return out;
        }

        if (type.startsWith('a{')) {
            const out = {};
            for (let i = 0; i < value.n_children(); i++) {
                const entry = value.get_child_value(i);
                try {
                    const key = this._unwrap(entry.get_child_value(0));
                    out[key] = this._unwrap(entry.get_child_value(1));
                } catch (e) {
                    // ignore malformed entry
                }
            }
            return out;
        }

        try {
            const out = value.unpack();
            if (Array.isArray(out))
                return out.map(item => this._unwrap(item));
            return (out instanceof GLib.Variant) ? this._unwrap(out) : out;
        } catch (e) {
            return null;
        }
    }

    _parseProps(propsVariant) {
        const out = {};
        let unpacked;
        try {
            unpacked = propsVariant.deepUnpack();
        } catch (e) {
            return out;
        }

        for (const [key, value] of Object.entries(unpacked))
            out[key] = this._unwrap(value);

        return out;
    }

    _buildNode(item, busName, path, menuId = 0, itemPath = []) {
        const props = item.props ?? {};
        const rawChildren = item.children ?? [];

        /*
         * A placeholder.
         *
         * When the application has not built the contents of a menu, it puts
         * an empty item in its place -- an item with no label and nothing
         * in it.  It is not an item, and it must not be shown as one: it
         * would look like an entry with an empty name.
         */
        if (this._isPlaceholder(props, rawChildren)) {
            log('dbusmenu', `dropping placeholder id=${item.id} at ` +
                `[${itemPath.join(' / ')}] raw=${JSON.stringify(props)}`);
            return null;
        }

        const children = rawChildren
            .map(child => this._buildNode(child, busName, path, item.id,
                [...itemPath, child.props?.label ?? '']))
            .filter(child => child !== null);

        /*
         * The type of an item.
         *
         * A separator says so with "type".  A menu of its own says so with
         * "children-display" being "submenu" -- that is the only mark it
         * has, and without it every submenu is a plain item and its
         * contents are never shown.
         */
        let type = props.type ?? 'standard';
        if (type !== 'separator' &&
            (props['children-display'] === 'submenu' || children.length))
            type = 'submenu';

        const node = {
            id: item.id,
            label: (props.label ?? '').replace(/_/g, ''),
            type,
            enabled: props.enabled !== false,
            visible: props.visible !== false,
            shortcut: this._formatShortcut(props.shortcut),
            toggle: props['toggle-type'] ? (props['toggle-state'] ?? 0) : null,
            children,
            // where the item is in the tree, so that it can be found again
            // when the application renumbers its model
            path: itemPath,
        };

        log('dbusmenu', `node id=${item.id} at [${itemPath.join(' / ')}] ` +
            `type=${type} label="${node.label}" enabled=${node.enabled}` +
            ` visible=${node.visible} toggle=${node.toggle} shortcut=${node.shortcut ?? '-'}` +
            ` children=${children.length} raw=${JSON.stringify(props)}`);

        if (type !== 'separator' && node.children.length === 0) {
            /*
             * The click is done by path, not by the id that was read here:
             * the application renumbers its model when it rebuilds it, so
             * an id of a moment ago can be unknown by the time the user
             * clicks.
             */
            node.activate = () => this._activate(busName, path, node);
        }

        /*
         * Every menu can be fetched again.
         *
         * The export of the application is a snapshot of its markup, and
         * the application fills the menus when they are shown: the history
         * list, the bookmark list and the folders of the bookmarks are
         * added by the `popupshowing` handler of the popup, not by the
         * markup.  The same is true for a menu that has not been built at
         * all -- the application puts an empty item in its place.
         *
         * So every menu carries the way to get its current contents, and
         * the bar asks for them when it is about to show the menu.  There
         * is no difference between a top-level menu and a menu inside a
         * menu: both are fetched the same way.
         */
        if (type === 'submenu')
            node.fetch = ({demand = true} = {}) => this._fetchMenu(busName, path, node, demand);

        if (type === 'submenu' && this._hasPlaceholderChild(rawChildren)) {
            log('dbusmenu', `"${node.label}" is not fully built (it has an empty ` +
                `placeholder in it, id=${item.id}) — it will be asked for when it is shown`);
            /*
             * The items that are there are kept: the placeholder is only
             * the place where the application puts the parts it has to
             * build itself.
             */
            node.unbuilt = true;
        }

        return node;
    }

    /*
     * Is this the empty item an application puts in place of the contents
     * of a menu it has not built?
     */
    _isPlaceholder(props, children) {
        if (props.label || props.type || props['children-display'])
            return false;
        if (children.length)
            return false;
        return true;
    }

    /*
     * Does this menu have nothing but the placeholder in it?
     */
    /*
     * Does the menu have a part that the application has to build?
     *
     * The export puts an empty item in place of the contents that are only
     * there when the menu is shown: the recent bookmarks of the bookmarks
     * menu, the history entries of the history menu, and the whole of a
     * folder that was never opened.  Such an item has no label, no type
     * and no children -- that is what makes it a placeholder.
     */
    _hasPlaceholderChild(children) {
        for (const child of children) {
            if (this._isPlaceholder(child.props ?? {}, child.children ?? []))
                return true;
        }
        return false;
    }

    /*
     * Read the contents of a menu the application has not built.
     *
     * The application fills such a menu when it is shown, and the dbusmenu
     * protocol has an event for that: `opened` makes the application show
     * the menu, and it fills it while doing so.  The contents are read
     * after that.
     *
     * Showing a menu in the application means that the application shows it
     * -- in its own window, and with a grab.  So the menu is closed again
     * right away: `closed` is what the application needs to give the grab
     * back and to forget that the menu was open.  Without it the menubar of
     * the application gets stuck, and it cannot be opened with the keyboard
     * any more.
     *
     * The id of an item is not stable: the application renumbers its model
     * every time it rebuilds it, and filling a menu is a rebuild.  So the
     * menu is looked up again by its path, and the event is sent to the id
     * it has now.
     */
    /*
     * The current contents of a menu.
     *
     * The export of the application is a snapshot of its markup, and the
     * parts that are added when the menu is shown -- the history list, the
     * bookmark list, "Mobile Bookmarks", the recently closed tabs, the
     * folders of the bookmarks -- are not in it.  `opened` is the event
     * that makes the application show the menu, and showing it is what
     * makes it fill it.  A menu the application has not built at all is
     * exported as an empty item, and it is filled the same way.
     *
     * Showing a menu in the application means that the application shows it
     * -- in its own window, and with a grab.  So the menu is closed again
     * right away: `closed` is what the application needs to give the grab
     * back and to forget that the menu was open.  Without it the menubar of
     * the application gets stuck, and it cannot be opened with the keyboard
     * any more.
     *
     * The id of an item is not stable: the application renumbers its model
     * every time it rebuilds it, and filling a menu is a rebuild.  So the
     * menu is looked up again by its path, and the event is sent to the id
     * it has now.
     *
     * There is no difference between a top-level menu and a menu inside a
     * menu: both are fetched the same way, and the bar asks for the
     * contents of a menu when it is about to show it.
     */
    /*
     * The current contents of a menu.
     *
     * `demand` says whether the application should be asked to build the
     * menu (`opened`).  That makes the application show the menu in its own
     * window, with a grab -- and in some builds the buttons of the title
     * bar of the window do not come back afterwards.  So the application is
     * only asked when it is really needed: when the menu is opened, or when
     * the application has not built it at all.  A pointer that merely rests
     * on a title only reads what the application already has.
     */
    async _fetchMenu(busName, path, node, demand = true) {
        const before = (node.children ?? []).map(child => child.label).join('\u0000');
        log('dbusmenu', `fetch "${node.label}" path=[${node.path.join(' / ')}] ` +
            `object=${busName}${path}: ${node.children?.length ?? 0} items before` +
            `${node.unbuilt ? ' (not fully built)' : ''}`);

        /*
         * The watch.
         *
         * The application says when it rebuilt its model -- that is the
         * `LayoutUpdated` signal -- and the revision of the tree says the
         * same thing.  It does not mean that the *menu* is built: the
         * application rebuilds its model whenever it builds any menu, so
         * the watch only tells us that the tree is fresh, not that the menu
         * we want is in it.  So the watch does not end the fetch: it only
         * says that the tree below is worth reading again.
         */
        const key = `${busName}|${path}`;
        const known = this._revisions.get(key);
        const signalled = this._changed.has(key);
        const revision = await this._revision(busName, path);
        if (signalled || (known !== undefined && revision !== -1 && revision !== known)) {
            this._changed.delete(key);
            log('dbusmenu', `watch: the model of ${busName}${path} changed` +
                (signalled
                    ? ' (the application said so)'
                    : ` (revision ${known} -> ${revision})`));
        }

        const id = await this._findId(busName, path, node);
        if (id === null) {
            log('dbusmenu', `fetch "${node.label}": item not found any more`);
            return node.children;
        }
        log('dbusmenu', `fetch "${node.label}": current id=${id}` +
            (id !== node.id ? ` (was ${node.id}, renumbered)` : ''));

        /*
         * What does the application have right now?
         *
         * If it is what it built for us the last time, there is nothing to
         * do: the application does not have to build anything, and it does
         * not show a menu in its own window.  That case matters, because
         * every build the application does is one that can cost the buttons
         * of its title bar.
         *
         * The reference is what the application *built*, not what was read
         * last: the application keeps a menu it has built (the items are
         * still there), while a read of the tree gives the version of the
         * markup -- which is the short one, without the parts the
         * application fills itself.
         */
        const current = await this._readItem(busName, path, node.path);
        const raw = current?.children ?? [];
        const children = raw
            .map(child => this._buildNode(child, busName, path, current.id,
                [...node.path, child.props?.label ?? '']))
            .filter(child => child !== null);
        const after = children.map(child => child.label).join('\u0000');

        const menuKey = node.path?.join('/') ?? node.label;
        const built = this._built.get(menuKey);
        if (built !== undefined && after === built) {
            log('dbusmenu', `fetch "${node.label}": the application still has the ` +
                `${children.length} items it built, nothing to build`);
            node.children = children;
            node.unbuilt = false;
            return children;
        }

        if (!demand || !demandAllowed()) {
            log('dbusmenu', `fetch "${node.label}": the application is not asked to ` +
                `build the menu (${demand ? 'the switch is off' : 'only reading'})`);
            node.children = children;
            node.unbuilt = false;
            return children;
        }

        this._openedAt = GLib.get_monotonic_time();

        /*
         * The demand: the application is asked to build the menu, and it
         * shows it in its own window, with a grab.  In some builds the
         * buttons of the title bar of that window do not come back
         * afterwards, so this is done as rarely as possible.
         */
        this._sendEvent(busName, path, id, 'opened');
        // remember it: the application has to be told to close it again
        const openKey = `${busName}|${path}`;
        if (!this._opened.has(openKey))
            this._opened.set(openKey, new Set());
        this._opened.get(openKey).add(id);

        try {
            /*
             * The application builds the menu while it handles the `opened`
             * event -- but it does not finish before the call returns: the
             * build takes about 130ms (measured), and the call comes back
             * after 14ms.  Reading right after the call is therefore too
             * early, and the menu would be half built.
             *
             * The application says when it did something: the model is
             * rebuilt, and that is the `LayoutUpdated` signal.  So we wait
             * for that signal -- but not longer than half a second.
             *
             * There is no way to tell from the export whether a menu still
             * has to be built: the parts that the application fills itself
             * are simply *absent* from the export, without a marker (the
             * history list of Firefox is the case: the export has seven
             * items where the menu has twenty-five).  So the wait is always
             * done after a build.
             */
            const built = await this._waitForBuild(busName, path, BUILD_TIMEOUT_MS);
            log('dbusmenu', `fetch "${node.label}": ` +
                (built
                    ? 'the application says it rebuilt its model'
                    : `no build signal within ${BUILD_TIMEOUT_MS}ms, reading anyway`));

            /*
             * And the tree is looked at again a few times: the signal
             * comes when the model was rebuilt, but the menu of the
             * application can take a while after that (the places popup of
             * Firefox reads its history from the disk).
             */
            for (const wait of [0, 100, 200, 400]) {
                if (wait)
                    await sleep(wait);

                const current = await this._readItem(busName, path, node.path);
                const raw = current?.children ?? [];
                log('dbusmenu', `fetch "${node.label}": item id=${current?.id ?? 'gone'}, ` +
                    `${raw.length} raw children` +
                    (raw.length
                        ? ` [${raw.map(child => child.props?.label ?? '<separator>').join(', ')}]`
                        : ''));

                if (!raw.length) {
                    if (wait >= 200)
                        break;
                    continue;
                }

                const children = raw
                    .map(child => this._buildNode(child, busName, path, current.id,
                        [...node.path, child.props?.label ?? '']))
                    .filter(child => child !== null);

                const after = children.map(child => child.label).join('\u0000');
                if (after === before && wait < 400) {
                    log('dbusmenu', `fetch "${node.label}": still the same ` +
                        `(${children.length} items), waiting`);
                    continue;
                }

                node.children = children;
                node.unbuilt = false;

                // what the application has built for this menu: the next
                // look can tell that it is still there
                this._built.set(menuKey, after);

                if (after === before) {
                    log('dbusmenu', `fetch "${node.label}": unchanged (${children.length} items)`);
                } else {
                    log('dbusmenu', `fetch "${node.label}": ${before.split('\u0000').length} -> ` +
                        `${children.length} items ` +
                        `[${children.map(child => child.label || '<sep>').join(', ')}]`);
                }
                return children;
            }

            log('dbusmenu', `fetch "${node.label}": the application did not fill the menu`);
            return node.children;
        } finally {
            /*
             * Give the grab back to the application.
             *
             * The id the menu was opened with is not necessarily the id it
             * has now: showing a menu rebuilds the model of the
             * application, and that renumbers every id in it.  The
             * application remembers the open menu under the id it was
             * opened with, so closing only the new id leaves the menu open
             * in the application -- and an open menu in the application
             * covers the title bar of its window, so the window buttons
             * disappear.
             *
             * So both ids are closed: the one it was opened with, and the
             * one it has now.  An id the application does not know is
             * ignored.
             */
            const current = await this._findId(busName, path, node);
            const ids = [...new Set([id, current].filter(value => value !== null))];
            for (const closeId of ids) {
                log('dbusmenu', `fetch "${node.label}": closing id=${closeId}`);
                this._sendEvent(busName, path, closeId, 'closed');
            }
            this._opened.get(`${busName}|${path}`)?.delete(id);
            this._opened.get(`${busName}|${path}`)?.delete(current);

        }
    }

    /*
     * The id the item has now.
     *
     * The application renumbers its model when it rebuilds it, so the id
     * that was read a moment ago can be stale.  The item is looked up
     * again by its path in the tree.
     */
    async _findId(busName, path, node) {
        const pathTo = node.path ?? [];
        if (!pathTo.length)
            return node.id;

        const item = await this._readItem(busName, path, pathTo);
        log('dbusmenu', `findId [${pathTo.join(' / ')}]: ` +
            (item ? `id=${item.id}` : 'not found'));
        return item?.id ?? node.id;
    }

    /* the item at a path in the tree, read from the server */
    _readItem(busName, path, pathTo) {
        return this._readPath(busName, path, pathTo).then(found => found.item);
    }

    /*
     * The item at a path in the tree and the menu it is in, read with one
     * call: the menu is the parent of the item, and its id is what the
     * AboutToShow needs.
     */
    _readPath(busName, path, pathTo) {
        return new Promise(resolve => {
            const started = GLib.get_monotonic_time();
            this._conn.call(busName, path, DBUSMENU_IFACE, 'GetLayout',
                new GLib.Variant('(iias)', [0, -1, []]),
                new GLib.VariantType('(u(ia{sv}av))'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (source, result) => {
                    const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                    try {
                        const reply = source.call_finish(result);
                        // the revision of the model, for the watch
                        this._revisions.set(`${busName}${path}`,
                            reply.get_child_value(0).unpack());
                        const root = this._parseItem(reply.get_child_value(1));
                        const found = this._itemAndParent(root, pathTo);
                        log('dbusmenu', `readPath [${pathTo.join(' / ')}]: ` +
                            (found.item
                                ? `id=${found.item.id}, menu id=${found.parent?.id ?? 0}, ` +
                                  `${found.item.children?.length ?? 0} raw children ` +
                                  `in ${elapsed.toFixed(1)}ms`
                                : `not found in ${elapsed.toFixed(1)}ms`));
                        resolve(found);
                    } catch (e) {
                        log('dbusmenu', `readPath [${pathTo.join(' / ')}] failed after ` +
                            `${elapsed.toFixed(1)}ms: ${e.message}`);
                        resolve({item: null, parent: null});
                    }
                });
        });
    }

    _itemAtPath(root, pathTo) {
        return this._itemAndParent(root, pathTo).item;
    }

    /* the item at a path, and the item it is in */
    _itemAndParent(root, pathTo) {
        let item = root;
        let parent = null;
        for (const label of pathTo) {
            const children = item.children ?? [];
            const next = children.find(c => c.props.label === label);
            if (!next) {
                log('dbusmenu', `path [${pathTo.join(' / ')}]: "${label}" is not among ` +
                    `the ${children.length} children ` +
                    `[${children.map(c => c.props?.label ?? '<placeholder>').join(', ')}]`);
                return {item: null, parent: null};
            }
            parent = item;
            item = next;
        }
        return {item, parent};
    }

    /* the "opened" and "closed" events of a menu */
    _sendEvent(busName, path, id, name) {
        log('dbusmenu', `Event(${name}) id=${id} ${busName}${path}`);
        this._conn.call(busName, path, DBUSMENU_IFACE, 'Event',
            new GLib.Variant('(isvu)', [id, name, new GLib.Variant('s', ''), 0]),
            null, Gio.DBusCallFlags.NONE, 2000, null, (source, result) => {
                try {
                    source.call_finish(result);
                    log('dbusmenu', `Event(${name}) id=${id} acknowledged`);
                } catch (e) {
                    log('dbusmenu', `could not send "${name}" for ${id}: ${e.message}`);
                }
            });
    }

    /* the children of a menu, read from the server */
    _readChildren(busName, path, id) {
        return new Promise(resolve => {
            const started = GLib.get_monotonic_time();
            this._conn.call(busName, path, DBUSMENU_IFACE, 'GetLayout',
                new GLib.Variant('(iias)', [id, 1, []]),
                new GLib.VariantType('(u(ia{sv}av))'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (source, result) => {
                    const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                    try {
                        const reply = source.call_finish(result);
                        const layout = reply.get_child_value(1);
                        const item = this._parseItem(layout);
                        const children = (item.children ?? [])
                            .map(child => this._buildNode(child, busName, path, id, []))
                            .filter(child => child !== null);
                        log('dbusmenu', `readChildren of ${id}: ${children.length} items ` +
                            `in ${elapsed.toFixed(1)}ms ` +
                            `[${children.map(c => c.label || '<sep>').join(', ')}]`);
                        resolve(children);
                    } catch (e) {
                        log('dbusmenu', `readChildren of ${id} failed after ` +
                            `${elapsed.toFixed(1)}ms: ${e.message}`);
                        resolve(null);
                    }
                });
        });
    }

    _formatShortcut(shortcut) {        if (!Array.isArray(shortcut) || !shortcut.length)
            return null;
        return shortcut
            .map(chord => (Array.isArray(chord) ? chord.join('+') : String(chord)))
            .filter(part => part && part !== 'undefined')
            .join(', ');
    }

    async _activate(busName, path, node) {
        /*
         * The click.
         *
         * The ids of the application are not stable: it renumbers its model
         * when it rebuilds it, and it rebuilds it whenever a menu is filled.
         * An id that was read a moment ago can be unknown by the time the
         * user clicks, and the application answers "The ID supplied does not
         * refer to a menu item we have" -- and nothing happens at all.  So
         * the item is looked up again by its path, and so is the menu it is
         * in, whose id the AboutToShow needs.
         */
        const wanted = node.path ?? [];
        const found = await this._readPath(busName, path, wanted);
        if (!found.item) {
            log('dbusmenu', `activate "${node.label}": the item is not in the tree any more`);
            return;
        }
        log('dbusmenu', `activate "${node.label}": id=${found.item.id}` +
            (found.item.id !== node.id ? ` (was ${node.id}, renumbered)` : ''));

        /*
         * `AboutToShow` tells the application that the menu of the item is
         * about to be shown, so that it builds it -- an application that
         * builds its menus when they are opened needs that, or the item is
         * not there yet.  The id of the *menu* is meant, not the id of the
         * item.
         */
        const menuId = found.parent?.id ?? 0;
        if (menuId) {
            log('dbusmenu', `AboutToShow menu id=${menuId} (for item ${found.item.id})`);
            try {
                await new Promise(resolve => {
                    this._conn.call(busName, path, DBUSMENU_IFACE, 'AboutToShow',
                        new GLib.Variant('(i)', [menuId]), null,
                        Gio.DBusCallFlags.NONE, 1000, null, (source, result) => {
                            try {
                                source.call_finish(result);
                                log('dbusmenu', `AboutToShow menu id=${menuId} acknowledged`);
                            } catch (e) {
                                log('dbusmenu', `AboutToShow menu id=${menuId} failed: ` +
                                    `${e.message}`);
                            }
                            resolve();
                        });
                });
            } catch (e) {
                log('dbusmenu', `AboutToShow failed: ${e.message}`);
            }
        } else {
            log('dbusmenu', `no menu id known for item ${found.item.id}, no AboutToShow`);
        }

        /*
         * Showing the menu of the item may make the application build it,
         * and building it renumbers the model -- so the item is looked up
         * once more, and the fresh id is the one that is clicked.
         */
        const fresh = await this._readPath(busName, path, wanted);
        const id = fresh.item?.id ?? found.item.id;
        if (fresh.item && fresh.item.id !== found.item.id)
            log('dbusmenu', `activate "${node.label}": the id changed to ${fresh.item.id} ` +
                'while the menu was shown');

        log('dbusmenu', `Event(clicked) id=${id} ${busName}${path}`);
        this._conn.call(busName, path, DBUSMENU_IFACE, 'Event',
            new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('s', ''), 0]),
            null, Gio.DBusCallFlags.NONE, 2000, null, (source, result) => {
                try {
                    source.call_finish(result);
                    log('dbusmenu', `clicked id=${id} acknowledged`);
                } catch (e) {
                    log('dbusmenu', `could not activate ${id}: ${e.message}`);
                }
            });
    }
}
