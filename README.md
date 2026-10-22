# Menu Bar (`menubar@local`)

A macOS-style global menu bar for GNOME Shell: the focused application's menus
appear in the top bar.

## Sources

Menus are collected from the first source that has something:

| source | what it gives | who provides it |
|---|---|---|
| **dbusmenu** | a real menubar tree: labels, separators, checkable items, disabled items, keyboard shortcuts | Chromium, Firefox (on X11/XWayland), GTK3 apps with `appmenu-gtk-module`, Qt apps |
| **org.gtk.Actions** | the app's and window's GAction groups (synthesised into File/Edit/View/Go/Help, labels derived from action names) | libadwaita / GTK4 apps (GNOME Calendar, Epiphany, …) |
| **AT-SPI** | the accessible `MENU_BAR` widget | GTK3 / Qt apps that export nothing over D-Bus |

If nothing is found the bar shows just the application name.

## No screen reader required

Firefox and Chromium only initialise their AT-SPI bridge when an event
listener appears on the accessibility bus: at-spi2's registry emits
`EventListenerRegistered` when a client calls `RegisterEvent`, and the
browsers watch for that. A screen reader (Orca) does exactly this — which
is why they stay silent until one is running.

The extension registers the same event itself (`sources/fakeat.js`), so
those browsers publish their accessibility trees (and with them their
menubars) without a screen reader being involved.

## Lazily built menus

Firefox builds a menubar's popup only when the menu is actually opened, so
the top-level titles exist but their items do not. An AT-SPI tree of titles
only is rejected (`getMenus: NOT READY (titles only)`): showing it would
give menus with nothing in them. Firefox is served by the dbusmenu source
instead, which has the same tree without touching the application.

The AT-SPI source also does not open menus inside the application
(`OPEN_MENUS_IN_APPLICATION`): that takes the pointer grab, the popup is
visible in the window, and a menu left open blocks the application.

The tree of an application changes while it runs, so the menus inside the
menubar are read again when they are shown: OpenTabletDriver fills its
presets a moment after its window appears, and until then its menu says
"No presets loaded" — which the bar would show for as long as the
application stays focused.  The items of the *menubar* itself are the
structure of the application and do not change, so they are not read
again.

## AT-SPI runs in its own process

libatspi's calls are synchronous and cannot be given a timeout. Walking the
accessibility tree of an application that does not answer — a browser that
has just started, a toolkit whose bridge is not up yet — blocked the
compositor's thread until the D-Bus default timeout. Measured once: the
whole desktop frozen for 16 seconds after a fresh Firefox window appeared.

So `sources/atspi.js` only starts
`helpers/atspi-helper.js` (`gjs -m`, pid + window title on the command
line) and reads one JSON answer from its stdout. The helper is killed when
it does not answer in time, and nothing it does can block the shell. The
cost is the process start: an AT-SPI read takes about 150–250ms instead of
60–200ms, and the result is cached where that is safe (titles for 8s, "no
usable menus" for 30s).


**The read has to happen before our popup opens.** Opening the
application's own menu takes the pointer grab, and a grab taken by a client
dismisses the shell's own modal popup — so opening ours first and reading
afterwards leaves the user staring at the application's menu instead of
ours. The items are cached, so the application's menu is only opened once
per menu.

The application's menu is visible for a moment while it is being read, so
the result is **cached per application and menu**: the flash happens once
per menu, not on every click. Items of a closed menu are defunct, so
activating one re-opens the menu, activates the item and closes it again.

If you want no flash at all for Firefox, run it on X11
(`MOZ_ENABLE_WAYLAND=0` plus `widget.gtk.global-menu.enabled=true`): it
then exports the menu over dbusmenu, which needs no opening at all, and
the extension prefers that source.

Closing the application's own menu again is done with Escape first (clean,
cannot hit the wrong item) and only then by clicking the menu item —
Firefox's XUL code can hit an internal error while re-parenting a popup
that is being destroyed.

## Reloading the extension

`gnome-extensions enable/disable` re-runs `enable()`, but the ES module
is **cached per shell process**, so changes to the code are only picked
up after the session is restarted (log out and back in). Only the data
(the desktop files, the a11y bus) is re-read live.

## Application names

