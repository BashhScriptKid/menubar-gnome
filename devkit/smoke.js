/* Automation script for the nested GNOME Shell devkit.
 *
 *   ./devkit/run.sh
 *
 * The shell imports this file as an ES module and calls init() at startup
 * and run() once the layout manager is up (js/ui/main.js).
 */

import Meta from 'gi://Meta';

let Main = null;
let Scripting = null;
let St = null;

export function init() {
    print('SMOKE: init()');
}

export async function run() {
    Scripting = await import('resource:///org/gnome/shell/ui/scripting.js');
    Main = await import('resource:///org/gnome/shell/ui/main.js');
    St = (await import('gi://St')).default;

    await Scripting.sleep(4000);

    const ext = Main.extensionManager?.lookup('menubar@local');
    print(`SMOKE: extension=${!!ext} state=${ext?.state} error=${ext?.error || 'none'}`);

    // the devkit shell starts in the overview, where popups are refused
    Main.overview.hide();
    await Scripting.sleep(1000);
    print(`SMOKE: actionMode=${Main.actionMode}`);

    // our bar in the panel
    const bar = Main.panel._leftBox?.get_children()
        .find(c => (c.style_class ?? '').includes('menubar'));
    print(`SMOKE: bar=${!!bar}`);
    if (!bar)
        return;

    /*
     * No applications in the nested shell, so feed the bar a model by hand:
     * that exercises the popup building, opening, item activation and the
     * close path without needing an app.
     */
    bar.setContent('Test', [
        {
            label: 'File', type: 'submenu', children: [
                {label: 'New Tab', type: 'standard', enabled: true, shortcut: 'Ctrl+T',
                 activate: () => print('SMOKE: "New Tab" activated')},
                {label: 'Save', type: 'standard', enabled: false,
                 activate: () => print('SMOKE: "Save" activated (should not happen)')},
                // a submenu of its own, a greyed out item and a checked one
                {label: 'Toolbars', type: 'submenu', children: [
                    {label: 'Menu Bar', type: 'standard', enabled: true},
                ]},
                // a nested menu that the application only builds when it is
                // shown: it is empty until then, and the shell does not
                // open an empty menu at all
                {label: 'Nested Lazy', type: 'submenu', children: [],
                 fetch: async () => {
                     await new Promise(r => setTimeout(r, 300));
                     print('SMOKE: nested fetch() called');
                     return [{label: 'Nested Item', type: 'standard', enabled: true}];
                 }},
                {label: 'Repair Text Encoding', type: 'standard', enabled: false},
                {label: 'Full Screen', type: 'standard', enabled: true, toggle: true},
            ],
        },
        {
            label: 'Edit', type: 'submenu', children: [
                {label: 'Undo', type: 'standard', enabled: true,
                 activate: () => print('SMOKE: "Undo" activated')},
            ],
        },
        {
            // a long menu: it has to scroll instead of being clipped
            label: 'Long', type: 'submenu', children:
                Array.from({length: 200}, (_, i) => ({
                    label: `Item ${i}`, type: 'standard', enabled: true,
                })),
        },
        {
            // a lazily built menu: the items only exist after the menu was
            // read out of the application
            label: 'Lazy', type: 'submenu', children: [],
            fetch: async () => {
                await new Promise(r => setTimeout(r, 400));
                print('SMOKE: fetch() called');
                return [{label: 'Lazy Item', type: 'standard', enabled: true,
                         activate: () => print('SMOKE: "Lazy Item" activated')}];
            },
        },
        {
            // a top-level menu the application fills when it is shown
            label: 'Fresh', type: 'submenu', children: [
                {label: 'Old Item', type: 'standard', enabled: true},
            ],
            fetch: async () => {
                await new Promise(r => setTimeout(r, 50));
                print('SMOKE: refresh() called');
                return [
                    {label: 'Old Item', type: 'standard', enabled: true},
                    {label: 'Fresh Item', type: 'standard', enabled: true},
                ];
            },
        },
    ]);
    await Scripting.sleep(300);

    // the bar holds St.Bins, each wrapping one PanelMenu.Button
    const menuButtons = bar.get_children()
        .map(c => c.get_children()[0])
        .filter(c => (c.style_class ?? '').includes('menubar-item'));
    print(`SMOKE: menu buttons=${menuButtons.length} ` +
          `labels=${JSON.stringify(menuButtons.map(b => b.label_actor?.text ?? b.label))}`);
    print(`SMOKE: button style=${JSON.stringify(menuButtons[0]?.style_class)} ` +
          `labelReactive=${menuButtons[0]?.label_actor?.reactive} ` +
          `buttonReactive=${menuButtons[0]?.reactive}`);
    const titleLabel = menuButtons[0]?.label_actor;
    print(`SMOKE: title font-weight=${titleLabel?.get_theme_node().get_font()?.get_weight()} ` +
          `(normal=400, bold=700)`);

    // the buttons are PanelMenu.Buttons with a real menu, so the shell's own
    // click gesture opens it
    const press = button => {
        const gesture = button?._clickGesture;
        print(`SMOKE: gesture on ${JSON.stringify(button?.label_actor?.text)} = ${!!gesture} ` +
              `menu=${!!button?.menu}`);
        gesture?.emit('recognize');
    };

    // the long menu has to be scrollable
    press(menuButtons[2]);
    await Scripting.sleep(600);
    const longMenu = bar._openMenu;
    const scrollView = longMenu?._scrollView;
    print(`SMOKE: long menu: items=${longMenu?._getMenuItems?.().length} ` +
          `scrollview=${!!scrollView} ` +
          `vscroll=${scrollView?.get_vscrollbar_visible?.()} ` +
          `maxHeight=${longMenu?.actor.get_theme_node?.().get_max_height?.()} ` +
          `actorHeight=${longMenu?.actor.height} ` +
          `contentHeight=${scrollView?.get_child?.()?.height} ` +
          `binHeight=${longMenu?._boxPointer?.bin?.height} ` +
          `scrollHeight=${scrollView?.height} ` +
          `binMax=${longMenu?._boxPointer?.bin?.get_theme_node?.().get_max_height?.()} ` +
          `actorStyle=${JSON.stringify(longMenu?.actor.style)}`);

    // a lazily built menu is fetched by the menu itself, when it is
    // opened -- not in a pass over all of them when the content is set,
    // because that would change the size of a menu that is open
    print(`SMOKE: the lazy menu is not read in advance: ` +
          `${bar._entries[3].menu._getMenuItems().length} items`);
    press(menuButtons[3]);
    await Scripting.sleep(600);
    const lazyMenu = bar._openMenu;
    print(`SMOKE: lazy menu items=${lazyMenu?._getMenuItems?.().length ?? 0} ` +
          `visible=${lazyMenu?.actor.visible} mapped=${lazyMenu?.actor.mapped}`);

    // a top-level menu is refreshed when it is opened: the application adds
    // the items it only builds when the menu is shown
    press(menuButtons[4]);
    await Scripting.sleep(400);
    const freshMenu = bar._openMenu;
    print(`SMOKE: refreshed menu items=${freshMenu?._getMenuItems?.().length ?? 0} ` +
          `labels=${JSON.stringify((freshMenu?._getMenuItems?.() ?? [])
              .map(i => i.label?.text))}`);

    // an ordinary menu
    press(menuButtons[0]);
    await Scripting.sleep(700);
    print(`SMOKE: open button=${bar._openButton === menuButtons[0]} ` +
          `pseudo=${JSON.stringify(bar._openButton?.get_pseudo_classes?.() ?? [])} ` +
          `hasActive=${bar._openButton?.has_style_pseudo_class?.('active')} ` +
          `classes=${JSON.stringify(bar._openButton?.get_style_class?.() ?? '')}`);
    const our = bar._openMenu;
    print(`SMOKE: our menu exists=${!!our} visible=${our?.actor.visible} ` +
          `inStage=${!!our?.actor.get_stage()} mapped=${our?.actor.mapped} ` +
          `sourceAlignment=${our?._boxPointer?._sourceAlignment} ` +
          `arrowAlignment=${our?._boxPointer?._arrowAlignment} ` +
          `radius=${our?.box.get_theme_node().get_border_radius(St.Corner.TOPLEFT)}`);
    const items = our?._getMenuItems?.() ?? [];
    const firstItemLabel = items[0]?.label;
    print(`SMOKE: entry font-weight=${firstItemLabel?.get_theme_node().get_font()?.get_weight()}`);

    // the items have to keep their type: a submenu of its own, a greyed
    // out item, a checked one
    const submenu = items.find(i => i.label?.text === 'Toolbars');
    const greyed = items.find(i => i.label?.text === 'Repair Text Encoding');
    const checked = items.find(i => i.label?.text === 'Full Screen');
    const PopupMenu = await import('resource:///org/gnome/shell/ui/popupMenu.js');
    print(`SMOKE: types: submenu=${!!submenu?.menu} ` +
          `greyed=${greyed?.sensitive === false} reactive=${greyed?.reactive} ` +
          `checked=${checked?._ornament === PopupMenu.Ornament.CHECK} ` +
          `submenuItems=${submenu?.menu?._getMenuItems?.().length ?? 0}`);

    // the dbusmenu parser has to know the type of an item, and it has to
    // recognise the empty item an application puts in place of a menu it
    // has not built
    {
        const {DBusMenuSource} = await import('file:///home/bashh/.local/share/gnome-shell/extensions/menubar@local/sources/dbusmenu.js');
        const source = new DBusMenuSource();
        // the shape _parseItem returns: {id, props, children}
        const item = (id, props, children = []) => ({id, props, children});
        const build = (props, children = []) =>
            source._buildNode(item(1, props, children), ':1.0', '/com/canonical/menu/0');

        const submenuNode = build({label: 'Sub', 'children-display': 'submenu'}, [
            item(2, {label: 'Item'}),
        ]);
        const separator = build({type: 'separator'});
        // a menu the application has not built: one empty item in it
        const unbuilt = build({label: 'Empty', 'children-display': 'submenu'}, [
            item(3, {}),
        ]);
        // the empty item on its own is not an item at all
        const empty = build({});

        print(`SMOKE: dbusmenu types: submenu=${submenuNode.type} ` +
              `separator=${separator.type} ` +
              `unbuilt=${unbuilt.unbuilt === true && unbuilt.children.length === 0 && !!unbuilt.activate} ` +
              `placeholderDropped=${empty === null}`);
    }

    // a submenu has to come up with its items and a height: the content of
    // a submenu is in a scroll view already, and putting a second one
    // around it would leave it without a height
    if (submenu?.menu) {
        submenu.menu.open();
        await Scripting.sleep(400);
        const subItems = submenu.menu._getMenuItems?.() ?? [];
        print(`SMOKE: submenu open: items=${subItems.length} ` +
              `visible=${submenu.menu.actor?.visible} ` +
              `mapped=${submenu.menu.actor?.mapped} ` +
              `height=${submenu.menu.actor?.height} ` +
              `labels=${JSON.stringify(subItems.map(i => i.label?.text ?? i.label))}`);
        submenu.menu.close();
    }
    print(`SMOKE:   items=${items.length} ` +
          `labels=${JSON.stringify(items.map(i => i.label?.text ?? i.label))} ` +
          `reactive=${JSON.stringify(items.map(i => i.reactive))}`);

    // does a *click* on a submenu item open the submenu?  In GNOME 50 a
    // submenu opens on a click, not when the pointer arrives.
    {
        const sub = items.find(i => i.menu);
        if (sub) {
            print(`SMOKE: submenu item "${sub.label?.text}" gesture=${!!sub._clickGesture}`);
            sub._clickGesture?.emit('recognize');
            await Scripting.sleep(500);
            print(`SMOKE: submenu opened by a click: open=${sub.menu.isOpen} ` +
                  `items=${sub.menu._getMenuItems?.().length}`);
            sub.menu.close();
        } else {
            print('SMOKE: no submenu item found');
        }
    }

    // a nested menu that the application has not built yet is empty, and
    // the shell does not open an empty menu: so the contents have to be
    // read before the menu is opened
    {
        const lazy = items.find(i => i.label?.text === 'Nested Lazy');
        print(`SMOKE: nested lazy item: found=${!!lazy}`);
        if (lazy) {
            print(`SMOKE: nested lazy before: open=${lazy.menu.isOpen} ` +
                  `items=${lazy.menu._getMenuItems?.().length}`);
            lazy.activate();
            await Scripting.sleep(900);
            print(`SMOKE: nested lazy after: open=${lazy.menu.isOpen} ` +
                  `items=${lazy.menu._getMenuItems?.().length} ` +
                  `labels=${JSON.stringify(lazy.menu._getMenuItems?.().map(i => i.label?.text))}`);
            lazy.menu.close();
        }
    }

    // the menu passing: with the File menu open, the pointer over the Edit
    // title switches the open menu
    const editButton = menuButtons[1];
    // the nested shell has no panel geometry, so the hit test is faked
    bar._titleAt = () => bar._entries[1];
    bar._onMenuMotion(bar._openMenu, {getCoords: () => [10, 10]});
    await Scripting.sleep(500);
    print(`SMOKE: passed to Edit: open=${bar._openButton === editButton} ` +
          `items=${bar._openMenu?._getMenuItems?.().length ?? 0} ` +
          `fileClosed=${!menuButtons[0]?.menu?.isOpen}`);

    // activate the first item
    bar._openMenu?._getMenuItems?.()[0]?.emit('activate', null);
    await Scripting.sleep(400);

    // the structure check: when the application's menubar changes, the bar
    // has to pick the new titles up
    const state = Main.extensionManager.lookup('menubar@local').stateObj;
    state._titleSource = {
        getTitles: () => ['Alpha', 'Beta'],
    };
    state._sources = [{
        name: 'fake',
        getMenus: async () => [
            {label: 'Alpha', type: 'standard', children: []},
            {label: 'Beta', type: 'standard', children: []},
        ],
    }];
    // a window to work with: the nested shell has none
    state._focusedWindow = () => ({
        get_pid: () => 4242,
        get_gtk_application_id: () => null,
        get_wm_class: () => 'fake',
        get_title: () => 'Fake',
        get_stable_sequence: () => 1,
        get_window_type: () => 0,
    });
    state._bar.setContent('Test', [{label: 'Old', type: 'standard', children: []}]);
    print(`SMOKE: pre-check titles=${JSON.stringify(state._bar.titles)} ` +
          `updateId=${state._updateId} gen=${state._generation}`);
    state._checkStructure();
    await Scripting.sleep(1500);
    print(`SMOKE: post-check titles=${JSON.stringify(state._bar.titles)} ` +
          `updateId=${state._updateId} gen=${state._generation}`);
    print(`SMOKE: after structure change: ${JSON.stringify(state._bar.titles)}`);

    // the optimistic update: the name is shown at once, the menus follow
    state._onFocusChanged();
    print(`SMOKE: optimistic: titles=${JSON.stringify(state._bar.titles)} ` +
          `visible=${state._bar.visible} appName=${state._bar._titleLabel?.text}`);
    await Scripting.sleep(600);
    print(`SMOKE: after the data arrived: titles=${JSON.stringify(state._bar.titles)}`);

    // data of another context must not end up in the bar
    state._bar.setContent('Test', [
        {label: 'Mine', type: 'standard', children: [], context: 'mine'},
    ], 'mine');
    const mine = JSON.stringify(state._bar.titles);
    state._bar.setContent('Test', [
        {label: 'Foreign', type: 'standard', children: [], context: 'somebody-else'},
    ], 'mine');
    print(`SMOKE: context isolation: mine=${mine} afterForeign=${JSON.stringify(state._bar.titles)}`);

    // an item of an older context must not be activated
    let activated = false;
    state._bar.setContent('Test', [
        {label: 'Old', type: 'standard', children: [], context: 'mine',
         activate: () => { activated = true; }},
    ], 'mine');
    const staleItem = state._bar._entries[0]?.menu?._getMenuItems?.()[0];
    state._bar.setContent('Test', [
        {label: 'New', type: 'standard', children: [], context: 'mine'},
    ], 'mine');
    staleItem?.emit('activate', null);
    print(`SMOKE: stale item not activated: ${!activated}`);

    // does a *click* on a submenu item open the submenu?  In GNOME 50 a
    // submenu opens on a click, not when the pointer arrives.
    {
        const sub = bar._entries[0]?.menu?._getMenuItems?.().find(i => i.menu);
        if (sub) {
            print(`SMOKE: submenu item "${sub.label?.text}" gesture=${!!sub._clickGesture}`);
            sub._clickGesture?.emit('recognize');
            await Scripting.sleep(500);
            print(`SMOKE: submenu opened by a click: open=${sub.menu.isOpen} ` +
                  `items=${sub.menu._getMenuItems?.().length}`);
            sub.menu.close();
        } else {
            print('SMOKE: no submenu item found');
        }
    }

    // what is in the panel, and where: the bar has to fit next to the
    // other items, and it must not cover them
    {
        const panel = Main.panel;
        const dump = (name, box) => {
            if (!box)
                return;
            const children = box.get_children();
            print(`SMOKE: panel ${name}: ${children.length} children`);
            for (const child of children) {
                const [x] = child.get_transformed_position();
                const classes = child.style_class ?? '';
                const label = child.accessible_name ?? '';
                print(`SMOKE:   ${JSON.stringify(label)} classes=${JSON.stringify(classes)} ` +
                      `x=${Math.round(x)} w=${child.get_width()} h=${child.get_height()}`);
            }
        };
        dump('left', panel._leftBox);
        dump('centre', panel._centerBox);
        dump('right', panel._rightBox);
    }

    print('SMOKE: done');
    Meta.exit(Meta.ExitCode.SUCCESS);
}

export function finish() {
    print('SMOKE: finish()');
}
