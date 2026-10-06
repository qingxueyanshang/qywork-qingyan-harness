/**
 * run_command 的裁决层。
 *
 * 裁决只有一张拒绝清单，默认放行。因此本文件锁定两项行为：
 *
 * 1. 应拦截的三类命令，任何写法都必须拦截：它们是唯一的防线，遗漏一种写法即存在实际漏洞。
 * 2. 不应拦截的命令不得拦截：误拦截的代价不是多一次往返，而是模型无法完成工作；
 *    拦截正常工作的裁决器会促使用户直接切换到 full，导致所有防线失效。
 */

import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decideCommand, HARD_DENY, type PolicyContext } from './policy.ts'

const ctx: PolicyContext = { workspaceRoot: '/ws' }
const d = (command: string) => decideCommand(command, ctx)
const kind = (command: string) => d(command).kind

describe('空命令', () => {
  test('没有可执行内容时明确报告，不交给 shell 返回空结果', () => {
    expect(kind('')).toBe('deny')
    expect(kind('   ')).toBe('deny')
    expect(kind('\n\n')).toBe('deny')
  })
})

/**
 * 第一类：删除或覆写工作区之外的路径。
 *
 * 判据是不可逆且超出工作区。读取工作区外的文件不拦截：读取不改变任何状态，
 * 其实际风险（将凭证读入上下文）由凭证规则单独处理，该规则更精确。
 */