The bar shows the name the application wants to be called, which comes from
its desktop entry (`Name`, localised) — not from the WM class. So
OpenTabletDriver.UX shows as *OpenTabletDriver* and firefox as
*Mozilla Firefox*. The desktop entries are indexed by their
`StartupWMClass` / `X-GNOME-WMClass` / `Exec` binary, and looked up through
`GioUnix.DesktopAppInfo` (the API moved out of `Gio` in newer GLib).

Several entries can claim the same class, and then the title of the window
decides. A Chromium web app is a desktop entry that starts the browser:

```
Exec=/usr/bin/chromium --profile-directory=Default --app-id=dnfpo… %U
```

The binary of that line is `chromium`, which is the class of every
ordinary Chromium window as well — so without care the web app takes the
name of the browser (or the other way round, depending on the order the
files happen to be read in). The entry that starts the program itself is
therefore preferred over the ones that run something inside another
program, and the title of the window breaks the remaining ties: a web app
shows its own name, the browser puts its own name at the end
(*Photopea - Chromium*).

## Debugging

Everything logs through `print()` (not `console.debug`, which the default
journal view filters out), through `debug.js`.  Every line is prefixed with
the seconds since the module was loaded and the section it comes from, so a
single grep shows the whole life of an update:

```sh
journalctl --user -b -p debug | grep 'menubar\['
```

```
menubar[    7.835] bar: title "Fresh" type=submenu children=1 unbuilt=false fetchable=true
menubar[   11.929] bar: menu "Fresh" OPEN items=1 readPromise=false context=1 current=1
menubar[   11.929] bar: fetching "Fresh" (the menu was opened)
menubar[   11.980] bar: "Fresh": 2 items in 51ms (the menu was opened) [Old Item, Fresh Item]
```

The sections are `ext` (focus, the source race, which source won and why),
`bar` (every menu open/close, read, fill and activation), `dbusmenu`,
`atspi` and `gtk`.  The dbusmenu section prints the raw properties of every
node (`raw={...}`), which is what shows why an item is enabled, checked or
missing.

Every fetch says *why* it happened, so a line is enough to tell where a
menu came from and what it cost:

```
bar: fetching "History" (the pointer rests on the title)
dbusmenu: fetch "History" path=[History] object=:1.105/com/canonical/menu/0: 7 items before
dbusmenu: Event(opened) id=33555 :1.105/com/canonical/menu/0
dbusmenu: fetch "History": after 60ms, item id=33555, 25 raw children [Show All History, ..]
dbusmenu: fetch "History": 7 -> 25 items [Show All History, ..]
dbusmenu: Event(closed) id=33555 :1.105/com/canonical/menu/0
bar: "History": 25 items in 171ms (the pointer rests on the title) [Show All History, ..]
```

The reasons are `the pointer rests on the title`, `the pointer rests on the
item`, `the item was clicked`, `the menu was opened` and `the pointer moved
to another title`.  A menu that was fetched a moment ago says so instead of
fetching again, and a menu that is not opened says why (`the pointer is
elsewhere`).

Every fetch path logs, including the ones that used to be invisible: the
introspection of every path on the bus, the `GetLayout` of every item that
is read again, the `DescribeAll` of every action group, the
`AboutToShow`/`Activate` acknowledgements, and the path the application
name was found by.  The AT-SPI reader runs in its own process, and its
trace comes back on stderr and is relayed line by line:

```
menubar[    0.375] atspi: helper: [220ms] desktop: [11] "OpenTabletDriver.UX" has pid 673221 -> this is the one
menubar[    0.376] atspi: helper: [222ms] frame: using the fallback
```

Set `DEBUG` in `debug.js` to `false` to silence all of it.

### Looking at an application's dbusmenu without restarting the shell

`devkit/probe-dbusmenu.js` runs outside the shell and talks to the session
bus directly, so it works against the live session:

```sh
gjs -m devkit/probe-dbusmenu.js                     # every app on the bus
gjs -m devkit/probe-dbusmenu.js --pid 1234          # one application
gjs -m devkit/probe-dbusmenu.js --pid 1234 --probe History
```

`--probe LABEL` sends the `opened` event for that top-level menu, waits,
reads the tree again and prints what changed (and sends `closed` so the
application gets its grab back).  That is how the Firefox menu refresh was
found: `History` goes from 7 to 25 items and `Bookmarks` from 10 to 31 when
the application is asked to show them.

Clicking the application name in the bar forces a re-read, which is the
escape hatch if the focus tracking ever falls behind.

## Note on Firefox

