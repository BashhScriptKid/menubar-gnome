/* org.gtk.Actions source — for GTK4 / libadwaita applications.
 *
 * libadwaita apps have no menubar at all (their menus live in the header
 * bar), but they do publish their GAction groups over D-Bus:
 *
 *   /<app-id>              -> application actions
 *   /<app-id>/window/<n>   -> window actions
 *
 * Unlike the dbusmenu source there is no menu *structure* and no *labels*:
 * only action names ("new-event"), an enabled flag and a parameter
 * signature.  So the menu we present is synthesised: actions are bucketed
 * into File/Edit/View/Window/Help and the labels are derived from the action
 * name.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {log} from '../debug.js';

const ACTIONS_IFACE = 'org.gtk.Actions';

/* name -> [group, label] ; unknown actions fall into the default group */
const ACTION_MAP = {
    'new-window': ['File', 'New Window'],
    'new-tab': ['File', 'New Tab'],
    'new-private-window': ['File', 'New Private Window'],
    'new-incognito': ['File', 'New Incognito Window'],
    'new-event': ['File', 'New Event'],
    'new-document': ['File', 'New Document'],
    'open': ['File', 'Open…'],
    'open-file': ['File', 'Open File…'],
    'open-location': ['File', 'Open Location…'],
    'save': ['File', 'Save'],
    'save-as': ['File', 'Save As…'],
    'print': ['File', 'Print…'],
    'import': ['File', 'Import…'],
    'export': ['File', 'Export…'],
    'quit': ['File', 'Quit'],
    'close': ['File', 'Close Window'],
    'close-tab': ['File', 'Close Tab'],
    'preferences': ['File', 'Preferences'],
    'about': ['Help', 'About'],
    'help': ['Help', 'Help'],
    'shortcuts': ['Help', 'Keyboard Shortcuts'],
    'undo': ['Edit', 'Undo'],
    'redo': ['Edit', 'Redo'],
    'cut': ['Edit', 'Cut'],
    'copy': ['Edit', 'Copy'],
    'paste': ['Edit', 'Paste'],
    'delete': ['Edit', 'Delete'],
    'select-all': ['Edit', 'Select All'],
    'find': ['Edit', 'Find…'],
    'find-next': ['Edit', 'Find Next'],
    'find-prev': ['Edit', 'Find Previous'],
    'zoom-in': ['View', 'Zoom In'],
    'zoom-out': ['View', 'Zoom Out'],
    'zoom': ['View', 'Zoom'],
    'actual-size': ['View', 'Actual Size'],
    'fullscreen': ['View', 'Full Screen'],
    'toggle-fullscreen': ['View', 'Full Screen'],
    'refresh': ['View', 'Reload'],
    'reload': ['View', 'Reload'],
    'back': ['Go', 'Back'],
    'forward': ['Go', 'Forward'],
    'up': ['Go', 'Up'],
    'down': ['Go', 'Down'],
    'home': ['Go', 'Home'],
    'location': ['Go', 'Location'],
    'search': ['Go', 'Search'],
    'today': ['View', 'Today'],
    'next-date': ['Go', 'Next Date'],
    'previous-date': ['Go', 'Previous Date'],
    'change-view': ['View', 'Change View'],
    'show-calendars': ['View', 'Show Calendars'],
};

const GROUP_ORDER = ['File', 'Edit', 'View', 'Go', 'Window', 'Help'];

export class GtkActionsSource {
    constructor() {
        this._conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    }

    get name() {
        return 'gtk-actions';
    }

    start() {}

    stop() {}

    async getMenus(descriptor) {
        if (!descriptor)
            return null;

        const appId = descriptor.appId;
        if (!appId) {
            log('gtk', 'getMenus: no app id');
            return null;
        }
        log('gtk', `getMenus: appId=${appId}`);

        const groups = new Map();

        // GTK exports the application object at the app id with dots
        // turned into slashes: org.gnome.Calendar -> /org/gnome/Calendar
        const appPath = `/${appId.replace(/\./g, '/')}`;

        const appActions = await this._describeAll(appId, appPath);
        for (const [name, info] of appActions)
            this._add(groups, name, info, appId, appPath);

        // window action groups live under /<app-id>/window/<n>
        for (const path of await this._windowPaths(appId, appPath)) {
            const windowActions = await this._describeAll(appId, path);
            for (const [name, info] of windowActions)
                this._add(groups, name, info, appId, path);
        }

        if (!groups.size) {
            log('gtk', `getMenus: no actions for ${appId}`);
            return null;
        }
        log('gtk', `getMenus: ${groups.size} groups for ${appId}: ` +
            [...groups.entries()].map(([group, actions]) => `${group}=${actions.length}`).join(' '));

        const nodes = [];
        const context = descriptor.context;
        for (const group of GROUP_ORDER) {
            const actions = groups.get(group);
            if (!actions || !actions.length)
                continue;
            nodes.push({
                label: group,
                type: 'submenu',
                enabled: true,
                visible: true,
                shortcut: null,
                context,
                children: actions,
            });
        }

        return nodes.length ? nodes : null;
    }

    _add(groups, name, info, busName, path) {
        const [group, label] = ACTION_MAP[name] ?? ['File', this._humanize(name)];
        if (!groups.has(group))
            groups.set(group, []);

        const actionPath = path;
        groups.get(group).push({
            label,
            type: 'standard',
            enabled: info.enabled !== false,
            visible: true,
            shortcut: null,
            children: [],
            activate: () => this._activate(busName, path, name, info.signature),
        });
    }

