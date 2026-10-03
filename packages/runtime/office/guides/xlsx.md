# Excel（xlsx）做法要点

## 流程

1. 有原文件先 `read_office`：拿到工作表、公式与缓存值和 `sha256`；`range` 填工作表名可看到更多行。
2. 用 `write_file` 写 Python 制作脚本。
3. `write_office` 执行：脚本写出工作副本 → 办公软件只读打开全量重算，把每个公式的计算结果写回文件 → 结构检查 → 按工作表渲染 → 提交。
4. 看检查项里的错误值；`view_office` 看页，页码写成「工作表名:页码」，结果里标着每页对应的单元格区域。
5. 看出问题就改脚本再 `write`。

## 脚本 API

全局变量 `office`（也可 `from qyoffice import office`）：`office.output(路径)` 取工作副本路径；`office.inputs`；`office.workspace`；`office.figure(宽cm, 高cm)`；`office.app("xlsx")` 取产品新起的 WPS 表格 / Excel 原生对象（每次调用新起一个实例，一个实例只打开一个文件），不要用它另存文件。

openpyxl、lxml 的完整 API 都可以用。

## 公式纪律

- 计算写成公式，不写算好的数：输入、计算、输出分区摆放，输入单元格单独标出。
- 不用 `IFERROR(…, 0)` 或 `IFERROR(…, "")` 掩盖未知错误；只对已知会出现的情况（查找不到、分母为零）写明确的判断，并说明处理方式。
- 区分真零、缺数据、不适用：缺数据写明缺什么，不填 0。
- 少用易变函数（NOW、TODAY、RAND、OFFSET、INDIRECT）。
- openpyxl 写的 SEQUENCE、FILTER、UNIQUE、SORT 等动态数组公式不会溢出到相邻单元格，只算出第一个值；需要多个结果时逐格写普通公式，或用 `ArrayFormula(区域, 公式)` 写成数组公式。
- 错误值为零不等于算对：关键结果另外手算核对；改一组输入写到另一个输出路径再算一次，核对结果跟着变。

## 计算结果

openpyxl 只写公式、不算结果。`write` 会用办公软件只读打开工作副本全量重算，把结果写回文件的缓存值，并设为打开时重算。
写回失败（公式单元格对不上、遇到不认识的错误码）时文件保持无缓存值，并在 stages 里说明。
外部链接不更新；循环引用、办公软件不支持的函数会以错误值出现在检查项里。

## 检查项

- `cached_errors`：计算结果是错误值，按错误类型列出位置。
- `missing_cache`：公式没有缓存值（结果为空字符串的公式也计在内）。
- `external_links`：引用了外部文件。
- `volatile_functions`：用了易变函数。
- `library_metadata`：文档属性是生成库的默认值。openpyxl 默认创建者是 `openpyxl`，脚本里设 `wb.properties.creator` 为真实作者或清空。

## 版式

- 设列宽、数字格式（千分位、小数位、百分比）、冻结首行；表头与合计行加粗。
- 需要打印或导出 PDF 的表，设打印区域和分页（`ws.print_area`、`ws.page_setup`）。
- 图表用 openpyxl 的原生图表（`openpyxl.chart`），数据引用工作表区域，不要贴图。

## 修改已有文件

- 先 `read`：之后 `write` 同一路径时，工具以读到的版本为准，文件在此期间被别处改过就返回冲突、不覆盖。工作副本里已经是原文件的内容，只改需要改的单元格。
- openpyxl 读写会丢掉它不支持的内容（部分图形、数据透视表缓存、控件）；原稿里有这些对象时先 `read` 看清楚，改完 `view` 核对。
- 交付件就是脚本写出的文件，只有公式缓存值由工具写回；工具不会让办公软件另存它。

## 边界

- 带宏的文件（.xlsm 等）一律拒绝打开。
- 重算、渲染需要 Windows 上的 WPS 或 Microsoft Office；没有时这两个阶段返回 unavailable。WPS 与 Excel 的公式支持不完全相同。
- 技能里写的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）只当做法参考，执行一律用 write_office；技能附带的专属代码要改写成这里支持的 Python。

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
