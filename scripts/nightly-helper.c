/* Waypoint nightly maintenance launcher.
 *
 * Why this exists at all: a launchd-spawned BARE interpreter has no "responsible app", so since
 * macOS 26 no System Settings privacy grant can apply to it, and every access to an external
 * volume fails with EPERM while the same script works in Terminal (measured on macOS 26). Running
 * the job from inside a real .app makes the child's file accesses attribute to THIS app, which can
 * hold a Removable Volumes (or Full Disk Access) grant.
 *
 * fork() rather than a plain exec: keeping this process as the parent preserves the attribution the
 * .app has, which is the whole point. The child is /bin/bash running argv[1], so one signed binary
 * can serve a probe script and the real nightly.
 *
 * No script path is compiled in: the repository lives wherever it was cloned, and a path baked into
 * a signed binary is both a portability bug and a published copy of someone's filesystem layout.
 * The LaunchAgent's ProgramArguments supplies the script path at run time.
 *
 * The grant is bound to this binary's code signature (cdhash): FINALIZE THIS SOURCE BEFORE ASKING
 * FOR THE GRANT. Recompiling or re-signing afterwards silently invalidates it, and the job starts
 * failing with "TCC refused access" until it is granted again.
 *
 * Build and sign: scripts/install-nightly-agent.sh --install
 */

#ifndef INTERPRETER
#define INTERPRETER "/bin/bash"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char *argv[]) {
    if (argc < 2 || argv[1][0] == '\0') {
        fprintf(stderr, "usage: %s <script> [script args...]\n", argv[0]);
        return 64; /* the pipeline's usage code, so a bad call is not read as a failed run */
    }
    const char *script = argv[1];

    char ts[64];
    time_t t = time(NULL);
    strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", localtime(&t));
    printf("[%s] launcher pid=%d -> %s\n", ts, (int)getpid(), script);
    fflush(stdout);

    /* The child's argv is /bin/bash <script> [args…]. Forwarding the tail is load-bearing:
     * `<helper> <script> --self-check` must stay a probe, and dropping the flag ran the whole
     * pipeline instead — which can bump Electron, commit and install. */
    char **child = calloc((size_t)argc + 1, sizeof *child);
    if (child == NULL) {
        perror("calloc");
        return 1;
    }
    child[0] = (char *)INTERPRETER;
    for (int i = 1; i < argc; i += 1) child[i] = argv[i];
    child[argc] = NULL;

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }
    if (pid == 0) {
        /* Child: the script under the interpreter, inside this app's grant. */
        execv(INTERPRETER, child);
        perror("execv");
        _exit(127);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 1;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
