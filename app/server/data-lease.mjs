import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite's OS file lock is released even if the owner process is terminated.
export function acquireDataLease(directory) {
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, '.owner-lock.sqlite'));
  try {
    database.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE');
  } catch (cause) {
    database.close();
    throw new Error('DATA_ROOT_BUSY: 数据目录已有写入所有者，请连接既有桌面实例', { cause });
  }
  return () => database.close();
}
