"""Standard-library PTY transport for qa-sidebar.mjs; never paints terminal cells."""
import base64
import fcntl
import json
import os
import pty
import selectors
import signal
import struct
import sys
import termios

binary, cols, rows = sys.argv[1:]
gate_read, gate_write = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(gate_write)
    os.read(gate_read, 1)  # Parent sets geometry before Herdr can render.
    os.close(gate_read)
    os.execv(binary, [binary])
os.close(gate_read)
fcntl.ioctl(master, termios.TIOCSWINSZ,
            struct.pack('HHHH', int(rows), int(cols), 0, 0))
os.write(gate_write, b'1')
os.close(gate_write)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(sys.stdin, selectors.EVENT_READ)


def emit(value):
    print(json.dumps(value), flush=True)


def terminate(*_):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
try:
    emit({'ready': True, 'clientPid': pid})
    running = True
    while running:
        for key, _ in selector.select():
            if key.fileobj == sys.stdin:
                line = sys.stdin.readline()
                if not line:
                    running = False
                    break
                command = json.loads(line)
                if command.get('stop'):
                    running = False
                    break
                os.write(master, base64.b64decode(command['input']))
            else:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    # EIO is the documented PTY EOF on Linux; all other errors matter.
                    if error.errno != 5:
                        raise
                    running = False
                    break
                if not data:
                    running = False
                    break
                emit({'data': base64.b64encode(data).decode('ascii')})
finally:
    selector.close()
    os.close(master)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # The owned client has already exited.
    _, status = os.waitpid(pid, 0)
    emit({'stopped': True, 'clientPid': pid, 'waitStatus': status})