Firefox draws its own menu bar inside the window; the global bar mirrors
it, it does not replace it. Hiding Firefox's menubar (View ▸ Toolbars ▸
Menu Bar) also removes it from the accessibility tree, which is where the
bar reads the items from.

## Requirements / caveats

* **Firefox works through AT-SPI** (with the realise step above); Chromium
  has no menubar at all, so it only ever offers its app-menu button.
* **Browsers need X11/XWayland for the *dbusmenu* path.** Chromium's and
  Firefox's `com.canonical.AppMenu.Registrar` call lives in their *X11* code
  path; on native Wayland they switch to the KDE `org_kde_kwin_appmenu`
  protocol, which Mutter does not implement (and which no GNOME Shell
  extension can add, because it is a compositor-side Wayland global).
  * Chromium: `--ozone-platform=x11`
  * Firefox: `MOZ_ENABLE_WAYLAND=0` and `widget.gtk.global-menu.enabled=true`
    in `about:config`
* GTK3 apps need `appmenu-gtk-module` (not installed here) to export menus;
  without it the AT-SPI path picks them up instead.
* GTK4/libadwaita apps export *actions*, not menus — the menu you see is
  synthesised, so the labels and grouping are our own.
* Chromium/Electron have no menubar at all (only the hamburger "app menu"),
  so they show up as a single app-menu button.

## The menu data of Firefox

Firefox exports its menubar as a **dbusmenu** object, and the export is
still in Firefox 157 -- it is in `widget/gtk/DBusMenu.cpp` and
`widget/gtk/NativeMenuGtk.cpp`, gated behind `widget.gtk.global-menu.enabled`
(default false).

What differs is only the *announcement*:

* On X11 the application calls `RegisterWindow()` on the
  `com.canonical.AppMenu.Registrar`, and the extension is that registrar.
* On Wayland the application tells the *compositor* about it, over
  `org_kde_kwin_appmenu_manager` -- a KWin protocol that Mutter does not
  implement. That is the whole reason a Wayland Firefox has no menus.

But the object itself is created by `dbusmenu_server_new()` and is on the
session bus either way, under `/com/canonical/menu/<n>`. So the extension
finds it there instead of waiting for an announcement: the connections of
the process are found through their pid, and the objects by introspection
(one call per level, since the bus daemon knows the children of a path).

The result is the whole tree, with the accelerators, the states of the
items and the submenus -- and without opening a single menu in the
application. A Wayland Firefox is answered in about 170ms, and the
accessibility source is not needed for it at all.

An application with several windows exports one object per window; the
titles of the window (read from the accessibility source, which is cheap
because the items of a menubar are there whether it is open or not) say
which object belongs to the window in front.

### The export is a snapshot, and the menus are filled on show

The export is built from the XUL markup, so it has the structure of the
menus but not the state of the application.  Two consequences:

* An item whose command is currently unavailable (`Restore Previous Session`
  with no session to restore) is exported as **enabled**, because only the
  element's `disabled` attribute is visible to the export, not the state of
  the command.  Firefox's own menu greys it out; the export cannot.
* The parts a menu only gets when it is shown -- the history list, the
  bookmark list, `Mobile Bookmarks`, the recently closed tabs -- are **not**
  in the export.  They are added by the `popupshowing` handler of the
  places popup.  On a fresh Firefox the `History` menu has 7 items where
  its own menu has 25, and `Bookmarks` has 10 where its own has 31.

The protocol has the event for this: `opened` on a menu makes Firefox fire
`popupshowing` on its popup.  So the bar asks the application for the
contents of a menu, waits, reads the tree again and fills the menu with
what changed; `closed` follows so the application releases its grab (and
its own menubar keeps working).  Verified on the live profile:

```
fetch "History": 7 -> 25 items   [.., Tabs From Other Devices, ..]
fetch "Bookmarks": 10 -> 31 items [.., Mobile Bookmarks, <the bookmark list>..]
```

Ids are renumbered by the rebuild, so the item is found again by its label
path before `opened` and before `closed`.

### The bar is dynamic by construction

There is no snapshot of the menus of an application in the bar, and no
special case for the menus that change.  Every menu -- a title of the bar
as well as a menu inside a menu -- carries the way to get its current
contents, and the bar asks for them when it is about to show the menu:

```
node.fetch()   ->  the children the application has right now
```

