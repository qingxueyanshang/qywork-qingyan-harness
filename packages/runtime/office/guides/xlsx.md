# Excel（xlsx）做法要点

## 流程

1. 修改已有文件时先调用 `read_office`，取得工作表、公式、缓存值与 `sha256`；`range` 填写工作表名可查看更多行。
2. 用 `write_file` 写入 Python 制作脚本。
3. 用 `write_office` 执行：脚本写出工作副本 → 办公软件以只读方式打开并全量重算，把每个公式的计算结果写回文件 → 结构检查 → 按工作表渲染 → 提交。
4. 查看检查项中的错误值；用 `view_office` 查看页面，页码写为「工作表名:页码」，结果中标明每页对应的单元格区域。
5. 发现问题时修改脚本，再次执行 `write`。

## 脚本 API

全局变量 `office`（也可用 `from qyoffice import office` 导入）：`office.output(路径)` 取得工作副本路径；`office.inputs`；`office.workspace`；`office.figure(宽cm, 高cm)`；`office.app("xlsx")` 取得新启动的 WPS 表格 / Excel 实例的原生对象（每次调用启动一个新实例，一个实例只打开一个文件），不要用它另存文件。

可使用 openpyxl、lxml 的完整 API。

## 公式规范

- 计算写成公式，不写入计算好的数值：输入、计算、输出分区放置，输入单元格单独标出。
- 不要用 `IFERROR(…, 0)` 或 `IFERROR(…, "")` 掩盖未知错误；只对已知会出现的情况（查找无结果、分母为零）写明确的判断，并说明处理方式。
- 区分真实的零、缺少数据与不适用：缺少数据时写明缺少的内容，不填 0。
- 尽量不用易变函数（NOW、TODAY、RAND、OFFSET、INDIRECT）。
- openpyxl 写入的 SEQUENCE、FILTER、UNIQUE、SORT 等动态数组公式不会溢出到相邻单元格，只计算出第一个值；需要多个结果时逐个单元格写普通公式，或用 `ArrayFormula(区域, 公式)` 写为数组公式。
- 错误值数量为零不等于计算正确：关键结果另行手工核算；修改一组输入，写到另一个输出路径再计算一次，核对结果随之变化。

## 计算结果

openpyxl 只写入公式，不计算结果。`write` 用办公软件以只读方式打开工作副本并全量重算，把结果写回文件的缓存值，并设为打开时重算。
写回失败（公式单元格不一致、遇到无法识别的错误码）时，文件保持无缓存值，并在 stages 中说明。
外部链接不更新；循环引用与办公软件不支持的函数以错误值出现在检查项中。

## 检查项

- `cached_errors`：计算结果为错误值，按错误类型列出位置。
- `missing_cache`：公式没有缓存值（结果为空字符串的公式也计在内）。
- `external_links`：引用了外部文件。
- `volatile_functions`：使用了易变函数。
- `library_metadata`：文档属性是生成库的默认值。openpyxl 默认的创建者为 `openpyxl`，脚本中把 `wb.properties.creator` 设为真实作者或清空。

## 版式

- 设置列宽、数字格式（千分位、小数位、百分比）、冻结首行；表头与合计行加粗。
- 需要打印或导出 PDF 的表，设置打印区域与分页（`ws.print_area`、`ws.page_setup`）。
- 图表使用 openpyxl 的原生图表（`openpyxl.chart`），数据引用工作表区域，不要插入图片。

## 修改已有文件

- 先 `read`：之后 `write` 同一路径时，工具以读取时的版本为准，文件在此期间被其他程序修改时返回冲突，不覆盖。工作副本中已是原文件的内容，只修改需要修改的单元格。
- openpyxl 读写时丢弃它不支持的内容（部分图形、数据透视表缓存、控件）；原稿中有这些对象时先用 `read` 确认，修改后用 `view` 核对。
- 交付的文件就是脚本写出的文件，只有公式缓存值由工具写回；工具不会让办公软件另存该文件。

## 边界

- 带宏的文件（.xlsm 等）一律拒绝打开。
- 重算、渲染需要 Windows 上的 WPS 或 Microsoft Office；未安装时这两个阶段返回 unavailable。WPS 与 Excel 的公式支持不完全相同。
- 技能中写明的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）仅作为做法参考，执行一律使用 write_office。技能已生成供 write_office 执行的脚本时（例如它输出的 `office_job.py`），直接把该脚本交给 write_office，不要改写技能的代码。

## 最小示例

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "利润表"
ws.append(["项目", "2026", "2027", "2028"])
ws.append(["收入", 1200, 1500, 1800])
ws.append(["成本", 800, 950, 1100])
ws.append(["利润", "=B2-B3", "=C2-C3", "=D2-D3"])
for c in ws[1]:
    c.font = Font(bold=True)
for row in ws.iter_rows(min_row=2, min_col=2):
    for c in row:
        c.number_format = "#,##0"
ws.column_dimensions["A"].width = 12
chart = BarChart()
chart.title = "利润（万元）"
chart.add_data(Reference(ws, min_col=2, max_col=4, min_row=4), from_rows=True)
chart.set_categories(Reference(ws, min_col=2, max_col=4, min_row=1))
ws.add_chart(chart, "F2")
wb.save(office.output("利润表.xlsx"))
```
