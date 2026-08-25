/**
 * run_command 的裁决层。
 *
 * 裁决只有**一张拒绝清单**，放行是默认值。所以这个文件压两件事：
 *
 * 1. **该拦的三类，换各种写法都要拦住**——它们是唯一的防线，漏一种写法就是真漏。
 * 2. **不该拦的不许拦**——误伤的代价不是「多一次往返」，是模型干不了活，
 *    而一个把本职工作也拦掉的裁决器会让用户直接切到 full，因此一层防线都不剩。
 */

import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decideCommand, HARD_DENY, type PolicyContext } from './policy.ts'

const ctx: PolicyContext = { workspaceRoot: '/ws' }
const d = (command: string) => decideCommand(command, ctx)
const kind = (command: string) => d(command).kind

describe('空命令', () => {
  test('没有可执行内容时说清楚，不落到 shell 去回一个空结果', () => {
    expect(kind('')).toBe('deny')
    expect(kind('   ')).toBe('deny')
    expect(kind('\n\n')).toBe('deny')
  })
})

/**
 * 第一类：**删除 / 覆写工作区之外的路径**。
 *
 * 判据是「不可逆 + 越界」。读工作区外**不拦**——读不改变任何状态，
 * 而它真正的风险（把凭证读进上下文）由凭证那条规则单独管，那条更准。
 */
describe('越界的写与删', () => {
  test('往家目录写', () => {
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

  test('往系统目录写', () => {
    expect(kind('echo x > /etc/hosts')).toBe('deny')
    expect(kind('cp evil.dll C:/Windows/System32/')).toBe('deny')
  })

  /** **读不拦。** 写成「引用家目录就拒」会把 `cat ~/.gitconfig` 一起拦了。 */
  test('读家目录不拦', () => {
    for (const cmd of [
      'cat ~/.gitconfig',
      'ls ~/projects',
      'Get-ChildItem $HOME',
      'type C:/Users/x/notes.txt',
    ]) {
      expect(kind(cmd)).toBe('allow')
    }
  })

  test('递归删根目录或家目录', () => {
    expect(kind('rm -rf /')).toBe('deny')
    expect(kind('rm -rf ~')).toBe('deny')
    expect(kind('rm --recursive --force ~/')).toBe('deny')
    expect(kind('rm -rf / --no-preserve-root')).toBe('deny')
    expect(kind('Remove-Item -Recurse C:/')).toBe('deny')
  })

  /**
   * 组合命令里的**每一段**都要被扫到。
   *
   * 靠的是规则本身：要么锚在命令位（认 `;` `&&` `|` 换行之后），要么扫整个原始串，
   * 不靠「有组合符号就取消放行资格」那种前置判断。
   */
  test('藏在组合命令后面一样拦', () => {
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

  /** 工作区内的删除**不拦**：那是它的工作对象，而且有 git。 */
  test('工作区内的删除不拦', () => {
    expect(kind('rm -rf dist')).toBe('allow')
    expect(kind('rm -rf node_modules src/generated')).toBe('allow')
  })
})

/** 第二类：**改系统状态**。这条跨的是操作系统权限边界。 */
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
   * 硬拒绝必须锚在**命令位**上。
   *
   * 不锚的话 `git log --grep="shutdown"` 会因为字符串里出现了 shutdown 被拒，
   * 而这套模型下 deny 是终局判决，后面没有任何一层兜底。
   */
  test('出现在字符串里不算', () => {
    expect(kind('git log --grep="shutdown"')).toBe('allow')
    expect(kind('rg "sudo" docs/')).toBe('allow')
    expect(kind('echo "关于 mkfs 的说明"')).toBe('allow')
  })
})

/**
 * 第三类：**凭证文件**——读也拦。
 *
 * 写是装后门，读是把内容送进上下文再发给模型供应商，**发出去收不回**。
 * 这是两道防线的第一道；第二道是 `secrets.ts` 按形状脱敏，兜住换了位置的。
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

  /** 本程序自己的配置：明文 apiKey、权限模式都在这一个文件里。 */
  test('qywork 自己的 config.json', () => {
    expect(kind('cat ~/.qywork/config.json')).toBe('deny')
  })

  test('往 SSH 凭据里写', () => {
    expect(kind('echo mykey >> ~/.ssh/authorized_keys')).toBe('deny')
  })

  /**
   * **工作区里的 `.qy/` `.agents/` 不在这条规则里。**
   *
   * 那是项目自己的 agent 配置，与程序全局目录 `~/.qywork/` 是两回事。
   * 拦它没有安全收益——模型有 `run_command`，给自己加不加工具能做的事一样多；
   * 而且 `.agents/memory/` 本来就是 `write_memory` 在写，shell 拦就成了两套账。
   */
  test('项目里的 .agents / .qy 不算凭证，照常可写', () => {
    expect(kind('cat .agents/mcp.json')).toBe('allow')
    expect(kind('echo x > .agents/memory/note.md')).toBe('allow')
    expect(kind('cp team.json .qy/team.json')).toBe('allow')
  })

  test('名字里碰巧带这些词的普通文件不误伤', () => {
    expect(kind('cat docs/ssh-setup.md')).toBe('allow')
    expect(kind('cat src/config.json')).toBe('allow')
    expect(kind('cat kubeconfig.md')).toBe('allow')
  })
})

