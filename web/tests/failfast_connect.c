/* Same 3 s non-blocking cap as QemuEth connect_failfast.
   A blackholed SYN must come back as a failure before 6 s, then the process continues. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static int connect_failfast(int fd, const struct sockaddr *name, socklen_t namelen) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) flags = 0;
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  int rc = connect(fd, name, namelen);
  if (rc == 0 || errno != EINPROGRESS) {
    fcntl(fd, F_SETFL, flags);
    return rc;
  }
  fd_set wset;
  FD_ZERO(&wset);
  FD_SET(fd, &wset);
  struct timeval tv;
  tv.tv_sec = 3;
  tv.tv_usec = 0;
  int sel = select(fd + 1, NULL, &wset, NULL, &tv);
  int err = ETIMEDOUT;
  if (sel > 0) {
    socklen_t len = sizeof err;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0) err = errno;
  }
  fcntl(fd, F_SETFL, flags);
  if (err) {
    errno = err;
    return -1;
  }
  return 0;
}

static long long now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

int main(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 1;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof addr);
  addr.sin_family = AF_INET;
  addr.sin_port = htons(80);
  inet_pton(AF_INET, "192.0.2.1", &addr.sin_addr);
  long long t0 = now_ms();
  int rc = connect_failfast(fd, (struct sockaddr *)&addr, sizeof addr);
  long long elapsed = now_ms() - t0;
  close(fd);
  if (rc == 0) {
    printf("OPEN\nELAPSED_MS %lld\n", elapsed);
    return 2;
  }
  printf("BLOCKED\nELAPSED_MS %lld\nCONTINUE\n", elapsed);
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return 1;
  struct sockaddr_in local;
  memset(&local, 0, sizeof local);
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(0x7f000001);
  local.sin_port = 0;
  if (bind(listener, (struct sockaddr *)&local, sizeof local) < 0) return 1;
  if (listen(listener, 1) < 0) return 1;
  socklen_t llen = sizeof local;
  if (getsockname(listener, (struct sockaddr *)&local, &llen) < 0) return 1;
  int client = socket(AF_INET, SOCK_STREAM, 0);
  if (client < 0) return 1;
  if (connect(client, (struct sockaddr *)&local, sizeof local) < 0) return 1;
  close(client);
  close(listener);
  printf("STILL_RUNNING\n");
  return 0;
}
