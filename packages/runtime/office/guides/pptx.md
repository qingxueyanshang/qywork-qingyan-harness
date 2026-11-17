# PPT（pptx）做法要点

## 流程

1. 修改已有文件时先调用 `read_office`，取得每页的形状、位置尺寸、文字、图表、表格与 `sha256`。
2. 用 `write_file` 写入 Python 制作脚本。
3. 用 `write_office` 执行：脚本写出工作副本 → 结构检查 → 逐页渲染 → 提交。pptx 没有后处理阶段。
4. 用 `view_office` 查看页面：每页都要查看；文字密集或有小字的区域用 `region` 取局部。
5. 发现问题时修改脚本，再次执行 `write`，修改后重新查看改动的页。

生成成功、检查项为零都不等于合格：溢出、遮挡、配色与版式须查看页面判断。

## 脚本 API

全局变量 `office`（也可用 `from qyoffice import office` 导入）：`office.output(路径)` 取得工作副本路径；`office.inputs`；`office.workspace`；`office.figure(宽cm, 高cm)` 按最终尺寸生成图；`office.app("pptx")` 取得新启动的 WPS 演示 / PowerPoint 实例的原生对象（每次调用启动一个新实例，一个实例只打开一个文件），不要用它另存文件。

可使用 python-pptx、lxml、Pillow 的完整 API，也可以直接修改 OOXML。

## 页面与字体

- 16:9 页面：`prs.slide_width = Inches(13.333)`、`prs.slide_height = Inches(7.5)`。
- python-pptx 的 `font.name` 只设置西文字体，中文字体需另行设置 `a:ea`：

```python
from pptx.oxml.ns import qn

def set_fonts(run, latin, east_asia):
    """先设置西文字体生成 a:latin，再在其后放入 a:ea（两者在 rPr 中的先后顺序固定）。"""
    run.font.name = latin
    latin_el = run._r.get_or_add_rPr().find(qn("a:latin"))
    ea = latin_el.getnext()
    if ea is None or ea.tag != qn("a:ea"):
        ea = latin_el.makeelement(qn("a:ea"), {})
        latin_el.addnext(ea)
    ea.set("typeface", east_asia)
```

- 不要依赖自动缩小字号：文本框按内容留足宽高，渲染后检查是否有溢出或被裁切的文字。

## 原生对象

- 需要修改数据的图表使用原生图表（`slide.shapes.add_chart` + `CategoryChartData`），不要插入图片；表格使用 `add_table`。
- 只有照片、纹理等无法用原生对象表达的内容才使用图片。
- 图表中的文字按最终显示尺寸设置字号；数据标签与图例不要互相遮挡。
- 图表的坐标轴、刻度、图例文字默认为深灰色：深色背景上须显式设为浅色（`chart.font.color.rgb`，或逐个设置 `category_axis.tick_labels.font`），查看页面时用 `region` 放大图表核对。

## 检查项

- `off_slide`：形状超出页面。
- `text_overlap`：两个文本框重叠，仅为疑似遮挡；有意叠放（文字置于色块上）属于正常情况，须查看页面判断。
- `empty_placeholder`：空占位符，放映时不显示，编辑时显示提示文字。
- `text_overflow`：按字号与字数估算，文字高度超出文本框 20% 以上；仅为疑似，须查看页面确认。只对关闭了自动调整的文本框估算。
- `east_asia_font_missing`：中文文字未设置东亚字体，主题次要字体中也没有。
- `notes_present` / `comments_present`：存在演讲者备注或批注；用户未要求时，交付前删除。
- `library_metadata`：文档属性是生成库的默认值。

## 将图片型 PPT 重建为可编辑文件

选用了专门完成此项工作的技能（例如 `pptx-editable-rebuild`）时，按技能执行，以下各条不适用：技能用原图像素拆分图层、擦除文字，构建脚本由技能生成后交给 `write_office` 执行。

1. 用 `read` 查看原稿每页的结构；原稿的图片位于包内的 `ppt/media/`，脚本可用 `zipfile` 取出。
2. 先按原图记录标题栏、Logo、卡片、图片框等固定区域的坐标，重建时以此为准。
3. 逐页列出原图上的全部可见文字，包括叠加在照片上的数据面板、标签、角标与水印。照片保留为图片时，这些文字仍须重建为文本框，不属于照片的一部分。
4. 需要清除底图上的文字时，用 `generate_image` 以原图为输入修改图片（没有遮罩参数，修改后须核对固定区域是否变形、是否出现多余的文字或图案；清除的面板与标签须在上一步的清单中）。修改图片会重新绘制整张图，用户要求保留原图像素时不能使用。
5. 文字、图标、表格、数据图按原坐标用原生对象重建；无法辨认的内容标为待核对，不推测。
6. 交付前用 `read` 读取新文件，与第 3 步的清单逐条对照，补齐缺少的内容。
7. 可编辑性须实测：另写一个脚本修改副本中的文字、颜色、图表数据，`write` 到另一个路径并 `view`，确认改动生效、没有重影。

## 修改已有文件

- 先 `read`：之后 `write` 同一路径时，工具以读取时的版本为准，文件在此期间被其他程序修改时返回冲突，不覆盖。工作副本中已是原文件的内容，只修改需要修改的形状。
- 交付的文件即脚本写出的文件，工具不会让办公软件另存该文件。
- 文档属性由脚本设为真实作者：python-pptx 默认写入最后修改者 `Steve Canny` 与备注 `generated using python-pptx`（检查项 `library_metadata`）。用户未提供作者时清空这些字段（`prs.core_properties.last_modified_by`、`comments`），不要写入工具名；主题名同样不要使用工具名。

## 边界

- 带宏的文件（.pptm 等）一律拒绝打开。
- 渲染需要 Windows 上的 WPS 或 Microsoft Office；未安装时渲染阶段返回 unavailable，不能视为已查看页面。
- 技能中写明的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）仅作为做法参考，执行一律使用 write_office。技能已生成供 write_office 执行的脚本时（例如它输出的 `office_job.py`），直接把该脚本交给 write_office，不要改写技能的代码。

## 最小示例

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[6])
box = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12), Inches(1))
run = box.text_frame.paragraphs[0].add_run()
run.text = "季度收入"
run.font.size = Pt(32)
data = CategoryChartData()
data.categories = ["一季度", "二季度", "三季度"]
data.add_series("收入（万元）", (120, 150, 170))
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.6),
                       Inches(12), Inches(5.4), data)
prs.save(office.output("汇报.pptx"))
```
