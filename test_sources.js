/* Standalone test of the menu sources (no GNOME Shell involved).
 *
 *   gjs -m test_sources.js <seconds>
 *
 * Owns com.canonical.AppMenu.Registrar exactly like the extension does and
 * prints every registration plus the menu tree it yields.
 */

import GLib from 'gi://GLib';

import {DBusMenuSource} from './sources/dbusmenu.js';
import {GtkActionsSource} from './sources/gtkactions.js';
import {AtspiSource} from './sources/atspi.js';

const DURATION = Number(ARGV[0] ?? 20);

function printTree(nodes, indent = 0) {
    for (const node of nodes) {
        if (node.type === 'separator') {
            print(`${'  '.repeat(indent)}---`);
            continue;
        }
        const flags = [
            node.enabled === false ? 'disabled' : null,
            node.toggle ? 'checked' : null,
            node.shortcut ? `<${node.shortcut}>` : null,
        ].filter(Boolean).join(' ');
        print(`${'  '.repeat(indent)}${node.label} ${flags}`.trimEnd());
        if (node.children?.length)
            printTree(node.children, indent + 1);
    }
}

const dbusmenu = new DBusMenuSource();
const gtkactions = new GtkActionsSource();
const atspi = new AtspiSource();

const originalRegister = dbusmenu._register.bind(dbusmenu);
dbusmenu._register = (sender, windowId, path) => {
    originalRegister(sender, windowId, path);
    print(`REGISTER sender=${sender} windowId=${windowId} path=${path}`);
    dbusmenu._pidForBusName(sender, pid => {
        print(`  -> pid ${pid}`);
        dbusmenu.getMenus({pid}).then(nodes => {
            if (!nodes || !nodes.length) {
                print('  -> no menu tree');
                return;
            }
            print(`  -> ${nodes.length} top-level menus:`);
            printTree(nodes, 2);
        });
    });
};

dbusmenu.start();
gtkactions.start();
atspi.start();

// libadwaita app (GNOME Calendar): org.gtk.Actions source
gtkactions.getMenus({appId: 'org.gnome.Calendar'}).then(nodes => {
    print(`GTK ACTIONS (org.gnome.Calendar): ${nodes ? nodes.length : 'null'}`);
    if (nodes) printTree(nodes, 1);
}).catch(e => print('GTK ACTIONS failed: ' + e.message));

// GTK3 app (OTD): AT-SPI source
atspi.getMenus({pid: 36802}).then(nodes => {
    print(`AT-SPI (pid 36802): ${nodes ? nodes.length : 'null'}`);
    if (nodes) printTree(nodes, 1);
}).catch(e => print('AT-SPI failed: ' + e.message));

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, DURATION * 1000, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

print('--- done');
dbusmenu.stop();
