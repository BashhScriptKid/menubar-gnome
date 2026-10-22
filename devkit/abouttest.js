import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DBusMenuSource} from '../sources/dbusmenu.js';

const pid = parseInt(ARGV[0]);
const label = ARGV[1] ?? 'Other Bookmarks';
const mode = ARGV[2] ?? 'about';

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
print(`"${label}": ${node?.children?.length} items, id=${node?.id}, unbuilt=${!!node?.unbuilt}`);

const conn = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const call = (method, variant, replyType) => new Promise(resolve => {
    conn.call(object.busName, object.path, 'com.canonical.dbusmenu', method,
        variant, replyType, Gio.DBusCallFlags.NONE, 3000, null, (s, r) => {
            try {
                const reply = s.call_finish(r);
                print(`${method}: acknowledged${reply ? ' ' + reply.deepUnpack() : ''}`);
            } catch (e) {
                print(`${method}: failed: ${e.message}`);
            }
            resolve();
        });
});

if (mode === 'about')
    await call('AboutToShow', new GLib.Variant('(i)', [node.id]), new GLib.VariantType('(b)'));
else
    await call('Event', new GLib.Variant('(isvu)',
        [node.id, 'opened', new GLib.Variant('s', ''), 0]), null);

await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

const after = await source.getMenus(descriptor);
const node2 = find(after, label);
print(`"${label}" now: ${node2?.children?.length} items, unbuilt=${!!node2?.unbuilt}`);
