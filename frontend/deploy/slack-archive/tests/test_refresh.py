from contextlib import closing
"""Regression tests using real SQLite files; no production services are touched."""
import importlib.machinery
import importlib.util
from pathlib import Path
import sqlite3
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
        self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'new')
        self.assertEqual(self.rows(self.job.view, 'ALIAS'), [('C1', 'viewer alias', '2026-10-01')])
        self.assertEqual(self.rows(self.job.rollback)[0][0], 'old')
        self.assertFalse(self.job.pending.exists())
        self.assertFalse(self.job.viewer_pending.exists())
        self.assertFalse(self.job.mcp_pending.exists())
        with refresh.database(self.job.view, readonly=True) as db:
            self.assertEqual([row[2] for row in db.execute('PRAGMA index_info(MESSAGE_VIEWER_PAGE)')],
                             ['CHANNEL_ID', 'ID', 'CHUNK_ID'])
        self.assertLess(self.calls.index(('stop', refresh.MCP)), self.calls.index(('start', refresh.MCP)))

    def test_unhealthy_new_viewer_restores_old_snapshot(self):
        self.health.side_effect = [TimeoutError('new snapshot unhealthy'), None]
        with self.assertRaises(TimeoutError):
            self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertEqual(self.rows(self.job.view, 'ALIAS')[0][1], 'viewer alias')
        self.assertFalse(self.job.pending.exists())

    def test_failed_rollback_keeps_marker_and_does_not_start_viewer(self):
        refresh.backup(self.job.view, self.job.rollback)
        self.job.pending.touch()
        self.calls.clear()
        with patch.object(refresh, 'backup', side_effect=OSError('unreadable rollback')):
            with self.assertRaises(OSError):
                self.job.recover()
        self.assertTrue(self.job.pending.exists())
        self.assertNotIn(('start', refresh.VIEWER), self.calls)

    def test_pending_publish_recovers_after_process_death(self):
        refresh.backup(self.job.view, self.job.rollback)
        refresh.backup(self.job.live, self.job.view)
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

    def test_backup_reads_committed_wal_and_creates_standalone_db(self):
        conn = sqlite3.connect(self.job.live)
        self.addCleanup(conn.close)
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute("INSERT INTO MESSAGE VALUES ('wal', '2', 2)")
        conn.commit()
        target = self.root/'wal-copy.sqlite'
        refresh.backup(self.job.live, target)
        self.assertEqual(len(self.rows(target)), 2)
        with closing(sqlite3.connect(target)) as db, db:
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone(), ('delete',))
        refresh.check(target)

    def test_missing_archive_leaves_viewer_untouched_and_restores_mcp(self):
        self.job.live.unlink()
        with self.assertRaises(sqlite3.OperationalError):
            self.job.run()
        self.assertEqual(self.rows(self.job.view)[0][0], 'old')
        self.assertNotIn(('stop', refresh.VIEWER), self.calls)
        self.assertIn(('start', refresh.MCP), self.calls)

    def test_sqlite_query_deadline_interrupts_work(self):
        with patch.object(refresh, 'OPERATION_TIMEOUT', -1):
            with refresh.database(self.job.live, readonly=True) as db:
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<100000) SELECT SUM(x) FROM n').fetchone()

    def test_backup_deadline_interrupts_copy(self):
        with patch.object(refresh, 'OPERATION_TIMEOUT', -1):
            with self.assertRaises(TimeoutError):
                refresh.backup(self.job.live, self.root/'timeout.sqlite')

    def test_insufficient_memory_rejects_index_before_modifying_database(self):
        before = self.job.live.read_bytes()
        with patch.object(refresh.Path, 'exists', return_value=True), \
             patch.object(refresh.Path, 'read_text', return_value='MemTotal: 1 kB\n'):
            with self.assertRaises(MemoryError):
                refresh.prepare_index(self.job.live)
        self.assertEqual(self.job.live.read_bytes(), before)

    def test_mcp_pending_survives_failed_restart(self):
        self.job.mcp_pending.touch()
        with patch.object(refresh, 'unit', side_effect=RuntimeError('start failed')):
            with self.assertRaises(RuntimeError):
                self.job.restore_mcp()
        self.assertTrue(self.job.mcp_pending.exists())
        self.job.restore_mcp()
        self.assertFalse(self.job.mcp_pending.exists())

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
        with self.assertRaisesRegex(RuntimeError, 'checkpoint busy'):
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