For dbusmenu that is `_fetchMenu()`: it sends `opened` for the menu, waits
for the application to fill it, reads the tree again and rebuilds the
children from it.  The same call serves the history list of Firefox, the
bookmark list, and a folder of the bookmarks -- there is no difference
between them any more.

The bar fetches a menu

* when the pointer rests on it (a title or an item), so that the menu is
  current when it is clicked,
* when it is clicked, for the case that the pointer was never on it.

A menu that was fetched a moment ago is not fetched again, and the fetch
of a menu that is already running is shared.

### Asking the application to build a menu

The export of an application is a snapshot of its markup, and the parts
that are added when a menu is shown — the history list, the bookmark list,
the folders of the bookmarks — are not in it.  The dbusmenu protocol has
the event for that: `opened` makes the application show the menu, and it
fills it while doing so.

That is not free.  The application shows the menu **in its own window**,
with a grab, and in some builds (a browser with a title bar of its own)
the buttons of the title bar do not come back afterwards.  So the bar asks
for it as rarely as it can:

* a pointer that merely rests on a title only **reads** what the
  application has — the application is not asked to build anything, so
  nothing happens in its window;
* the application is asked when the user **opens** a menu in the bar, or
  when a menu the application has not built at all is opened (it is empty
  otherwise).

`DEMAND_MENUS` in `sources/dbusmenu.js` turns the asking off entirely; the
bar then shows what the export holds, without the parts that are filled
when a menu is shown.

The application builds the menu while it handles the `opened` event, but
it does not *finish* before the call returns: the build takes about 130ms
and the call comes back after 14ms, so reading right after the call finds
a half-built menu (measured: 7 of 25 items in the history list).

The application says when it is done: the model is rebuilt when the menu
is built, and that is the `LayoutUpdated` signal.  So the bar waits for
that signal — but not longer than half a second, and the menu is closed
either way.  With that, the menu is complete the *first* time it is
opened, instead of needing a second or third try.

**One build per menu.**  Every build makes the application show a menu in
its own window, and that is what breaks the title bar of some builds, so
the bar builds a menu only when it has to: a menu that the application has
already built is simply read.  The revision of the model says whether that
is the case — it changes with every rebuild of the model — and the build
of each menu is remembered with it, so a second look at the same menu
costs nothing (measured: 24ms, and no build at all).

The `opened` event for the *root* of the menu tree, which would build every
menu of the menubar at once, does not work with Firefox: the export
builds only the menu that is named.  So it is one build per menu, and
the bar asks for a menu only when the user opens it — a pointer that
merely rests on a title only reads what the application already has.

The ids do not survive that: the application renumbers its model when it
rebuilds it, so the menu is opened with one id and has another one
afterwards.  Both are closed again — an id the application does not know
is ignored, but the id it was opened with has to be closed, or the menu
stays open in the application.


### The watch

Asking the application for a menu is not free: it builds the menu in the
application, which takes Firefox about 170ms.  So the bar watches the
menu object instead of asking all the time.

The dbusmenu protocol has the means for that: the interface of a menu
object has the signals `LayoutUpdated(revision, parent)` and
`ItemsPropertiesUpdated`, and the application sends them when it rebuilds
its model.  Firefox does send them -- measured on the live profile:
```
dbusmenu: watching :1.115/com/canonical/menu/0 for layout changes
dbusmenu: watch: LayoutUpdated on :1.115/com/canonical/menu/0 (revision=4809 parent=0)
dbusmenu: watch: ItemsPropertiesUpdated on :1.115/com/canonical/menu/0 (1 updated, 0 removed)
```

(The signal only comes when the model is *rebuilt* -- so a test that opens
a menu that was open before sees nothing, which is how it looked as if
Firefox never sent it.)

The revision of the tree is the second watch: it changes with every
rebuild of the model, and asking for it is cheap (only the root of the
menu is asked for).  It is what tells the bar that the tree it has is not
the tree of the application any more, even for an application that sends
no signals.

When the watch says that the model changed, the tree is simply read
again -- no `opened` is sent and nothing has to wait for the application:

```
dbusmenu: watch: the model of :1.115/com/canonical/menu/0 changed (the application said so), reading it again
dbusmenu: watch: "History" is now 25 items (was 25)
```

That path takes 30ms where the full fetch takes 174ms.

### The accessibility bus can be watched the same way

