/* Resolve the name an application wants to be called.
 *
 * The window's WM class is an implementation detail ("OpenTabletDriver.UX",
 * "firefox", "Navigator"); the name the application wants to be called is
 * the `Name` of its desktop entry ("OpenTabletDriver", "Firefox").
 *
 * So we index the desktop entries by their StartupWMClass / Exec binary and
 * ask GIO for the (localised) display name.
 *
 * Several entries can claim the same class, and then the name of the
 * window decides.  A Chromium web app, for example, is a desktop entry
 * whose Exec line starts the browser:
 *
 *   Exec=/usr/bin/chromium --profile-directory=Default --app-id=dnfpo… %U
 *
 * The binary of that line is "chromium", which is also the class of every
 * ordinary Chromium window -- so the web app took the name of the browser
 * (or the other way round, depending on the order the files are read in).
 * The entry that starts the program itself is therefore preferred over the
 * ones that run something inside another program, and the title of the
 * window breaks the remaining ties.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {log} from '../debug.js';

// Gio.DesktopAppInfo moved to a separate library in newer GLib; touching
// the old one at all triggers a deprecation warning, so only fall back to it
let DesktopAppInfo = null;
try {
    const GioUnix = (await import('gi://GioUnix')).default;
    DesktopAppInfo = GioUnix?.DesktopAppInfo ?? null;
} catch (e) {
    // older GLib, no GioUnix
}
if (!DesktopAppInfo)
    DesktopAppInfo = Gio.DesktopAppInfo;

/* the field codes a desktop entry may use */
const FIELD_CODES = ['%U', '%u', '%F', '%f', '%i', '%c', '%k', '%d', '%D', '%n', '%N', '%v', '%m'];

export class AppNames {
    constructor() {
        this._byClass = new Map();    // lowercase wm class -> [desktop id]
        this._byBinary = new Map();   // lowercase exec binary -> [desktop id]
        this._execs = new Map();      // desktop id -> the exec line
        this._scanned = false;
    }

    _scan() {
        if (this._scanned)
            return;
        this._scanned = true;

        const dirs = [`${GLib.get_home_dir()}/.local/share/applications`];
        const dataDirs = GLib.getenv('XDG_DATA_DIRS');
        for (const dir of (dataDirs || '/usr/local/share:/usr/share').split(':')) {
            if (dir)
                dirs.push(`${dir}/applications`);
        }

        for (const dir of dirs) {
            let files;
            try {
                const enumerator = Gio.File.new_for_path(dir).enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
                files = [];
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    if (info.get_name().endsWith('.desktop'))
                        files.push(info.get_name());
                }
            } catch (e) {
                log('appnames', `${dir} cannot be read: ${e.message}`);
                continue;
            }

            for (const name of files) {
                try {
                    this._indexFile(`${dir}/${name}`);
                } catch (e) {
                    log('appnames', `${name} cannot be read: ${e.message}`);
                }
            }
        }

