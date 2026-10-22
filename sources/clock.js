/* Move the clock out of the centre of the top bar.
 *
 * GNOME 50 puts the clock in the panel's *centre* box by default (the
 * session mode lists `center: ['dateMenu']`), while the control centre
 * (`quickSettings`) is the last item of the right box.  We move the clock
 * behind the control centre, i.e. to the far right corner.
 *
 * The panel re-applies the session-mode layout whenever the session mode
 * changes (`Main.sessionMode` 'updated' -> `Panel._updatePanel()`), which puts
 * the clock back into the centre, so the move has to be re-applied as well.
 */

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLOCK_STYLE_CLASS = 'menubar-clock';

export function moveClockToRight() {
    const panel = Main.panel;
    const dateMenu = panel.statusArea?.dateMenu;
    const clock = dateMenu?.container;
    const right = panel._rightBox;

    if (!clock || !right)
        return false;

    const parent = clock.get_parent();
    if (parent !== right) {
        if (parent)
            parent.remove_child(clock);
        right.add_child(clock);
    }

    // the clock keeps the padding it had in the centre, which leaves a
    // visible gap next to the other indicators
    clock.add_style_class_name(CLOCK_STYLE_CLASS);

    // the message banner follows the clock's side
    try {
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
    } catch (e) {
        // not fatal
    }

    return true;
}

export function restoreClock() {
    const panel = Main.panel;
    const clock = panel.statusArea?.dateMenu?.container;
    const center = panel._centerBox;

    if (!clock || !center)
        return false;

    const parent = clock.get_parent();
    if (parent !== center) {
        if (parent)
            parent.remove_child(clock);
        center.add_child(clock);
    }

    clock.remove_style_class_name(CLOCK_STYLE_CLASS);

    try {
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.CENTER;
    } catch (e) {
        // not fatal
    }

    return true;
}

/**
 * Dump the right hand part of the panel with the position and size of every
 * child, so the spacing between the indicators and the clock can be measured
 * instead of guessed at.
 */
export function dumpPanel() {
    const right = Main.panel._rightBox;
    if (!right)
        return;

    const describe = (actor, depth) => {
        // note: `allocation` is not readable through GJS, use the methods
        const [x, y] = actor.get_transformed_position();
        const width = actor.get_width();
        const height = actor.get_height();
        // style_class and accessible_name are properties, not methods
        const classes = typeof actor.style_class === 'string' ? actor.style_class : '';
        const name = typeof actor.accessible_name === 'string' ? actor.accessible_name : '';
        print(`menubar: ${'  '.repeat(depth)}${JSON.stringify(name)} ` +
            `classes=${JSON.stringify(classes)} ` +
            `x=${Math.round(x)} y=${Math.round(y)} w=${width} h=${height}`);
        return {x, width};
    };

    const describeTree = (actor, depth) => {
        for (const inner of actor.get_children()) {
            describe(inner, depth);
            if (depth < 3 && inner.get_children().length)
                describeTree(inner, depth + 1);
        }
    };

    try {
        print(`menubar: right box spacing=${right.spacing ?? '?'}`);
        let previousEnd = null;

        for (const child of right.get_children()) {
            let alloc;
            try {
                alloc = describe(child, 0);
            } catch (e) {
                print(`menubar:   (child not describable: ${e.message})`);
                continue;
            }

            const gap = previousEnd === null ? 0 : alloc.x - previousEnd;
            if (gap)
                print(`menubar:   ^ ${Math.round(gap)}px gap before this one`);
            previousEnd = alloc.x + alloc.width;

            // the clock is a component with an inner box: show its parts
            try {
                if ((child.style_class ?? '').includes('clock-display'))
                    describeTree(child, 1);
            } catch (e) {
                // ignore
            }
        }
    } catch (e) {
        print(`menubar: could not dump the panel: ${e.message}`);
    }
}