The AT-SPI tree of an application changes while it runs, and the
accessibility bus says so: the registry forwards the events of the tree to
the clients that registered for them, as signals on the bus --
`org.a11y.atspi.Event.Object` with the member `ChildrenChanged`,
`PropertyChange`, `StateChanged` or `ItemChanged`.  The sender of the
signal is the connection of the application, and the bus daemon knows which
process that is.

`sources/fakeat.js` already registers on that bus (it has to, or the
browsers would not publish their trees at all), so it subscribes to those
signals as well and reports the pid of the application whose tree changed.
The AT-SPI source marks that application as changed, and the next time one
of its menus is shown, it is read again -- and if the tree did *not*
change, nothing is read at all and no helper is started.

Measured on the live profile, with OpenTabletDriver reloading its presets:

```
menubar: object:property-change in 752679
*** the tree of 761803 changed
events: 4 [761803, 761803, 761803, 752679]
```

What the watch cannot replace is the *demand*: the export of an
application is a snapshot of its markup, and the application only builds
its menus when it shows them.  Asking the application to show a menu
(`opened`) is what makes it build it, and that is how the bar gets a
history list that is up to date.  So the demand is still sent when a menu
is shown -- but only when the watch has not already brought the bar up to
date.

Two rules make the result stable:

* **The contents of a menu are fetched before it is shown.**  The panel
  button of the shell opens its menu itself, so the bar takes that over:
  the menu waits for its content and is opened with it.  A menu that is
  open is never refilled -- its size would change under the pointer, and
  the items would move while the user is aiming at one.  The content that
  arrives while a menu is open is used the next time it is opened.
* **There is no pass over all the menus when the content is set.**  Such a
  pass (a "warm-up") read every menu that the application had not built
  yet, and the result landed in a menu that was open at that moment --
  which changed its size while the user was looking at it.  A menu that
  the application builds lazily is now fetched by the menu itself, when it
  is opened.

One catch makes the order important: **the shell does not open an empty
menu** (`PopupMenu.open()` returns when `isEmpty()`), so a menu that the
application has not built yet cannot be opened at all -- and a click on it
would do nothing, because the reading was supposed to happen when the menu
opens.  So the contents are always fetched *before* the menu is opened, and
the menu is opened once it has items.

## Shell API gotchas hit along the way

* **`PopupMenu.isOpen` is a property**, not a method, in GNOME 45+. Calling
  `menu.isOpen()` throws, and because the throw happened inside
  `closeAll()` it took the whole "open the menu" path down with it.
* **The shell does not open an empty menu.** `PopupMenu.open()` returns
  when `isEmpty()` — so a menu whose contents the application has not built
  yet cannot be opened at all, and the reading has to happen before.
* **A popup menu's actor has to be in the UI group.**
  `Main.uiGroup.add_child(menu.actor)` — without it `open()` throws
  `this.actor.get_parent() is null` and *nothing is displayed*. The shell's
  own `PanelMenu.Button.setMenu()` does exactly this.
* **`new PopupMenu.PopupMenu(sourceActor, arrowAlignment, arrowSide)`** —
  the second argument is an arrow alignment, not a params object.
* **A popup menu also needs a `PopupMenuManager`**, which handles the modal
  grab and closes the menu when clicking elsewhere.
* **A panel item has to be a real `PanelMenu.Button` with a real menu.**
  The apps-menu extension builds its button like this:

  ```js
  const button = new PanelMenu.Button(0, name, true);
  button.setMenu(new PopupMenu.PopupMenu(button, 0, St.Side.TOP));
  Main.panel.menuManager.addMenu(button.menu);
  ```

  `setMenu()` gives the button the shell's own click gesture, the modal
  grab, the `active` pseudo class and the keyboard navigation, and
  `menuManager.addMenu()` is what passes the "a menu is open in this panel"
  state from one button to the next: opening a menu closes the one that was
  open. A button with a hand-rolled gesture and a hand-rolled popup is
  invisible to all of that and behaves differently from every other button
  in the bar.
* **The bar is optimistic.** When the focus changes, the name of the
  application is shown right away and the menus follow when they have been
  read out of it. Waiting for the menus would keep the bar showing the
  menus of the application that was in front before. The visible result is
  that the application name never changes and only the *menu titles* appear
  a moment later — that flicker is expected. It could be removed by reusing
  the title buttons and only relabelling them, at the price of a more
  complicated life cycle for the menus.
