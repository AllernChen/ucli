import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { openDb } from '../electron/persistence/db.js'

test('opening an all-zero database preserves it and creates a usable database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-recovery-'))
  const dbPath = join(dir, 'ucli.db')
  const zeroedDatabase = Buffer.alloc(53248)
  writeFileSync(dbPath, zeroedDatabase)

  let db
  try {
    db = await openDb(dbPath)
    assert.equal(db.recoveryInfo?.reason, 'invalid-database')
    assert.deepEqual(readFileSync(db.recoveryInfo.backupPath), zeroedDatabase)

    db.insertSession({
      id: 'recovered-session',
      project_path: 'F:\\projects\\recovered',
      adapter_id: 'claude',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    db.flush()
    assert.equal(db.getSession('recovered-session')?.id, 'recovered-session')
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opening a truncated SQLite database preserves it and creates a usable database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-recovery-'))
  const dbPath = join(dir, 'ucli.db')
  const truncatedDatabase = Buffer.from('SQLite format 3\0')
  writeFileSync(dbPath, truncatedDatabase)

  let db
  try {
    db = await openDb(dbPath)
    assert.equal(db.recoveryInfo?.reason, 'invalid-database')
    assert.deepEqual(readFileSync(db.recoveryInfo.backupPath), truncatedDatabase)
    db.touchProject('F:\\projects\\recovered', 'recovered')
    db.flush()
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opening a non-SQLite database preserves it and creates a usable database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-recovery-'))
  const dbPath = join(dir, 'ucli.db')
  const legacyContent = Buffer.from('{"sessions":{"legacy":{}}}')
  writeFileSync(dbPath, legacyContent)

  let db
  try {
    db = await openDb(dbPath)
    assert.equal(db.recoveryInfo?.reason, 'invalid-database')
    assert.deepEqual(readFileSync(db.recoveryInfo.backupPath), legacyContent)
    db.touchProject('F:\\projects\\recovered', 'recovered')
    db.flush()
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second flush keeps the previous valid database as a backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-backup-'))
  const dbPath = join(dir, 'ucli.db')
  const backupPath = `${dbPath}.bak`

  let db
  try {
    db = await openDb(dbPath)
    db.insertSession({
      id: 'session-1',
      project_path: 'F:\\projects\\backup',
      adapter_id: 'claude',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    db.flush()
    db.updateSession('session-1', { status: 'running' })
    db.flush()

    assert.equal(existsSync(backupPath), true)
    const initFn = initSqlJs.default || initSqlJs
    const SQL = await initFn()
    const backup = new SQL.Database(readFileSync(backupPath))
    const result = backup.exec("SELECT status FROM sessions WHERE id='session-1'")
    assert.equal(result[0].values[0][0], 'offline')
    backup.close()

    db.updateSession('session-1', { status: 'stopped' })
    db.flush()
    const nextBackup = new SQL.Database(readFileSync(backupPath))
    const nextResult = nextBackup.exec("SELECT status FROM sessions WHERE id='session-1'")
    assert.equal(nextResult[0].values[0][0], 'running')
    nextBackup.close()
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opening a damaged database restores the last valid backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-restore-'))
  const dbPath = join(dir, 'ucli.db')

  let db
  try {
    db = await openDb(dbPath)
    db.insertSession({
      id: 'preserved-session',
      project_path: 'F:\\projects\\preserved',
      adapter_id: 'claude',
      tier: 'safety-rules',
      status: 'offline',
      created_at: 1
    })
    db.flush()
    db.flush()
    db.close()
    db = null

    writeFileSync(dbPath, Buffer.alloc(53248))
    db = await openDb(dbPath)

    assert.equal(db.recoveryInfo?.reason, 'invalid-database')
    assert.equal(db.recoveryInfo?.restoredFromBackup, true)
    assert.equal(db.getSession('preserved-session')?.id, 'preserved-session')
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opening a database with a valid header and damaged pages isolates it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucli-db-page-damage-'))
  const dbPath = join(dir, 'ucli.db')
  const initFn = initSqlJs.default || initSqlJs
  const SQL = await initFn()
  const source = new SQL.Database()
  source.run('CREATE TABLE payload (id INTEGER PRIMARY KEY, value TEXT)')
  source.run('INSERT INTO payload (value) VALUES (?)', ['preserve enough structure to create a page'])
  const damagedDatabase = Buffer.from(source.export())
  source.close()
  damagedDatabase.fill(0, 100, 160)
  writeFileSync(dbPath, damagedDatabase)

  let db
  try {
    db = await openDb(dbPath)
    assert.equal(db.recoveryInfo?.reason, 'invalid-database')
    assert.deepEqual(readFileSync(db.recoveryInfo.backupPath), damagedDatabase)
    db.touchProject('F:\\projects\\recovered', 'recovered')
  } finally {
    db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