/**
 * PowerShell 语法。
 *
 * 没装 Git Bash 的机器上外层 shell 就是 PowerShell（`tools/sandbox.ts` 的
 * `resolveCommandShell`），那台机器上模型**只会**写这一半——POSIX 的写法一次都不出现。
 * 所以这不是「多认几种写法」，是那台机器上的全部防线。
 */
describe('PowerShell 写法', () => {
  /**
   * **`{` 之后是命令位。**
   *
   * Windows PowerShell 5.1 上 `&&` 是解析错误（本机实测：`The token '&&' is not a
   * valid statement separator in this version.`），所以「上一条成功才继续」只能写
   * `if ($?) { … }`——而 `run_command` 的描述里正是这么教模型写的。不认 `{` 的话，
   * 每一条锚在命令位上的规则都会失配，**这条旁路是工具描述自己造出来的**。
   */
  test('语句块里的每一段照样扫到', () => {
    for (const cmd of [
      'npm test; if ($?) { Stop-Computer }',
      'if ($?) { Remove-Item -Recurse -Force ~ }',
      'if ($?) { sudo rm -rf /var }',
      'bun run build; if ($?) { diskpart }',
    ]) {
      expect(kind(cmd)).toBe('deny')
    }
  })

  /** 块里装的是本职工作就照常放行——`{` 只是锚点，不是新的拒绝理由。 */
  test('语句块本身不构成拒绝', () => {
    expect(kind('if ($?) { npm run build }')).toBe('allow')
    expect(kind('Get-ChildItem | ForEach-Object { $_.Name }')).toBe('allow')
  })

  /**
   * 工作区外的位置，PowerShell 的拼法。
   *
   * `$env:APPDATA` / `$env:LOCALAPPDATA` 在家目录里，`$env:windir` 就是 `C:\Windows`
   * ——和 `~/`、`$HOME` 是同一批位置，只是那台机器上模型写的是这一批。
   */
  test('往工作区外写', () => {
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

  /** PowerShell 的启动脚本：字面上看不出它在家目录里，写它 = 之后每开一个 shell 都跑一遍。 */
  test('写 $PROFILE', () => {
    expect(kind('Set-Content $PROFILE -Value "whoami"')).toBe('deny')
  })

  /** 读**不拦**，与 POSIX 侧同一条判据：读不改变任何状态，凭证那条单独管。 */
  test('读工作区外不拦', () => {
    expect(kind('Get-ChildItem $env:APPDATA')).toBe('allow')
    expect(kind('Get-Content $HOME\\.gitconfig')).toBe('allow')
  })

  /**
   * 参数与位置参数可以任意穿插，所以 `-Recurse` 用前视找。
   * 只认「`-Recurse` 在路径前面」的话，把开关挪到后面就绕过去了。
   */
  test('Remove-Item 的开关放哪都算', () => {
    expect(kind('Remove-Item C:\\ -Recurse -Force')).toBe('deny')
    expect(kind('Remove-Item -Recurse -Force ~')).toBe('deny')
    expect(kind('Remove-Item -Recurse dist')).toBe('allow')
  })

  /**
   * **`.qy/` 与 `.agents/` 在这里同样不拦，这是有意的，不是漏了。**
   *
   * 理由与 POSIX 侧一字不差（见 `policy.ts` 里 `OUTSIDE_LOCATION` 上方那段）：
   * 模型手里已经有 `run_command`，给自己加个工具并没有多出任何能力；而
   * `.agents/memory/` 本来就是 `write_memory` 在写，shell 拦、工具不拦就是两套账。
   * `Set-Content .qy\mcp.json` 与 `echo x > .qy/mcp.json` 是同一件事，
   * 换个语法不改变上面两条。
   */
  test('项目里的 .qy / .agents 照常可写', () => {
    expect(kind('Set-Content .qy\\mcp.json -Value x')).toBe('allow')
    expect(kind('Remove-Item .agents\\memory\\note.md')).toBe('allow')
  })
})

/**
 * **不该拦的一律放行。**
 *
 * 「起服务器」「读工作区外」「装新包」全是编码 agent 的本职工作，一条都不许进
 * 拒绝清单。一个把本职工作也拦掉的裁决器，实际安全性是负的——用户三分钟内就会
 * 切到 full，因此一层防线都不剩。
 */
describe('本职工作放行', () => {
  test('跑项目自己的代码与工具链', () => {
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

  /** 起本地服务器——用户点名的那个场景。 */
  test('起本地服务器', () => {
    expect(kind('npm run dev')).toBe('allow')
    expect(kind('python -m http.server 8000')).toBe('allow')
    expect(kind('bunx serve dist')).toBe('allow')
  })

  test('装包', () => {
    expect(kind('npm install lodash')).toBe('allow')
    expect(kind('bun add -d vitest')).toBe('allow')
    expect(kind('pip install requests')).toBe('allow')
  })

  /** 下载即执行也放行：拦一种写法拦不住这件事，却会误伤 rustup / bun 的官方安装。 */
  test('下载即执行不再拦', () => {
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

  test('组合命令只要每一段都没事就放行', () => {
    expect(kind('cd packages/web && npm run build')).toBe('allow')
    expect(kind('git add -A; git commit -m x')).toBe('allow')
  })
})

/**
 * `additionalDirectories`：用户显式授权的工作区外位置。
 *
 * 它只放开**位置**那一条，其余每条判的是「这件事本身没有正当理由」，
 * 不会因为多配了一个可写目录就改变。
 */
describe('additionalDirectories', () => {
  const H = homedir()
  const withExtra: PolicyContext = {
    workspaceRoot: '/ws',
    additionalDirectories: [join(H, 'data')],
  }

  test('清单内的位置可以写', () => {
    expect(decideCommand(`echo x > ${join(H, 'data', 'out.txt')}`, withExtra).kind).toBe('allow')
  })

  /**
   * **逐处检查，不是整条放开。**
   *
   * 用户把 `~/data` 加进清单的意思是「这个目录可以碰」，不是「家目录全可以碰」。
   * 整条放开的话 `rm -rf ~/other` 会一起被放行。
   */
  test('清单外的位置仍然拒', () => {
    expect(decideCommand(`echo x > ${join(H, 'other', 'out.txt')}`, withExtra).kind).toBe('deny')
    expect(decideCommand('rm -rf ~/other', withExtra).kind).toBe('deny')
  })

  /** PowerShell 的写法一样能用这份授权，否则「配了却不管用」。 */
  test('清单内的位置，PowerShell 写法同样可写', () => {
    expect(
      decideCommand(`Set-Content ${join(H, 'data', 'out.txt')} -Value 1`, withExtra).kind,
    ).toBe('allow')
  })

  /**
   * **一条命令里只要有一处没被授权，整条就拒。**
   *
   * 覆盖检查扫的写法必须与拒绝规则认的写法同源：只往拒绝那边加一种写法的话，
   * 覆盖检查看不见它，`.every()` 判成「全部被覆盖」，因此这条整个放行——
   * 多认一种写法反而放松了规则。
   */
  test('一处授权盖不住另一处没授权的', () => {
    const cmd = `Copy-Item a.txt $env:APPDATA\\b.txt; Set-Content ${join(H, 'data', 'o.txt')} -Value x`
    expect(decideCommand(cmd, withExtra).kind).toBe('deny')
  })

  /** 凭证那条不受它影响——把 `~/.ssh` 加进可写目录清单也不该放开私钥。 */
  test('放不开凭证', () => {
    const sshExtra: PolicyContext = {
      workspaceRoot: '/ws',
      additionalDirectories: [join(H, '.ssh')],
    }
    expect(decideCommand('cat ~/.ssh/id_rsa', sshExtra).kind).toBe('deny')
  })

  /**
   * fail-closed：解析不出具体路径就当没被覆盖。
   *
   * 这条规则是终局判决，后面没有任何一层兜底，「拿不准」的正确方向是保持拒绝。
   */
  test('展开不出字面路径时保持拒绝', () => {
    expect(decideCommand('echo x > $HOME/$SOMEVAR/out.txt', withExtra).kind).toBe('deny')
  })
})

/**
 * 大小写与写法变体。
 *
 * Windows 与 macOS 的文件系统不区分大小写，`c:/users/x/.ssh/id_rsa` 和
 * `C:/Users/X/.ssh/id_rsa` 是同一个文件——不折的话，把盘符敲成小写就绕过了。
 */
describe('写法变体', () => {
  const H = homedir()

  test('绝对路径的大小写要折', () => {
    expect(kind(`rm ${join(H, 'x.txt').toLowerCase()}`)).toBe('deny')
    expect(kind(`rm ${join(H, 'x.txt').toUpperCase()}`)).toBe('deny')
  })

  test('家目录的符号写法与字面写法都认', () => {
    expect(kind('rm ~/x.txt')).toBe('deny')
    expect(kind('rm $HOME/x.txt')).toBe('deny')
    expect(kind(`rm ${join(H, 'x.txt')}`)).toBe('deny')
  })

  /** 裸 `~` 不算——`git diff HEAD~1` 里就有一个。 */
  test('裸 ~ 不触发', () => {
    expect(kind('git diff HEAD~1')).toBe('allow')
    expect(kind('git log HEAD~3..HEAD')).toBe('allow')
  })
})

describe('规则表本身', () => {
  test('每条都带得出理由 —— 拒绝而说不出为什么，用户没法改写命令', () => {
    for (const rule of HARD_DENY) {
      expect(rule.reason.length).toBeGreaterThan(10)
    }
  })

  test('放行也给理由，日志里才看得出是走了哪条路', () => {
    expect(d('npm test').reason.length).toBeGreaterThan(0)
  })
})
