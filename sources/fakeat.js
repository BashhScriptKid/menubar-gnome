/* Register ourselves as an assistive-technology client on the accessibility
 * bus.
 *
 * Firefox (and Chromium) only initialise their AT-SPI bridge once an event
 * listener appears on the a11y bus: at-spi2's registry emits
 * `EventListenerRegistered` when a client calls `RegisterEvent`, and the
 * browser watches for that.  A screen reader (Orca) does exactly this, which
 * is why those browsers stay silent until one is running.
 *
 * Registering the same event ourselves means their accessibility trees are
 * published without a screen reader being involved — and we want them
 * published anyway, because that is where the menubar lives.
 *
 * The registration also makes the bus send us the events of the tree, which
 * is the counterpart of the `LayoutUpdated` signal of dbusmenu: when the
 * tree of an application changes, the registry tells us, and the bar knows
 * that what it has read is not what the application has.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const A11Y_BUS_ADDRESS = 'unix:path=/run/user/1000/at-spi/bus';


/*
 * The events that say "the tree changed".
 *
 * They arrive as signals on the accessibility bus: the interface is
 * `org.a11y.atspi.Event.Object` and the member is the name of the event in
 * camel case ("object:children-changed" -> "ChildrenChanged").  The sender
 * of the signal is the connection of the application whose tree changed.
 */
const EVENTS = [
    ['object:children-changed', 'ChildrenChanged'],
    ['object:item-changed', 'ItemChanged'],
    ['object:property-change', 'PropertyChange'],
    ['object:state-changed', 'StateChanged'],
];

export class FakeATClient {
    constructor() {
        this._connection = null;
        this._pids = new Map();      // bus name -> pid
        /* called with the pid of the application whose tree changed */
        this.onEvent = null;
    }

    async start() {
        if (this._connection)
            return false;

        /*
         * The accessibility bus of *this* session.  The path is not the same
         * everywhere: a nested session has a bus of its own, and a browser
         * only publishes its tree when there is a client on the bus of its
         * own session.  So the address is asked for.
         */
        let address = null;
        try {
            const reply = await Gio.DBus.session.call('org.a11y.Bus', '/org/a11y/bus',
                'org.a11y.Bus', 'GetAddress', null, new GLib.VariantType('(s)'),
                Gio.DBusCallFlags.NONE, 5000, null);
            address = reply.deepUnpack()[0];
        } catch (e) {
            print(`menubar: cannot ask for the accessibility bus: ${e.message}`);
        }
        address = address ?? A11Y_BUS_ADDRESS;

        try {
            this._connection = Gio.DBusConnection.new_for_address_sync(
                address,
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
                Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                null, null);
        } catch (e) {
            print(`menubar: cannot reach the accessibility bus (${address}): ${e.message}`);
            this._connection = null;
            return false;
        }

        // the events arrive as signals of the accessibility bus
        for (const [event, member] of EVENTS) {
            this._subscribe(event, member);
        }

        /*
         * The registration has to be done for every kind of event, and the
         * `document:attributes-changed` one is what makes the browsers
         * publish their trees at all.
         */
        for (const event of ['document:attributes-changed', ...EVENTS.map(e => e[0])]) {
            this._registerEvent(event);
        }

        return true;
    }

    _subscribe(event, member) {
        try {
            this._connection.signal_subscribe(null, 'org.a11y.atspi.Event.Object', member,
                null, null, Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) =>
                    this._onEvent(event, member, sender, params));
        } catch (e) {
            print(`menubar: cannot listen for ${event}: ${e.message}`);
        }
    }

    _registerEvent(event) {
        this._connection.call('org.a11y.atspi.Registry', '/org/a11y/atspi/registry',
            'org.a11y.atspi.Registry', 'RegisterEvent',
            new GLib.Variant('(sass)', [event, [], '']),
            null, Gio.DBusCallFlags.NONE, 5000, null,
            (source, result) => {
                try {
                    source.call_finish(result);
                    print(`menubar: registered for the a11y event ${event}`);
                } catch (e) {
                    print(`menubar: the registration for ${event} failed: ${e.message}`);
                }
            });
    }

    /*
     * An event of the accessibility bus.
     *
     * The sender of the signal is the connection of the application whose
     * tree changed, and the bus daemon knows which process that is.
     */
    _onEvent(event, member, sender, params) {
        if (!sender)
            return;

        this._pidOf(sender).then(pid => {
            if (pid === null)
                return;
            print(`menubar: ${event} in ${pid}`);
            this.onEvent?.(pid);
        });
    }

    /* the process behind a bus name, asked of the bus daemon */
    _pidOf(busName) {
        if (this._pids.has(busName))
            return Promise.resolve(this._pids.get(busName));

        return new Promise(resolve => {
            this._connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [busName]), new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (source, result) => {
                    try {
                        const [pid] = source.call_finish(result).deepUnpack();
                        this._pids.set(busName, pid);
                        resolve(pid);
                    } catch (e) {
                        this._pids.set(busName, null);
                        resolve(null);
                    }
                });
        });
    }

    stop() {
        this._connection?.close_sync(null);
        this._connection = null;
    }
}
