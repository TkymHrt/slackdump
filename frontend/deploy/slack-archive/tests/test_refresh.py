"""Regression tests using real SQLite files; no production services are touched."""
from contextlib import closing
import importlib.machinery
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader(
    'refresh', str(Path(__file__).resolve().parents[1]/'scripts/slack-dump-view-refresh'))
spec = importlib.util.spec_from_loader(loader.name, loader)
refresh = importlib.util.module_from_spec(spec)
loader.exec_module(refresh)


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.job = refresh.Refresh(self.root)
        self.job.live.parent.mkdir()
        self.job.view.parent.mkdir()
        for path, value in ((self.job.live, 'new'), (self.job.view, 'old')):
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.executescript('CREATE TABLE MESSAGE (CHANNEL_ID TEXT, ID TEXT, CHUNK_ID INTEGER);'
                                   'CREATE TABLE ALIAS (CHANNEL_ID TEXT PRIMARY KEY, ALIAS TEXT, CREATED_AT TEXT);')
                conn.execute('INSERT INTO MESSAGE VALUES (?, ?, ?)', (value, '1', 1))
        with closing(sqlite3.connect(self.job.live)) as conn, conn:
            conn.execute("INSERT INTO ALIAS VALUES ('deleted', 'stale source alias', '2026-01-01')")
        with closing(sqlite3.connect(self.job.view)) as conn, conn:
            conn.execute("INSERT INTO ALIAS VALUES ('C1', 'viewer alias', '2026-10-01')")
        self.calls = []
        def unit(action, name, *args):
            self.calls.append((action, name))
            if action == 'show':
                return 'success' if args[-1] == 'Result' else ('active' if name == refresh.MCP else 'inactive')
            return ''
        self.addCleanup(patch.stopall)
        patch.object(refresh, 'unit', side_effect=unit).start()
        patch.object(refresh.Refresh, 'permissions', lambda self, path: None).start()
        self.real_healthy = refresh.healthy
        self.health = patch.object(refresh, 'healthy').start()

    def rows(self, path, table='MESSAGE'):
        with closing(sqlite3.connect(path)) as conn, conn:
            return conn.execute('SELECT * FROM '+table).fetchall()

    def test_publish_preserves_aliases_and_deletions(self):
        old_inode = self.job.view.stat().st_ino
        with patch.object(refresh, 'copy_connection', wraps=refresh.copy_connection) as copies:
            self.job.run()
        self.assertEqual(copies.call_count, 2)
        self.assertEqual(self.rows(self.job.view)[0][0], 'new')
        self.assertEqual(self.rows(self.job.view, 'ALIAS'), [('C1', 'viewer alias', '2026-10-01')])
        self.assertEqual(self.rows(self.job.rollback)[0][0], 'old')
        self.assertEqual(self.job.rollback.stat().st_ino, old_inode)
        self.assertFalse(self.job.pending.exists())
        self.assertFalse(self.job.viewer_pending.exists())
        self.assertFalse(self.job.mcp_pending.exists())
        with refresh.database(self.job.view, readonly=True) as db:
            self.assertEqual([row[2] for row in db.execute('PRAGMA index_info(MESSAGE_VIEWER_PAGE)')],
                             ['CHANNEL_ID', 'ID', 'CHUNK_ID'])
        self.assertLess(self.calls.index(('stop', refresh.MCP)), self.calls.index(('start', refresh.MCP)))
        self.assertLess(self.calls.index(('start', refresh.MCP)), self.calls.index(('stop', refresh.VIEWER)))

    def test_unhealthy_new_viewer_restores_old_snapshot(self):
        self.health.side_effect = [TimeoutError('new snapshot unhealthy'), None]
        with self.assertLogs(refresh.LOG, level='ERROR'), self.assertRaises(TimeoutError):
            self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertEqual(self.rows(self.job.view, 'ALIAS')[0][1], 'viewer alias')
        self.assertFalse(self.job.pending.exists())

    def test_failed_rollback_keeps_marker_and_does_not_start_viewer(self):
        shutil.copyfile(self.job.view, self.job.rollback)
        self.job.pending.touch()
        self.job.mcp_pending.touch()
        self.calls.clear()
        with patch.object(refresh.os, 'link', side_effect=OSError('unreadable rollback')):
            with self.assertLogs(refresh.LOG, level='ERROR'), self.assertRaises(OSError):
                self.job.recover()
        self.assertTrue(self.job.pending.exists())
        self.assertNotIn(('start', refresh.VIEWER), self.calls)
        self.assertIn(('start', refresh.MCP), self.calls)
        self.assertFalse(self.job.mcp_pending.exists())

    def test_pending_publish_recovers_after_process_death(self):
        shutil.copyfile(self.job.view, self.job.rollback)
        shutil.copyfile(self.job.live, self.job.view)
        self.job.pending.touch()
        self.job.recover()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertTrue(self.job.rollback.exists())
        self.assertFalse(self.job.pending.exists())

    def test_interruption_before_publish_restarts_original_viewer(self):
        self.job.viewer_pending.touch()
        self.job.recover()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertIn(('start', refresh.VIEWER), self.calls)
        self.health.assert_called_once()
        self.assertFalse(self.job.viewer_pending.exists())

    def test_publish_reads_committed_wal_and_creates_standalone_db(self):
        conn = sqlite3.connect(self.job.live)
        self.addCleanup(conn.close)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute("INSERT INTO MESSAGE VALUES ('wal', '2', 2)")
        conn.commit()
        self.job.run()
        self.assertEqual(len(self.rows(self.job.view)), 2)
        with closing(sqlite3.connect(self.job.view)) as db, db:
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone(), ('delete',))
            self.assertEqual(db.execute('PRAGMA quick_check').fetchall(), [('ok',)])

    def test_missing_archive_leaves_viewer_untouched_and_restores_mcp(self):
        self.job.live.unlink()
        with self.assertRaises(FileNotFoundError):
            self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertNotIn(('stop', refresh.VIEWER), self.calls)
        self.assertNotIn(('stop', refresh.MCP), self.calls)

    def test_sqlite_query_deadline_interrupts_work(self):
        with patch.object(refresh, 'OPERATION_TIMEOUT', -1):
            with refresh.database(self.job.live, readonly=True) as db:
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT SUM(x) FROM n').fetchone()

    def test_backup_deadline_interrupts_copy(self):
        with patch.object(refresh, 'OPERATION_TIMEOUT', -1):
            with closing(sqlite3.connect(self.job.live)) as src, closing(sqlite3.connect(':memory:')) as dst:
                with self.assertRaises(TimeoutError):
                    refresh.copy_connection(src, dst, self.job.live)

    def test_insufficient_memory_rejects_refresh_before_stopping_services(self):
        before = self.job.live.read_bytes()
        with patch.object(refresh, 'require_memory', side_effect=MemoryError('no spare RAM')):
            with self.assertRaises(MemoryError):
                self.job.run()
        self.assertEqual(self.job.live.read_bytes(), before)
        self.assertNotIn(('stop', refresh.MCP), self.calls)
        self.assertNotIn(('stop', refresh.VIEWER), self.calls)

    def test_require_memory_rejects_small_container(self):
        with patch.object(refresh, 'Path') as meminfo:
            meminfo.return_value.read_text.return_value = 'MemTotal: 1 kB\n'
            with self.assertRaises(MemoryError):
                refresh.require_memory(self.job.live)

    def test_mcp_pending_survives_failed_restart(self):
        self.job.mcp_pending.touch()
        with patch.object(refresh, 'unit', side_effect=RuntimeError('start failed')):
            with self.assertLogs(refresh.LOG, level='ERROR'):
                self.job.restore_mcp()
        self.assertTrue(self.job.mcp_pending.exists())
        self.job.restore_mcp()
        self.assertFalse(self.job.mcp_pending.exists())

    def test_recover_replaces_corrupt_or_missing_snapshot_without_memory(self):
        for state in ('corrupt', 'missing'):
            with self.subTest(state=state):
                shutil.copyfile(self.job.live, self.job.rollback)
                self.job.pending.touch()
                if state == 'corrupt':
                    self.job.view.write_bytes(b'not a database')
                else:
                    self.job.view.unlink()
                for suffix in ('-wal', '-shm', '-journal'):
                    self.job.view.with_name(self.job.view.name+suffix).write_bytes(b'failed snapshot sidecar')
                with patch.object(refresh, 'require_memory', side_effect=MemoryError('no spare RAM')):
                    self.job.recover()
                self.assertEqual(self.rows(self.job.view)[0][0], 'new')
                self.assertTrue(self.job.rollback.exists())
                self.assertFalse(self.job.pending.exists())
                for suffix in ('-wal', '-shm', '-journal'):
                    self.assertFalse(self.job.view.with_name(self.job.view.name+suffix).exists())

    def test_recover_can_retry_after_health_failure(self):
        shutil.copyfile(self.job.view, self.job.rollback)
        self.job.pending.touch()
        self.job.mcp_pending.touch()
        self.health.side_effect = [TimeoutError('not ready'), None]
        with self.assertLogs(refresh.LOG, level='ERROR'), self.assertRaises(TimeoutError):
            self.job.recover()
        self.assertTrue(self.job.pending.exists())
        self.assertIn(('start', refresh.MCP), self.calls)
        self.job.recover()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertFalse(self.job.pending.exists())

    def test_recover_removes_staging_after_abrupt_process_exit(self):
        script = '''
import importlib.machinery, importlib.util, os, sys
from pathlib import Path
from unittest.mock import patch
loader = importlib.machinery.SourceFileLoader('refresh', sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
refresh = importlib.util.module_from_spec(spec)
loader.exec_module(refresh)
def unit(action, name, *args):
    if action == 'show':
        return 'success' if args[-1] == 'Result' else ('active' if name == refresh.MCP else 'inactive')
    if action == 'stop' and name == refresh.VIEWER:
        os._exit(23)
    return ''
with patch.object(refresh, 'unit', side_effect=unit):
    refresh.Refresh(Path(sys.argv[2])).run()
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, loader.path, str(self.root)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertTrue(list(self.job.view.parent.glob('.refresh-*')))
        abandoned_recovery = self.job.view.parent/'.recover-abandoned'
        abandoned_recovery.mkdir()
        (abandoned_recovery/'restored.sqlite').write_bytes(b'partial')
        self.job.recover()
        self.assertFalse(list(self.job.view.parent.glob('.refresh-*')))
        self.assertFalse(list(self.job.view.parent.glob('.recover-*')))
        self.assertFalse(self.job.viewer_pending.exists())
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')

    def test_external_wal_reader_prevents_replacement(self):
        writer = sqlite3.connect(self.job.view)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute("INSERT INTO MESSAGE VALUES ('before-read', '2', 2)")
        writer.commit()
        reader = sqlite3.connect(self.job.view)
        self.addCleanup(reader.close)
        reader.execute('BEGIN')
        reader.execute('SELECT * FROM MESSAGE').fetchall()
        writer.execute("INSERT INTO MESSAGE VALUES ('after-read', '3', 3)")
        writer.commit()
        with self.assertLogs(refresh.LOG, level='ERROR'), self.assertRaisesRegex(RuntimeError, 'checkpoint busy'):
            self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertFalse(self.job.pending.exists())
        self.assertIn(('start', refresh.VIEWER), self.calls)

    def test_health_deadline_counts_request_time(self):
        clock = [0.0]
        def request(*args, **kwargs):
            clock[0] += kwargs['timeout']
            raise OSError('not ready')
        def sleep(seconds):
            clock[0] += seconds
        with patch.object(refresh.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(refresh.time, 'sleep', side_effect=sleep), \
             patch.object(refresh.urllib.request, 'urlopen', side_effect=request):
            with self.assertRaises(TimeoutError):
                self.real_healthy(timeout=5)
        self.assertEqual(clock[0], 5.0)


if __name__ == '__main__':
    unittest.main()
