#!/usr/bin/env python3
"""Owned nested bind-mount qualification; run in a private mount namespace.

python3 scripts/qualify-linux-mounts.py
Never mount in the host namespace. Linux only; no existing data is deleted.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys

repo = Path(__file__).resolve().parent.parent
# The launcher records its own namespace before creating a disposable one.
if len(sys.argv) == 1:
    raise SystemExit(subprocess.run(['unshare', '--user', '--map-root-user', '--mount', sys.executable, __file__, '--inside', os.readlink('/proc/self/ns/mnt')]).returncode)
if len(sys.argv) != 3 or sys.argv[1] != '--inside' or os.readlink('/proc/self/ns/mnt') == sys.argv[2]:
    raise SystemExit('requires the launcher-created private mount namespace')
results = []
with tempfile.TemporaryDirectory(prefix='sweep-mounts-', dir=repo / 'target') as owned:
    owned = Path(owned)
    for engine in ['rust', 'js']:
        root = owned / engine
        protected = owned / (engine + '-protected-home')
        alias = root / 'alias-of-home'
        (protected / 'node_modules').mkdir(parents=True)
        alias.mkdir(parents=True)
        sentinel = protected / 'node_modules' / 'keep'
        sentinel.write_text('protected root alias sentinel')
        subprocess.run(['mount', '--bind', str(protected), str(alias)], check=True)
        try:
            alias_env = {**os.environ, 'HOME': str(protected), 'SWEEP_CONFIG_DIR': str(owned / 'config'),
                         'SWEEP_ENGINE_PATH': str(repo / 'target/release/sweep-engine')}
            alias_scan = subprocess.run(['node', str(repo / 'apps/cli/dist/sweep.js'), 'scan', str(alias),
                                         '--engine', engine, '--json'], env=alias_env, capture_output=True, text=True)
            if alias_scan.returncode != 2 or sentinel.read_text() != 'protected root alias sentinel':
                raise RuntimeError(engine + ' accepted a bind alias of its protected home: ' + alias_scan.stderr)
            results.append({'engine': engine, 'protectedRootBindAliasRefused': True,
                            'exit': alias_scan.returncode, 'protectedSentinelPreserved': True})
        finally:
            subprocess.run(['umount', str(alias)], check=True)
        artifact = root / 'node_modules'
        destination = artifact / 'volume'
        outside = owned / (engine + '-outside')
        destination.mkdir(parents=True)
        outside.mkdir()
        (outside / 'keep').write_text('outside sentinel')
        (artifact / 'owned').write_text('owned')
        (root / '.sweeprc').write_text('{}')
        subprocess.run(['mount', '--bind', str(outside), str(destination)], check=True)
        try:
            env = {**os.environ, 'XDG_CONFIG_HOME': str(owned / 'config'), 'SWEEP_ENGINE_PATH': str(repo / 'target/release/sweep-engine')}
            cli = ['node', str(repo / 'apps/cli/dist/sweep.js')]
            scan = subprocess.run(cli + ['scan', str(root), '--engine', engine, '--json'], cwd=root, env=env, capture_output=True, text=True, check=True)
            plan = owned / (engine + '-plan.json')
            plan.write_text(scan.stdout)
            apply = subprocess.run(cli + ['apply', '--plan', str(plan), '--engine', engine, '--yes', '--json'], cwd=root, env=env, capture_output=True, text=True)
            if not (outside / 'keep').exists():
                raise RuntimeError(engine + ' removed outside sentinel')
            if apply.returncode == 0:
                raise RuntimeError(engine + ' accepted a nested bind mount')
            if not apply.stdout.strip():
                raise RuntimeError(engine + " produced no report: " + apply.stderr[-3000:])
            report = json.loads(apply.stdout)
            if report.get('failedCount') != 1:
                raise RuntimeError(engine + ' did not report candidate failure: ' + apply.stdout)
            results.append({'engine': engine, 'exit': apply.returncode, 'failedCount': report['failedCount'], 'outsideSentinelPreserved': True, 'sameDeviceBindMount': True})
        finally:
            subprocess.run(['umount', str(destination)], check=True)
    for engine in ['rust', 'js']:
        for kind in ['directory', 'file']:
            root = owned / (engine + '-ancestor-' + kind)
            outside = owned / (engine + '-ancestor-outside-' + kind)
            alias = root / 'alias'
            alias.mkdir(parents=True)
            (outside / 'pkg').mkdir(parents=True)
            (outside / 'keep').write_text('outside sentinel')
            name = 'node_modules' if kind == 'directory' else 'tsconfig.tsbuildinfo'
            source = outside / 'pkg' / name
            if kind == 'directory':
                source.mkdir()
                (source / 'payload').write_text('selected payload')
            else:
                source.write_text('selected payload')
            subprocess.run(['mount', '--bind', str(outside), str(alias)], check=True)
            try:
                env = {**os.environ, 'SWEEP_CONFIG_DIR': str(owned / 'config'),
                       'SWEEP_ENGINE_PATH': str(repo / 'target/release/sweep-engine')}
                cli = ['node', str(repo / 'apps/cli/dist/sweep.js')]
                def scan_apply(target, label):
                    scan = subprocess.run(cli + ['scan', str(target), '--engine', engine, '--json'],
                                          env=env, capture_output=True, text=True, check=True)
                    plan = owned / (engine + '-' + kind + '-' + label + '.json')
                    plan.write_text(scan.stdout)
                    parsed = json.loads(scan.stdout)
                    if len(parsed['selectedCandidateIds']) != 1:
                        raise RuntimeError('ancestor fixture did not select one candidate: ' + scan.stdout)
                    return subprocess.run(cli + ['apply', '--plan', str(plan), '--engine', engine, '--yes', '--json'],
                                          env=env, capture_output=True, text=True)
                refused = scan_apply(root, 'crossing')
                payload = source / 'payload' if kind == 'directory' else source
                if not payload.exists() or payload.read_text() != 'selected payload':
                    raise RuntimeError(engine + ' crossed an ancestor bind mount for ' + kind)
                report = json.loads(refused.stdout)
                if refused.returncode == 0 or report.get('failedCount') != 1:
                    raise RuntimeError(engine + ' did not refuse ancestor mount: ' + refused.stdout)
                # A mounted workspace may be chosen explicitly as the root.
                # Only a mount crossed below that root must refuse removal.
                allowed = scan_apply(alias / 'pkg', 'explicit-root')
                if allowed.returncode != 0 or json.loads(allowed.stdout).get('deletedCount') != 1 or source.exists():
                    raise RuntimeError(engine + ' refused explicit mounted root: ' + allowed.stderr + allowed.stdout)
                if (outside / 'keep').read_text() != 'outside sentinel':
                    raise RuntimeError(engine + ' changed an unselected sentinel')
                results.append({'engine': engine, 'candidateKind': kind,
                                'ancestorSameDeviceMountRefused': True,
                                'explicitMountedRootAllowed': True,
                                'outsideSentinelPreserved': True})
            finally:
                subprocess.run(['umount', str(alias)], check=True)
print(json.dumps({'scope': 'Private Linux namespace, owned nested/ancestor same-device bind mounts and explicit mounted roots, actual CLI scan/save/apply', 'results': results}, indent=2))