    _humanize(name) {
        const words = name.replace(/-/g, ' ').split(' ');
        return words.map((word, index) => {
            if (!word)
                return word;
            const lower = word.toLowerCase();
            if (index === 0 && !['new', 'open', 'save', 'print', 'import', 'export', 'close', 'quit'].includes(lower))
                return word.charAt(0).toUpperCase() + word.slice(1);
            if (['to', 'in', 'out', 'all', 'as', 'next', 'prev'].includes(lower))
                return lower;
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        }).join(' ');
    }

    /*
     * NO_AUTO_START matters: the application id is used as a bus name, and
     * for an application that does not export actions -- a terminal, say --
     * the name is not owned by anything.  Without the flag the bus tries to
     * *start* the service, and the call then sits there until the timeout;
     * that made every update of a non-GTK window take 400ms.
     */
    _describeAll(busName, path) {
        return new Promise(resolve => {
            const started = GLib.get_monotonic_time();
            this._conn.call(busName, path, ACTIONS_IFACE, 'DescribeAll',
                null, new GLib.VariantType('(a{s(bgav)})'),
                Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
                (source, result) => {
                    const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                    try {
                        const reply = source.call_finish(result);
                        const actions = this._readActions(reply.get_child_value(0));
                        log('gtk', `DescribeAll ${busName} ${path}: ${actions.size} actions ` +
                            `in ${elapsed.toFixed(0)}ms` +
                            (actions.size
                                ? ` [${[...actions.keys()].join(', ')}]`
                                : ''));
                        resolve(actions);
                    } catch (e) {
                        log('gtk', `DescribeAll ${busName} ${path} failed after ` +
                            `${elapsed.toFixed(0)}ms: ${e.message}`);
                        resolve([]);
                    }
                });
        });
    }

    /*
     * DescribeAll returns a{s(bgav)}: name -> (enabled, signature, ...).
     * GJS's deepUnpack() hands back an array of entries for dicts whose
     * values are structs, so the dict is walked by hand.
     */
    _readActions(dict) {
        const out = new Map();
        const skipped = [];
        for (let i = 0; i < dict.n_children(); i++) {
            const entry = dict.get_child_value(i);
            let key = null;
            let description = null;
            try {
                key = entry.get_child_value(0).unpack();
                description = entry.get_child_value(1);
            } catch (e) {
                skipped.push(`[${i}]: ${e.message}`);
                continue;
            }
            if (key === null || !description) {
                skipped.push(`[${i}]: no name or no description`);
                continue;
            }
            let enabled = true;
            let signature = '';
            try {
                enabled = description.get_child_value(0).unpack();
                signature = description.get_child_value(1).unpack() ?? '';
            } catch (e) {
                // keep defaults
                skipped.push(`[${i}] ${key}: ${e.message}`);
            }
            out.set(key, {enabled, signature});
        }
        if (skipped.length)
            log('gtk', `${skipped.length} actions could not be read:`, skipped.join(', '));
        return out;
    }

    _windowPaths(appId, appPath) {
        return new Promise(resolve => {
            const started = GLib.get_monotonic_time();
            this._conn.call(appId, `${appPath}/window`, 'org.freedesktop.DBus.Introspectable',
                'Introspect', null, new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
                (source, result) => {
                    const elapsed = (GLib.get_monotonic_time() - started) / 1000;
                    try {
                        const [xml] = source.call_finish(result).deepUnpack();
                        const paths = [];
                        const re = /node name="([^"]+)"/g;
                        let match;
                        while ((match = re.exec(xml)) !== null)
                            paths.push(`${appPath}/window/${match[1]}`);
                        log('gtk', `window paths of ${appId}: ${paths.length} in ` +
                            `${elapsed.toFixed(0)}ms` +
                            (paths.length ? ` [${paths.join(', ')}]` : ' (no window actions)'));
                        resolve(paths);
                    } catch (e) {
                        log('gtk', `the window paths of ${appId} are not there ` +
                            `(${elapsed.toFixed(0)}ms): ${e.message}`);
                        resolve([]);
                    }
                });
        });
    }

    _activate(busName, path, action, signature) {
        let parameter = new GLib.Variant('s', '');
        if (signature) {
            try {
                parameter = new GLib.Variant(signature, this._defaultFor(signature));
            } catch (e) {
                log('gtk', `the parameter of "${action}" (${signature}) could not be built: ` +
                    `${e.message}, sending an empty string`);
                parameter = new GLib.Variant('s', '');
            }
        }
        log('gtk', `Activate "${action}" ${busName} ${path} (signature=${signature || '-'})`);
        this._conn.call(busName, path, ACTIONS_IFACE, 'Activate',
            new GLib.Variant('(sv a{sv})'.replace(' ', ''), [action, parameter, {}]),
            null, Gio.DBusCallFlags.NO_AUTO_START, 2000, null, (source, result) => {
                try {
                    source.call_finish(result);
                    log('gtk', `Activate "${action}" acknowledged`);
                } catch (e) {
                    log('gtk', `Activate "${action}" failed: ${e.message}`);
                }
            });
    }

    _defaultFor(signature) {
        switch (signature) {
        case 'i':
            return 0;
        case 'u':
            return 0;
        case 'b':
            return false;
        case 'd':
            return 0.0;
        default:
            return '';
        }
    }
}
