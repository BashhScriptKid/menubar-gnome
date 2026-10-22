/* Menu Bar — a macOS-style global menu bar for GNOME.
 *
 * Menu data is collected from three sources, in order of quality:
 *
 *   1. dbusmenu      real menubar trees (Chromium, Firefox under XWayland,
 *                    GTK3 apps with appmenu-gtk-module, Qt apps)
 *   2. org.gtk.Actions  action lists from libadwaita apps (no labels, so
 *                    the menu is synthesised)
 *   3. AT-SPI         menubar widgets of GTK3/Qt apps
 *
 * When no source has anything, the bar shows just the application name.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {log} from './debug.js';
import {MenuBar} from './menubar.js';
import {DBusMenuSource} from './sources/dbusmenu.js';
import {GtkActionsSource} from './sources/gtkactions.js';
import {AtspiSource} from './sources/atspi.js';
import {moveClockToRight, restoreClock, dumpPanel} from './sources/clock.js';
import {FakeATClient} from './sources/fakeat.js';
import {AppNames} from './sources/appnames.js';
import {Shots} from './sources/shots.js';
import {ensureTitlebarCss} from './sources/firefoxcss.js';

const UPDATE_DELAY_MS = 60;
const FOCUS_POLL_MS = 150;
const SOURCE_TIMEOUT_MS = 400;
const STRUCTURE_POLL_MS = 3000;
const SOURCE_GRACE_MS = 250;      // how long to wait for a better source
const SOURCE_GRACE_POLL_MS = 25;


/*
 * Whether the accessibility source may be used to read the menus of an
 * application.
 *
 * It is on, because a toolkit that publishes its menubar in the
 * accessibility tree (Qt, GTK3) has the whole tree there -- no menu has to
 * be opened in the application to read it.  What the source must not do is
 * open a menu in the application, which is what
 * `OPEN_MENUS_IN_APPLICATION` in the source is about.
 *
 * An application that exports its menus over dbusmenu (Firefox) is served
 * by the dbusmenu source, which is preferred.
 */
const USE_AT_SPI_FOR_MENUS = true;

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });
        }),
    ]);
}

