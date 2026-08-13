const THEMES = Object.freeze([
  Object.freeze({
    id: 'executive', label: '高管简报', marker: 'data-executive-brief',
    css: 'body{background-color:#f4f0e8;color:#20201d}nav{background-color:#20201d;color:#ffffff}main{max-width:960px}h1,h2{color:#6b3d24}'
  }),
  Object.freeze({
    id: 'engineering', label: '工程报告', marker: 'data-engineering-grid',
    css: 'body{background-color:#0e1720;color:#d9e5ee}nav{background-color:#142635;color:#ffffff}main{max-width:1100px}h1,h2{color:#67d8ef}pre{background-color:#162632;color:#eefaff}'
  }),
  Object.freeze({
    id: 'timeline', label: '进展时间线', marker: 'data-timeline',
    css: 'body{background-color:#fffaf2;color:#352e27}nav{background-color:#7d3f2f;color:#ffffff}main{max-width:900px}article{border-left:4px solid #d88159;padding-left:24px}h2{color:#7d3f2f}'
  }),
  Object.freeze({
    id: 'dashboard', label: '数据看板', marker: 'data-dashboard-layout',
    css: 'body{background-color:#edf3f6;color:#172a35}nav{background-color:#163846;color:#ffffff}main{max-width:1180px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.kpi{background-color:#ffffff;color:#172a35;padding:18px}'
  }),
  Object.freeze({
    id: 'print', label: '打印归档', marker: 'data-print-layout',
    css: 'body{background-color:#ffffff;color:#111111}nav{background-color:#eeeeee;color:#111111}main{max-width:820px}h1,h2{color:#111111;border-bottom:1px solid #777777}'
  })
])

export const SUMMARY_THEME_IDS = Object.freeze(THEMES.map(theme => theme.id))
export const SUMMARY_THEME_CATALOG = THEMES

export function getSummaryTheme(themeId) {
  const theme = THEMES.find(item => item.id === themeId)
  if (!theme) throw Object.assign(new Error('Invalid summary theme'), { code: 'SUMMARY_THEME_INVALID' })
  return theme
}