* **The items have to keep their type — and the type depends on where the
  item was found.** Firefox describes its items with a `tag` attribute, but
  the same tag means two different things: the items of a *menubar* are
  tagged `menu` (they are the menus of the application), and an item of a
  *popup* is tagged `menu` as well when it opens a menu of its own. So the
  type is only meaningful together with the container the crawler found the
  item in:

  | container | the items are |
  |---|---|
  | a menubar (`tag=menubar`) | the menus of the application |
  | a popup (`role=MENU`) | leaves, or menus of their own (`tag=menu`) |
  | a toolbar (`tag=toolbar`) | buttons with a dropdown — not menus |

  `menuseparator` is a separator, `checkable` marks an item that carries a
  check mark, and the states say whether an item can be used at all — one
  without `ENABLED` and `SENSITIVE` is greyed out in the application — and
  `CHECKED` says the check mark is set. Without reading those, every menu is
  a flat list of labels.
  The *contents* of a submenu cannot be read through AT-SPI: Firefox builds
  them when the submenu is hovered, and neither a programmatic click, nor a
  synthesised mouse event, nor a synthesised key reaches that — only a real
  pointer does. So a submenu shows up with its arrow and with the items the
  application happened to build already, and an item whose contents are
  missing opens the application's own menu instead of an empty popup.
  Firefox does not expose the accelerator of an item (`F11`) either, so that
  one only comes with the dbusmenu source — which needs Firefox on X11
  (`MOZ_ENABLE_WAYLAND=0`), because its dbusmenu export lives in its X11
  code path.
* **The dbusmenu export of an application is a snapshot of its markup.**
  Firefox builds the model of the menus from the XUL document, and it only
  refreshes it while its own menubar is open.  So the export knows the
  *structure* of the menus, but not their live state: an item whose command
  is currently unavailable (`Restore Previous Session` when there is no
  session to restore) is exported as enabled, and an item that is only
  filled when the menu opens (the bookmark folders, the profile list) is
  exported as an empty item.
* **A menu the application has not built is asked for with the `opened`
  event.** Firefox fills the menus it builds when they are opened -- the
  bookmark folders, the profiles -- and it puts an empty item in place of
  the contents until then.  The dbusmenu protocol has an event for that:
  `opened` makes the application show the menu, and it fills it while doing
  so.  Without it there is no data for such a menu.
  The id of an item is not stable either: the application renumbers its
  model every time it rebuilds it, and filling a menu is a rebuild -- so the
  item is looked up again by its path in the tree before the event is sent.
* **A submenu is a scroll view already.** `PopupSubMenu` puts its content
  into an `St.ScrollView`, while a `PopupMenu` puts it into the bin of a
  boxpointer.  Wrapping both in a scroll view leaves the content of a
  submenu without a height, and the submenu comes up empty.
* **A dbusmenu item is a menu of its own when it says so.** A menu of its
  own has `children-display` set to `submenu` -- that is the only mark it
  has.  Without reading it, every submenu is a plain item and its contents
  are never shown.
* **`AboutToShow` wants the id of the menu, not of the item.** It is what
  tells the application that a menu is about to be shown, so that it builds
  it -- an application that builds its menus when they are opened needs
  that, or the item is not there yet.  The id of the menu an item is in is
  remembered while the tree is read.
* **A source has to say when it is not ready.** The accessibility source
  can only read the tree that the application publishes.  A toolkit that
  builds its menus when they are opened (XUL, and so Firefox) publishes
  only the *titles* of the menubar there -- the items appear when the menu
  is opened.  A tree of titles is of no use, and it answers faster than a
  source that has the whole tree, so the source says that it is not ready
  and lets the dbusmenu source answer instead.
* **A menu that is left open in the application blocks the application.**
  Firefox stops responding with one of its own menus open. Whether a menu is
  still open is told by its `EXPANDED` state — the number of children does
  not tell, the application keeps the popup's items in the tree after the
  popup is closed. The close is verified, and a failure aborts the reading
  instead of opening more menus.
* **Data has to be bound to the context it was read for.** The sources tag
  every node with the window it came from (`pid:window`), and the bar keeps a
  context counter that changes with every `setContent()`. A model of another
  context is dropped, a read that finishes after the bar moved on is
  discarded, and an item of an older context is not activated. The menu
  components are reused, but never the data behind them.
* **While a menu is open the pointer is grabbed**, so the pointer motion
  arrives at the menu's actor, not at the buttons. That is where the
  "hover to the next title switches the menu" behaviour is implemented.
