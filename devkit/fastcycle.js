import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DBusMenuSource} from '../sources/dbusmenu.js';

const pid = parseInt(ARGV[0]);
const label = ARGV[1] ?? 'History';

const source = new DBusMenuSource();
const descriptor = {
    pid, appId: null, wmClass: 'firefox', title: 'Mozilla Firefox',
    windowKey: 'w', context: 'ctx',
};

const find = (nodes, name) => {
    for (const node of nodes ?? []) {
        if (node.label === name)
            return node;
        const deeper = find(node.children, name);
        if (deeper)
            return deeper;
    }
    return null;
};

const menus = await source.getMenus(descriptor);
const node = find(menus, label);
const object = source._lastObject.get(pid);
print(`"${label}": ${node?.children?.length} items, id=${node?.id}`);

const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const event = (id, name) => new Promise(resolve => {
    conn.call(object.busName, object.path, 'com.canonical.dbusmenu', 'Event',
        new GLib.Variant('(isvu)', [id, name, new GLib.Variant('s', ''), 0]),
        null, Gio.DBusCallFlags.NONE, 2000, null, (s, r) => {
            try {
                s.call_finish(r);
            } catch (e) {
                print(`${name} failed: ${e.message}`);
            }
            resolve();
        });
});

// opened and closed back to back, without waiting
const started = GLib.get_monotonic_time();
await event(node.id, 'opened');
await event(node.id, 'closed');
print(`the open/close cycle took ${((GLib.get_monotonic_time() - started) / 1000).toFixed(1)}ms`);

for (const wait of [0, 30, 100, 300]) {
    await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
    const after = await source.getMenus(descriptor);
    const node2 = find(after, label);
    print(`after ${wait}ms: "${label}" has ${node2?.children?.length} items`);
}
