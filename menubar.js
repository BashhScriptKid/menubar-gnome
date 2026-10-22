/* The panel widget: a horizontal strip of menu titles in the top bar.
 *
 * The titles are `PanelMenu.Button`s with a real menu, exactly the way the
 * apps-menu extension builds its button:
 *
 *     const button = new PanelMenu.Button(0, name, true);
 *     button.setMenu(new PopupMenu.PopupMenu(button, 0, St.Side.TOP));
 *     Main.panel.menuManager.addMenu(button.menu);
 *
 * That matters: the button then brings the shell's own machinery with it --
 * the click gesture, the modal grab, the "active" pseudo class, the keyboard
 * navigation, and above all the panel's menu manager, which is what passes
 * the "a menu is open in this panel" state from one button to the next.  A
 * button with a hand-rolled gesture and a hand-rolled popup is invisible to
 * all of that, and behaves differently from every other button in the bar.
 *
 * The items themselves are read out of the application.  Some toolkits only
 * build a menu when it is opened, so for those the items are read before the
 * popup opens -- reading them opens the application's own menu, and that
 * takes the pointer grab, which would dismiss our popup again.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {log} from './debug.js';

/*
 * How much of the screen a menu may use.  The shell clamps a menu to the
 * whole work area, which means a long menu covers the entire screen; this
 * keeps it to a share of it, so the window below stays visible.
 */
const MENU_HEIGHT_RATIO = 0.7;

/*
 * Fetching the content of a menu.
 *
 * The bar does not keep a snapshot of the menus of an application: it asks
 * for them when it is about to show one.  The application fills its menus
 * when they are shown, and the ids of its model are renumbered when it
 * does -- so a menu that was read a moment ago can be out of date, and a
 * menu that was never filled is empty.
 *
 * The pointer has to rest on a title for a moment before it is fetched, so
 * that passing over the bar does not make the application build all of its
 * menus.  A menu that was fetched a moment ago is not fetched again.
 */
const TITLE_HOVER_DELAY_MS = 150;
const FETCH_FRESH_MS = 700;