* **`gnome-extensions pack` only picks up `metadata.json`, `stylesheet.css`
  and `extension.js`** — a packed install of this extension would be broken.
  `devkit/run.sh` therefore builds the bundle itself.
* **A JS exception inside a `GLib.timeout_add` callback removes the
  timeout** — the poll stops silently. Everything scheduled from the
  extension is wrapped in try/catch for that reason.
* **`console.debug` does not reach the journal** (it is filtered out at
  the default priority), so the extension logs with `print()` instead.
* **`Meta.Window.get_id()` is the X11 window id** and is always 0 for
  native Wayland clients. `get_stable_sequence()` is the identity that
  works everywhere (a unique, monotonic number per window), and that is
  what the focus poll compares.

## Implementation notes (the non-obvious parts)

These are the details that silently break a global menu implementation:

* **Registrar signature.** Apps call `RegisterWindow(u windowId, o menuPath)`
  — the modern `"uo"` form. The legacy protocol used `(o window, u timestamp)`.
  Chromium's and Firefox's D-Bus libraries resolve a method by name *and*
  verify the in-signature, so a mismatching signature means the call is never
  even sent: the app just never registers.
* **GetLayout signature.** Chromium and Firefox implement
  `GetLayout(i parentId, i recursionDepth, as propertyNames)`, not the
  specification's `(u revision, i parentId, as)`. Calling it spec-style
  returns an empty tree, which looks exactly like "this app has no menu".
* **Window ids are opaque.** The registrar key is *not* an X window id
  (Chromium uses its browser frame id, Firefox its own counter), so a focused
  window is resolved to its registration through the process id of the bus
  name that called `RegisterWindow`.
* **GJS 1.88 variant pitfalls.** `GLib.Variant.get_string()` returns
  `"[text,length]"` instead of the string, and `unpack()` on a string array
  yields `[{},{}]`. Values are therefore unwrapped by hand
  (`sources/dbusmenu.js:_unwrap`).
* **A `Glib.Variant` of type `v` inside `av`** is how Chromium wraps each
  layout child; the parser unwraps it.

## The clock

GNOME 50 puts the clock in the *centre* of the top bar (the session mode
lists `center: ['dateMenu']`), with the control centre (`quickSettings`)
last in the right box. The extension moves the clock behind the control
centre, i.e. to the far right corner, and puts it back when the extension
is disabled.

The panel re-applies the session-mode layout whenever the session mode
changes (`Main.sessionMode` `updated` -> `Panel._updatePanel()`), which would
send the clock back to the centre, so the move is re-applied on that signal.

## Files

```
extension.js          lifecycle, focus tracking, source fallback
menubar.js            the panel strip + popup menus
debug.js              the logging helpers (DEBUG, log, dumpTree)
sources/dbusmenu.js   Canonical Registrar host + com.canonical.dbusmenu client
                      (and the watch on the LayoutUpdated signal)
sources/gtkactions.js org.gtk.Actions reader (app + window action groups)
sources/atspi.js      the AT-SPI source (runs the reader out of process)
helpers/atspi-helper.js  walks an app's accessibility tree, answers in JSON
sources/clock.js      moves the clock from the centre to the right corner
sources/fakeat.js      registers us as an AT client so browsers publish trees
sources/appnames.js    resolves the application's own name from its .desktop
devkit/probe-dbusmenu.js  reads (and probes) an app's dbusmenu outside the shell
test_sources.js       standalone test of the source layer (no shell needed)
```

## Testing the sources without the shell

```sh
gjs -m test_sources.js 20          # owns the Registrar, prints every menu tree
chromium --ozone-platform=x11 --user-data-dir=/tmp/x --no-first-run about:blank
```

## Testing without touching the live session

GNOME imports an extension's module once per shell process and
`EnableExtension` does not re-import it, so **code changes need a session
restart**.  The Mutter *development kit* gives a way to test without that:

```sh
./devkit/run.sh
```

boots a nested GNOME Shell (`gnome-shell-test-tool --devkit`) with the
extension installed and enabled, on its own D-Bus session, and runs
`devkit/smoke.js` inside it.  The nested shell prints the extension's state
and the panel layout, and — unlike the live session — it can be started
and stopped as often as you like.

## Enabling

```sh
gnome-extensions enable menubar@local
```

On Wayland the shell has to be restarted for a new extension to load: log out
and back in (on X11, `Alt+F2` → `r`).