export default class MenuBarExtension extends Extension {
    enable() {
        log('ext', 'enable: shell', Main.sessionMode.currentMode,
            'atspi', USE_AT_SPI_FOR_MENUS ? 'on' : 'off');
        this._bar = new MenuBar();
        this._appNames = new AppNames();
        this._shownContext = null;
        this._checking = false;
        this._bar.onRefresh = () => {
            log('ext', 'refresh requested by the bar');
            this._scheduleUpdate(true);
        };

        this._sources = [
            new DBusMenuSource(),
            new GtkActionsSource(),
        ];
        this._dbusmenu = this._sources[0];

        /*
         * The accessibility source reads the menus of an application from
         * the tree it publishes.  It comes last, because the dbusmenu
         * source has the whole tree with the accelerators and the states of
         * the items, while the accessibility source has to open a menu in
         * the application to read it -- and that is what
         * `OPEN_MENUS_IN_APPLICATION` in the source is about.
         *
         * It is still asked for the titles of a menubar -- that is a plain
         * listing and opens nothing -- because an application with several
         * windows exports one menu object per window, and the titles say
         * which object belongs to the window in front.
         */
        this._atspi = new AtspiSource();
        if (USE_AT_SPI_FOR_MENUS)
            this._sources.push(this._atspi);

        /*
         * The sources of the titles of a menubar.  Reading them is a plain
         * listing of the items of a menubar, which opens nothing, so it
         * works even when the menus of the application may not be opened.
         *
         * The dbusmenu source comes first: it knows the object of the
         * application already, and reading it is a single call.  The
         * accessibility bus is the fallback, and it is the only one that
         * knows the titles of an application that exports nothing.
         */
        this._titleSources = [this._dbusmenu, this._atspi];

        for (const source of this._sources) {
            log('ext', `starting source ${source.name}`);
            source.onUpdated = () => {
                log('ext', `source ${source.name} reported a change`);
                this._scheduleUpdate();
            };
            source.start?.();
        }
        log('ext', 'sources started:', this._sources.map(source => source.name).join(', '));
        log('ext', 'title sources:', this._titleSources.map(s => s?.name).filter(Boolean).join(', '));

        // the bar belongs on the left of the panel, next to the app menu
        const left = Main.panel._leftBox;
        if (left) {
            left.add_child(this._bar);
            this._container = left;
            log('ext', 'bar added to the left box');
        } else {
            Main.panel.addToStatusArea('menubar', this._bar);
            this._container = null;
            log('ext', 'bar added with addToStatusArea (no left box)');
        }

        // Make browsers publish their accessibility trees (and with them
        // their menubars) without requiring a screen reader to be running.
        this._fakeAT = new FakeATClient();
        // the events of the accessibility bus are the counterpart of the
        // `LayoutUpdated` signal of dbusmenu: they say that the tree of an
        // application changed, so what the bar has read is not what the
        // application has any more
        this._fakeAT.onEvent = pid => this._atspi?.noteChanged(pid);
        this._fakeAT.start();

        // screenshots of the screen, for looking at the bar from another
        // terminal (only while a flag file exists)
        this._shots = new Shots();
        this._shots.start();

        /*
         * Browsers hide the window buttons of their title bar while their
         * menu bar is "active", and a menu built through the global menu
         * leaves it in that state.  Nothing outside the browser can style
         * its window, so the rule that keeps the buttons visible is put
         * into the userChrome.css of the browser's profile.
         */
        ensureTitlebarCss();

        // GNOME 50 centres the clock; push it behind the control centre
        moveClockToRight();
        dumpPanel();
        this._sessionModeId = Main.sessionMode.connectObject('updated',
            () => moveClockToRight(), this);

        this._focusId = global.display.connect('notify::focus-window',
            () => this._onFocusChanged());
        this._workspaceId = global.display.connect('notify::current-workspace',
            () => this._scheduleUpdate());

        /*
         * The focus signal alone proved unreliable (the menu did not follow
         * the focus), so the focused window is also polled -- cheaply, by
         * comparing its identity only.  Reading the menus again is expensive
         * and only happens when the focused window actually changed.
         */
        this._focusPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_POLL_MS, () => {
            // an exception here would remove the timeout and silently stop
            // the polling, so it is caught
            try {
                const window = global.display.get_focus_window();
                if (!window)
                    return GLib.SOURCE_CONTINUE;   // no focus: nothing changed
                const key = this._windowKey(window);
                if (key !== this._focusKey) {
                    this._focusKey = key;
                    log('ext', `focus poll: ${key}`,
                        `pid=${window.get_pid()}`,
                        `app=${this._appName(window)}`,
                        `title="${window.get_title()}"`);
                    this._onFocusChanged();
                }
            } catch (e) {
                print(`menubar: focus poll failed: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });

        /*
         * An application can change its menubar while it runs -- Firefox adds
         * a "Profiles" menu when the profile manager shows up.  The titles
         * are cheap to read, so they are compared every couple of seconds
         * and the menus are read again when they changed.
         */
        this._structurePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STRUCTURE_POLL_MS, () => {
            this._checkStructure().catch(e =>
                print(`menubar: structure check failed: ${e.message}`));
            return GLib.SOURCE_CONTINUE;
        });

        this._generation = 0;
        this._scheduleUpdate();
    }

    disable() {
        log('ext', 'disable');
        if (this._structurePollId) {
            GLib.source_remove(this._structurePollId);
            this._structurePollId = 0;
        }
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (this._workspaceId) {
            global.display.disconnect(this._workspaceId);
            this._workspaceId = 0;
        }
        if (this._focusPollId) {
            GLib.source_remove(this._focusPollId);
            this._focusPollId = 0;
        }
        if (this._sessionModeId) {
            Main.sessionMode.disconnectObject(this._sessionModeId);
            this._sessionModeId = 0;
        }

        for (const source of this._sources)
            source.stop?.();
        this._sources = [];

        this._fakeAT?.stop();
        this._fakeAT = null;

        this._shots?.stop();
        this._shots = null;

        restoreClock();

        this._bar?.destroy();
        this._bar = null;
        this._container = null;
    }

    _scheduleUpdate(force = false) {
        if (force) {
            this._generation++;   // discard whatever is in flight
            log('ext', `update forced, generation -> ${this._generation}`);
        }

        if (this._updateId) {
            // An update is already running.  Dropping the request would
            // leave the bar showing the menus of the application that was in
            // front before, so another one is run afterwards.
            this._updatePending = true;
            log('ext', 'update already scheduled, queued another one');
            return;
        }

        this._updateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_DELAY_MS, () => {
            this._updateId = 0;
            log('ext', 'update starting');
            this._update().catch(e => {
                log('ext', `update failed: ${e.message}`, e.stack ?? '');
            }).finally(() => {
                if (this._updatePending) {
                    this._updatePending = false;
                    log('ext', 'running the queued update');
                    this._scheduleUpdate();
                }
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusedWindow() {
        return global.display.get_focus_window();
    }

    /*
     * The name of the application is known at once, but its menus have to be
     * read out of it, which takes a moment.  So the bar shows the name right
     * away and the menus follow when they arrive, instead of the bar
     * keeping the menus of the application that was in front before.
     */
    _onFocusChanged() {
        /*
         * While one of our menus is open the shell has the keyboard, so the
         * focus moves around.  That is our own doing and must not make the
         * bar rebuild itself -- the application in front did not change.
         */
        if (this._bar?.isOpen) {
            log('ext', 'focus changed, but one of our menus is open: ignored');
            return;
        }

        const window = this._focusedWindow();
        if (!window || window.get_window_type() === Meta.WindowType.DESKTOP) {
            log('ext', 'focus changed to nothing/desktop');
            return;
        }

        /*
         * The focus signal and the poll both report the same change: the
         * signal fires first, and the poll then sees a different key
         * because the signal handler did not update it.  That started two
         * updates for every focus change, and the first was thrown away as
         * stale.  So the key is updated here as well, and a window whose
         * context is already shown is ignored.
         */
        this._focusKey = this._windowKey(window);

        const context = this._contextKey(window);
        if (context === this._shownContext) {
            log('ext', 'the focus is already shown, ignored');
            return;
        }
        this._shownContext = context;

        log('ext', `focus changed to "${window.get_title()}"`,
            `(${context})`, `app=${this._appName(window)}`);
        this._bar?.setContent(this._appName(window), [], context);
        this._scheduleUpdate();
    }

    _contextKey(window) {
        // the window key already carries the pid (pid:stable-sequence)
        return this._windowKey(window);
    }

    /*
     * The titles of the menubar of the window.
     *
     * They are only needed to tell the menu objects of an application with
     * several windows apart, so they are only read when the application
     * exports more than one.  Reading them is cheap either way -- the items
     * of a menubar are there whether it is open or not -- but it is a call
     * into the application, so it is not done for nothing.
     */
    /*
     * The titles of the menubar of *this window*, read from the
     * accessibility bus.  They say which of the menu objects of an
     * application belongs to the window in front, so they have to come from
     * the window and not from the object of the application.
     */
    async _titlesOf(descriptor) {
        if (!this._atspi?.getTitles)
            return null;

        try {
            // the AT-SPI source runs its reader in a separate process, so
            // this is asynchronous now
            return await this._atspi.getTitles(descriptor);
        } catch (e) {
            log('ext', `could not read the titles: ${e.message}`);
            return null;
        }
    }

    /*
     * The titles of the menubar of the application, for the structure check.
     * The dbusmenu source comes first: it knows the object of the
     * application already, and reading it is a single call.  The
     * accessibility bus is the fallback, and the only one that knows the
     * titles of an application that exports nothing.
     */
    async _structureTitles(descriptor) {
        for (const source of this._titleSources) {
            if (!source?.getTitles)
                continue;

            try {
                const titles = await source.getTitles(descriptor);
                if (titles?.length) {
                    log('ext', `structure titles from ${source.name}: [${titles.join(', ')}]`);
                    return titles;
                }
            } catch (e) {
                log('ext', `could not read the titles from ${source.name}: ${e.message}`);
            }
        }

        return null;
    }

    async _update() {        const generation = ++this._generation;
        const window = this._focusedWindow();
        if (!window || window.get_window_type() === Meta.WindowType.DESKTOP) {
            log('ext', 'update: no window focused, clearing the bar');
            this._bar.clear();
            return;
        }

        const descriptor = this._descriptor(window);
        log('ext', `update #${generation}:`, {
            app: this._appName(window),
            title: descriptor.title,
            pid: descriptor.pid,
            appId: descriptor.appId,
            wmClass: descriptor.wmClass,
            context: descriptor.context,
        });

        /*
         * The sources are asked at the same time, and the first one that
         * answers with a complete tree wins.  Asking them one after the
         * other was slow: a source that does not answer costs its full
         * timeout, and the timeout of the source before the one with the
         * data is pure waiting.
         *
         * A source only answers when it has the whole tree, so there is
         * nothing to compare: the accessibility source, for instance, says
         * that it is not ready when the application builds its menus when
         * they are opened, because it would have to open them in the
         * application to read them.
         */
        const answers = [];
        const pending = new Set(this._sources);
        let result = null;

        const record = answer => {
            answers.push(answer);
            pending.delete(answer.source);
            log('ext', `${answer.source.name} answered in ${answer.elapsed.toFixed(0)}ms:`,
                answer.menus?.length
                    ? `${answer.menus.length} menus [${answer.menus.map(m => m.label).join(', ')}]`
                    : 'nothing (null or empty)');
            return answer;
        };

        const attempts = this._sources.map(source => {
            const started = GLib.get_monotonic_time();
            log('ext', `asking ${source.name}`);
            return withTimeout(source.getMenus(descriptor), SOURCE_TIMEOUT_MS)
                .then(menus => record({
                    source,
                    menus,
                    elapsed: (GLib.get_monotonic_time() - started) / 1000,
                }))
                .catch(e => {
                    log('ext', `${source.name} threw: ${e.message}`);
                    return record({
                        source,
                        menus: null,
                        elapsed: (GLib.get_monotonic_time() - started) / 1000,
                    });
                });
        });

        await Promise.race([
            Promise.all(attempts),
            // the first answer
            new Promise(resolve => {
                for (const attempt of attempts) {
                    attempt.then(value => {
                        if (!value.menus?.length)
                            return;
                        if (!result || this._betterSource(value.source, result.source))
                            result = value;
                        resolve();
                    });
                }
            }),
        ]);

        /*
         * The first answer is not taken right away when a better source
         * could still come: the dbusmenu source has the accelerators and
         * the states of the items, which the accessibility source does not
         * have.  So the result is held back -- but only while a better
         * source is actually still running.  Waiting for one that already
         * answered nothing was a fixed 250ms on every accessibility
         * result.
         */
        if (result && this._betterStillPending(result.source, pending)) {
            log('ext', `${result.source.name} has the answer, waiting up to ` +
                `${SOURCE_GRACE_MS}ms for a better source`);
            const deadline = GLib.get_monotonic_time() + SOURCE_GRACE_MS * 1000;
            while (GLib.get_monotonic_time() < deadline) {
                await sleep(SOURCE_GRACE_POLL_MS);
                const best = this._bestAnswer(answers);
                if (best && this._betterSource(best.source, result.source)) {
                    log('ext', `better source ${best.source.name} takes over`);
                    result = best;
                    break;
                }
                if (!this._betterStillPending(result.source, pending)) {
                    log('ext', 'the better sources have answered, no need to wait');
                    break;
                }
            }
        }

        const menus = result?.menus ?? null;
        if (result)
            log('ext', `chosen source: ${result.source.name}`, `(${result.elapsed.toFixed(0)}ms)`);
        else
            log('ext', 'no source had menus');

        // a slower earlier update must not overwrite a newer one
        if (generation !== this._generation) {
            log('ext', `update #${generation} is stale (now #${this._generation}), dropped`);
            return;
        }

        log('ext', `${menus ? menus.length : 0} menus for ${this._appName(window)}` +
            ` (${this._windowKey(window)})`);
        this._bar.setContent(this._appName(window), menus, descriptor.context);
    }

    /*
     * The best answer among the ones that have arrived.
     */
    _bestAnswer(answers) {
        let best = null;
        for (const answer of answers) {
            if (!answer?.menus?.length)
                continue;
            if (!best || this._betterSource(answer.source, best.source))
                best = answer;
        }
        return best;
    }

    /*
     * Is a better source than this one still running?
     */
    _betterStillPending(source, pending) {
        const order = this._sources.indexOf(source);
        return this._sources.slice(0, order).some(other => pending.has(other));
    }

    /*
     * Is the first source better than the second one?
     *
     * The dbusmenu source knows the whole tree of the application: the
     * accelerators, the states of the items, the submenus.  The
     * accessibility source has to open a menu in the application to read it,
     * which is visible and takes a grab, so it is only used when there is
     * nothing better.
     */
    _betterSource(candidate, current) {
        const order = source => this._sources.indexOf(source);
        return order(candidate) < order(current);
    }

    _descriptor(window) {
        const descriptor = {
            pid: window.get_pid(),
            appId: window.get_gtk_application_id(),
            wmClass: window.get_wm_class(),
            // the title identifies the window inside the application, which
            // matters for apps with several windows and different menubars
            title: window.get_title() ?? '',
            windowKey: this._windowKey(window),
            // identifies the window the data belongs to; the sources tag
            // their nodes with it and the bar refuses data of another one
            context: this._contextKey(window),
        };

        /*
         * The titles of the menubar of the window.  They are only read when
         * a source needs them -- an application with several windows
         * exports one menu object per window, and the titles say which
         * object belongs to the window in front.
         */
        descriptor.getTitles = () => this._titlesOf(descriptor);

        return descriptor;
    }

    /*
     * Compare the titles of the application's menubar with the ones the bar
     * shows, and read the menus again when they differ.
     */
    async _checkStructure() {
        // one check at a time: reading the titles now runs a process
        if (this._checking)
            return;
        this._checking = true;

        try {
            await this._checkStructureNow();
        } finally {
            this._checking = false;
        }
    }

    async _checkStructureNow() {
        const window = this._focusedWindow();
        if (!window || window.get_window_type() === Meta.WindowType.DESKTOP)
            return;

        const descriptor = this._descriptor(window);

        // the titles come from the accessibility bus: reading them is a
        // plain listing, it opens nothing
        const titles = await this._structureTitles(descriptor);
        if (!titles || !titles.length) {
            log('ext', 'structure check: no titles');
            return;
        }

        const current = this._bar.titles;
        if (current.length === titles.length && current.every((t, i) => t === titles[i])) {
            log('ext', `structure check: unchanged [${current.join(', ')}]`);
            return;
        }

        log('ext', `structure check: changed [${current.join(', ')}] -> [${titles.join(', ')}]`);
        this._scheduleUpdate(true);
    }

    /*
     * Identity of a window that works on Wayland: get_id() is the X11
     * window id (always 0 for native Wayland clients), while the stable
     * sequence is a unique, monotonically increasing number per window.
     */
    _windowKey(window) {
        const pid = window.get_pid();
        let id = 0;
        try {
            id = window.get_stable_sequence();
        } catch (e) {
            id = window.get_id();
        }
        return `${pid}:${id}`;
    }

    _appName(window) {
        const appId = window.get_gtk_application_id();
        const wmClass = window.get_wm_class();

        // the name the application wants to be called
        const pretty = this._appNames.lookup(appId, wmClass, window.get_title() ?? '');
        if (pretty)
            return pretty;

        if (appId) {
            const parts = appId.split('.');
            const last = parts[parts.length - 1];
            if (last) {
                const name = last.charAt(0).toUpperCase() + last.slice(1);
                log('ext', `the name of the application is taken from its id: "${name}"`);
                return name;
            }
        }

        if (wmClass) {
            log('ext', `the name of the application is its window class: "${wmClass}"`);
            return wmClass;
        }

        const title = window.get_title() ?? '';
        log('ext', `the name of the application is its window title: "${title}"`);
        return title;
    }
}