export const MenuBar = GObject.registerClass(
class MenuBar extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'menubar',
            x_expand: false,
            y_expand: false,
            visible: false,
        });

        this._titleLabel = null;
        this._entries = [];      // {button, menu, node, context}
        this._pending = null;
        // every setContent() starts a new context: data that belongs to an
        // older one is dropped instead of being shown or activated
        this._context = 0;
        this._openMenu = null;
        this._openButton = null;
        this._titleTimer = 0;
    }

    clear() {
        log('bar', `clear (${this._entries.length} entries, context ${this._context})`);
        this.closeAll();
        for (const entry of this._entries) {
            entry.menu.destroy();
            entry.button.destroy();
        }
        this._entries = [];
        this._titleLabel?.destroy();
        this._titleLabel = null;
        this.hide();
    }

    /* true while one of our menus is open */
    get isOpen() {
        return this._entries.some(entry => entry.menu.isOpen);
    }

    /* the titles the bar currently shows */
    get titles() {
        return this._entries.map(entry => entry.node.label ?? '');
    }

    setContent(appName, nodes, context) {
        /*
         * The model has to belong to the context it is shown for.  A source
         * that answers late -- or a menu that was filled for another window
         * -- must not end up in this bar.
         */
        if (context) {
            const foreign = (nodes ?? []).find(node => node.context && node.context !== context);
            if (foreign) {
                log('bar', `DROPPING a model of another context: ` +
                    `${foreign.context} != ${context}`);
                return;
            }
        }

        this.clear();
        this._context++;

        log('bar', `setContent app="${appName}" nodes=${nodes?.length ?? 0}` +
            ` context ${this._context}`);

        if (appName) {
            this._titleLabel = new St.Label({
                style_class: 'menubar-title',
                text: appName,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._titleLabel);
        }

        if (!nodes || !nodes.length) {
            log('bar', `no menus, showing just the app name (visible=${!!appName})`);
            this.visible = !!appName;
            return;
        }

        for (const node of nodes) {
            if (node.type === 'separator')
                continue;

            log('bar', `title "${node.label}" type=${node.type}` +
                ` children=${node.children?.length ?? 0}` +
                ` unbuilt=${!!node.unbuilt}` +
                ` fetchable=${!!(node.fetch ?? node.loadChildren ?? node.refresh)}`);
            const entry = this._createEntry(node, this._context);
            // PanelMenu.Button wraps itself in a St.Bin, so the *container*
            // is what goes into a box (this is what addToStatusArea does)
            this.add_child(entry.button.container);
            this._entries.push(entry);
        }

        this.visible = true;
    }

    _createEntry(node, context) {
        const label = node.label ?? '';

        // PanelMenu.Button(menuAlignment, accessibleName, dontCreateMenu)
        const button = new PanelMenu.Button(0, label, true);
        button.add_style_class_name('menubar-item');

        // PanelMenu.Button is a ButtonBox, not an St.Button, so the visible
        // text is a child label (this is what the apps-menu extension does)
        const text = new St.Label({
            text: label,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            // a reactive label would swallow the pointer events and the
            // button would never get its :hover state
            reactive: false,
        });
        button.add_child(text);
        button.label_actor = text;

        // The menu belongs to the button, so the shell opens it on click and
        // marks the button as active while it is open.
        const menu = new PopupMenu.PopupMenu(button, 0, St.Side.TOP);
        menu.setSourceAlignment(0);
        menu.box.add_style_class_name('menubar-menu');
        this._makeScrollable(menu);
        button.setMenu(menu);

        // The panel's menu manager closes one menu when another one opens,
        // which is what lets the state pass from one panel item to the next.
        Main.panel.menuManager.addMenu(menu);

        // The panel button opens its menu itself when the title is clicked,
        // and it opens with whatever the menu has at that moment.  The
        // content of the application is fetched first, so that the menu
        // comes up with what the application has right now -- and so that
        // its size does not change while it is open, which would move the
        // items under the pointer.
        const shellOpen = menu.open.bind(menu);
        menu.open = animate => {
            if (menu.isOpen)
                return;

            if (this._isFresh(node)) {
                shellOpen(animate);
                return;
            }

            log('bar', `"${label}": the menu waits for its content`);
            this._fetchMenu(node, menu, context, 'never', null, 'the menu was opened', true)
                .then(() => {
                    if (!menu.isOpen) {
                        log('bar', `"${label}": opening the menu with its content`);
                        shellOpen(animate);
                    }
                });
        };

        menu.connect('open-state-changed', (m, open) => {
            log('bar', `menu "${label}" ${open ? 'OPEN' : 'closed'}`,
                `items=${m._getMenuItems?.().length ?? '?'}`,
                `readPromise=${!!node.readPromise}`,
                `context=${context} current=${this._context}`);
            if (open) {
                this._openMenu = m;
                this._openButton = button;

                if (!m._getMenuItems().length && node.readPromise) {
                    // the menu is still being read out of the application --
                    // show it when it is ready instead of showing it empty
                    log('bar', `"${label}" is empty and still being read: reopening when ready`);
                    this._pending = m;
                    m.close();
                    return;
                }

                this._limitHeight(menu, button);

                /*
                 * The application fills its menus when they are shown, so
                 * the content of the menu is fetched again: what the bar
                 * shows is what the application has at this moment.  The
                 * application has just built the menu (the opening asked
                 * for it), so nothing is asked of it here.
                 */
                this._fetchMenu(node, menu, context, 'never', null,
                    'the menu was opened', false);
            } else if (this._openMenu === m) {
                this._openMenu = null;
                this._openButton = null;
            }
        });

        // While a menu is open the pointer is grabbed, so the pointer motion
        // arrives at the menu.  That is where the "hover to the next title
        // switches the menu" behaviour comes from.
        menu.actor.connect('motion-event', (actor, event) => {
            this._onMenuMotion(menu, event);
            return Clutter.EVENT_PROPAGATE;
        });

        /*
         * The content of the menu is fetched when the pointer rests on the
         * title: the application fills its menus when they are shown, and
         * the bar wants to show what it has at that moment.  The delay
         * keeps a pointer that only passes over the bar from making the
         * application build all of its menus.
         */
        button.connect('enter-event', () => {
            log('bar', `pointer entered "${label}"`);
            if (this._titleTimer) {
                GLib.source_remove(this._titleTimer);
                this._titleTimer = 0;
            }
            this._titleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                TITLE_HOVER_DELAY_MS, () => {
                    this._titleTimer = 0;
                    /*
                     * Only read what the application has.  Asking it to
                     * build the menu makes it show the menu in its own
                     * window -- and in some builds the buttons of the title
                     * bar of that window do not come back.  A pointer that
                     * rests on a title has not asked for the menu yet.
                     */
                    this._fetchMenu(node, menu, context, 'never', null,
                        'the pointer rests on the title', false);
                    return GLib.SOURCE_REMOVE;
                });
            return Clutter.EVENT_PROPAGATE;
        });

        button.connect('leave-event', () => {
            log('bar', `pointer left "${label}"`);
            if (this._titleTimer) {
                GLib.source_remove(this._titleTimer);
                this._titleTimer = 0;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        /*
         * The presses are watched in the capture phase.  PanelMenu.Button
         * puts a real St.Button inside itself and that button handles the
         * click, so a plain button-press-event handler out here would never
         * run.  The capture phase goes through the ancestors before the
         * target, so the press (and which mouse button it was) is seen
         * regardless.  A right or middle click is otherwise invisible.
         */
        button.connect('captured-event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS ||
                type === Clutter.EventType.BUTTON_RELEASE) {
                const what = type === Clutter.EventType.BUTTON_PRESS ? 'press' : 'release';
                log('bar', `${what} on "${label}": button=${event.get_button()}` +
                    ` mods=${event.get_state()} coords=${event.get_coords().slice(0, 2)}`);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        menu.actor.connect('enter-event', () => {
            log('bar', `pointer entered the menu "${label}"`);
            return Clutter.EVENT_PROPAGATE;
        });

        menu.actor.connect('leave-event', () => {
            log('bar', `pointer left the menu "${label}"`);
            return Clutter.EVENT_PROPAGATE;
        });

        menu.actor.connect('button-press-event', (actor, event) => {
            log('bar', `press inside the menu "${label}": button=${event.get_button()}` +
                ` coords=${event.get_coords().slice(0, 2)}`);
            return Clutter.EVENT_PROPAGATE;
        });

        // keyboard navigation: the arrow keys move the selection, Escape
        // closes, Enter activates.  The key value is a number, so it is
        // printed together with the character when there is one.  This is
        // watched in the capture phase as well, because the menu's items
        // are the key targets.
        menu.actor.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;
            log('bar', `key in the menu "${label}": keyval=${event.get_key_symbol()}` +
                ` char="${event.get_key_unicode()}" mods=${event.get_state()}`);
            return Clutter.EVENT_PROPAGATE;
        });

        this._fill(menu, node.children ?? [], context);

        return {button, menu, node, context};
    }

    /*
     * The shell's popup menus have no scroll view: a menu that is taller
     * than the screen is simply clipped and the items below the edge cannot
     * be reached.  Putting the content into a scroll view makes a long menu
     * scrollable.  The shell sets a max-height on the menu's actor when it
     * opens, and the scroll view honours it.
     */
    _makeScrollable(menu) {
        const box = menu.box;
        const parent = box.get_parent();
        if (!parent) {
            log('bar', 'scroll: menu box has no parent, skipped');
            return null;
        }

        /*
         * A PopupMenu puts its content into the bin of a boxpointer -- a
         * plain box, which needs a scroll view to be scrollable.  A
         * PopupSubMenu is a scroll view already, with the content in it, so
         * there is nothing to do -- and putting a second scroll view around
         * it would leave the content without a height, and the submenu
         * would come up empty.
         */
        if (parent instanceof St.ScrollView) {
            log('bar', 'scroll: parent is already a ScrollView (submenu), reusing it');
            parent.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
            parent.set_overlay_scrollbars(true);
            menu._scrollView = parent;
            return parent;
        }

        log('bar', `scroll: wrapping ${parent.constructor.name} in a new ScrollView`);

        const scrollView = new St.ScrollView({
            style_class: 'vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        parent.remove_child(box);
        scrollView.set_child(box);
        if (parent instanceof St.Bin)
            parent.set_child(scrollView);
        else
            parent.add_child(scrollView);

        // a submenu is not opened by the shell, so its height is limited
        // here
        try {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const maxHeight = Math.round(workArea.height * MENU_HEIGHT_RATIO / scaleFactor);
            menu.actor.style = `max-height: ${maxHeight}px;`;
        } catch (e) {
            // ignore
        }

        menu._scrollView = scrollView;
        return scrollView;
    }

    /* the shell clamps the menu to the whole work area -- tighten that */
    _limitHeight(menu, button) {
        try {
            const monitor = Main.layoutManager.findMonitorForActor(button) ??
                Main.layoutManager.primaryIndex;
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor);
            const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const margins = menu.actor.margin_top + menu.actor.margin_bottom;
            const maxHeight = Math.round((workArea.height * MENU_HEIGHT_RATIO - margins) / scaleFactor);
            menu.actor.style = `max-height: ${maxHeight}px;`;
            log('bar', `limited menu height to ${maxHeight}px (workArea ${workArea.height}, ` +
                `scale ${scaleFactor})`);
        } catch (e) {
            log('bar', `could not limit the menu height: ${e.message}`);
        }
    }

    _entryOf(menu) {
        return this._entries.find(entry => entry.menu === menu) ?? null;
    }

    /*
     * The pointer is over another title while a menu is open: switch to that
     * menu.  The panel's menu manager closes the old one for us.
     */
    /*
     * The content of a menu, fetched from the application.
     *
     * Every menu of the bar can change: the application fills its menus
     * when they are shown, and it renumbers its model when it does.  So
     * the bar asks the source for the content of a menu when it is about
     * to show it, and the popup is filled with the answer.  A menu that
     * was fetched a moment ago is not fetched again.
     *
     * What happens with the popup afterwards is up to the caller:
     *   'always'     open it as soon as it has content
     *   'never'      leave it alone (it is open already, or the caller
     *                opens it itself)
     */
    /*
     * Is the content of a menu current?
     *
     * A menu that was fetched a moment ago is still what the application
     * has; one that was not fetched at all is not.
     */
    _isFresh(node) {
        const fetch = node.fetch ?? node.loadChildren ?? node.refresh;
        if (!fetch)
            return true;
        const age = GLib.get_monotonic_time() - (node.fetchedAt ?? 0);
        return age < FETCH_FRESH_MS * 1000;
    }

    async _fetchMenu(node, popup, context, open, pointerTarget, reason, demand = true) {
        const fetch = node.fetch ?? node.loadChildren ?? node.refresh;
        const path = node.path?.length ? ` path=[${node.path.join(' / ')}]` : '';
        if (!fetch) {
            // a menu of a source that does not change
            log('bar', `"${node.label}" has nothing to fetch${path} (${reason})`);
            if (open !== 'never' && !popup.isOpen) {
                log('bar', `opening "${node.label}" with what it has`);
                popup.open();
            }
            return node.children;
        }

        if (!node.readPromise) {
            // a menu that was fetched a moment ago is still current
            const age = GLib.get_monotonic_time() - (node.fetchedAt ?? 0);
            if (age < FETCH_FRESH_MS * 1000) {                log('bar', `"${node.label}" was fetched ${Math.round(age / 1000)}ms ago, ` +
                    `that is current enough (${reason})`);
                if (open !== 'never' && !popup.isOpen) {
                    if (open === 'always' || this._pointerIn(pointerTarget)) {
                        log('bar', `opening "${node.label}" (${reason})`);
                        popup.open();
                    } else {
                        log('bar', `"${node.label}" is not opened: the pointer is elsewhere`);
                    }
                }
                return node.children;
            }

            const started = Date.now();
            log('bar', `fetching "${node.label}"${path} (${reason}` +
                `${demand ? '' : ', without asking the application to build it'})`);

            node.readPromise = fetch({demand}).then(children => {
                // the read may finish after the bar moved on to another
                // application: the result then belongs to a context that is
                // gone
                if (context !== this._context) {
                    log('bar', `the content of "${node.label}" arrived too late ` +
                        `(${context} != ${this._context}), dropped`);
                    return null;
                }

                if (!children?.length) {
                    log('bar', `"${node.label}": the application gave no items ` +
                        `(${reason})`);
                    return children;
                }

                node.children = children;
                node.fetchedAt = GLib.get_monotonic_time();

                if (popup.isOpen) {
                    /*
                     * The menu is open, and its size must not change now:
                     * the items would move under the pointer.  The new
                     * content is used the next time the menu is opened.
                     */
                    log('bar', `"${node.label}" is open: ${children.length} items are ` +
                        'used the next time it is opened');
                } else {
                    popup.removeAll();
                    this._fill(popup, children, context);
                    log('bar', `"${node.label}": ${children.length} items in ` +
                        `${Date.now() - started}ms (${reason})` +
                        ` [${children.map(child => child.label || '<sep>').join(', ')}]`);
                }

                // a menu that was asked for while it was still empty is
                // shown now that it has its items
                if (this._pending === popup && !popup.isOpen) {
                    log('bar', `"${node.label}" was waiting: opening it now`);
                    this._pending = null;
                    popup.open();
                }

                return children;
            }).catch(e => {
                log('bar', `could not fetch "${node.label}" (${reason}): ${e.message}`);
                return null;
            }).finally(() => {
                node.readPromise = null;
                node.fetchLogged = false;
            });
        } else {
            // the same menu is asked for again and again while the pointer
            // moves over the bar: that is one fetch, not many
            if (!node.fetchLogged) {
                node.fetchLogged = true;
                log('bar', `"${node.label}" is being fetched already (${reason})`);
            }
        }

        const children = await node.readPromise;
        if (!children?.length)
            return children;

        if (open === 'never')
            return children;

        /*
         * The shell does not open an empty menu, so the menu is opened now
         * that it has items.
         */
        if (!popup.isOpen) {
            if (open === 'always' || this._pointerIn(pointerTarget)) {
                log('bar', `opening "${node.label}" (${reason})`);
                popup.open();
            } else {
                log('bar', `"${node.label}" is not opened: the pointer is elsewhere`);
            }
        }

        return children;
    }

    /* is the pointer inside the actor? */
    _pointerIn(actor) {
        if (!actor)
            return false;
        const [px, py] = global.get_pointer();
        const [ax, ay] = actor.get_transformed_position();
        return px >= ax && px < ax + actor.width &&
            py >= ay && py < ay + actor.height;
    }

    _onMenuMotion(menu, event) {
        if (!menu.isOpen)
            return;

        // during the modal grab the pointer still moves freely, so its
        // position is more reliable than the coordinates of the event
        let x, y;
        if (event?.get_coords) {
            [x, y] = event.get_coords();
        } else {
            [x, y] = global.get_pointer();
        }
        const entry = this._titleAt(x, y);
        if (!entry || entry.menu === menu)
            return;

        log('bar', `motion at ${x},${y}: over "${entry.node.label}"` +
            ` (open=${entry.menu.isOpen}, items=${entry.menu._getMenuItems?.().length ?? '?'})`);

        if (!entry.menu.isOpen) {
            /*
             * The pointer moved from one title to another while a menu was
             * open: the other menu is opened the same way a click opens it,
             * so that it comes up with what the application has right now
             * (and not with the last thing the bar read).
             */
            entry.menu.open();
            log('bar', `passed to "${entry.node.label}"`);
        }
    }

    _titleAt(x, y) {
        for (const entry of this._entries) {
            const button = entry.button;
            if (!button.visible)
                continue;
            const [bx, by] = button.get_transformed_position();
            if (x >= bx && x < bx + button.get_width() &&
                y >= by && y < by + button.get_height())
                return entry;
        }
        return null;
    }

    closeAll() {
        const menu = this._openMenu;
        this._openMenu = null;
        this._openButton = null;
        // NOTE: PopupMenu.isOpen is a property in GNOME 45+, not a method
        if (menu?.isOpen) {
            log('bar', 'closeAll: closing the open menu');
            menu.close();
        }
    }

    _refill(menu, nodes, context) {
        log('bar', `refill: ${nodes?.length ?? 0} nodes (context ${context})`);
        menu.removeAll();
        this._fill(menu, nodes, context);
    }

    _fill(menu, nodes, context) {
        log('bar', `fill: ${nodes?.length ?? 0} nodes`);
        for (const node of nodes) {
            if (node.type === 'separator') {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }

            const label = node.label ?? '';

            if (node.type === 'submenu') {
                log('bar', `fill submenu "${label}" children=${node.children?.length ?? 0}` +
                    ` unbuilt=${!!node.unbuilt} ` +
                    `fetchable=${!!(node.fetch ?? node.loadChildren ?? node.refresh)}`);
                const item = new PopupMenu.PopupSubMenuMenuItem(label);
                this._makeScrollable(item.menu);
                this._fill(item.menu, node.children ?? [], context);

                /*
                 * A menu that the application has not built yet is empty,
                 * and the shell does not open an empty menu at all -- so
                 * the menu cannot be opened, and the click on it does
                 * nothing.  That is the case for the menus of Firefox that
                 * are filled when they are shown ("Other Bookmarks", "New
                 * Container Tab", ...).
                 *
                 * So the contents are read *before* the menu is opened: the
                 * click reads them, and the menu is opened when they are
                 * there.
                 */
                const fetchSubmenu = demand =>
                    () => this._fetchMenu(node, item.menu, context, 'never', item,
                        'the item was clicked', demand);

                /*
                 * The click is the shell's own toggle -- except that the
                 * content has to be there before the menu opens: an empty
                 * menu does not open at all, and a menu that the application
                 * fills only when it is shown is empty until it is fetched.
                 *
                 * The menu is opened by the shell's own `setSubmenuShown`,
                 * not by `open()` here: that is the call that passes the
                 * animation, and a submenu that is opened without it does
                 * not animate at all.
                 */
                const activate = item.activate.bind(item);
                item.activate = () => {
                    if (item.menu.isOpen) {
                        activate();
                        return;
                    }

                    fetchSubmenu(true)().then(children => {
                        if (children?.length && !item.menu.isOpen)
                            item.setSubmenuShown(true);
                    });
                };

                if (node.fetch || node.loadChildren || node.refresh) {
                    item.menu.connect('open-state-changed', (submenu, open) => {
                        if (!open) {
                            log('bar', `submenu "${label}" closed`);
                            return;
                        }
                        log('bar', `submenu "${label}" OPEN` +
                            ` items=${submenu._getMenuItems?.().length ?? 0}` +
                            ` fetchable=${!!(node.fetch ?? node.loadChildren ?? node.refresh)}`);
                    });
                }

                menu.addMenuItem(item);
                continue;
            }

            log('bar', `fill item "${label}" type=${node.type} enabled=${node.enabled}` +
                ` shortcut=${node.shortcut ?? '-'} toggle=${node.toggle ?? '-'}`);

            /*
             * A submenu whose contents the application did not build: the
             * item opens the menu of the application instead, which is
             * better than an arrow that leads to an empty popup.
             */
            const item = new PopupMenu.PopupMenuItem(label);
            item.reactive = node.enabled !== false;
            // an item the application greys out is insensitive here as well
            if (node.enabled === false)
                item.setSensitive(false);

            if (node.shortcut && item.label?.clutter_text) {
                const markup = `${escapeMarkup(label)}  <span alpha="55%">${escapeMarkup(node.shortcut)}</span>`;
                try {
                    item.label.clutter_text.set_markup(markup);
                } catch (e) {
                    // ignore
                }
            }

            if (node.toggle !== null && node.toggle !== undefined && PopupMenu.Ornament) {
                try {
                    item.setOrnament(node.toggle ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                } catch (e) {
                    // ignore
                }
            }

            item.connect('activate', () => {
                // the item belongs to the application that was in front when
                // the menu was filled; if that has changed, it is not ours
                // to activate any more
                if (context !== this._context) {
                    log('bar', `NOT activating "${label}": context ${context} != ` +
                        `${this._context}`);
                    this.closeAll();
                    return;
                }

                log('bar', `activate "${label}" (context ${context})`);

                /*
                 * The activation is not always immediate: an item of a menu
                 * that the application has closed again has to be looked up
                 * first.  So it is waited for, and only then is the menu
                 * closed -- closing it right away would take the focus
                 * away from the item while it is being activated.
                 */
                Promise.resolve()
                    .then(() => node.activate?.())
                    .then(() => log('bar', `activated "${label}"`))
                    .catch(e => {
                        log('bar', `could not activate "${label}": ${e.message}`);
                    })
                    .finally(() => this.closeAll());
            });

            menu.addMenuItem(item);
        }
    }
});

function escapeMarkup(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
