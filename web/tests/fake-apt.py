#!/usr/bin/env python3
# A stand-in apt for the plugin package tests (fake-apt.ts installs it as
# apt-get, apt-cache, apt-mark and dpkg-query in /usr/local/bin, ahead of the
# real ones on both PHP's PATH and sudo's secure_path).
#
# Only the packages named in its state file are fake; it answers for them as
# apt and dpkg would, and records every call. Anything about any other package
# is handed to the real tool, except what would change the system: an install
# or removal through apt-get never reaches the real apt-get.
#
# State, /tmp/fpp-tests-apt/state.json:
#   installed   name -> {"version", "auto": bool, "hold": bool}
#   available   names apt could install (version 1.0)
#   listFails   true: dpkg-query's full listing fails (exit 1)
# Calls, one JSON array of argv per line: /tmp/fpp-tests-apt/calls.log.
import json
import os
import shutil
import subprocess
import sys

DIR = '/tmp/fpp-tests-apt'
STATE = os.path.join(DIR, 'state.json')
CALLS = os.path.join(DIR, 'calls.log')


def load():
    with open(STATE) as f:
        s = json.load(f)
    s.setdefault('installed', {})
    s.setdefault('available', [])
    return s


def save(s):
    with open(STATE + '.tmp', 'w') as f:
        json.dump(s, f)
    os.rename(STATE + '.tmp', STATE)
    # What dpkg does on every change: a new status file, by rename (FPP
    # compares its inode, size and mtime to tell whether to look again). The
    # same content, so the inode can come back from the last change: the
    # mtime moves on a second each time instead.
    status = '/var/lib/dpkg/status'
    mtime = os.stat(status).st_mtime + 1
    shutil.copy2(status, status + '.fpp-tests')
    os.rename(status + '.fpp-tests', status)
    os.utime(status, (mtime, mtime))


def known(s, name):
    return name in s['installed'] or name in s['available']


def real(tool, args):
    sys.stdout.flush()
    os.execv('/usr/bin/' + tool, [tool] + args)


def dpkg_query(s, args):
    fmt = None
    names = []
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith('-f=') or a.startswith('--showformat='):
            fmt = a.split('=', 1)[1]
        elif a in ('-f', '--showformat'):
            i += 1
            fmt = args[i]
        elif a == '--':
            pass
        elif a.startswith('-'):
            pass
        else:
            names.append(a)
        i += 1
    if fmt is None:
        fmt = '${Package}\t${Version}\n'
    fmt = fmt.replace('\\n', '\n')

    def line(name):
        p = s['installed'][name]
        return (fmt.replace('${Package}', name).replace('${Architecture}', 'all')
                .replace('${Version}', p.get('version', '1.0'))
                .replace('${db:Status-Want}', 'hold' if p.get('hold') else 'install')
                .replace('${db:Status-Status}', 'installed')
                .replace('${Status}', ('hold' if p.get('hold') else 'install') + ' ok installed'))

    if not names:
        if s.get('listFails'):
            sys.exit(1)
        out = subprocess.run(['/usr/bin/dpkg-query'] + args, capture_output=True, text=True)
        sys.stdout.write(out.stdout)
        for n in sorted(s['installed']):
            sys.stdout.write(line(n))
        sys.exit(out.returncode)
    rc = 0
    for n in names:
        if n in s['installed']:
            sys.stdout.write(line(n))
        elif known(s, n) or n.startswith('fpp-tests-'):
            sys.stderr.write('dpkg-query: no packages found matching %s\n' % n)
            rc = 1
        else:
            out = subprocess.run(['/usr/bin/dpkg-query'] + [a for a in args if a not in names] + [n],
                                 capture_output=True, text=True)
            sys.stdout.write(out.stdout)
            rc = rc or out.returncode
    sys.exit(rc)


def apt_get(s, args):
    flags = []
    words = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '-o':
            i += 1
        elif a.startswith('-'):
            flags.append(a)
        else:
            words.append(a)
        i += 1
    cmd = words[0] if words else ''
    pkgs = words[1:]
    simulate = '-s' in flags or '--simulate' in flags
    if simulate:
        if not pkgs or not all(known(s, p) or p.startswith('fpp-tests-') for p in pkgs):
            real('apt-get', args)
        for p in pkgs:
            if cmd == 'install':
                if p not in s['available'] and p not in s['installed']:
                    print('E: Unable to locate package %s' % p)
                    sys.exit(100)
                if p not in s['installed']:
                    print('Inst %s (1.0 fpp-tests [all])' % p)
            elif cmd in ('remove', 'purge'):
                if p in s['installed']:
                    print('Remv %s [%s]' % (p, s['installed'][p].get('version', '1.0')))
        sys.exit(0)
    if cmd == 'install':
        for p in pkgs:
            if p not in s['available'] and p not in s['installed']:
                print('E: Unable to locate package %s' % p)
                sys.exit(100)
        for p in pkgs:
            if p not in s['installed']:
                s['installed'][p] = {'version': '1.0', 'auto': False, 'hold': False}
        save(s)
    elif cmd in ('remove', 'purge'):
        for p in pkgs:
            s['installed'].pop(p, None)
        save(s)
    sys.exit(0)


def apt_cache(s, args):
    if len(args) >= 2 and args[0] == 'pkgnames':
        hits = sorted(n for n in set(s['installed']) | set(s['available']) if n.startswith(args[1]))
        if hits or args[1].startswith('fpp-tests-'):
            print('\n'.join(hits))
            sys.exit(0)
    if args and args[0] == 'rdepends':
        names = [a for a in args[1:] if not a.startswith('-')]
        if names and all(known(s, n) for n in names):
            for n in names:
                print('%s\nReverse Depends:' % n)
            sys.exit(0)
    real('apt-cache', args)


def apt_mark(s, args):
    names = [a for a in args[1:] if not a.startswith('-')]
    if args and names and all(known(s, n) for n in names):
        if args[0] == 'showauto':
            for n in names:
                if s['installed'].get(n, {}).get('auto'):
                    print(n)
            sys.exit(0)
        if args[0] in ('hold', 'unhold'):
            for n in names:
                if n in s['installed']:
                    s['installed'][n]['hold'] = args[0] == 'hold'
            save(s)
            sys.exit(0)
    real('apt-mark', args)


def main():
    tool = sys.argv[1]
    args = sys.argv[2:]
    with open(CALLS, 'a') as f:
        f.write(json.dumps([tool] + args) + '\n')
    s = load()
    {'dpkg-query': dpkg_query, 'apt-get': apt_get, 'apt-cache': apt_cache, 'apt-mark': apt_mark}[tool](s, args)


main()
