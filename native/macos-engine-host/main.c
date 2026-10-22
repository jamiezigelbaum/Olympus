// Olympus engine host: the small signed program macOS sees as "Olympus".
//
// macOS asks the person about Desktop, Documents, Downloads, iCloud Drive and
// removable or network volumes in the name of the app responsible for the
// access. The engine is a LaunchAgent that runs Bun; run directly, the
// prompt would say "bun" and a grant would belong to the interpreter. This
// launcher is the LaunchAgent's program instead. It starts the command it is
// given (Bun and the engine entry) as a child, which keeps this app as the
// responsible process, and then stays out of the way:
//
//   - It sets OLYMPUS_ENGINE_HELPER so the engine knows it runs under this app.
//   - SIGTERM, SIGINT and SIGHUP are passed to the child.
//   - It exits with the child's exit code, or 128 + the signal that ended
//     the child, so launchd's KeepAlive rules see what Bun would have said.
//
// It reads nothing, writes nothing and opens no files.

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid = 0;

static void forward(int sig) {
  pid_t pid = child_pid;
  if (pid > 0) kill(pid, sig);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [arguments...]\n", argv[0]);
    return 64;
  }

  // Block the forwarded signals until the child exists, so one that arrives
  // during spawn is delivered afterwards instead of lost.
  sigset_t forwarded, previous;
  sigemptyset(&forwarded);
  sigaddset(&forwarded, SIGTERM);
  sigaddset(&forwarded, SIGINT);
  sigaddset(&forwarded, SIGHUP);
  sigprocmask(SIG_BLOCK, &forwarded, &previous);

  // The engine looks for this to know your Mac will ask in the name of Olympus.
  setenv("OLYMPUS_ENGINE_HELPER", "ai.olympusplugin.engine-host", 1);

  pid_t pid = 0;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attr;
  posix_spawn_file_actions_init(&actions);
  posix_spawnattr_init(&attr);
  // The child starts with the signal mask this program had on entry.
  posix_spawnattr_setsigmask(&attr, &previous);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK);
  int rc = posix_spawn(&pid, argv[1], &actions, &attr, &argv[1], environ);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) {
    fprintf(stderr, "Olympus engine host: could not start %s: %s\n", argv[1], strerror(rc));
    return 127;
  }
  child_pid = pid;

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  sigprocmask(SIG_SETMASK, &previous, NULL);

  int status = 0;
  for (;;) {
    pid_t done = waitpid(pid, &status, 0);
    if (done == pid) break;
    if (done < 0 && errno != EINTR) return 70;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 70;
}
