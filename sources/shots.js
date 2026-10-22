/* Screenshots of the screen, for looking at what the bar does.
 *
 * The screenshots are taken *inside* the shell, so they need no portal and
 * no permission dialog: this is the same API the shell's own screenshot
 * user interface uses.  A session that runs in the devkit can therefore be
 * looked at from another terminal.
 *
 * They are only taken while a flag file exists:
 *
 *   mkdir -p ~/.cache && touch ~/.cache/menubar-capture   # start
 *   rm ~/.cache/menubar-capture                           # stop
 *
 * A screenshot is written every SHOT_INTERVAL_MS to
 * ~/.cache/menubar-captures/000.png, 001.png, ...  The whole screen is
 * taken, so a menu that the application shows for itself is in the picture
 * as well.
 */

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {log} from '../debug.js';

const SHOT_INTERVAL_MS = 700;
const FLAG = 'menubar-capture';
const DIRECTORY = 'menubar-captures';

export class Shots {
    constructor() {
        this._source = 0;
        this._screenshot = null;
        this._count = 0;
    }

    start() {
        if (this._source)
            return;
        this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOT_INTERVAL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        log('shot', `screenshots are taken while ~/.cache/${FLAG} exists`);
    }

    stop() {
        if (this._source) {
            GLib.source_remove(this._source);
            this._source = 0;
        }
    }

    _tick() {
        const cache = GLib.get_user_cache_dir();

        if (!GLib.file_test(`${cache}/${FLAG}`, GLib.FileTest.EXISTS))
            return;

        const directory = `${cache}/${DIRECTORY}`;
        GLib.mkdir_with_parents(directory, 0o755);

        const path = `${directory}/${String(this._count++).padStart(3, '0')}.png`;
        const width = global.screen_width;
        const height = global.screen_height;

        try {
            if (!this._screenshot)
                this._screenshot = new Shell.Screenshot();
            this._screenshot.screenshot_area(0, 0, width, height, path, (source, result) => {
                try {
                    source.screenshot_area_finish(result);
                    log('shot', `saved ${path}`);
                } catch (e) {
                    log('shot', `screenshot failed: ${e.message}`);
                }
            });
        } catch (e) {
            log('shot', `cannot take a screenshot: ${e.message}`);
        }
    }
}
