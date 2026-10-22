/* Keeps the nested shell running.
 *
 * The smoke test exits the shell when it is done; this script does not, so
 * that a program can be tried out inside the nested shell (see
 * `devkit/nested.sh`).
 */

export function init() {
    print('menubar: the nested shell is up, waiting for a program');
}