        log('appnames', `${this._byClass.size} classes and ${this._byBinary.size} binaries ` +
            `are known from ${dirs.length} directories`);
    }

    _indexFile(path) {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return;

        const id = path.split('/').pop();
        const text = new TextDecoder().decode(contents);
        let wmClass = null;
        let gnomeWmClass = null;
        let exec = null;
        let inEntry = false;

        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('[')) {
                inEntry = line === '[Desktop Entry]';
                continue;
            }
            if (!inEntry)
                continue;
            if (line.startsWith('StartupWMClass='))
                wmClass = line.slice('StartupWMClass='.length).trim();
            else if (line.startsWith('X-GNOME-WMClass='))
                gnomeWmClass = line.slice('X-GNOME-WMClass='.length).trim();
            else if (line.startsWith('Exec='))
                exec = line.slice('Exec='.length).trim();
        }

        this._execs.set(id, exec ?? '');

        // the class of the application, the strong mark
        for (const key of [wmClass, gnomeWmClass]) {
            if (!key)
                continue;
            const lower = key.toLowerCase();
            if (!this._byClass.has(lower))
                this._byClass.set(lower, []);
            if (!this._byClass.get(lower).includes(id))
                this._byClass.get(lower).push(id);
        }

        // the binary of the Exec line, the weak mark: it is the class of the
        // program that is started, which for a web app is the browser
        if (exec) {
            const binary = exec.split(' ')[0].split('/').pop();
            if (binary) {
                const lower = binary.toLowerCase();
                if (!this._byBinary.has(lower))
                    this._byBinary.set(lower, []);
                if (!this._byBinary.get(lower).includes(id))
                    this._byBinary.get(lower).push(id);
            }
        }
    }

    _nameOf(id) {
        try {
            return DesktopAppInfo.new(id)?.get_display_name() ?? null;
        } catch (e) {
            return null;
        }
    }

    /*
     * Does the entry start the program itself, or does it run something
     * inside another program?  A web app starts the browser with
     * "--app-id=…", and that is not the class of the browser.
     */
    _startsItself(id) {
        const exec = this._execs.get(id) ?? '';
        const parts = exec.split(' ').filter(part => part && part !== '%U');
        return parts.length <= 1 || parts.every(part => FIELD_CODES.includes(part));
    }

    /*
     * The entry that speaks for the class.
     *
     * The title of the window has the last word: a web app shows its own
     * name in the title, and a plain window of the browser does not.
     */
    _pick(candidates, title) {
        if (candidates.length === 1)
            return candidates[0];

        if (title) {
            const lower = title.toLowerCase();
            // the name that comes first in the title is the name of the
            // application: a web app shows its own name, and the browser
            // puts its own name at the end ("Photopea - Chromium")
            const hits = candidates
                .map(id => ({id, name: this._nameOf(id)}))
                .filter(entry => entry.name && lower.includes(entry.name.toLowerCase()))
                .sort((a, b) =>
                    lower.indexOf(a.name.toLowerCase()) - lower.indexOf(b.name.toLowerCase()));

            if (hits.length) {
                log('appnames', `the title "${title}" decides: ${hits[0].id} ` +
                    `(${hits.map(hit => hit.name).join(', ')})`);
                return hits[0].id;
            }
        }

        const plain = candidates.filter(id => this._startsItself(id));
        if (plain.length === 1) {
            log('appnames', `${plain[0]} starts the program itself, the others do not`);
            return plain[0];
        }

        return candidates[0];
    }

    /**
     * @param {string} appId the GApplication id, if any
     * @param {string} wmClass the window's WM class, if any
     * @param {string} title the window's title, if any
     * @returns {string|null} the localised application name
     */
    lookup(appId, wmClass, title) {
        this._scan();

        // the GApplication id usually is the desktop file id
        if (appId) {
            const info = DesktopAppInfo.new(`${appId}.desktop`);
            const name = info?.get_display_name();
            if (name) {
                log('appnames', `${appId} -> "${name}" (the application id)`);
                return name;
            }
            log('appnames', `${appId}.desktop has no display name`);
        }

        if (wmClass) {
            const lower = wmClass.toLowerCase();

            const strong = this._byClass.get(lower);
            if (strong?.length) {
                const id = this._pick(strong, title);
                const name = this._nameOf(id);
                if (name) {
                    log('appnames', `${wmClass} -> ${id} -> "${name}" ` +
                        `(the window class, ${strong.length} entries claim it)`);
                    return name;
                }
            }

            const weak = this._byBinary.get(lower);
            if (weak?.length) {
                const id = this._pick(weak, title);
                const name = this._nameOf(id);
                if (name) {
                    log('appnames', `${wmClass} -> ${id} -> "${name}" ` +
                        `(the program binary, ${weak.length} entries claim it: ` +
                        `${weak.map(other => this._nameOf(other) ?? other).join(', ')})`);
                    return name;
                }
            }

            if (!strong?.length && !weak?.length)
                log('appnames', `${wmClass} is not in the index ` +
                    `(${this._byClass.size} classes are known)`);
        }

        log('appnames', `no name for appId=${appId ?? '-'} wmClass=${wmClass ?? '-'}`);
        return null;
    }
}
