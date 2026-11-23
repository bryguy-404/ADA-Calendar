"""Fictional local interactive login only. Credentials arrive on stdin, never logs."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

credentials = json.load(sys.stdin)
if not credentials['email'].endswith('@example.invalid') or os.environ.get('ADA_CALENDAR_ALLOW_LOCAL') != '1':
    raise SystemExit('Fictional local sign-in required')
master, slave = pty.openpty()
process = subprocess.Popen([sys.argv[1], sys.argv[2], 'login'], stdin=slave, stdout=slave, stderr=slave, env=os.environ)
os.close(slave)
output = b''
sent_email = sent_password = False
deadline = time.monotonic() + 40
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try:
                chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output += chunk
            if not sent_email and b'Email:' in output:
                os.write(master, (credentials['email'] + '\n').encode())
                sent_email = True
            if not sent_password and b'Password (hidden):' in output:
                os.write(master, (credentials['password'] + '\n').encode())
                sent_password = True
        if process.poll() is not None:
            break
    if process.poll() is None:
        process.terminate()
    code = process.wait(timeout=5)
    if code != 0 or not sent_password or b'Signed in.' not in output:
        raise SystemExit('Fictional interactive login failed')
    if credentials['password'].encode() in output:
        raise SystemExit('Password was echoed')
    print('PASS: fictional interactive login; password hidden')
finally:
    os.close(master)
    if process.poll() is None:
        process.kill()
