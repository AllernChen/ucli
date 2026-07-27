export const LEGACY_DEFAULT_RULESET = {
  id: 'default',
  name: '默认规则集',
  deny: [],
  highRisk: [
    'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(git push:*)', 'Bash(git reset --hard:*)',
    'Bash(git clean -fd:*)', 'Bash(npm publish:*)', 'Bash(docker rm:*)', 'Bash(docker rmi:*)',
    'Bash(docker system prune:*)', 'Bash(sudo:*)', 'Bash(chmod:*)',
    'Bash(re:curl\\s.*\\|\\s*(sh|bash))', 'Bash(re:wget\\s.*\\|\\s*(sh|bash))',
    'Write(.env*)', 'Edit(.env*)', 'Write(~/.ssh/**)', 'Edit(~/.ssh/**)',
    'Write(~/.aws/**)', 'Edit(~/.gitconfig)'
  ],
  allow: [
    'Bash(ls:*)', 'Bash(cat:*)', 'Bash(pwd:*)', 'Bash(git status:*)',
    'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(echo:*)',
    'Read(*)'
  ]
}

export const DEFAULT_RULESET = {
  id: 'default',
  name: '默认规则集',
  deny: [],
  highRisk: [
    'Bash(rm -rf:*)', 'Bash(rm -fr:*)', 'Bash(rm -r:*)',
    'Bash(rmdir /s:*)', 'Bash(del /s:*)', 'Bash(Remove-Item -Recurse:*)',
    'Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)',
    'Bash(npm publish:*)', 'Bash(pnpm publish:*)',
    'Bash(docker system prune:*)', 'Bash(docker volume prune:*)',
    'Bash(sudo:*)', 'Bash(chmod -R:*)',
    'Bash(re:curl\\s.*\\|\\s*(sh|bash))', 'Bash(re:wget\\s.*\\|\\s*(sh|bash))',
    'Write(~/.ssh/**)', 'Edit(~/.ssh/**)', 'Write(~/.aws/**)', 'Edit(~/.aws/**)',
    'Write(~/.gitconfig)', 'Edit(~/.gitconfig)'
  ],
  allow: [
    'Bash(ls:*)', 'Bash(dir:*)', 'Bash(Get-ChildItem:*)',
    'Bash(cat:*)', 'Bash(type:*)', 'Bash(Get-Content:*)', 'Bash(pwd:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
    'Bash(git show:*)', 'Bash(git fetch:*)',
    'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ping:*)', 'Bash(nslookup:*)',
    'Bash(Resolve-DnsName:*)', 'Bash(Test-NetConnection:*)', 'Bash(echo:*)',
    'Read(*)', 'WebFetch(*)', 'WebSearch(*)'
  ]
}

function sameList(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((item, index) => item === right[index])
}

/**
 * Replace only the untouched v0.4.3 default. Any user-edited ruleset is
 * returned as-is so an upgrade never overwrites deliberate policy choices.
 */
export function upgradeDefaultRuleset(ruleset) {
  if (
    ruleset?.id === LEGACY_DEFAULT_RULESET.id &&
    sameList(ruleset.deny, LEGACY_DEFAULT_RULESET.deny) &&
    sameList(ruleset.highRisk, LEGACY_DEFAULT_RULESET.highRisk) &&
    sameList(ruleset.allow, LEGACY_DEFAULT_RULESET.allow)
  ) {
    return structuredClone(DEFAULT_RULESET)
  }
  return ruleset
}