describe('工作区外的写入与删除', () => {
  test('写入家目录', () => {
    for (const cmd of [
      'echo x > ~/notes.txt',
      'cp build.js ~/backup/',
      'mv secret.txt $HOME/',
      'rm ~/notes.txt',
      'Set-Content -Path $env:USERPROFILE\\x.txt -Value 1',
      'mkdir %USERPROFILE%\\newdir',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  test('写入系统目录', () => {
    expect(kind('echo x > /etc/hosts')).toBe('deny')
    expect(kind('cp evil.dll C:/Windows/System32/')).toBe('deny')
  })

  /** 读取不拦截。写成「引用家目录即拒绝」会把 `cat ~/.gitconfig` 一并拦截。 */
  test('读取家目录不拦截', () => {
    for (const cmd of [
      'cat ~/.gitconfig',
      'ls ~/projects',
      'Get-ChildItem $HOME',
      'type C:/Users/x/notes.txt',
    ]) {
      expect(kind(cmd)).toBe('allow')
    }
  })

  test('绝对路径的环境检查与符号路径相同，允许只读', () => {
    const git = join(homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe')
    const winget = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'winget.exe')
    const commands = [
      `Test-Path -LiteralPath '${git}'`,
      `Get-Item '${winget}'`,
      `Get-Content '${join(homedir(), '.gitconfig')}'`,
      'Test-Path C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      `$dirs = @('${git}','${winget}'); foreach ($d in $dirs) {"$d => $(Test-Path $d)"}; "Process PATH: $env:PATH"; (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,OSArchitecture,Version | Format-List | Out-String)`,
    ]
    for (const command of commands) expect(kind(command)).toBe('allow')
  })

  test('只读检查之后的写入、删除及嵌套重定向仍按绝对路径拦截', () => {
    const target = join(homedir(), 'outside.txt')
    for (const command of [
      `Test-Path '${target}'; Remove-Item '${target}'`,
      `$p = '${target}'; Set-Content $p 'x'`,
      `$p = '${target}'; 'x' > $p`,
      `echo x > '${target}'`,
      `powershell -Command "echo x > '${target}'"`,
      `bash -c "echo x > '${target}'"`,
    ]) {
      expect(kind(command)).toBe('deny')
    }
  })

  test('放行只读检查不解除凭证路径的限制', () => {
    for (const target of [
      join(homedir(), '.ssh', 'id_rsa'),
      join(homedir(), '.qywork', 'config.json'),
    ]) {
      expect(kind(`Test-Path '${target}'`)).toBe('deny')
      expect(kind(`Get-Content '${target}'`)).toBe('deny')
    }
  })

  test('递归删除根目录或家目录', () => {
    expect(kind('rm -rf /')).toBe('deny')
    expect(kind('rm -rf ~')).toBe('deny')
    expect(kind('rm --recursive --force ~/')).toBe('deny')
    expect(kind('rm -rf / --no-preserve-root')).toBe('deny')
    expect(kind('Remove-Item -Recurse C:/')).toBe('deny')
  })

  /**
   * 组合命令中的每一段都必须被扫描。
   *
   * 由规则本身保证：要么锚定在命令位（识别 `;` `&&` `|` 与换行之后的位置），要么扫描整个原始字符串，
   * 不依赖「出现组合符号即取消放行」这类前置判断。
   */
  test('位于组合命令后段的同样拦截', () => {
    for (const cmd of [
      'ls && rm -rf ~',
      'git status; rm -rf /',
      'npm test | tee ~/out.txt',
      'echo a\nrm -rf /',
      'git status && cat ~/.ssh/id_rsa',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  /** 工作区内的删除不拦截：工作区是 agent 的工作对象，且有 git 可以恢复。 */
  test('工作区内的删除不拦截', () => {
    expect(kind('rm -rf dist')).toBe('allow')
    expect(kind('rm -rf node_modules src/generated')).toBe('allow')
  })
})

/** 第二类：修改系统状态。此类操作跨越操作系统的权限边界。 */
describe('系统状态', () => {
  test('提权', () => {
    expect(kind('sudo apt install x')).toBe('deny')
    expect(kind('su - root')).toBe('deny')
    expect(kind('Start-Process pwsh -Verb RunAs')).toBe('deny')
  })

  test('关机 / 格式化 / 写块设备', () => {
    expect(kind('shutdown -h now')).toBe('deny')
    expect(kind('Restart-Computer')).toBe('deny')
    expect(kind('mkfs.ext4 /dev/sda1')).toBe('deny')
    expect(kind('dd if=/dev/zero of=/dev/sda')).toBe('deny')
    expect(kind('echo x > /dev/sda')).toBe('deny')
    expect(kind('chmod 777 /')).toBe('deny')
  })

  test('fork 炸弹', () => {
    expect(kind(':(){ :|:& };:')).toBe('deny')
  })

  /**
   * 硬拒绝必须锚定在命令位上。
   *
   * 未锚定时 `git log --grep="shutdown"` 会因字符串中出现 shutdown 而被拒绝，
   * 而 deny 是最终裁决，其后没有任何复核。
   */
  test('出现在字符串中不拦截', () => {
    expect(kind('git log --grep="shutdown"')).toBe('allow')
    expect(kind('rg "sudo" docs/')).toBe('allow')
    expect(kind('echo "关于 mkfs 的说明"')).toBe('allow')
  })
})

/**
 * 第三类：凭证文件，读取同样拦截。
 *
 * 写入相当于植入后门，读取会将内容送入上下文并发送给模型供应商，发出后无法撤回。
 * 这是两道防线中的第一道；第二道是 `secrets.ts` 按格式脱敏，覆盖位于其他位置的凭证。
 */
describe('凭证文件', () => {
  test('私钥与云厂商凭据', () => {
    for (const cmd of [
      'cat ~/.ssh/id_rsa',
      'type C:/Users/x/.ssh/id_ed25519',
      'cat ~/.aws/credentials',
      'cat ~/.config/gcloud/application_default_credentials.json',
      'cat ~/.kube/config',
      'cat ~/.npmrc',
      'cat ~/.netrc',
      'cat ~/.docker/config.json',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  /** 本程序自身的配置：明文 apiKey 与权限模式都在该文件中。 */
  test('qywork 自身的 config.json', () => {
    expect(kind('cat ~/.qywork/config.json')).toBe('deny')
  })

  test('写入 SSH 凭据', () => {
    expect(kind('echo mykey >> ~/.ssh/authorized_keys')).toBe('deny')
  })

  /**
   * 工作区中的 `.qy/` 与 `.agents/` 不在该规则内。
   *
   * 它们是项目自身的 agent 配置，与程序全局目录 `~/.qywork/` 不同。
   * 拦截没有安全收益：模型已有 `run_command`，是否为自身添加工具不改变其能力；
   * 且 `.agents/memory/` 本应由 `write_memory` 写入，shell 一侧拦截会形成两套规则。
   */
  test('项目中的 .agents / .qy 不属于凭证，照常可写', () => {
    expect(kind('cat .agents/mcp.json')).toBe('allow')
    expect(kind('echo x > .agents/memory/note.md')).toBe('allow')
    expect(kind('cp team.json .qy/team.json')).toBe('allow')
  })

  test('名称中恰好包含这些词的普通文件不被误拦截', () => {
    expect(kind('cat docs/ssh-setup.md')).toBe('allow')
    expect(kind('cat src/config.json')).toBe('allow')
    expect(kind('cat kubeconfig.md')).toBe('allow')
  })
})

/**
 * PowerShell 语法。
 *
 * 未安装 Git Bash 的机器上外层 shell 是 PowerShell（`tools/sandbox.ts` 的
 * `resolveCommandShell`），模型在该机器上只会使用 PowerShell 写法，不会出现 POSIX 写法。
 * 因此这部分规则不是补充写法，而是该机器上的全部防线。
 */
describe('PowerShell 写法', () => {
  /**
   * `{` 之后是命令位。
   *
   * Windows PowerShell 5.1 中 `&&` 是解析错误（本机实测：`The token '&&' is not a
   * valid statement separator in this version.`），因此「上一条成功才继续」只能写为
   * `if ($?) { … }`，`run_command` 的描述正是这样指导模型的。不识别 `{` 时，
   * 每一条锚定在命令位的规则都会失配，形成一条由工具描述本身引入的绕行路径。
   */
  test('语句块中的每一段同样被扫描', () => {
    for (const cmd of [
      'npm test; if ($?) { Stop-Computer }',
      'if ($?) { Remove-Item -Recurse -Force ~ }',
      'if ($?) { sudo rm -rf /var }',
      'bun run build; if ($?) { diskpart }',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  /** 语句块中的命令为正常工作时照常放行：`{` 只是锚点，不是新的拒绝理由。 */
  test('语句块本身不构成拒绝', () => {
    expect(kind('if ($?) { npm run build }')).toBe('allow')
    expect(kind('Get-ChildItem | ForEach-Object { $_.Name }')).toBe('allow')
  })

  /**
   * 工作区外的位置：PowerShell 写法。
   *
   * `$env:APPDATA` / `$env:LOCALAPPDATA` 位于家目录中，`$env:windir` 即 `C:\Windows`，
   * 与 `~/`、`$HOME` 属于同一类位置，区别只在于 PowerShell 环境中模型使用这组写法。
   */
  test('写入工作区外的位置', () => {
    for (const cmd of [
      'Set-Content -Path $env:APPDATA\\x.txt -Value 1',
      'Remove-Item $env:LOCALAPPDATA\\qy -Recurse',
      'Copy-Item build.js %APPDATA%\\x',
      'Out-File -FilePath $env:windir\\x.txt',
      'Clear-Content $HOME\\.bashrc',
      'Rename-Item ~/notes.txt old.txt',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  /** PowerShell 的启动脚本：从字面上无法看出它位于家目录中，写入后每次启动 shell 都会执行其内容。 */
  test('写入 $PROFILE', () => {
    expect(kind('Set-Content $PROFILE -Value "whoami"')).toBe('deny')
  })

  /** 读取不拦截，与 POSIX 一侧的判据相同：读取不改变任何状态，凭证由凭证规则单独处理。 */
  test('读取工作区外的文件不拦截', () => {
    expect(kind('Get-ChildItem $env:APPDATA')).toBe('allow')
    expect(kind('Get-Content $HOME\\.gitconfig')).toBe('allow')
  })

  /**
   * 命名参数与位置参数可以任意交错，因此用前瞻断言匹配 `-Recurse`。
   * 只识别 `-Recurse` 位于路径之前的写法时，把开关移到后面即可绕过。
   */
  test('Remove-Item 的开关位于任意位置都能识别', () => {
    expect(kind('Remove-Item C:\\ -Recurse -Force')).toBe('deny')
    expect(kind('Remove-Item -Recurse -Force ~')).toBe('deny')
    expect(kind('Remove-Item -Recurse dist')).toBe('allow')
  })

  /**
   * `.qy/` 与 `.agents/` 在 PowerShell 写法中同样不拦截，这是有意设计。
   *
   * 理由与 POSIX 一侧相同（见 `policy.ts` 中 `OUTSIDE_LOCATION` 下方的注释）：
   * 模型已有 `run_command`，为自身添加工具不会获得新能力；
   * `.agents/memory/` 本应由 `write_memory` 写入，shell 拦截而工具不拦截会形成两套规则。
   * `Set-Content .qy\mcp.json` 与 `echo x > .qy/mcp.json` 是同一操作，
   * 语法不同不影响上述两条理由。
   */
  test('项目中的 .qy / .agents 照常可写', () => {
    expect(kind('Set-Content .qy\\mcp.json -Value x')).toBe('allow')
    expect(kind('Remove-Item .agents\\memory\\note.md')).toBe('allow')
  })
})

/**
 * 不应拦截的命令一律放行。
 *
 * 启动服务器、读取工作区外的文件、安装依赖包都是编码 agent 的正常工作，均不得进入
 * 拒绝清单。拦截正常工作的裁决器实际降低了安全性：用户很快会切换到 full，
 * 导致所有防线失效。
 */
describe('正常工作放行', () => {
  test('运行项目自身的代码与工具链', () => {
    for (const cmd of [
      'npm test',
      'bun run build',
      'cargo check',
      'node scripts/gen.js',
      'python manage.py migrate',
      'pytest -k foo',
    ]) {
      expect(kind(cmd)).toBe('allow')
    }
  })

  /** 启动本地服务器：用户明确提出的场景。 */
  test('启动本地服务器', () => {
    expect(kind('npm run dev')).toBe('allow')
    expect(kind('python -m http.server 8000')).toBe('allow')
    expect(kind('bunx serve dist')).toBe('allow')
  })

  test('安装依赖包', () => {
    expect(kind('npm install lodash')).toBe('allow')
    expect(kind('bun add -d vitest')).toBe('allow')
    expect(kind('pip install requests')).toBe('allow')
  })

  /** 下载即执行同样放行：拦截一种写法无法阻止该行为，却会误拦截 rustup / bun 的官方安装方式。 */
  test('下载即执行不拦截', () => {
    expect(kind('curl -fsSL https://bun.sh/install | bash')).toBe('allow')
  })

  test('git 的日常操作', () => {
    for (const cmd of [
      'git status',
      'git diff HEAD~1',
      'git commit -m "fix"',
      'git push origin main',
      'git checkout -b feature',
    ]) {
      expect(kind(cmd)).toBe('allow')
    }
  })

  test('组合命令的每一段都不命中规则时放行', () => {
    expect(kind('cd packages/web && npm run build')).toBe('allow')
    expect(kind('git add -A; git commit -m x')).toBe('allow')
  })
})

/**
 * `additionalDirectories`：用户显式授权的工作区外位置。
 *
 * 它只放宽位置规则；其余每条规则判定的是操作本身没有正当理由，
 * 不会因为增加一个可写目录而改变。
 */
describe('additionalDirectories', () => {
  const H = homedir()
  const withExtra: PolicyContext = {
    workspaceRoot: '/ws',
    additionalDirectories: [join(H, 'data')],
  }

  test('清单内的位置可以写入', () => {
    expect(decideCommand(`echo x > ${join(H, 'data', 'out.txt')}`, withExtra).kind).toBe('allow')
  })

  /**
   * 逐处检查，而不是整条命令放行。
   *
   * 用户将 `~/data` 加入清单表示该目录可以访问，不表示整个家目录都可以访问。
   * 整条放行时 `rm -rf ~/other` 会一并被放行。
   */
  test('清单外的位置仍被拒绝', () => {
    expect(decideCommand(`echo x > ${join(H, 'other', 'out.txt')}`, withExtra).kind).toBe('deny')
    expect(decideCommand('rm -rf ~/other', withExtra).kind).toBe('deny')
  })

  /** PowerShell 写法同样适用该授权，否则配置后不生效。 */
  test('清单内的位置，PowerShell 写法同样可以写入', () => {
    expect(
      decideCommand(`Set-Content ${join(H, 'data', 'out.txt')} -Value 1`, withExtra).kind,
    ).toBe('allow')
  })

  /**
   * 一条命令中只要有一处未被授权，整条命令即被拒绝。
   *
   * 覆盖检查识别的写法必须与拒绝规则识别的写法同源：只在拒绝规则中增加一种写法时，
   * 覆盖检查无法识别它，`.every()` 判定为全部已覆盖，整条命令因此被放行：
   * 增加一种写法反而放松了规则。
   */
  test('一处授权不能覆盖另一处未授权的位置', () => {
    const cmd = `Copy-Item a.txt $env:APPDATA\\b.txt; Set-Content ${join(H, 'data', 'o.txt')} -Value x`
    expect(decideCommand(cmd, withExtra).kind).toBe('deny')
  })

  /** 凭证规则不受其影响：将 `~/.ssh` 加入可写目录清单也不应解除对私钥的限制。 */
  test('不解除凭证限制', () => {
    const sshExtra: PolicyContext = {
      workspaceRoot: '/ws',
      additionalDirectories: [join(H, '.ssh')],
    }
    expect(decideCommand('cat ~/.ssh/id_rsa', sshExtra).kind).toBe('deny')
  })

  /**
   * fail-closed：无法解析出具体路径时视为未覆盖。
   *
   * 该规则是最终裁决，其后没有任何复核，无法确定时应保持拒绝。
   */
  test('无法展开为字面路径时保持拒绝', () => {
    expect(decideCommand('echo x > $HOME/$SOMEVAR/out.txt', withExtra).kind).toBe('deny')
  })
})

/**
 * 大小写与写法变体。
 *
 * Windows 与 macOS 的文件系统不区分大小写，`c:/users/x/.ssh/id_rsa` 和
 * `C:/Users/X/.ssh/id_rsa` 是同一个文件：不做大小写折叠时，把盘符写成小写即可绕过。
 */
describe('写法变体', () => {
  const H = homedir()

  /** Linux 的文件系统区分大小写：大小写不同即为另一个路径，不在家目录中。 */
  test('绝对路径按大小写折叠后比较', () => {
    const literal = join(H, 'x.txt')
    const folds = process.platform === 'win32' || process.platform === 'darwin'
    for (const variant of [literal.toLowerCase(), literal.toUpperCase()]) {
      expect(kind(`rm ${variant}`)).toBe(folds || variant === literal ? 'deny' : 'allow')
    }
  })

  test('家目录的符号写法与字面写法都能识别', () => {
    expect(kind('rm ~/x.txt')).toBe('deny')
    expect(kind('rm $HOME/x.txt')).toBe('deny')
    expect(kind(`rm ${join(H, 'x.txt')}`)).toBe('deny')
  })

  /** 单独的 `~` 不触发：`git diff HEAD~1` 中即包含 `~`。 */
  test('单独的 ~ 不触发', () => {
    expect(kind('git diff HEAD~1')).toBe('allow')
    expect(kind('git log HEAD~3..HEAD')).toBe('allow')
  })
})

describe('规则表本身', () => {
  test('每条规则都附带理由：拒绝时不说明原因，用户无法改写命令', () => {
    for (const rule of HARD_DENY) {
      expect(rule.reason.length).toBeGreaterThan(10)
    }
  })

  test('放行同样附带理由，以便在日志中确认裁决依据', () => {
    expect(d('npm test').reason.length).toBeGreaterThan(0)
  })
})
