/* The one thing an application cannot be told from outside.
 *
 * Firefox hides the buttons of its title bar while its menu bar is
 * "active": browser-shared.css has
 *
 *   #toolbar-menubar[autohide]:not([inactive])
 *     ~ :is(#TabsToolbar, #nav-bar) > .titlebar-buttonbox-container {
 *     visibility: hidden;
 *   }
 *
 * and it shows the buttons in the menu bar row in that state.  Themes that
 * hide the menu bar row (as the Monterey theme does when the global menu is
 * enabled) hide every copy of the buttons with it.  The global menu is what
 * puts the menu bar into that state: a menu is built by firing
 * `popupshowing`/`popupshown` on the menu, and the matching `popuphidden`
 * does not clear the state of the menu bar again.
 *
 * Nothing outside the application can style its chrome -- it draws its own
 * window, and on Wayland no other process can reach into that surface.  So
 * the fix is a rule in the profile of the browser, and this module puts it
 * there: it is the same rule a person would add to userChrome.css, written
 * once, with a comment that says what it is for.
 *
 * It is only written when the profile already enables userChrome.css
 * (`toolkit.legacyUserProfileCustomizations.stylesheets`); without that the
 * browser ignores the file, and changing a preference of someone else's
 * browser is not something a menu bar should do.
 */

import GLib from 'gi://GLib';

import {log} from '../debug.js';

/* written into the stylesheet, and looked for to tell whether it is there */
const MARK = 'menubar@local -- keep the window buttons visible';

const RULE = `/* ${MARK}.
 *
 * Firefox hides the copy of the window buttons that is in the navigation
 * bar while its menu bar is "active" (browser-shared.css:
 * \`#toolbar-menubar[autohide]:not([inactive]) ~ :is(#TabsToolbar, #nav-bar)
 * > .titlebar-buttonbox-container { visibility: hidden }\`), and a theme
 * that hides the menu bar row hides every other copy as well.  The global
 * menu leaves the menu bar in that state after it has built a menu, so the
 * buttons stay hidden.  This block is written by the menu bar extension;
 * deleting it brings the missing buttons back.
 */
#nav-bar > .titlebar-buttonbox-container,
#nav-bar .titlebar-buttonbox-container {
\tvisibility: visible !important;
}
`;

/** the directories where a browser keeps its profiles */
function profileRoots() {
    const home = GLib.get_home_dir();
    return [
        `${home}/.mozilla/firefox`,
        `${home}/.waterfox`,
        `${home}/.librewolf`,
    ].filter(directory => GLib.file_test(directory, GLib.FileTest.IS_DIR));
}

/** "Path=..." entries of a profiles.ini */
function profilesIni(directory) {
    const text = fileText(`${directory}/profiles.ini`);
    if (!text)
        return [];

    const profiles = [];
    let current = null;

    const flush = () => {
        if (current?.path) {
            profiles.push(current.relative
                ? `${directory}/${current.path}`
                : current.path);
        }
        current = null;
    };

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
            flush();
            current = trimmed.startsWith('[Profile') ? {relative: true} : null;
            continue;
        }
        if (!current)
            continue;
        const match = /^(\w+)=(.*)$/.exec(trimmed);
        if (!match)
            continue;
        if (match[1] === 'Path')
            current.path = match[2];
        else if (match[1] === 'IsRelative')
            current.relative = match[2] !== '0';
    }
    flush();

    return profiles;
}

function fileText(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(contents) : null;
    } catch (e) {
        return null;
    }
}

/** does this profile load userChrome.css? */
function loadsUserChrome(profile) {
    for (const file of ['user.js', 'prefs.js']) {
        const text = fileText(`${profile}/${file}`);
        if (text && /user_pref\("toolkit\.legacyUserProfileCustomizations\.stylesheets",\s*true\)/.test(text))
            return true;
    }
    return false;
}

/** where the rule belongs in this profile */
function stylesheetOf(profile) {
    const chrome = `${profile}/chrome`;
    const custom = `${chrome}/customChrome.css`;
    const user = `${chrome}/userChrome.css`;

    // a theme that imports its own customization file: the rule is added
    // there, so that the theme itself is left untouched
    const userText = fileText(user);
    if (userText && /@import\s+["']customChrome\.css["']/.test(userText) &&
        GLib.file_test(custom, GLib.FileTest.EXISTS))
        return custom;

    return user;
}

/** put the rule into one profile, if it is not there already */
function fixProfile(profile) {
    if (!loadsUserChrome(profile)) {
        log('css', `${profile}: userChrome.css is not enabled, not touching it`);
        return false;
    }

    const sheet = stylesheetOf(profile);
    const text = fileText(sheet);
    if (text === null) {
        log('css', `${sheet} does not exist, not creating it`);
        return false;
    }

    if (text.includes(MARK)) {
        log('css', `${sheet}: already there`);
        return true;
    }

    try {
        GLib.file_set_contents(sheet, `${text}\n${RULE}`);
        log('css', `${sheet}: the rule was added (a browser restart is needed)`);
        return true;
    } catch (e) {
        log('css', `cannot write ${sheet}: ${e.message}`);
        return false;
    }
}

/**
 * Make sure every browser profile that uses the global menu keeps its
 * title bar buttons visible.
 */
export function ensureTitlebarCss() {
    for (const root of profileRoots()) {
        for (const profile of profilesIni(root)) {
            if (!GLib.file_test(profile, GLib.FileTest.IS_DIR))
                continue;
            fixProfile(profile);
        }
    }
}
