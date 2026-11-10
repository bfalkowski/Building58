#!/usr/bin/env python3
"""Runs a command in a pseudo-terminal, for the relay's Claude Code panel.

    python3 pty-bridge.py COLS ROWS COMMAND [ARGS...]

Bytes on stdin go to the terminal, and what the terminal prints comes out on stdout.
File descriptor 3, when the relay opens it, takes resize lines: "COLS ROWS\\n".
It uses only the standard library, so the relay needs no npm packages.
"""
import errno, fcntl, os, pty, select, signal, struct, sys, termios


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(2, rows), max(2, cols), 0, 0))


def write_all(fd, data):
    while data:
        try:
            n = os.write(fd, data)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                continue
            raise
        data = data[n:]


def main():
    cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write('Could not start %s: %s\r\n' % (cmd[0], e.strerror))
            os._exit(127)
    set_size(fd, cols, rows)

    def stop(*_):  # the relay is stopping: hang up the program, then leave
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        os.fstat(3)
        ctl = 3
    except OSError:
        ctl = None
    inputs = [fd, 0] + ([ctl] if ctl is not None else [])
    pending = b''
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:  # the relay closed stdin: stop the program
                os.kill(pid, signal.SIGHUP)
                inputs.remove(0)
            else:
                write_all(fd, data)
        if ctl is not None and ctl in ready:
            data = os.read(ctl, 4096)
            if not data:
                inputs.remove(ctl)
                ctl = None
            else:
                pending += data
                *lines, pending = pending.split(b'\n')
                for line in lines:
                    try:
                        c, r = (int(x) for x in line.split())
                        set_size(fd, c, r)
                    except ValueError:
                        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)


if __name__ == '__main__':
    main()
