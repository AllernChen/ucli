import initSqlJs from 'sql.js'
import { readFileSync } from 'fs'

const dbPath = process.argv[2] || process.env.APPDATA + '/ucli/ucli.db'
const initFn = initSqlJs.default || initSqlJs
const SQL = await initFn()
const db = new SQL.Database(readFileSync(dbPath))
const r = db.exec('SELECT id,name,native_session_id,project_path,status FROM sessions ORDER BY rowid')
if (r.length) {
  console.log('rows:', r[0].values.length)
  for (const v of r[0].values) {
    console.log(v[0].slice(0,8), 'name='+v[1], 'native='+(v[2]||'(null)').slice(0,24), 'cwd='+v[3].slice(-30), 'status='+v[4])
  }
} else {
  console.log('empty')
}

// Also check stats
const r2 = db.exec('SELECT session_id,input_tokens,output_tokens,turns_count FROM session_stats')
if (r2.length && r2[0].values.length) {
  console.log('stats rows:', r2[0].values.length)
  for (const v of r2[0].values) {
    console.log('  sid='+v[0].slice(0,8), 'in='+v[1], 'out='+v[2], 'turns='+v[3])
  }
}
