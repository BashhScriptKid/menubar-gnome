/* AT-SPI source — for toolkits that expose a real menubar widget.
 *
 * GTK3/Qt applications publish their menubar as an accessible MENU_BAR object
 * with MENU children and MENU_ITEM leaves, each leaf carrying a "click"
 * action.  This is the only substrate that works for apps that export nothing
 * over D-Bus (OTD, and anything else GTK3-ish).
 *
 * The reading itself happens in helpers/atspi-helper.js, in a process of its
 * own.  libatspi's calls are synchronous and have no timeout: walking the
 * accessibility tree of an application that does not answer (a browser that
 * has just started, a toolkit whose bridge is not up yet) blocked this
 * thread until the D-Bus default timeout, and once froze the whole desktop
 * for 16 seconds.  An out-of-process reader can be killed when it takes too
 * long, and the compositor never waits for it.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {log, dumpTree} from '../debug.js';

const HELPER_TIMEOUT_MS = 1000;      // reading the titles or the menus
const ACTIVATE_TIMEOUT_MS = 2000;    // clicking one item
const TITLES_TTL_MS = 8000;          // the structure check runs every 3s
const NO_MENUS_RETRY_MS = 30000;     // believe "no usable menus" for a while
const NO_APP_RETRY_MS = 10000;       // an app may bring its bridge up later
const MAX_HELPERS = 6;

const [SOURCE_FILE] = GLib.filename_from_uri(import.meta.url);
const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(SOURCE_FILE), '..', 'helpers', 'atspi-helper.js',
]);

export class AtspiSource {
    constructor() {
        this._gjs = GLib.find_program_in_path('gjs');
        this._running = new Set();      // helpers that are still alive
        this._titleCache = new Map();   // "pid:window" -> {titles, at}
        this._noMenubar = new Map();    // "pid:window" -> at, no menubar at all
        this._titlesOnly = new Map();   // "pid:window" -> at, titles but no items
        this._noApp = new Map();        // "pid:window" -> at, app is not on the bus
        this._changed = new Set();      // pid -> the application changed its tree
    }

    get name() {
        return 'at-spi';
    }

    /*
     * The application changed its tree.
     *
     * The accessibility bus sends the events of the tree to the clients
     * that registered for them (see `sources/fakeat.js`), and this is the
     * counterpart of the `LayoutUpdated` signal of dbusmenu: what the bar
     * has read is not what the application has any more.  The next time a
     * menu of that application is shown, it is read again.
     */
    noteChanged(pid) {
        if (!pid)
            return;
        this._changed.add(pid);
    }

    start() {}

    stop() {
        for (const proc of this._running) {
            try {
                proc.force_exit();
            } catch (e) {
                // it may have exited already
            }
        }
        this._running.clear();
        this._titleCache.clear();
        this._noMenubar.clear();
        this._titlesOnly.clear();
        this._noApp.clear();
    }

    _key(descriptor) {
        return `${descriptor.pid}:${descriptor.windowKey ?? ''}`;
    }

    /*
     * Run the helper and give back its JSON answer, or null when it did not
     * answer in time.  A helper that hangs is killed: that is the whole
     * point of the process.
     */
    _run(kind, descriptor, path, timeout) {
        if (!this._gjs) {
            log('atspi', `${kind}: gjs is not in PATH, the helper cannot run`);
            return Promise.resolve(null);
        }
        if (this._running.size >= MAX_HELPERS) {
            log('atspi', `${kind}: ${this._running.size} helpers are running, skipped`);
            return Promise.resolve(null);
        }

        const argv = [
            this._gjs, '-m', HELPER, kind, String(descriptor.pid),
            descriptor.title ?? '', path ? JSON.stringify(path) : '',
        ];
        log('atspi', `${kind}: helper for pid ${descriptor.pid} ` +
            `"${descriptor.title ?? ''}"${path ? ` path=${JSON.stringify(path)}` : ''}`);

        return new Promise(resolve => {
            let done = false;
            let timer = 0;
            let proc = null;

            const finish = (value, note) => {
                if (done)
                    return;
                done = true;
                if (timer)
                    GLib.source_remove(timer);
                if (proc)
                    this._running.delete(proc);
                if (note)
                    log('atspi', `${kind}: ${note}`);
                if (value && typeof value === 'object')
                    log('atspi', `${kind}: answer ${JSON.stringify(value).slice(0, 300)}`);
                resolve(value);
            };

            try {
                proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                log('atspi', `${kind}: could not start the helper: ${e.message}`);
                resolve(null);
                return;
            }
            this._running.add(proc);

            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                log('atspi', `${kind}: no answer in ${timeout}ms, killing the helper`);
                try {
                    proc.force_exit();
                } catch (e) {
                    // it may have exited already
                }
                finish(null);
                return GLib.SOURCE_REMOVE;
            });

            proc.communicate_utf8_async(null, null, (p, result) => {
                let out = '';
                let err = '';
                try {
                    [, out, err] = p.communicate_utf8_finish(result);
                } catch (e) {
                    finish(null, `the helper failed: ${e.message}`);
                    return;
                }

                // the helper traces every step on stderr
                for (const line of (err ?? '').split('\n')) {
                    if (line.trim())
                        log('atspi', `helper: ${line.trim()}`);
                }

                let reply = null;
                try {
                    reply = JSON.parse((out ?? '').trim());
                } catch (e) {
                    finish(null, `unreadable answer: ${JSON.stringify((out ?? '').slice(0, 120))}`);
                    return;
                }
                finish(reply);
            });
        });
    }

    /*
     * The titles of the menubar, without reading the menus themselves.  Used
     * to notice that an application changed its menubar (Firefox adds a
     * "Profiles" menu when a profile manager shows up).  Cached for a few
     * seconds, because the structure check runs every three.
     */
    async getTitles(descriptor) {
        if (!descriptor?.pid || descriptor.pid <= 0)
            return null;

        const key = this._key(descriptor);
        const cached = this._titleCache.get(key);
        if (cached && GLib.get_monotonic_time() - cached.at < TITLES_TTL_MS * 1000)
            return cached.titles;

        const skipped = this._noMenubar.get(key);
        if (skipped && GLib.get_monotonic_time() - skipped < NO_MENUS_RETRY_MS * 1000) {
            log('atspi', `getTitles: ${descriptor.pid} had no menubar, not looking again yet`);
            return null;
        }

        const noApp = this._noApp.get(key);
        if (noApp && GLib.get_monotonic_time() - noApp < NO_APP_RETRY_MS * 1000) {
            log('atspi', `getTitles: ${descriptor.pid} has no accessibility app, not looking again yet`);
            return null;
        }

        const reply = await this._run('titles', descriptor, null, HELPER_TIMEOUT_MS);
        if (!reply) {
            log('atspi', `getTitles: no answer for pid ${descriptor.pid}`);
            return null;
        }
        if (!reply.ok) {
            if (reply.reason === 'no-app') {
                log('atspi', `getTitles: no app object for pid ${descriptor.pid}`);
                this._noApp.set(key, GLib.get_monotonic_time());
            } else if (reply.reason === 'no-menubar') {
                log('atspi', `getTitles: no menubar for pid ${descriptor.pid}`);
                this._noMenubar.set(key, GLib.get_monotonic_time());
            } else {
                log('atspi', `getTitles: ${reply.reason}` +
                    `${reply.error ? `: ${reply.error}` : ''}`);
            }
            return null;
        }

        const titles = reply.titles ?? [];
        this._titleCache.set(key, {titles, at: GLib.get_monotonic_time()});
        log('atspi', `getTitles: [${titles.join(', ')}]`);
        return titles;
    }

    async getMenus(descriptor) {
        if (!descriptor?.pid || descriptor.pid <= 0)
            return null;

        const key = this._key(descriptor);
        const now = GLib.get_monotonic_time();
        for (const [map, ttl, what] of [
            [this._noMenubar, NO_MENUS_RETRY_MS, 'no menubar'],
            [this._titlesOnly, NO_MENUS_RETRY_MS, 'titles only'],
            [this._noApp, NO_APP_RETRY_MS, 'no accessibility app'],
        ]) {
            const skipped = map.get(key);
            if (skipped && now - skipped < ttl * 1000) {
                log('atspi', `getMenus: ${descriptor.pid} had ${what}, not looking again yet`);
                return null;
            }
        }

        const started = GLib.get_monotonic_time();
        const reply = await this._run('menus', descriptor, null, HELPER_TIMEOUT_MS);
        const elapsed = ((GLib.get_monotonic_time() - started) / 1000).toFixed(0);

        if (!reply) {
            log('atspi', `getMenus: no answer for pid ${descriptor.pid} in ${elapsed}ms`);
            return null;
        }

        if (!reply.ok) {
            if (reply.reason === 'titles-only') {
                log('atspi', `getMenus: NOT READY (titles only) in ${elapsed}ms:`,
                    `[${(reply.titles ?? []).join(', ')}]`);
                this._titlesOnly.set(key, GLib.get_monotonic_time());
            } else if (reply.reason === 'no-menubar') {
                log('atspi', `getMenus: no menubar for pid ${descriptor.pid} in ${elapsed}ms`);
                this._noMenubar.set(key, GLib.get_monotonic_time());
            } else if (reply.reason === 'no-app') {
                log('atspi', `getMenus: no app object for pid ${descriptor.pid} in ${elapsed}ms`);
                this._noApp.set(key, GLib.get_monotonic_time());
            } else {
                log('atspi', `getMenus: ${reply.reason} for pid ${descriptor.pid} in ${elapsed}ms` +
                    `${reply.error ? `: ${reply.error}` : ''}`);
            }
            return null;
        }

        const nodes = reply.menus ?? [];
        if (!nodes.length) {
            log('atspi', 'getMenus: the menubar has no children');
            return null;
        }

        // the whole tree is read now, so it is what the application has
        this._changed.delete(pid);

        log('atspi', `getMenus: READY, ${nodes.length} menus in ${elapsed}ms`);
        dumpTree('atspi', nodes, 'AT-SPI menubar');

        // every node carries the context it was read for, so that data of
        // one window can never be shown or activated for another one
        this._tag(nodes, descriptor.context ?? key);
        this._wireActivate(nodes, descriptor);
        this._wireFetch(nodes, descriptor, 0);

        return nodes;
    }

    /*
     * Every menu can be read again.
     *
     * The tree of an application changes while it is running: it loads its
     * data (OpenTabletDriver fills its presets a moment after its window
     * appears, and until then its menu says "No presets loaded"), and the
     * tree of the bar is a snapshot of that moment.  So a menu is read
     * again when it is about to be shown -- the same way the dbusmenu
     * source does it.
     */
    _wireFetch(nodes, descriptor, depth) {
        for (const node of nodes) {
            /*
             * Only the menus *inside* the menubar are fetched again: the
             * items of the menubar itself are the structure of the
             * application and do not change, while the items of a popup do
             * (OpenTabletDriver fills its presets a moment after its window
             * appears, and until then its menu says "No presets loaded").
             */
            if (node.type === 'submenu' && depth > 0) {
                // the path of child indices the node was read at: the helper
                // walks the same path down from the menubar again
                const nodePath = node.path?.length ? node.path : [];

                node.fetch = async () => {
                    const children = await this._fetchSubmenu(descriptor, nodePath);
                    if (children?.length)
                        node.children = children;
                    return node.children;
                };
            }

            if (node.children?.length)
                this._wireFetch(node.children, descriptor, depth + 1);
        }
    }

    /* the items of one menu, read again */
    async _fetchSubmenu(descriptor, path) {
        const pid = descriptor.pid;

        /*
         * The watch: if the application has not changed its tree since we
         * read it, what we have is what it has -- and no helper has to be
         * started at all.
         */
        if (!this._changed.has(pid)) {
            log('atspi', `fetch [${path.join('.')}]: the tree of ${pid} has not changed, ` +
                'nothing to read again');
            return null;
        }

        const started = GLib.get_monotonic_time();
        const reply = await this._run('submenu', descriptor, path, HELPER_TIMEOUT_MS);
        const elapsed = ((GLib.get_monotonic_time() - started) / 1000).toFixed(0);

        if (!reply?.ok) {
            log('atspi', `fetch [${path.join('.')}]: ${reply?.reason ?? 'no answer'} ` +
                `in ${elapsed}ms`);
            return null;
        }

        const children = reply.children ?? [];
        log('atspi', `fetch [${path.join('.')}]: ${children.length} items in ${elapsed}ms`);
        this._tag(children, descriptor.context ?? this._key(descriptor));
        this._wireActivate(children, descriptor);
        this._wireFetch(children, descriptor, path.length);
        return children;
    }

    /*
     * Activation goes through the helper as well: the node carries the child
     * indices it was read at, and the helper walks that path down from the
     * menubar again.  An accessible reference cannot be kept in the shell --
     * the application may replace its objects -- and doing the walk here
     * would put a synchronous call back on the compositor's thread.
     */
    _wireActivate(nodes, descriptor) {
        for (const node of nodes) {
            if (node.children?.length)
                this._wireActivate(node.children, descriptor);
            if (node.type === 'separator')
                continue;
            node.activate = () => this._activate(node.path, descriptor);
        }
    }

    async _activate(path, descriptor) {
        log('atspi', `activating ${JSON.stringify(path)} in "${descriptor.title}"`);
        const reply = await this._run('activate', descriptor, path, ACTIVATE_TIMEOUT_MS);
        if (!reply) {
            log('atspi', `could not activate ${JSON.stringify(path)}: no answer`);
            return;
        }
        if (!reply.ok) {
            log('atspi', `could not activate ${JSON.stringify(path)}: ${reply.reason}` +
                `${reply.error ? `: ${reply.error}` : ''}`);
            return;
        }
        log('atspi', `activated ${JSON.stringify(path)}`);
    }

    _tag(nodes, context) {
        for (const node of nodes) {
            node.context = context;
            if (node.children?.length)
                this._tag(node.children, context);
        }
    }
}
